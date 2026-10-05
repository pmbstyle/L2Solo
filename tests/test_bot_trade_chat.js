const assert = require('assert');
require('../src/Global');
const Chat = invoke('GameServer/Bot/Economy/BotTradeChat');
const Merchant = invoke('GameServer/Bot/AI/States/MerchantState');
const Voice = invoke('GameServer/Bot/AI/BotChatVoice');
const Identity = invoke('GameServer/Bot/AI/BotServiceIdentity');
const World = invoke('GameServer/World/World');
const Response = invoke('GameServer/Network/Response');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const Manager = invoke('GameServer/Bot/BotManager');
const DataCache = invoke('GameServer/DataCache');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const BuyerActivity = invoke('GameServer/Bot/Economy/MarketBuyerActivity');
const saved = { user: World.user, speak: Response.speak, cached: LifeState.cachedState,
    upsert: LifeState.upsertState, find: Manager.findSessionById, activeShops: AfkTrade.activeShops,
    now: Date.now, config: { ...Config } };
let now = 1000000;
const packets = [], leaked = [], states = new Map(), hot = new Map();
function player(sink, accountId = 'player', online = true) {
    return { accountId, socket: { write() {} }, actor: { fetchIsOnline: () => online }, dataSendToMe: packet => sink.push(packet) };
}
function cold(id = 101, type = 1) {
    const state = { characterId: id, name: `Wanderer${id}`, phase: 'cold', activity: 'merchant', adena: 5000000,
        currentRegion: 'Giran', stats: { marketStore: { id: `${id}:shop`, storeType: type, budgetBacked: type === 3,
            town: 'Giran', expiresAt: now + 3600000, items: [{ selfId: 1, name: 'Short Sword', count: 3, price: 500000 }] } } };
    states.set(id, state);
    return state;
}
function materialize(state) {
    const session = { plan: 'merchant', coldMarketState: state, actor: {
        fetchId: () => state.characterId, fetchName: () => state.name, fetchIsOnline: () => true, isDead: () => false,
        fetchPrivateStore: () => state.stats.marketStore, fetchPrivateStoreType: () => state.stats.marketStore?.storeType || 0,
        fetchAdena: () => state.adena
    } };
    hot.set(state.characterId, session);
    return session;
}
function reset() {
    Chat.reset(); Voice.reset(); packets.length = 0; leaked.length = 0; states.clear(); hot.clear(); now += 1000000;
    Config.marketTradeChatEnabled = true;
    AfkTrade.activeShops = () => [];
    BuyerActivity._resetForTests();
    World.user = { sessions: [player(packets), player(leaked, 'bot_test'), player(leaked, 'offline', false)] };
}
function afkShop(id, selfId = 1, type = 1, price = 72863) {
    return { ownerId: id, ownerName: `Trader${id}`, ownerAccount: `bot_${id}`,
        storeType: type, town: 'Giran', escrowAdena: type === 3 ? price * 2 : 0,
        lines: [{ selfId, name: selfId === 1 ? 'Short Sword' : 'Blue Wolf Stockings Pattern',
            count: 2, price }] };
}
async function main() {
    try {
        DataCache.init();
        Date.now = () => now;
        Response.speak = (actor, data) => ({ id: actor.fetchId(), name: actor.fetchName(), ...data });
        LifeState.cachedState = id => states.get(id);
        Manager.findSessionById = id => hot.get(id);
        for (const [input, expected] of [[500, '500 adena'], [999, '999 adena'], [1000, '1k'], [1500, '1.5k'],
            [500000, '500k'], [999999, '1kk'], [1500000, '1.5kk'], [1550000, '1.6kk'], [0, ''], [-1, ''], [NaN, '']]) {
            assert.strictEqual(Chat.price(input), expected);
        }
        reset();
        const seller = cold();
        assert(Chat.offer(seller, now).announced);
        assert.strictEqual(packets[0].kind, 8);
        assert(/WTS.*Short Sword - 500k each/.test(packets[0].text) && packets[0].text.includes('Giran'));
        assert.strictEqual(leaked.length, 0);
        Merchant.tick(materialize(seller));
        assert.strictEqual(packets.length, 1, 'materializing the same merchant must not repeat the cold opening ad');
        now += Config.marketTradeChatIntervalMs;
        Merchant.tick(hot.get(101));
        assert.strictEqual(packets.length, 2, 'a still-open merchant can advertise again after its cooldown');

        reset();
        const buyer = cold(102, 3);
        buyer.stats.marketStore.items[0].price = 1512345;
        assert(Chat.offer(materialize(buyer), now).announced);
        assert(/WTB.*~1.5kk each/.test(packets[0].text), 'rounded prices are marked approximate and refer to one item');
        const long = { ...buyer.stats.marketStore, items: [{ selfId: 1, name: 'A very long weapon name '.repeat(10), count: 1, price: 500 }] };
        const text = Chat.offerText(long, buyer);
        assert(text.length <= 120 && text.includes('500 adena each') && text.includes('Giran'), 'name shortening must preserve price and location');
        const unnamed = Chat.offerText({ ...long, items: [{ selfId: 1, name: 'Item 1', count: 1, price: 500 }] });
        assert(unnamed.includes('Short Sword') && !unnamed.includes('Item 1'), 'template names replace internal item placeholders');

        for (const invalidate of [
            s => { s.staticService = true; },
            s => { s.name = Identity.configuredMerchantNames()[0]; },
            s => { s.stats.marketStore.storeType = 5; },
            s => { s.stats.marketStore.items[0].count = 0; },
            s => { s.stats.marketStore.expiresAt = now; },
            s => { s.stats.marketStore.items[0].marketExpiresAt = now; },
            s => { s.stats.marketStore.repricing = true; },
            s => { s.activity = 'hunting'; },
            s => { s.stats.marketStore.storeType = 3; s.stats.marketStore.budgetBacked = false; },
            s => { s.stats.marketStore.storeType = 3; s.stats.marketStore.budgetBacked = true; s.adena = 1; }
        ]) {
            reset(); const state = cold(); invalidate(state);
            assert(!Chat.offer(state, now).announced);
            assert.strictEqual(packets.length, 0, 'invalid, unfunded, closed and static stores stay silent');
        }
        for (const invalidate of [
            s => { s.coldMarketState = null; },
            s => { s.actor.fetchPrivateStoreType = () => 0; },
            s => { s.actor.fetchIsOnline = () => false; },
            s => { s.actor.isDead = () => true; },
            s => { s.merchantStoreMutation = true; }
        ]) {
            reset(); const session = materialize(cold()); invalidate(session); Merchant.tick(session);
            assert.strictEqual(packets.length, 0, 'hot merchant ticks must respect store visibility and service identity');
        }

        reset(); Chat.offer(cold(), now);
        const queued = cold(102);
        assert(!Chat.offer(queued, now).announced);
        assert.strictEqual(Chat.snapshot().pending, 1);
        const updated = structuredClone(queued);
        updated.stats.marketStore.items[0].price = 1500000;
        states.set(102, updated);
        now += Config.marketTradeChatGlobalMinIntervalMs;
        Chat.flush(now);
        assert.strictEqual(packets.length, 2);
        assert(packets[1].text.includes('1.5kk'), 'queued advertisements must read the latest store price');

        for (const change of ['sold', 'closed', 'replaced', 'expired', 'hot']) {
            reset(); Chat.offer(cold(), now);
            const state = cold(102); Chat.offer(state, now);
            if (change === 'hot') { materialize(state); states.set(102, { ...state, phase: 'hot' }); }
            if (change === 'sold') state.stats.marketStore.items[0].count = 0;
            if (change === 'closed') state.activity = 'shopping';
            if (change === 'replaced') state.stats.marketStore.id = 'different-shop';
            now += change === 'expired' ? Chat.PENDING_TTL_MS : Config.marketTradeChatGlobalMinIntervalMs;
            Chat.flush(now);
            assert.strictEqual(packets.length, change === 'hot' ? 2 : 1, `queued ${change} store handling`);
            assert.strictEqual(Chat.snapshot().pending, 0);
        }
        reset(); Chat.offer(cold(), now);
        for (let i = 0; i < 100; i++) Chat.offer(cold(200 + i), now);
        assert.strictEqual(Chat.snapshot().pending, Chat.MAX_PENDING, 'a burst of shops cannot grow an unbounded queue');
        Config.marketTradeChatEnabled = false; now += 1000; Chat.flush(now);
        assert.strictEqual(Chat.snapshot().pending, 0);
        assert(!Chat.offer(cold(999), now).announced);
        reset(); World.user.sessions = [];
        assert(!Chat.offer(cold(), now).announced);
        assert.strictEqual(Chat.snapshot().pending, 0, 'no backlog is collected without real players');

        reset();
        assert.strictEqual(Config.marketTradeChatGlobalMinIntervalMs, 100000,
            'one shared slot per 100 seconds caps all bot trade ads at 36 per hour');
        const expensive = afkShop(701, 1, 1, 90000);
        const bestAsk = afkShop(702);
        AfkTrade.activeShops = () => [expensive, bestAsk];
        Chat.flush(now);
        assert.strictEqual(packets.length, 1);
        assert.strictEqual(packets[0].id, 702, 'a competitive offer should win the chat slot');
        assert(packets[0].text.includes('72,863 Adena ea, Giran. PM me.'),
            'the AFK ad should give the exact live price and a direct reply path');
        now += Config.marketTradeChatGlobalMinIntervalMs;
        Chat.flush(now);
        assert.strictEqual(packets.length, 1, 'another seller must not repeat the same item immediately');
        const fundedBid = afkShop(703, 2, 3, 51000);
        AfkTrade.activeShops = () => [bestAsk, fundedBid];
        now += 30000;
        Chat.flush(now);
        assert.strictEqual(packets[1].id, 703);
        assert(packets[1].text.startsWith('WTB '), 'funded AFK buy orders also reach trade chat');
        reset();
        const playerBargain = { ...afkShop(799, 1, 1, 50000), ownerAccount: 'player' };
        AfkTrade.activeShops = () => [bestAsk, playerBargain];
        Chat.flush(now);
        assert.strictEqual(packets.length, 0,
            'a bot should not claim the trade slot when a player lists the same item cheaper');
        fundedBid.escrowAdena = 0;
        reset(); AfkTrade.activeShops = () => [fundedBid];
        Chat.flush(now);
        assert.strictEqual(packets.length, 0, 'an unfunded AFK buy order must stay silent');
        reset(); AfkTrade.activeShops = () => [afkShop(706, 1, 1, 5)];
        Chat.flush(now);
        assert.strictEqual(packets.length, 0, 'a tiny cheap listing must not consume a trade chat slot');

        reset();
        const scarce = afkShop(704, 2);
        AfkTrade.activeShops = () => [scarce];
        Chat.offer(cold(705), now);
        assert.strictEqual(packets[0].id, 704);
        assert.strictEqual(Chat.snapshot().pending, 1);
        now += Config.marketTradeChatGlobalMinIntervalMs;
        Chat.flush(now);
        assert.strictEqual(packets[1].id, 705,
            'ordinary merchants and AFK shops must share the same budget without starving one another');
        assert.strictEqual(packets.length, 2);

        reset();
        AfkTrade.activeShops = () => [afkShop(801, 1), afkShop(802, 2),
            afkShop(803, 3), afkShop(804, 4, 3)];
        for (let index = 0; index < 3; index++) {
            Chat.flush(now);
            now += Config.marketTradeChatGlobalMinIntervalMs;
        }
        assert.deepStrictEqual(packets.map(packet => packet.kind === 8 && packet.text.slice(0, 3)),
            ['WTS', 'WTS', 'WTB'], 'funded bids should receive roughly one in three AFK ad slots');

        reset();
        const saturated = Array.from({ length: 5 }, (_, index) => afkShop(710 + index));
        let scans = 0;
        AfkTrade.activeShops = () => { scans += 1; return saturated; };
        World.user.sessions = [];
        Chat.flush(now);
        assert.strictEqual(scans, 0, 'market selection must not run without a real player audience');
        World.user.sessions = [player(packets)];
        now += 1000; Chat.flush(now);
        assert.strictEqual(packets.length, 0, 'saturated supply without buyer activity needs no advertisement');
        now += 1000; Chat.flush(now);
        assert.strictEqual(scans, 1, 'an empty selection must not rescan all shops on every tick');
        console.log('Bot trade chat checks passed');
    } finally {
        World.user = saved.user; Response.speak = saved.speak; LifeState.cachedState = saved.cached;
        LifeState.upsertState = saved.upsert; Manager.findSessionById = saved.find;
        AfkTrade.activeShops = saved.activeShops;
        Date.now = saved.now; Object.assign(Config, saved.config); Chat.reset(); Voice.reset();
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
