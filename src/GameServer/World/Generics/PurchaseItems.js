const DataCache = invoke('GameServer/DataCache');
const ServerResponse = invoke('GameServer/Network/Response');

function purchaseItems(session, items, purchaseOptions = {}) {
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

    const actor = session.actor;
    const backpack = actor.backpack;
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
