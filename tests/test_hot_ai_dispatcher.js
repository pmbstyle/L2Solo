'use strict';

const assert = require('assert');

require('../src/Global');

const Dispatcher = invoke('GameServer/Bot/AI/HotAiDispatcher');
const BotAI = invoke('GameServer/Bot/BotAI');

function wait(ms = 10) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
    Dispatcher.resetForTest();
    const order = [];
    const first = {};
    const second = {};
    Dispatcher.enqueue(first, () => {
        order.push('actor-1');
        setTimeout(() => order.push('player-timer'), 0);
    });
    Dispatcher.enqueue(second, () => order.push('actor-2'));
    await wait(20);
    assert.deepStrictEqual(order, ['actor-1', 'player-timer', 'actor-2'], 'dispatcher must yield to timers between actors');

    Dispatcher.resetForTest();
    let duplicateRuns = 0;
    const duplicate = {};
    assert.strictEqual(Dispatcher.enqueue(duplicate, () => { duplicateRuns += 1; }), true);
    assert.strictEqual(Dispatcher.enqueue(duplicate, () => { duplicateRuns += 100; }, { urgent: true }), false);
    await wait(10);
    assert.strictEqual(duplicateRuns, 1, 'duplicate wakeups for one actor must coalesce');
    assert.strictEqual(Dispatcher.snapshot().coalesced, 1);

    Dispatcher.resetForTest();
    const canceled = {};
    Dispatcher.enqueue(canceled, () => assert.fail('canceled actor must not run'));
    assert.strictEqual(Dispatcher.cancel(canceled), true);
    await wait(10);
    assert.strictEqual(Dispatcher.snapshot().completed, 0);

    Dispatcher.resetForTest();
    const originalTick = BotAI.tick;
    const originalDelay = BotAI.calculateNextTickDelay;
    let ticks = 0;
    const session = { actor: {}, aiActive: true };
    const normalSession = { actor: {}, aiActive: true };
    try {
        BotAI.tick = () => { ticks += 1; };
        BotAI.calculateNextTickDelay = () => 60000;
        BotAI.wakeup(session, { urgent: true });
        assert.strictEqual(ticks, 0, 'urgent wakeup must never execute AI inside the caller/network stack');
        await wait(20);
        assert.strictEqual(ticks, 1, 'urgent wakeup must execute on the cooperative dispatcher');
        assert.strictEqual(Dispatcher.snapshot().urgent, 1);
        BotAI.stop(session);

        Dispatcher.resetForTest();
        ticks = 0;
        BotAI.wakeup(normalSession);
        await wait(20);
        assert.strictEqual(ticks, 1, 'normal wakeup must execute on the cooperative dispatcher');
        assert.strictEqual(Dispatcher.snapshot().urgent, 0, 'normal wakeup must preserve the fairness lane');
    } finally {
        BotAI.stop(session);
        BotAI.stop(normalSession);
        BotAI.tick = originalTick;
        BotAI.calculateNextTickDelay = originalDelay;
        Dispatcher.resetForTest();
    }

    console.log('Hot AI cooperative dispatcher checks passed');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
