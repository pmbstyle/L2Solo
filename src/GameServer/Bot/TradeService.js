const DataCache = invoke('GameServer/DataCache');
const Database  = invoke('Database');
const BotEconomyPricing = invoke('GameServer/Bot/Economy/BotEconomyPricing');

function itemTemplate(selfId) {
    return DataCache.items.find((ob) => ob.selfId === selfId);
}

function itemName(selfId) {
    return itemTemplate(selfId)?.template?.name ?? `Item ${selfId}`;
}

function itemBasePrice(selfId) {
    return itemTemplate(selfId)?.template?.price ?? 0;
}

function ratedPrice(selfId, rate, fallback = 1) {
    const base = itemBasePrice(selfId);
    const price = base > 0 ? base * rate : fallback;
    return BotEconomyPricing.scalePrice(price);
}

function storeLoc(actor) {
    return {
        locX: actor.fetchLocX(),
        locY: actor.fetchLocY(),
        locZ: actor.fetchLocZ()
    };
}

function distance2d(a, b) {
    const dx = a.locX - b.locX;
    const dy = a.locY - b.locY;
    return Math.sqrt(dx * dx + dy * dy);
}

function fetchAdena(actor) {
    return actor.backpack.fetchItemFromSelfId(57);
}

function isSellableInventoryItem(item) {
    return item && !item.fetchEquipped() && item.fetchSelfId() !== 57;
}

function normalizeStoreItems(storeCfg) {
    let fakeObjectIdSeq = 600000000 + utils.randomNumber(100000000);
    return storeCfg.items.map((item) => ({
        objectId: ++fakeObjectIdSeq,
        selfId: item.selfId,
        price: item.price ?? ratedPrice(item.selfId, item.priceRate ?? 1),
        count: item.count ?? 1
    }));
}

function describeStoreItems(items, limit = 3) {
    return items
        .slice(0, limit)
        .map((item) => itemName(item.selfId))
        .join(', ');
}

function deductAdena(actor, amount) {
    return new Promise((resolve, reject) => {
        const adenaItem = fetchAdena(actor);
        if (!adenaItem || adenaItem.fetchAmount() < amount) {
            return reject("Not enough Adena.");
        }

        const total = adenaItem.fetchAmount() - amount;
        if (total > 0) {
            Database.updateItemAmount(actor.fetchId(), adenaItem.fetchId(), total).then(() => {
                adenaItem.setAmount(total);
                resolve();
            }).catch(reject);
        } else {
            Database.deleteItem(actor.fetchId(), adenaItem.fetchId()).then(() => {
                actor.backpack.items = actor.backpack.items.filter((ob) => ob.fetchId() !== adenaItem.fetchId());
                resolve();
            }).catch(reject);
        }
    });
}

function giveAdena(actor, amount) {
    return new Promise((resolve, reject) => {
        const adenaItem = fetchAdena(actor);
        if (adenaItem) {
            const total = adenaItem.fetchAmount() + amount;
            Database.updateItemAmount(actor.fetchId(), adenaItem.fetchId(), total).then(() => {
                adenaItem.setAmount(total);
                resolve();
            }).catch(reject);
            return;
        }

        Database.setItem(actor.fetchId(), {
            selfId: 57,
            name: 'Adena',
            amount,
            equipped: false,
            slot: 0
        }).then((packet) => {
            actor.backpack.insertItem(Number(packet.insertId), 57, { amount });
            resolve();
        }).catch(reject);
    });
}

function giveItem(actor, selfId, amount) {
    return new Promise((resolve, reject) => {
        actor.backpack.stackableExists(selfId).then((item) => {
            const total = item.fetchAmount() + amount;
            Database.updateItemAmount(actor.fetchId(), item.fetchId(), total).then(() => {
                actor.backpack.updateAmount(item.fetchId(), total);
                resolve();
            }).catch(reject);
        }).catch(() => {
            const itemDetails = itemTemplate(selfId);
            if (!itemDetails) {
                reject(`Unknown item ${selfId}.`);
                return;
            }

            Database.setItem(actor.fetchId(), {
                selfId: itemDetails.selfId,
                name: itemDetails.template.name,
                amount,
                equipped: false,
                slot: itemDetails.etc?.slot ?? 0
            }).then((packet) => {
                actor.backpack.insertItem(Number(packet.insertId), selfId, { amount });
                resolve();
            }).catch(reject);
        });
    });
}

function takeItem(actor, selfId, amount) {
    return new Promise((resolve, reject) => {
        const item = actor.backpack.fetchItemFromSelfId(selfId);
        if (!item || item.fetchAmount() < amount) {
            return reject("Not enough items.");
        }

        const total = item.fetchAmount() - amount;
        if (total > 0) {
            Database.updateItemAmount(actor.fetchId(), item.fetchId(), total).then(() => {
                item.setAmount(total);
                resolve();
            }).catch(reject);
        } else {
            Database.deleteItem(actor.fetchId(), item.fetchId()).then(() => {
                actor.backpack.items = actor.backpack.items.filter((ob) => ob.fetchId() !== item.fetchId());
                resolve();
            }).catch(reject);
        }
    });
}

function previewSaleToStore(actor, store) {
    if (!store || store.storeType !== 3) {
        return { totalAdena: 0, itemCount: 0, lines: [] };
    }

    let totalAdena = 0;
    let itemCount = 0;
    const lines = [];

    actor.backpack.fetchItems().filter(isSellableInventoryItem).forEach((inventoryItem) => {
        const storeItem = store.items.find((item) => item.selfId === inventoryItem.fetchSelfId() && item.count > 0);
        if (!storeItem) return;

        const qty = Math.min(inventoryItem.fetchAmount(), storeItem.count);
        if (qty <= 0) return;

        const payout = qty * storeItem.price;
        totalAdena += payout;
        itemCount += qty;
        lines.push({
            selfId: inventoryItem.fetchSelfId(),
            name: inventoryItem.fetchName(),
            qty,
            price: storeItem.price,
            payout
        });
    });

    return { totalAdena, itemCount, lines };
}

async function buyFromStore(actor, store, selfId, qty) {
    if (!store || store.storeType !== 1) {
        throw new Error("This store is not selling items.");
    }

    const storeItem = store.items.find((item) => item.selfId === selfId);
    if (!storeItem) {
        throw new Error("Item is not available.");
    }

    const buyQty = Math.min(qty, storeItem.count);
    if (buyQty <= 0) {
        throw new Error("Item is out of stock.");
    }

    const totalCost = storeItem.price * buyQty;
    await deductAdena(actor, totalCost);
    await giveItem(actor, selfId, buyQty);

    storeItem.count -= buyQty;
    store.items = store.items.filter((item) => item.count > 0);

    return { qty: buyQty, totalAdena: totalCost, name: itemName(selfId) };
}

async function sellToStore(actor, store, selfId, qty) {
    if (!store || store.storeType !== 3) {
        throw new Error("This store is not buying items.");
    }

    const storeItem = store.items.find((item) => item.selfId === selfId);
    if (!storeItem) {
        throw new Error("Item is not wanted.");
    }

    const actorItem = actor.backpack.fetchItemFromSelfId(selfId);
    const actorCount = actorItem ? actorItem.fetchAmount() : 0;
    const sellQty = Math.min(qty, actorCount, storeItem.count);
    if (sellQty <= 0) {
        throw new Error("No items to sell.");
    }

    const totalEarn = storeItem.price * sellQty;
    await takeItem(actor, selfId, sellQty);
    await giveAdena(actor, totalEarn);

    storeItem.count -= sellQty;
    store.items = store.items.filter((item) => item.count > 0);

    return { qty: sellQty, totalAdena: totalEarn, name: itemName(selfId) };
}

async function sellInventoryToStore(actor, store) {
    const preview = previewSaleToStore(actor, store);
    const sold = [];

    for (const line of preview.lines) {
        const result = await sellToStore(actor, store, line.selfId, line.qty);
        sold.push(result);
    }

    return {
        itemsSold: sold.reduce((acc, line) => acc + line.qty, 0),
        totalAdena: sold.reduce((acc, line) => acc + line.totalAdena, 0),
        sold
    };
}

function findBestBuyerForActor(actor, merchantSessions, options = {}) {
    const town = options.town || null;
    const maxTownDistance = options.maxTownDistance ?? 6500;
    const actorLoc = storeLoc(actor);

    let best = null;
    merchantSessions.forEach((session) => {
        const merchant = session.actor;
        if (!merchant || session.plan !== 'merchant') return;

        const store = merchant.fetchPrivateStore && merchant.fetchPrivateStore();
        if (!store || store.storeType !== 3 || !store.items.length) return;

        const merchantLoc = storeLoc(merchant);
        if (town && distance2d(merchantLoc, { locX: town.x, locY: town.y, locZ: town.z }) > maxTownDistance) {
            return;
        }

        const preview = previewSaleToStore(actor, store);
        if (preview.totalAdena <= 0) return;

        const distance = distance2d(actorLoc, merchantLoc);
        const score = preview.totalAdena - Math.floor(distance / 10);
        if (!best || score > best.score) {
            best = { session, actor: merchant, store, preview, distance, score };
        }
    });

    return best;
}

module.exports = {
    buyFromStore,
    describeStoreItems,
    findBestBuyerForActor,
    itemBasePrice,
    itemName,
    normalizeStoreItems,
    previewSaleToStore,
    ratedPrice,
    sellInventoryToStore,
    sellToStore
};
