'use strict';

const fs = require('fs');
const path = require('path');

// What a player SEES of hot bots. Two players log in at a quiet town, then the window opens:
// - the fighter teleports to a busy hunting spot, is given a level and the GM's buffs (it has no
//   gear; at its mobs' level it died every 20 s and killed one mob in 4 min) and fights there
//   (clicks the nearest free mob, as a player does; revived where it fell) for FIGHT_MS, so
//   kill-steals and target conflicts show;
// - the watcher teleports to Giran's gatekeeper landing (C4 teleport destination 59) and stands
//   there: the bots that arrive by teleport and walk off.
// For each player a recorder keeps what its client was sent: every SAMPLE_MS a line with every body
// in view (CharInfo shown, no DeleteOb since, in the world and in the client's range: a body that
// teleported away gets no DeleteOb, its viewer only its TeleportToLocation): position, state, plan,
// town, target, weapon/shield, HP/MP, party, karma, nearest mob on its floor; the server packets by
// name; chat lines, party/trade invites, PvP first hits, the fighter's mobs (who hit them, who took
// the kill); per sample the mobs in view and the bodies that target each (shared: 2+ bodies,
// contested: 2+ sides), bodies with no target and for how long (hunters, out of town in a hunting
// plan, apart from town bodies), target switches away from a live mob. Every activation attempt
// near the players (PopulationService.requestActivation, wrapped for the run) is logged with its
// outcome. The hot bots' target search (HuntingState.findPreferredMonster, seen through the
// World.fetchNpcsInRadius it opens with and the targetScan timing it closes with, both wrapped for
// the run) is counted per minute: calls, ms on main, scans at the expanded radius.
// Output in the run folder: spot-watcher-<label>.jsonl per player, spot-watcher-summary.json.
// The run ends after FIGHT_MS, or a minute before the window closes.
// Run: node scripts/perf.js run --save=312ebb2e-e9ee-417c-ae0e-5a58f2923b37 --scenario=script
//      --script=tests/e2e/spot-watcher.js --warmup=2 --minutes=12 --diagnostics --keep-world

// Floran had no bot in the save: the players heat nothing before the window.
const FLORAN = { locX: 17144, locY: 170156, locZ: -3504 };
// Spot 28_-31 (south of the Dwarven Village): the save's fullest, 25 hunters of levels 22-27.
const SPOT = { locX: 173785, locY: -184306, locZ: -1896 };
const GIRAN_LANDING = { locX: 83400, locY: 147943, locZ: -3404 };
const FIGHTER_LEVEL = 40;
const FIGHT_MS = 10 * 60000;
const SAMPLE_MS = 5000;
// The fighter takes mobs this close, at most this many levels above it, and is taken back to the
// spot when a chase leads it farther than LEASH.
const FIGHT_RADIUS = 1200;
const MOB_LEVELS_ABOVE = 5;
const LEASH = 2500;
// A mob the fighter has not hit in this long is given up.
const ENGAGE_MS = 40000;
// A walk back: a body again within RETURN_NEAR of a place it stood at, within RETURN_MS, having been
// RETURN_FAR from it in between.
const RETURN_MS = 120000;
const RETURN_NEAR = 150;
const RETURN_FAR = 600;
// Bodies this close stand in one another (not a pair fighting each other or one mob: melee range).
const STACKED = 50;
// A body that moved less than this between two samples stood still.
const STILL = 20;
// Nearest-mob search radius (farther: null).
const MOB_SEARCH = 3000;
// A mob no one hit for this long has left the view: its fight is settled without a kill.
const MOB_FORGET_MS = 120000;
const { CLIENT_VISIBILITY_RADIUS, SPOT_CELL_SIZE, inClientView } = invoke('GameServer/World/WorldConstants');
// A mob on another floor is not near: the spot catalogue's floor bound (SpotService), the farthest
// height a mob assists or aggroes across.
const SAME_FLOOR = Math.max(invoke('GameServer/Npc/SocialAggro').MAX_ASSIST_Z_DIFFERENCE, invoke('GameServer/Npc/NpcAggro').MAX_AGGRO_Z_DIFFERENCE);
// The AI plans of a body out hunting (BotAI); in a town it is not hunting whatever its plan.
const HUNTING_PLANS = new Set(['hunting', 'pk_hunting']);
// HuntingState's widened scan for a solo hunter with no target for 2 ticks (its local one is 2500).
const EXPANDED_RADIUS = Math.ceil(SPOT_CELL_SIZE * Math.SQRT2);

const GROUPS = {
    move: ['MoveToLocation', 'MoveToPawn', 'StopMove', 'ValidateLocation'],
    attack: ['Attack', 'SkillStarted', 'MagicSkillLaunched', 'AutoAttackStart', 'AutoAttackStop', 'Die'],
    charInfo: ['CharInfo'],
    chat: ['Speak'],
    party: ['AskForTeamUp', 'JoinParty', 'PartySmallWindowAll', 'PartySmallWindowDeleteAll', 'PartySmallWindowUpdate'],
    trade: ['TradeStart', 'TradeDone'],
    store: ['PrivateStoreMsg']
};

const int = (buffer, offset) => (buffer.length >= offset + 4 ? buffer.readInt32LE(offset) : null);
// A UTF-16 null-terminated string of a packet, and where the next field starts.
function text(buffer, offset) {
    let end = offset;
    while (end + 1 < buffer.length && !(buffer[end] === 0 && buffer[end + 1] === 0)) end += 2;
    return { text: buffer.toString('ucs2', offset, end), next: end + 2 };
}
const away = (a, b) => Math.hypot(a.locX - b.locX, a.locY - b.locY);
const locOf = actor => ({ locX: actor.fetchLocX(), locY: actor.fetchLocY(), locZ: actor.fetchLocZ() });
const round = value => Math.round(Number(value) || 0);
function quantiles(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const at = q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    return { n: sorted.length, p50: at(0.5), p90: at(0.9), max: sorted[sorted.length - 1] };
}
const top = (map, n = 10) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([id, count]) => ({ id, count }));

function actorById(session, id) {
    return session.knownCharacterActors?.get(id)?.deref() || invoke('GameServer/World/World').registeredActorById(id)?.actor || null;
}

function partyOf(actor) {
    const session = actor?.session;
    if (!session) return null;
    if (session.partyCompanion === true) return `player:${session.followPlayerSession?.actor?.fetchId?.()}`;
    return session.hotBackgroundPartyId || session.coldLifeState?.party?.partyId || null;
}

// One player's view: what its client was sent, and the samples of the bodies in it.
class View {
    constructor(client, label, file) {
        this.client = client;
        this.label = label;
        this.id = client.actor.fetchId();
        this.out = fs.createWriteStream(file, { flags: 'a' });
        this.shown = new Map();
        this.firstSeen = new Map();
        this.arrivalAt = null;
        this.packets = new Map();
        this.chat = [];
        this.invites = [];
        this.mobs = new Map();
        this.pvp = new Map();
        this.ks = { engaged: 0, joinedAfterPlayer: 0, playerJoinedAfter: 0, playerKills: 0, lastHitByOther: 0, by: new Map() };
        this.conflicts = 0;
        this.bodies = new Map();
        this.samples = 0;
        this.bodySamples = 0;
        this.idle = { standing: 0, seated: 0 };
        this.stacked = 0;
        this.outOfView = { ids: new Set(), rows: 0 };
        this.mobDistance = { all: [], hunting: [] };
        this.deaths = 0;
        this.targets = { mobSamples: 0, shared: 0, contested: 0, playerMob: 0, playerMobShared: 0, playerMobContested: 0,
            liveSamples: 0, noTarget: 0, huntingSamples: 0, huntingNoTarget: 0, townSamples: 0, townNoTarget: 0, streaks: [] };
        this.listener = entry => this.packet(entry);
        client.waiters.add(this.listener);
    }

    write(record) {
        this.out.write(`${JSON.stringify({ t: new Date().toISOString(), ...record })}\n`);
    }

    // Called before the teleport: the client's scene unloads and every body shown after is new.
    arrive(loc) {
        this.arrivalAt = Date.now();
        this.arrivalLoc = loc;
        this.shown.clear();
        this.firstSeen.clear();
        this.write({ type: 'arrive', loc });
    }

    isCharacter(id) {
        return id === this.id || this.shown.has(id);
    }

    packet(entry) {
        this.packets.set(entry.name, (this.packets.get(entry.name) || 0) + 1);
        const buffer = entry.buffer;
        switch (entry.name) {
        case 'CharInfo': {
            const id = int(buffer, 19);
            if (!id || id === this.id) return;
            const body = this.body(id);
            if (this.shown.has(id)) { body.charInfo += 1; return; }
            this.shown.set(id, entry.at);
            if (this.arrivalAt && !this.firstSeen.has(id)) {
                const at = { locX: int(buffer, 3), locY: int(buffer, 7), locZ: int(buffer, 11) };
                this.firstSeen.set(id, { id, ms: entry.at - this.arrivalAt, distance: round(away(at, this.client.loc())),
                    fromLanding: round(away(at, this.arrivalLoc)) });
            }
            return;
        }
        case 'DeleteOb': this.shown.delete(int(buffer, 3)); return;
        case 'TeleportToLocation': if (int(buffer, 3) === this.id) this.shown.clear(); return;
        case 'Attack': {
            const src = int(buffer, 3);
            this.hit(src, int(buffer, 7), entry.at);
            const extra = buffer.length >= 30 ? buffer.readUInt16LE(28) : 0;
            for (let i = 0; i < extra; i++) this.hit(src, int(buffer, 30 + i * 9), entry.at);
            return;
        }
        case 'SkillStarted': {
            const src = int(buffer, 3), dst = int(buffer, 7);
            if (dst && dst !== src && this.offensive(src, int(buffer, 11), dst)) this.hit(src, dst, entry.at);
            return;
        }
        case 'Die': this.settle(int(buffer, 3), true); return;
        case 'Speak': {
            const id = int(buffer, 3), kind = int(buffer, 7);
            const name = text(buffer, 11);
            const line = { at: entry.at, id, kind, name: name.text, text: text(buffer, name.next).text };
            if (id === this.id) return;
            this.chat.push(line);
            this.write({ type: 'chat', ...line });
            return;
        }
        case 'AskForTeamUp': this.invite('party', text(buffer, 3).text); return;
        case 'TradeStart': this.invite('trade', int(buffer, 3)); return;
        default:
        }
    }

    invite(kind, from) {
        this.invites.push({ kind, from });
        this.write({ type: 'invite', kind, from });
    }

    // A skill on a character counts as a hit only when it is cast on an enemy (C4SkillRules target).
    offensive(src, skillId, dst) {
        if (!this.isCharacter(dst)) return true;
        const caster = src === this.id ? this.client.actor : actorById(this.client.session, src);
        return caster?.skillset?.fetchSkill?.(skillId)?.fetchSemantic?.()?.target === 'enemy';
    }

    hit(src, dst, at) {
        if (!src || !dst || src === dst || !this.isCharacter(src)) return;
        if (this.isCharacter(dst)) {
            const key = [Math.min(src, dst), Math.max(src, dst)].join(':');
            const fight = this.pvp.get(key);
            if (fight) { fight.hits += 1; return; }
            const describe = (id) => {
                const actor = id === this.id ? this.client.actor : actorById(this.client.session, id);
                return { id, name: actor?.fetchName?.(), karma: actor?.fetchKarma?.() ?? null, pvpFlag: actor?.fetchPvpFlag?.() ?? null,
                    party: partyOf(actor) };
            };
            const record = { at, first: describe(src), second: describe(dst), hits: 1, withPlayer: src === this.id || dst === this.id };
            this.pvp.set(key, record);
            this.write({ type: 'pvp', first: record.first, second: record.second, withPlayer: record.withPlayer });
            return;
        }
        const mob = this.mobs.get(dst) || { hitters: new Map(), last: null, playerFirst: null, lastAt: at };
        const hitter = mob.hitters.get(src) || { first: at };
        hitter.last = at;
        mob.hitters.set(src, hitter);
        mob.last = src;
        mob.lastAt = at;
        if (src === this.id && mob.playerFirst === null) mob.playerFirst = at;
        this.mobs.set(dst, mob);
    }

    // A mob's fight ends (it died, or no one hit it for MOB_FORGET_MS): who fought it, who took it.
    settle(mobId, killed) {
        const mob = this.mobs.get(mobId);
        if (!mob) return;
        this.mobs.delete(mobId);
        const side = id => (id === this.id ? 'player' : partyOf(actorById(this.client.session, id)) || `solo:${id}`);
        const others = [...mob.hitters.keys()].filter(id => id !== this.id);
        if (new Set([...mob.hitters.keys()].map(side)).size >= 2) this.conflicts += 1;
        if (mob.playerFirst === null) return;
        this.ks.engaged += 1;
        const after = others.filter(id => mob.hitters.get(id).first > mob.playerFirst);
        const before = others.filter(id => mob.hitters.get(id).first < mob.playerFirst);
        if (after.length) this.ks.joinedAfterPlayer += 1;
        if (before.length) this.ks.playerJoinedAfter += 1;
        for (const id of after) this.ks.by.set(id, (this.ks.by.get(id) || 0) + 1);
        if (killed && mob.last === this.id) this.ks.playerKills += 1;
        else if (killed && others.includes(mob.last)) this.ks.lastHitByOther += 1;
        this.write({ type: 'mob', id: mobId, killed, lastHit: mob.last, playerFirst: mob.playerFirst,
            hitters: [...mob.hitters.entries()].map(([id, row]) => ({ id, first: row.first, last: row.last })) });
    }

    body(id) {
        let body = this.bodies.get(id);
        if (!body) {
            body = { samples: 0, lastAt: null, idle: 0, idleSince: null, longestIdleMs: 0, history: [], returns: 0, weapon: undefined,
                shield: undefined, reEquips: 0, charInfo: 0, lastTarget: null, noTargetSince: null, huntNoTargetSince: null,
                longestHuntNoTargetMs: 0, switches: 0 };
            this.bodies.set(id, body);
        }
        return body;
    }

    sample(now = Date.now()) {
        const World = invoke('GameServer/World/World');
        const Life = invoke('GameServer/Bot/Population/BotLifeState');
        const { townAt } = invoke('GameServer/Bot/AI/TownTransitPolicy');
        const me = this.client.actor;
        const here = locOf(me);
        const rows = [], outOfView = [];
        for (const mobId of [...this.mobs.keys()]) if (now - this.mobs.get(mobId).lastAt > MOB_FORGET_MS) this.settle(mobId, false);
        for (const id of this.shown.keys()) {
            // Only the world's body: a cooled one lives on only as the session's stale reference.
            const actor = World.registeredActorById(id)?.actor;
            const loc = actor ? locOf(actor) : null;
            if (!actor || !inClientView(here.locX, here.locY, loc.locX, loc.locY)) { outOfView.push(id); continue; }
            const state = actor.state;
            const session = actor.session;
            const paperdoll = actor.backpack?.paperdoll || {};
            const target = Number(actor.fetchDestId?.()) || null;
            const town = townAt(loc);
            const mob = World.fetchNpcsInRadius(loc.locX, loc.locY, MOB_SEARCH)
                .filter(npc => npc.fetchAttackable?.() && !npc.isDead?.() && Math.abs(npc.fetchLocZ() - loc.locZ) <= SAME_FLOOR)
                .reduce((best, npc) => Math.min(best, away(loc, locOf(npc))), Infinity);
            rows.push({ id, name: actor.fetchName(), bot: String(session?.accountId || '').startsWith('bot_'), level: actor.fetchLevel(),
                classId: actor.fetchClassId?.(), loc, distance: round(away(loc, here)),
                moving: state.fetchTowards() || false, seated: state.fetchSeated(), dead: state.fetchDead(),
                hitting: state.fetchHits(), casting: state.fetchCasts(), combat: state.fetchCombats(),
                plan: session?.plan || null, activity: Life.cachedState(id)?.activity || null, town,
                hunter: !town && HUNTING_PLANS.has(session?.plan),
                target, targetIsCharacter: target ? this.isCharacter(target) : null,
                weapon: paperdoll[7]?.selfId || paperdoll[14]?.selfId || null, shield: paperdoll[8]?.selfId || null,
                hp: round(actor.fetchHp()), maxHp: round(actor.fetchMaxHp()), mp: round(actor.fetchMp()), maxMp: round(actor.fetchMaxMp()),
                party: partyOf(actor), karma: actor.fetchKarma?.() ?? 0, pvpFlag: actor.fetchPvpFlag?.() ?? 0,
                store: actor.fetchPrivateStoreType?.() || 0, nearestMob: Number.isFinite(mob) ? round(mob) : null });
        }
        this.samples += 1;
        this.outOfView.rows += outOfView.length;
        outOfView.forEach(id => this.outOfView.ids.add(id));
        const mobs = new Map(World.fetchNpcsInRadius(here.locX, here.locY, CLIENT_VISIBILITY_RADIUS)
            .filter(npc => npc.fetchAttackable?.() && !npc.isDead?.()).map(npc => [npc.fetchId(), npc]));
        for (const row of rows) this.account(row, rows, now, mobs);
        const mine = Number(me.fetchDestId?.()) || null;
        const targeted = this.contests(rows, mobs, mine);
        this.write({ type: 'sample', player: { id: this.id, loc: here, hp: round(me.fetchHp()), mp: round(me.fetchMp()),
            target: mine, dead: me.isDead() }, mobsInView: mobs.size, targeted, bodies: rows, outOfView });
    }

    // The mobs in view that bodies target: shared by 2+ bodies, contested by 2+ sides (a party is one).
    contests(live, mobs, mine) {
        const by = new Map();
        const add = (mobId, id) => { if (mobs.has(mobId)) by.set(mobId, [...(by.get(mobId) || []), id]); };
        for (const row of live) if (row.target && !row.targetIsCharacter && !row.dead) add(row.target, row.id);
        if (mine && !this.client.actor.isDead()) add(mine, this.id);
        const side = id => (id === this.id ? 'player' : live.find(row => row.id === id)?.party || `solo:${id}`);
        const targeted = [];
        for (const [mobId, ids] of by) {
            const contested = new Set(ids.map(side)).size >= 2;
            const player = ids.includes(this.id);
            this.targets.mobSamples += 1;
            if (ids.length >= 2) this.targets.shared += 1;
            if (contested) this.targets.contested += 1;
            if (player) {
                this.targets.playerMob += 1;
                if (ids.length >= 2) this.targets.playerMobShared += 1;
                if (contested) this.targets.playerMobContested += 1;
            }
            targeted.push({ id: mobId, name: mobs.get(mobId).fetchName(), by: ids, contested, player });
        }
        return targeted;
    }

    account(row, live, now, mobs) {
        const body = this.body(row.id);
        // Back in view after a gap: its streaks and its path restart.
        if (body.lastAt !== null && now - body.lastAt > 2 * SAMPLE_MS) {
            if (body.noTargetSince !== null) this.targets.streaks.push(body.lastAt - body.noTargetSince);
            Object.assign(body, { idleSince: null, noTargetSince: null, huntNoTargetSince: null, history: [] });
        }
        body.lastAt = now;
        const last = body.history[body.history.length - 1];
        this.bodySamples += 1;
        body.samples += 1;
        // Idle: no move, no target, no hit or cast, alive, no private store (a seated one rests; it is
        // counted apart).
        const still = !last || away(last, row.loc) < STILL;
        const idle = !row.dead && !row.store && !row.moving && still && !row.target && !row.hitting && !row.casting;
        if (idle) {
            this.idle[row.seated ? 'seated' : 'standing'] += 1;
            body.idle += 1;
            if (!row.seated) {
                body.idleSince ??= now;
                body.longestIdleMs = Math.max(body.longestIdleMs, now - body.idleSince);
            }
        }
        if (!idle || row.seated) body.idleSince = null;
        const fighting = other => other.target === row.id || row.target === other.id || (row.target && other.target === row.target);
        if (live.some(other => other !== row && away(other.loc, row.loc) < STACKED && !fighting(other))) this.stacked += 1;
        if (row.nearestMob !== null) {
            this.mobDistance.all.push(row.nearestMob);
            if (row.hunter) this.mobDistance.hunting.push(row.nearestMob);
        }
        if (body.weapon !== undefined && (body.weapon !== row.weapon || body.shield !== row.shield)) {
            body.reEquips += 1;
            this.write({ type: 'equip', id: row.id, name: row.name, weapon: [body.weapon, row.weapon], shield: [body.shield, row.shield] });
        }
        body.weapon = row.weapon;
        body.shield = row.shield;
        // No target: alive, no store; a streak ends when it takes one.
        if (!row.dead && !row.store) {
            this.targets.liveSamples += 1;
            if (row.hunter) this.targets.huntingSamples += 1;
            if (row.town) this.targets.townSamples += 1;
            if (!row.target) {
                this.targets.noTarget += 1;
                if (row.hunter) this.targets.huntingNoTarget += 1;
                if (row.town) this.targets.townNoTarget += 1;
                body.noTargetSince ??= now;
            }
        }
        // A hunter's streak with no target: it ends when it takes one, dies, opens a store or stops hunting.
        if (row.hunter && !row.dead && !row.store && !row.target) {
            body.huntNoTargetSince ??= now;
            body.longestHuntNoTargetMs = Math.max(body.longestHuntNoTargetMs, now - body.huntNoTargetSince);
        } else body.huntNoTargetSince = null;
        if ((row.target || row.dead || row.store) && body.noTargetSince !== null) {
            this.targets.streaks.push(now - body.noTargetSince);
            body.noTargetSince = null;
        }
        // A switch mid-fight: from a mob still alive in view to another target.
        if (body.lastTarget && row.target && row.target !== body.lastTarget && mobs.has(body.lastTarget)) {
            body.switches += 1;
            this.write({ type: 'target_switch', id: row.id, name: row.name, from: body.lastTarget, to: row.target });
        }
        body.lastTarget = row.target;
        // A walk back to where it stood: A, then RETURN_FAR away, then A again within RETURN_MS.
        body.history = body.history.filter(point => now - point.at <= RETURN_MS);
        const back = body.history.findIndex(point => now - point.at >= 2 * SAMPLE_MS && away(point, row.loc) < RETURN_NEAR
            && body.history.some(mid => mid.at > point.at && away(point, mid) >= RETURN_FAR));
        if (back >= 0) {
            body.returns += 1;
            this.write({ type: 'walk_back', id: row.id, name: row.name, from: body.history[back], via: RETURN_FAR, ms: now - body.history[back].at });
            body.history = [];
        }
        body.history.push({ at: now, locX: row.loc.locX, locY: row.loc.locY });
    }

    summary(minutes) {
        const bodies = [...this.bodies.entries()];
        const count = names => names.reduce((sum, name) => sum + (this.packets.get(name) || 0), 0);
        const perMinute = value => Math.round(value / Math.max(minutes, 1 / 60) * 10) / 10;
        const seen = [...this.firstSeen.values()];
        const chatKinds = {};
        for (const line of this.chat) chatKinds[line.kind] = (chatKinds[line.kind] || 0) + 1;
        return {
            label: this.label, minutes: Math.round(minutes * 10) / 10, samples: this.samples, bodiesSeen: this.bodies.size,
            outOfView: { bodies: this.outOfView.ids.size, rows: this.outOfView.rows },
            idle: { share: this.bodySamples ? Math.round((this.idle.standing + this.idle.seated) / this.bodySamples * 1000) / 1000 : 0,
                standingShare: this.bodySamples ? Math.round(this.idle.standing / this.bodySamples * 1000) / 1000 : 0,
                bodiesIdleStanding60s: bodies.filter(([, body]) => body.longestIdleMs >= 60000).map(([id, body]) => ({ id, ms: body.longestIdleMs })) },
            walkBacks: { total: bodies.reduce((sum, [, body]) => sum + body.returns, 0), bodies: bodies.filter(([, body]) => body.returns).length,
                top: top(new Map(bodies.map(([id, body]) => [id, body.returns]).filter(([, n]) => n))) },
            stackedShare: this.bodySamples ? Math.round(this.stacked / this.bodySamples * 1000) / 1000 : 0,
            nearestMob: { all: quantiles(this.mobDistance.all), hunting: quantiles(this.mobDistance.hunting),
                huntingBeyond1500: this.mobDistance.hunting.filter(d => d > 1500).length },
            reEquips: { total: bodies.reduce((sum, [, body]) => sum + body.reEquips, 0), bodies: bodies.filter(([, body]) => body.reEquips).length,
                top: top(new Map(bodies.map(([id, body]) => [id, body.reEquips]).filter(([, n]) => n))),
                charInfoResends: bodies.reduce((sum, [, body]) => sum + body.charInfo, 0) },
            chat: { lines: this.chat.length, perMinute: perMinute(this.chat.length), byKind: chatKinds },
            invites: { party: this.invites.filter(row => row.kind === 'party').length, trade: this.invites.filter(row => row.kind === 'trade').length },
            packets: { perMinute: Object.fromEntries(Object.entries(GROUPS).map(([group, names]) => [group, perMinute(count(names))])),
                total: [...this.packets.values()].reduce((a, b) => a + b, 0), byName: Object.fromEntries([...this.packets.entries()].sort((a, b) => b[1] - a[1])) },
            killSteals: { engagedMobs: this.ks.engaged, othersJoinedAfterPlayer: this.ks.joinedAfterPlayer, playerJoinedAfterOthers: this.ks.playerJoinedAfter,
                playerKills: this.ks.playerKills, lastHitByOther: this.ks.lastHitByOther, by: top(this.ks.by), playerDeaths: this.deaths },
            targetConflicts: this.conflicts,
            targets: (() => {
                const t = this.targets, share = (a, b) => (b ? Math.round(a / b * 1000) / 1000 : 0);
                const ongoing = bodies.filter(([, body]) => body.noTargetSince !== null).map(([, body]) => body.lastAt - body.noTargetSince);
                const bodyHours = this.bodySamples * SAMPLE_MS / 3600000;
                return { mobSamples: t.mobSamples, sharedShare: share(t.shared, t.mobSamples), contestedShare: share(t.contested, t.mobSamples),
                    playerMob: { samples: t.playerMob, shared: t.playerMobShared, contested: t.playerMobContested },
                    noTarget: { share: share(t.noTarget, t.liveSamples), huntingSamples: t.huntingSamples,
                        huntingShare: share(t.huntingNoTarget, t.huntingSamples), townSamples: t.townSamples, townShare: share(t.townNoTarget, t.townSamples),
                        streakMs: quantiles([...t.streaks, ...ongoing]), ongoingOver60s: ongoing.filter(ms => ms >= 60000).length,
                        huntersOver60s: bodies.filter(([, body]) => body.longestHuntNoTargetMs >= 60000)
                            .map(([id, body]) => ({ id, ms: body.longestHuntNoTargetMs })).sort((a, b) => b.ms - a.ms) },
                    switches: { total: bodies.reduce((sum, [, body]) => sum + body.switches, 0),
                        perBodyHour: bodyHours ? Math.round(bodies.reduce((sum, [, body]) => sum + body.switches, 0) / bodyHours * 10) / 10 : 0,
                        top: top(new Map(bodies.map(([id, body]) => [id, body.switches]).filter(([, n]) => n))) } };
            })(),
            pvp: { pairs: this.pvp.size, withPlayer: [...this.pvp.values()].filter(row => row.withPlayer).length,
                fights: [...this.pvp.values()].map(row => ({ first: row.first, second: row.second, hits: row.hits })) },
            popIn: { all: quantiles(seen.map(row => row.ms)), within1500: quantiles(seen.filter(row => row.distance < 1500).map(row => row.ms)),
                atLanding: seen.filter(row => row.fromLanding < 400 && row.ms > 30000).length }
        };
    }

    close() {
        this.client.waiters.delete(this.listener);
        return new Promise(resolve => this.out.end(resolve));
    }
}

// Every activation attempt near a player, with its outcome, through the population's own entry
// (PopulationService.requestActivation; activateNearPlayers and showWalkersNear call it), and the
// scans that left rows out (activation_budget). Returns the undo.
function watchActivations(views, radius, onAttempt) {
    const Population = invoke('GameServer/Bot/Population/PopulationService');
    const Metrics = invoke('GameServer/Bot/Population/PopulationMetrics');
    const World = invoke('GameServer/World/World');
    const request = Population.requestActivation;
    const refusal = Metrics.recordActivationRefusal;
    Population.requestActivation = function (stateOrName, reason, options = {}) {
        const state = typeof stateOrName === 'object' ? stateOrName : null;
        const from = options.playerLoc || state?.loc;
        const view = from && views.find(row => away(row.client.loc(), from) <= radius);
        const attempt = request.call(this, stateOrName, reason, options);
        if (!view) return attempt;
        const log = (result) => {
            const id = Number(state?.characterId || result?.state?.characterId) || null;
            const body = result?.ok && id ? World.registeredActorById(id)?.actor : null;
            const placed = body ? locOf(body) : null;
            onAttempt(view, { type: 'activation', id, name: state?.name || String(stateOrName), reason, activity: state?.activity,
                ok: !!result?.ok, refusal: result?.ok ? null : result?.reason || 'unknown', count: result?.count || 1, from: state?.loc || null, placed,
                distance: placed ? round(away(placed, view.client.loc())) : null });
        };
        return Promise.resolve(attempt).then((result) => {
            log(result);
            return result;
        }, (error) => {
            log({ ok: false, reason: `threw: ${error?.message || error}` });
            throw error;
        });
    };
    Metrics.recordActivationRefusal = function (reason, ...rest) {
        if (reason === 'activation_budget') onAttempt(null, { type: 'activation_budget' });
        return refusal.call(this, reason, ...rest);
    };
    return () => {
        Population.requestActivation = request;
        Metrics.recordActivationRefusal = refusal;
    };
}

// The hot bots' target search on main: HuntingState.findPreferredMonster opens with one
// World.fetchNpcsInRadius at its search radius and closes with HotActorLodPolicy.recordSubsystem
// ('targetScan'), synchronously, with no other radius query in between; the time between the two
// is the scan's. Returns the stats and the undo.
function watchTargetSearch() {
    const { performance } = require('perf_hooks');
    const World = invoke('GameServer/World/World');
    const Lod = invoke('GameServer/Bot/AI/HotActorLodPolicy');
    const fetch = World.fetchNpcsInRadius;
    const record = Lod.recordSubsystem;
    const started = Date.now();
    const stats = { calls: 0, ms: 0, coarseMs: 0, expanded: 0, byRadius: {}, perCall: [], minutes: [] };
    let last = null;
    World.fetchNpcsInRadius = function (locX, locY, radius) {
        last = { radius, at: performance.now() };
        return fetch.apply(this, arguments);
    };
    Lod.recordSubsystem = function (name, durationMs) {
        if (name === 'targetScan') {
            const ms = last ? performance.now() - last.at : 0;
            const radius = last ? round(last.radius) : null;
            const minute = stats.minutes[Math.floor((Date.now() - started) / 60000)] ||= { calls: 0, ms: 0, expanded: 0 };
            stats.calls += 1;
            stats.ms += ms;
            stats.coarseMs += Number(durationMs) || 0;
            stats.perCall.push(ms);
            stats.byRadius[radius] = (stats.byRadius[radius] || 0) + 1;
            minute.calls += 1;
            minute.ms += ms;
            if (radius === EXPANDED_RADIUS) { stats.expanded += 1; minute.expanded += 1; }
            last = null;
        }
        return record.apply(this, arguments);
    };
    const summary = () => {
        const minutes = Math.max((Date.now() - started) / 60000, 1 / 60);
        const ms = quantiles(stats.perCall.map(value => Math.round(value * 100) / 100));
        return { calls: stats.calls, perMinute: Math.round(stats.calls / minutes), msPerMinute: Math.round(stats.ms / minutes * 10) / 10,
            msPerCall: ms, coarseMsTotal: stats.coarseMs, expanded: stats.expanded,
            expandedShare: stats.calls ? Math.round(stats.expanded / stats.calls * 1000) / 1000 : 0, byRadius: stats.byRadius,
            minutes: stats.minutes.map(row => row && { calls: row.calls, ms: Math.round(row.ms * 10) / 10, expanded: row.expanded }) };
    };
    return { summary, undo() { World.fetchNpcsInRadius = fetch; Lod.recordSubsystem = record; } };
}

module.exports = {
    name: 'spot-watcher',
    players: 2,
    areas: ['GameServer/Bot/Population/PopulationService.js', 'GameServer/Bot/Population/HotActivation.js',
        'GameServer/Bot/Population/ActivationPlacement.js', 'GameServer/World/CharacterVisibility.js',
        'GameServer/Bot/AI/SpotService.js', 'GameServer/Bot/AI/States/HuntingState.js', 'GameServer/Actor/Generics/AttackRequest.js', 'GameServer/Actor/Generics/TeleportTo.js'],
    needs: { towns: ['Floran Village', 'Giran'] },
    place() {
        return invoke('GameServer/World/TownRespawn').getClosestTown(FLORAN.locX, FLORAN.locY, FLORAN.locZ) || FLORAN;
    },

    async run({ players, step, within, world, setup }) {
        const [fighter, watcher] = players;
        if (!watcher) throw new Error('the script needs 2 players (server.log: "did not log in")');
        const Recorder = invoke('Perf/LiveRecorder');
        const dir = Recorder.settings?.dir || process.cwd();
        let windowMinutes = FIGHT_MS / 60000 + 1;
        try { windowMinutes = Number(JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8')).windowMinutes) || windowMinutes; } catch { /* the default */ }
        const fightMs = Math.max(60000, Math.min(FIGHT_MS, windowMinutes * 60000 - 60000));
        const views = [new View(fighter, 'fighter', path.join(dir, 'spot-watcher-fighter.jsonl')),
            new View(watcher, 'watcher', path.join(dir, 'spot-watcher-watcher.jsonl'))];
        const radius = Number(invoke('GameServer/Bot/Population/PopulationConfig').activationRadius || 9000) + 1000;
        const activations = [];
        let budgetCuts = 0;
        const unwatch = watchActivations(views, radius, (view, record) => {
            if (!view) { budgetCuts += 1; return; }
            activations.push({ view: view.label, ...record });
            view.write(record);
        });
        const search = watchTargetSearch();
        const started = Date.now();
        const sampler = setInterval(() => views.forEach((view) => {
            try { view.sample(); } catch (error) { view.write({ type: 'sample_error', error: error.message }); }
        }), SAMPLE_MS);
        const writeSummary = () => {
            const minutes = (Date.now() - started) / 60000;
            const placed = activations.filter(row => row.ok);
            const refused = {};
            for (const row of activations.filter(item => !item.ok)) refused[row.refusal] = (refused[row.refusal] || 0) + 1;
            const summary = { at: new Date().toISOString(), spot: SPOT, landing: GIRAN_LANDING, fighterLevel: FIGHTER_LEVEL,
                views: views.map(view => view.summary(minutes)), targetSearch: search.summary(),
                activations: { attempts: activations.length, placed: placed.length, refused, budgetCuts,
                    placedDistance: quantiles(placed.filter(row => row.distance !== null).map(row => row.distance)) } };
            fs.writeFileSync(path.join(dir, 'spot-watcher-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
            return summary;
        };
        const summaryTimer = setInterval(() => { try { writeSummary(); } catch { /* the next one */ } }, 60000);
        try {
            await step('the fighter has a level for the spot', async () => {
                await setup.setLevel(fighter, FIGHTER_LEVEL);
                setup.fullBuff(fighter);
                if (fighter.actor.fetchLevel() !== FIGHTER_LEVEL) throw new Error(`level ${fighter.actor.fetchLevel()}`);
            });
            for (const [client, view, loc, what] of [[fighter, views[0], SPOT, 'the spot'], [watcher, views[1], GIRAN_LANDING, "Giran's landing"]]) {
                await step(`the ${view.label} arrives at ${what}`, async () => {
                    view.arrive(loc);
                    if (setup.teleport(client, loc) === false) throw new Error('teleport refused');
                    await within(10000, () => away(client.loc(), loc) < 500, { what: `the ${view.label} at ${what}` });
                });
            }
            await step('the fighter fights at the spot', async () => {
                const fighting = views[0];
                let mob = null, engagedAt = 0;
                for (const end = started + fightMs; Date.now() < end;) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                    if (fighter.actor.isDead()) {
                        fighting.deaths += 1;
                        fighting.write({ type: 'player_death', loc: fighter.loc() });
                        mob = null;
                        await new Promise(resolve => setTimeout(resolve, 3000));
                        setup.revive(fighter);
                        setup.fullBuff(fighter);
                        continue;
                    }
                    if (away(fighter.loc(), SPOT) > LEASH) {
                        fighting.write({ type: 'leash', loc: fighter.loc() });
                        setup.teleport(fighter, SPOT);
                        mob = null;
                        continue;
                    }
                    const hitLately = mob && fighting.mobs.get(mob.fetchId())?.hitters.get(fighting.id)?.last > Date.now() - 10000;
                    if (mob && !mob.isDead() && (hitLately || Date.now() - engagedAt < ENGAGE_MS)) continue;
                    // The nearest mob no one fights; else the nearest one.
                    const mobs = world.npcsNear(fighter.loc(), FIGHT_RADIUS, npc => npc.fetchAttackable?.() && !npc.isDead?.()
                        && !npc.fetchIsSummon?.() && Number(npc.fetchLevel()) <= FIGHTER_LEVEL + MOB_LEVELS_ABOVE);
                    mob = mobs.find(npc => !npc.fetchDestId?.()) || mobs[0] || null;
                    if (!mob) continue;
                    engagedAt = Date.now();
                    fighting.write({ type: 'engage', mob: mob.fetchId(), name: mob.fetchName(), level: mob.fetchLevel(), free: !mob.fetchDestId?.() });
                    await fighter.action(mob.fetchId());
                    await fighter.action(mob.fetchId());
                }
            });
        } finally {
            clearInterval(sampler);
            clearInterval(summaryTimer);
            unwatch();
            search.undo();
            const summary = writeSummary();
            await Promise.all(views.map(view => view.close()));
            Recorder.note('e2e-watch', { script: 'spot-watcher', summary: summary.views.map(view => ({ label: view.label, bodies: view.bodiesSeen,
                idle: view.idle.share, ks: view.killSteals, pvp: view.pvp.pairs, targets: view.targets })), activations: summary.activations,
                targetSearch: { ...summary.targetSearch, minutes: undefined } });
        }
    }
};
