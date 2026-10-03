const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
DataCache.init();
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const { ColdSimulationCoordinator, npcPlanningCatalogRows } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const Memory = invoke('GameServer/Social/InteractionMemoryRuntime');
const Policy = require('../src/GameServer/Social/InteractionMemoryPolicy');
const ClanSocial = invoke('GameServer/Clan/ClanSocialRuntime');
Memory.repository = { loadMany: async ids => ids.map(Policy.empty) };
ClanSocial.refresh = async () => {};

function coordinatorWithWorker() {
    const coordinator = new ColdSimulationCoordinator();
    const messages = [];
    coordinator.worker = { postMessage: message => messages.push(message) };
    coordinator.workerEpoch = 'startup-test';
    coordinator.ready = true;
    coordinator.started = true;
    return { coordinator, messages };
}

(async () => {
    // The planning catalog reaches the worker whole and in order, each page within
    // the message limit, sized by counting each row once.
    {
        const { coordinator, messages } = coordinatorWithWorker();
        const spots = Array.from({ length: 3000 }, (_, index) => ({
            id: `${index}_spot`, name: 'Поляна🌲'.repeat(index % 40), minLevel: index % 80, npcEntries: [{ selfId: 20000 + index, count: index % 7 }]
        }));
        const ensure = SpotProfiles.ensure;
        SpotProfiles.ensure = () => spots;
        const byteLength = Protocol.byteLength;
        let serialisedRows = 0;
        Protocol.byteLength = (value) => { if (Array.isArray(value) && value.length === 1) serialisedRows += 1; return byteLength(value); };
        try {
            coordinator.sendPlanningCatalog();
        } finally {
            SpotProfiles.ensure = ensure;
            Protocol.byteLength = byteLength;
        }
        const npcRows = npcPlanningCatalogRows();
        for (const [catalog, rows] of [['spots', spots], ['npc_offers', npcRows]]) {
            const pages = messages.filter(message => message.type === 'catalog_page' && message.payload.catalog === catalog);
            assert.deepStrictEqual(pages.flatMap(page => page.payload.rows), JSON.parse(JSON.stringify(rows)), `${catalog} rows arrive whole and in order`);
            assert.deepStrictEqual(pages.map(page => page.payload.done), pages.map((_, index) => index === pages.length - 1), `${catalog}: done only on the last page`);
            for (const page of pages) {
                const actual = byteLength(page);
                assert(actual <= Protocol.MAX_MESSAGE_BYTES, 'every page fits the message limit');
                assert(page.bytes >= actual, 'the stamped size is an upper bound of the real message');
                assert(page.payload.rows.length <= Protocol.MAX_BATCH);
            }
        }
        assert(messages.filter(message => message.payload.catalog === 'spots').length > 3, 'the fixture exercises byte-limited pages');
        assert(serialisedRows <= spots.length + npcRows.length, `each row is measured once (${serialisedRows})`);

        // An empty catalog still tells the worker it is complete.
        messages.length = 0;
        SpotProfiles.ensure = () => [];
        try { coordinator.sendPlanningCatalog(); } finally { SpotProfiles.ensure = ensure; }
        const empty = messages.filter(message => message.payload.catalog === 'spots');
        assert.deepStrictEqual(empty.map(message => [message.payload.rows.length, message.payload.done]), [[0, true]]);
    }

    // The initial snapshot hands the loop back while it builds a page, so slow
    // rows do not hold the main thread for the whole page.
    {
        const { coordinator, messages } = coordinatorWithWorker();
        coordinator.reconcileOrphanedBackgroundParties = async () => {};
        coordinator.contextIndex = () => ({ spots: new Map(), parties: new Map() });
        coordinator.snapshotEntry = (state) => {
            const until = Date.now() + 4;
            while (Date.now() < until) { /* a cold-cache route decision */ }
            return { state, context: {} };
        };
        const states = Array.from({ length: 60 }, (_, index) => ({ characterId: index + 1, phase: 'cold' }));
        LifeState.allStates = () => states;
        let ticks = 0, longest = 0, last = Date.now(), running = true;
        const tick = () => { const now = Date.now(); longest = Math.max(longest, now - last); last = now; ticks += 1;
            if (running) setImmediate(tick); };
        setImmediate(tick);
        const result = await coordinator.sendFullSnapshot();
        running = false;
        assert.strictEqual(result.ok, true);
        assert.deepStrictEqual(messages.flatMap(message => message.payload.rows.map(row => row.state)), states);
        assert.strictEqual(messages.filter(message => message.payload.done).length, 1);
        // 48 rows x 4 ms per page = ~190 ms without slicing; with 50 ms slices the loop runs well within that.
        assert(longest < 150, `the loop waited ${longest} ms while one page was built`);
        assert(ticks > 3);
    }

    console.log('cold startup snapshot paging ok');
    process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
