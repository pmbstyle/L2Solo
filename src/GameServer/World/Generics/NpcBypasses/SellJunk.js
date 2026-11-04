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
    const selling = MarketListingPolicy.npcSaleCandidatesForActor(session);
    const sales = [];
    // The live policy already subtracts project/equipment reserves. Applying
    // those quantities again by bag order can exclude the selected free copy.
    const items = session.actor.backpack.items;
    const sold = new Map();
    for (const candidate of selling) {
        let left = Number(candidate.count || 0);
        const ids = candidate.objectIds ? new Set(candidate.objectIds.map(Number)) : null;
        for (const item of items) {
            if (left <= 0) break;
            if (Number(item.fetchSelfId()) !== Number(candidate.selfId)
                || Number(item.fetchEnchantLevel?.() || 0) !== Number(candidate.enchant || 0)
                || (ids && !ids.has(Number(item.fetchId())))
                || item.fetchEquipped() || !NpcSellRules.canSell(item)) continue;
            const amount = Math.min(item.fetchAmount() - Number(sold.get(item) || 0), left);
            if (amount <= 0) continue;
            sold.set(item, Number(sold.get(item) || 0) + amount);
            left -= amount;
        }
    }
    for (const [item, amount] of sold) sales.push({ item, amount });
    return sales;
}

async function sellJunk(session) {
    const backpack = session.actor.backpack;
    const bot = String(session.accountId || '').startsWith('bot_');
    const sales = (bot ? await botSales(session) : playerSales(session))
        .filter((sale) => sale.amount > 0);

    if (sales.length === 0) {
        session.dataSendToMe(ServerResponse.speak(session.actor, { kind: 0, text: "You have no unequipped items to sell." }));
        return { count: 0, payout: 0 };
    }

    let totalAdenaPayout = 0;
    let soldDetails = [];

    // Every write is kept so that its failure reaches the handler's log below
    // instead of rejecting unhandled; the writes still start in the same order.
    const writes = [];
    const soldItemIds = new Set();
    sales.forEach(({ item, amount }) => {
        const price = item.fetchPrice();
        const sellPrice = NpcSellRules.npcBuyPrice(price);
        const payout = sellPrice * amount;
        
        totalAdenaPayout += payout;
        soldDetails.push(`${amount}x ${item.fetchName()} (+${payout} Adena)`);
        
        const left = item.fetchAmount() - amount;
        if (left > 0) {
            writes.push(Database.updateItemAmount(session.actor.fetchId(), item.fetchId(), left));
            item.setAmount(left);
            return;
        }
        writes.push(Database.deleteItem(session.actor.fetchId(), item.fetchId()));
        soldItemIds.add(Number(item.fetchId()));
    });

    backpack.items = backpack.items.filter((item) => !soldItemIds.has(Number(item.fetchId())));

    const announceSale = () => {
        session.dataSendToMe(ServerResponse.itemsList(backpack.fetchItems()));
        session.dataSendToMe(ServerResponse.userInfo(session.actor));
        session.dataSendToMe(ServerResponse.speak(session.actor, { kind: 0, text: `Sold: ${soldDetails.join(', ')}` }));
        session.dataSendToMe(ServerResponse.speak(session.actor, { kind: 0, text: `Successfully sold ${sales.length} items. Gained +${totalAdenaPayout} Adena!` }));
    };

    // An existing Adena stack is updated; only a missing one gets a new stack
    // (a failed update must not fall through to a second, new stack).
    writes.push(backpack.stackableExists(57).then((adenaItem) => {
        const total = adenaItem.fetchAmount() + totalAdenaPayout;
        return Database.updateItemAmount(session.actor.fetchId(), adenaItem.fetchId(), total).then(() => {
            adenaItem.setAmount(total);
            announceSale();
        });
    }, () => {
        return Database.setItem(session.actor.fetchId(), {
            selfId: 57,
            name: "Adena",
            amount: totalAdenaPayout,
            equipped: false,
            slot: 0
        }).then((packet) => {
            backpack.insertItem(Number(packet.insertId), 57, { amount: totalAdenaPayout });
            announceSale();
        });
    }));

    await Promise.all(writes);
    return { count: sales.reduce((sum, sale) => sum + sale.amount, 0), payout: totalAdenaPayout };
}

// The NPC dialog does not await its handlers: a failure is logged here. A
// bot's town visit awaits `sell` itself: { count, payout } or a rejection.
module.exports = function(session) {
    return sellJunk(session).catch((error) => {
        utils.infoWarn('SellJunk', 'junk sale failed for %s: %s', session?.actor?.fetchName?.() || 'unknown', error?.message || String(error));
    });
};
module.exports.sell = sellJunk;
