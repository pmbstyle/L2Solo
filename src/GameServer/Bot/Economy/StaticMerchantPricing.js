const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');
const DataCache = invoke('GameServer/DataCache');
const BotEconomyPricing = invoke('GameServer/Bot/Economy/BotEconomyPricing');
// The NPC side is the one NPC price table (town sellers, cheapest row), main's
// and the workers' snapshot of it.
const { npcPriceOf } = invoke('GameServer/Bot/Economy/BotMarketPricing');
const NpcSellRules = invoke('GameServer/Items/NpcSellRules');
const OfferQuery = require('./OfferQuery');
const { SELL, BUY } = require('../../AfkTrade/BoardIndex');
const { isMainThread } = require('node:worker_threads');

const BUYBACK_RATIO = 0.9;
let boardSource = null;

function basePrice(selfId) {
    return Number(ItemTemplateIndex.find(DataCache.items, selfId)?.template?.price || 0);
}

function configuredPrice(line) {
    if (line.price !== undefined) return Number(line.price);
    const base = basePrice(line.selfId);
    return BotEconomyPricing.scalePrice(base > 0 ? base * (line.priceRate ?? 1) : 1);
}

function botPriceFor(store, line) {
    const price = configuredPrice(line);
    if (Number(store.storeType) !== BUY) return price;
    // Bound fixed-buyer payouts below repeatable NPC and fixed-store supply.
    const ceiling = Math.floor(cheapestPurchase(line.selfId) * BUYBACK_RATIO);
    return Math.min(price, ceiling);
}

// Configured supply is independent of the board: bots keep its original
// price until 3.6. Index it once per loaded config and effective Adena rate.
let fixedConfig = null;
let fixedRate = null;
let sellers = new Map();
let fixedMinimums = new Map();
function refreshFixedOffers() {
    const config = invoke('GameServer/Bot/MerchantStoreConfigs');
    const rate = BotEconomyPricing.economyRate();
    if (fixedConfig === config && fixedRate === rate) return;
    fixedConfig = config;
    fixedRate = rate;
    sellers = new Map();
    fixedMinimums = new Map();
    for (const [name, store] of Object.entries(config)) {
        if (Number(store?.storeType) !== SELL) continue;
        for (const line of store.items || []) {
            if (!(Number(line.count ?? 1) > 0)) continue;
            const id = Number(line.selfId);
            const price = configuredPrice(line);
            fixedMinimums.set(id, Math.min(fixedMinimums.get(id) ?? Infinity, price));
            if (store.town) {
                if (!sellers.has(id)) sellers.set(id, []);
                sellers.get(id).push({ town: store.town, price, sourceName: name });
            }
        }
    }
}

// The cheapest repeatable supply of an item: NPC shops and the configured city
// stores. forBot: only where a bot may buy it (ProductionPolicy: a city store
// sells a bot only shots), the one price every bot purchase path reads.
function cheapestPurchase(selfId, { forBot = false } = {}) {
    refreshFixedOffers();
    const id = Number(selfId);
    const production = require('./ProductionPolicy');
    const minimum = !forBot || production.allowsFixedShot(id) ? fixedMinimums.get(id) ?? Infinity : Infinity;
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

function buyQuote(store, line, options = {}) {
    const npcPrice = NpcSellRules.npcBuyPrice(basePrice(line.selfId));
    const offers = buyOffers(line.selfId, options);
    const price = Math.max(npcPrice, ...offers.map(offer => Number(offer.price)));
    const count = price === npcPrice ? Number(line.count ?? 1)
        : offers.filter(offer => Number(offer.price) === price)
            .reduce((sum, offer) => sum + Number(offer.storeItem.count), 0);
    return { price, count: Math.min(Number(line.count ?? 1), count), npcPrice,
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
        return bid ? bid.price : NpcSellRules.npcBuyPrice(basePrice(line.selfId));
    }
    const price = configuredPrice(line);
    if (Number(store.storeType) !== SELL) return price;
    const ask = OfferQuery.bestSellOffer(index, line.selfId, {
        accept: offer => ['shop', 'sell_ad'].includes(offer.recordKind) && validPrice(offer, 0)
    });
    return ask ? Math.max(price, Number(ask.price)) : price;
}

// An NPC shop's price of an item for a bot: the NPC price table's (the
// configured city stores excluded: they sell a bot only shots,
// ProductionPolicy.allowsFixedShot); a dearer town's tax quotes above it.
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

module.exports = { BUYBACK_RATIO, botPriceFor, buyQuote, cheapestPurchase, botPurchasePrice: id => cheapestPurchase(id, { forBot: true }), botNpcListPrice, botBuyPrice,
    priceFor, sellersOf, useBoard: source => { boardSource = source; } };
