const assert = require('assert');

require('../src/Global');

const BotSupplyErrand = invoke('GameServer/Bot/AI/BotSupplyErrand');
const BotTownTravel = invoke('GameServer/Bot/AI/BotTownTravel');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const ShoppingState = invoke('GameServer/Bot/AI/States/ShoppingState');
const FollowingState = invoke('GameServer/Bot/AI/States/FollowingState');
const ShotStock = invoke('GameServer/Inventory/ShotStock');
const BotTradeService = invoke('GameServer/Bot/BotTradeService');
const BotRoles = invoke('GameServer/Bot/AI/BotRoles');
const BotPartyChat = invoke('GameServer/Bot/AI/BotPartyChat');

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
        npcOffers: MarketOpportunity.npcOffers,
        request: BotTownTravel.request,
        purchase: ShotStock.purchaseActorRestock,
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
        moveTo() {},
        backpack: { fetchItemFromSelfId: (selfId) => bySelfId.get(Number(selfId)) },
        automation: { abortAll() {} },
        state: { fetchTowards: () => false }
    };
    const session = { accountId: 'bot_1', actor: bot, partyCompanion: true, followPlayerSession: player };
    try {
        MarketOpportunity.npcOffers = () => [{ price: 17, itemName: 'Soulshot: D-grade' }];
        BotTownTravel.request = (_session, _bot, _ai, _reason, options) => {
            assert.strictEqual(options.allowCompanion, true);
            return 'walk';
        };
        const requested = BotSupplyErrand.request(session, player, 1463, 200);
        assert.strictEqual(requested.ok, true);
        assert.strictEqual(requested.amount, 200);
        assert.strictEqual(session.companionShopping.amount, 200);

        ShotStock.purchaseActorRestock = async (_actor, options) => {
            assert.strictEqual(options.targetAmount, 1191, 'purchase target must add the requested amount to existing stock');
            shots.setAmount(options.targetAmount);
            return { ok: true, delta: 200, cost: 3400 };
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
    } finally {
        MarketOpportunity.npcOffers = originals.npcOffers;
        BotTownTravel.request = originals.request;
        ShotStock.purchaseActorRestock = originals.purchase;
        ShoppingState.scheduleResourceReturn = originals.scheduleReturn;
        BotTradeService.startBotTradeWithOffer = originals.trade;
        BotRoles.inferRole = originals.inferRole;
        BotPartyChat.announce = originals.announce;
    }
    console.log('LLM supply errand checks passed');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
