const DataCache = invoke('GameServer/DataCache');
const ServerResponse = invoke('GameServer/Network/Response');
const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');
const Limits = require('../../Inventory/InventoryLimits');

function purchaseItems(session, items, purchaseOptions = {}) {
    const actor = session.actor;
    const backpack = actor.backpack;
    const stacks = new Set();
    let slots = 0;
    for (const item of backpack.fetchItems()) {
        if (item.fetchStackable()) stacks.add(Number(item.fetchSelfId()));
        slots += item.fetchStackable() ? 1 : item.fetchAmount();
    }
    // Validate the complete basket before charging. Splitting equipment into
    // physical copies must never turn a client count into unbounded DB work.
    for (const item of items) {
        const template = ItemTemplateIndex.find(DataCache.items, item.selfId);
        if (!template || !Number.isSafeInteger(item.amount) || item.amount < 1 || item.amount > 0x7fffffff) {
            session.dataSendToMe(ServerResponse.actionFailed());
            return false;
        }
        if ((template.etc?.stackable ?? template.stackable) === true) {
            slots += Number(!stacks.has(Number(item.selfId)));
            stacks.add(Number(item.selfId));
        } else slots += item.amount;
        if (slots > Limits.forActor(actor)) {
            session.dataSendToMe(ServerResponse.actionFailed());
            return false;
        }
    }
    // 1. Calculate total cost
    let totalCost = 0;
    if (!purchaseOptions.free) {
        for (const item of items) {
            let price = 0;
            if (purchaseOptions.prices && purchaseOptions.prices.has(item.selfId)) {
                price = purchaseOptions.prices.get(item.selfId);
            } else {
                DataCache.fetchItemFromSelfId(item.selfId, (itemDetails) => {
                    price = itemDetails.template.price ?? 0;
                });
            }
            totalCost += price * item.amount;
        }
    }

    const totalAdena = backpack.fetchTotalAdena();

    if (totalCost > 0 && totalAdena < totalCost) {
        session.dataSendToMe(ServerResponse.speak(actor, { kind: 0, text: `You do not have enough Adena. Required: ${totalCost}, available: ${totalAdena}` }));
        return;
    }

    // Deduct Adena if needed
    if (totalCost > 0) {
        const adenaItem = backpack.fetchItemFromSelfId(57);
        if (adenaItem) {
            backpack.deleteItem(session, adenaItem.fetchId(), totalCost, () => {
                let timer = 0;
                items.forEach((item) => {
                    setTimeout(() => {
                        this.purchaseItem(session, item.selfId, item.amount);
                    }, timer += 100);
                });
            });
        } else {
            session.dataSendToMe(ServerResponse.speak(actor, { kind: 0, text: "You do not have any Adena." }));
        }
    } else {
        // Free / Admin / 0 cost purchase
        let timer = 0;
        items.forEach((item) => {
            setTimeout(() => {
                this.purchaseItem(session, item.selfId, item.amount);
            }, timer += 100);
        });
    }
}

module.exports = purchaseItems;
