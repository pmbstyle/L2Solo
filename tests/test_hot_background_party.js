const assert = require('assert');
require('../src/Global');
const Party = invoke('GameServer/Bot/AI/HotBackgroundParty');
const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
const World = invoke('GameServer/World/World');
const Awareness = invoke('GameServer/Bot/AI/PartyAwareness');
const Tactics = invoke('GameServer/Bot/AI/BotPvpTactics');
const Restrictions = invoke('GameServer/Effects/EffectRestrictions');
const Raid = invoke('GameServer/Bot/AI/BotRaidSafety');
const Roles = invoke('GameServer/Bot/AI/BotRoles');
const NpcDied = invoke('GameServer/Actor/Generics/NpcDied');
const Generics = invoke(path.actor);
const saved = [];
function replace(object, key, value) { const old = object[key]; saved.push(() => object[key] = old); object[key] = value; }
function actor(id, x = 0, kind = null) {
    return { x, hp: 100, fetchId: () => id, fetchSelfId: () => id, fetchKind: () => kind,
        fetchLocX() { return this.x; }, fetchLocY: () => 0, fetchLocZ: () => 0,
        fetchHp() { return this.hp; }, fetchMaxHp: () => 100, fetchMp: () => 100, fetchMaxMp: () => 100,
        fetchLevel: () => 20, fetchIsOnline: () => true, isDead() { return this.hp <= 0; },
        state: { seated: false, fetchSeated() { return this.seated; }, setSeated(v) { this.seated = v; } },
        automation: { replenishVitals() {} }, select() {}, moveTo(coords) { this.moved = true; this.move = coords; } };
}
try {
    const group = [1, 2, 3].map(id => ({ hotBackgroundPartyId: 'group', actor: actor(id), dataSendToOthers() {} }));
    const [leader, healer, follower] = group;
    const party = { partyId: 'group', leaderId: 1, memberIds: [1, 2, 3], status: 'hot', stats: { objective: { npcId: 20 } } };
    replace(Parties, 'find', () => party);
    replace(World, 'user', { sessions: group });
    const wanted = actor(20, 400, 'Monster'), other = actor(21, 20, 'Monster');
    replace(World, 'fetchNpcsInRadius', () => [other, wanted]);
    replace(Awareness, 'npcThreateningActor', s => s.incoming || null);
    replace(Restrictions, 'canUseBasicAction', () => true);
    replace(Restrictions, 'canMove', () => true);
    replace(Raid, 'isProtectedRaidEntity', npc => !!npc.raid);
    replace(Roles, 'shouldRestForMana', () => false);
    replace(Tactics, 'stop', () => {});
    let healing = false;
    replace(Tactics, 'support', () => healing);
    const attacks = [];
    const AI = { executeCombat: (s, _bot, target) => attacks.push([s.actor.fetchId(), target.fetchId()]) };
    const tick = s => Party.tick(s, s.actor, Generics, AI, 10000);
    follower.partyGroundPickupInProgress = true;
    follower.partyGroundPickupDeadlineAt = 15000;
    tick(leader);
    assert.strictEqual(leader.lastDecision.action, 'party_wait_loot', 'a fresh pull waits for the physical collector');
    assert.strictEqual(attacks.length, 0);
    leader.incoming = wanted;
    tick(leader);
    assert.strictEqual(attacks.length, 1, 'an incoming monster still interrupts the loot wait');
    leader.incoming = null;
    leader.backgroundHuntTarget = null;
    attacks.length = 0;
    follower.partyGroundPickupInProgress = false;
    leader.partyRevivalAttempt = { targetId: follower.actor.fetchId(), startedAt: Date.now() };
    tick(leader); tick(follower);
    assert.strictEqual(leader.partyRevivalAttempt, null, 'a living roster clears a completed resurrection before a later death');
    assert.deepStrictEqual(attacks, [[1, 20], [3, 20]], 'party shares the objective target, not the nearest unrelated mob');
    healing = true; tick(healer);
    assert.strictEqual(attacks.length, 2, 'healing owns the action instead of also attacking');
    healing = false;
    follower.actor.x = 3000; tick(follower);
    assert(follower.actor.moved, 'distant follower regroups');
    follower.incoming = actor(22, 3100, 'Monster'); tick(follower);
    assert.deepStrictEqual(attacks.at(-1), [3, 22], 'an isolated member defends against its actual attacker');
    follower.incoming.raid = true;
    assert.strictEqual(tick(follower), false, 'raid protection remains owned by the existing escape path');
    follower.incoming = null; follower.actor.x = 0;
    leader.backgroundHuntTarget = null; leader.actor.hp = 40;
    tick(healer);
    assert(healer.actor.state.fetchSeated(), 'group waits for recovery before a new pull');

    // The last local monster is gone: the leader must walk to the next part
    // of its spot, without widening each member's combat scan or teleporting.
    leader.actor.hp = 100;
    const Spots = invoke('GameServer/Bot/AI/SpotService');
    const Geo = invoke('GameServer/Geodata/GeodataEngine');
    party.spotId = 'test';
    const spot = { id: 'test', arrivalPoints: [{ locX: 2800, locY: 0, locZ: 0 }] };
    replace(Spots, 'findById', () => spot);
    replace(Spots, 'findCurrentSpot', point => ({ id: point.locX < 4000 ? 'test' : 'other' }));
    let geoChecks = 0;
    replace(Geo, 'getCellData', x => { geoChecks++; return { nswe: x === 1900 ? 0 : 15, z: x === 2100 ? 1000 : 0 }; });
    const remote = actor(30, 2300, 'Monster'), blocked = actor(31, 1900, 'Monster');
    const raid = actor(32, 2000, 'Monster'); raid.raid = true;
    const dead = actor(33, 2050, 'Monster'); dead.hp = 0;
    const upstairs = actor(34, 2100, 'Monster'); upstairs.fetchLocZ = () => 1000;
    const outside = actor(35, 4100, 'Monster');
    let available = [blocked, raid, dead, upstairs, remote, outside];
    let wideScans = 0;
    replace(World, 'fetchNpcsInRadius', (x, _y, radius) => {
        if (radius > 1800) wideScans++;
        return available.filter(n => Math.abs(n.x - x) <= radius);
    });
    const searchTick = (s, now = 20000) => Party.tick(s, s.actor, Generics, AI, now);
    leader.nextBackgroundTargetScanAt = 0;
    searchTick(follower);
    assert.strictEqual(wideScans, 0, 'followers do not scan the wider spot');
    searchTick(leader);
    assert.strictEqual(leader.lastDecision.action, 'party_search');
    assert.strictEqual(leader.actor.move.to.locX, 2300, 'skip blocked, dead, raid and wrong-floor destinations');
    assert.strictEqual(geoChecks, 3);
    assert.strictEqual(attacks.at(-1)[1], 22, 'a distant monster is a travel destination, not an immediate combat target');
    searchTick(leader, 21000);
    assert.strictEqual(wideScans, 1, 'search retries are bounded');
    leader.pendingPathRequest = {};
    searchTick(leader, 26000);
    assert.strictEqual(wideScans, 1, 'pending native routes are not replaced');
    leader.pendingPathRequest = null;
    leader.actor.x = 700;
    available = [remote];
    searchTick(leader, 29000);
    assert.strictEqual(leader.lastDecision.action, 'party_hunt', 'entering normal range starts native combat');
    assert.strictEqual(attacks.at(-1)[1], 30);
    leader.actor.x = 0; leader.backgroundHuntTarget = null;
    available = [raid, dead, upstairs, outside];
    spot.arrivalPoints[0].locZ = 700;
    searchTick(leader, 30000);
    assert.strictEqual(leader.actor.move.to.locX, 2800, 'empty spots use a known spawn point inside the same spot');
    assert.strictEqual(leader.actor.move.to.locZ, 0, 'spawn metadata is projected onto a reachable local terrain surface');
    available = [remote];
    spot.arrivalPoints = [];
    searchTick(leader, 35000);
    assert.strictEqual(leader.lastDecision.action, 'party_search_wait', 'failed destinations are not retried immediately');
    follower.actor.x = 1500;
    searchTick(leader, 36000);
    assert.strictEqual(leader.lastDecision.action, 'party_wait_roster', 'leader waits for separated members');
    follower.actor.x = 0;
    leader.actor.hp = 40;
    const scansBeforeRecovery = wideScans;
    searchTick(leader, 42000);
    assert.strictEqual(leader.lastDecision.action, 'party_recovery');
    assert.strictEqual(wideScans, scansBeforeRecovery, 'recovery takes priority over exploring');
    leader.incoming = other;
    searchTick(leader, 44000);
    assert.strictEqual(attacks.at(-1)[1], other.fetchId(), 'incoming combat interrupts recovery and exploration');
    leader.incoming = null; leader.backgroundHuntTarget = null;
    leader.actor.hp = 100;
    available = []; spot.arrivalPoints = [];
    searchTick(leader, 50000);
    assert.strictEqual(leader.lastDecision.action, 'party_search_wait', 'no reachable destination is explicit, not a stale hunt');
    leader.backgroundSearchHistory.clear();
    spot.arrivalPoints = Array.from({ length: 9 }, (_, i) => ({ locX: 1000 + i * 200, locY: 0, locZ: 0 }));
    let boundedChecks = 0;
    replace(Geo, 'getCellData', x => { boundedChecks++; return { nswe: x === 2600 ? 15 : 0, z: 0 }; });
    searchTick(leader, 56000);
    assert.strictEqual(boundedChecks, 8, 'terrain work is capped per search');
    assert.strictEqual(leader.lastDecision.action, 'party_search_wait');
    searchTick(leader, 62000);
    assert.strictEqual(leader.actor.move.to.locX, 2600, 'rejected points cannot starve a later valid destination');

    // Exercise the real death callback: every nearby native party actor gets
    // the C4 share, including a healer that never hit the monster.
    leader.actor.hp = 100;
    replace(World, 'removeNpc', () => {});
    replace(Generics, 'abortCombatState', () => {});
    const rewards = [];
    replace(Generics, 'experienceReward', (s, _a, exp, sp) => rewards.push({ id: s.actor.fetchId(), exp, sp }));
    replace(invoke('GameServer/Quest/QuestService'), 'onKill', async () => {});
    replace(invoke('GameServer/Pets/PetRuntime'), 'rewardDamage', () => 1);
    const sharedHunts = [];
    replace(invoke('GameServer/Social/SharedHuntMemory'), 'recordHot', shares => sharedHunts.push(shares));
    wanted.fetchAcquiredExp = () => 100;
    wanted.fetchRewardSp = () => 10;
    NpcDied(follower, follower.actor, wanted);
    assert.deepStrictEqual(rewards.map(r => r.id).sort(), [1, 2, 3]);
    assert(rewards.every(r => r.exp > 0 && r.sp > 0));
    assert.strictEqual(sharedHunts[0].length, 3, 'shared hunt memory receives all rewarded party members');
    const Loot = invoke('GameServer/Bot/AI/PartyCompanionService');
    assert.deepStrictEqual(Loot.adenaAllocations(follower, 10, wanted).map(r => r.amount), [4, 3, 3]);
    const Data = invoke('GameServer/DataCache');
    const Rates = invoke('GameServer/ProgressionRates');
    replace(Data, 'fetchNpcRewardsFromSelfId', (_id, cb) => cb({ rewards: [{}] }));
    replace(Data, 'fetchItemFromSelfId', (id, cb) => cb({ selfId: id, etc: { stackable: true } }));
    replace(Rates, 'rewardGroupRoll', () => ({ hit: true, itemRate: 1 }));
    replace(Rates, 'selectDropItem', () => ({ selfId: 57 }));
    replace(Rates, 'rollDropAmount', () => 10);
    replace(Math, 'random', () => 0.5);
    group.forEach(s => { s.accountId = `bot_${s.actor.fetchId()}`; });
    const drops = [];
    invoke('GameServer/World/Generics/NpcRewards').call({
        purchaseItem: () => assert.fail('hot drops must be picked up from the ground'),
        spawnItem: (_s, id, amount, coords) => drops.push([id, amount, coords.partyLootLeaderId])
    }, follower, wanted);
    assert.deepStrictEqual(drops, [[57, 10, 1]], 'hot party drops stay on the ground and belong to the party leader');
    console.log('Hot background party: common objective, recovery, regroup, defense, native rewards and shared hunt memory passed');
} finally { saved.reverse().forEach(restore => restore()); }
