process.env.BOT_DEVELOPER_DIAGNOSTICS = 'true'; // Fixture inspects optional developer counters (channel.stats).
const assert = require('assert');
const { ColdTableChannel, shared } = require('../src/GameServer/Bot/Population/ColdTableChannel');
const TableMirror = require('../src/GameServer/Bot/Population/TableMirror');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const { PAGE_BYTES } = require('../src/GameServer/Bot/Population/ColdMessagePages');

const turn = () => new Promise((resolve) => queueMicrotask(resolve));

function table(channel, name, eventDriven) {
    const rows = new Map();
    let reads = 0;
    channel.register(name, { key: (row) => row.id, allRows: () => { reads++; return rows.values(); },
        ...(eventDriven === undefined ? {} : { eventDriven }) });
    return {
        rows,
        reads: () => reads,
        set(row) { rows.set(row.id, row); channel.changed(name, row); },
        remove(id) { rows.delete(id); channel.changed(name, { key: id, removed: true }); }
    };
}

function target(channel, key = {}, epoch = 'e1') {
    const mirror = new TableMirror();
    const pages = [];
    const post = (payload, bytes) => {
        assert.strictEqual(bytes, Protocol.byteLength(payload));
        assert(bytes <= PAGE_BYTES);
        const message = Protocol.envelope('table_page', epoch, payload);
        assert(Protocol.validateEnvelope(message, 'main', { workerEpoch: epoch }).ok,
            'automatic delivery still uses valid native table pages');
        pages.push(payload);
        const gaps = mirror.apply(payload.tables);
        if (gaps.length) channel.resync(key, epoch, gaps);
        return true;
    };
    channel.attach(key, epoch, post);
    return { mirror, pages, key, post };
}

async function automaticBurst() {
    const channel = new ColdTableChannel();
    const board = table(channel, 'board', true);
    const market = table(channel, 'market', true);
    const passive = table(channel, 'passive');
    const first = target(channel);
    const second = target(channel);
    first.pages.length = second.pages.length = 0;
    const reads = [board.reads(), market.reads(), passive.reads()];

    board.set({ id: 1, price: 10 });
    board.set({ id: 2, price: 20 });
    board.set({ id: 1, price: 11 });
    board.remove(2);
    market.set({ id: 'material none', deals: 1 });
    market.set({ id: 'material none', deals: 2 });
    assert.strictEqual(first.pages.length, 0, 'producer changes coalesce before sending');
    await turn();
    assert.strictEqual(first.mirror.rows('board').get(1)?.price, 11,
        'event-driven board changes arrive without a snapshot timer or explicit flush');
    assert(!first.mirror.rows('board').has(2));
    assert.strictEqual(first.mirror.rows('market').get('material none').deals, 2);
    assert.strictEqual(channel.stats.flushes, 1, 'one versioned flush for a board/market burst');
    assert.strictEqual(first.pages.length, 1);
    assert.strictEqual(second.pages.length, 1);
    assert.strictEqual(first.mirror.version('board'), 1);
    assert.strictEqual(second.mirror.version('market'), 1);
    assert.deepStrictEqual([board.reads(), market.reads(), passive.reads()], reads,
        'event deltas do not rebuild source tables');

    passive.set({ id: 3, note: 'pending' });
    await turn();
    assert(!first.mirror.rows('passive').has(3), 'passive alone waits for the existing flush path');
    assert.strictEqual(channel.snapshot().tables.passive.pending, 1);
    channel.flush();
    assert.strictEqual(first.mirror.rows('passive').get(3).note, 'pending');

    passive.set({ id: 3, note: 'piggyback' });
    market.set({ id: 'material none', deals: 3 });
    board.set({ id: 4, price: 40 });
    const before = first.pages.length;
    await turn();
    assert.strictEqual(first.pages.length, before + 1, 'passive pending and event tables share one flush');
    assert.strictEqual(first.mirror.rows('passive').get(3).note, 'piggyback');
    assert.strictEqual(channel.snapshot().tables.passive.pending, 0);
    assert.strictEqual(first.mirror.version('market'), 2);

    market.set({ id: 'material none', deals: 4 });
    channel.flush();
    const sent = first.pages.length;
    await turn();
    assert.strictEqual(first.pages.length, sent, 'a queued callback after manual flush sends no duplicate');
    assert.strictEqual(first.mirror.version('market'), 3);
}

async function startupAndRestart() {
    const channel = new ColdTableChannel();
    const board = table(channel, 'board', true);
    for (let id = 0; id < 1000; id++) { board.set({ id, price: id }); board.remove(id); }
    board.set({ id: 1, price: 5 });
    await turn();
    assert.strictEqual(channel.snapshot().tables.board.pending, 0, 'no pending row retention without targets');
    assert.strictEqual(channel.snapshot().tables.board.version, 0, 'unseen events do not schedule work');
    assert.strictEqual(board.reads(), 0);
    const first = target(channel);
    assert.strictEqual(first.mirror.version('board'), 1);
    assert.deepStrictEqual([...first.mirror.rows('board')], [[1, { id: 1, price: 5 }]]);
    board.set({ id: 1, price: 6 });
    channel.detach(first.key);
    const before = first.pages.length;
    await turn();
    assert.strictEqual(first.pages.length, before, 'detach fences the already queued flush');
    board.set({ id: 2, price: 7 });
    const restarted = target(channel, first.key, 'e2');
    assert.deepStrictEqual([...restarted.mirror.rows('board')], [...board.rows]);
    const fulls = restarted.pages.length;
    await turn();
    assert.strictEqual(restarted.pages.length, fulls, 'restart full copy is not followed by an old duplicate');
}

async function failureAndGap() {
    const channel = new ColdTableChannel();
    const market = table(channel, 'market', true);
    const worker = target(channel);
    const entry = channel.targets.get(worker.key);
    let posts = 0;
    entry.post = () => { posts++; return false; };
    market.set({ id: 1, deals: 1 });
    await turn();
    await turn();
    assert.strictEqual(posts, 1, 'failed automatic send does not recursively retry');
    assert.strictEqual(channel.stats.retries, 0);
    market.set({ id: 1, deals: 2 });
    await turn();
    assert.strictEqual(posts, 2, 'the next real event flush gives the existing one full retry');
    assert.strictEqual(channel.stats.retries, 1);
    for (let id = 3; id < 8; id++) { market.set({ id: 1, deals: id }); await turn(); }
    assert.strictEqual(posts, 2, 'a suspended/retried target stays silent across later bursts');
    entry.post = worker.post;
    channel.resync(worker.key, 'e1', []);
    assert.strictEqual(worker.mirror.rows('market').get(1).deals, 7);
    assert(worker.pages.at(-1).tables[0].full, 'resync recovers missed updates as a full copy');

    entry.post = () => true;
    market.set({ id: 1, deals: 8 });
    await turn();
    entry.post = worker.post;
    market.set({ id: 1, deals: 9 });
    await turn();
    assert.strictEqual(worker.mirror.rows('market').get(1).deals, 9);
    assert.strictEqual(channel.stats.resyncs, 2, 'automatic version gaps use the native resync path');
}

async function automaticPages() {
    const channel = new ColdTableChannel();
    const board = table(channel, 'board', true);
    const worker = target(channel);
    worker.pages.length = 0;
    for (let id = 0; id < 3000; id++) board.set({ id, note: 'ж🙂'.repeat(30) + id });
    await turn();
    assert(worker.pages.length >= 3, 'automatic deltas retain native byte paging');
    assert.strictEqual(worker.mirror.rows('board').size, 3000);
    assert.strictEqual(worker.mirror.version('board'), 1, 'pages keep one version for the whole burst');
    board.set({ id: 9000, note: 'x'.repeat(PAGE_BYTES) });
    await turn();
    assert.strictEqual(channel.stats.skipped, 1);
    assert(!worker.mirror.rows('board').has(9000));
}

// Native producer registration and publication, with in-memory catalog and
// unused lifecycle dependencies only. No database or server module is loaded.
async function nativeProducers() {
    const oldInvoke = global.invoke;
    const deps = new Map([
        ['GameServer/DataCache', { items: [{ selfId: 1864, template: { name: 'Stem', kind: 'Other.Material' },
            etc: { stackable: true } }] }],
        ['GameServer/Items/C4RecipeItems', { loadRecipeItems: () => ({}) }],
        ['GameServer/Bot/Economy/FirstPrice', { cachedFirstPrice: () => 10 }],
        ['GameServer/Actor/Actor', {}], ['Database', {}], ['GameServer/Network/Response', {}],
        ['GameServer/World/World', {}], ['GameServer/World/WorldConstants', { CLIENT_VISIBILITY_RADIUS: 2000 }],
        ['GameServer/Bot/Economy/ShopPlaces', {}],
        // Public workshop rows share the 'board' table (CraftWorkshopService
        // publishes them as 'w:<owner>:<recipe>' rows): a full board copy reads
        // them lazily, so the producer dependency is part of the contract.
        ['GameServer/Bot/Economy/CraftWorkshopService', { publicRows: () => [['w:77:5', 5]] }]
    ]);
    // A board change also keeps the main-thread item->recipe index current
    // (ColdOccupationSources.recipeIndex, shared with the workers). That index
    // loads the whole merchant catalogue, so it is replaced by a recorder here.
    const sourcesPath = require.resolve('../src/GameServer/Bot/Population/ColdOccupationSources');
    const oldSources = require.cache[sourcesPath];
    const indexUpdates = [];
    require.cache[sourcesPath] = { id: sourcesPath, filename: sourcesPath, loaded: true,
        exports: { recipeIndex: () => ({ reset() {}, update(id) { indexUpdates.push(id); } }) } };
    global.invoke = (name) => {
        assert(deps.has(name), `unexpected native producer dependency ${name}`);
        return deps.get(name);
    };
    let worker;
    try {
        const counters = require('../src/GameServer/Bot/Economy/MarketCounters');
        deps.set('GameServer/Bot/Economy/MarketCounters', counters);
        const service = require('../src/GameServer/AfkTrade/AfkTradeService');
        worker = target(shared);
        assert.deepStrictEqual(worker.mirror.rows('board').get('w:77:5'), ['w:77:5', 5],
            'the full board copy carries the public workshop rows');
        const record = { id: 1, kind: 'sell_ad', ownerId: 12, ownerAccount: 'bot_12', town: 'Giran',
            status: 'active', storeType: service.SELL, revision: 1,
            lines: [{ id: 2, selfId: 1864, count: 5, price: 10, enchant: 0 }] };
        service.refreshRecord(record);
        counters.deal(1864, 10, 2, Date.now(), 12, 'Giran', 13);
        await turn();
        assert.strictEqual(worker.mirror.rows('board').get(1)?.[6][0][3], 5,
            'the real board producer opts into automatic publication');
        assert(indexUpdates.includes(1864), 'a board change updates the recipe index for its item');
        assert.strictEqual(worker.mirror.rows('market').get('c:material none')?.[1], 1,
            'the real counter producer opts into automatic publication');
        assert.strictEqual(worker.mirror.rows('market').get('i:1864')[1], 1);
        service.refreshRecord({ ...record, status: 'closed' });
        await turn();
        assert(!worker.mirror.rows('board').has(1), 'native record removal is delivered as an event');
    } finally {
        if (worker) shared.detach(worker.key);
        if (oldSources) require.cache[sourcesPath] = oldSources;
        else delete require.cache[sourcesPath];
        if (oldInvoke === undefined) delete global.invoke;
        else global.invoke = oldInvoke;
    }
}

(async () => {
    await automaticBurst();
    await startupAndRestart();
    await failureAndGap();
    await automaticPages();
    await nativeProducers();
    console.log('N53 table events: automatic/coalesced native delivery, passive defaults, epochs, paging and retry passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
