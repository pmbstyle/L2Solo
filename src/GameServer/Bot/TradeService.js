const BeginnerShots = require('../Items/C4BeginnerShots');
const ItemTemplateIndex = require('../Item/ItemTemplateIndex');
const DataCache = invoke('GameServer/DataCache');
const Database  = invoke('Database');
const BotEconomyPricing = invoke('GameServer/Bot/Economy/BotEconomyPricing');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const storePurchaseQueues = new WeakMap();
const actorPurchaseQueues = new WeakMap();
// Runtime-only source identity: object spread preserves this symbol, JSON
// and persisted item/state fields omit it. Repricing never loses the author's
// configured line, even after another player opened the merchant's window.
const staticPriceSource = Symbol('staticMerchantSource');

function isBotActor(actor) {
    const session = actor?.session;
    return session?.botSession === true || session?.constructor?.name === 'BotSession'
        || String(session?.accountId || '').startsWith('bot_');
}

function storeItemPrice(store, item, actor = null) {
    const source = item[staticPriceSource];
    if (!source) return Number(item.price);
    const pricing = invoke('GameServer/Bot/Economy/StaticMerchantPricing');
    return isBotActor(actor) ? pricing.botPriceFor(source.store, source.line)
        : pricing.priceFor(source.store, source.line, { viewerId: actor?.fetchId?.() || 0 });
}

function refreshStorePrices(store, actor = null) {
    for (const item of store?.items || []) {
        if (item[staticPriceSource]) item.price = storeItemPrice(store, item, actor);
    }
    return store;
}

// Native C4 store windows cannot quote a price wider than their D field.
// Keep the exact price for HTML and execution; omitted native rows have no quote.
function nativeStoreItems(store) {
    const WireD = invoke('Packet/WireD');
    return (store?.items || []).filter(item => WireD.isRepresentable(item.price));
}

// The retained static-buyer route until 3.6 is only for bot materials.
// Preview and queued execution share this gate so neither buyer selection
// nor a direct/stale arrival can liquidate gear through a static buyer.
function acceptsSellerItem(actor, storeItem, inventoryItem) {
    if (BeginnerShots.isRestricted(storeItem.selfId)) return false;
    if (storeItem[staticPriceSource] && isBotActor(actor)
        && require('./Economy/ProductionPolicy').buyersDisabled()) return false;
    return !storeItem[staticPriceSource] || !isBotActor(actor)
        || String(inventoryItem?.fetchKind?.() || itemTemplate(storeItem.selfId)?.template?.kind || '')
            .startsWith('Other.Material');
}

async function withTradeQueues(store, selfId, actors, operation) {
    if (!storePurchaseQueues.has(store)) storePurchaseQueues.set(store, new Map());
    const storeQueues = storePurchaseQueues.get(store);
    const queueKey = String(Number(selfId));
    const uniqueActors = [...new Set(actors.filter(Boolean))];
    const predecessors = [
        storeQueues.get(queueKey) || Promise.resolve(),
        ...uniqueActors.map((actor) => actorPurchaseQueues.get(actor) || Promise.resolve())
    ];
    const ready = Promise.all(predecessors.map((pending) => pending.catch(() => null)));
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const queued = ready.then(() => gate);
    storeQueues.set(queueKey, queued);
    uniqueActors.forEach((actor) => actorPurchaseQueues.set(actor, queued));

    await ready;
    try {
        return await operation();
    } finally {
        release();
        uniqueActors.forEach((actor) => {
            if (actorPurchaseQueues.get(actor) === queued) actorPurchaseQueues.delete(actor);
        });
        if (storeQueues.get(queueKey) === queued) storeQueues.delete(queueKey);
        if (storeQueues.size === 0) storePurchaseQueues.delete(store);
    }
}

async function runPostCommitCallback(label, callback, result, storeItem) {
    if (typeof callback !== 'function') return;
    try {
        await callback(result, storeItem);
    } catch (error) {
        result.callbackWarning = error?.message || String(error);
        utils.infoWarn('BotTrade', '%s callback failed after committed trade: %s', label, result.callbackWarning);
    }
}

function itemTemplate(selfId) {
    return ItemTemplateIndex.findStrict(DataCache.items, selfId);
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
    return item && !BeginnerShots.isRestricted(item.fetchSelfId?.()) && !item.fetchPetLocked?.() && !item.fetchEquipped() && item.fetchSelfId() !== 57;
}

// The copies a sale to a buy store may take: not reserved by the bot's
// plans, not equipped, not pet-locked, not Adena.
function sellableActorItems(actor, state) {
    return ItemDisposition.unreservedActorItems(state, actor.backpack.fetchItems())
        .filter(isSellableInventoryItem);
}

function normalizeStoreItems(storeCfg, { staticStore = false } = {}) {
    let fakeObjectIdSeq = 600000000 + utils.randomNumber(100000000);
    const pricing = staticStore ? invoke('GameServer/Bot/Economy/StaticMerchantPricing') : null;
    return storeCfg.items.map((item) => ({
        objectId: ++fakeObjectIdSeq,
        selfId: item.selfId,
        price: pricing ? pricing.priceFor(storeCfg, item) : item.price ?? ratedPrice(item.selfId, item.priceRate ?? 1),
        count: item.count ?? 1,
        ...(pricing ? { [staticPriceSource]: { store: storeCfg, line: item } } : {})
    })).filter((item) => !staticStore || item.price > 0);
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

// The handle of a row giveItem inserted that the backpack does not hold: enough
// for takeItem to delete that row.
function insertedRow(id, amount) {
    return { fetchId: () => id, fetchAmount: () => amount, setAmount: (value) => { amount = value; } };
}

// Resolves with the item the amount went to: the stack, or the new row.
function giveItem(actor, selfId, amount) {
    return new Promise((resolve, reject) => {
        actor.backpack.stackableExists(selfId).then((item) => {
            const total = item.fetchAmount() + amount;
            Database.updateItemAmount(actor.fetchId(), item.fetchId(), total).then(() => {
                actor.backpack.updateAmount(item.fetchId(), total);
                resolve(item);
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
                // The new row, even when the backpack did not take it: a rollback
                // must be able to delete exactly this row.
                resolve(actor.backpack.items.find((entry) => Number(entry.fetchId()) === Number(packet.insertId))
                    || insertedRow(Number(packet.insertId), amount));
            }).catch(reject);
        });
    });
}

// The copy a buy store takes: the offered one (objectId), else the first
// sellable copy. Never a worn or pet-locked one.
function sellableCopy(actor, selfId, objectId = null) {
    return actor.backpack.fetchItems().find((item) => (
        Number(item.fetchSelfId()) === Number(selfId)
        && (!objectId || Number(item.fetchId()) === Number(objectId))
        && isSellableInventoryItem(item)
    )) || null;
}

function takeItem(actor, selfId, amount, item = actor.backpack.fetchItemFromSelfId(selfId)) {
    return new Promise((resolve, reject) => {
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

// The board's buy record in this town a hot bot sells into, as { offer,
// score, sale }, or null: the buy ads it chose to answer by the cold bots'
// one sale decision (MarketListingPolicy.evaluate, MarketPricing.disposition:
// an ad against the NPC, the board and keeping the item), over the items it
// may sell (its reservations kept); of those in this town, the record that
// pays most. sale: selfId -> the units decided for that record. A buy shop's
// stall is walked to; a buy ad is answered by record at its place (D6, E45).
// options.now: the decision point (tests).
function findAfkBuyerForActor(actor, town, state = null, options = {}) {
    const ListingPolicy = invoke('GameServer/Bot/Economy/MarketListingPolicy');
    const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
    const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
    const items = sellableActorItems(actor, state);
    if (!items.length) return null;
    const seller = ListingPolicy.actorState({ actor, coldLifeState: state });
    seller.inventory = { ...LifeState.inventorySummaryFromItems(items),
        ...(seller.inventory['57'] ? { 57: seller.inventory['57'] } : {}) };
    const records = new Map();
    for (const answer of ListingPolicy.evaluate(seller, { unlimited: true, now: options.now }).answers) {
        if (answer.line.town !== town?.name) continue;
        const record = records.get(answer.line.recordId) || { line: answer.line, score: 0, sale: {} };
        record.score += answer.line.price * answer.count;
        record.sale[answer.line.selfId] = (record.sale[answer.line.selfId] || 0) + answer.count;
        records.set(answer.line.recordId, record);
    }
    let best = null;
    for (const record of records.values()) {
        if (best && record.score <= best.score) continue;
        const offer = AfkTrade.offerOf(record.line, town.name);
        if (offer) best = { offer, score: record.score, sale: record.sale };
    }
    return best;
}

function previewSaleToStore(actor, store, options = {}) {
    if (!store || store.storeType !== 3) {
        return { totalAdena: 0, itemCount: 0, lines: [] };
    }

    let totalAdena = 0;
    let itemCount = 0;
    const lines = [];

    sellableActorItems(actor, options.state)
        .forEach((inventoryItem) => {
            const storeItem = store.items.find((item) => item.selfId === inventoryItem.fetchSelfId() && item.count > 0);
            if (!storeItem) return;
            if (!acceptsSellerItem(actor, storeItem, inventoryItem)) return;

            const qty = Math.min(inventoryItem.fetchAmount(), storeItem.count);
            if (qty <= 0) return;

            const price = storeItemPrice(store, storeItem, actor);
            const payout = qty * price;
            totalAdena += payout;
            itemCount += qty;
            lines.push({
                objectId: inventoryItem.fetchId(),
                selfId: inventoryItem.fetchSelfId(),
                name: inventoryItem.fetchName(),
                qty,
                price,
                payout
            });
        });

    return { totalAdena, itemCount, lines };
}

async function buyFromStore(actor, store, selfId, qty, options = {}) {
    if (BeginnerShots.isRestricted(selfId)) throw new Error("Beginner shots cannot be traded.");
    if (!store || store.storeType !== 1) {
        throw new Error("This store is not selling items.");
    }

    return withTradeQueues(store, selfId, [actor], async () => {
        store.activePurchases = Math.max(0, Number(store.activePurchases || 0)) + 1;
        try {
            if (store.repricing === true) {
                throw new Error("Store listing changed.");
            }
            if (options.expectedRevision !== undefined && Number(store.revision || 1) !== Number(options.expectedRevision)) {
                throw new Error("Store listing changed.");
            }
            const storeItem = store.items.find((item) => Number(item.selfId) === Number(selfId));
            if (!storeItem) {
                throw new Error("Item is not available.");
            }
            if (storeItem[staticPriceSource] && isBotActor(actor)
                && (!invoke('GameServer/Inventory/ShotStock').SHOT_IDS.includes(Number(selfId))
                    || !require('./Economy/ProductionPolicy').allowsFixedShot(selfId))) {
                throw new Error('Static merchant item is unavailable to bots.');
            }
            const unitPrice = storeItemPrice(store, storeItem, actor);
            if (options.expectedUnitPrice !== undefined && unitPrice !== Number(options.expectedUnitPrice)) {
                throw new Error("Store price changed.");
            }

            const requestedQty = Number(qty);
            if (!Number.isSafeInteger(requestedQty) || requestedQty <= 0) {
                throw new Error("Invalid quantity.");
            }
            const buyQty = Math.min(requestedQty, Number(storeItem.count));
            if (!Number.isSafeInteger(buyQty) || buyQty <= 0) {
                throw new Error("Item is out of stock.");
            }

            const totalCost = unitPrice * buyQty;
            const originalCount = Number(storeItem.count);
            const originalIndex = store.items.indexOf(storeItem);
            // Reserve the finite lot synchronously, before any database await. A
            // second buyer therefore observes the reduced count even if this
            // purchase is still waiting on SQLite/network I/O.
            storeItem.count = originalCount - buyQty;
            if (storeItem.count <= 0) store.items = store.items.filter((item) => item !== storeItem);

            let adenaDeducted = false;
            try {
                await deductAdena(actor, totalCost);
                adenaDeducted = true;
                await giveItem(actor, selfId, buyQty);
            } catch (error) {
                // Restore the reserved lot before releasing the queue. This keeps
                // a failed purchase retryable and prevents a DB error from
                // silently destroying finite stock.
                storeItem.count = originalCount;
                if (!store.items.includes(storeItem)) {
                    store.items.splice(Math.max(0, Math.min(originalIndex, store.items.length)), 0, storeItem);
                }

                if (adenaDeducted) {
                    try {
                        await giveAdena(actor, totalCost);
                    } catch (rollbackError) {
                        if (error && typeof error === 'object') {
                            error.rollbackError = rollbackError;
                        }
                    }
                }
                throw error;
            }

            const result = { qty: buyQty, totalAdena: totalCost, name: itemName(selfId) };
            await runPostCommitCallback('afterPurchase', options.afterPurchase, result, storeItem);
            return result;
        } finally {
            store.activePurchases = Math.max(0, Number(store.activePurchases || 0) - 1);
        }
    });
}

async function sellToStore(actor, store, selfId, qty, options = {}) {
    if (!store || store.storeType !== 3) {
        throw new Error("This store is not buying items.");
    }
    const buyerActor = store.budgetBacked === true ? options.buyerActor || null : null;
    return withTradeQueues(store, selfId, [actor, buyerActor], async () => {
        store.activePurchases = Math.max(0, Number(store.activePurchases || 0)) + 1;
        try {
            if (store.repricing === true) {
                throw new Error("Store listing changed.");
            }

            const storeItem = store.items.find((item) => Number(item.selfId) === Number(selfId));
            if (!storeItem) {
                throw new Error("Item is not wanted.");
            }
            let unitPrice = storeItemPrice(store, storeItem, actor);
            if (options.expectedUnitPrice !== undefined && unitPrice !== Number(options.expectedUnitPrice)) {
                throw new Error('Store price changed.');
            }

            const requestedQty = Number(qty);
            if (!Number.isSafeInteger(requestedQty) || requestedQty <= 0) {
                throw new Error("Invalid quantity.");
            }
            let actorItem = sellableCopy(actor, selfId, options.objectId);
            if (!acceptsSellerItem(actor, storeItem, actorItem)) {
                throw new Error('Static buyer item is unavailable to bots.');
            }
            const actorCount = actorItem ? actorItem.fetchAmount() : 0;
            let sellQty = Math.min(requestedQty, Number(actorCount), Number(storeItem.count));
            if (!Number.isSafeInteger(sellQty) || sellQty <= 0) {
                throw new Error("No items to sell.");
            }

            const staticBuyer = !!storeItem[staticPriceSource] && !isBotActor(actor);
            let adQty = 0, adAdena = 0;
            const staticResult = (npcQty = 0, npcAdena = 0) => ({ qty: adQty + npcQty,
                totalAdena: adAdena + npcAdena, name: itemName(selfId), budgetBacked: false,
                adQty, adAdena, npcQty, npcAdena });
            if (staticBuyer) {
                const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
                const ads = AfkTrade.offers(selfId, AfkTrade.BUY, { characterId: actor.fetchId(),
                    enchant: Number(actorItem.fetchEnchantLevel?.() || 0), limit: 5,
                    accept: offer => ['shop', 'buy_ad'].includes(offer.recordKind)
                        && Number.isSafeInteger(offer.price) && offer.price >= 1 });
                let left = sellQty;
                for (const ad of ads) {
                    if (!left) break;
                    const amount = Math.min(left, Number(ad.storeItem.count));
                    if (!(amount > 0)) continue;
                    try {
                        const paid = await AfkTrade.sellToShop(actor.fetchId(), ad.store, selfId, amount, {
                            lineId: ad.storeItem.afkTradeLineId, objectId: actorItem.fetchId(),
                            expectedPrice: ad.storeItem.price });
                        if (paid.pending) {
                            // Earlier backed sales already moved physical goods. Keep
                            // their result and the merchant's remaining quantity exact.
                            storeItem.count -= adQty;
                            if (storeItem.count <= 0) store.items = store.items.filter(item => item !== storeItem);
                            const result = { ...staticResult(), pending: true, meetingId: paid.meetingId,
                                preparationId: paid.preparationId, token: paid.token };
                            if (adQty) await runPostCommitCallback('afterTrade', options.afterTrade, result, storeItem);
                            return result;
                        }
                        adQty += paid.amount;
                        adAdena += paid.totalPrice;
                        left -= paid.amount;
                    } catch (error) {
                        if (!String(error?.message || error).startsWith('afk_trade_')) throw error;
                    }
                }
                // Board deals have committed; only the remainder uses the
                // merchant's native buy-back and creates new adena.
                storeItem.count -= adQty;
                if (storeItem.count <= 0) store.items = store.items.filter(item => item !== storeItem);
                actorItem = sellableCopy(actor, selfId, options.objectId);
                sellQty = Math.min(left, Number(actorItem?.fetchAmount() || 0));
                if (!sellQty) {
                    const result = staticResult();
                    await runPostCommitCallback('afterTrade', options.afterTrade, result, storeItem);
                    return result;
                }
                unitPrice = invoke('GameServer/Items/NpcSellRules').npcBuyPrice(itemBasePrice(selfId));
            }

            const totalEarn = unitPrice * sellQty;
            const budgetBacked = store.budgetBacked === true;
            const buyerAdena = buyerActor ? Number(fetchAdena(buyerActor)?.fetchAmount() || 0) : 0;
            if (budgetBacked && (!buyerActor || buyerAdena < totalEarn)) {
                throw new Error("Buyer does not have enough Adena.");
            }

            const originalCount = Number(storeItem.count);
            const originalIndex = store.items.indexOf(storeItem);
            storeItem.count = originalCount - sellQty;
            if (storeItem.count <= 0) store.items = store.items.filter((item) => item !== storeItem);
            let sellerItemTaken = false;
            let buyerAdenaDeducted = false;
            let buyerItemGiven = false;
            let buyerItem = null;
            try {
                await takeItem(actor, selfId, sellQty, actorItem);
                sellerItemTaken = true;
                if (budgetBacked) {
                    await deductAdena(buyerActor, totalEarn);
                    buyerAdenaDeducted = true;
                    buyerItem = await giveItem(buyerActor, selfId, sellQty);
                    buyerItemGiven = true;
                }
                await giveAdena(actor, totalEarn);
            } catch (error) {
                storeItem.count = originalCount;
                if (!store.items.includes(storeItem)) {
                    store.items.splice(Math.max(0, Math.min(originalIndex, store.items.length)), 0, storeItem);
                }
                try {
                    // Take back the copy just given (its row, even one the backpack did not
                    // take), never another one the buyer holds or wears.
                    if (buyerItemGiven) await takeItem(buyerActor, selfId, sellQty, buyerItem);
                    if (buyerAdenaDeducted) await giveAdena(buyerActor, totalEarn);
                    if (sellerItemTaken) await giveItem(actor, selfId, sellQty);
                } catch (rollbackError) {
                    if (error && typeof error === 'object') error.rollbackError = rollbackError;
                }
                throw error;
            }

            const result = staticBuyer ? staticResult(sellQty, totalEarn)
                : { qty: sellQty, totalAdena: totalEarn, name: itemName(selfId), budgetBacked };
            await runPostCommitCallback('afterTrade', options.afterTrade, result, storeItem);
            return result;
        } finally {
            store.activePurchases = Math.max(0, Number(store.activePurchases || 0) - 1);
        }
    });
}

async function sellInventoryToStore(actor, store, options = {}) {
    const preview = previewSaleToStore(actor, store, options);
    const sold = [];

    for (const line of preview.lines) {
        const result = await sellToStore(actor, store, line.selfId, line.qty, { ...options, objectId: line.objectId });
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
        if (!merchant) return;
        if (!String(session.accountId || '').startsWith('bot_') || session.plan !== 'merchant') return;

        const store = merchant.fetchPrivateStore && merchant.fetchPrivateStore();
        if (!store || store.storeType !== 3 || !store.items.length) return;

        const merchantLoc = storeLoc(merchant);
        if (town && distance2d(merchantLoc, { locX: town.x, locY: town.y, locZ: town.z }) > maxTownDistance) {
            return;
        }

        const preview = previewSaleToStore(actor, store, options);
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
    nativeStoreItems,
    buyFromStore,
    describeStoreItems,
    findAfkBuyerForActor,
    findBestBuyerForActor,
    itemBasePrice,
    isSellableInventoryItem,
    itemName,
    normalizeStoreItems,
    previewSaleToStore,
    ratedPrice,
    refreshStorePrices,
    sellableActorItems,
    sellInventoryToStore,
    sellToStore,
    sellableCopy,
    storeItemPrice
};
