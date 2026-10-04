const assert = require('assert');
const fs = require('fs');
const path = require('path');
require('../src/Global');
const Data = invoke('GameServer/DataCache');
Data.init();
const Runtime = require('../src/GameServer/ClanHall/Runtime');
const Services = require('../src/GameServer/ClanHall/Services');
const Hot = require('../src/GameServer/ClanHall/BotVisit');
const Cold = require('../src/GameServer/ClanHall/ColdVisit');
const Effects = invoke('GameServer/Effects/EffectStore');
const Ticker = invoke('GameServer/Effects/EffectTicker');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Database = invoke('Database');
const World = invoke('GameServer/World/World');
const Approach = invoke('GameServer/Bot/AI/TownNpcApproach');
const Navigation = invoke('GameServer/Bot/AI/CompanionNavigationRecovery');
const Spots = invoke('GameServer/Bot/AI/SpotService');
const Departure = require('../src/GameServer/ClanHall/Departure');
const originalBestSpot = Spots.findBestSpot;
const originalArrival = Spots.arrivalPointForState;
const originalInvoke = global.invoke;
const { lifecycleKind, ColdSimulationKernel } = invoke('GameServer/Bot/Population/ColdSimulationKernel');
const membership = invoke('GameServer/Clan/ClanSocialRuntime').view.memberships;
const def = Runtime.Policy.definition(36);
const at = Date.now();
const hallRow = {
    id: def.id,
    ownerId: 1,
    serviceDueAt: at + 86400000,
    functionsJson: '{"support":8}',
    auctionEndsAt: 0,
    rentDueAt: at + 604800000
};
const directory = fs.mkdtempSync(path.resolve('tmp/hall-services-'));
options.default.Database.path = path.join(directory, 'world.sqlite');
Database.init();
let mp = 10000,
    moved = 0;
const npc = {
    fetchId: () => 80000,
    fetchSelfId: () => def.managerIds[0],
    fetchName: () => 'Manager',
    fetchLocX: () => def.spawn.locX,
    fetchLocY: () => def.spawn.locY,
    fetchLocZ: () => def.spawn.locZ,
    fetchMp: () => mp,
    setMp: (v) => {
        mp = v;
    },
    fetchHead: () => 0,
    isDead: () => false
};
const originalNpc = World.npc;
const originalLos = Approach.hasLineOfSight;
const originalMove = Navigation.move;
World.npc = { spawns: [npc] };
Approach.hasLineOfSight = () => true;
Navigation.move = () => {
    moved++;
    return { status: 'moving' };
};
Runtime.applyRows([hallRow]);
function stateFor(id, classId = 88) {
    return {
        characterId: id,
        accountName: 'bot_hall_services',
        name: 'HallVisitor',
        phase: 'cold',
        activity: 'hunting',
        level: 60,
        exp: 1000000,
        sp: 10000,
        adena: 100000,
        loc: { ...def.spawn },
        currentRegion: def.town,
        spotId: null,
        vitals: { hp: 10000, maxHp: 10000, mp: 10000, maxMp: 10000 },
        timing: { lastResolvedAt: at, nextResolveAt: at, activityStartedAt: at },
        party: { partyId: null },
        inventory: {},
        stats: {
            classId,
            classProgressionLevel: 60,
            classProgressionClassId: classId,
            coldCombat: { effects: [], skills: [], skillSource: 'hot' }
        },
        simulation: { ownerId: 'legacy_main', revision: 0, leaseUntil: 0 }
    };
}
function hotActor(state) {
    const a = Cold.actorFor(state, Runtime.owned(1));
    let seated = false;
    a.state = {
        fetchDead: () => false,
        fetchCombats: () => false,
        fetchSeated: () => seated,
        setSeated: (v) => {
            seated = v;
        }
    };
    a.automation = { abortAll() {}, replenishVitals() {} };
    a.unselect = () => {};
    a.fetchKarma = () => 0;
    return a;
}
async function main() {
    const actors = [];
    try {
        await Database.createAccount('bot_hall_services', 'test');
        await Database.createCharacter('bot_hall_services', {
            name: 'HallVisitor',
            race: 0,
            classId: 88,
            maxHp: 10000,
            maxMp: 10000,
            sex: 0,
            face: 0,
            hair: 0,
            hairColor: 0,
            ...def.spawn
        });
        const character = (await Database.fetchCharacters('bot_hall_services'))[0];
        const id = Number(character.id);
        membership.set(id, 1);
        let state = stateFor(id);
        const physical = hotActor(state);
        actors.push(physical);
        const magic = hotActor(stateFor(id + 1, 94));
        actors.push(magic);
        assert(Services.missing(physical, Runtime.owned(1), at).some((s) => s.fetchSelfId() === 1086));
        assert(!Services.missing(magic, Runtime.owned(1), at).some((s) => s.fetchSelfId() === 1086));
        assert(Services.missing(magic, Runtime.owned(1), at).some((s) => s.fetchSelfId() === 1059));
        const haste2 = Services.skillFor({ id: 1086, level: 2 });
        Effects.apply(physical, { ...Services.effectFor(haste2, at), expiresAt: at + 30000 });
        assert(
            !Services.missing(physical, Runtime.owned(1), at).some((s) => s.fetchSelfId() === 1086),
            'never replace stronger haste'
        );
        const shield3 = Services.skillFor({ id: 1040, level: 3 });
        Effects.apply(physical, Services.effectFor(shield3, at));
        assert(!Services.missing(physical, Runtime.owned(1), at).some((s) => s.fetchSelfId() === 1040));
        const focus = Services.skillFor({ id: 1077, level: 1 });
        Effects.apply(physical, Services.effectFor(focus, at));
        assert(
            !Services.missing(physical, Runtime.owned(1), at).some((s) => s.fetchSelfId() === 1077),
            'unstacked buffs must not loop'
        );
        const full = hotActor(state);
        actors.push(full);
        for (let i = 0; i < Effects.BUFF_LIMIT; i++)
            Effects.apply(full, {
                key: `protected${i}`,
                id: 9000 + i,
                type: 'buff',
                expiresAt: at + 1200000,
                dispellable: false
            });
        assert.equal(
            Services.missing(full, Runtime.owned(1), at).length,
            0,
            'do not evict unrelated buffs for a hall visit'
        );
        const broadcasts = [];
        const session = {
            actor: physical,
            plan: 'hunting',
            dataSendToMe() {},
            dataSendToOthers() {},
            dataSendToMeAndOthers(packet, caster) { broadcasts.push({ packet, caster }); }
        };
        physical.session = session;
        // A player cast reserves the manual cast window; bots bypass it even at zero MP.
        assert(Services.cast(session, magic, npc, 1059, at).ok);
        broadcasts.length = 0;
        mp = 0;
        const requested = Services.missing(physical, Runtime.owned(1), at).map(skill => skill.fetchSelfId());
        Hot.tick(session, physical, at);
        assert.equal(mp, 0, 'bot support is independent of manager MP');
        assert.equal(Services.missing(physical, Runtime.owned(1), at).length, 0, 'one tick grants the whole requested set');
        for (const id of requested) assert(Effects.list(physical).some(effect => effect.id === id));
        assert.equal(session.clanHallVisit, null, 'a healthy bot finishes service in the same tick');
        assert.deepEqual(broadcasts.map(b => b.packet[0]), [0x48, 0x76], 'one completed animation for the entire batch');
        assert.equal(broadcasts[0].packet.readInt32LE(17), 0, 'batch animation has no cast delay');
        for (const { packet, caster } of broadcasts) {
            assert.strictEqual(caster, npc);
            assert.equal(packet.readInt32LE(1), npc.fetchId());
        }
        assert.equal(broadcasts[0].packet.readInt32LE(5), physical.fetchId());
        assert.equal(broadcasts[1].packet.readInt32LE(17), physical.fetchId());
        const waiting = { ...session, actor: magic, clanHallVisit: null, clanHallRetryAt: 0 };
        Hot.tick(waiting, magic, at);
        assert.equal(Services.missing(magic, Runtime.owned(1), at).length, 0,
            'a second bot receives its full set at the same timestamp, even during a player cast');
        assert.equal(waiting.clanHallVisit, null);
        const packetCount = broadcasts.length;
        assert.equal(Services.buffBot(session, physical, npc, at).count, 0);
        assert.equal(broadcasts.length, packetCount, 'fresh buffs do not trigger repeated animation');
        mp = 10000;
        const hotExpiry = Effects.list(physical).find((e) => e.id === 1204).expiresAt;
        const blocked = { ...session, clanHallVisit: null, clanHallRetryAt: 0, currentTargetId: 55 };
        assert.equal(Hot.tick(blocked, physical, at + 2000), false, 'combat target takes priority');
        assert.equal(Hot.tick({ ...session, clanHallVisit: null, clanHallRetryAt: 0, clanAllianceQuest: {} }, physical, at), false);
        const remote = hotActor({ ...state, loc: { locX: 0, locY: 0, locZ: 0 } });
        actors.push(remote);
        assert.equal(
            Hot.tick({ ...session, actor: remote, clanHallVisit: null, clanHallRetryAt: 0, followPlayerSession: {} }, remote, at),
            false,
            'do not abandon a party'
        );
        for (const guard of [
            { currentTargetId: 55 }, { incomingThreatId: 55 }, { pvpDefense: {} },
            { spotRelocation: {} }, { townEscape: {} }, { pendingTownTrip: {} },
            { clanAllianceQuest: {} }, { coldLifeState: { stats: { equipmentPlan: { clanGoal: {} } } } },
            { coldLifeState: { stats: { marketReturn: {} } } }
        ]) assert.equal(Hot.tick({ ...session, actor: remote, clanHallVisit: null, clanHallRetryAt: 0, ...guard }, remote, at),
            false, 'return for buffs must wait for combat, transport and existing duties');
        const nearby = hotActor({ ...state, loc: { ...def.spawn, locX: def.spawn.locX + 900 } });
        actors.push(nearby);
        assert(Hot.tick({ ...session, actor: nearby, clanHallVisit: null, clanHallRetryAt: 0 }, nearby, at));
        assert(moved > 0, 'visible bot approaches the manager instead of receiving remote buffs');
        mp = 0;
        const unbuffed = hotActor(state);
        actors.push(unbuffed);
        assert(Services.cast(null, unbuffed, npc, 1086, at + 10000, true).ok,
            'manual support also works with zero manager MP');
        assert.equal(mp, 0, 'manual support never consumes manager MP');
        assert(Effects.list(unbuffed).some(effect => effect.id === 1086));
        assert.equal(Services.cast(null, unbuffed, npc, 1086, at + 10000, true).code, 'manager_busy',
            'manual casts retain their cast interval');
        mp = 10000;
        assert(Cold.needed(state, at));
        assert.equal(Cold.needed({ ...state, stats: { ...state.stats, pveEncounter: { hp: 10 } } }, at), false);
        assert.equal(
            Cold.needed({ ...state, stats: { ...state.stats, equipmentPlan: { clanGoal: { goalKey: 'level' } } } }, at),
            false
        );
        assert.equal(Cold.needed({ ...state, party: { partyId: 'party' } }, at), false);
        // Death restart: where a dead bot of the hall's clan restarts, hot and cold.
        const hall = Runtime.owned(1);
        const restart = (extra, actor = physical) => Hot.restartHall({ plan: 'hunting', ...extra }, actor);
        assert.strictEqual(restart({}), hall, 'hot: a solo hunter restarts in the hall');
        assert.strictEqual(restart({ partyCompanion: true, followPlayerSession: {} }), null,
            'hot: a player companion restarts in town');
        assert.strictEqual(restart({ clanAllianceQuest: {} }), null, 'hot: an alliance courier restarts in town');
        assert.strictEqual(restart({ clanAllianceSupportLeaderId: 7 }), null);
        assert.strictEqual(restart({ plan: 'merchant' }), null, 'hot: a merchant restarts at its stall');
        assert.strictEqual(restart({}, { ...physical, fetchKarma: () => 10 }), null, 'hot: a red bot restarts in town');
        assert.strictEqual(restart({ hotBackgroundPartyId: 'party' }), hall, 'hot: a party member restarts in the hall');
        assert.strictEqual(restart({ coldLifeState: { stats: { marketReturn: { spotId: 'home' } } } }), hall,
            'hot: a bot with an errand restarts in the hall');
        const dead = { ...state, activity: 'dead', vitals: { ...state.vitals, hp: 0 } };
        assert.strictEqual(Cold.needed(dead, at), true, 'cold: a dead solo hunter restarts in the hall');
        assert.strictEqual(Cold.needed({ ...dead, party: { partyId: 'party' } }, at), false,
            'cold: a party member restarts in town');
        assert.strictEqual(Cold.needed({ ...dead, stats: { ...dead.stats, marketReturn: { spotId: 'home' } } }, at), false,
            'cold: a bot with an errand restarts in town');
        assert.strictEqual(Cold.needed({ ...dead, stats: { ...dead.stats, karma: 10 } }, at), false,
            'cold: a red bot restarts in town');
        assert.strictEqual(Cold.needed({ ...dead, accountName: 'bot_craft_probe' }, at), false,
            'cold: a craft account restarts in town');
        const distantState = { ...state, loc: { locX: 0, locY: 0, locZ: 0 } };
        assert(Cold.needed(distantState, at), 'missing useful buffs trigger a cold visit from anywhere');
        assert.equal(Cold.needed({ ...distantState, stats: { ...state.stats, marketReturn: {} } }, at), false);
        assert.equal(Cold.needed({ ...distantState, stats: { ...state.stats, clanHallRetryAt: at + 10000 } }, at), false);
        await Life.init();
        state = await Life.upsertState(state, 'hall_test_seed');
        assert(state);
        assert.equal(lifecycleKind(state, { clanHallServices: true }), 'command');
        let requests;
        const kernel = new ColdSimulationKernel({
            now: () => at,
            emit: (type, payload) => {
                if (type === 'command_request') requests = payload.requests;
            },
            resolveSolo: () => {
                throw Error('hall service must not simulate a fight');
            }
        });
        kernel.upsert({ state, context: { clanHallServices: true } });
        await kernel.resolveCommand(id);
        assert(requests?.[0].precomputedResult, 'worker requests a main-thread service operation');
        const returnSpot = { id: 'hall-return-test', name: 'Hunting field',
            center: { locX: 10000, locY: 15000, locZ: -3000 }, npcNames: [] };
        let selection;
        Spots.findBestSpot = (status, options) => { selection = { status, options }; return { spot: returnSpot }; };
        Spots.arrivalPointForState = () => ({ ...returnSpot.center });
        const safeDeparture = Departure.plan({ ...state, stats: { ...state.stats,
            spotBackoffs: [{ spotId: 'dangerous', until: at + 100000 }] } }, Runtime.owned(1), at);
        assert(safeDeparture);
        assert.equal(selection.options.spotRetryAfter.dangerous, Infinity, 'do not return to a dangerous spot');
        assert.equal(selection.options.mode, 'solo');
        // Karma closes the hall's teleport: any karma above 0 blocks it; none,
        // zero or negative karma does not.
        for (const [karma, blocked] of [[undefined, false], [null, false], [0, false], [-5, false], ['0', false], [NaN, false], [1, true], ['7', true], [45, true]]) {
            assert.strictEqual(!!Departure.plan({ ...state, stats: { ...state.stats, karma } }, Runtime.owned(1), at), !blocked,
                `hall departure with karma ${karma}`);
        }
        assert.equal(Departure.plan({ ...state, loc: { locX: 0, locY: 0, locZ: 0 } }, Runtime.owned(1), at), null,
            'hall departure is not a free teleport from anywhere');
        Spots.arrivalPointForState = () => null;
        assert.equal(Departure.plan(state, Runtime.owned(1), at), null, 'no teleport without a valid arrival point');
        Spots.arrivalPointForState = () => ({ ...returnSpot.center });
        let hotDestination;
        global.invoke = (name) => name === 'GameServer/Actor/Generics/TeleportTo'
            ? (_session, _actor, destination) => { hotDestination = destination; return true; }
            : originalInvoke(name);
        const remoteSession = { ...session, actor: remote, clanHallVisit: null, clanHallRetryAt: 0 };
        remote.session = remoteSession;
        assert(Hot.tick(remoteSession, remote, at));
        assert.deepEqual(hotDestination, def.spawn, 'a distant hot bot teleports to its owned hall');
        assert.equal(Effects.list(remote).length, 0, 'no buffs before the real teleport arrives');
        hotDestination = null;
        const movesBeforeArrival = moved;
        assert(Hot.tick(remoteSession, remote, at + 500));
        assert.equal(hotDestination, null, 'do not send duplicate teleports while arriving');
        assert.equal(moved, movesBeforeArrival, 'do not walk from the old coordinates during a teleport');
        remote.fetchLocX = () => def.spawn.locX;
        remote.fetchLocY = () => def.spawn.locY;
        remote.fetchLocZ = () => def.spawn.locZ;
        assert(Hot.tick(remoteSession, remote, at + 1200));
        assert.equal(Services.missing(remote, Runtime.owned(1), at + 1200).length, 0);
        assert.deepEqual(hotDestination, returnSpot.center, 'hot round trip ends at the selected farm');
        assert.equal(remoteSession.clanHallVisit, null);
        remote.fetchLocX = () => 0;
        remote.fetchLocY = () => 0;
        remote.fetchLocZ = () => 0;
        assert.equal(Hot.tick({ ...remoteSession, spotRelocation: null, clanHallRetryAt: 0 }, remote, at + 60000), false,
            'fresh buffs do not cause another remote visit');
        const refreshingSession = { ...remoteSession, spotRelocation: null, clanHallRetryAt: 0 };
        assert(Hot.tick(refreshingSession, remote, at + 1200000), 'ending hot buffs trigger the next return');
        assert.deepEqual(hotDestination, def.spawn);
        global.invoke = (name) => name === 'GameServer/Actor/Generics/TeleportTo'
            ? () => false : originalInvoke(name);
        const failedSession = { ...remoteSession, spotRelocation: null, clanHallVisit: null, clanHallRetryAt: 0 };
        assert.equal(Hot.tick(failedSession, remote, at + 1200000), false);
        assert.equal(failedSession.clanHallVisit, null);
        assert(failedSession.clanHallRetryAt > at + 1200000, 'failed teleports back off instead of looping');
        global.invoke = (name) => name === 'GameServer/Actor/Generics/TeleportTo'
            ? (_session, _actor, destination) => { hotDestination = destination; return true; }
            : originalInvoke(name);
        const departingActor = hotActor(state);
        actors.push(departingActor);
        const departing = { ...session, actor: departingActor, clanHallVisit: { hallId: def.id, expiresAt: at + 180000 } };
        departingActor.session = departing;
        mp = 0;
        assert(Hot.tick(departing, departingActor, at + 1000));
        assert.equal(Services.missing(departingActor, Runtime.owned(1), at + 1000).length, 0,
            'all buffs and departure happen in one hot tick');
        assert.deepEqual(hotDestination, returnSpot.center, 'a serviced hot bot teleports directly to hunting');
        assert.equal(departing.currentSpot.id, returnSpot.id);
        assert.equal(departing.spotRelocation.method, 'clan_hall');
        assert(departing.spotRelocation.arrivalPending, 'normal teleport settling prevents an immediate movement command');
        hotDestination = null;
        const grouped = { ...session, actor: full, followPlayerSession: {},
            clanHallVisit: { hallId: def.id, expiresAt: at + 180000 } };
        assert.equal(Hot.tick(grouped, full, at + 1000), false);
        assert.equal(hotDestination, null, 'party members stay with their party after support');
        global.invoke = originalInvoke;
        const recalled = await Cold.resolve({ ...state, loc: distantState.loc }, at);
        assert(recalled.ok && recalled.state.activity === 'clan_hall');
        assert.deepEqual(recalled.state.loc, def.spawn, 'cold return persists the owned hall destination');
        assert.equal(recalled.state.stats.coldCombat.effects.length, 0, 'cold bots also receive buffs only after arrival');
        assert(recalled.state.stats.clanHallVisit);
        assert.equal(recalled.state.stats.travel, null, 'remote return does not walk across the map');
        const outcome = await Cold.resolve(recalled.state, at + 1200);
        assert(outcome?.ok, 'cold service snapshot persists');
        state = outcome.state;
        assert.equal(mp, 0, 'cold batch also works without manager MP');
        assert.equal(Services.missing(Cold.actorFor(state, Runtime.owned(1)), Runtime.owned(1), at).length, 0,
            'one cold resolve grants the entire loadout and persists it before departure');
        mp = 10000;
        assert.equal(state.activity, 'hunting');
        assert.equal(state.stats.clanHallVisit, null, 'completed visit resumes hunting');
        assert.deepEqual(state.loc, returnSpot.center, 'cold departure persists an immediate teleport');
        assert.equal(state.spotId, returnSpot.id);
        assert.equal(state.stats.travel, null, 'no gatekeeper or walking leg after hall support');
        assert.equal(Cold.needed({ ...state, stats: { ...state.stats, clanHallRetryAt: 0 } }, at + 60000), false,
            'fresh buffs prevent another cold round trip even without the retry cooldown');
        assert(Cold.needed({ ...state, stats: { ...state.stats, clanHallRetryAt: 0 } }, at + 1200000),
            'ending buffs trigger another remote visit');
        const haste = state.stats.coldCombat.effects.find((e) => e.id === 1086);
        assert.equal(haste.level, 1, 'cold service preserves the C4 hall skill rank');
        assert(haste.expiresAt > at && haste.expiresAt < at + 1300000);
        const row = (await Database.execute(['SELECT statsJson FROM bot_life_state WHERE characterId=?', [id]]))[0];
        assert(JSON.parse(row.statsJson).coldCombat.effects.some((e) => e.id === 1086));
        assert.equal(Cold.needed(state, at + 60000), false, 'no repeat visit while buffs are fresh');
        const activated = hotActor({ ...state, stats: { ...state.stats, coldCombat: { effects: [] } } });
        actors.push(activated);
        invoke('GameServer/Actor/CharacterStatus').restoreEffects(null, activated, state.stats.coldCombat.effects);
        assert.equal(
            Effects.list(activated).find((e) => e.id === 1086).expiresAt,
            haste.expiresAt,
            'cold-to-hot activation keeps the original expiry, without a fresh 20 minutes'
        );
        Runtime.applyRows([{ ...hallRow, functionsJson: '{"support":8,"hp":100}' }]);
        const wounded = {
            ...state,
            loc: { ...def.spawn },
            vitals: { ...state.vitals, hp: 10 },
            stats: { ...state.stats, clanHallRetryAt: 0, coldCombat: { effects: [] } }
        };
        const woundedActor = hotActor(wounded);
        actors.push(woundedActor);
        const restingSession = { ...session, actor: woundedActor, clanHallVisit: null, clanHallRetryAt: 0 };
        woundedActor.session = restingSession;
        assert(Hot.tick(restingSession, woundedActor, at + 30000));
        assert.equal(Services.missing(woundedActor, Runtime.owned(1), at + 30000).length, 0);
        assert(restingSession.clanHallVisit && woundedActor.state.fetchSeated(),
            'instant hot buffs still allow the bot to stay for health recovery');
        const recovering = await Cold.resolve(wounded, at + 30000);
        assert(recovering.ok && recovering.state.stats.clanHallVisit);
        assert.equal(recovering.state.activity, 'clan_hall', 'cold bots also stay to recover after receiving all buffs');
        assert.equal(Services.missing(Cold.actorFor(recovering.state, Runtime.owned(1)), Runtime.owned(1), at + 30000).length, 0);
        assert.deepEqual(recovering.state.loc, def.spawn);
        Runtime.applyRows([{ ...hallRow, functionsJson: '{"hp":100}' }]);
        assert.equal(Cold.needed({ ...wounded, loc: distantState.loc }, at + 30000), false,
            'recovery alone does not enable remote recall when the hall has no useful buffs');
        Runtime.applyRows([hallRow]);
        const travelStart = {
            ...state,
            activity: 'hunting',
            loc: { ...def.spawn, locX: def.spawn.locX + 900 },
            stats: { ...state.stats, clanHallRetryAt: 0, coldCombat: { ...state.stats.coldCombat, effects: [] } }
        };
        let walking = await Cold.resolve(travelStart, at + 60000);
        assert(walking.ok && walking.state.activity === 'traveling');
        assert.equal(walking.state.stats.coldCombat.effects.length, 0, 'walking grants no remote buffs');
        walking = await Cold.resolve(walking.state, walking.state.stats.travel.arrivalAt + 1);
        assert(walking.ok && walking.state.activity === 'clan_hall');
        assert.equal(walking.state.stats.coldCombat.effects.length, 0, 'arrival is separate from service use');
        const arrived = await Cold.resolve(walking.state, walking.state.timing.nextResolveAt);
        assert(arrived.ok && arrived.state.stats.coldCombat.effects.length > 0);
        const death = {
            ...state,
            activity: 'dead',
            vitals: { ...state.vitals, hp: 0 },
            stats: { ...state.stats, clanHallRetryAt: 0 }
        };
        const respawned = await Cold.resolve(death, at + 80000);
        assert(respawned.ok);
        assert.deepEqual(respawned.state.loc, def.spawn, 'cold death returns to the actual owned hall');
        assert.equal(respawned.state.stats.coldCombat.effects.length, 0, 'death does not preserve old buffs');
        assert.equal(Runtime.Policy.desired(def, [{ level: 60, classId: 94 }]).support, 8);
        assert(hotExpiry > at); // The native effect keeps an absolute deadline for persistence.
        const lost = {
            ...state,
            activity: 'clan_hall',
            stats: { ...state.stats, clanHallVisit: { hallId: def.id, startedAt: at, expiresAt: at + 180000 } }
        };
        membership.delete(id);
        const cancelled = await Cold.resolve(lost, at + 70000);
        assert(cancelled.ok && !cancelled.state.stats.clanHallVisit, 'membership loss cancels an in-progress visit');
        membership.set(id, 1);
        const later = Services.cast(session, magic, npc, 1059, at + 200000);
        assert(later.ok, 'the next recipient can use the manager after the shared interval');
        const lastPackets = broadcasts.slice(-2).map(b => b.packet);
        assert.deepEqual(lastPackets.map(p => p[0]), [0x48, 0x76]);
        assert.equal(lastPackets[0].readInt32LE(5), magic.fetchId());
        assert.equal(lastPackets[1].readInt32LE(17), magic.fetchId(), 'launch never retains the previous recipient');
        Runtime.applyRows([{ ...hallRow, serviceDueAt: at - 1 }]);
        assert.equal(Services.missing(magic, Runtime.owned(1), at).length, 0);
        assert.equal(Services.cast(null, magic, npc, 1059, at, true).code, 'not_authorized');
        assert.equal(Services.buffBot(null, magic, npc, at, true).code, 'not_authorized');
        assert.equal(Cold.needed(distantState, at), false, 'unpaid support cannot trigger a remote visit');
        assert.equal(Hot.tick({ ...session, actor: remote, clanHallVisit: null, clanHallRetryAt: 0 }, remote, at), false);
        const Resolver = invoke('GameServer/Bot/Population/BackgroundResolver');
        const weak = {
            ...state,
            vitals: { hp: 10, maxHp: 10000, mp: 10, maxMp: 10000 },
            stats: { ...state.stats, restUntil: 0 }
        };
        const regular = Resolver.resolveRest(weak, 3000, at);
        const boosted = Resolver.resolveRest(weak, 3000, at, { hpMultiplier: 2, mpMultiplier: 1.4 });
        assert(Math.abs(boosted.patch.vitals.hp - 10 - 2 * (regular.patch.vitals.hp - 10)) < 0.01);
        assert(Math.abs(boosted.patch.vitals.mp - 10 - 1.4 * (regular.patch.vitals.mp - 10)) < 0.01);
        console.log(
            'Clan hall bot service selection, hot casting, cold persistence, worker routing, safety and recovery checks passed'
        );
    } finally {
        actors.forEach((a) => Ticker.clearAll(a));
        global.invoke = originalInvoke;
        Spots.findBestSpot = originalBestSpot;
        Spots.arrivalPointForState = originalArrival;
        World.npc = originalNpc;
        Approach.hasLineOfSight = originalLos;
        Navigation.move = originalMove;
        Runtime.applyRows([]);
        await Database.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
}
main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
