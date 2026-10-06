const assert = require('assert');
require('../src/Global');
const Service = invoke('GameServer/Bot/Economy/HotBoardReviewService');
const Counters = invoke('GameServer/Bot/Economy/MarketCounters');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const World = invoke('GameServer/World/World');
const Dispatcher = invoke('GameServer/Bot/AI/HotAiDispatcher');
const Database = invoke('Database');

const restore = [];
const acquired = [];
const active = new Map();
let callbacks = 0;
function track(target, key, name) {
    const original = target[key];
    restore.push(() => { target[key] = original; });
    target[key] = callback => {
        const token = Symbol(name);
        active.set(token, name);
        const unsubscribe = original(change => { callbacks++; callback(change); });
        const tracked = () => { active.delete(token); unsubscribe(); };
        acquired.push(tracked);
        return tracked;
    };
}
function counts() {
    return { counter: [...active.values()].filter(name => name === 'counter').length,
        board: [...active.values()].filter(name => name === 'board').length };
}

try {
    track(Counters, 'subscribeChanges', 'counter');
    track(Afk, 'subscribeBoardChanges', 'board');
    const providers = { admit: () => null, complete() {} };
    assert.strictEqual(Database.isReady(), false);
    assert.throws(() => Service.start(), TypeError);
    assert.strictEqual(Service.start(providers), true);
    assert.deepStrictEqual(counts(), { counter: 1, board: 1 });
    assert.strictEqual(Service.stop(), true);
    assert.deepStrictEqual(counts(), { counter: 0, board: 0 });
    console.log('Actual ordinary service start/stop and required admission positive controls PASS');
    const original = World.subscribeUserChanges;
    restore.push(() => { World.subscribeUserChanges = original; });
    let fail = true;
    World.subscribeUserChanges = callback => {
        if (fail) { fail = false; throw new Error('private_subscription_fault'); }
        return original(callback);
    };
    assert.throws(() => Service.start(providers), /private_subscription_fault/);
    assert.deepStrictEqual(counts(), { counter: 0, board: 0 },
        'failed actual startup rolls back subscriptions acquired before the third subscription fault');
    assert.strictEqual(Service.running, false);
    assert.strictEqual(Service.stop(), false, 'already rolled back startup disposes idempotently');
    assert.strictEqual(Service.start(providers), true);
    assert.deepStrictEqual(counts(), { counter: 1, board: 1 }, 'retry retains exactly one current subscription');
    Service.stop();
    const before = callbacks;
    Counters.reset();
    assert.deepStrictEqual(counts(), { counter: 0, board: 0 });
    assert.strictEqual(callbacks, before, 'stopped actual producers have no leaked callback');
    assert.strictEqual(Database.isReady(), false);
    console.log('Actual partial startup rollback/retry/stopped producer disposal PASS');
} finally {
    try { Service.stop(); } catch (_) { /* Before-fix startup disposal also fails. */ }
    for (const unsubscribe of acquired) unsubscribe();
    for (const undo of restore.reverse()) undo();
    Dispatcher.resetForTest();
}
