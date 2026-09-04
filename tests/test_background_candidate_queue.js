const assert = require('assert');
const Queue = require('../src/GameServer/Bot/Population/BackgroundCandidateQueue');

(async () => {
    const originalNow = Date.now;
    let clock = 1000;
    Date.now = () => clock;
    try {
        const queue = new Queue();
        let selections = 0;
        const latest = new Map([[1, { id: 1, revision: 2 }], [2, null], [3, { id: 3, revision: 4 }]]);
        const seen = [];
        const progress = [];
        const options = {
            limit: 3, deadlineAt: 1050,
            select: async () => { selections++; clock += 60; return [{ id: 1 }, { id: 2 }, { id: 3 }]; },
            refresh: async (old) => latest.get(old.id),
            work: async (current) => { seen.push(current); clock += 30; return current; },
            onProgress: (value) => progress.push(value)
        };
        const first = await queue.run(options);
        assert.strictEqual(first.processed, 0);
        assert.strictEqual(first.remaining, 3, 'slow selection must survive its expired governor window');
        const second = await queue.run({ ...options, deadlineAt: 1080 });
        assert.strictEqual(selections, 1, 'resuming must not repeat SQL selection');
        assert.strictEqual(second.processed, 1, 'one completed candidate must make useful progress');
        assert.deepStrictEqual(seen[0], { id: 1, revision: 2 }, 'work must use refreshed state');
        const third = await queue.run({ ...options, deadlineAt: 1200 });
        assert.strictEqual(third.skipped, 1, 'hot/owned/deleted candidates are skipped after refresh');
        assert.strictEqual(third.remaining, 0);
        assert.strictEqual(third.continuation, true, 'a full selection must request another pass even after resuming');
        assert.strictEqual(selections, 1);
        assert.deepStrictEqual(seen.map(x => x.id), [1, 3]);
        assert.strictEqual(progress[0].selected, 3);
        assert.strictEqual(progress[0].deadlineStops, 1);
        assert.strictEqual(progress[1].resumed, 1);
        assert.strictEqual(progress[2].pending, 0);
        const exhausted = await queue.run({ ...options, select: async () => [], deadlineAt: 1200 });
        assert.strictEqual(exhausted.continuation, false);
        console.log('Background candidate continuation, progress and stale-state checks passed');
    } finally { Date.now = originalNow; }
})().catch(error => { console.error(error); process.exitCode = 1; });
