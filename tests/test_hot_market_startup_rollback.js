const assert = require('assert');
require('../src/Global');
const Service = invoke('GameServer/Bot/Economy/HotBoardReviewService');
const Counters = invoke('GameServer/Bot/Economy/MarketCounters');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const World = invoke('GameServer/World/World');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
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
    return Object.fromEntries(['counter', 'board', 'world', 'market', 'life']
        .map(name => [name, [...active.values()].filter(value => value === name).length]));
}
const stopped = { counter: 0, board: 0, world: 0, market: 0, life: 0 };
const running = { counter: 0, board: 1, world: 1, market: 1, life: 1 };

try {
    track(Counters, 'subscribeChanges', 'counter');
    track(Afk, 'subscribeBoardChanges', 'board');
    track(World, 'subscribeUserChanges', 'world');
    track(Life, 'subscribeMarketReviewChanges', 'market');
    track(Life, 'subscribeChanges', 'life');
    const providers = { admit: () => null, complete() {} };
    assert.strictEqual(Database.isReady(), false);
    assert.throws(() => Service.start(), TypeError);
    assert.strictEqual(Service.start(providers), true);
    assert.deepStrictEqual(counts(), running, 'own-line review owns four current subscriptions and no retired counter listener');
    assert.strictEqual(Service.stop(), true);
    assert.deepStrictEqual(counts(), stopped);
    console.log('Actual ordinary service start/stop and required admission positive controls PASS');
    const original = World.subscribeUserChanges;
    restore.push(() => { World.subscribeUserChanges = original; });
    let fail = true;
    World.subscribeUserChanges = callback => {
        if (fail) { fail = false; throw new Error('private_subscription_fault'); }
        return original(callback);
    };
    assert.throws(() => Service.start(providers), /private_subscription_fault/);
    assert.deepStrictEqual(counts(), stopped,
        'failed actual startup rolls back the board subscription acquired before the world subscription fault');
    assert.strictEqual(Service.running, false);
    assert.strictEqual(Service.stop(), false, 'already rolled back startup disposes idempotently');
    assert.strictEqual(Service.start(providers), true);
    assert.deepStrictEqual(counts(), running, 'retry retains exactly one listener for each current producer');
    Service.stop();
    const before = callbacks;
    Counters.reset();
    assert.deepStrictEqual(counts(), stopped);
    assert.strictEqual(callbacks, before, 'stopped actual producers have no leaked callback');
    assert.strictEqual(Database.isReady(), false);
    console.log('Actual partial startup rollback/retry/stopped producer disposal PASS');
} finally {
    try { Service.stop(); } catch (_) { /* Before-fix startup disposal also fails. */ }
    for (const unsubscribe of acquired) unsubscribe();
    for (const undo of restore.reverse()) undo();
    Dispatcher.resetForTest();
}
