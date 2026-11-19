const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');
const DataCache = invoke('GameServer/DataCache');
const BotEconomyPricing = invoke('GameServer/Bot/Economy/BotEconomyPricing');
// The NPC side is the one NPC price table (town sellers, cheapest row), main's
// and the workers' snapshot of it.
const { npcPriceOf } = invoke('GameServer/Bot/Economy/BotMarketPricing');
const NpcSellRules = invoke('GameServer/Items/NpcSellRules');
const OfferQuery = require('./OfferQuery');
// Loaded once: a require() per cheapestPurchase resolved the path on disk each call (~55% of it).
const production = require('./ProductionPolicy');
const FixedShotOffers = require('./FixedShotOffers');
const { SELL, BUY } = require('../../AfkTrade/BoardIndex');
const { isMainThread } = require('node:worker_threads');
const NpcShopPriceScale = require('../../World/Generics/NpcShopPriceScale');
const ProgressionRates = invoke('GameServer/ProgressionRates');

const BUYBACK_RATIO = 0.9;
let boardSource = null;

function basePrice(selfId) {
    return Number(ItemTemplateIndex.find(DataCache.items, selfId)?.template?.price || 0);
}

// A configured store sells at the datapack price, x1 at every preset (the
// maintainer's rule, econ decision 450: shop prices do not follow the server's
// adena rate). The gear reserve (npcRate) sells at npcRate x the datapack price.
function configuredPrice(line) {
    if (line.price !== undefined) return Number(line.price);
    const base = basePrice(line.selfId);
    if (line.npcRate !== undefined) return Math.max(1, Math.round(base * line.npcRate));
    return Math.max(1, Math.round(base > 0 ? base * (line.priceRate ?? 1) : 1));
}

// What a fixed buy line pays, one price for a bot and a player. Our choice,
// not C4 (C4 gives only the NPC buy-back at half the datapack price): the
// merchant pays half again the NPC buy-back, or a quarter of the datapack
// price at the adena rate where that is more, so a buy store reads as a
// plausible buyer at x1 and at x50 alike. An explicit line price replaces
// both. It stays under 0.9 of the cheapest repeatable NPC or fixed-store
// supply, so nobody buys an item to sell it straight back here.
const BUY_OVER_NPC = 1.5;
const BUY_BASE_SHARE = 0.25;
function buyLinePrice(line) {
    const base = basePrice(line.selfId);
    const price = line.price !== undefined ? Number(line.price)
        : Math.max(Math.floor(NpcSellRules.npcBuyPrice(base) * BUY_OVER_NPC), BotEconomyPricing.scalePrice(base * BUY_BASE_SHARE));
    return Math.min(price, Math.floor(cheapestPurchase(line.selfId) * BUYBACK_RATIO));
}

// A bot is paid the line price alone: it reaches a board bid through its own
// sale decision, which answers bids before the fixed buyers.
function botPriceFor(store, line) {
    return Number(store.storeType) === BUY ? buyLinePrice(line) : configuredPrice(line);
}

// Configured supply is independent of the board: bots keep its original
// price until 3.6. Index it once per loaded config, effective Adena rate and
// progression multiplier (the NPC price scale of npcRate lines).
let fixedConfig = null;
let fixedRate = null;
let fixedMultiplier = null;
let sellers = new Map();
let fixedMinimums = new Map();
function refreshFixedOffers() {
    const config = invoke('GameServer/Bot/MerchantStoreConfigs');
    const rate = BotEconomyPricing.economyRate();
    const multiplier = ProgressionRates.profile().multiplier;
    if (fixedConfig === config && fixedRate === rate && fixedMultiplier === multiplier) return;
    fixedConfig = config;
    fixedRate = rate;
    fixedMultiplier = multiplier;
    sellers = new Map();
    fixedMinimums = new Map();
    const openMinimums = new Map();
    for (const [name, store] of Object.entries(config)) {
        if (Number(store?.storeType) !== SELL) continue;
        for (const line of store.items || []) {
            if (!(Number(line.count ?? 1) > 0)) continue;
            const id = Number(line.selfId);
            const price = configuredPrice(line);
            // A row sold to named classes only (a crafter's gear row) is no buyer's price
            // where an open row sells the item; a scroll sold to the spoiler line only keeps its.
            if (!line.buyerClasses) openMinimums.set(id, Math.min(openMinimums.get(id) ?? Infinity, price));
            fixedMinimums.set(id, Math.min(fixedMinimums.get(id) ?? Infinity, price));
            if (store.town) {
                if (!sellers.has(id)) sellers.set(id, []);
                sellers.get(id).push({ town: store.town, price, sourceName: name, reserve: line.reserve === true,
                    ...(line.buyerClasses ? { buyerClasses: line.buyerClasses, hourlyStock: Number(line.hourlyStock) } : {}),
                    ...(line.valve ? { valve: line.valve } : {}),
                    ...(line.boardMarkup ? { boardMarkup: Number(line.boardMarkup) } : {}) });
            }
        }
    }
    for (const [id, price] of openMinimums) fixedMinimums.set(id, price);
}

// The cheapest repeatable supply of an item: NPC shops and the configured city
// stores. forBot: only where a bot may buy it (the configured reserve rows,
// FixedShotOffers: a city store sells a bot its shots and its reserve gear
// lines), the one price every bot purchase path reads.
function cheapestPurchase(selfId, { forBot = false } = {}) {
    refreshFixedOffers();
    const id = Number(selfId);
    const minimum = forBot ? FixedShotOffers.lowestPrice(id) : fixedMinimums.get(id) ?? Infinity;
    return forBot && !production.allowsNpcShot(id) ? minimum : Math.min(minimum, npcPriceOf(id));
}

// The configured city merchants selling an item, by town. This remains the
// authored supply for bot shot trips, never the player's board-relative price.
function sellersOf(selfId) {
    refreshFixedOffers();
    return sellers.get(Number(selfId)) || [];
}

function validPrice(line, minimum = 1) {
    return Number.isSafeInteger(Number(line.price)) && Number(line.price) >= minimum;
}

// Escrow shops deliver directly. Conditional ads require the player at the
// meeting point; a remote ad must not establish this merchant's quote.
function buyOffers(selfId, { actor, viewerId = 0, enchant = 0 } = {}) {
    const afk = invoke('GameServer/AfkTrade/AfkTradeService');
    return afk.offers(selfId, BUY, {
        characterId: actor?.fetchId?.() || viewerId, enchant, limit: 5,
        accept: offer => ['shop', 'buy_ad'].includes(offer.recordKind) && validPrice(offer)
            && (!(offer.conditional || offer.store?.conditional) || actor && Math.hypot(
                Number(actor.fetchLocX?.()) - Number(offer.locX),
                Number(actor.fetchLocY?.()) - Number(offer.locY),
                Number(actor.fetchLocZ?.()) - Number(offer.locZ)) <= 200)
    });
}

// The player's quote: the line price, or the best board bid above it.
function buyQuote(store, line, options = {}) {
    const linePrice = buyLinePrice(line);
    const offers = buyOffers(line.selfId, options);
    const price = Math.max(linePrice, ...offers.map(offer => Number(offer.price)));
    const count = price === linePrice ? Number(line.count ?? 1)
        : offers.filter(offer => Number(offer.price) === price)
            .reduce((sum, offer) => sum + Number(offer.storeItem.count), 0);
    return { price, count: Math.min(Number(line.count ?? 1), count), linePrice,
        offers: offers.filter(offer => Number(offer.price) === price) };
}

// The player's static price is read from the one board at the window and
// transaction, not at spawn. Shops and ads share the same item-side index;
// orders are another goal and do not establish an ordinary purchase bid.
function priceFor(store, line, { viewerId = 0, actor = null, enchant = 0 } = {}) {
    const index = invoke('GameServer/AfkTrade/AfkTradeService').boardIndex();
    if (Number(store.storeType) === BUY) {
        if (actor) return buyQuote(store, line, { actor, viewerId, enchant }).price;
        const bid = index.first(line.selfId, BUY, {
            excludeOwner: Number(viewerId) || 0,
            accept: candidate => ['shop', 'buy_ad'].includes(candidate.kind) && validPrice(candidate)
        });
        return Math.max(buyLinePrice(line), Number(bid?.price || 0));
    }
    const price = configuredPrice(line);
    if (Number(store.storeType) !== SELL) return price;
    const ask = OfferQuery.bestSellOffer(index, line.selfId, {
        accept: offer => ['shop', 'sell_ad'].includes(offer.recordKind) && validPrice(offer, 0)
    });
    return ask ? Math.max(price, Number(ask.price)) : price;
}

// An NPC shop's price of an item for a bot: the NPC price table's (the
// configured city stores excluded: their reserve is its own offer rows,
// FixedShotOffers); a dearer town's tax quotes above it.
// Infinity where no town NPC sells it to bots. The survival kit's price
// (EconomyContext.survivalPrice).
function botNpcListPrice(selfId) {
    const id = Number(selfId);
    return require('./ProductionPolicy').allowsNpcShot(id) ? npcPriceOf(id) : Infinity;
}

// A graded shot's replacement cost is the public stock price, else recent
// paid trades, else the native materials-and-labour estimate. These are
// valuations, not an unlimited supply or permission to buy from a fixed shop.
function shotPrice(id, npc) {
    const board = boardSource ? boardSource()
        : isMainThread ? invoke('GameServer/AfkTrade/AfkTradeService').boardIndex() : null;
    const ask = board?.first(id, SELL, { enchant: 0,
        accept: row => ['shop', 'sell_ad'].includes(row.kind) && Number(row.count) > 0
            && Number(row.price) > 0 && Number.isFinite(Number(row.price)) });
    const quoted = Math.min(npc, Number(ask?.price || Infinity));
    if (Number.isFinite(quoted)) return quoted;
    const counters = require('./MarketCounters');
    const evidence = counters.itemPriceEvidence(id);
    if (Number.isFinite(evidence.logMedian)) return Math.max(1, Math.round(Math.exp(evidence.logMedian)));
    const made = counters.firstPrice(id);
    return Number.isFinite(made) && made > 0 ? made : BotEconomyPricing.scalePrice(basePrice(id));
}

// The common consumable valuation of the hunt model, stock and shot-use policy.
function botBuyPrice(id) {
    const npc = cheapestPurchase(id, { forBot: true });
    if (require('./ProductionPolicy').GRADED_SHOTS.has(Number(id))) return shotPrice(Number(id), npc);
    return Number.isFinite(npc) ? npc : Math.max(0, Number(ItemTemplateIndex.find(DataCache.items, id)?.template?.price || 0));
}

module.exports = { BUYBACK_RATIO, botPriceFor, configuredPrice, buyQuote, cheapestPurchase, botPurchasePrice: id => cheapestPurchase(id, { forBot: true }), botNpcListPrice, botBuyPrice,
    priceFor, sellersOf, useBoard: source => { boardSource = source; } };
