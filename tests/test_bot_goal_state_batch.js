const assert = require('assert');

require('./helpers/databaseIsolation');
const isolated = require('./helpers/isolatedSocialDatabase')('rule-native-goal-batch');
require('../src/Global');
isolated.assertConfigured(options.default);

const Database = invoke('Database');
const GoalState = invoke('GameServer/Bot/Goals/GoalState');
const GoalService = invoke('GameServer/Bot/Goals/GoalService');
const Data = invoke('GameServer/DataCache');
Data.init();
invoke('GameServer/Bot/Economy/MarketCounters').useSpots(() => invoke('GameServer/Bot/Population/SpotProfiles').ensure());
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const decisions = invoke('GameServer/Bot/Population/ColdSimulationCoordinator').economyDecisions;
const nativeDecision = require('./helpers/workerEconomyDecision');

async function main() {
    const originalExecute = Database.execute;
    const originalBatch = Database.upsertBotGoalStates;
    const batches = [];
    try {
        Database.execute = async () => [];
        Database.upsertBotGoalStates = async (entries) => {
            batches.push(entries);
            return entries.length;
        };
        GoalState.reset();
        for (const characterId of [101, 102]) {
            GoalState.prime(characterId, JSON.stringify({
                type: 'progress_level', status: 'active', priority: 50,
                target: {}, plan: {}, blockers: [], createdAt: 1,
                reviewedAt: 1, nextReviewAt: 1
            }), 1);
        }
        const states = [101, 102].map((characterId) => ({
            characterId,
            name: `BatchGoal${characterId}`,
            phase: 'cold',
            activity: 'hunting',
            level: 20,
            adena: 10000,
            spotId: 'batch_spot',
            vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
            party: {},
            stats: {}
        }));
        // C1: a missing cold decision cannot manufacture a voluntary goal.
        const deferred = await GoalService.reviewBatch(states, { now: 100000 });
        assert.strictEqual(deferred.length, 2);
        assert.strictEqual(batches.length, 0);
        for (const state of states) {
            assert.strictEqual(GoalState.snapshot(state.characterId).current.reviewedAt, 1);
            const before = structuredClone(state);
            const native = await nativeDecision(state, { timestamp: 100000 });
            const { compact } = require('../src/GameServer/Bot/Population/ColdEconomyDecision');
            const leaf = compact(native.decision).activity;
            assert(leaf, 'the real producer must supply a voluntary leaf before this write-batch test');
            assert.deepStrictEqual(state, before, 'planning cannot spend or equip physical state');
            state.stats = { ...state.stats, ...native.statsPacket };
            decisions.accept(state.characterId, native.decision);
            assert(decisions.decided(state), 'the actual worker publication matches the input state');
        }
        const originalForState = Economy.forState;
        Economy.forState = () => { throw Error('main cold goal batch must not rebuild a wish network'); };
        let results;
        try { results = await GoalService.reviewBatch(states, { now: 100000 }); }
        finally { Economy.forState = originalForState; }
        assert.strictEqual(results.length, 2);
        assert.strictEqual(batches.length, 1, 'a stale-goal slice must use one queued SQLite transaction');
        assert.strictEqual(batches[0].length, 2);
        assert.strictEqual(GoalState.snapshot(101).current.reviewedAt, 100000);
        assert.strictEqual(GoalState.snapshot(102).current.reviewedAt, 100000);
        console.log('Bot goal state batch checks passed');
    } finally {
        Database.execute = originalExecute;
        Database.upsertBotGoalStates = originalBatch;
        GoalState.reset();
        for (const id of [101, 102]) decisions.forget(id);
        require('node:fs').rmSync(isolated.directory, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
