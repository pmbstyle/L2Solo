'use strict';

// Actual ON estimates, retained-history startup and native deal settlement.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const gameRoot = path.resolve(process.env.N53_GAME_ROOT || path.join(__dirname, '..'));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'n79-learning-'));
const databasePath = path.join(directory, 'world.sqlite');
const historyPath = path.join(directory, 'history.sqlite');
const previousCwd = process.cwd();
const environmentKeys = ['L2NODE_CONFIG_FILE', 'L2NODE_SHARED_CONFIG_FILE', 'BOT_KNOWLEDGE_ERRORS_ENABLED'];
const previousEnvironment = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
let Database, Life, Afk, Market, Config, World, previousUser, previousPaths, previousEnabled;
const observations = [];
function pass(name) { observations.push(name); console.log('PASS ' + name); }
function near(actual, expected, message) { assert(Math.abs(actual - expected) < 1e-10, message); }

async function bot(label, { player = false } = {}) {
    const account = `${player ? 'player' : 'bot'}_learning_${label}`;
    await Database.createAccount(account, 'pw');
    const id = Number((await Database.createCharacter(account, { name: `Learn${label}`, race: 0, classId: 0,
        maxHp: 100, maxMp: 100, sex: 0, face: 0, hair: 0, hairColor: 0,
        locX: 83000, locY: 148000, locZ: -3466 })).insertId);
    await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 10000, equipped: false, enchant: 0, slot: 0 });
    const stock = Number((await Database.setItem(id, { selfId: 1864, name: 'Stem', amount: 30,
        equipped: false, enchant: 0, slot: 0 })).insertId);
    if (!player) await Life.upsertState({ characterId: id, accountName: account, name: `Learn${label}`,
        phase: 'cold', activity: 'hunting', level: 40, adena: 10000,
        inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)), currentRegion: 'Giran',
        loc: { locX: 83000, locY: 148000, locZ: -3466 }, stats: { generatedCold: true, retainedKnowledge: 17 },
        timing: {}, vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 } }, 'learning_fixture');
    return { id, stock };
}
async function stats(id) {
    const saved = JSON.parse((await Database.execute(['SELECT statsJson FROM bot_life_state WHERE characterId = ?', [id]]))[0].statsJson);
    const rows = await Database.execute(['SELECT counter,deals FROM bot_market_counts WHERE characterId=?', [id]]);
    return { ...saved, marketTrades: Object.fromEntries(rows.map(row => [row.counter, Number(row.deals)])) };
}
async function history(eventKey, fields) {
    return Database.recordMarketTrade({ eventKey, occurredAt: Date.now() - 3600000, selfId: 1864,
        unitPrice: 100, quantity: 20, sourceType: 'afk_bot_store', town: 'Giran', ...fields });
}
async function nativeFacts(owner, buyer, shop) {
    await Database.flushHistory();
    return {
        owner: await Database.fetchItems(owner.id), buyer: await Database.fetchItems(buyer.id),
        ownerStats: await stats(owner.id), buyerStats: await stats(buyer.id),
        shop: (await Database.fetchAfkTradeShops(owner.id)).find(row => row.id === shop.shop.id),
        events: await Database.fetchAfkTradeNotifications(owner.id),
        publicCounts: await Database.execute(["SELECT key, value FROM world_meta WHERE key LIKE 'boardDealCount:%' OR key LIKE 'boardCounterDealCount:%' ORDER BY key"]),
        outbox: await Database.execute(['SELECT * FROM history_outbox ORDER BY id'])
    };
}

async function run() {
    process.chdir(gameRoot);
    process.env.L2NODE_CONFIG_FILE = path.join(gameRoot, 'config/default.ini');
    delete process.env.L2NODE_SHARED_CONFIG_FILE;
    process.env.BOT_KNOWLEDGE_ERRORS_ENABLED = 'true';
    require(path.join(gameRoot, 'src/Global'));
    previousPaths = { world: options.default.Database.path, history: options.default.Database.historyPath };
    options.default.Database.path = databasePath;
    options.default.Database.historyPath = historyPath;
    Database = invoke('Database');
    const DataCache = invoke('GameServer/DataCache');
    DataCache.init();
    Config = invoke('GameServer/Bot/Population/PopulationConfig');
    previousEnabled = Config.knowledgeErrorsEnabled;
    Config.knowledgeErrorsEnabled = true;
    const Learning = invoke('GameServer/Bot/AI/KnowledgeLearning');
    const PriceLearning = invoke('GameServer/Bot/Economy/PriceLearning');
    const Belief = invoke('GameServer/Bot/Economy/PriceBelief');
    const Pricing = invoke('GameServer/Bot/Economy/MarketPricing');
    Market = invoke('GameServer/Bot/Economy/MarketCounters');
    Afk = invoke('GameServer/AfkTrade/AfkTradeService');
    Life = invoke('GameServer/Bot/Population/BotLifeState');
    World = invoke('GameServer/World/World');
    previousUser = World.user;
    World.user = { sessions: [], revision: 0 };
    assert.equal(Database.isReady(), false);
    assert.deepEqual(fs.readdirSync(directory), []);
    Database.init();
    assert.equal(Database.isReady(), true);
    await Life.init();

    const stages = Learning.stages();
    assert.equal(Learning.stages(), stages);
    assert(Object.isFrozen(stages));
    assert.deepEqual(stages.map(row => row.grade), ['none', 'd', 'c', 'b', 'a', 's']);
    for (let i = 0; i < stages.length; i++) {
        const stage = stages[i];
        assert(stage.kills > 0 && Number.isSafeInteger(stage.halfLife));
        if (i) assert(stage.halfLife > stages[i - 1].halfLife);
        const n = Learning.halfLifeOf(stage.grade);
        near(Learning.stageError(0.2, 0.03, n, stage.grade), 0.115, 'one N halves excess error');
        near(Learning.stageError(0.2, 0.03, 3 * n, stage.grade), 0.05125, 'three N leaves 1/8 of excess');
        near(Learning.halfLifeOf(stage.grade, 'market'), Learning.halfLifeOf(stage.grade, 'crafting'));
        assert.equal(Learning.halfLifeOf(stage.grade, 'market'), 3);
        assert.equal(Learning.halfLifeOf(stage.grade, 'crafting'), 3);
        assert.equal(Learning.halfLifeOf(stage.grade, 'mobs'), stage.halfLife);
        assert.equal(Learning.halfLifeOf(stage.grade, 'people'), stage.halfLife);
        near(PriceLearning.errorOf(0.5, Learning.halfLifeOf(stage.grade, 'market'), `gear ${stage.grade}`), 0.0725);
    }
    for (const counter of ['gear none', 'gear d', 'gear b', 'gear s', 'material a']) {
        near(PriceLearning.errorOf(0.3, 0, counter), 0.149, 'a new counter starts with the full personal error');
        near(PriceLearning.errorOf(0.3, 3, counter), 0.0895, 'three own deals halve the excess in every grade');
    }
    assert.throws(() => Learning.halfLifeOf('unknown', 'market'), /unknown_learning_grade/);
    assert.equal(Learning.gradeOfLevel(19), 'none');
    assert.equal(Learning.gradeOfLevel(20), 'd');
    assert.equal(Learning.gradeOfLevel(40), 'c');
    assert.equal(Learning.gradeOfLevel(76), 's');
    assert.equal(PriceLearning.errorOf(1, 0), 0.03);
    assert.equal(PriceLearning.errorOf(0, 0), 0.2);
    assert.equal(PriceLearning.errorOf(0, Infinity), 0.03);
    assert(Learning.stageError(0.2, 0.03, stages[1].halfLife, 'c') > Learning.stageError(0.2, 0.03, stages[1].halfLife, 'd'));
    assert(Learning.stageError(0.2, 0.03, stages[1].halfLife, 'c') < Learning.stageError(0.2, 0.03, 0, 'c'));
    console.log('GRADE N ' + stages.map(row => `${row.grade}:${row.halfLife}/market:${Learning.halfLifeOf(row.grade, 'market').toFixed(2)}`).join(' '));
    pass('shared x1 grade curriculum, lifelong experience, economic unit and 3% floor');

    const owner = await bot('Owner'), buyer = await bot('Buyer'), veteran = await bot('Veteran');
    const player = await bot('Player', { player: true });
    await Database.execute(['INSERT INTO bot_market_counts(characterId,counter,deals) VALUES(?,?,7)', [veteran.id, 'material none']]);
    Life.acceptMarketTrades(veteran.id, { 'material none': 7 });
    for (const row of await Database.execute(['SELECT * FROM bot_life_state'])) Life.acceptLifecycleRow(row);
    const oldDeal = { sellerCharacterId: owner.id, buyerCharacterId: buyer.id };
    await history('old:one', oldDeal);
    await history('old:one', oldDeal);
    await history('old:player', { sourceType: 'afk_player_buy_store', sellerCharacterId: owner.id, buyerCharacterId: player.id });
    await history('old:veteran', { sellerCharacterId: veteran.id, buyerCharacterId: player.id });
    await history('old:npc', { ...oldDeal, sourceType: 'npc_shop' });
    await history('old:free', { ...oldDeal, unitPrice: 0 });
    await history('old:adena', { ...oldDeal, selfId: 57 });
    await Database.flushHistory();
    await Afk.init();
    assert.equal((await stats(owner.id)).marketTrades['material none'], 2);
    assert.equal((await stats(buyer.id)).marketTrades['material none'], 1);
    assert.equal((await stats(veteran.id)).marketTrades['material none'], 7, 'already authoritative counters stay exact');
    assert.equal(Life.cachedState(owner.id).marketTrades['material none'], 2, 'startup publishes seeded native rows');
    assert.equal((await stats(owner.id)).retainedKnowledge, 17);
    assert.equal((await Database.execute(["SELECT value FROM world_meta WHERE key = 'botMarketTradesInitialized'"]))[0].value, 'history');
    await history('late:import', oldDeal);
    await Afk.init();
    assert.equal((await stats(owner.id)).marketTrades['material none'], 2, 'restarts cannot replay or add a newly imported journal row');
    pass('startup seeds confirmed canonical retained deals once, preserves existing counts and unrelated stats');

    const shop = await Database.createAfkTradeShop(owner.id, { kind: 'sell_ad', storeType: 1, town: 'Giran',
        lines: [{ objectId: owner.stock, selfId: 1864, name: 'Stem', count: 10, price: 100, stackable: true }] });
    Afk.refreshRecord(shop.shop);
    const authoredPricing = { ...Afk.boardIndex().ownerLines(owner.id)[0].pricing };
    const ctx = () => Pricing.traderContext(Life.cachedState(buyer.id), { board: Afk.boardIndex(),
        persona: { understanding: 0.5, traits: { commitment: 0.5, caution: 0.5 } }, timestamp: Date.now() });
    const publicPrior = Belief.prior(1864, { ...ctx(), knowledgeEnabled: false });
    const novice = Belief.prior(1864, { ...ctx(), marketTrades: {} });
    const learnt = Belief.prior(1864, { ...ctx(), marketTrades: { 'material none': 3 } });
    const foreign = Belief.prior(1864, { ...ctx(), marketTrades: { 'gear d': 3000 } });
    const sign = novice.bias / PriceLearning.errorOf(0.5, 0);
    near(learnt.bias, sign * PriceLearning.errorOf(0.5, 3));
    near((learnt.bias / sign - 0.03) / (novice.bias / sign - 0.03), 0.5, 'actual production curve halves only the learnable excess');
    near(foreign.bias, novice.bias, 'experience in another kind/grade teaches nothing here');
    near(Math.exp(novice.mu - publicPrior.mu), 1 + novice.bias);
    near(Belief.prior(1864, { ...ctx(), timestamp: Date.now() + 86400000, marketTrades: {} }).bias, novice.bias);
    const priced = Pricing.priceForSale(1864, ctx(), { town: 'Giran', units: 1, rollKey: ['learning', buyer.id] });
    assert(Number.isFinite(priced.ask.price));
    assert(priced.ask.price >= priced.market.buyback, 'ON estimate still obeys the native NPC outside option');
    assert.equal(Life.cachedState(buyer.id).stats.priceBeliefs, undefined);
    pass('actual ON trader/prior/ask uses stable personal error and own counter experience, without an item book');

    const offer = () => Afk.offerOf(Afk.boardIndex().ownerLines(owner.id)[0]);
    const before = { owner: (await stats(owner.id)).marketTrades['material none'], buyer: (await stats(buyer.id)).marketTrades['material none'] };
    const deal = await Afk.buyFromShop(buyer.id, offer().store, 1864, 2);
    assert.equal(deal.amount, 2);
    assert.equal((await stats(owner.id)).marketTrades['material none'], before.owner + 1);
    assert.equal((await stats(buyer.id)).marketTrades['material none'], before.buyer + 1);
    assert.equal(Life.cachedState(buyer.id).marketTrades['material none'], before.buyer + 1);
    assert.equal(Life.cachedState(owner.id).marketTrades['material none'], before.owner + 1);
    assert.equal(Afk.boardIndex().ownerLines(owner.id)[0].fills, 1);
    assert.deepEqual(Afk.boardIndex().ownerLines(owner.id)[0].pricing, authoredPricing, 'experience cannot replace authored line observations');
    await Life.upsertState({ ...Life.cachedState(buyer.id), stats: { ...Life.cachedState(buyer.id).stats,
        marketTrades: { 'material none': 0 } } }, 'stale_learning_snapshot');
    assert.equal((await stats(buyer.id)).marketTrades['material none'], before.buyer + 1, 'stale simulation save cannot reset committed learning');
    pass('actual two-party native trade and cache publication add one action, not two units, preserving line/checkpoint authority');

    Config.knowledgeErrorsEnabled = false;
    const offBefore = await stats(buyer.id);
    const counterBefore = Market.counter('material none').deals;
    const exact = Belief.prior(1864, ctx());
    assert.equal(exact.bias, 0);
    await Afk.buyFromShop(buyer.id, offer().store, 1864, 1);
    assert.deepEqual((await stats(buyer.id)).marketTrades, offBefore.marketTrades);
    assert.equal(Market.counter('material none').deals, counterBefore + 1, 'OFF still observes actual board deals');
    const offAfter = Belief.prior(1864, ctx());
    assert.equal(offAfter.bias, 0);
    assert.equal(Afk.boardIndex().ownerLines(owner.id)[0].fills, 2);
    Config.knowledgeErrorsEnabled = true;
    pass('common OFF switch disables personal bias and learning increments, while public market and fills continue');

    await Database.flushHistory();
    const conserved = await nativeFacts(owner, buyer, shop);
    await Database.execute([`CREATE TEMP TRIGGER learning_deal_failure BEFORE UPDATE OF deals ON main.bot_market_counts
        WHEN NEW.characterId = ${owner.id} BEGIN SELECT RAISE(ABORT, 'learning settlement refused'); END`]);
    try { await assert.rejects(Afk.buyFromShop(buyer.id, offer().store, 1864, 1), /learning settlement refused/); }
    finally { await Database.execute(['DROP TRIGGER temp.learning_deal_failure']); }
    assert.deepEqual(await nativeFacts(owner, buyer, shop), conserved);
    assert.equal(Afk.boardIndex().ownerLines(owner.id)[0].fills, 2);
    pass('failed native learning write rolls back bags, Adena, board fill, counters, event and journal together');
}

run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    Afk?._resetForTests(); Market?.reset();
    if (Database) await Database.close();
    if (World && previousUser !== undefined) World.user = previousUser;
    if (Config && previousEnabled !== undefined) Config.knowledgeErrorsEnabled = previousEnabled;
    if (previousPaths) { options.default.Database.path = previousPaths.world; options.default.Database.historyPath = previousPaths.history; }
    for (const key of environmentKeys) {
        if (previousEnvironment[key] === undefined) delete process.env[key]; else process.env[key] = previousEnvironment[key];
    }
    fs.rmSync(directory, { recursive: true, force: true });
    process.chdir(previousCwd);
    console.log(JSON.stringify({ observations, databaseClosed: Database?.isReady() === false, generatedDirectoryRemoved: !fs.existsSync(directory) }));
});
