const ClassProgression = invoke('GameServer/ClassProgression');
const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const ListingPolicy = invoke('GameServer/Bot/Economy/MarketListingPolicy');
const ListingService = invoke('GameServer/Bot/Economy/ColdMarketListingService');
const BuyStoreService = invoke('GameServer/Bot/Economy/ColdMarketBuyStoreService');
const MarketTownPolicy = invoke('GameServer/Bot/Economy/MarketTownPolicy');
const ShopPlaces = invoke('GameServer/Bot/Economy/ShopPlaces');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const MarketPricing = invoke('GameServer/Bot/Economy/MarketPricing');
const PurchaseFunding = invoke('GameServer/Bot/Economy/PurchaseFunding');
const LotPolicy = require('./MarketLotPolicy');
const { isNativeSource } = require('./TradeIntent');
const Diagnostics = require('./EconomyDiagnostics');
const EconomyCommit = require('./EconomyCommit');
const { marketStoreTitle, marketBuyStoreTitle } = invoke('GameServer/Bot/Economy/MarketStoreTitle');

const BoardRules = require('../../AfkTrade/BoardRules');
const BotBuyShopService = require('./BotBuyShopService');
const BidPurchaseAlternative = require('./BidPurchaseAlternative');
const EconomicTrip = require('./EconomicTrip');
const ColdEconomyDecision = require('../Population/ColdEconomyDecision');
const ReadyTradeChoice = require('./ReadyTradeChoice');
const ShotCraftPolicy = require('./ShotCraftPolicy');
const ColdShotEconomyService = require('./ColdShotEconomyService');
const TradeMeetingService = require('../../AfkTrade/TradeMeetingService');
const BuyAdPolicy = require('./BuyAdPolicy');
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

// Adena reserved by the bot's own purchase shop remains part of its budget
// when reviewing or replacing its bids.
function buyOrderEscrow(characterId) {
    return AfkTrade.ownerRecords(characterId).reduce((sum, record) => (
        Number(record.storeType) === AfkTrade.BUY ? sum + Math.max(0, Number(record.escrowAdena || 0)) : sum
    ), 0);
}

// Both purchase channels follow the same need and withdrawal lifecycle.
function buyAds(characterId) {
    return AfkTrade.ownerRecords(characterId).filter((record) => record.kind === 'buy_ad'
        || record.kind === 'shop' && Number(record.storeType) === AfkTrade.BUY);
}

// A continuing item's ad keeps its town. A new wanted item opens by the
// same weighted decision as a shop; karma closes every town but Floran.
function buyAdTown(state, ads, wanted) {
    return MarketTownPolicy.buyAdTown(state, wanted, ads.flatMap(ad => (ad.lines || []).map(line => ({
        ...line, recordId: ad.id, kind: ad.kind, storeType: ad.storeType, town: ad.town
    }))));
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
        if (!invoke('GameServer/Items/ItemAcquisitionCatalog').hasSource(goal.target?.itemId)) return false;
        // A purchase planned at an NPC or configured shot shop is made there,
        // never through a WTB; in town the bot
        // still takes a cheaper listing if one is there.
        if (isNativeSource(goal.plan?.sourceType)) return false;
        // A selected executable player quote has a physical purchase owner.
        // Publishing a bid is not completion of that purchase.
        if (goal.plan?.sourceType === 'afk' && goal.plan?.priceSource === 'offer') return false;
        const existing = linesOf(buyAds(state.characterId));
        const reserved = buyOrderEscrow(state.characterId);
        const budgetState = { ...state, adena: PurchaseFunding.budget(state, reserved) };
        // The offer as the buyer weighs it: its price and its trip there (б5, C7).
        const offer = MarketOpportunity.bestOffer(goal.target?.itemId, {
            town: goal.plan?.marketTown || null,
            budget: PurchaseFunding.spendable(state, reserved, PurchaseFunding.goalTerms(goal)),
            buyerCharacterId: state.characterId,
            cost: invoke('GameServer/Bot/Economy/ColdMarketService').tripFrom(state)
        });
        if (isNativeSource(offer?.sourceType) && goal.plan?.priceSource !== 'offer') return false;
        if (reserved && existing.some((line) => Number(line.selfId) === Number(goal.target?.itemId))) return true;
        return !!BuyStoreService.bidFor(budgetState, goal, { money: BuyAdPolicy.goalMoney(state, goal, reserved) });
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
    // Own buy-ad lines passed source admission when they opened (BuyAdPolicy);
    // saved ones from before that rule close at board start.
    const items = new Set(lines.filter((line) => Number(line.count) > 0).map((line) => Number(line.selfId)));
    if (!items.size) return false;
    const needs = candidates || invoke('GameServer/Bot/Goals/NeedsEvaluator').evaluate(state);
    // ARCH-NOTE: NeedsEvaluator's native survival floor carries rest/revive
    // in plan.kind; it no longer sets the retired target.condition field.
    // Recovery defers wish judgement, while a native store plan holds no WTB.
    if (needs.length === 1 && (needs[0].target?.condition === 'alive_and_recovered'
        || needs[0].type === 'recover' && ['rest', 'revive'].includes(needs[0].plan?.kind))) {
        return !isNativeSource(state.stats?.equipmentPlan?.market?.sourceType);
    }
    // A purchase planned at a native store never holds a WTB, rest or not.
    return needs.some((need) => desiredSide(need) === AfkTrade.BUY && !isNativeSource(need.plan?.sourceType)
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
    const classInfo = ClassProgression.firstClassRow(DataCache.classTemplates || [], row.classId);
    return {
        model: { ...row, ...utils.crushOb(classInfo || {}) },
        paperdoll: utils.tupleAlloc(16, {}),
        items: items.filter((item) => Number(item.equipped) === 1)
            .map((item) => ({ ...item, equipped: true }))
    };
}

function viableSellLine(line) {
    return LotPolicy.viable(line)
        && invoke('GameServer/Items/ItemAcquisitionCatalog').hasSource(line.selfId);
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

const lineKey = line => `${Number(line.selfId)}:${Number(line.enchant || 0)}`;
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
            enchant: Math.max(Number(previous.enchant || 0), Number(line.enchant || 0)),
            instances: [...(previous.instances || []), {id:Number(line.sourceObjectId || line.objectId),amount:count,
                equipped:false,slot:line.slot,enchant:Number(line.enchant || 0)}]
        };
    }
    return { ...state, inventory: combined };
}

// The bot's shop lines and what it lists past them (sell ads), from the
// sale decision (MarketListingPolicy.evaluate) on its bag and its shop: a kept
// line keeps its price (the bot's own look reprices it, MarketPricing.look); a new
// one is listed at the bot's ask. The most valuable unit asks fill the shop
// first; the rest become ads. Returns { lines, listed, listings }.
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
            petData: line.petData || null,
            fills: Number(line.fills || 0),
            pricing: line.pricing
        })) : [];
    const classified = evaluateOptions.decided || decide(state, stock, existing, evaluateOptions);
    const listings = classified.listings;
    const remaining = new Map(listings.map((item) => [lineKey(item), Number(item.count)]));
    const listed = new Map((classified.decisions || [])
        .filter((decision) => decision.action === 'list')
        .map((decision) => [lineKey(decision.item), decision]));
    const next = [];
    const keepExisting = (line) => {
        if (next.length >= MAX_LINES) return;
        const available = Math.max(0, Number(remaining.get(lineKey(line)) || 0));
        if (!available) return;
        const count = Math.min(line.count, available);
        next.push({ ...line, count });
        remaining.set(lineKey(line), available - count);
    };
    const appendListing = (listing) => {
        if (next.length >= MAX_LINES) return;
        const available = inventory.filter((row) => Number(row.selfId) === Number(listing.selfId)
            && !row.equipped && Number(row.amount) > 0 && Number(row.enchant || 0) === Number(listing.enchant || 0));
        for (const row of available) {
            const count = Math.min(Number(row.amount), Math.max(0, Number(remaining.get(lineKey(listing)) || 0)));
            if (count <= 0) continue;
            const stackable = ItemTemplateIndex.find(DataCache.items, row.selfId)?.etc?.stackable === true;
            const matching = stackable && next.find((line) => Number(line.selfId) === Number(row.selfId)
                && Number(line.enchant || 0) === Number(row.enchant || 0));
            if (matching) {
                matching.count += count;
                remaining.set(lineKey(listing), Number(remaining.get(lineKey(listing))) - count);
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
                petData: row.petData || null,
                pricing: listing.pricing
            });
            remaining.set(lineKey(listing), Number(remaining.get(lineKey(listing))) - count);
            break;
        }
    };
    for (const listing of ListingPolicy.prioritizeListings(listings, { board: AfkTrade.boardIndex(),
        characterId: state.characterId, timestamp: evaluateOptions.now })) {
        existing.filter(line => lineKey(line) === lineKey(listing)).forEach(keepExisting);
        appendListing(listing);
    }
    return { lines: next.filter(viableSellLine).slice(0, MAX_LINES), listed, listings };
}

// The sale decision (MarketListingPolicy.evaluate) over the bot's bag and its
// shop's stock: the shop's lines keep their slot and price, its sell ads
// take their slots.
function decide(state, stock, existing, options = {}) {
    const own = AfkTrade.boardIndex().ownerLines(Number(state.characterId)).filter(line => line.storeType === AfkTrade.SELL);
    return ListingPolicy.evaluate(stateWithEscrow(state, stock), {
        ...options, economy: options.economy || ColdEconomyDecision.economyFor(state),
        stockQuotes: true, slots: ListingPolicy.BOARD_SLOTS,
        kept: new Map([...own, ...existing].map((line) => [lineKey(line), line.price])),
        conditionalKept: new Set(own.filter(line => line.custodyPolicy === 1).map(lineKey))
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

// The bot's buy ad lines carry the quote, its authored worth and cursors.
function buyLines(state, goal, options = {}) {
    return invoke('GameServer/Bot/Economy/BuyAdPolicy').linesFor(state, goal, {
        board: AfkTrade.boardIndex(), ...options, townFor: items => buyAdTown(state, buyAds(state.characterId), items)
    });
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

// Source admission is fixed when an ad opens (BuyAdPolicy, the wish gates);
// only a saved ad from before that rule can lack a source. The board start
// closes such ads once through the native batch withdrawal/refund owner.
async function withdrawSourceInvalidBuyAds(ownerId) {
    ownerId = Number(ownerId);
    const withdrawals = [];
    let sourceChanged = false;
    for (const ad of buyAds(ownerId)) {
        const remaining = (ad.lines || []).filter(line => Number(line.count) > 0);
        const invalid = remaining.filter(line => !invoke('GameServer/Items/ItemAcquisitionCatalog').hasSource(line.selfId));
        if (!invalid.length) continue;
        if (invalid.every(line => line.pricing)) {
            for (const line of invalid) withdrawals.push({ recordId: ad.id, lineId: line.id,
                expectedRevision: ad.revision, previousPricing: { ...line.pricing } });
        } else if (invalid.length === remaining.length) {
            // Legacy lines without a pricing cursor can close only a wholly
            // impossible record; unrelated valid stock keeps its native owner.
            try {
                const result = await AfkTrade.closeBotRecord(ownerId, ad.id, { expectedRevision: ad.revision });
                sourceChanged = sourceChanged || result.closed;
            }
            catch (error) { if (!staleMove(error)) throw error; }
        }
    }
    if (withdrawals.length) {
        const result = await AfkTrade.repriceBotLines(ownerId, [], { withdrawals });
        sourceChanged = sourceChanged || Number(result.changed) > 0;
    }
    return sourceChanged;
}

// The buy side of a review: the bot's buy ads follow its goal as the author's
// single WTB order did. A buy goal the bot can trade remotely gets its ad
// (replacing another one); a buy goal it travels for takes the ads back
// first (the trip pays from the wallet); without a buy goal the ads stand
// while the needs still ask for their items (standingBuyNeed), else go.
async function reduceStandingBids(state, ads, { beforeWrite } = {}) {
    const hour = Number(state.stats?.money?.[0]);
    if (state.phase !== 'cold' || !ads.length || !Number.isFinite(hour) || hour < 0
        || state.stats?.tradeMeeting) return false;
    // A preparation is still a quote, checked by record revision at native
    // acceptance. It cannot lock an overpriced remaining ad indefinitely.
    // Native lifecycle transitions can have no worker plan. Compare only the
    // owner's five bids against reserved stock/NPCs and known routes, using the
    // existing money packet; this does not build or value a wish graph.
    const trip = EconomicTrip.reader(state, { hourAdena: hour });
    const ctx = { state, characterId: Number(state.characterId), adena: Number(state.adena), hour,
        board: AfkTrade.boardIndex(), travelDetails: trip.details,
        npcOffersFor: selfId => MarketOpportunity.npcOffersAll(selfId) };
    const reprices = [], withdrawals = [];
    for (const ad of ads) for (const line of ad.lines || []) {
        if (!line.pricing || !(line.count > 0)) continue;
        const owned = { ...line, town: ad.town, custodyPolicy: ad.custodyPolicy };
        const ceiling = Math.min(BidPurchaseAlternative.forLine(owned, ctx), BidPurchaseAlternative.cashCap(owned, ctx));
        if (!Number.isSafeInteger(ceiling) || ceiling < 0 || ceiling >= line.price) continue;
        const move = { lineId: line.id, recordId: ad.id, selfId: line.selfId,
            expectedRevision: ad.revision, previousPricing: { ...line.pricing } };
        if (!ceiling) withdrawals.push(move);
        else reprices.push({ ...move, price: ceiling, pricing: { ...line.pricing, price: ceiling } });
    }
    if (!reprices.length && !withdrawals.length) return false;
    beforeWrite?.();
    const result = await AfkTrade.repriceBotLines(state.characterId, reprices, { withdrawals,
        coldAuthority: EconomyCommit.authority(state),
        canCommitReview: beforeWrite ? () => { beforeWrite(); return true; } : null });
    if (result.skipped) throw Error('afk_trade_shop_changed');
    return true;
}

async function reviewPurchaseLimits(state, options = {}) {
    const ownerId = Number(state.characterId);
    state = LifeState.snapshot(ownerId) || state;
    try {
        const changed = await reduceStandingBids(state, buyAds(ownerId), options);
        return { state: LifeState.snapshot(ownerId) || state, changed };
    } catch (error) {
        if (staleMove(error) || error.message === 'economy_plan_need_changed')
            return { state: LifeState.snapshot(ownerId) || state, changed: false, reason: error.message };
        throw error;
    }
}

async function reconcileBuyAds(state, goal, candidates) {
    const ownerId = Number(state.characterId);
    const checked = await reviewPurchaseLimits(state);
    if (checked.reason) return checked;
    state = checked.state;
    const ads = buyAds(ownerId), corrected = checked.changed;
    // Only the core's buy step opens or widens an ad (MVP-1): a goal without
    // a buy side never borrows the first watched item as a guessed target.
    const side = desiredSide(goal);
    const lines = linesOf(ads);
    const retained = new Set(require('./TradeIntent').retainedProjectIntents(state, { moneyPrice: 1 }, () => 1)
        .map(row => Number(row.itemId)));
    const withdrawUnrelated = async () => {
        if (!retained.size) return withdrawBuyAds(ownerId, null, state);
        let current = state, changed = corrected;
        for (const id of new Set(lines.map(line => Number(line.selfId)).filter(id => !retained.has(id)))) {
            const result = await withdrawBuyAds(ownerId, id, current);
            current = result.state || current; changed ||= result.changed;
        }
        return { state: current, changed };
    };
    if (side !== AfkTrade.BUY) {
        if (!ads.length || (!side && standingBuyNeed(state, lines, candidates))) return { state, changed: corrected };
        if (state.phase !== 'cold') return { state, changed: false };
        return withdrawUnrelated();
    }
    if (!canTradeRemotely(state, goal)) {
        if (!ads.length || state.phase !== 'cold') return { state, changed: false };
        return withdrawUnrelated();
    }
    // Keep the raw wallet for the item check: a precomputed cap must not subtract R twice.
    const escrow = buyOrderEscrow(ownerId);
    const wanted = buyLines({ ...state, adena: PurchaseFunding.budget(state, escrow) }, goal,
        { money: BuyAdPolicy.goalMoney(state, goal, escrow) });
    const town = buyAdTown(state, ads, wanted);
    if (!wanted.length) return ads.length ? withdrawUnrelated() : { state, changed: false };
    let published;
    try {
        published = await publishBuyAds(ownerId, ads, wanted, town, null, desiredSide(goal));
    } catch (error) {
        if (staleMove(error) || error?.message === 'board_cap_reached') return { state, changed: false, reason: error.message };
        throw error;
    }
    return { ...await finishPublish(ownerId, state, published.shop), changed: corrected || published.changed };
}

// Retain authored prices, then divide prepared needs between the physical
// purchase shop and the remaining meeting adverts in this town.
async function publishBuyAds(ownerId, ads, lines, town, expectedAuthority = null, priority = 0) {
    // Reconciliation deliberately retains a continuing line's price. Apply
    // only violated prepared limits through the existing fenced price writer
    // before quantity reconciliation, including a native town review.
    const reprices = [];
    for (const ad of ads) if (ad.town === town) for (const line of ad.lines || []) {
        const wanted = lines.find(row => Number(row.selfId) === Number(line.selfId)
            && Number(row.enchant || 0) === Number(line.enchant || 0));
        if (BuyAdPolicy.withinCap(line.price, wanted?.purchaseCap) || !line.pricing) continue;
        reprices.push({ recordId: ad.id, lineId: line.id, selfId: line.selfId, expectedRevision: ad.revision,
            previousPricing: { ...line.pricing }, price: wanted.price, pricing: { ...line.pricing, price: wanted.price } });
    }
    if (reprices.length) {
        const result = await AfkTrade.repriceBotLines(ownerId, reprices, {
            ...(expectedAuthority?.phase === 'cold' ? { coldAuthority: expectedAuthority }
                : expectedAuthority?.phase === 'hot' ? { hotAuthority: expectedAuthority } : {})
        });
        if (result.skipped) throw Error('afk_trade_shop_changed');
    }
    const state = LifeState.snapshot(ownerId);
    return BotBuyShopService.publish(state, lines, town, { priority, expectedAuthority,
        appearance: async () => {
            const [rows, inventory] = await Promise.all([
                Database.execute(['SELECT * FROM characters WHERE id=? LIMIT 1', [ownerId]], 'bot-afk:buyer'),
                Database.fetchItems(ownerId, 'bot_afk_buy_appearance')
            ]);
            if (!rows[0]) throw Error('afk_trade_owner_missing');
            return appearance(rows[0], inventory);
        } });
}

// A bot asks in the town chosen by the shop opening roll: its buy ad replaces
// the ads it has (their escrow comes back first). Returns { opened, state,
// store } for ColdMarketBuyStoreService.open.
async function openBuyAd(state, goal) {
    const ownerId = Number(state.characterId);
    const ads = buyAds(ownerId);
    // Keep the raw wallet for the item check: a precomputed cap must not subtract R twice.
    const escrow = buyOrderEscrow(ownerId);
    const wanted = buyLines({ ...state, adena: PurchaseFunding.budget(state, escrow) }, goal,
        { money: BuyAdPolicy.goalMoney(state, goal, escrow) });
    if (!wanted.length) return { state, opened: false, reason: 'insufficient_budget' };
    const town = buyAdTown(state, ads, wanted);
    let store;
    try {
        store = (await publishBuyAds(ownerId, ads, wanted, town, null, AfkTrade.BUY)).shop;
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
            if (selfId !== null && ad.kind === 'shop') {
                const withdrawals = ad.lines.filter(line => Number(line.selfId) === Number(selfId) && line.count > 0)
                    .map(line => ({ lineId: line.id, recordId: ad.id, expectedRevision: ad.revision,
                        previousPricing: line.pricing || null }));
                const result = await AfkTrade.repriceBotLines(ownerId, [], { withdrawals });
                if (result.changed) withdrawn++;
                continue;
            }
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
// come from the bot's event review (MarketPricing.look), not a fixed review
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
    // The account is on the bot's life state (accountName = characters.username).
    if (!BoardRules.isBotAccount(state.accountName)) return { state, changed: false };
    const inventory = await Database.fetchItems(ownerId, 'market_reconcile_shop');
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
        // The shop's look (head, appearance) is the owner's character row: read only to publish.
        const [row] = await Database.execute(['SELECT * FROM characters WHERE id = ? LIMIT 1', [ownerId]], 'bot-afk:owner');
        if (!row) return { state, changed: false };
        const published = await publishSellShop(ownerId, state, stock, lines, stock.town, row, inventory);
        if (!published.shop) return { state, changed: false, reason: published.reason };
        shop = published.shop;
    }
    const advertisingInventory = shop !== stock ? await Database.fetchItems(ownerId) : inventory;
    const ads = await listSellAds(ownerId, state, sale.listings, shop, advertisingInventory);
    if (shop === stock && !ads.listed) {
        rememberInventory(ownerId, state);
        return { state, changed: false };
    }
    return finishPublish(ownerId, state, shop);
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
            promoteAds: AfkTrade.ownerRecords(ownerId).filter(record => record.kind === 'sell_ad'
                && record.custodyPolicy === 1 && record.lines.some(line => lines.some(next => lineKey(line) === lineKey(next))))
                .map(record => ({ id: record.id, revision: record.revision })),
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
// shopTown }.
async function listOnBoard(state, options = {}) {
    const ownerId = Number(state.characterId);
    const current = AfkTrade.findOwnerProjection(ownerId)?.shop;
    const stock = Number(current?.storeType) === AfkTrade.SELL ? current : null;
    const [characters, inventory] = await Promise.all([
        Database.execute(['SELECT * FROM characters WHERE id = ? LIMIT 1', [ownerId]], 'bot-afk:owner'),
        Database.fetchItems(ownerId, 'market_list_on_board')
    ]);
    const row = characters[0];
    if (!row) return { state, listed: 0, reason: 'owner_missing' };
    const sale = sellLines(state, stock, inventory, options);
    if (Number(current?.storeType) === AfkTrade.BUY && options.priority !== AfkTrade.SELL) {
        const ads = await listSellAds(ownerId, state, sale.listings, null, inventory, options);
        return { state, listed: ads.listed, reason: ads.reason, shopTown: null };
    }
    let listed = 0;
    let reason = null;
    let shop = stock;
    let shopTown = null;
    const visitTown = state.activity === 'shopping' && ShopPlaces.hasPlaza(state.currentRegion)
        && invoke('GameServer/Bot/Economy/BotImprovementService').inTown(state) ? state.currentRegion : null;
    const town = sale.lines.length ? stock?.town || options.planTowns?.get(lineKey(sale.lines[0]))
        || options.planTowns?.get(Number(sale.lines[0].selfId))
        || state.stats?.shopTown?.town || visitTown || MarketTownPolicy.openingTown(state, sale.lines, options.now).town : null;
    if (town && !stock && town !== state.currentRegion) {
        // The shop opens in its own town: the bot goes there with its lines.
        shopTown = town;
        shop = { lines: sale.lines };
    } else if (town) {
        if (stock && sameSellOrder(stock, sale.lines)) {
            listed += sale.lines.length;
        } else {
            const published = await publishSellShop(ownerId, state, stock || current, sale.lines, town, row, inventory);
            if (published.shop) {
                shop = published.shop;
                listed += sale.lines.length;
                rememberInventory(ownerId, LifeState.snapshot(ownerId) || state);
            } else {
                reason = published.reason;
            }
        }
    }
    const advertisingInventory = shop && shop !== stock && !shopTown ? await Database.fetchItems(ownerId) : inventory;
    const ads = await listSellAds(ownerId, state, sale.listings, shop, advertisingInventory, options);
    listed += ads.listed;
    return { state: LifeState.snapshot(ownerId) || state, listed, reason: reason || ads.reason, shopTown };
}

// The owner's sell-ad room: the lines already up (its ads, the shop) and
// the free ad records.
function sellAdRoom(ownerId, shop) {
    const ads = AfkTrade.ownerRecords(ownerId).filter((record) => record.kind === 'sell_ad');
    return { advertised: new Set(linesOf(ads).map(lineKey)), inShop: new Set(linesOf(shop ? [shop] : []).map(lineKey)),
        free: Math.max(0, BoardRules.BOT_RECORDS.sell_ad - ads.length) };
}

// One sell ad per listing the shop has no line for, while the bot has ad
// slots left (BoardRules.BOT_RECORDS); an item it already advertises keeps
// its ad. All in one move from the bag. `inventory`: the bag the caller read
// for this review; a shop published since took only items of its own lines,
// which no ad takes (a row that changed meanwhile refuses the move).
// `inventory` may be a loader instead: it is read only when the board still
// has room for a listing not yet up (the room is read again after it).
async function listSellAds(ownerId, state, listings, shop, inventory, options = {}) {
    if (typeof inventory === 'function') {
        const room = sellAdRoom(ownerId, shop);
        if (!room.free) return { listed: 0, reason: 'board_cap_reached' };
        if (!(listings || []).some((listing) => !room.inShop.has(lineKey(listing))
            && !room.advertised.has(lineKey(listing)))) return { listed: 0 };
        inventory = await inventory();
    }
    const { advertised, inShop, free } = sellAdRoom(ownerId, shop);
    if (!free) return { listed: 0, reason: 'board_cap_reached' };
    const configs = [];
    for (const listing of listings || []) {
        if (configs.length >= free) break;
        const selfId = Number(listing.selfId);
        if (inShop.has(lineKey(listing)) || advertised.has(lineKey(listing))) continue;
        const row = inventory.find((item) => Number(item.selfId) === selfId && !Number(item.equipped)
            && Number(item.amount) > 0 && Number(item.enchant || 0) === Number(listing.enchant || 0));
        if (!row) continue;
        const stackable = ItemTemplateIndex.find(DataCache.items, selfId)?.etc?.stackable === true;
        const line = {
            objectId: Number(row.id), selfId, name: row.name || listing.name,
            count: Math.min(Number(row.amount), Math.max(1, Number(listing.count) || 1)),
            price: Number(listing.price), enchant: Number(row.enchant || 0), slot: Number(row.slot || 0),
            stackable, petData: row.petData || null, pricing: listing.pricing
        };
        if (!viableSellLine(line)) continue;
        const town = options.planTowns?.get(lineKey(line)) || options.planTowns?.get(selfId)
            || MarketTownPolicy.shopTown(state, [line]);
        const center = ListingService.townCenter(town) || { locX: 0, locY: 0, locZ: 0 };
        configs.push({ storeType: AfkTrade.SELL, title: marketStoreTitle([line]), town, ...center, lines: [line] });
        advertised.add(lineKey(listing));
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

// Executes only the worker's quoted lines. The native writers validate
// current item/record rows; a failed step is dropped by the coordinator's
// existing after-commit guard, and the next resolve can decide again.
async function executePlan(state, plan, { step = work => work(), beforeWrite = () => {}, preparedState = state, reviewGoal = true } = {}) {
    if (state.stats?.tradeMeeting || invoke('GameServer/AfkTrade/TradeMeetingService').hasPreparation(state.characterId)) return { state, pending: true };
    const ownerId = Number(state.characterId);
    const authority = EconomyCommit.authority(preparedState);
    const stillPrepared = () => EconomyCommit.sameAuthority(EconomyCommit.authority(LifeState.cachedState(ownerId) || state), authority);
    const run = async (work) => {
        const result = await step(() => Database.withMutationAdmission(beforeWrite, work));
        state = LifeState.cachedState(ownerId) || result?.state || state;
        return result;
    };
    // No native writer reads accepted incoming. Units that reached the bag or
    // an obligation accepted since the decision may already fill a purchase:
    // it waits for the worker's new card (buyPending) instead of buying twice.
    const card = preparedState.phase === 'cold' ? invoke('GameServer/Bot/Population/ColdSimulationCoordinator')
        .economyDecisions?.decided?.(preparedState)?.activity : null;
    const heldAtDecision = itemId => Number(card?.itemId) === Number(itemId) && Number.isFinite(Number(card.heldAtDecision))
        ? Number(card.heldAtDecision) : ColdEconomyDecision.heldFor(preparedState, itemId);
    const filledSince = itemId => ColdEconomyDecision.heldFor(LifeState.cachedState(ownerId) || state, itemId) > heldAtDecision(itemId);
    if (plan.bidLimits?.length) await run(async () => {
        if (!stillPrepared()) throw Error('economy_plan_need_changed');
        if (!Array.isArray(plan.bidLimits) || plan.bidLimits.length > MAX_LINES + BoardRules.BOT_RECORDS.buy_ad) throw Error('economy_plan_bid_cap');
        const reprices = [], withdrawals = [], seen = new Set(), ads = buyAds(ownerId);
        for (const row of plan.bidLimits) {
            if (!Array.isArray(row) || row.length !== 6 || !row.every(Number.isSafeInteger)
                || row.slice(0, 5).some(value => value < 1) || row[5] < 0 || row[5] >= row[4] || seen.has(row[0]))
                throw Error('economy_plan_bid_cap');
            seen.add(row[0]);
            const [lineId, recordId, revision, count, price, ceiling] = row;
            const ad = ads.find(record => record.id === recordId);
            const line = ad?.lines.find(candidate => candidate.id === lineId);
            if (!line?.pricing || ad.revision !== revision || line.count !== count || line.price !== price)
                throw Error('afk_trade_shop_changed');
            const move = { lineId, recordId, selfId: line.selfId, expectedRevision: revision,
                previousPricing: { ...line.pricing } };
            if (!ceiling) withdrawals.push(move);
            else reprices.push({ ...move, price: ceiling, pricing: { ...line.pricing, price: ceiling } });
        }
        const result = await AfkTrade.repriceBotLines(ownerId, reprices, { withdrawals,
            ...(authority.phase === 'cold' ? { coldAuthority: authority } : { hotAuthority: authority }) });
        if (result.skipped) throw Error('afk_trade_shop_changed');
        return result;
    });
    if (plan.take) {
        if (!stillPrepared()) return { state, tradeDeferred: true };
        const buying = plan.take[0] === AfkTrade.SELL;
        if (buying && filledSince(plan.take[1])) return { state, buyPending: true };
        const line = ReadyTradeChoice.resolve(plan.take, AfkTrade.boardIndex(), ownerId);
        // The tuple's item passed source admission where it was made: a wish
        // network item node (purchase) or the sale classification (answer).
        if (!line) return { state, tradeDeferred: true };
        const offer = AfkTrade.offerOf(line);
        if (!offer) return { state, tradeDeferred: true };
        const result = await run(async () => {
            if (!stillPrepared()) return { state, tradeDeferred: true };
            if (buying && filledSince(plan.take[1])) return { state, buyPending: true };
            try {
                const trade = buying ? AfkTrade.buyFromShop : AfkTrade.sellToShop;
                return await trade(ownerId, offer.store, line.selfId, plan.take[2], {
                    lineId: line.lineId, expectedRevision: line.revision, expectedPrice: line.price, coldState: state
                });
            } catch (error) {
                // A counterpart may change its need, wallet, stock or route
                // during bilateral preparation. Keep the old records; do not
                // turn rejection into new consent or an immediate retry loop.
                if (/^(trade_meeting_|economy_|afk_trade_|board_|not_enough_adena)/.test(error.message))
                    return { state, tradeDeferred: true, reason: error.message };
                throw error;
            }
        });
        return { ...result, state: LifeState.cachedState(ownerId) || state };
    }
    // A craft step runs under the prepared authority like a take: a stale
    // step waits for the worker's new card.
    const crafted = plan.shot ? await run(async () => {
        if (!stillPrepared()) return { state, stale: true };
        const shot = ShotCraftPolicy.unpackStep(plan.shot);
        if (shot.wealth) {
            const Wealth = invoke('GameServer/Bot/Economy/ColdWealthCraftService');
            if (!Wealth.eligible(state)) return { state };
            const refusal = {};
            const opportunity = Wealth.recheck(state, shot.wealth, undefined, refusal);
            return opportunity ? Wealth.execute(state, opportunity, { stillPrepared })
                : { state: await Wealth.rejectAccepted(state, state, refusal) };
        }
        return { state: await ColdShotEconomyService.execute(state, shot) };
    }) : null;
    if (crafted?.stale) return { state, buyPending: true };
    if (TradeMeetingService.hasPreparation(ownerId)) return { state, pending: true };
    if (plan.withdraw?.length) await run(async () => {
        const own = new Map(AfkTrade.boardIndex().ownerLines(ownerId).map(line => [line.lineId, line]));
        const withdrawals = [];
        let invalid = false;
        for (const lineId of new Set(plan.withdraw.slice(0, 8).map(Number))) {
            const line = own.get(lineId);
            // The earlier board review or a fill may already have removed it.
            // Its absence is the completed intent, not another stock return.
            if (!line) continue;
            if (line.storeType !== AfkTrade.SELL) { invalid = true; continue; }
            withdrawals.push({ lineId: line.lineId, recordId: line.recordId,
                expectedRevision: line.revision, previousPricing: line.pricing ? { ...line.pricing } : null });
        }
        // Use the same native batch writer as a board review: one transaction,
        // one inventory publication and one fence per original record snapshot.
        const result = withdrawals.length ? await AfkTrade.repriceBotLines(ownerId, [], { withdrawals,
            canCommitReview: () => { beforeWrite(); return true; } }) : { changed: 0, skipped: 0 };
        if (invalid || result.skipped) throw Error('economy_plan_line_changed');
        return result;
    });
    if (plan.sell?.length) await run(async () => {
        // A line's pricing state (MarketPricing.lineState) reads the persona,
        // the board and the item beliefs, never the hunt/stock forecast: the
        // card context serves it. Only an enchanted line's belief reads
        // economy.price; that line takes the full context, built once.
        const ctx = ListingPolicy.cardTraderContext(state);
        let full = null;
        const lineContext = enchant => {
            if (!(enchant > 0)) return ctx;
            if (!full && Diagnostics.active()) Diagnostics.count('trader_context', 'full', 'enchanted_sale');
            return full ||= ListingPolicy.traderContext(state, { now: ctx.timestamp });
        };
        if (Diagnostics.active()) Diagnostics.count('trader_context', 'card', 'plan_sell');
        // Listings come from MarketListingPolicy.evaluate: sale candidates
        // and classify already admitted their sources.
        let ownSell = null; // read once: the map below writes nothing
        const listings = plan.sell.slice(0, 8).map(([selfId, count, price, , plannedEnchant]) => {
            const item = ItemTemplateIndex.find(DataCache.items, selfId);
            let enchant = plannedEnchant;
            if (enchant === undefined) {
                // Older prepared plans can only select a unique enchant.
                const bag = state.inventory?.[selfId], copies = (bag?.instances || []).filter(row => !row.equipped && row.amount > 0);
                const enchants = new Set([...copies.map(row => Number(row.enchant || 0)),
                    ...(ownSell ||= AfkTrade.boardIndex().ownerLines(ownerId).filter(line => line.storeType === AfkTrade.SELL))
                        .filter(line => line.selfId === Number(selfId))
                        .map(line => Number(line.enchant || 0))]);
                if (!enchants.size) enchants.add(Number(bag?.enchant || 0));
                if (enchants.size !== 1) throw Error('economy_plan_ambiguous_copies');
                enchant = [...enchants][0];
            }
            if (!Number.isSafeInteger(enchant) || enchant < 0) throw Error('economy_plan_invalid_enchant');
            return { selfId: Number(selfId), count: Number(count), price: Number(price), enchant,
                name: item?.template?.name || `Item ${selfId}`, kind: item?.template?.kind || '',
                pricing: MarketPricing.lineState(selfId, lineContext(enchant),
                    { price: Number(price), storeType: AfkTrade.SELL, enchant, count: Number(count) }) };
        });
        const planTowns = new Map(listings.map((line, at) => [lineKey(line), plan.sell[at][3]]));
        // The worker marks promotion at a real visit (or a standing shop's
        // refresh). Never manufacture a town visit from a field quote.
        const current = AfkTrade.findOwnerProjection(ownerId)?.shop;
        const shop = Number(current?.storeType) === AfkTrade.SELL ? current : null;
        if (plan.shop) {
            if (state.phase !== 'cold' || (current ? current.town !== plan.shop
                : state.activity !== 'shopping' || state.currentRegion !== plan.shop
                    || !invoke('GameServer/Bot/Economy/BotImprovementService').inTown(state)))
                return { state, reason: 'shop_visit_changed' };
            return listOnBoard(state, { decided: { listings }, planTowns, priority: plan.buyShop });
        }
        return listSellAds(ownerId, state, listings, shop,
            () => Database.fetchItems(ownerId, 'market_execute_plan'), { planTowns });
    });
    // An empty desired list closes the old ads; it does not run another bid
    // decision on main. The plan's quote remains the quote the worker made.
    // An earlier native improvement/craft/sale may have filled the root or
    // changed its inputs. Publishing its old certificate at the new revision
    // would manufacture fresh authority from stale need. Keep it pending.
    const filledAd = () => (plan.buyAds || []).slice(0, MAX_LINES + BoardRules.BOT_RECORDS.buy_ad).some(row => filledSince(row[0]));
    if (Object.hasOwn(plan, 'buyAds') && (!stillPrepared() || filledAd())) return { state, buyPending: true };
    const published = Object.hasOwn(plan, 'buyAds') ? await run(async () => {
        if (!stillPrepared()) throw Error('economy_plan_need_changed');
        if (filledAd()) return { state, buyPending: true };
        // One read of the owner's records: nothing below writes before publishBuyAds.
        const ads = buyAds(ownerId), escrow = buyOrderEscrow(ownerId);
        if (Object.hasOwn(plan, 'buyCaps') && (!Array.isArray(plan.buyCaps) || plan.buyCaps.length !== plan.buyAds.length
            || plan.buyCaps.some((cap, at) => cap !== null && (!Number.isSafeInteger(cap) || cap < 1 || plan.buyAds[at][2] > cap))))
            throw Error('economy_plan_bid_cap');
        // Unenchanted bids: their pricing state needs no forecast (see plan.sell).
        const ctx = ListingPolicy.cardTraderContext(state);
        if (Diagnostics.active()) Diagnostics.count('trader_context', 'card', 'plan_buy');
        let money = PurchaseFunding.budget(state, escrow);
        // Planned bids come from BuyAdPolicy.linesFor: bidFor admitted each source.
        // A survival item's ad may spend its kit cost from the survival
        // reserve, as the meeting and the NPC restock do (each item once):
        // the tranche the worker decided the bid with (plan.buyKit).
        let wanted = (plan.buyAds || []).slice(0, MAX_LINES + BoardRules.BOT_RECORDS.buy_ad).map((row, at) => {
            const [selfId, count, price] = row;
            const intent = row.length === 9 ? require('./TradeIntent').decode(row) : null;
            const survivalCost = Math.max(0, Math.round(Number(plan.buyKit?.[at]) || 0));
            if (!(selfId > 0 && count > 0 && price > 0) || !intent && count * price > money
                || count * price > PurchaseFunding.spendable(state, escrow,
                    { ...(intent ? { r: intent.valueRate } : { itemId: selfId }), survivalCost })) {
                throw Error('economy_plan_bid_unfunded');
            }
            if (!intent) money -= count * price;
            const item = ItemTemplateIndex.find(DataCache.items, selfId);
            return { selfId, count, price, intent, survivalCost, purchaseCap: plan.buyCaps?.[at] ?? Infinity,
                enchant: 0, name: item?.template?.name || `Item ${selfId}`,
                slot: Number(item?.etc?.slot || 0), stackable: item?.etc?.stackable === true,
                pricing: MarketPricing.lineState(selfId, ctx,
                    { price, storeType: AfkTrade.BUY, enchant: 0, count: Number(count) }) };
        });
        // A standing bid may have been repriced since worker preparation.
        // Bound its prepared quantity at the price reconciliation will keep;
        // this does not choose a new price or rebuild the worker's wishes.
        const budgetState = { ...state, adena: PurchaseFunding.budget(state, escrow) };
        const owned = AfkTrade.boardIndex().ownerLines(ownerId);
        wanted = BuyAdPolicy.keepRetainedBids(state, owned, wanted, Number(state.stats?.money?.[1]), escrow);
        let town = buyAdTown(state, ads, wanted);
        for (let pass = 0; pass <= MAX_LINES + BoardRules.BOT_RECORDS.buy_ad; pass++) {
            wanted = BuyAdPolicy.retainedLines(budgetState, wanted, owned, town);
            const nextTown = buyAdTown(state, ads, wanted);
            if (!wanted.length || nextTown === town) break;
            town = nextTown;
        }
        if (!wanted.length) {
            if (ads.length) await publishBuyAds(ownerId, ads, [], ads[0].town, authority);
            return { state: LifeState.cachedState(ownerId) || state };
        }
        await publishBuyAds(ownerId, ads, wanted, town, authority, plan.buyShop || 0);
        return { state: LifeState.cachedState(ownerId) || state };
    }) : null;
    if (published?.buyPending) return { state, buyPending: true };
    if (!reviewGoal) return { state };
    await run(async () => {
        const snapshot = await invoke('GameServer/Bot/Goals/GoalService').review(state, { saleTown: plan.sell?.[0]?.[3] || state.stats?.shopTown?.town });
        const goal = snapshot?.current;
        if (!plan.travel || goal?.plan?.wishKey !== plan.travel) return { state };
        const travel = invoke('GameServer/Bot/Goals/GoalExecutor').beginMarketTravel(state, goal);
        return { state: travel ? await LifeState.upsertState(travel, 'worker_economy_market_travel') : state };
    });
    return { state };
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
async function applyReview(ownerId, review = {}, { coldAuthority = null, hotAuthority = null, canCommitReview = null } = {}) {
    // Prices and withdrawals share one fence, including lines of the same
    // record. Rows from an older worker have no revision and wait for a look
    // from a worker that has the current board format.
    const result = await AfkTrade.repriceBotLines(Number(ownerId), review.reprices || [], {
        withdrawals: review.withdrawals || [],
        updates: review.updates || [],
        coldAuthority,
        hotAuthority,
        canCommitReview
    });
    return { changed: result.changed, updated: result.updated || 0 };
}

module.exports = { executePlan, applyReview, buyOrderEscrow, buyLines, reconcileBuyAds, reviewPurchaseLimits, withdrawSourceInvalidBuyAds, canTradeRemotely, desiredSide, listOnBoard, openBuyAd,
    saleDecision,
    pruneResourceLots, reconcile, rememberInventory, viableSellLine, withdraw, withdrawBuyAds,
    _resetForTests() { reviewedInventory.clear(); pending.clear(); } };
