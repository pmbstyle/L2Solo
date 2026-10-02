const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const ListingPolicy = invoke('GameServer/Bot/Economy/MarketListingPolicy');
const MarketBuyerActivity = invoke('GameServer/Bot/Economy/MarketBuyerActivity');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const ListingService = invoke('GameServer/Bot/Economy/ColdMarketListingService');
const BuyStoreService = invoke('GameServer/Bot/Economy/ColdMarketBuyStoreService');
const MarketTownPolicy = invoke('GameServer/Bot/Economy/MarketTownPolicy');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const BotEconomyPricing = invoke('GameServer/Bot/Economy/BotEconomyPricing');
const LotPolicy = require('./MarketLotPolicy');
const { marketStoreTitle, marketBuyStoreTitle } = invoke('GameServer/Bot/Economy/MarketStoreTitle');

const MAX_LINES = 3;
const SHOP_REVIEW_MS = 5 * 60 * 1000;
const reviewedInventory = new Map();
const pending = new Map();
let reviewOwners = [];
let reviewCursor = 0;
let reviewRunning = false;

function desiredSide(goal) {
    if (goal?.status && goal.status !== 'active') return 0;
    if (goal?.type === 'sell_inventory' && goal.plan?.expectedBenefit === 'market_sale_inventory'
        && !goal.target?.cleanupReason && !goal.plan?.cleanupReason) return AfkTrade.SELL;
    if (goal?.type === 'upgrade_gear'
        && ['market_search_for_weapon', 'market_search_for_gear'].includes(goal.plan?.expectedBenefit)) return AfkTrade.BUY;
    if (goal?.type === 'buy_craft_material'
        && goal.plan?.expectedBenefit === 'market_buy_craft_material') return AfkTrade.BUY;
    return 0;
}

// Adena held by the bot's own open buy order. It is still the bot's money for
// any purchase: a new order replaces the old one and refunds it.
function buyOrderEscrow(characterId) {
    const shop = AfkTrade.findOwnerProjection(characterId)?.shop;
    return Number(shop?.storeType) === AfkTrade.BUY ? Math.max(0, Number(shop.escrowAdena || 0)) : 0;
}

function canTradeRemotely(state, goal) {
    const side = desiredSide(goal);
    if (!state || state.phase !== 'cold' || state.stats?.marketStore
        || !(state.stats?.generatedCold === true || String(state.accountName || '').startsWith('bot_'))
        || !side) return false;
    if (side === AfkTrade.BUY) {
        const existing = AfkTrade.findOwnerProjection(state.characterId)?.actor?.fetchPrivateStore?.();
        const reserved = existing?.botOwned ? buyOrderEscrow(state.characterId) : 0;
        const budgetState = { ...state, adena: Number(state.adena || 0) + reserved };
        const offer = MarketOpportunity.bestOffer(goal.target?.itemId, {
            town: goal.plan?.marketTown || null,
            budget: budgetState.adena,
            buyerCharacterId: state.characterId
        });
        // An NPC-sold item is bought at the NPC, not through a WTB, unless the
        // goal is quoted from another seller: a quote from the bot's own NPC
        // shop plan still means the NPC (NeedsEvaluator keeps NG/D gear there).
        if (offer?.sourceType === 'npc'
            && (goal.plan?.priceSource !== 'offer' || goal.plan?.sourceType === 'npc')) return false;
        if (reserved && existing.items.some((line) => Number(line.selfId) === Number(goal.target?.itemId))) return true;
        return !!BuyStoreService.bidFor(budgetState, goal);
    }
    return true;
}

function stockSignature(state) {
    return Object.values(state?.inventory || {})
        .filter((item) => Number(item.selfId) !== 57 && Number(item.amount || 0) > 0)
        .map((item) => `${item.selfId}:${item.amount}:${item.enchant ?? ''}:${item.equippedCount || 0}`)
        .sort().join('|');
}

function rememberInventory(ownerId, state) {
    if (state) reviewedInventory.set(Number(ownerId), {
        signature: stockSignature(state), reviewedAt: Date.now(),
        buyerRevision: MarketBuyerActivity.revision()
    });
}

function appearance(row, items) {
    const classInfo = (DataCache.classTemplates || [])
        .find((entry) => Number(entry.classId) === Number(row.classId));
    return {
        model: { ...row, ...utils.crushOb(classInfo || {}) },
        paperdoll: utils.tupleAlloc(16, {}),
        items: items.filter((item) => Number(item.equipped) === 1)
            .map((item) => ({ ...item, equipped: true }))
    };
}

function minimumResourceLotValue() {
    return BotEconomyPricing.scalePrice(LotPolicy.MIN_BASE_VALUE);
}

function viableSellLine(line) {
    return LotPolicy.viable(line);
}

async function publishPrunedSellShop(shop, kept, town = shop.town, loc = shop) {
    if (!kept.length) return AfkTrade.stop(shop.ownerId);
    return AfkTrade.publishBot(shop.ownerId, {
        storeType: AfkTrade.SELL,
        title: marketStoreTitle(kept),
        town,
        locX: loc.locX, locY: loc.locY, locZ: loc.locZ,
        head: shop.head,
        appearance: shop.appearance,
        lines: kept.map((line) => ({
            ...line, objectId: line.sourceObjectId,
            stackable: Number(line.stackable) === 1
        }))
    });
}

async function pruneResourceLots(ownerId) {
    const shop = AfkTrade.findOwnerProjection(ownerId)?.shop;
    if (!shop || !String(shop.ownerAccount || '').startsWith('bot_')
        || Number(shop.storeType) !== AfkTrade.SELL) return { changed: false };
    const lines = (shop.lines || []).filter((line) => Number(line.count) > 0);
    const kept = lines.filter(viableSellLine);
    if (kept.length === lines.length) return { changed: false };
    await publishPrunedSellShop(shop, kept);
    return { changed: true, removed: lines.length - kept.length, closed: kept.length === 0 };
}

function stateWithEscrow(state, stock) {
    if (Number(stock?.storeType) !== AfkTrade.SELL) return state;
    const combined = { ...(state.inventory || {}) };
    for (const line of stock.lines || []) {
        const selfId = Number(line.selfId || 0);
        const count = Math.max(0, Number(line.count || 0));
        if (!selfId || !count) continue;
        const template = ItemTemplateIndex.find(DataCache.items, selfId);
        const previous = combined[String(selfId)] || {};
        combined[String(selfId)] = {
            ...previous, selfId, name: line.name || previous.name || template?.template?.name,
            kind: previous.kind || template?.template?.kind,
            rank: previous.rank || template?.etc?.rank,
            amount: Math.max(0, Number(previous.amount || 0)) + count,
            enchant: Math.max(Number(previous.enchant || 0), Number(line.enchant || 0))
        };
    }
    return { ...state, inventory: combined };
}

function sellLines(state, stock, inventory) {
    const existing = stock?.storeType === AfkTrade.SELL
        ? stock.lines.filter((line) => Number(line.count) > 0).map((line) => ({
            objectId: Number(line.sourceObjectId || 0),
            selfId: Number(line.selfId),
            name: line.name,
            count: Number(line.count),
            price: Number(line.price),
            enchant: Number(line.enchant || 0),
            slot: Number(line.slot || 0),
            stackable: Number(line.stackable) === 1,
            petData: line.petData || null
        })) : [];
    const saleState = stateWithEscrow(state, stock);
    const hasRecipe = Object.values(saleState.inventory || {}).some(ItemDisposition.isMarketRecipeItem);
    const classified = ListingPolicy.evaluate(saleState, hasRecipe ? { recipeFirst: true } : {});
    const listings = classified.listings;
    const priorityMarketItems = new Set(classified.listings
        .filter((item) => ItemDisposition.isMarketRecipeItem(item)
            || String(item.kind || '').startsWith('Other.Shot'))
        .map((item) => Number(item.selfId)));
    const remaining = new Map(listings.map((item) => [Number(item.selfId), Number(item.count)]));
    const next = [];
    const keepExisting = (line) => {
        if (next.length >= MAX_LINES) return;
        const available = Math.max(0, Number(remaining.get(line.selfId) || 0));
        if (!available) return;
        const count = Math.min(line.count, available);
        next.push({ ...line, count });
        remaining.set(line.selfId, available - count);
    };
    const appendListing = (listing) => {
        if (next.length >= MAX_LINES) return;
        const available = inventory.filter((row) => Number(row.selfId) === Number(listing.selfId)
            && !row.equipped && Number(row.amount) > 0);
        for (const row of available) {
            const count = Math.min(Number(row.amount), Math.max(0, Number(remaining.get(Number(listing.selfId)) || 0)));
            if (count <= 0) continue;
            const stackable = ItemTemplateIndex.find(DataCache.items, row.selfId)?.etc?.stackable === true;
            const matching = stackable && next.find((line) => Number(line.selfId) === Number(row.selfId)
                && Number(line.enchant || 0) === Number(row.enchant || 0));
            if (matching) {
                matching.count += count;
                remaining.set(Number(listing.selfId), Number(remaining.get(Number(listing.selfId))) - count);
                break;
            }
            if (next.some((line) => Number(line.objectId) === Number(row.id))) continue;
            next.push({
                objectId: Number(row.id),
                selfId: Number(row.selfId),
                name: row.name || listing.name,
                count,
                price: Number(listing.price),
                enchant: Number(row.enchant || 0),
                slot: Number(row.slot || 0),
                stackable,
                petData: row.petData || null
            });
            remaining.set(Number(listing.selfId), Number(remaining.get(Number(listing.selfId))) - count);
            break;
        }
    };
    existing.filter((line) => priorityMarketItems.has(line.selfId)).forEach(keepExisting);
    listings.filter((item) => priorityMarketItems.has(Number(item.selfId))).forEach(appendListing);
    existing.filter((line) => !priorityMarketItems.has(line.selfId)).forEach(keepExisting);
    listings.filter((item) => !priorityMarketItems.has(Number(item.selfId))).forEach(appendListing);
    return next.filter(viableSellLine).slice(0, MAX_LINES);
}

function buyLines(state, goal) {
    const bid = BuyStoreService.bidFor(state, goal);
    if (!bid) return [];
    const item = ItemTemplateIndex.find(DataCache.items, bid.selfId);
    return [{
        selfId: Number(bid.selfId),
        name: bid.name,
        count: Number(bid.count),
        price: Number(bid.price),
        enchant: 0,
        slot: Number(item?.etc?.slot || 0),
        stackable: item?.etc?.stackable === true
    }];
}

function sameBuyOrder(stock, lines) {
    if (Number(stock?.storeType) !== AfkTrade.BUY || stock.lines.length !== lines.length) return false;
    return stock.lines.every((line, index) => Number(line.selfId) === Number(lines[index].selfId)
        && Number(line.price) === Number(lines[index].price)
        && Number(line.count) === Number(lines[index].count));
}

function sameSellOrder(stock, lines) {
    if (Number(stock?.storeType) !== AfkTrade.SELL) return false;
    const current = stock.lines.filter((line) => Number(line.count) > 0);
    return current.length === lines.length && current.every((line, index) =>
        Number(line.selfId) === Number(lines[index].selfId)
        && Number(line.count) === Number(lines[index].count)
        && Number(line.price) === Number(lines[index].price)
        && Number(line.enchant || 0) === Number(lines[index].enchant || 0));
}

async function reconcileOne(state, goal) {
    const ownerId = Number(state.characterId);
    const projection = AfkTrade.findOwnerProjection(ownerId);
    let stock = projection?.shop || null;
    if (stock && await repairStoreTitle(stock)) {
        stock = AfkTrade.findOwnerProjection(ownerId)?.shop || null;
        state = LifeState.snapshot(ownerId) || state;
    }
    const persistentSellGoal = Number(stock?.storeType) === AfkTrade.SELL && !desiredSide(goal)
        ? { type: 'sell_inventory', status: 'active', plan: { expectedBenefit: 'market_sale_inventory' } }
        : goal;
    const side = desiredSide(persistentSellGoal);
    if (!canTradeRemotely(state, persistentSellGoal)) {
        if (state.phase === 'cold' && projection?.actor?.fetchPrivateStore?.()?.botOwned
            && Number(stock?.storeType) === AfkTrade.BUY) {
            await AfkTrade.stop(ownerId);
            reviewedInventory.delete(ownerId);
            return { state: LifeState.snapshot(ownerId) || state, changed: true, withdrawn: true };
        }
        return { state, changed: false };
    }
    const signature = stockSignature(state);
    const existingTown = stock?.storeType === side
        ? MarketTownPolicy.targetTownForItems(state, stock.lines)
        : null;
    const review = reviewedInventory.get(ownerId);
    if (side === AfkTrade.SELL && stock?.storeType === side
        && review?.signature === signature && Date.now() - review.reviewedAt < SHOP_REVIEW_MS
        && review.buyerRevision === MarketBuyerActivity.revision() && stock.town === existingTown
        && stock.lines.every(viableSellLine)) return { state, changed: false };
    if (side === AfkTrade.SELL) await MarketBuyerActivity.refresh();
    const [characters, inventory] = await Promise.all([
        Database.execute(['SELECT * FROM characters WHERE id = ? LIMIT 1', [ownerId]], 'bot-afk:owner'),
        Database.fetchItems(ownerId)
    ]);
    const row = characters[0];
    if (!row || !String(row.username || '').startsWith('bot_')) return { state, changed: false };
    const lines = side === AfkTrade.SELL
        ? sellLines(state, stock, inventory)
        : buyLines({ ...state, adena: Number(state.adena || 0) + buyOrderEscrow(ownerId) }, goal);
    const town = MarketTownPolicy.targetTownForItems(state, lines);
    if (!lines.length && side === AfkTrade.SELL && Number(stock?.storeType) === AfkTrade.SELL) {
        await AfkTrade.stop(ownerId);
        rememberInventory(ownerId, LifeState.snapshot(ownerId) || state);
        return { state: LifeState.snapshot(ownerId) || state, changed: true, withdrawn: true };
    }
    if (!lines.length || (stock?.town === town && side === AfkTrade.SELL && sameSellOrder(stock, lines))
        || (stock?.town === town && side === AfkTrade.BUY && sameBuyOrder(stock, lines))) {
        if (side === AfkTrade.SELL) rememberInventory(ownerId, state);
        return { state, changed: false };
    }

    const loc = stock?.town === town
        ? { locX: stock.locX, locY: stock.locY, locZ: stock.locZ }
        : ListingService.marketLocation({ name: town }, { state });
    if (!loc) return { state, changed: false, reason: 'market_full' };
    const title = side === AfkTrade.SELL
        ? marketStoreTitle(lines)
        : marketBuyStoreTitle(lines);
    const shop = await AfkTrade.publishBot(ownerId, {
        storeType: side,
        title,
        town,
        ...loc,
        head: Number(row.head || 0),
        appearance: appearance(row, inventory),
        lines
    });
    try {
        await AfkTrade.matchAfkOrders(ownerId);
        await BuyStoreService.matchAfkPlayerShop(ownerId);
    } catch (error) {
        utils.infoWarn('BotMarket', 'AFK shop matching failed for %s: %s', state.name, error.message);
    }
    const saved = LifeState.snapshot(ownerId) || state;
    rememberInventory(ownerId, saved);
    return { state: saved, changed: true, shop };
}

async function repairStoreTitle(shop) {
    if (!String(shop.ownerAccount || '').startsWith('bot_')) return false;
    const lines = (shop.lines || []).filter(line => Number(line.count) > 0);
    if (!lines.length) return false;
    const title = Number(shop.storeType) === AfkTrade.BUY
        ? marketBuyStoreTitle(lines) : marketStoreTitle(lines);
    if (shop.title === title) return false;
    await AfkTrade.repriceBot(shop.ownerId, lines[0].id, lines[0].price, shop.revision, null, { match: false });
    return true;
}

async function migrateRestoredShops() {
    let moved = 0;
    let skipped = 0;
    let pruned = 0;
    let closed = 0;
    for (const shop of AfkTrade.activeShops()) {
        if (!String(shop.ownerAccount || '').startsWith('bot_')) continue;
        const state = { characterId: Number(shop.ownerId), loc: shop };
        const lines = (shop.lines || []).filter((line) => Number(line.count) > 0);
        const kept = Number(shop.storeType) === AfkTrade.SELL
            ? lines.filter(viableSellLine) : lines;
        const removed = lines.length - kept.length;
        const town = MarketTownPolicy.targetTownForItems(state, kept.length ? kept : lines);
        const relocate = town !== shop.town;
        const loc = relocate
            ? ListingService.marketLocation({ name: town }, { state })
            : { locX: shop.locX, locY: shop.locY, locZ: shop.locZ };
        if (!loc && kept.length) { skipped++; continue; }
        try {
            if (!relocate && !removed) {
                await repairStoreTitle(shop);
                continue;
            }
            if (!kept.length) {
                await publishPrunedSellShop(shop, kept);
                closed++;
            } else if (removed) {
                await publishPrunedSellShop(shop, kept, relocate ? town : shop.town, loc);
                pruned += removed;
                if (relocate) moved++;
            } else if (relocate) {
                await AfkTrade.relocateBot(shop.ownerId, town, loc);
                moved++;
            }
        } catch (error) {
            skipped++;
            utils.infoWarn('BotMarket', 'AFK shop migration failed for %s: %s', shop.ownerName, error.message);
        }
    }
    if (moved || skipped || pruned || closed) utils.infoSuccess('BotMarket',
        'restored AFK shops relocated=%d resourceLinesRemoved=%d closed=%d pending=%d', moved, pruned, closed, skipped);
    return { moved, skipped, pruned, closed };
}

function reconcile(state, goal) {
    const ownerId = Number(state?.characterId || 0);
    if (!ownerId) return Promise.resolve({ state, changed: false });
    const previous = pending.get(ownerId) || Promise.resolve();
    const next = previous.catch(() => null).then(() => reconcileOne(LifeState.snapshot(ownerId) || state, goal));
    const tracked = next.then(() => null, () => null);
    tracked.then(() => {
        if (pending.get(ownerId) === tracked) pending.delete(ownerId);
    });
    pending.set(ownerId, tracked);
    return next;
}

async function withdraw(ownerId) {
    const id = Number(ownerId);
    const shop = AfkTrade.findOwnerProjection(id)?.shop;
    if (!shop || !String(shop.ownerAccount || '').startsWith('bot_')) return { stopped: false };
    const result = await AfkTrade.stop(id);
    reviewedInventory.delete(id);
    return result;
}

async function reviewNextPersistentShop() {
    if (reviewRunning) return false;
    if (reviewCursor >= reviewOwners.length) {
        reviewOwners = AfkTrade.activeShops()
            .filter((shop) => String(shop.ownerAccount || '').startsWith('bot_')
                && Number(shop.storeType) === AfkTrade.SELL)
            .map((shop) => Number(shop.ownerId));
        reviewCursor = 0;
    }
    const ownerId = reviewOwners[reviewCursor++];
    if (!ownerId) return false;
    const state = LifeState.snapshot(ownerId);
    if (!state || state.phase !== 'cold') return false;
    reviewRunning = true;
    try {
        await reconcile(state, null);
        return true;
    } catch (error) {
        utils.infoWarn('BotMarket', 'persistent shop review failed for %d: %s', ownerId, error.message);
        return false;
    } finally {
        reviewRunning = false;
    }
}

module.exports = { buyOrderEscrow, canTradeRemotely, desiredSide, migrateRestoredShops, minimumResourceLotValue,
    pruneResourceLots, reconcile, rememberInventory, reviewNextPersistentShop, viableSellLine, withdraw,
    _resetForTests() { reviewedInventory.clear(); pending.clear(); reviewOwners = []; reviewCursor = 0; reviewRunning = false; } };
