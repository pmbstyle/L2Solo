'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
require('../src/Global');
const Data = invoke('GameServer/DataCache');
const Database = invoke('Database');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Meetings = require('../src/GameServer/AfkTrade/TradeMeetingService');
const Shopping = invoke('GameServer/Bot/AI/States/ShoppingState');
const Trade = invoke('GameServer/Bot/TradeService');
const Upgrades = invoke('GameServer/Bot/AI/BotEquipmentUpgrade');
const Training = invoke('GameServer/Bot/BotSkillTraining');
Data.init();
const restores = [];
const stub = (object, key, value) => { const old = object[key]; object[key] = value; restores.push(() => { object[key] = old; }); };
// The visit's NPC sale of its leftovers (the general sell-junk), counted.
const sellJunkFile = require.resolve('../src/GameServer/World/Generics/NpcBypasses/SellJunk');
require(sellJunkFile);
const sellJunk = require.cache[sellJunkFile];
const sellJunkHandler = sellJunk.exports;
let npcSales = 0;
sellJunk.exports = () => { npcSales++; };
let serial = 0, requests = 0, restocks = 0, upgrades = 0, terminal = 'completed';
const tick = () => new Promise(resolve => setImmediate(resolve));
const bot = { fetchId: () => 920051, fetchName: () => 'PendingShopper', fetchClassId: () => 0,
    fetchLevel: () => 14, fetchLocX: () => 83396, fetchLocY: () => 147904, fetchLocZ: () => -3400,
    isDead: () => false, backpack: { fetchItems: () => [], fetchItemFromSelfId: () => null } };
let current;
const session = { actor: bot, accountId: 'bot_pending_shopper', partyCompanion: true, plan: 'shopping' };
const ai = { say() {}, getClosestTown: () => ({ name: 'Giran', x: 83396, y: 147904, z: -3400 }) };
const point = { locX: 83396, locY: 147904, locZ: -3400 };
function stage() {
    const token = `hot-shopping-${++serial}`;
    Meetings.stage({ token, actorA: bot.fetchId(), actorB: 920052, seqA: 1, seqB: 1, town: 'Giran', point,
        lines: [{ payer: 0, itemId: 123, selfId: 1, count: 1, price: 500 }],
        parties: [0, 1].map(() => ({ revision: 0, sequence: 1, needRevision: 0, phase: 'hot',
            ownerId: 'legacy_main', leaseId: null, hotAt: 1,
            route: { fee: 0, scroll: false, method: 'walk', durationMs: 0 } })) });
    return token;
}
function visit(selling = false) {
    session.actor = bot; session.plan = 'shopping'; session.shopTimer = ++serial;
    session.shoppingDoneAnnounced = true; session.lastTradeSummary = null;
    session.shoppingRestock = undefined; session.nearRaise = null;
    const target = { recordId: 123, name: selling ? 'Buyer' : 'Seller', town: 'Giran', ...point };
    session.shoppingTarget = target;
    session.companionShopping = selling ? undefined : { kind: 'market_purchase', itemId: 1,
        itemName: 'Short Sword', amount: 1, price: 500, lineId: 77, purchaseCount: 12,
        sourceType: 'afk_bot_store', target };
    session.coldLifeState = current = { characterId: bot.fetchId(), phase: 'hot', activity: 'shopping',
        stats: {}, inventory: {}, loc: point };
    const store = { afkTrade: true, conditional: true, shopId: 123, ownerId: 920052,
        storeType: selling ? 3 : 1, items: [{ selfId: selling ? 1867 : 1, name: selling ? 'Animal Skin' : 'Short Sword',
            count: 10, price: 500, afkTradeLineId: 77 }] };
    Afk.recordStore = () => store;
}

const deadline = setTimeout(() => { throw Error('pending shopping continuation timed out'); }, 10000);
(async () => {
    try {
        stub(Afk, 'recordStore', () => null);
        stub(Afk, 'ownerRecords', () => []);
        stub(Afk, 'buyFromShop', async () => { requests++; return { pending: true, token: activeToken }; });
        stub(Afk, 'sellToShop', async () => { requests++; return { pending: true, token: activeToken }; });
        stub(Trade, 'sellableActorItems', () => [{ fetchId: () => 123, fetchSelfId: () => 1867, fetchAmount: () => 2 }]);
        stub(Life, 'cachedState', id => Number(id) === bot.fetchId() ? current : null);
        stub(Life, 'hotRow', id => Number(id) === bot.fetchId() ? current : null);
        stub(Life, 'acceptLifecycleRow', () => {
            // Adopting the committed row can invalidate its original staged
            // preparation before accepted() has finished presenting the result.
            Meetings.discard(activeToken);
            return current;
        });
        stub(Upgrades, 'applyBestUpgrades', () => { upgrades++; });
        stub(Training, 'review', async () => {});
        stub(Shopping, 'scheduleRestock', () => { restocks++; });
        stub(Database, 'acceptTradeMeeting', async request => ({ pending: false,
            coldLifeRows: { [bot.fetchId()]: {} },
            meeting: { id: serial, token: request.token, actorA: request.actorA, actorB: request.actorB,
                revision: 1, state: terminal, ...point } }));
        stub(Database, 'fetchTradeMeeting', async () => durableMeeting);
        stub(Database, 'fetchAfkTradeShops', async () => []);
        stub(Database, 'acknowledgeTradeMeeting', async () => {});
        stub(Database, 'fetchTradeMeetingsForOwner', async () => [durableMeeting]);
        stub(Database, 'cancelTradeMeeting', async () => {
            durableMeeting = { ...durableMeeting, state: 'cancelled' };
            return { meeting: durableMeeting };
        });
        stub(Database, 'arriveTradeMeeting', async () => {
            await new Promise(resolve => { releaseArrival = resolve; });
            if (durableMeeting.state === 'accepted') durableMeeting = { ...durableMeeting, state: 'completed' };
            return { meeting: durableMeeting };
        });
        stub(Database, 'fetchTradeMeetingByToken', async () => null);
        stub(Database, 'fetchTradeMeetingReceipt', async token => token === 'already-completed'
            ? { pending: false, meetingId: 999, outcome: 'completed' } : null);
        let durableMeeting, releaseArrival;
        let activeToken;
        for (const selling of [false, true]) for (const outcome of ['completed', 'cancelled', 'discarded']) {
            visit(selling); terminal = outcome;
            activeToken = stage();
            const before = { requests, restocks, upgrades, npcSales };
            const work = Shopping.sellAndRestock(session, bot, null, ai);
            await tick();
            assert(session.pendingShoppingMeeting, 'a pending exchange retains its shopping continuation');
            Shopping.tick(session, bot, null, ai);
            assert.equal(requests, before.requests + 1, 'waiting ticks cannot submit another trade');
            assert.equal(restocks, before.restocks, 'no restock before the native outcome');
            if (outcome === 'discarded') Meetings.discard(activeToken);
            else await Meetings.accept(activeToken, bot.fetchId());
            await work;
            assert.equal(session.pendingShoppingMeeting, undefined, 'terminal outcome releases the continuation');
            assert.equal(restocks, before.restocks + 1, 'completion and cancellation both continue the visit');
            if (!selling) {
                assert.equal(upgrades, before.upgrades + Number(outcome === 'completed'), 'only committed purchases equip gear');
                assert.match(session.lastTradeSummary, outcome === 'completed' ? /^bought 1x/ : /^could not buy/);
            } else if (outcome === 'completed') {
                assert.match(session.lastTradeSummary, /^sold 2 to Buyer for 1,000a$/);
                assert.equal(npcSales, before.npcSales + 1, 'leftovers are cleaned after committed delivery');
            }
        }
        // The usual lifecycle has a durable accepted meeting between the
        // preparation and terminal publication, rather than completing at acceptance.
        Database.acceptTradeMeeting = async request => {
            durableMeeting = { id: ++serial, token: request.token, actorA: request.actorA, actorB: request.actorB,
                revision: 1, state: 'accepted', ...point };
            return { pending: true, meeting: durableMeeting };
        };
        for (const cancelled of [false, true]) {
            visit(); activeToken = stage(); releaseArrival = undefined;
            const travellingWork = Shopping.sellAndRestock(session, bot, null, ai);
            await tick();
            const before = { restocks, upgrades };
            await Meetings.accept(activeToken, bot.fetchId());
            for (let n = 0; n < 20 && !releaseArrival; n++) await tick();
            assert(releaseArrival, 'the accepted meeting reaches its native arrival handler');
            assert.equal(restocks, before.restocks, 'durable acceptance alone cannot resume shopping');
            if (cancelled) await Meetings.cancel(bot.fetchId());
            releaseArrival(); await travellingWork;
            assert.equal(restocks, before.restocks + 1, 'completion or cancellation resumes the accepted visit');
            assert.equal(upgrades, before.upgrades + Number(!cancelled), 'cancelled meetings cannot equip a purchase');
        }
        Database.acceptTradeMeeting = async request => ({ pending: false,
            meeting: { id: ++serial, token: request.token, actorA: request.actorA, actorB: request.actorB,
                revision: 1, state: terminal, ...point } });
        visit(); activeToken = stage();
        const staleWork = Shopping.sellAndRestock(session, bot, null, ai);
        await tick();
        const before = { restocks, upgrades };
        session.actor = { ...bot };
        terminal = 'completed'; await Meetings.accept(activeToken, bot.fetchId()); await staleWork;
        assert.deepEqual({ restocks, upgrades }, before, 'a replaced actor cannot resume the old visit');
        visit(); activeToken = stage();
        const stoppedWork = Shopping.sellAndRestock(session, bot, null, ai);
        await tick(); session.pendingShoppingMeeting.controller.abort(); await stoppedWork;
        assert.equal(session.pendingShoppingMeeting, undefined, 'AI shutdown releases its result listener');
        Meetings.discard(activeToken);
        assert.equal((await Meetings.waitForResult('already-completed', bot.fetchId())).outcome, 'completed',
            'a terminal receipt remains observable when completion precedes listener registration');
        assert.equal(await Meetings.waitForResult('missing', bot.fetchId()), null,
            'a removed preparation cannot leave a result listener waiting forever');
        let receiptReads = 0;
        Database.fetchTradeMeetingByToken = async () => {
            if (++receiptReads === 1) throw Error('temporary receipt read failure');
            return null;
        };
        assert.equal((await Meetings.waitForResult('already-completed', bot.fetchId())).outcome, 'completed');
        assert.equal(receiptReads, 2, 'a transient read error cannot be mistaken for a cancelled exchange');
        // A refused buy gets the cold buyer's verdict (test_bot_cold_market_purchase, same codes): a
        // seller's or a money refusal marks its quote, a meeting's marks nothing, none is a
        // failure; a broken invariant marks nothing and is counted. A live store's line changed is
        // the seller's refusal as a bot store's is.
        const FailureLog = invoke('FailureLog'), Marks = invoke('GameServer/Bot/AI/GearMarks');
        const failures = () => Number(FailureLog.snapshot()?.['economy.hot_board_buy'] || 0);
        const refusedBuy = async (thrown, liveStore = false) => {
            visit();
            if (liveStore) {
                const store = { storeType: 1, kind: 'player', ownerId: 920052, items: [{ selfId: 1, count: 10, price: 500 }] };
                Afk.recordStore = () => store;
            }
            Afk.buyFromShop = Trade.buyFromStore = async () => { throw Error(thrown); };
            const before = failures();
            await Shopping.sellAndRestock(session, bot, null, ai);
            return { counted: failures() - before, quotes: Marks.quotes(session.coldLifeState.stats) };
        };
        stub(Trade, 'buyFromStore', Trade.buyFromStore);
        assert.deepEqual(await refusedBuy('trade_meeting_integer'), { counted: 1, quotes: [] }, 'a broken meeting invariant is counted');
        assert.deepEqual(await refusedBuy('trade_meeting_party_busy'), { counted: 0, quotes: [] }, 'a busy party is the meeting\'s refusal');
        assert.deepEqual(await refusedBuy('not_enough_adena'), { counted: 0, quotes: [[1, 'Giran', 500]] },
            'a writer\'s money refusal marks its quote');
        assert.deepEqual(await refusedBuy('afk_trade_stock_changed'), { counted: 0, quotes: [[1, 'Giran', 500]] },
            'a line the seller changed marks its quote');
        assert.deepEqual(await refusedBuy('private_store_changed', true), { counted: 0, quotes: [[1, 'Giran', 500]] },
            'a live store\'s changed line marks its quote');
        console.log('PASS hot shopping: pending buy/sell, native completion/cancellation, discarded preparation, single trade, actor/AI interruption and refused-buy verdicts');
    } finally {
        clearTimeout(deadline);
        Meetings.reset(); sellJunk.exports = sellJunkHandler;
        for (const restore of restores.reverse()) restore();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
