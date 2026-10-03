const ServerResponse = invoke('GameServer/Network/Response');
const Database       = invoke('Database');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const ShotStock = invoke('GameServer/Inventory/ShotStock');
const NpcSellRules = invoke('GameServer/Items/NpcSellRules');
const BotWarehouse = invoke('GameServer/Bot/Economy/BotWarehouseService');
const MarketListingPolicy = invoke('GameServer/Bot/Economy/MarketListingPolicy');

// The player's "sell unequipped junk": everything unequipped the NPC buys,
// except shots and what a pending warehouse visit will store.
function playerSales(session) {
    const items = session.actor.backpack.items;
    const protectPendingWarehouseItems = session.plan === 'shopping'
        && session.shoppingWarehouseDone !== true;
    return ItemDisposition.unreservedActorItems(session.coldLifeState, items)
        .filter(item => NpcSellRules.canSell(item)
            && !ShotStock.SHOT_IDS.includes(Number(item.fetchSelfId()))
            && (!protectPendingWarehouseItems || !ItemDisposition.isWarehouseCandidate(item)))
        .map((item) => ({ item, amount: item.fetchAmount() }));
}

// A bot sells what the cold visit would sell to the NPC (one rule for hot and
// cold bots, MarketListingPolicy.npcSaleForActor). Recipes it can learn are
// learned first, as on the cold path.
async function botSales(session) {
    await BotWarehouse.learnActorRecipes(session.actor, session.coldLifeState, session);
    const selling = MarketListingPolicy.npcSaleForActor(session);
    const sales = [];
    for (const item of ItemDisposition.unreservedActorItems(session.coldLifeState, session.actor.backpack.items)) {
        const selfId = Number(item.fetchSelfId());
        const left = Number(selling.get(selfId) || 0);
        if (left <= 0 || item.fetchEquipped() || !NpcSellRules.canSell(item)) continue;
        const amount = Math.min(item.fetchAmount(), left);
        selling.set(selfId, left - amount);
        sales.push({ item, amount });
    }
    return sales;
}

async function sellJunk(session) {
    const backpack = session.actor.backpack;
    const bot = String(session.accountId || '').startsWith('bot_');
    const sales = (bot ? await botSales(session) : playerSales(session))
        .filter((sale) => sale.amount > 0);

    if (sales.length === 0) {
        session.dataSendToMe(ServerResponse.speak(session.actor, { kind: 0, text: "You have no unequipped items to sell." }));
        return;
    }

    let totalAdenaPayout = 0;
    let soldDetails = [];

    const soldItemIds = new Set();
    sales.forEach(({ item, amount }) => {
        const price = item.fetchPrice();
        const sellPrice = Math.max(1, Math.floor(price * 0.5));
        const payout = sellPrice * amount;
        
        totalAdenaPayout += payout;
        soldDetails.push(`${amount}x ${item.fetchName()} (+${payout} Adena)`);
        
        const left = item.fetchAmount() - amount;
        if (left > 0) {
            Database.updateItemAmount(session.actor.fetchId(), item.fetchId(), left);
            item.setAmount(left);
            return;
        }
        Database.deleteItem(session.actor.fetchId(), item.fetchId());
        soldItemIds.add(Number(item.fetchId()));
    });

    backpack.items = backpack.items.filter((item) => !soldItemIds.has(Number(item.fetchId())));

    backpack.stackableExists(57).then((adenaItem) => {
        const total = adenaItem.fetchAmount() + totalAdenaPayout;
        Database.updateItemAmount(session.actor.fetchId(), adenaItem.fetchId(), total).then(() => {
            adenaItem.setAmount(total);
            session.dataSendToMe(ServerResponse.itemsList(backpack.fetchItems()));
            session.dataSendToMe(ServerResponse.userInfo(session.actor));
            
            session.dataSendToMe(ServerResponse.speak(session.actor, { kind: 0, text: `Sold: ${soldDetails.join(', ')}` }));
            session.dataSendToMe(ServerResponse.speak(session.actor, { kind: 0, text: `Successfully sold ${sales.length} items. Gained +${totalAdenaPayout} Adena!` }));
        });
    }).catch(() => {
        Database.setItem(session.actor.fetchId(), {
            selfId: 57,
            name: "Adena",
            amount: totalAdenaPayout,
            equipped: false,
            slot: 0
        }).then((packet) => {
            backpack.insertItem(Number(packet.insertId), 57, { amount: totalAdenaPayout });
            session.dataSendToMe(ServerResponse.itemsList(backpack.fetchItems()));
            session.dataSendToMe(ServerResponse.userInfo(session.actor));
            
            session.dataSendToMe(ServerResponse.speak(session.actor, { kind: 0, text: `Sold: ${soldDetails.join(', ')}` }));
            session.dataSendToMe(ServerResponse.speak(session.actor, { kind: 0, text: `Successfully sold ${sales.length} items. Gained +${totalAdenaPayout} Adena!` }));
        });
    });
}

// The NPC dialog does not await its handlers: a failure is logged here.
module.exports = function(session) {
    return sellJunk(session).catch((error) => {
        utils.infoWarn('SellJunk', 'junk sale failed for %s: %s', session?.actor?.fetchName?.() || 'unknown', error?.message || String(error));
    });
};
