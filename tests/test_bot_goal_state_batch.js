const assert = require('assert');

require('../src/Global');

const Database = invoke('Database');
const GoalState = invoke('GameServer/Bot/Goals/GoalState');
const GoalService = invoke('GameServer/Bot/Goals/GoalService');

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
        const results = await GoalService.reviewBatch(states, { now: 100000 });
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
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
