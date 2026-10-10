const assert = require('node:assert/strict');
delete process.env.L2NODE_SHARED_CONFIG_FILE;
process.env.L2NODE_CONFIG_FILE = 'config/default.ini';
const { createWorld, Database } = require('./helpers/c4QuestHarness');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const Statements = require('../src/DatabaseStatements');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const ids = [719101, 719102, 719103];
const counter = 'material none';
const saved = async id => (await Database.execute(['SELECT statsJson FROM bot_life_state WHERE characterId=?', [id]]))[0];
const counts = async () => Database.execute(['SELECT * FROM bot_market_counts ORDER BY characterId,counter']);

async function run() {
    const world = await createWorld(ids.map(id => ({ id, level: 60 })), 'saved-market-counts');
    const enabled = Config.knowledgeErrorsEnabled;
    Config.knowledgeErrorsEnabled = true;
    try {
        await Database.createAccount('bot_saved_counts', 'test');
        await Database.execute(["UPDATE characters SET username='bot_saved_counts'"]);
        for (const [index, id] of ids.entries()) await Database.execute([
            `INSERT INTO bot_life_state(characterId,accountName,characterName,level,phase,activity,inventorySummary,statsJson)
                VALUES(?,'bot_saved_counts',?,60,'cold','hunting','{}',?)`,
            [id, `Count${id}`, JSON.stringify({ classId: 0, loadProbe: 'x'.repeat(22000), marketTrades: { [counter]: index + 2 } })]
        ]);
        await Database.execute(['CREATE TABLE saved_counts_audit(kind TEXT)']);
        await Database.execute([`CREATE TRIGGER saved_counts_life AFTER UPDATE OF statsJson ON bot_life_state
            BEGIN INSERT INTO saved_counts_audit VALUES('life'); END`]);
        // Reopen the real upgrade boundary with three legacy rows.
        await Database.execute(['DELETE FROM schema_migrations WHERE version=59']);
        await Database.execute(["DELETE FROM world_meta WHERE key='botMarketCountsMoved'"]);
        await world.reopen(ids[0]);
        assert.deepEqual((await counts()).map(row => row.deals), [2, 3, 4]);
        for (const id of ids) assert.equal(JSON.parse((await saved(id)).statsJson).marketTrades, undefined);
        assert.equal((await Database.execute(['SELECT COUNT(*) AS n FROM saved_counts_audit']))[0].n, 3);
        await world.reopen(ids[0]);
        assert.equal((await Database.execute(['SELECT COUNT(*) AS n FROM saved_counts_audit']))[0].n, 3, 'second start does not copy or rewrite legacy counters again');

        await Life.init();
        for (const id of ids.slice(0, 2)) {
            await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 10000, slot: 0 });
            if (id === ids[0]) await Database.setItem(id, { selfId: 1864, name: 'Stem', amount: 10, slot: 0 });
            const old = Life.cachedState(id);
            await Life.upsertState({ ...old, adena: 10000,
                inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)) }, 'saved_counts_seed');
        }
        const item = (await Database.fetchItems(ids[0])).find(row => row.selfId === 1864);
        // A bot sell ad settles only at a meeting (E115); an immediate deal needs the backed shop.
        const { shop } = await Database.createAfkTradeShop(ids[0], { kind: 'shop', storeType: 1, town: 'Giran',
            lines: [{ objectId: item.id, selfId: 1864, name: 'Stem', count: 10, price: 100, stackable: true }] });
        await Database.execute(['DELETE FROM saved_counts_audit']);
        await Database.execute([`CREATE TRIGGER saved_counts_insert AFTER INSERT ON bot_market_counts
            BEGIN INSERT INTO saved_counts_audit VALUES('count'); END`]);
        await Database.execute([`CREATE TRIGGER saved_counts_update AFTER UPDATE ON bot_market_counts
            BEGIN INSERT INTO saved_counts_audit VALUES('count'); END`]);
        const prepare = Statements.prepare, parse = JSON.parse;
        const sql = [], parsedBytes = [];
        Statements.prepare = (db, text) => { sql.push(text); return prepare(db, text); };
        JSON.parse = (text, ...args) => { parsedBytes.push(typeof text === 'string' ? text.length : 0); return parse(text, ...args); };
        let result;
        try {
            result = await Database.buyFromAfkTradeShop(ids[1], { shopId: shop.id, ownerId: ids[0], lineId: shop.lines[0].id, amount: 1 });
        } finally { Statements.prepare = prepare; JSON.parse = parse; }
        assert.equal((await Database.execute(["SELECT COUNT(*) AS n FROM saved_counts_audit WHERE kind='life'"]))[0].n, 0, 'a standalone deal writes no life row');
        assert.equal((await Database.execute(["SELECT COUNT(*) AS n FROM saved_counts_audit WHERE kind='count'"]))[0].n, 2, 'a deal advances exactly two small counter rows');
        assert(!sql.some(text => /SELECT[\s\S]*statsJson/.test(text)), 'deal learning reads no saved stats');
        assert(!sql.some(text => /SELECT value FROM world_meta WHERE key = 'board(?:Deal|Counter)CountsReady'/.test(text)), 'initialized readiness has no per-deal SELECT');
        assert(Math.max(0, ...parsedBytes) < 4000, 'deal parses only small metadata');
        for (const [id, own] of Object.entries(result.marketTrades)) Life.acceptMarketTrades(id, own);
        assert.equal(Life.cachedState(ids[0]).marketTrades[counter], 3);
        assert.equal(Life.cachedState(ids[1]).marketTrades[counter], 4);

        const state = Life.cachedState(ids[2]);
        const token = await Owner.claim(state, { leaseMs: 30000 });
        assert(token.ok);
        const next = structuredClone(state);
        next.stats.marketTrades = { malicious: 999 };
        const [commit] = await Owner.commitAndReleaseBatch([{ token, nextState: next,
            proposal: { baseState: { inventory: state.inventory } } }]);
        assert(commit.ok);
        assert.equal(JSON.parse((await saved(ids[2])).statsJson).marketTrades, undefined, 'a stale cold worker cannot put counters back into statsJson');
        assert.equal((await counts()).find(row => row.characterId === ids[2]).deals, 4);
        assert.equal(Life.cachedState(ids[2]).marketTrades[counter], 4);
        console.log('Saved market counts: once-only upgrade, two small deal writes, zero stats reads/writes, cached readiness and cold-save preservation passed');
    } finally { Config.knowledgeErrorsEnabled = enabled; await world.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
