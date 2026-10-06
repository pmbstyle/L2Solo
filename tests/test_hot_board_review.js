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
const Belief = invoke('GameServer/Bot/Economy/PriceBelief');
const Listings = invoke('GameServer/Bot/Economy/MarketListingPolicy');
const Dispatcher = invoke('GameServer/Bot/AI/HotAiDispatcher');
const HotReview = invoke('GameServer/Bot/Economy/HotBoardReviewService');
const Governor = invoke('GameServer/Bot/Population/BackgroundWorkGovernor');
const WriteQueue = invoke('GameServer/Persistence/CharacterWriteQueue');
const ActorModel = invoke('GameServer/Model/Actor');
const BotMarket = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');

// Real native publication, settlement, board index and cooperative turns.
// No server/worker/listener is started. Neither look nor applyReview is
// invoked by this fixture: only the production event path may checkpoint.
const STEM = 1864;
const LOC = { locX: 83000, locY: 148000, locZ: -3400 };
const sessions = [];
const failures = [];
let sequence = 0;
let directory;
let admitted = true;
let completion;
let leases = 0;
const previous = { databasePath: options.default.Database.path, knowledge: Config.knowledgeErrorsEnabled };

const providers = {
    admit() {
        if (!admitted) return null;
        const lease = Governor.admit({ job: 'hot_market_review', requestedBudgetMs: 1,
            minimumBudgetMs: 1, playerProtected: false, eventLoopLagMs: 0, dbPending: 0 }).lease || null;
        if (lease) leases++;
        return lease;
    },
    complete(lease, options) {
        Governor.complete(lease, options);
        completion?.();
        completion = null;
    }
};

async function character({ bot = false, online = false } = {}) {
    const account = `${bot ? 'bot' : 'player'}_hot_review_${++sequence}`;
    await Database.createAccount(account, 'pw');
    const id = Number((await Database.createCharacter(account, { name: `HotReview${sequence}`,
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
        name: `HotReview${sequence}`, phase: 'hot', activity: 'hunting', level: 40,
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

async function check(name, work) {
    try { Governor.reset(); await work(); console.log(`PASS ${name}`); }
    catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.stack}`); }
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

async function observeFill(trader, customer, side) {
    const { shop, line, pricing } = await publication(trader, side);
    const counterKey = Counters.counterOf(STEM);
    const before = Counters.counter(counterKey).deals;
    const store = AfkTrade.recordStore(shop.id);
    if (side === AfkTrade.SELL) {
        await AfkTrade.buyFromShop(customer.id, store, STEM, 1,
            { lineId: line.lineId, expectedPrice: line.price, expectedRevision: shop.revision });
    } else {
        const source = (await Database.fetchItems(customer.id)).find(item => Number(item.selfId) === STEM);
        await AfkTrade.sellToShop(customer.id, store, STEM, 1,
            { objectId: source.id, lineId: line.lineId, expectedPrice: line.price, expectedRevision: shop.revision });
    }
    assert.strictEqual(Counters.counter(counterKey).deals, before + 1, 'actual native deal delivers the counter event');
    assert.strictEqual(Counters.itemDeals(STEM).deals, before + 1, 'item evidence is delivered too');
    const filled = (await Database.fetchAfkTradeShops(trader.id))[0].lines[0];
    assert.strictEqual(filled.count, 9, 'native escrow loses exactly one item');
    assert.strictEqual(filled.fills, 1, 'native successful deal records one exact line fill');
    assert.strictEqual(LifeState.snapshot(trader.id).phase, 'hot', 'settlement retains hot lifecycle');
    assert.strictEqual(LifeState.snapshot(trader.id).marketTrades[counterKey], 7,
        'OFF does not increment existing personal experience');
    const actual = Belief.prior(STEM, actualContext(trader).ctx);
    assert(actual && Number.isFinite(actual.mu) && actual.K > 0);
    assert.strictEqual(actual.bias, 0, 'real OFF pricing reads fresh board/deal evidence without pending ON policy');
    const { ctx } = actualContext(trader);
    if (side === AfkTrade.SELL) {
        const quote = Pricing.priceForSale(STEM, ctx, { town: 'Giran', units: 9,
            rollKey: ['hot-review-fixture-positive-ask', trader.id] });
        assert(quote && !quote.ask.npc && quote.ask.price > quote.market.buyback,
            'actual OFF decision has a valuable board ask, rather than an NPC-only withdrawal');
    } else {
        const review = Pricing.look(LifeState.snapshot(trader.id), AfkTrade.boardIndex().ownerLines(trader.id), ctx);
        assert(!(review?.withdrawals || []).some(move => move.lineId === filled.id),
            'actual OFF review keeps the existing bid at its authored worth');
    }
    console.log(`PASS ${side === AfkTrade.SELL ? 'SELL' : 'BUY'} native data controls: counter=${before + 1}, fills=1, hot=true, bias=0`);
    await cooperativeTurns();
    const reviewed = (await Database.fetchAfkTradeShops(trader.id))[0]?.lines[0];
    assert(reviewed, 'an economically valid authored line remains on the board after review');
    assert.strictEqual(reviewed.pricing.seenCounter, before + 1,
        `actual hot ${side === AfkTrade.SELL ? 'SELL' : 'BUY'} review must consume the delivered counter after a cooperative turn`);
    assert.strictEqual(reviewed.pricing.seenItem, before + 1);
    assert.strictEqual(reviewed.pricing.seenFills, 1);
    assert.strictEqual(reviewed.pricing.worth, pricing.worth, 'BUY keeps the exact authored worth');
}

function reviewFlush(id) {
    let arrive;
    let release;
    let held = false;
    const entered = new Promise(resolve => { arrive = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    Database.registerCharacterWriteFlush(characterId => {
        if (Number(characterId) !== id || held || !HotReview.events.inFlight.has(id)) {
            return WriteQueue.flushCharacter(characterId);
        }
        held = true;
        arrive();
        return gate.then(() => WriteQueue.flushCharacter(characterId));
    });
    return { entered, release, restore: () => Database.registerCharacterWriteFlush(WriteQueue.flushCharacter) };
}

async function fill(trader, customer, published) {
    return AfkTrade.buyFromShop(customer.id, AfkTrade.recordStore(published.shop.id), STEM, 1,
        { lineId: published.line.lineId, expectedPrice: published.line.price,
            expectedRevision: published.shop.revision });
}

async function heldReview(customer, change) {
    const trader = await character({ bot: true, online: true });
    const published = await publication(trader, AfkTrade.SELL);
    const barrier = reviewFlush(trader.id);
    try {
        const deal = fill(trader, customer, published);
        await barrier.entered;
        assert(HotReview.inFlight, 'real native hot review is awaiting the character flush');
        const before = (await Database.fetchAfkTradeShops(trader.id))[0];
        admitted = false;
        await change(trader);
        const done = new Promise(resolve => { completion = resolve; });
        barrier.release();
        await deal;
        await done;
        assert.deepStrictEqual((await Database.fetchAfkTradeShops(trader.id))[0], before,
            'old runtime authority writes no native quote, observation, stock or escrow');
        return trader;
    } finally {
        barrier.release();
        barrier.restore();
        admitted = true;
    }
}

async function rejectedReview(customer, change, caughtUp = false) {
    const trader = await character({ bot: true, online: true });
    const published = await publication(trader, AfkTrade.SELL);
    const barrier = reviewFlush(trader.id);
    const original = BotMarket.applyReview;
    const results = [];
    BotMarket.applyReview = async (id, review, options) => {
        const result = await original(id, review, options);
        if (id === trader.id) results.push(result);
        return result;
    };
    try {
        const deal = fill(trader, customer, published);
        await barrier.entered;
        admitted = false;
        await change(trader, published);
        const done = new Promise(resolve => { completion = resolve; });
        barrier.release();
        await deal;
        await done;
        assert.deepStrictEqual(results, [{ changed: 0, updated: 0 }], 'actual native CAS rejected the old review');
        assert.strictEqual(HotReview.events.ready.has(trader.id), !caughtUp,
            'only fresh, still-unconsumed input is ready after the zero ACK');
        admitted = true;
        HotReview.pump();
        await cooperativeTurns();
        assert.strictEqual(results.length, caughtUp ? 1 : 2, 'fresh input has one retry; caught-up metadata has none');
        assert.strictEqual((await Database.fetchAfkTradeShops(trader.id))[0].lines[0].pricing.seenCounter,
            Counters.counter(Counters.counterOf(STEM)).deals);
    } finally {
        barrier.release();
        barrier.restore();
        admitted = true;
        BotMarket.applyReview = original;
    }
}

(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'l2solo-hot-board-review-'));
    options.default.Database.path = path.join(directory, 'fixture.sqlite');
    Config.knowledgeErrorsEnabled = false;
    try {
        Database.init();
        assert(Database.isReady());
        DataCache.init();
        World.user = { sessions: [], revision: 0 };
        await LifeState.init();
        await AfkTrade.init();
        assert.throws(() => HotReview.start(), /requires admission/);
        HotReview.start(providers);
        const customer = await character();
        await check('native hot SELL wakes from a delivered deal', async () => {
            await observeFill(await character({ bot: true, online: true }), customer, AfkTrade.SELL);
        });
        await check('native hot BUY wakes from a delivered deal', async () => {
            await observeFill(await character({ bot: true, online: true }), customer, AfkTrade.BUY);
        });
        await check('pressure denial retains evidence until an independent pump', async () => {
            const trader = await character({ bot: true, online: true });
            const published = await publication(trader, AfkTrade.SELL);
            const before = Counters.counter(Counters.counterOf(STEM)).deals;
            const oldLeases = leases;
            admitted = false;
            try {
                await fill(trader, customer, published);
                await cooperativeTurns();
                assert.strictEqual(leases, oldLeases, 'no work lease or immediate apply under pressure');
                assert.strictEqual((await Database.fetchAfkTradeShops(trader.id))[0].lines[0].pricing.seenCounter, before);
                assert(HotReview.events.ready.has(trader.id), 'denied owner remains ready');
            } finally { admitted = true; }
            HotReview.pump();
            await cooperativeTurns();
            assert.strictEqual(Counters.counter(Counters.counterOf(STEM)).deals, before + 1, 'recovery needs no new deal');
            assert.strictEqual((await Database.fetchAfkTradeShops(trader.id))[0].lines[0].pricing.seenCounter, before + 1);
        });
        await check('terminal retirement fences a waiting native review and explicit registration recovers', async () => {
            await cooperativeTurns();
            const trader = await heldReview(customer, async owner => {
                const token = World.registeredActorById(owner.id).token;
                World.retireUserActor(owner.session, owner.session.actor);
                owner.session.actor.setIsOnline(true);
                assert(World.registeredActorById(owner.id).retired, 'late online setter preserves retirement');
                assert.notStrictEqual(World.registeredActorById(owner.id).token, token, 'terminal event invalidates authority token');
            });
            World.insertUser(trader.session);
            HotReview.pump();
            await cooperativeTurns();
            assert.strictEqual((await Database.fetchAfkTradeShops(trader.id))[0].lines[0].pricing.seenCounter,
                Counters.counter(Counters.counterOf(STEM)).deals);
        });
        await check('remove and insert of the same actor changes token across native await', async () => {
            await cooperativeTurns();
            const trader = await heldReview(customer, async owner => {
                const token = World.registeredActorById(owner.id).token;
                World.removeUser(owner.session);
                assert.strictEqual(World.registeredActorById(owner.id), null);
                World.insertUser(owner.session);
                assert.notStrictEqual(World.registeredActorById(owner.id).token, token);
            });
            HotReview.pump();
            await cooperativeTurns();
            assert.strictEqual((await Database.fetchAfkTradeShops(trader.id))[0].lines[0].pricing.seenCounter,
                Counters.counter(Counters.counterOf(STEM)).deals, 'fresh registered identity may review the remaining evidence');
        });
        await check('service restart awaits old native work and keeps the existing actor AI key', async () => {
            await cooperativeTurns();
            let aiRan = 0;
            const trader = await heldReview(customer, async owner => {
                assert(Dispatcher.enqueue(owner.session, () => { aiRan++; }));
                const oldToken = HotReview.inFlight;
                const before = leases;
                HotReview.stop();
                HotReview.start(providers);
                admitted = true;
                await cooperativeTurns();
                assert.strictEqual(HotReview.inFlight, oldToken, 'restart retains the old outstanding async token');
                assert.strictEqual(leases, before, 'new generation cannot start a second async apply before old finally');
                admitted = false;
            });
            HotReview.pump();
            await cooperativeTurns();
            assert.strictEqual(aiRan, 1, 'stop only cancels the private review key');
            assert.strictEqual((await Database.fetchAfkTradeShops(trader.id))[0].lines[0].pricing.seenCounter,
                Counters.counter(Counters.counterOf(STEM)).deals, 'new service generation consumes remaining evidence once');
        });
        await check('new deal and board input in flight survives native zero ACK exactly once', async () => {
            await cooperativeTurns();
            await rejectedReview(customer, async (trader, published) => {
                const shop = (await Database.fetchAfkTradeShops(trader.id))[0];
                await AfkTrade.repriceBot(trader.id, published.line.lineId, 201, shop.revision);
                const current = (await Database.fetchAfkTradeShops(trader.id))[0];
                await fill(trader, customer, { shop: current, line: AfkTrade.boardIndex().ownerLines(trader.id)[0] });
            });
        });
        await check('already checkpointed metadata consumes in-flight input without retry', async () => {
            await cooperativeTurns();
            await rejectedReview(customer, async (trader, published) => {
                const first = (await Database.fetchAfkTradeShops(trader.id))[0];
                await fill(trader, customer, { shop: first, line: AfkTrade.boardIndex().ownerLines(trader.id)[0] });
                const current = (await Database.fetchAfkTradeShops(trader.id))[0];
                await AfkTrade.repriceBot(trader.id, published.line.lineId, 201, current.revision);
            }, true);
        });
        await check('fresh hot solo state wins over stale party and economic session snapshots', async () => {
            await cooperativeTurns();
            const trader = await character({ bot: true, online: true });
            const published = await publication(trader, AfkTrade.SELL);
            const hot = LifeState.hotRow(trader.id);
            const live = Listings.actorState(trader.session);
            const liveState = { ...hot, inventory: live.inventory, adena: live.adena, level: live.level,
                stats: { ...hot.stats, classId: live.stats.classId } };
            const sample = { spotId: 'hot-review-own-income', signature: Hunt.signature(liveState), samples: 3,
                at: Date.now(), cycleMs: 60000, exp: 100, adena: 10000, loot: 0, kills: 5 };
            assert(await LifeState.upsertState({ ...hot, stats: { ...hot.stats, huntEfficiency: [sample] } },
                'hot_review_current_income'));
            const current = LifeState.hotRow(trader.id);
            assert.notStrictEqual(Hunt.hourValue(liveState).source, 'own', 'old state has no personal sample');
            const expected = Hunt.hourValue({ ...current, inventory: live.inventory, adena: live.adena, level: live.level });
            assert.strictEqual(expected.source, 'own');
            assert.strictEqual(expected.perHour, 600000, 'real current solo income positive control');
            trader.session.coldLifeState = { ...trader.session.coldLifeState,
                phase: 'cold', party: { partyId: 'stale_old_party' },
                adena: 1, inventory: {}, loc: { locX: -99999, locY: -99999, locZ: 9999 },
                marketTrades: { [Counters.counterOf(STEM)]: 999 } };
            const original = Listings.traderContext;
            const received = [];
            Listings.traderContext = (state, ...rest) => {
                const ctx = original(state, ...rest);
                if (state.characterId === trader.id) received.push({ state, ctx });
                return ctx;
            };
            try {
                await fill(trader, customer, published);
                await cooperativeTurns();
                assert(received.length, 'event service constructed the actual common pricing context');
                for (const { state, ctx } of received) {
                    assert.strictEqual(state.party || null, current.party || null);
                    assert.strictEqual(state.phase, 'hot');
                    assert.deepStrictEqual(state.loc, LOC);
                    assert(state.adena > 1 && state.inventory[57], 'live bag and Adena override stale session economics');
                    assert.strictEqual(ctx.marketTrades[Counters.counterOf(STEM)], 7);
                    assert.strictEqual(ctx.hour, 600000, 'stale party must not replace the current solo income with 36000');
                }
            } finally { Listings.traderContext = original; }
        });
        await check('raw registration precedes online and usable-coordinate spatial filters', async () => {
            const trader = await character({ bot: true });
            const raw = World.registeredActorById(trader.id);
            assert(raw && raw.actor === trader.session.actor && raw.session === trader.session && !raw.retired);
            trader.session.actor.setIsOnline(true);
            trader.session.actor.setLocXYZ({ locX: NaN, locY: 1, locZ: 2 });
            assert.strictEqual(World.registeredActorById(trader.id), raw, 'invalid coordinates keep the same raw registration');
            trader.session.actor.setLocXYZ(LOC);
            assert.strictEqual(World.registeredActorById(trader.id), raw, 'movement preserves token and record identity');
            World.retireUserActor(trader.session, trader.session.actor);
            assert(World.registeredActorById(trader.id).retired, 'terminal raw record remains identifiable but ineligible');
        });
        await check('new review dispatch reads no unrelated sessions or life states', async () => {
            for (const session of sessions) await AfkTrade.leave(session.actor.fetchId());
            await cooperativeTurns();
            const trader = await character({ bot: true, online: true });
            await publication(trader, AfkTrade.SELL);
            for (let index = 0; index < 40; index++) {
                const accountId = `${index % 2 ? 'player' : 'bot'}_unrelated_review_${index}`;
                const session = { accountId, fetchAccountId() { return this.accountId; }, dataSendToMe() {} };
                session.actor = new ActorModel({ id: 8000000 + index, username: accountId, isOnline: false, ...LOC });
                session.actor.session = session;
                World.insertUser(session);
                session.actor.setIsOnline(true);
                sessions.push(session);
            }
            const oldSessions = World.user.sessions;
            const oldAllStates = LifeState.allStates;
            World.user.sessions = new Proxy(oldSessions, { get(target, key) {
                if (['find', 'filter', 'forEach', 'includes', Symbol.iterator].includes(key)) {
                    throw new Error('unrelated World sessions scan');
                }
                return Reflect.get(target, key);
            } });
            LifeState.allStates = () => { throw new Error('all bot states scan'); };
            try {
                Counters.deal(STEM, 200, 1, Date.now(), 12345, 'Giran', 12346);
                await cooperativeTurns();
                assert.strictEqual((await Database.fetchAfkTradeShops(trader.id))[0].lines[0].pricing.seenCounter,
                    Counters.counter(Counters.counterOf(STEM)).deals);
            } finally {
                World.user.sessions = oldSessions;
                LifeState.allStates = oldAllStates;
            }
        });
    } finally {
        HotReview.stop();
        AfkTrade._resetForTests();
        Dispatcher.resetForTest();
        for (const session of sessions) World.removeUser(session);
        await Database.close();
        Config.knowledgeErrorsEnabled = previous.knowledge;
        options.default.Database.path = previous.databasePath;
        fs.rmSync(directory, { recursive: true, force: true });
    }
    if (failures.length) process.exitCode = 1;
    else console.log('Hot board review native tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
