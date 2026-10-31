const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');
const DataCache = invoke('GameServer/DataCache');
const BotEconomyPricing = invoke('GameServer/Bot/Economy/BotEconomyPricing');
// Authored shop rows are pure data and are shared with cold craft decisions.
const NpcShopBuyLists = require('../../World/Generics/NpcShopBuyLists');
const NpcSellRules = invoke('GameServer/Items/NpcSellRules');
const OfferQuery = require('./OfferQuery');
const { SELL, BUY } = require('../../AfkTrade/BoardIndex');

const BUYBACK_RATIO = 0.9;
let npcOffers = new Map();
let npcRate = null;
function refreshNpcOffers() {
    const rate = invoke('GameServer/ProgressionRates').profile().multiplier;
    if (npcRate === rate) return;
    npcRate = rate;
    npcOffers = new Map();
    for (const line of NpcShopBuyLists.allOffers()) {
        const id = Number(line.selfId);
        if (!npcOffers.has(id)) npcOffers.set(id, []);
        npcOffers.get(id).push(line);
    }
}

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

function cheapestPurchase(selfId, { forBot = false } = {}) {
    refreshNpcOffers();
    refreshFixedOffers();
    const id = Number(selfId);
    const production = require('./ProductionPolicy');
    let minimum = forBot && production.shotsDisabled() && (production.GRADED_SHOTS.has(id) || production.NO_GRADE_SHOTS.has(id))
        ? Infinity : fixedMinimums.get(id) ?? Infinity;
    if (forBot && !production.allowsNpcShot(id)) return minimum;
    for (const line of npcOffers.get(id) || []) {
        minimum = Math.min(minimum, Number(line.price ?? basePrice(id)));
    }
    return minimum;
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

// What a bot pays an NPC for an item at the current rate, else (no NPC sells
// it) its template price: the baseline consumable price of the hunt model.
function botBuyPrice(id) {
    const npc = cheapestPurchase(id, { forBot: true });
    return Number.isFinite(npc) ? npc : Math.max(0, Number(ItemTemplateIndex.find(DataCache.items, id)?.template?.price || 0));
}

module.exports = { BUYBACK_RATIO, botPriceFor, buyQuote, cheapestPurchase, botPurchasePrice: id => cheapestPurchase(id, { forBot: true }), botBuyPrice,
    priceFor, sellersOf };
