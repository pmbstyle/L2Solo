const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
require('../src/Global');

const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const Actor = invoke('GameServer/Actor/Actor');
const World = invoke('GameServer/World/World');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const Counters = invoke('GameServer/Bot/Economy/MarketCounters');
const Pricing = invoke('GameServer/Bot/Economy/MarketPricing');
const Listings = invoke('GameServer/Bot/Economy/MarketListingPolicy');
const Dispatcher = invoke('GameServer/Bot/AI/HotAiDispatcher');
const HotReview = invoke('GameServer/Bot/Economy/HotBoardReviewService');
const Metrics = invoke('GameServer/Bot/Population/PopulationMetrics');
const WriteQueue = invoke('GameServer/Persistence/CharacterWriteQueue');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');

const STEM = 1864;
const LOC = { locX: 83000, locY: 148000, locZ: -3400 };
const sessions = [];
let sequence = 0;
let admitted = true;
const providers = { admit: () => admitted ? {} : null, complete() {} };
async function character({ bot = false, online = false } = {}) {
    const account = `${bot ? 'bot' : 'player'}_hot_safety_${++sequence}`;
    await Database.createAccount(account, 'pw');
    const id = Number((await Database.createCharacter(account, { name: `HotSafety${sequence}`,
        race: 0, classId: 0, sex: 0, face: 0, hair: 0, hairColor: 0,
        maxHp: 100, maxMp: 100, ...LOC })).insertId);
    for (const item of [{ selfId: 57, name: 'Adena', amount: 300000 },
        { selfId: STEM, name: 'Stem', amount: 40 }]) {
        await Database.setItem(id, { equipped: false, enchant: 0, slot: 0, ...item });
    }
    const items = await Database.fetchItems(id);
    if (!bot) return { id, items };
    const counter = Counters.counterOf(STEM);
    await Database.execute(['INSERT INTO bot_market_counts(characterId,counter,deals) VALUES(?,?,7)', [id, counter]]);
    LifeState.acceptMarketTrades(id, { [counter]: 7 });
    const state = await LifeState.upsertState({ characterId: id, accountName: account,
        name: `HotSafety${sequence}`, phase: 'hot', activity: 'hunting', level: 40,
        adena: 300000, loc: { ...LOC }, currentRegion: 'Giran',
        inventory: LifeState.inventorySummaryFromItems(items),
        vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
        stats: { generatedCold: true, classId: 0 },
        timing: { nextResolveAt: Date.now() + 3600000 } }, 'hot_review_fixture');
    assert(state && LifeState.hotRow(id), 'native lifecycle and cache are actually hot');
    const row = (await Database.fetchCharacters(account))[0];
    const classInfo = DataCache.classTemplates.find(entry => Number(entry.classId) === Number(row.classId));
    const session = { accountId: account, botSession: true, plan: 'hunting', currentRegion: 'Giran',
        coldLifeState: state, fetchAccountId() { return this.accountId; },
        dataSendToMe() {}, dataSendToOthers() {}, dataSendToMeAndOthers() {} };
    session.actor = new Actor(session, { ...row, ...utils.crushOb(classInfo), level: 40,
        items, paperdoll: utils.tupleAlloc(16, {}), isOnline: false });
    World.insertUser(session);
    session.actor.setIsOnline(online);
    assert.strictEqual(World.updateUserLocation(session), online, 'hot actor is registered in the common runtime');
    sessions.push(session);
    return { id, session, items };
}

function actualContext(trader) {
    const state = { ...LifeState.snapshot(trader.id), ...Listings.actorState(trader.session),
        phase: 'hot', activity: trader.session.plan, loc: { ...LOC }, currentRegion: 'Giran' };
    const ctx = Listings.traderContext(state);
    assert.strictEqual(ctx.knowledgeEnabled, false, 'uses the actual shared OFF switch');
    return { state, ctx };
}

async function cooperativeTurns() {
    const completed = Dispatcher.snapshot().completed;
    for (let index = 0; index < 16; index++) {
        await new Promise(resolve => {
            assert(Dispatcher.enqueue(Symbol('hot-review-fixture-turn'), resolve));
        });
    }
    assert(Dispatcher.snapshot().completed >= completed + 16, 'real dispatcher crossed sixteen cooperative turns');
}

async function publication(trader, side) {
    const price = 200;
    const worth = side === AfkTrade.BUY ? 5000.375 : 0;
    const { ctx } = actualContext(trader);
    const pricing = Pricing.lineState(STEM, ctx, { price, storeType: side, worth });
    const source = trader.items.find(item => Number(item.selfId) === STEM);
    const shop = await AfkTrade.publishBot(trader.id, { kind: side === AfkTrade.BUY ? 'buy_ad' : 'sell_ad',
        storeType: side, town: 'Giran', lines: [{ selfId: STEM, name: 'Stem', count: 10,
            price, stackable: true, ...(side === AfkTrade.SELL ? { objectId: source.id } : {}), pricing }] });
    const line = AfkTrade.boardIndex().ownerLines(trader.id)[0];
    assert(line && line.botOwned && line.count === 10, 'actual bot publication enters the indexed board');
    assert.deepStrictEqual(line.pricing, pricing, 'actual publication retains the OFF-produced line state');
    assert([...AfkTrade.boardIndex().ownersForCounter(Counters.counterOf(STEM))].includes(trader.id),
        'priced bot owner is indexed by the actual counter');
    return { shop, line, pricing };
}


(async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'l2solo-hot-board-safety-'));
    const previous = { database: options.default.Database.path, history: options.default.Database.historyPath,
        knowledge: Config.knowledgeErrorsEnabled };
    options.default.Database.path = path.join(directory, 'world.sqlite');
    options.default.Database.historyPath = path.join(directory, 'history.sqlite');
    Config.knowledgeErrorsEnabled = false;
    try {
        Database.init();
        DataCache.init();
        World.user = { sessions: [], revision: 0 };
        await LifeState.init();
        await AfkTrade.init();
        HotReview.start(providers);
        const customer = await character();
        const trader = await character({ bot: true, online: true });
        const { shop, line } = await publication(trader, AfkTrade.SELL);
        admitted = false;
        const before = Counters.counter(Counters.counterOf(STEM)).deals;
        await AfkTrade.buyFromShop(customer.id, AfkTrade.recordStore(shop.id), STEM, 1,
            { lineId: line.lineId, expectedPrice: line.price, expectedRevision: shop.revision });
        await cooperativeTurns();
        const filled = (await Database.fetchAfkTradeShops(trader.id))[0].lines[0];
        assert.strictEqual(filled.fills, 1);
        assert.strictEqual(filled.pricing.seenCounter, before);
        assert.strictEqual(Counters.counter(Counters.counterOf(STEM)).deals, before + 1);
        assert(HotReview.events.pending.has(trader.id), 'actual denied review remains pending');
        console.log('Actual native publication/fill, hot owner, counter and denied pending review: PASS');
        assert.strictEqual(typeof HotReview.probeSafety, 'function', 'hot safety probe API exists');
        assert.strictEqual(typeof HotReview.repairSafety, 'function');
        const checkpoint = Protocol.safetyCheckpoint(LifeState.hotRow(trader.id));
        const recovered = Metrics.counters.missedEventsRecovered;
        const total = HotReview.safetyRepairs || 0;
        assert.strictEqual(HotReview.probeSafety(checkpoint).status, 'covered', 'intentional pending is covered');
        HotReview.events.forget(trader.id); // Deliberate lost input after an actual native fill.
        const receipt = HotReview.probeSafety(checkpoint);
        assert.strictEqual(receipt.status, 'uncovered');
        assert.strictEqual(HotReview.repairSafety(receipt), true);
        assert.strictEqual(HotReview.repairSafety(receipt), false, 'same receipt counts once');
        assert.strictEqual(HotReview.safetyRepairs, total + 1);
        assert.strictEqual(Metrics.counters.missedEventsRecovered, recovered + 1);
        assert.strictEqual(Metrics.recordHotSafetyTotal(HotReview.safetyRepairs), 0);
        for (const invalid of [null, '2', -1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
            assert.strictEqual(Metrics.recordHotSafetyTotal(invalid), 0);
        }
        assert.strictEqual(Metrics.recordHotSafetyTotal(total), 0, 'out of order report does not move the watermark');
        admitted = true;
        HotReview.pump();
        await cooperativeTurns();
        const reviewed = (await Database.fetchAfkTradeShops(trader.id))[0].lines[0];
        assert.strictEqual(reviewed.pricing.seenCounter, before + 1);
        assert.strictEqual(reviewed.pricing.seenItem, before + 1);
        assert.strictEqual(reviewed.pricing.seenFills, 1);
        assert.notStrictEqual(HotReview.probeSafety(checkpoint).status, 'uncovered');
        console.log('Actual native lost-event repair queues once and production dispatcher checkpoints: PASS');

        const waitingTrader = await character({ bot: true, online: true });
        const waitingShop = await publication(waitingTrader, AfkTrade.SELL);
        let enter, release, held = false;
        const entered = new Promise(resolve => { enter = resolve; });
        const gate = new Promise(resolve => { release = resolve; });
        Database.registerCharacterWriteFlush(id => {
            if (Number(id) !== waitingTrader.id || held || HotReview.inFlight?.id !== waitingTrader.id) {
                return WriteQueue.flushCharacter(id);
            }
            held = true; enter();
            return gate.then(() => WriteQueue.flushCharacter(id));
        });
        try {
            const deal = AfkTrade.buyFromShop(customer.id, AfkTrade.recordStore(waitingShop.shop.id), STEM, 1,
                { lineId: waitingShop.line.lineId, expectedPrice: waitingShop.line.price,
                    expectedRevision: waitingShop.shop.revision });
            await entered;
            const waitingCheckpoint = Protocol.safetyCheckpoint(LifeState.hotRow(waitingTrader.id));
            HotReview.events.forget(waitingTrader.id);
            const ownLines = HotReview.board.ownerLines;
            HotReview.board.ownerLines = () => { throw new Error('native busy coverage must precede own-line reads'); };
            try {
                assert.strictEqual(HotReview.probeSafety(waitingCheckpoint).status, 'covered');
            } finally { HotReview.board.ownerLines = ownLines; }
            assert.strictEqual(HotReview.safetyRepairs, total + 1);
            release(); await deal; await cooperativeTurns();
            console.log('Actual native in-flight owner stays covered after removed queue input: PASS');
        } finally {
            release(); Database.registerCharacterWriteFlush(WriteQueue.flushCharacter);
        }

        // A second real deal gives fresh work for authority/identity controls.
        admitted = false;
        const currentShop = (await Database.fetchAfkTradeShops(trader.id))[0];
        const currentLine = AfkTrade.boardIndex().ownerLines(trader.id)[0];
        await AfkTrade.buyFromShop(customer.id, AfkTrade.recordStore(currentShop.id), STEM, 1,
            { lineId: currentLine.lineId, expectedPrice: currentLine.price, expectedRevision: currentShop.revision });
        await cooperativeTurns();
        HotReview.events.forget(trader.id);
        const fresh = Protocol.safetyCheckpoint(LifeState.hotRow(trader.id));
        const oldReceipt = HotReview.probeSafety(fresh);
        assert.strictEqual(oldReceipt.status, 'uncovered');
        const token = World.registeredActorById(trader.id).token;
        World.removeUser(trader.session);
        World.insertUser(trader.session);
        assert.notStrictEqual(World.registeredActorById(trader.id).token, token);
        HotReview.events.forget(trader.id);
        assert.strictEqual(HotReview.repairSafety(oldReceipt), false, 'raw replacement invalidates receipt');
        const newReceipt = HotReview.probeSafety(fresh);
        HotReview.stop(); HotReview.start(providers);
        HotReview.events.forget(trader.id);
        assert.strictEqual(HotReview.repairSafety(newReceipt), false, 'service generation invalidates receipt');
        const terminalReceipt = HotReview.probeSafety(fresh);
        assert.strictEqual(terminalReceipt.status, 'uncovered');
        World.retireUserActor(trader.session, trader.session.actor);
        HotReview.events.forget(trader.id);
        assert.strictEqual(HotReview.repairSafety(terminalReceipt), false);
        assert.strictEqual(Metrics.counters.missedEventsRecovered, recovered + 1);
        console.log('Raw identity, service restart, terminal retirement accept zero additional repairs: PASS');
        console.log('Hot board safety native tests: PASS');
    } finally {
        HotReview.stop();
        AfkTrade._resetForTests();
        Dispatcher.resetForTest();
        for (const session of sessions) World.removeUser(session);
        await Database.close();
        options.default.Database.path = previous.database;
        options.default.Database.historyPath = previous.history;
        Config.knowledgeErrorsEnabled = previous.knowledge;
        fs.rmSync(directory, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
