const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const BackgroundDropResolver = invoke('GameServer/Bot/Population/BackgroundDropResolver');
const ClanSimulationConfig = invoke('GameServer/Clan/ClanSimulationConfig');
const Contracts = invoke('GameServer/Clan/ClanSimulationContracts');

DataCache.init();

assert.strictEqual(ClanSimulationConfig.founderMinLevel, 20);
assert.strictEqual(ClanSimulationConfig.founderQuorum, 5);
assert.strictEqual(ClanSimulationConfig.maxBotClans, 40);
assert.strictEqual(ClanSimulationConfig.maxBotMemberShare, 0.70);
assert.strictEqual(ClanSimulationConfig.bloodMarkItemId, 1419);
assert.strictEqual(ClanSimulationConfig.bloodMarkSourceNpcId, 12079);
assert.strictEqual(ClanSimulationConfig.catastrophicFailureThreshold, 5);

assert(Contracts.isReasonCode(Contracts.REASON_CODES.FOUNDER_NO_QUORUM));
assert(!Contracts.isReasonCode('not_a_clan_reason'));

const goal = Contracts.normalizeGoal({
    type: 'item',
    target: { itemId: 1419 },
    required: 1,
    progress: 0,
    plan: { kind: 'farm', sourceId: 12079 },
    assignedMemberIds: [12, 11, 12],
    catastrophicFailures: 2,
    status: 'executing',
    reasonCodes: [Contracts.REASON_CODES.PARTY_NOT_READY]
}, 1234);
assert.deepStrictEqual(goal.assignedMemberIds, [11, 12]);
assert.strictEqual(goal.target.itemId, 1419);
assert.strictEqual(goal.plan.kind, 'farm');
assert.strictEqual(goal.createdAt, 1234);

const state = Contracts.normalizeState({
    clanId: 77,
    leaderId: 12,
    level: 4,
    memberIds: [12, 11, 12],
    goal,
    contributionLedgerVersion: 3,
    warehouseRevision: 5
}, 1234);
assert.strictEqual(state.version, Contracts.STATE_VERSION);
assert.strictEqual(state.level, 3);
assert.deepStrictEqual(state.memberIds, [11, 12]);
assert.strictEqual(state.goal.plan.kind, 'farm');

const reward = (DataCache.npcRewards || []).find((entry) => entry.selfId === 12079);
assert(reward, 'Bloody Queen reward entry must be loaded by DataCache');
assert(reward.rewards.some((group) => group.items.some((item) => item.selfId === 1419)),
    'Bloody Queen must have Blood Mark in normal rewards');

const drops = BackgroundDropResolver.rollForFight({
    spot: { npcSelfIds: [12079], avgLevel: 60 },
    killerLevel: 60,
    npcSelfId: 12079,
    rng: () => 0
});
assert.strictEqual(drops.length, 1, 'Bloody Queen reward path must produce the deterministic test drop');
assert.strictEqual(drops[0].selfId, 1419);
assert.strictEqual(drops[0].name, 'Blood Mark');

console.log('Clan simulation Slice 0 checks passed');
