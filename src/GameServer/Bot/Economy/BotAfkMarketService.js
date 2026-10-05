const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const ListingPolicy = invoke('GameServer/Bot/Economy/MarketListingPolicy');
const PriceBelief = invoke('GameServer/Bot/Economy/PriceBelief');
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
const Karma = require('../../Karma');
const MAX_LINES = BoardRules.BOT_SHOP_LINES;
const reviewedInventory = new Map();
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

// A continuing item's ad keeps its town. A new wanted item opens by the
// same weighted decision as a shop; karma closes every town but Floran.
function buyAdTown(state, ads, wanted) {
    const standing = ads.find((ad) => (ad.lines || []).some((line) =>
        wanted.some((item) => Number(item.selfId) === Number(line.selfId))));
    return standing && Karma.townFor(state.stats?.karma, standing.town) === standing.town
        ? standing.town : MarketTownPolicy.shopTown(state, wanted);
}

function linesOf(records) {
    return records.flatMap((record) => (record.lines || []).filter((line) => Number(line.count) > 0));
}

function canTradeRemotely(state, goal) {
    const side = desiredSide(goal);
    if (!state || state.phase !== 'cold'
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
        // The offer as the buyer weighs it: its price and its trip there (б5, C7).
        const offer = MarketOpportunity.bestOffer(goal.target?.itemId, {
            town: goal.plan?.marketTown || null,
            budget: PurchaseFunding.spendable(state, reserved),
            buyerCharacterId: state.characterId,
            cost: invoke('GameServer/Bot/Economy/ColdMarketService').tripFrom(state)
        });
        if (offer?.sourceType === 'npc' && goal.plan?.priceSource !== 'offer') return false;
        if (reserved && existing.some((line) => Number(line.selfId) === Number(goal.target?.itemId))) return true;
        return !!BuyStoreService.bidFor(budgetState, goal);
    }
    // Opening a shop needs the seller in its town (user, 2026-10-05): only a
    // bot that has its shop sells from afar.
    return hasShop(state.characterId);
}

function hasShop(characterId) {
    return Number(AfkTrade.findOwnerProjection(characterId)?.shop?.storeType) === AfkTrade.SELL;
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
    if (state) reviewedInventory.set(Number(ownerId), { signature: stockSignature(state) });
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

// The bot's shop lines and what it lists past them (sell ads), from the
// sale decision (MarketListingPolicy.evaluate) on its bag and its shop: a kept
// line keeps its price (the bot's own look reprices it, MarketPricing.look); a new
// one is listed at the bot's ask. Shots fill the shop first, as the author's
// review placed them. Returns { lines, listed, listings, book }.
function sellLines(state, stock, inventory, evaluateOptions = {}) {
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
    const classified = evaluateOptions.decided || decide(state, stock, existing, evaluateOptions);
    const listings = classified.listings;
    const priorityMarketItems = new Set(classified.listings
        .filter((item) => String(item.kind || '').startsWith('Other.Shot'))
        .map((item) => Number(item.selfId)));
    const remaining = new Map(listings.map((item) => [Number(item.selfId), Number(item.count)]));
    const listed = new Map((classified.decisions || [])
        .filter((decision) => decision.action === 'list')
        .map((decision) => [Number(decision.item.selfId), decision]));
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
    return { lines: next.filter(viableSellLine).slice(0, MAX_LINES), listed, listings, book: classified.book };
}

// The sale decision (MarketListingPolicy.evaluate) over the bot's bag and its
// shop's stock: the shop's lines keep their slot and price, its sell ads
// take their slots.
function decide(state, stock, existing, options = {}) {
    const ads = AfkTrade.ownerRecords(Number(state.characterId)).filter((record) => record.kind === 'sell_ad').length;
    return ListingPolicy.evaluate(stateWithEscrow(state, stock), {
        ...options, slots: Math.max(0, ListingPolicy.BOARD_SLOTS - ads),
        kept: new Map(existing.map((line) => [line.selfId, line.price]))
    });
}

// A market visit's one sale decision (one decision point, evaluated once):
// what goes into the buy ads of the town, to the NPC, onto the board
// (listOnBoard takes it as options.decided).
function saleDecision(state, options = {}) {
    const shop = AfkTrade.findOwnerProjection(state.characterId)?.shop;
    const stock = Number(shop?.storeType) === AfkTrade.SELL ? shop : null;
    const existing = stock ? stock.lines.filter((line) => Number(line.count) > 0)
        .map((line) => ({ selfId: Number(line.selfId), price: Number(line.price) })) : [];
    return decide(state, stock, existing, options);
}

// The bot's buy ad lines for its goal, with the beliefs that keep its bid
// (lines.book, saved when the ad is published).
function buyLines(state, goal) {
    const bid = BuyStoreService.bidFor(state, goal);
    if (!bid) return [];
    const item = ItemTemplateIndex.find(DataCache.items, bid.selfId);
    const lines = [{
        selfId: Number(bid.selfId),
        name: bid.name,
        count: Number(bid.count),
        price: Number(bid.price),
        enchant: 0,
        slot: Number(item?.etc?.slot || 0),
        stackable: item?.etc?.stackable === true
    }];
    lines.book = bid.book;
    return lines;
}

// The bot's buy ads ask for the same items and counts: their bids are the
// bot's own look's (MarketPricing.look), as a kept sell line's ask is.
function sameBuyOrder(stock, lines) {
    if (Number(stock?.storeType) !== AfkTrade.BUY || stock.lines.length !== lines.length) return false;
    return stock.lines.every((line, index) => Number(line.selfId) === Number(lines[index].selfId)
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
            shop = await AfkTrade.repriceBot(ownerId, current[index].id, lines[index].price, shop.revision);
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
    const town = buyAdTown(state, ads, wanted);
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
    return finishPublish(ownerId, await keepBeliefs(state, wanted.book), shop);
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

// A bot asks in the town chosen by the shop opening roll: its buy ad replaces
// the ads it has (their escrow comes back first). Returns { opened, state,
// store } for ColdMarketBuyStoreService.open.
async function openBuyAd(state, goal) {
    const ownerId = Number(state.characterId);
    const ads = buyAds(ownerId);
    const wanted = buyLines({ ...state, adena: PurchaseFunding.budget(state, buyOrderEscrow(ownerId)) }, goal);
    if (!wanted.length) return { state, opened: false, reason: 'insufficient_budget' };
    const town = buyAdTown(state, ads, wanted);
    let store;
    try {
        store = await publishBuyAds(ownerId, ads, wanted, town);
    } catch (error) {
        if (staleMove(error) || error?.message === 'board_cap_reached' || error?.message === 'not_enough_adena') {
            return { state, opened: false, reason: error.message };
        }
        throw error;
    }
    const saved = await keepBeliefs(LifeState.snapshot(ownerId) || state, wanted.book);
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

// The sell side of a review: the bot's shop (the author's AFK sell shop),
// reviewed from afar once it stands. It changes when the bag changed or a
// line is no longer a lot, and never moves (N51, E46); what is listed past
// its lines goes to sell ads, which need no trip. The prices of its lines
// are the bot's own look (attention, MarketPricing.look), not a fixed review
// period. A bot without a shop opens one in town (listOnBoard).
async function reconcileSellShop(state, goal) {
    const ownerId = Number(state.characterId);
    const current = AfkTrade.findOwnerProjection(ownerId)?.shop;
    const stock = Number(current?.storeType) === AfkTrade.SELL ? current : null;
    const persistentSellGoal = stock && !desiredSide(goal)
        ? { type: 'sell_inventory', status: 'active', plan: { expectedBenefit: 'market_sale_inventory' } }
        : goal;
    const side = desiredSide(persistentSellGoal);
    if (side !== AfkTrade.SELL || !canTradeRemotely(state, persistentSellGoal)) return { state, changed: false };
    const signature = stockSignature(state);
    const review = reviewedInventory.get(ownerId);
    if (review?.signature === signature && stock.lines.every(viableSellLine)) return { state, changed: false };
    const [characters, inventory] = await Promise.all([
        Database.execute(['SELECT * FROM characters WHERE id = ? LIMIT 1', [ownerId]], 'bot-afk:owner'),
        Database.fetchItems(ownerId)
    ]);
    const row = characters[0];
    if (!row || !String(row.username || '').startsWith('bot_')) return { state, changed: false };
    const sale = sellLines(state, stock, inventory);
    const lines = sale.lines;
    if (!lines.length) {
        await AfkTrade.stop(ownerId);
        rememberInventory(ownerId, LifeState.snapshot(ownerId) || state);
        return { state: LifeState.snapshot(ownerId) || state, changed: true, withdrawn: true };
    }
    let shop = stock;
    if (sameSellLines(stock, lines)) {
        if (!sameSellOrder(stock, lines)) shop = await repriceSellLines(ownerId, stock, lines) || stock;
    } else {
        const published = await publishSellShop(ownerId, state, stock, lines, stock.town, row, inventory);
        if (!published.shop) return { state, changed: false, reason: published.reason };
        shop = published.shop;
    }
    const ads = await listSellAds(ownerId, state, sale.listings, shop, inventory);
    if (shop === stock && !ads.listed) {
        rememberInventory(ownerId, state);
        return { state, changed: false };
    }
    return finishPublish(ownerId, await keepBeliefs(state, sale.book), shop);
}

// The bot keeps its beliefs of what it listed from afar, as at a market
// visit, so the sales that follow are learned (group E follow-up).
async function keepBeliefs(state, book) {
    const written = book ? PriceBelief.writeBook(book) : null;
    if (!written) return state;
    const current = LifeState.snapshot(state.characterId) || state;
    if (current.phase !== 'cold') return current;
    return await LifeState.upsertState({ ...current, stats: { ...(current.stats || {}), priceBeliefs: written } },
        'board_remote_listing_beliefs') || current;
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
// what fits nowhere stays in the bag. A shop stands where it was opened; a
// new one opens in the town the bot chose for it (MarketTownPolicy.openingTown,
// one roll): when that is another town, its lines wait in the bag and
// shopTown names the town to travel to. Returns { state, listed, reason,
// shopTown, priceBeliefs }.
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
    const sale = sellLines(state, stock, inventory, options);
    let listed = 0;
    let reason = null;
    let shop = stock;
    let shopTown = null;
    const town = sale.lines.length ? stock?.town || MarketTownPolicy.openingTown(state, sale.lines, options.now).town : null;
    if (town && !stock && town !== state.currentRegion) {
        // The shop opens in its own town: the bot goes there with its lines.
        shopTown = town;
        shop = { lines: sale.lines };
    } else if (town) {
        if (stock && sameSellOrder(stock, sale.lines)) {
            listed += sale.lines.length;
        } else {
            const published = await publishSellShop(ownerId, state, stock, sale.lines, town, row, inventory);
            if (published.shop) {
                shop = published.shop;
                listed += sale.lines.length;
                rememberInventory(ownerId, LifeState.snapshot(ownerId) || state);
            } else {
                reason = published.reason;
            }
        }
    }
    const ads = await listSellAds(ownerId, state, sale.listings, shop, inventory);
    listed += ads.listed;
    return { state: LifeState.snapshot(ownerId) || state, listed, reason: reason || ads.reason, shopTown,
        priceBeliefs: sale.book ? PriceBelief.writeBook(sale.book) : null };
}

// One sell ad per listing the shop has no line for, while the bot has ad
// slots left (BoardRules.BOT_RECORDS); an item it already advertises keeps
// its ad. All in one move from the bag. `inventory`: the bag the caller read
// for this review; a shop published since took only items of its own lines,
// which no ad takes (a row that changed meanwhile refuses the move).
async function listSellAds(ownerId, state, listings, shop, inventory) {
    const records = AfkTrade.ownerRecords(ownerId);
    const advertised = new Set(linesOf(records.filter((record) => record.kind === 'sell_ad')).map((line) => Number(line.selfId)));
    const inShop = new Set(linesOf(shop ? [shop] : []).map((line) => Number(line.selfId)));
    const free = Math.max(0, BoardRules.BOT_RECORDS.sell_ad - records.filter((record) => record.kind === 'sell_ad').length);
    if (!free) return { listed: 0, reason: 'board_cap_reached' };
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
        const town = MarketTownPolicy.shopTown(state, [line]);
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
    await AfkTrade.repriceBot(shop.ownerId, lines[0].id, lines[0].price, shop.revision);
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
    return { ...result, stopped: !!result.stopped || ads.withdrawn };
}

// What the bot's own look decided (MarketPricing.look in the cold worker): new asks of
// its lines and new bids of its buy ads, lines whose best outcome is now the
// NPC (they leave the board; the NPC buys them at the next town visit) and
// buy ads no bid gains for (their escrow comes back). A line a deal or
// another move changed meanwhile waits for the next look.
async function applyReview(ownerId, review = {}) {
    // Prices and withdrawals share one fence, including lines of the same
    // record. Rows from an older worker have no revision and wait for a look
    // from a worker that has the current board format.
    const result = await AfkTrade.repriceBotLines(Number(ownerId), review.reprices || [], {
        withdrawals: review.withdrawals || []
    });
    return { changed: result.changed };
}

module.exports = { applyReview, buyOrderEscrow, canTradeRemotely, desiredSide, listOnBoard, minimumResourceLotValue, openBuyAd,
    saleDecision,
    pruneResourceLots, reconcile, rememberInventory, viableSellLine, withdraw, withdrawBuyAds,
    _resetForTests() { reviewedInventory.clear(); pending.clear(); } };
