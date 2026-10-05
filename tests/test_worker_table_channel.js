const assert = require('assert');
const path = require('path');
const { Worker } = require('worker_threads');

require('../src/Global');

const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const { ColdTableChannel } = require('../src/GameServer/Bot/Population/ColdTableChannel');
const TableMirror = require('../src/GameServer/Bot/Population/TableMirror');
const { PAGE_BYTES } = require('../src/GameServer/Bot/Population/ColdMessagePages');
const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
const { ClanPlanningCoordinator } = require('../src/GameServer/Clan/ClanPlanningCoordinator');

// The table channel (step 1.7): the main thread registers a table, reports
// changed and removed rows, and flush() sends each table's changes as one
// new version to every attached worker, whose TableMirror applies them in
// order. A gap makes the worker ask for the whole table; a new worker epoch
// gets every table in full. Only a test table is registered here.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function source(rows) {
    return { key: (row) => row.id, allRows: () => rows.values() };
}

// A channel wired straight to an in-process mirror; dropped pages are lost.
function wired() {
    const channel = new ColdTableChannel();
    const rows = new Map();
    channel.register('test', source(rows));
    const mirror = new TableMirror();
    const sent = [];
    const target = { drop: false };
    const deliver = (epoch) => (payload, bytes) => {
        sent.push({ payload, bytes });
        assert.strictEqual(bytes, Protocol.byteLength(payload), 'a page carries its real JSON size');
        assert(bytes <= PAGE_BYTES, 'a page stays within 240 KB');
        if (target.drop) return true;
        const resync = mirror.apply(payload.tables);
        if (resync.length) channel.resync(target, epoch, resync);
        return true;
    };
    const change = (row) => { rows.set(row.id, row); channel.changed('test', row); };
    const remove = (id) => { rows.delete(id); channel.changed('test', { key: id, removed: true }); };
    const same = () => assert.deepStrictEqual([...mirror.rows('test')].sort((a, b) => a[0] - b[0]),
        [...rows].sort((a, b) => a[0] - b[0]));
    return { channel, rows, mirror, sent, target, deliver, change, remove, same };
}

async function unitChecks() {
    // Attach sends the whole table; changes follow in order, one version per flush.
    {
        const w = wired();
        w.change({ id: 1, price: 10 });
        w.channel.attach(w.target, 'e1', w.deliver('e1'));
        assert.strictEqual(w.mirror.version('test'), 1, 'the full copy already has the pending change');
        w.same();
        w.change({ id: 1, price: 11 });
        w.change({ id: 2, price: 20 });
        w.change({ id: 1, price: 12 });
        w.channel.flush();
        assert.strictEqual(w.mirror.version('test'), 2);
        assert.strictEqual(w.mirror.rows('test').get(1).price, 12, 'the last change of a row wins');
        w.same();
        w.channel.flush();
        assert.strictEqual(w.mirror.version('test'), 2, 'a flush without changes sends nothing');

        // A removed row leaves the mirror.
        w.remove(2);
        w.change({ id: 3, price: 30 });
        w.channel.flush();
        assert.strictEqual(w.mirror.version('test'), 3);
        assert(!w.mirror.rows('test').has(2));
        w.same();
    }

    // Pages are limited by size only: a 600 KB table and a 600 KB change both
    // arrive whole, each page within 240 KB, with far more than 64 rows a page.
    {
        const w = wired();
        for (let id = 1; id <= 3000; id++) w.change({ id, note: 'ж🙂'.repeat(30) + id });
        w.channel.attach(w.target, 'e1', w.deliver('e1'));
        assert(w.sent.length >= 3, `full table in ${w.sent.length} pages`);
        assert(w.sent.every((page) => page.payload.tables[0].rows.length > 64));
        w.same();
        w.sent.length = 0;
        for (let id = 1; id <= 3000; id++) w.change({ id, note: 'x'.repeat(200) + id });
        w.channel.flush();
        assert(w.sent.length >= 3, `change in ${w.sent.length} pages`);
        assert.strictEqual(w.mirror.version('test'), 2);
        w.same();
        // A single row larger than a page is left out and counted.
        w.change({ id: 9999, note: 'x'.repeat(PAGE_BYTES) });
        w.channel.flush();
        assert.strictEqual(w.channel.stats.skipped, 1);
        assert.strictEqual(w.mirror.version('test'), 3);
    }

    // A lost version is a gap: the mirror drops later changes, asks for the
    // whole table once, and the full copy makes it current again.
    {
        const w = wired();
        w.change({ id: 1, price: 10 });
        w.channel.attach(w.target, 'e1', w.deliver('e1'));
        w.target.drop = true;
        w.change({ id: 1, price: 11 });
        w.remove(1);
        w.change({ id: 2, price: 20 });
        w.channel.flush();
        w.target.drop = false;
        w.change({ id: 3, price: 30 });
        w.channel.flush();
        assert.strictEqual(w.channel.stats.resyncs, 1);
        assert.strictEqual(w.mirror.version('test'), 3);
        w.same();
        // A mirror waiting for a full copy asks only once.
        const waiting = new TableMirror();
        assert.deepStrictEqual(waiting.apply([{ name: 'test', from: 4, to: 5, rows: [], removed: [] }]), ['test']);
        assert.deepStrictEqual(waiting.apply([{ name: 'test', from: 5, to: 6, rows: [], removed: [] }]), []);
        // A resync from an old epoch is ignored.
        w.channel.resync(w.target, 'e0', ['test']);
        assert.strictEqual(w.channel.stats.resyncs, 1);
    }

    // A new epoch (a restarted worker with an empty mirror) gets every table in full.
    {
        const w = wired();
        w.change({ id: 1, price: 10 });
        w.channel.attach(w.target, 'e1', w.deliver('e1'));
        w.change({ id: 2, price: 20 });
        w.channel.flush();
        w.mirror.tables.clear();
        w.channel.attach(w.target, 'e1', w.deliver('e1'));
        assert.strictEqual(w.mirror.version('test'), null, 'the same epoch is not sent again');
        w.channel.attach(w.target, 'e2', w.deliver('e2'));
        assert.strictEqual(w.mirror.version('test'), 2);
        w.same();
        // A detached worker gets nothing; a failed post suspends the worker
        // until it asks for a resync, then the table goes in full.
        w.channel.detach(w.target);
        const pages = w.sent.length;
        w.change({ id: 3, price: 30 });
        w.channel.flush();
        assert.strictEqual(w.sent.length, pages);
        let fail = true;
        w.channel.attach(w.target, 'e3', (payload, bytes) => (fail ? false : w.deliver('e3')(payload, bytes)));
        fail = false;
        w.change({ id: 4, price: 40 });
        w.channel.flush();
        assert.strictEqual(w.channel.stats.failedPosts, 1);
        assert.strictEqual(w.sent.length, pages, 'a suspended worker gets nothing');
        w.channel.resync(w.target, 'e3', []);
        assert(w.sent.at(-1).payload.tables[0].full, 'after a failed post the table goes in full');
        w.same();
    }

    // A failed post while the worker is gone (a restart between its new epoch
    // and its attach) costs one page, not a rebuild of every table per flush;
    // only the tables it missed go in full when it is back.
    {
        const channel = new ColdTableChannel();
        const tables = { a: new Map(), b: new Map(), c: new Map() };
        for (const name of Object.keys(tables)) channel.register(name, source(tables[name]));
        const set = (name, row) => { tables[name].set(row.id, row); channel.changed(name, row); };
        for (let id = 1; id <= 50; id++) { set('a', { id }); set('b', { id }); set('c', { id }); }
        const mirror = new TableMirror();
        const target = {};
        let gone = false;
        let posts = 0;
        const post = (payload) => {
            posts += 1;
            if (gone) return false;
            mirror.apply(payload.tables);
            return true;
        };
        channel.attach(target, 'e1', post);
        assert.deepStrictEqual(Object.keys(mirror.summary()).sort(), ['a', 'b', 'c']);
        gone = true;
        set('a', { id: 1, price: 2 });
        channel.flush();
        const failed = posts;
        for (let flush = 0; flush < 5; flush++) {
            set('b', { id: 2, price: flush });
            channel.flush();
        }
        assert.strictEqual(posts, failed, 'a suspended worker is not posted to on every flush');
        assert.strictEqual(channel.stats.failedPosts, 1);
        assert.strictEqual(channel.stats.fulls, 3, 'no full table is rebuilt while the worker is gone');
        gone = false;
        const sent = [];
        channel.attach(target, 'e1', (payload) => { sent.push(...payload.tables.map((piece) => `${piece.name}:${piece.full}`)); return post(payload); });
        assert.deepStrictEqual(sent, [], 'the same epoch attaching again does not lift the suspension');
        channel.resync(target, 'e1', []);
        assert.deepStrictEqual(sent.sort(), ['a:true', 'b:true'], 'only the tables the worker missed go in full');
        assert.strictEqual(mirror.rows('b').get(2).price, 4);
        assert.strictEqual(mirror.rows('c').size, 50);
    }

    // A full table cut across pages is loading until its final piece: the
    // mirror never reads the first pages as the whole table.
    {
        const w = wired();
        for (let id = 1; id <= 3000; id++) w.change({ id, note: 'x'.repeat(200) + id });
        const held = [];
        w.channel.attach(w.target, 'e1', (payload) => { held.push(payload); return true; });
        assert(held.length >= 3, `the full copy takes ${held.length} pages`);
        assert(held.every((page, at) => page.tables.every((piece) => piece.last === (at === held.length - 1 ? 1 : 0))),
            'every piece of a full copy says whether it is the last');
        for (const page of held.slice(0, -1)) w.mirror.apply(page.tables);
        assert.strictEqual(w.mirror.ready('test'), false);
        assert.strictEqual(w.mirror.rows('test').size, 0, 'a loading table reads as empty');
        assert.deepStrictEqual(w.mirror.apply([{ name: 'test', from: 1, to: 2, rows: [], removed: [] }]), ['test'],
            'a change on a full copy that never finished asks for the whole table');
        const fresh = new TableMirror();
        const seen = [];
        fresh.watch('test', { reset: () => seen.push('reset'), put: (key) => seen.push(key), remove: () => {} });
        for (const page of held) fresh.apply(page.tables);
        assert.strictEqual(fresh.ready('test'), true);
        assert.strictEqual(fresh.rows('test').size, 3000);
        assert.strictEqual(seen[0], 'reset');
        assert.strictEqual(seen.length, 3001, 'a listener follows every row');
    }

    // The cold coordinator: pages go out as valid table_page envelopes; a
    // resync from the worker is answered; a worker exit detaches it.
    {
        const channel = new ColdTableChannel();
        const rows = new Map([[1, { id: 1, price: 10 }]]);
        channel.register('test', source(rows));
        const coordinator = new ColdSimulationCoordinator({ tableChannel: channel });
        const messages = [];
        coordinator.worker = { postMessage: (message) => messages.push(message) };
        coordinator.workerEpoch = 'table-test';
        coordinator.attachTableChannel();
        assert.strictEqual(messages.length, 1);
        const page = messages[0];
        assert.strictEqual(page.type, 'table_page');
        const { bytes, ...sent } = page;
        assert(bytes >= Protocol.byteLength(sent), 'the counted size bounds the real envelope');
        assert(Protocol.validateEnvelope(page, 'main', { workerEpoch: 'table-test', bytes }).ok);
        await coordinator.onMessage(Protocol.envelope('table_resync', 'table-test', { names: ['test'] }));
        assert.strictEqual(messages.length, 2);
        assert(messages[1].payload.tables[0].full);
        coordinator.stopping = true;
        coordinator.onWorkerExit(0);
        assert.strictEqual(channel.targets.size, 0);
    }
}

async function coldWorkerRoundTrip() {
    const epoch = 'table-channel-test';
    const worker = new Worker(path.resolve(__dirname, '../src/GameServer/Bot/Population/ColdSimulationWorker.js'),
        { workerData: { workerEpoch: epoch } });
    const channel = new ColdTableChannel();
    const rows = new Map();
    channel.register('test', source(rows));
    const coordinator = new ColdSimulationCoordinator({ tableChannel: channel });
    coordinator.worker = worker;
    coordinator.workerEpoch = epoch;
    const received = [];
    let workerError;
    worker.on('error', (error) => { workerError = error; });
    worker.on('message', (message) => {
        received.push(message);
        if (message.type === 'table_resync') coordinator.onMessage(message);
    });
    const send = (type, payload) => worker.postMessage(Protocol.envelope(type, epoch, payload));
    const until = async (predicate, label) => {
        const deadline = Date.now() + 20000;
        for (;;) {
            if (workerError) throw workerError;
            const found = received.filter(predicate).at(-1);
            if (found) return found;
            if (Date.now() >= deadline) throw Error(`${label} timeout: ${JSON.stringify(received.map((m) => m.type))}`);
            await sleep(25);
        }
    };
    const mirrored = (version, count, label) => until((m) => m.type === 'heartbeat'
        && m.payload.tables?.test?.version === version && m.payload.tables.test.rows === count, label);
    try {
        await until((m) => m.type === 'ready' && m.payload.phase === 'loaded', 'load');
        send('catalog_page', { catalog: 'spots', rows: [], done: true });
        send('catalog_page', { catalog: 'npc_offers', rows: [], done: true });
        send('init', { config: { heartbeatMs: 250 } });
        await until((m) => m.type === 'ready' && m.payload.phase === 'running', 'init');

        // A table over 240 KB reaches the real worker in several valid pages.
        for (let id = 1; id <= 3000; id++) rows.set(id, { id, note: 'ж🙂'.repeat(30) + id });
        const before = coordinator.counters.messagesOut;
        coordinator.attachTableChannel();
        assert(coordinator.counters.messagesOut - before >= 3);
        await mirrored(0, 3000, 'full table');

        // A change and a removal.
        rows.set(5, { id: 5, note: 'changed' });
        channel.changed('test', rows.get(5));
        rows.delete(6);
        channel.changed('test', { key: 6, removed: true });
        channel.flush();
        await mirrored(1, 2999, 'change');

        // A lost page: the worker asks for the table and gets it whole.
        const entry = channel.targets.get(coordinator);
        const post = entry.post;
        entry.post = () => true;
        rows.delete(7);
        channel.changed('test', { key: 7, removed: true });
        channel.flush();
        entry.post = post;
        rows.delete(8);
        channel.changed('test', { key: 8, removed: true });
        channel.flush();
        await until((m) => m.type === 'table_resync', 'resync request');
        await mirrored(3, 2997, 'resync');
        assert.strictEqual(channel.stats.resyncs, 1);
        assert(!received.some((m) => m.type === 'fault'), JSON.stringify(received.filter((m) => m.type === 'fault')));
    } finally {
        await worker.terminate();
    }
}

async function clanWorkerRestart() {
    const channel = new ColdTableChannel();
    const rows = new Map([[1, { id: 1, price: 10 }], [2, { id: 2, price: 20 }]]);
    channel.register('test', source(rows));
    const coordinator = new ClanPlanningCoordinator({ tableChannel: channel, restartDelayMs: 0 });
    const summary = () => coordinator.send('table_summary', {});
    try {
        await coordinator.ready({});
        assert.deepStrictEqual((await summary()).test, { version: 0, rows: 2, waiting: false, loading: false });

        // Changes go out before each plan, ahead of the plan message.
        rows.set(3, { id: 3, price: 30 });
        channel.changed('test', rows.get(3));
        await assert.rejects(coordinator.plan({ member: null, context: {} }, {}));
        assert.deepStrictEqual((await summary()).test, { version: 1, rows: 3, waiting: false, loading: false });

        // A restarted worker starts empty and gets the table in full.
        const old = coordinator.worker;
        const exited = new Promise((resolve) => old.once('exit', resolve));
        await old.terminate();
        await exited;
        assert.strictEqual(channel.targets.size, 0, 'a failed worker is detached');
        rows.delete(1);
        channel.changed('test', { key: 1, removed: true });
        channel.flush();
        await coordinator.ready({});
        assert.notStrictEqual(coordinator.worker, old);
        assert.deepStrictEqual((await summary()).test, { version: 2, rows: 2, waiting: false, loading: false });
    } finally {
        await coordinator.shutdown();
    }
}

(async () => {
    await unitChecks();
    await coldWorkerRoundTrip();
    await clanWorkerRestart();
    console.log('worker table channel ok');
    process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
