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
const Geo = invoke('GameServer/Geodata/GeodataEngine');
const Generics = invoke(path.actor);

// Which monster a hot party prefers when its leader scans for the next pull
// (U10, step 1.5). The cold party resolver asks PartyHuntingTarget.npcId.
const saved = [];
function replace(object, key, value) { const old = object[key]; saved.push(() => object[key] = old); object[key] = value; }
function actor(id, x = 0, kind = null) {
    return { x, hp: 100, fetchId: () => id, fetchSelfId: () => id, fetchKind: kind ? () => kind : undefined,
        fetchLocX() { return this.x; }, fetchLocY: () => 0, fetchLocZ: () => 0,
        fetchHp() { return this.hp; }, fetchMaxHp: () => 100, fetchMp: () => 100, fetchMaxMp: () => 100,
        fetchLevel: () => 20, fetchIsOnline: () => true, isDead() { return this.hp <= 0; },
        state: { seated: false, fetchSeated() { return this.seated; }, setSeated(v) { this.seated = v; } },
        automation: { replenishVitals() {} }, select() {}, moveTo(coords) { this.moved = true; this.move = coords; } };
}
try {
    replace(Geo, 'hasLineOfSight', () => true);
    const group = [1, 2].map(id => ({ accountId: `bot_hot_target_${id}`, fetchAccountId() { return this.accountId; },
        hotBackgroundPartyId: 'group', actor: actor(id), dataSendToOthers() {} }));
    const [leader] = group;
    const party = { partyId: 'group', leaderId: 1, memberIds: [1, 2], status: 'hot', stats: {} };
    replace(Parties, 'find', () => party);
    replace(World, 'user', { sessions: [], revision: 0 });
    group.forEach(session => World.insertUser(session));
    // The nearest monster is 21; 20 is the one a target would prefer.
    const planned = actor(20, 400, 'Monster'), nearest = actor(21, 20, 'Monster');
    replace(World, 'fetchNpcsInRadius', () => [nearest, planned]);
    replace(Awareness, 'npcThreateningActor', () => null);
    replace(Restrictions, 'canUseBasicAction', () => true);
    replace(Restrictions, 'canMove', () => true);
    replace(Raid, 'isProtectedRaidEntity', () => false);
    replace(Roles, 'shouldRestForMana', () => false);
    replace(Tactics, 'stop', () => {});
    replace(Tactics, 'support', () => false);
    const AI = { executeCombat() {} };
    let now = 10000;
    const pick = (stats, leaderState = null) => {
        party.stats = stats;
        leader.coldLifeState = leaderState;
        leader.backgroundHuntTarget = null;
        leader.nextBackgroundTargetScanAt = 0;
        now += 10000;
        Party.tick(leader, leader.actor, Generics, AI, now);
        return leader.backgroundHuntTarget?.fetchSelfId();
    };
    const plan = (status) => ({ stats: { equipmentPlan: { status, next: { npcId: 20 } } } });

    assert.strictEqual(pick({}), 21, 'no target: the nearest monster');
    assert.strictEqual(pick({ objective: { npcId: 20 } }), 20, 'the shared objective wins');
    assert.strictEqual(pick({ acquisitionGoal: { status: 'active', next: { npcId: 20 } } }), 20,
        'the party gear goal');
    // As the cold party: only an active party goal steers the pull.
    assert.strictEqual(pick({ acquisitionGoal: { status: 'completed', next: { npcId: 20 } } }), 21,
        'an inactive party goal does not steer the pull');
    // As the cold party: without a party goal the leader's active gear plan does.
    assert.strictEqual(pick({}, plan('active')), 20, 'the leader plan steers the pull');
    assert.strictEqual(pick({}, plan('completed')), 21, 'a finished leader plan does not');
    // As the cold party: a clan help party hunts its shared spot, not a gear goal.
    assert.strictEqual(pick({ objective: { reason: 'clan_help' },
        acquisitionGoal: { status: 'active', next: { npcId: 20 } } }), 21,
    'a clan help party ignores the gear goal');
    console.log('Hot party target checks passed');
} finally { saved.reverse().forEach(restore => restore()); }
