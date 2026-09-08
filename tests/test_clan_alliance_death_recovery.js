const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
require('../src/Global');
const BotAI = invoke('GameServer/Bot/BotAI');

// Native death -> quest callback -> native revive/teleport. Only time,
// networking and world services are controlled; no test manually revives bots.
let now = 100000;
class Clock extends Date { static now() { return now; } }
const timers = [], packets = [], wakeups = [], trips = [], lifecycle = [];
function advance(ms) {
    now += ms;
    while (timers.some(t => t.at <= now)) {
        const index = timers.findIndex(t => t.at <= now);
        timers.splice(index, 1)[0].fn();
    }
}
function actor(id, x = 10000) {
    const a = { x, y: 10000, z: -3000, hp: 100, mp: 50, online: true, effects: {},
        fetchId: () => id, fetchClanId: () => 1, fetchClassId: () => 33, fetchKarma: () => 0,
        fetchName: () => `Courier${id}`, fetchIsOnline: () => a.online, fetchPrivateStore: () => false,
        fetchLocX: () => a.x, fetchLocY: () => a.y, fetchLocZ: () => a.z,
        fetchHp: () => a.hp, fetchMaxHp: () => 100, fetchMp: () => a.mp, fetchMaxMp: () => 50,
        isDead: () => a.state.dead,
        fillupVitals() { a.hp = 100; a.mp = 50; }, clearDestId() {}, unselect() {}, destructor() {},
        attack: { abortCast() {}, clearTimers() {} },
        automation: { abortAll() {}, stopReplenish() {}, replenishVitals() { assert.fail('must restore vitals immediately'); } },
        state: { dead: false, casts: false, hits: false, seated: false,
            setDead(v) { this.dead = v; }, setCasts(v) { this.casts = v; }, setHits(v) { this.hits = v; },
            fetchCasts() { return this.casts; }, fetchSeated() { return this.seated; }, setSeated(v) { this.seated = v; },
            destructor() { this.casts = this.hits = this.seated = false; } }
    };
    return a;
}
const leader = { accountId: 'player', actor: actor(1, 40000) };
const courier = { accountId: 'bot_recovery_test', actor: actor(2), aiActive: true,
    partyCompanion: true, followPlayerSession: leader, plan: 'following',
    clanAllianceQuest: { clanId: 1, leaderId: 1 },
    dataSendToMeAndOthers(packet) { packets.push(packet); lifecycle.push(packet.type); }, dataSendToOthers() {} };
courier.actor.session = courier;
const originalAssignment = courier.clanAllianceQuest;
const state = { kind: 'player', stage: 'gathering', leaderId: 1,
    members: [{ id: 2, herb: true, blood: true, delivered: false }], bloodObtained: true };
const stateBefore = JSON.stringify(state);
const world = { user: { sessions: [leader, courier] } };
const mocks = {
    Database: {}, 'GameServer/World/World': world,
    'GameServer/Bot/BotManager': { botPartySay: (s, message) => { lifecycle.push('report'); return true; } },
    'GameServer/Bot/BotAI': {
        clearTacticalState: BotAI.clearTacticalState,
        beginPartyTownRecovery: BotAI.beginPartyTownRecovery,
        getDeathRespawnTarget: BotAI.getDeathRespawnTarget,
        wakeup: (s, options) => wakeups.push({ s, options })
    },
    'GameServer/Bot/AI/BotSpotTravel': {
        cancel(s) { if (s.spotRelocation?.arrivalPending) return false; s.spotRelocation = undefined; return true; },
        startViaEscape: (...args) => { trips.push(args); return true; }
    },
    'GameServer/Bot/AI/CompanionNavigationRecovery': {},
    'GameServer/Bot/AI/PartyAwareness': { npcThreateningActor: () => null },
    'GameServer/Geodata/GeodataEngine': { getHeight: (x, y, z) => z, hasLineOfSight: () => true },
    'GameServer/Effects/EffectStore': { prune() {} },
    'GameServer/Effects/EffectTicker': { clearAll() {}, refreshEffects() {} },
    'GameServer/Actor/Generics/CalculateStats': () => {},
    'GameServer/Skills/ChargeLifecycle': { clear() {} },
    'GameServer/World/ArenaDuelService': { onPlayerDeath: () => false },
    'GameServer/Bot/AI/BotEventJournal': { record: async () => {} },
    'GameServer/Pets/PetTravel': { begin: () => [], finish() {} },
    'GameServer/Actor/Generics': { updatePosition(s, a, p) { a.x = p.locX; a.y = p.locY; a.z = p.locZ; } },
    'GameServer/Network/Response': {
        die: id => ({ type: 'die', id }), revive: id => ({ type: 'revive', id }),
        socialAction: id => ({ type: 'stand', id }), teleportToLocation: (id, coords) => ({ type: 'teleport', id, coords })
    }
};
function load(name) {
    const filename = path.resolve(__dirname, '..', 'src', `${name}.js`), module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, require: createRequire(filename),
        invoke: key => { assert(key in mocks, key); return mocks[key]; }, path: { actor: 'GameServer/Actor/Generics' },
        Date: Clock, setTimeout: (fn, ms) => timers.push({ at: now + ms, fn }),
        utils: { infoWarn: (...args) => assert.fail(args.join(' ')) }
    }, { filename });
    return mocks[name] = module.exports;
}
const service = load('GameServer/Clan/ClanAllianceService');
const questAI = load('GameServer/Bot/AI/ClanAllianceQuestAI');
const die = load('GameServer/Actor/Generics/Die');
load('GameServer/Actor/Generics/Revive');
const teleport = load('GameServer/Actor/Generics/TeleportTo');
service.records.set(1, state);

// A landing queued before death must never overwrite the town restart.
const oldLanding = { locX: 99999, locY: 99999, locZ: -3000 };
teleport(courier, courier.actor, oldLanding);
courier.spotRelocation = { arrivalPending: true, token: 'old-trip' };
packets.length = 0;
lifecycle.length = 0;
courier.currentTargetId = 999;
courier.incomingThreatId = 998;
courier.partyReviveCombatPauseStartedAt = now;
courier.deathTimerStart = now;
courier.actor.hp = 0;
die(courier, courier.actor);
assert.deepStrictEqual(packets.map(p => p.type), ['die'], 'lethal callback must finish before revival');
assert.deepStrictEqual(lifecycle, ['die', 'report'], 'the client receives death before the quest death announcement');
advance(0);
assert.strictEqual(courier.actor.isDead(), false, 'courier revives without advancing the death wait timer');
assert.deepStrictEqual(packets.map(p => p.type), ['die', 'revive', 'stand', 'teleport']);
assert.strictEqual(courier.actor.hp, 100);
assert.strictEqual(courier.actor.mp, 50);
assert.strictEqual(courier.spotRelocation, undefined);
assert.strictEqual(courier.incomingThreatId, undefined);
assert.strictEqual(courier.deathTimerStart, undefined);
assert.strictEqual(courier.partyReviveCombatPauseStartedAt, undefined);
assert.strictEqual(courier.clanAllianceQuest, originalAssignment);
assert.strictEqual(courier.followPlayerSession, leader);
assert.strictEqual(courier.partyCompanion, true);
assert.strictEqual(courier.resumeAfterBuff, null);
assert.strictEqual(JSON.stringify(state), stateBefore, 'recovery neither clears nor grants quest items/progress');
const town = packets.at(-1).coords;
assert(Math.hypot(town.locX - oldLanding.locX, town.locY - oldLanding.locY) > 1000);
assert(questAI.tick(courier, courier.actor, {}, {}), 'AI waits for the town teleport to settle');
assert.strictEqual(trips.length, 0);
advance(1000);
assert.strictEqual(courier.actor.x, town.locX, 'old landing cannot replace the town destination');
assert.strictEqual(wakeups.length, 1, 'only the current teleport wakes the courier');
assert.strictEqual(wakeups[0].options.urgent, true);
advance(201);
courier.clanAllianceRefreshAt = now + 5000;
assert(questAI.tick(courier, courier.actor, {}, {}));
assert.strictEqual(trips.length, 1, 'courier resumes delivery of already earned ingredients');
assert.strictEqual(trips[0][2].id, 'alliance-leader');

// An already dead courier also recovers through the BotAI fallback, and an
// already alive actor cannot be teleported twice by a duplicate callback.
courier.actor.state.dead = true; courier.actor.hp = 0;
assert.strictEqual(service.recoverDeadCourier(courier), true);
assert.strictEqual(service.recoverDeadCourier(courier), false);
advance(1201);

for (const change of ['failed', 'cured', 'human', 'other_clan', 'removed', 'offline', 'leader_dead']) {
    state.stage = 'gathering'; state.members = [{ id: 2 }];
    courier.accountId = 'bot_recovery_test'; courier.actor.online = true;
    courier.clanAllianceQuest = originalAssignment; leader.actor.state.dead = false;
    courier.actor.state.dead = true; courier.actor.hp = 0;
    if (change === 'failed' || change === 'cured') state.stage = change;
    if (change === 'human') courier.accountId = 'human_member';
    if (change === 'other_clan') courier.clanAllianceQuest = { clanId: 2, leaderId: 1 };
    if (change === 'removed') state.members = [];
    if (change === 'offline') courier.actor.online = false;
    if (change === 'leader_dead') leader.actor.state.dead = true;
    assert.strictEqual(service.recoverDeadCourier(courier), false, `${change} must not receive quest recovery`);
}
state.stage = 'gathering'; state.members = [{ id: 2 }]; leader.actor.state.dead = false;
courier.accountId = 'bot_recovery_test'; courier.actor.online = true; courier.clanAllianceQuest = originalAssignment;
service.onDeath(courier);
state.stage = 'failed';
advance(0);
assert(courier.actor.isDead(), 'cancellation before the callback prevents quest recovery');

state.stage = 'loyalty';
state.members[0].pledged = true;
service.onDeath(courier);
advance(0);
assert(courier.actor.isDead(), 'altar sacrifice must not use the gathering auto-revive');
assert.strictEqual(service.recoverDeadCourier(courier), false);
assert.strictEqual(service.awaitingRitualResurrection(courier), true, 'ritual corpse must wait for an ally resurrection');
advance(60001);
assert(courier.actor.isDead(), 'elapsed time does not automatically revive a ritual corpse');
state.stage = 'failed';
assert.strictEqual(service.awaitingRitualResurrection(courier), false, 'abandoning the quest releases the ritual corpse');
console.log('Clan alliance immediate death recovery: native packets, town, continuation, stale landing, cancellation and scope passed');
