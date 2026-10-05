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
const ShopPlaces = invoke('GameServer/Bot/Economy/ShopPlaces');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const BotEconomyPricing = invoke('GameServer/Bot/Economy/BotEconomyPricing');
const PurchaseFunding = invoke('GameServer/Bot/Economy/PurchaseFunding');
const LotPolicy = require('./MarketLotPolicy');
const { marketStoreTitle, marketBuyStoreTitle } = invoke('GameServer/Bot/Economy/MarketStoreTitle');

const BoardRules = require('../../AfkTrade/BoardRules');
const MAX_LINES = BoardRules.BOT_SHOP_LINES;
const SHOP_REVIEW_MS = 5 * 60 * 1000;
const reviewedInventory = new Map();
const listingSince = new Map();
const pending = new Map();

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

// Adena held by the bot's own buy ads. It is still the bot's money for any
// purchase: a new ad for its goal replaces the old one and refunds it.
function buyOrderEscrow(characterId) {
    return AfkTrade.ownerRecords(characterId).reduce((sum, record) => (
        Number(record.storeType) === AfkTrade.BUY ? sum + Math.max(0, Number(record.escrowAdena || 0)) : sum
    ), 0);
}

// The bot's buy ads: the author's single WTB order became an ad that does not
// take the bot's shop (design 4.2), so it sells and buys at once.
function buyAds(characterId) {
    return AfkTrade.ownerRecords(characterId).filter((record) => record.kind === 'buy_ad');
}

function linesOf(records) {
    return records.flatMap((record) => (record.lines || []).filter((line) => Number(line.count) > 0));
}

function canTradeRemotely(state, goal) {
    const side = desiredSide(goal);
    if (!state || state.phase !== 'cold' || state.stats?.marketStore
        || !(state.stats?.generatedCold === true || String(state.accountName || '').startsWith('bot_'))
        || !side) return false;
    if (side === AfkTrade.BUY) {
        // A purchase planned at an NPC shop is made there, never through a
        // WTB (NeedsEvaluator keeps NG/D gear on that plan); in town the bot
        // still takes a cheaper listing if one is there.
        if (goal.plan?.sourceType === 'npc') return false;
        const existing = linesOf(buyAds(state.characterId));
        const reserved = buyOrderEscrow(state.characterId);
        const budgetState = { ...state, adena: PurchaseFunding.budget(state, reserved) };
        const offer = MarketOpportunity.bestOffer(goal.target?.itemId, {
            town: goal.plan?.marketTown || null,
            budget: budgetState.adena,
            buyerCharacterId: state.characterId
        });
        if (offer?.sourceType === 'npc' && goal.plan?.priceSource !== 'offer') return false;
        if (reserved && existing.some((line) => Number(line.selfId) === Number(goal.target?.itemId))) return true;
        return !!BuyStoreService.bidFor(budgetState, goal);
    }
    return true;
}

// A buy order stands through a goal without a trade side, such as a rest,
// while the needs evaluation still asks to buy one of its items: a sell shop
// already persists the same way. `candidates` is that evaluation when the
// caller has just made it (a goal review). Near death the evaluation only
// asks to recover and judges nothing else, so the order waits like a rest.
function standingBuyNeed(state, lines, candidates) {
    const items = new Set(lines.filter((line) => Number(line.count) > 0).map((line) => Number(line.selfId)));
    if (!items.size) return false;
    const needs = candidates || invoke('GameServer/Bot/Goals/NeedsEvaluator').evaluate(state);
    if (needs.length === 1 && needs[0].target?.condition === 'alive_and_recovered') return true;
    // A purchase planned at an NPC shop never holds a WTB, rest or not.
    return needs.some((need) => desiredSide(need) === AfkTrade.BUY && need.plan?.sourceType !== 'npc'
        && items.has(Number(need.target?.itemId)));
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

// A physical stall lives for a fixed period and, when it ends unsold, the
// bot remembers the failure (ColdMarketListingService.pricingAfterReview):
// the next price is 5% lower and a speculative line is not tried again. An
// AFK shop has no lifetime, so its review measures each line against the
// same periods, counted from when the line was first listed.
function expiredSellLines(ownerId, stock, now) {
    const since = listingSince.get(ownerId);
    if (!since) return [];
    const expired = [];
    for (const line of stock.lines || []) {
        const listed = since.get(Number(line.selfId));
        if (!listed || Number(line.count) <= 0) continue;
        const period = listed.speculative ? ListingService.SPECULATIVE_LISTING_MS : ListingService.DEFAULT_LISTING_MS;
        if (now - listed.at < period) continue;
        expired.push({ selfId: Number(line.selfId), count: Number(line.count), price: Number(line.price),
            marketReason: listed.speculative ? 'speculative_demand' : null });
    }
    return expired;
}

function rememberListings(ownerId, stock, lines, listed, expiredIds, now) {
    const previous = listingSince.get(ownerId);
    // A period continues only for an item the shop still offered before this
    // review; an item listed again after a sell-out or a prune starts anew.
    const offered = new Set((Number(stock?.storeType) === AfkTrade.SELL ? stock.lines : [])
        .filter((line) => Number(line.count) > 0)
        .map((line) => Number(line.selfId)));
    const next = new Map();
    for (const line of lines) {
        const selfId = Number(line.selfId);
        const speculative = listed.get(selfId)?.reason === 'speculative_demand';
        const kept = offered.has(selfId) ? previous?.get(selfId) : null;
        // As a stall's line, a line that turns speculative gets a fresh short try.
        const fresh = !kept || expiredIds.has(selfId) || (speculative && !kept.speculative);
        next.set(selfId, { at: fresh ? now : kept.at, speculative });
    }
    if (next.size) listingSince.set(ownerId, next);
    else listingSince.delete(ownerId);
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

function sellLines(state, stock, inventory, expiredIds = new Set(), evaluateOptions = {}) {
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
    const classified = ListingPolicy.evaluate(saleState, hasRecipe ? { ...evaluateOptions, recipeFirst: true } : evaluateOptions);
    const listings = classified.listings;
    const priorityMarketItems = new Set(classified.listings
        .filter((item) => ItemDisposition.isMarketRecipeItem(item)
            || String(item.kind || '').startsWith('Other.Shot'))
        .map((item) => Number(item.selfId)));
    const remaining = new Map(listings.map((item) => [Number(item.selfId), Number(item.count)]));
    const listed = new Map((classified.decisions || [])
        .filter((decision) => decision.action === 'list')
        .map((decision) => [Number(decision.item.selfId), decision]));
    const next = [];
    // A kept line is re-priced as a physical store's review re-prices its
    // stall (ColdMarketListingService.revalidatedItems): its own price is the
    // preferred price, so only a cheaper competitor lowers it. A line that
    // outlived its period is offered again at the fresh, lower price.
    const keptPrice = (line) => {
        const decision = listed.get(line.selfId);
        if (!decision) return line.price;
        const preferred = expiredIds.has(line.selfId)
            ? Math.min(line.price, Number(decision.item.price)) : line.price;
        return ListingPolicy.listingPrice({ ...decision.item, price: preferred }, decision);
    };
    const keepExisting = (line) => {
        if (next.length >= MAX_LINES) return;
        const available = Math.max(0, Number(remaining.get(line.selfId) || 0));
        if (!available) return;
        const count = Math.min(line.count, available);
        next.push({ ...line, count, price: keptPrice(line) });
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
    return { lines: next.filter(viableSellLine).slice(0, MAX_LINES), listed, listings };
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

// The shop offers the same items, counts and enchants; prices may differ.
function sameSellLines(stock, lines) {
    if (Number(stock?.storeType) !== AfkTrade.SELL) return false;
    const current = stock.lines.filter((line) => Number(line.count) > 0);
    return current.length === lines.length && current.every((line, index) =>
        Number(line.selfId) === Number(lines[index].selfId)
        && Number(line.count) === Number(lines[index].count)
        && Number(line.enchant || 0) === Number(lines[index].enchant || 0));
}

function sameSellOrder(stock, lines) {
    return sameSellLines(stock, lines) && stock.lines.filter((line) => Number(line.count) > 0)
        .every((line, index) => Number(line.price) === Number(lines[index].price));
}

// Only prices changed: update those lines in place with the author's
// repriceBot (as an agreed deal does) instead of replacing the whole shop.
// A trade or a deal that changed the shop meanwhile wins: the remaining
// lines wait for the next review.
async function repriceSellLines(ownerId, stock, lines) {
    const current = stock.lines.filter((line) => Number(line.count) > 0);
    let shop = stock;
    for (let index = 0; index < lines.length; index++) {
        if (Number(current[index].price) === Number(lines[index].price)) continue;
        try {
            shop = await AfkTrade.repriceBot(ownerId, current[index].id, lines[index].price, shop.revision, null, { match: false });
        } catch (error) {
            if (error.message !== 'afk_trade_shop_changed') throw error;
            return AfkTrade.findOwnerProjection(ownerId)?.shop || null;
        }
        if (!shop) return null;
    }
    return shop;
}

// The buy side of a review: the bot's buy ads follow its goal as the author's
// single WTB order did. A buy goal the bot can trade remotely gets its ad
// (replacing another one); a buy goal it travels for takes the ads back
// first (the trip pays from the wallet); without a buy goal the ads stand
// while the needs still ask for their items (standingBuyNeed), else go.
async function reconcileBuyAds(state, goal, candidates) {
    const ownerId = Number(state.characterId);
    const ads = buyAds(ownerId);
    const side = desiredSide(goal);
    const lines = linesOf(ads);
    if (side !== AfkTrade.BUY) {
        if (!ads.length || (!side && standingBuyNeed(state, lines, candidates))) return { state, changed: false };
        if (state.phase !== 'cold') return { state, changed: false };
        return withdrawBuyAds(ownerId, null, state);
    }
    if (!canTradeRemotely(state, goal)) {
        if (!ads.length || state.phase !== 'cold') return { state, changed: false };
        return withdrawBuyAds(ownerId, null, state);
    }
    const wanted = buyLines({ ...state, adena: PurchaseFunding.budget(state, buyOrderEscrow(ownerId)) }, goal);
    const town = MarketTownPolicy.targetTownForItems(state, wanted);
    if (!wanted.length || (ads[0]?.town === town && sameBuyOrder({ storeType: AfkTrade.BUY, lines }, wanted))) {
        return { state, changed: false };
    }
    let shop;
    try {
        shop = await publishBuyAds(ownerId, ads, wanted, town);
    } catch (error) {
        if (staleMove(error) || error?.message === 'board_cap_reached') return { state, changed: false, reason: error.message };
        throw error;
    }
    return finishPublish(ownerId, state, shop);
}

// One buy ad per wanted item, in the town the item trades in. An ad stands
// nowhere in the world: its place is the town's centre.
async function publishBuyAds(ownerId, ads, lines, town) {
    const center = ListingService.townCenter(town) || { locX: 0, locY: 0, locZ: 0 };
    const result = await AfkTrade.replaceBotRecords(ownerId, 'buy_ad', lines.map((line) => ({
        storeType: AfkTrade.BUY,
        title: marketBuyStoreTitle([line]),
        town,
        locX: center.locX, locY: center.locY, locZ: center.locZ,
        lines: [line]
    })), { expected: Object.fromEntries(ads.map((ad) => [ad.id, ad.revision])) });
    return result.opened[0] || null;
}

// A bot in a market town asks for its goal item there: its buy ad replaces
// the ads it has (their escrow comes back first). Returns { opened, state,
// store } for ColdMarketBuyStoreService.open.
async function openBuyAd(state, goal, town) {
    const ownerId = Number(state.characterId);
    const ads = buyAds(ownerId);
    const wanted = buyLines({ ...state, adena: PurchaseFunding.budget(state, buyOrderEscrow(ownerId)) }, goal);
    if (!wanted.length) return { state, opened: false, reason: 'insufficient_budget' };
    let store;
    try {
        store = await publishBuyAds(ownerId, ads, wanted, town);
    } catch (error) {
        if (staleMove(error) || error?.message === 'board_cap_reached' || error?.message === 'not_enough_adena') {
            return { state, opened: false, reason: error.message };
        }
        throw error;
    }
    const saved = LifeState.snapshot(ownerId) || state;
    rememberInventory(ownerId, saved);
    return { state: saved, opened: !!store, item: wanted[0], store };
}

// Takes the bot's buy ads back (all, or those for one item): the escrow
// returns to its bag.
async function withdrawBuyAds(ownerId, selfId = null, state = null) {
    const ads = buyAds(ownerId).filter((ad) => selfId === null
        || (ad.lines || []).some((line) => Number(line.selfId) === Number(selfId)));
    let withdrawn = 0;
    for (const ad of ads) {
        try {
            const closed = await AfkTrade.closeBotRecord(ownerId, ad.id, { expectedRevision: ad.revision });
            if (closed.closed) withdrawn += 1;
        } catch (error) {
            if (!staleMove(error)) throw error;
        }
    }
    const current = LifeState.snapshot(ownerId) || state;
    return { state: current, changed: withdrawn > 0, withdrawn: withdrawn > 0 && withdrawn === ads.length };
}

// The sell side of a review: the bot's shop (the author's AFK sell shop).
async function reconcileSellShop(state, goal) {
    const ownerId = Number(state.characterId);
    const shop = AfkTrade.findOwnerProjection(ownerId)?.shop;
    const stock = Number(shop?.storeType) === AfkTrade.SELL ? shop : null;
    const persistentSellGoal = stock && !desiredSide(goal)
        ? { type: 'sell_inventory', status: 'active', plan: { expectedBenefit: 'market_sale_inventory' } }
        : goal;
    const side = desiredSide(persistentSellGoal);
    if (side !== AfkTrade.SELL || !canTradeRemotely(state, persistentSellGoal)) return { state, changed: false };
    const signature = stockSignature(state);
    const existingTown = stock ? MarketTownPolicy.targetTownForItems(state, stock.lines) : null;
    const review = reviewedInventory.get(ownerId);
    if (stock && review?.signature === signature && Date.now() - review.reviewedAt < SHOP_REVIEW_MS
        && review.buyerRevision === MarketBuyerActivity.revision() && stock.town === existingTown
        && stock.lines.every(viableSellLine)) return { state, changed: false };
    await MarketBuyerActivity.refresh();
    const now = Date.now();
    const expired = stock ? expiredSellLines(ownerId, stock, now) : [];
    let expiredIds = new Set();
    let pricingSaved = false;
    if (expired.length) {
        state = LifeState.snapshot(ownerId) || state;
        const before = state.stats?.marketPricing || {};
        const pricing = ListingService.pricingAfterReview(state, { items: expired }, now, true);
        // At the 50% minimum a failure changes nothing but its time: restart
        // the period without writing the state.
        const remembered = expired.some((line) => Number(before[line.selfId]?.percent ?? 100) !== pricing[line.selfId].percent
            || before[line.selfId]?.speculativeFailedAt !== pricing[line.selfId].speculativeFailedAt);
        const saved = remembered ? await LifeState.upsertState({ ...state,
            stats: { ...(state.stats || {}), marketPricing: pricing } }, 'afk_market_listing_expired') : state;
        if (saved) {
            state = saved;
            pricingSaved = remembered;
            expiredIds = new Set(expired.map((line) => line.selfId));
        }
    }
    const [characters, inventory] = await Promise.all([
        Database.execute(['SELECT * FROM characters WHERE id = ? LIMIT 1', [ownerId]], 'bot-afk:owner'),
        Database.fetchItems(ownerId)
    ]);
    const row = characters[0];
    if (!row || !String(row.username || '').startsWith('bot_')) return { state, changed: false };
    const sale = sellLines(state, stock, inventory, expiredIds);
    const lines = sale.lines;
    const town = MarketTownPolicy.targetTownForItems(state, lines);
    if (!lines.length && stock) {
        await AfkTrade.stop(ownerId);
        listingSince.delete(ownerId);
        rememberInventory(ownerId, LifeState.snapshot(ownerId) || state);
        return { state: LifeState.snapshot(ownerId) || state, changed: true, withdrawn: true };
    }
    rememberListings(ownerId, stock, lines, sale.listed, expiredIds, now);
    if (!lines.length || (stock?.town === town && sameSellOrder(stock, lines))) {
        rememberInventory(ownerId, state);
        // A remembered failure changed the saved state even when the lines did not.
        return { state, changed: pricingSaved };
    }
    if (stock?.town === town && sameSellLines(stock, lines)) {
        return finishPublish(ownerId, state, await repriceSellLines(ownerId, stock, lines));
    }
    const published = await publishSellShop(ownerId, state, stock, lines, town, row, inventory);
    if (!published.shop) return { state, changed: false, reason: published.reason };
    return finishPublish(ownerId, state, published.shop);
}

// A deal or another move changed the record after the review read it: the
// move is refused (its idempotency key) and the next review starts afresh.
function staleMove(error) {
    return error?.message === 'afk_trade_shop_changed';
}

// Publishes the bot's shop with `lines` in `town` (replacing the shop it
// has): a place on the town's square, its look, its title. Returns { shop }
// or { reason }.
async function publishSellShop(ownerId, state, stock, lines, town, row, inventory) {
    const loc = stock?.town === town
        ? { locX: stock.locX, locY: stock.locY, locZ: stock.locZ }
        : ListingService.marketLocation({ name: town }, { state, owner: ShopPlaces.afkOwner(ownerId) });
    if (!loc) return { reason: ShopPlaces.fullReason(town) };
    try {
        return { shop: await AfkTrade.publishBot(ownerId, {
            storeType: AfkTrade.SELL,
            title: marketStoreTitle(lines),
            town,
            ...loc,
            head: Number(row.head || 0),
            appearance: appearance(row, inventory),
            lines,
            ...(stock ? { expectedRevision: stock.revision } : {})
        }) };
    } catch (error) {
        AfkTrade.restorePlace(ownerId);
        if (staleMove(error)) return { reason: 'shop_changed' };
        throw error;
    }
}

// The record-backed equivalent of the author's market stall (step 3.3): a
// bot in a market town lists what the listing policy would put on a stall.
// Its shop takes up to MAX_LINES lines (kept lines first, as a review keeps
// them); each listing past the shop becomes a sell ad, up to the bot's cap;
// what fits nowhere stays in the bag. Returns { state, listed, reason }.
async function listOnBoard(state, options = {}) {
    const ownerId = Number(state.characterId);
    const current = AfkTrade.findOwnerProjection(ownerId)?.shop;
    const stock = Number(current?.storeType) === AfkTrade.SELL ? current : null;
    const [characters, inventory] = await Promise.all([
        Database.execute(['SELECT * FROM characters WHERE id = ? LIMIT 1', [ownerId]], 'bot-afk:owner'),
        Database.fetchItems(ownerId)
    ]);
    const row = characters[0];
    if (!row) return { state, listed: 0, reason: 'owner_missing' };
    const sale = sellLines(state, stock, inventory, new Set(), options);
    let listed = 0;
    let reason = null;
    let shop = stock;
    if (sale.lines.length) {
        const town = MarketTownPolicy.targetTownForItems(state, sale.lines);
        if (stock?.town === town && sameSellOrder(stock, sale.lines)) {
            listed += sale.lines.length;
        } else {
            const published = await publishSellShop(ownerId, state, stock, sale.lines, town, row, inventory);
            if (published.shop) {
                shop = published.shop;
                listed += sale.lines.length;
                rememberListings(ownerId, stock, sale.lines, sale.listed, new Set(), Date.now());
                rememberInventory(ownerId, LifeState.snapshot(ownerId) || state);
            } else {
                reason = published.reason;
            }
        }
    }
    const ads = await listSellAds(ownerId, state, sale.listings, shop);
    listed += ads.listed;
    if (listed) {
        try {
            await AfkTrade.matchAfkOrders(ownerId);
        } catch (error) {
            utils.infoWarn('BotMarket', 'board matching failed for %s: %s', state.name, error.message);
        }
    }
    return { state: LifeState.snapshot(ownerId) || state, listed, reason: reason || ads.reason };
}

// One sell ad per listing the shop has no line for, while the bot has ad
// slots left (BoardRules.BOT_RECORDS); an item it already advertises keeps
// its ad. All in one move from the bag.
async function listSellAds(ownerId, state, listings, shop) {
    const records = AfkTrade.ownerRecords(ownerId);
    const advertised = new Set(linesOf(records.filter((record) => record.kind === 'sell_ad')).map((line) => Number(line.selfId)));
    const inShop = new Set(linesOf(shop ? [shop] : []).map((line) => Number(line.selfId)));
    const free = Math.max(0, BoardRules.BOT_RECORDS.sell_ad - records.filter((record) => record.kind === 'sell_ad').length);
    if (!free) return { listed: 0, reason: 'board_cap_reached' };
    const inventory = await Database.fetchItems(ownerId);
    const configs = [];
    for (const listing of listings || []) {
        if (configs.length >= free) break;
        const selfId = Number(listing.selfId);
        if (inShop.has(selfId) || advertised.has(selfId)) continue;
        const row = inventory.find((item) => Number(item.selfId) === selfId && !Number(item.equipped)
            && Number(item.amount) > 0 && Number(item.enchant || 0) === Number(listing.enchant || 0));
        if (!row) continue;
        const stackable = ItemTemplateIndex.find(DataCache.items, selfId)?.etc?.stackable === true;
        const line = {
            objectId: Number(row.id), selfId, name: row.name || listing.name,
            count: Math.min(Number(row.amount), Math.max(1, Number(listing.count) || 1)),
            price: Number(listing.price), enchant: Number(row.enchant || 0), slot: Number(row.slot || 0),
            stackable, petData: row.petData || null
        };
        if (!viableSellLine(line)) continue;
        const town = MarketTownPolicy.targetTownForItems(state, [line]);
        const center = ListingService.townCenter(town) || { locX: 0, locY: 0, locZ: 0 };
        configs.push({ storeType: AfkTrade.SELL, title: marketStoreTitle([line]), town, ...center, lines: [line] });
        advertised.add(selfId);
    }
    if (!configs.length) return { listed: 0 };
    try {
        const result = await AfkTrade.openBotRecords(ownerId, 'sell_ad', configs);
        return { listed: result.opened.length };
    } catch (error) {
        if (['board_cap_reached', 'board_ad_exists', 'invalid_afk_trade_source', 'inventory_item_changed'].includes(error.message)) {
            return { listed: 0, reason: error.message };
        }
        throw error;
    }
}

async function reconcileOne(state, goal, candidates) {
    const ownerId = Number(state.characterId);
    const shop = AfkTrade.findOwnerProjection(ownerId)?.shop || null;
    if (shop && await repairStoreTitle(shop)) state = LifeState.snapshot(ownerId) || state;
    const buy = await reconcileBuyAds(state, goal, candidates);
    if (desiredSide(goal) === AfkTrade.BUY) return buy;
    const sell = await reconcileSellShop(buy.state || state, goal);
    return {
        ...sell,
        state: sell.state || buy.state || state,
        changed: !!(buy.changed || sell.changed),
        withdrawn: !!(buy.withdrawn || sell.withdrawn),
        shop: sell.shop || null
    };
}

async function finishPublish(ownerId, state, shop) {
    try {
        await AfkTrade.matchAfkOrders(ownerId);
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

function reconcile(state, goal, candidates = null) {
    const ownerId = Number(state?.characterId || 0);
    if (!ownerId) return Promise.resolve({ state, changed: false });
    const previous = pending.get(ownerId) || Promise.resolve();
    const next = previous.catch(() => null).then(() => reconcileOne(LifeState.snapshot(ownerId) || state, goal, candidates));
    const tracked = next.then(() => null, () => null);
    tracked.then(() => {
        if (pending.get(ownerId) === tracked) pending.delete(ownerId);
    });
    pending.set(ownerId, tracked);
    return next;
}

// The bot takes its shop and its buy ads back.
async function withdraw(ownerId) {
    const id = Number(ownerId);
    const shop = AfkTrade.findOwnerProjection(id)?.shop;
    const bot = String(shop?.ownerAccount || '').startsWith('bot_');
    const result = bot ? await AfkTrade.stop(id) : { stopped: false };
    const ads = await withdrawBuyAds(id);
    reviewedInventory.delete(id);
    listingSince.delete(id);
    return { ...result, stopped: !!result.stopped || ads.withdrawn };
}

module.exports = { buyOrderEscrow, canTradeRemotely, desiredSide, listOnBoard, minimumResourceLotValue, openBuyAd,
    pruneResourceLots, reconcile, rememberInventory, viableSellLine, withdraw, withdrawBuyAds,
    _resetForTests() { reviewedInventory.clear(); listingSince.clear(); pending.clear(); } };
