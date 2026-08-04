const assert = require('assert');

require('../src/Global');

const BotSupplyErrand = invoke('GameServer/Bot/AI/BotSupplyErrand');
const BotTownTravel = invoke('GameServer/Bot/AI/BotTownTravel');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const ShoppingState = invoke('GameServer/Bot/AI/States/ShoppingState');
const FollowingState = invoke('GameServer/Bot/AI/States/FollowingState');
const BotSupplyErrandModule = invoke('GameServer/Bot/AI/BotSupplyErrand');
const TradeService = invoke('GameServer/Bot/TradeService');
const DataCache = invoke('GameServer/DataCache');
const BotTradeService = invoke('GameServer/Bot/BotTradeService');
const BotRoles = invoke('GameServer/Bot/AI/BotRoles');
const BotPartyChat = invoke('GameServer/Bot/AI/BotPartyChat');
const BotAgentTools = invoke('GameServer/Bot/AI/BotAgentTools');

function item(id, selfId, amount, name = 'Soulshot: D-grade') {
    let count = amount;
    return {
        fetchId: () => id,
        fetchSelfId: () => selfId,
        fetchAmount: () => count,
        setAmount: (value) => { count = value; },
        fetchName: () => name
    };
}

async function main() {
    const originals = {
        bestSupplyOffer: MarketOpportunity.bestSupplyOffer,
        request: BotTownTravel.request,
        purchase: BotSupplyErrandModule.purchaseAtDestination,
        tradePurchase: TradeService.buyFromStore,
        scheduleReturn: ShoppingState.scheduleResourceReturn,
        trade: BotTradeService.startBotTradeWithOffer,
        inferRole: BotRoles.inferRole,
        announce: BotPartyChat.announce
    };
    const adena = item(10, 57, 100000, 'Adena');
    const shots = item(11, 1463, 991);
    const bySelfId = new Map([[57, adena], [1463, shots]]);
    const player = {
        accountId: 'player',
        actor: {
            fetchId: () => 100,
            fetchName: () => 'Slava',
            fetchIsOnline: () => true,
            fetchLocX: () => 0,
            fetchLocY: () => 0,
            fetchLocZ: () => 0
        }
    };
    const bot = {
        fetchId: () => 1,
        fetchName: () => 'Caelan',
        fetchIsOnline: () => true,
        fetchLocX: () => 0,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        unselect() {},
        setLocXYZ() {},
        dataSendToOthers() {},
        moveTo() {},
        backpack: { fetchItemFromSelfId: (selfId) => bySelfId.get(Number(selfId)) },
        automation: { abortAll() {} },
        state: { fetchTowards: () => false }
    };
    const session = { accountId: 'bot_1', actor: bot, partyCompanion: true, followPlayerSession: player };
    const originalItems = DataCache.items;
    try {
        DataCache.items = [{ selfId: 1463, template: { name: 'Soulshot: D-grade' }, etc: { stackable: true } }];
        assert.strictEqual(MarketOpportunity.resolveSupplyItem('Soulshots D grade').selfId, 1463);
        assert.strictEqual(MarketOpportunity.normalizeItemLookup('D-grade soulshots'), 'soulshot_d_grade');
        assert.strictEqual(MarketOpportunity.normalizeItemLookup('No-grade soulshots'), 'soulshot_no_grade');
        MarketOpportunity.bestSupplyOffer = () => ({
            sourceType: 'npc', sourceId: 7004, sourceName: 'D-grade grocer', town: 'Talking Island',
            selfId: 1463, price: 17, itemName: 'Soulshot: D-grade', available: true
        });
        BotTownTravel.request = (_session, _bot, _ai, _reason, options) => {
            assert.strictEqual(options.allowCompanion, true);
            assert.strictEqual(options.forceScrollOfEscape, true);
            return 'walk';
        };
        const requested = BotSupplyErrand.request(session, player, 1463, 200);
        assert.strictEqual(requested.ok, true);
        assert.strictEqual(requested.amount, 200);
        assert.strictEqual(session.companionShopping.amount, 200);

        TradeService.buyFromStore = async (_actor, store, selfId, amount) => {
            assert.strictEqual(store.items[0].selfId, 1463);
            assert.strictEqual(selfId, 1463);
            assert.strictEqual(amount, 200);
            shots.setAmount(1191);
            return { qty: 200, totalAdena: 3400, name: 'Soulshot: D-grade' };
        };
        ShoppingState.scheduleResourceReturn = () => {};
        await ShoppingState.sellAndRestock(session, bot, null, { say() {} });
        assert.strictEqual(session.pendingResourceDelivery.amount, 200);
        assert.strictEqual(session.pendingResourceDelivery.objectId, 11);

        let offered = null;
        BotTradeService.startBotTradeWithOffer = (_session, _player, objectId, amount) => {
            offered = { objectId, amount };
            return { ok: true, line: { objectId, count: amount } };
        };
        BotRoles.inferRole = () => 'dps';
        BotPartyChat.announce = () => true;
        assert.strictEqual(FollowingState.deliverPurchasedResources(session, bot, player), true);
        assert.deepStrictEqual(offered, { objectId: 11, amount: 200 });
        assert.strictEqual(session.pendingResourceDelivery, undefined);

        // An errand request must not cancel an active fight just because the
        // player asked at the wrong moment.
        session.companionShopping = undefined;
        session.pendingResourceDelivery = undefined;
        session.currentTargetId = 777;
        bot.state.fetchHits = () => true;
        const duringFight = BotSupplyErrand.request(session, player, 1463, 1);
        assert.strictEqual(duringFight.reason, 'unsafe_combat_state');
        assert.strictEqual(session.currentTargetId, 777);
        bot.state.fetchHits = () => false;
        session.currentTargetId = undefined;

        // The player-facing rejection includes the amount to transfer, so a
        // failed affordability check is actionable rather than generic.
        const affordability = BotAgentTools.rejectionReply({
            reason: 'not_enough_adena',
            cost: 3400,
            adena: 100,
            itemName: 'Soulshot: D-grade'
        });
        assert(affordability.includes('3,400'));
        assert(affordability.includes('100'));
        assert(affordability.includes('Transfer Adena'));
    } finally {
        MarketOpportunity.bestSupplyOffer = originals.bestSupplyOffer;
        BotTownTravel.request = originals.request;
        BotSupplyErrandModule.purchaseAtDestination = originals.purchase;
        TradeService.buyFromStore = originals.tradePurchase;
        ShoppingState.scheduleResourceReturn = originals.scheduleReturn;
        BotTradeService.startBotTradeWithOffer = originals.trade;
        BotRoles.inferRole = originals.inferRole;
        BotPartyChat.announce = originals.announce;
        DataCache.items = originalItems;
    }
    console.log('LLM supply errand checks passed');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
