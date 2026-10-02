const ServerResponse = invoke('GameServer/Network/Response');
const Database       = invoke('Database');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const ShotStock = invoke('GameServer/Inventory/ShotStock');
const NpcSellRules = invoke('GameServer/Items/NpcSellRules');
const HealingPotionStock = invoke('GameServer/Bot/AI/HealingPotionStock');

module.exports = function(session) {
    const backpack = session.actor.backpack;
    const items = backpack.items;
    const protectPendingWarehouseItems = session.plan === 'shopping'
        && session.shoppingWarehouseDone !== true;

    const bot = String(session.accountId || '').startsWith('bot_');
    const crafter = bot ? { classId: Number(session.actor.fetchClassId()), level: Number(session.actor.fetchLevel()) } : null;
    // A bot keeps the healing potions its restock would buy back right after
    // this sale (HealingPotionStock.restockPlan), and sells only the surplus.
    const potion = bot ? HealingPotionStock.purchasePotionFor(session.actor) : null;
    let potionsToKeep = potion ? HealingPotionStock.targetAmountFor(session.actor) : 0;

    const sales = ItemDisposition.unreservedActorItems(session.coldLifeState, items)
        .filter(item => NpcSellRules.canSell(item)
            && !ShotStock.SHOT_IDS.includes(Number(item.fetchSelfId()))
            && (!bot || !ItemDisposition.isKeptFromNpcJunk(item, crafter,
                (recipeId) => !!backpack.hasRecipe?.(session.actor, recipeId)))
            && (!protectPendingWarehouseItems || !ItemDisposition.isWarehouseCandidate(item)))
        .map((item) => {
            let amount = item.fetchAmount();
            if (potion && Number(item.fetchSelfId()) === potion.selfId) {
                const kept = Math.min(amount, potionsToKeep);
                potionsToKeep -= kept;
                amount -= kept;
            }
            return { item, amount };
        })
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
};
