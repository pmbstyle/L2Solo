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
const WriteQueue = invoke('GameServer/Persistence/CharacterWriteQueue');
const World = invoke('GameServer/World/World');

// Actual Main RPC, native AFK metadata apply and registered character flush.
// Generated world/history and worker sinks; no game listener or live database.
const clone = value => JSON.parse(JSON.stringify(value));
const failures = [];
let sequence = 0;
let directory;
let coordinator;
const sent = [];
const players = new Set();
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

function removePlayer(session) {
    World.removeUser(session);
    players.delete(session);
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
    const state = clone(LifeState.snapshot(trader.id));
    return { kind: 'market_review', commandCheckpoint: Protocol.commandCheckpoint(state), commandId: `n53-command-${++sequence}`, characterId: trader.id,
        state, context: { marker: 'worker-context', nested: { keep: 7 } },
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

function characterFlushBarrier(id) {
    let arrived;
    let release;
    let held = false;
    const entered = new Promise(resolve => { arrived = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    Database.registerCharacterWriteFlush(characterId => {
        if (Number(characterId) !== id || held) return WriteQueue.flushCharacter(characterId);
        held = true;
        arrived();
        return gate.then(() => WriteQueue.flushCharacter(characterId));
    });
    return { entered, release, restore: () => Database.registerCharacterWriteFlush(WriteQueue.flushCharacter) };
}

async function reviewAcrossFlush(mutate, { withdrawal = false, refusal = null } = {}) {
    const bot = await trader({ leased: false });
    // Publication put stock in escrow. Align the native lifecycle row with
    // the resulting physical bag before leasing it for this race fixture.
    const inventory = LifeState.inventorySummaryFromItems(await Database.fetchItems(bot.id));
    assert(await LifeState.upsertState({ ...LifeState.snapshot(bot.id), inventory }, 'n53_escrow_seed'));
    const claimed = await Owner.claimBatch([LifeState.snapshot(bot.id)], { allowLifecycle: true, leaseMs: 120000 });
    assert.strictEqual(claimed.grants.length, 1);
    const command = request(bot);
    if (withdrawal) command.market = { reprices: [], updates: [], withdrawals: [{
        recordId: bot.shop.id, lineId: bot.shop.lines[0].id, expectedRevision: bot.shop.revision,
        previousPricing: clone(bot.shop.lines[0].pricing) }] };
    const barrier = characterFlushBarrier(bot.id);
    const state = LifeState.snapshot(bot.id);
    WriteQueue.vitals(bot.id, state.vitals.hp, state.vitals.maxHp, state.vitals.mp, state.vitals.maxMp);
    let pending;
    try {
        pending = rpc(command);
        await barrier.entered;
        assert(coordinator.commandInflight.has(bot.id), 'native precheck passed before the real flush await');
        const rows = await Database.execute(['SELECT * FROM afk_trade_lines WHERE id = ?', [bot.shop.lines[0].id]]);
        assert.strictEqual(rows[0].pricingSeenCounter, 0, 'no line mutation before the controlled await');
        await mutate(bot, command);
        const before = await persisted();
        barrier.release();
        const result = await pending;
        const after = await persisted();
        if (refusal) {
            assert.deepStrictEqual(after, before,
                'changed authority refuses before any metadata, stock, escrow, inventory or lifecycle/cache write');
            assert.strictEqual(result.ok, false);
            assert.strictEqual(result.marketDeferred, true);
            assert.strictEqual(result.reason, refusal);
        } else {
            assert.strictEqual(result.ok, true, result.reason);
            assert.strictEqual(result.marketDeferred, false);
            const oldLine = before.afk_trade_lines.find(line => line.id === bot.shop.lines[0].id);
            const newLine = after.afk_trade_lines.find(line => line.id === oldLine.id);
            assert.strictEqual(newLine.pricingSeenCounter, 7, 'same authority applies after the real flush');
            after.afk_trade_lines = after.afk_trade_lines.map(line => line.id === oldLine.id ? {
                ...line, pricingSeenCounter: oldLine.pricingSeenCounter, pricingSeenItem: oldLine.pricingSeenItem,
                pricingRival: oldLine.pricingRival, updatedAt: oldLine.updatedAt
            } : line);
            assert.deepStrictEqual(after, before, 'same authority writes only the chosen line observation columns');
        }
    } finally {
        barrier.release();
        if (pending) await pending.catch(() => null);
        barrier.restore();
        for (const player of players) removePlayer(player);
        coordinator.fencedBots.delete(bot.id);
        coordinator.population = null;
        coordinator.ready = false;
    }
}

async function sourceReviewAcrossFlush() {
    const bot = await trader({ leased: false });
    const inventory = LifeState.inventorySummaryFromItems(await Database.fetchItems(bot.id));
    assert(await LifeState.upsertState({ ...LifeState.snapshot(bot.id), inventory }, 'command_source_escrow'));
    const claim = await Owner.claimBatch([LifeState.snapshot(bot.id)], { allowLifecycle: true, leaseMs: 120000 });
    assert.strictEqual(claim.grants.length, 1);
    const command = request(bot), barrier = characterFlushBarrier(bot.id), beforeSent = sent.length;
    const message = Protocol.envelope('command_request', coordinator.workerEpoch, { requests: [command] }, `source-${++sequence}`);
    const originalWorker = coordinator.worker, originalEpoch = coordinator.workerEpoch;
    let pending;
    try {
        pending = coordinator.onMessage(message, coordinator.worker, coordinator.workerEpoch);
        await barrier.entered;
        assert(coordinator.commandInflight.has(bot.id));
        const before = await persisted();
        const replacementSent = [];
        coordinator.worker = { postMessage: message => replacementSent.push(clone(message)) };
        coordinator.workerEpoch = 'source-replacement';
        barrier.release();
        await pending; await coordinator.commandTail;
        const after = await persisted();
        console.log('native source review', JSON.stringify({ seenBefore: before.afk_trade_lines.find(x => x.id === bot.shop.lines[0].id).pricingSeenCounter,
            seenAfter: after.afk_trade_lines.find(x => x.id === bot.shop.lines[0].id).pricingSeenCounter,
            oldAcks: sent.slice(beforeSent).filter(x => x.type === 'command_ack').length,
            replacementAcks: replacementSent.filter(x => x.type === 'command_ack').length }));
        assert.deepStrictEqual(after, before, 'retired Worker source must not write native line observation or physical/lifecycle/cache facts');
        assert.strictEqual(replacementSent.filter(x => x.type === 'command_ack').length, 0);
    } finally { barrier.release(); if (pending) await pending.catch(() => null); await coordinator.commandTail.catch(() => null); barrier.restore(); coordinator.worker=originalWorker; coordinator.workerEpoch=originalEpoch; }
}
async function run() {
    directory = fs.mkdtempSync(path.join(process.cwd(), 'tmp', 'command-source-native-'));
    options.default.Database.path = path.join(directory, 'world.sqlite');
    options.default.Database.historyPath = path.join(directory, 'history.sqlite');
    Database.init(); assert(Database.isReady()); DataCache.init();
    World.user = { sessions: [], revision: 0 }; await LifeState.init();
    coordinator = new ColdSimulationCoordinator({ tableChannel: new ColdTableChannel() });
    coordinator.workerEpoch = 'source-original';
    coordinator.worker = { postMessage: message => sent.push(clone(message)) };
    coordinator.contextIndex = () => { throw Error('market must not scan population'); };
    await check('native unchanged source current RPC crosses real flush and applies chosen metadata only', () => reviewAcrossFlush(async () => {}));
    await check('native retired source during real flush cannot apply observation or reply to replacement', sourceReviewAcrossFlush);
    if(failures.length) throw Error(`${failures.length} native source controls failed`);
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    for (const player of players) removePlayer(player);
    Database.registerCharacterWriteFlush(WriteQueue.flushCharacter);
    await WriteQueue.flushAll(); AfkTrade._resetForTests(); await Database.close();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
});
