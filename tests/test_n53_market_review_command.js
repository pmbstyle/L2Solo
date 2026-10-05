const assert = require('assert');
const fs = require('fs');
const path = require('path');

const gameRoot = path.resolve(process.env.N53_GAME_ROOT || path.join(__dirname, '..'));
require(path.join(gameRoot, 'src/Global'));
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const { ColdSimulationCoordinator } = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const Protocol = invoke('GameServer/Bot/Population/ColdSimulationProtocol');
const { ColdTableChannel } = invoke('GameServer/Bot/Population/ColdTableChannel');

// The main authority boundary uses the real DB, cache, native AFK apply and
// command transport. Only its outbound worker and player actor are fixtures;
// no simulation worker, game listener or live database is started.
const clone = value => JSON.parse(JSON.stringify(value));
const failures = [];
let sequence = 0;
let directory;
let coordinator;
const sent = [];
const pricing = { price: 100, seenCounter: 0, seenItem: 0, rival: 90, worth: 0, seenFills: 0 };

async function check(name, work) {
    try { await work(); console.log(`${name}: pass`); }
    catch (error) { failures.push(name); console.error(`${name}: FAIL ${error.stack}`); }
}

async function character() {
    const account = `bot_n53_command_${++sequence}`;
    await Database.createAccount(account, 'pw');
    const id = Number((await Database.createCharacter(account, { name: `N53Command${sequence}`,
        race: 0, classId: 0, sex: 0, face: 0, hair: 0, hairColor: 0, maxHp: 100, maxMp: 100,
        locX: 83000, locY: 148000, locZ: -3400 })).insertId);
    return { id, account };
}

async function trader({ hot = false, leased = true } = {}) {
    const { id, account } = await character();
    for (const item of [{ selfId: 57, name: 'Adena', amount: 1000 },
        { selfId: 1864, name: 'Stem', amount: 20 }]) {
        await Database.setItem(id, { equipped: false, enchant: 0, slot: 0, ...item });
    }
    await Database.setWarehouseItem(id, { selfId: 1864, name: 'Stem', amount: 4 });
    const inventory = LifeState.inventorySummaryFromItems(await Database.fetchItems(id));
    const now = Date.now();
    assert(await LifeState.upsertState({ characterId: id, accountName: account, name: `N53Command${sequence}`,
        phase: 'cold', activity: 'hunting', level: 40, exp: 12345, sp: 120, adena: 1000, inventory,
        currentRegion: 'Giran', loc: { locX: 83000, locY: 148000, locZ: -3400 },
        vitals: { hp: 85, maxHp: 100, mp: 70, maxMp: 100 },
        timing: { lastResolvedAt: now - 45000, nextResolveAt: now + 120000 },
        stats: { generatedCold: true, classId: 0, fights: 9, wins: 6, deaths: 3,
            playedHours: 12.5, frustration: 0.25, marketTrades: { 'material none': 2 },
            commandSentinel: 'preserve' } }, 'n53_command_seed'));
    const source = (await Database.fetchItems(id)).find(item => Number(item.selfId) === 1864);
    const shop = (await Database.createAfkTradeShop(id, { kind: 'sell_ad', storeType: AfkTrade.SELL,
        town: 'Giran', lines: [{ objectId: source.id, selfId: 1864, name: 'Stem', count: 5,
            price: 100, stackable: true, pricing: clone(pricing) }] })).shop;
    AfkTrade.refreshRecord(shop);
    if (hot) assert(await LifeState.upsertState({ ...LifeState.snapshot(id), phase: 'hot' }, 'n53_hot_seed'));
    else if (leased) {
        const claim = await Owner.claimBatch([LifeState.snapshot(id)], { allowLifecycle: true, leaseMs: 120000 });
        assert.strictEqual(claim.grants.length, 1, JSON.stringify(claim.rejected));
        assert(LifeState.snapshot(id).simulation.leaseId, 'positive control holds a real native simulation lease');
    }
    return { id, shop };
}

function request(trader, overrides = {}) {
    const line = trader.shop.lines[0];
    return { kind: 'market_review', commandId: `n53-command-${++sequence}`, characterId: trader.id,
        state: clone(LifeState.snapshot(trader.id)), context: { marker: 'worker-context', nested: { keep: 7 } },
        market: { reprices: [], withdrawals: [], updates: [{ recordId: trader.shop.id, lineId: line.id,
            expectedRevision: trader.shop.revision, previousPricing: clone(line.pricing),
            pricing: { ...clone(line.pricing), seenCounter: 7, seenItem: 3, rival: 95 } }] }, ...overrides };
}

async function persisted() {
    const rows = {};
    for (const table of ['bot_life_state', 'characters', 'items', 'warehouse_items', 'afk_trade_shops', 'afk_trade_lines']) {
        rows[table] = await Database.execute([`SELECT * FROM ${table} ORDER BY rowid`]);
    }
    rows.cached = rows.bot_life_state.map(row => [row.characterId, clone(LifeState.cachedState(row.characterId))]);
    return rows;
}

async function rpc(command) {
    const before = sent.length;
    const message = Protocol.envelope('command_request', coordinator.workerEpoch,
        { requests: [command] }, `n53-rpc-${++sequence}`);
    await coordinator.onMessage(message);
    await coordinator.commandTail;
    const acknowledgements = sent.slice(before).filter(row => row.type === 'command_ack');
    assert.strictEqual(acknowledgements.length, 1, 'one native acknowledgement per market command');
    const ack = acknowledgements[0];
    assert.strictEqual(ack.msgId, message.msgId);
    assert.strictEqual(ack.payload.results.length, 1);
    const result = ack.payload.results[0];
    assert.strictEqual(result.marketCommandId, command.commandId, 'ack echoes the exact queue command marker');
    assert.deepStrictEqual(result.context, command.context, 'market command preserves the supplied context');
    return result;
}

async function refused(command, reason) {
    const before = await persisted();
    const result = await rpc(command);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.marketDeferred, true);
    if (reason) assert.strictEqual(result.reason, reason);
    assert.deepStrictEqual(await persisted(), before, 'refusal changes neither physical state nor line metadata');
}

async function run() {
    assert.strictEqual(typeof ColdSimulationCoordinator.prototype.executeMarketReviewCommand, 'function',
        'baseline feature gap: the dedicated market review authority command is not implemented');
    fs.mkdirSync(path.join(process.cwd(), 'tmp'), { recursive: true });
    directory = fs.mkdtempSync(path.join(process.cwd(), 'tmp', 'test-n53-command-'));
    options.default.Database.path = path.join(directory, 'world.sqlite');
    Database.init();
    assert(Database.isReady());
    DataCache.init();
    invoke('GameServer/World/World').user = { sessions: [], revision: 0 };
    await LifeState.init();
    coordinator = new ColdSimulationCoordinator({ tableChannel: new ColdTableChannel() });
    coordinator.workerEpoch = 'n53-native-command';
    coordinator.worker = { postMessage: message => sent.push(clone(message)) };
    coordinator.contextIndex = () => { throw new Error('market_review must not scan population context'); };

    let valid;
    let validRequest;
    await check('native metadata-only apply and RPC preserve all simulation authority', async () => {
        valid = await trader();
        validRequest = request(valid);
        const before = await persisted();
        const result = await rpc(validRequest);
        assert.strictEqual(result.ok, true, result.reason);
        assert.strictEqual(result.marketDeferred, false);
        const current = (await Database.fetchAfkTradeShops(valid.id))[0];
        assert.deepStrictEqual(current.lines[0].pricing, validRequest.market.updates[0].pricing);
        assert.strictEqual(current.revision, valid.shop.revision, 'no new executable quote revision for metadata');
        const after = await persisted();
        const oldLine = before.afk_trade_lines.find(line => line.id === valid.shop.lines[0].id);
        const newLine = after.afk_trade_lines.find(line => line.id === oldLine.id);
        assert.strictEqual(newLine.pricingSeenCounter, 7);
        assert.strictEqual(newLine.pricingSeenItem, 3);
        after.afk_trade_lines = after.afk_trade_lines.map(line => line.id === oldLine.id ? {
            ...line, pricingSeenCounter: oldLine.pricingSeenCounter, pricingSeenItem: oldLine.pricingSeenItem,
            pricingRival: oldLine.pricingRival, updatedAt: oldLine.updatedAt
        } : line);
        assert.deepStrictEqual(after, before,
            'only line observation columns/time change; no stats, combat, timing, bag, warehouse, quote or lease write');
        assert.deepStrictEqual(result.state, LifeState.snapshot(valid.id));
    });
    await check('same public revision with stale previousPricing defers without replay', async () => {
        assert(validRequest, 'positive fixture required');
        const before = await persisted();
        const result = await rpc(validRequest);
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.marketDeferred, true, 'zero native applies explicitly defer the review');
        assert.deepStrictEqual(await persisted(), before);
    });
    await check('simulation revision, owner and lease mismatch refuse before native apply', async () => {
        const bot = await trader();
        for (const patch of [{ revision: 999 }, { ownerId: 'other_owner' }, { leaseId: 'old_lease' }]) {
            const command = request(bot);
            Object.assign(command.state.simulation, patch);
            await refused(command, 'stale_market_review');
        }
    });
    await check('hot, fenced, visible and noncached durable owners refuse', async () => {
        const hot = await trader({ hot: true });
        await refused(request(hot), 'hot_handoff_fenced');
        const bot = await trader();
        coordinator.fencedBots.add(bot.id);
        try { await refused(request(bot), 'hot_handoff_fenced'); }
        finally { coordinator.fencedBots.delete(bot.id); }
        const loc = LifeState.snapshot(bot.id).loc;
        coordinator.population = { realPlayerSessions: () => [{ actor: {
            fetchLocX: () => loc.locX, fetchLocY: () => loc.locY, fetchLocZ: () => loc.locZ
        } }] };
        try {
            assert.strictEqual(coordinator.visibleToRealPlayer(LifeState.snapshot(bot.id)), true,
                'the native visibility policy recognizes the adjacent human fixture');
            await refused(request(bot), 'hot_handoff_fenced');
        } finally { coordinator.population = null; }
        const uncached = await character();
        const row = (await Database.execute(['SELECT * FROM bot_life_state WHERE characterId = ?', [bot.id]]))[0];
        row.characterId = uncached.id;
        const columns = await Database.execute(['PRAGMA table_info(bot_life_state)']);
        const keys = columns.map(column => column.name);
        await Database.execute([`INSERT INTO bot_life_state (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
            keys.map(key => row[key])]);
        assert.strictEqual(LifeState.cachedState(uncached.id), null, 'durable owner has no current main cache authority');
        const command = request(bot, { characterId: uncached.id });
        command.state.characterId = uncached.id;
        await refused(command, 'hot_handoff_fenced');
    });
    await check('malformed arrays and command/character identities do not mutate anything', async () => {
        const bot = await trader();
        for (const overrides of [{ commandId: '' }, { commandId: 42 },
            { market: { reprices: [], withdrawals: [], updates: {} } },
            { market: { reprices: [], withdrawals: [], updates: Array(Protocol.MAX_BATCH + 1).fill({}) } }]) {
            await refused(request(bot, overrides), 'invalid_market_review');
        }
        await refused(request(bot, { characterId: -1 }), 'hot_handoff_fenced');
    });
    await check('native record owner guard cannot move another owner line', async () => {
        const owner = await trader();
        const other = await trader();
        const command = request(owner);
        const foreign = request(other).market.updates[0];
        command.market = { updates: [foreign], reprices: [{ ...foreign, price: 80,
            pricing: { ...foreign.pricing, price: 80 } }], withdrawals: [foreign] };
        const before = await persisted();
        const result = await rpc(command);
        assert.strictEqual(result.marketDeferred, true);
        assert.deepStrictEqual(await persisted(), before,
            'native apply preserves foreign escrow, stock, inventory and line memory');
    });
    if (failures.length) throw new Error(`${failures.length} N53 authority contracts failed: ${failures.join('; ')}`);
    console.log('N53 native market authority command: six focused contracts passed');
}

run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    AfkTrade._resetForTests();
    await Database.close();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
});
