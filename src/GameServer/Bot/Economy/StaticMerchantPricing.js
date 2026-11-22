const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');
const DataCache = invoke('GameServer/DataCache');
const BotEconomyPricing = invoke('GameServer/Bot/Economy/BotEconomyPricing');
const PriceAnchor = require('./PriceAnchor');
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

const BUYBACK_RATIO = 0.9;
let boardSource = null;

function basePrice(selfId) {
    return Number(ItemTemplateIndex.find(DataCache.items, selfId)?.template?.price || 0);
}

// A configured store line (the player's) sells at the datapack price x its priceRate
// x the server's Adena rate (BotEconomyPricing): x50 at x50, like the hunt Adena that
// pays for it. A hidden reserve row (a bot's only static row) sells at its npcRate x
// the bot-side anchor (PriceAnchor), a spoiler scroll row (boardMarkup) at its npcRate
// x the datapack price until the board has deals (FixedShotOffers.priced). Our rule;
// the NPC shops keep C4's datapack price.
function configuredPrice(line) {
    if (line.price !== undefined) return Number(line.price);
    const base = basePrice(line.selfId);
    if (line.reserve === true && line.npcRate !== undefined)
        return Math.max(1, Math.round(line.npcRate * (line.boardMarkup ? base : PriceAnchor.anchor(line.selfId))));
    return BotEconomyPricing.scalePrice(Math.max(1, Math.round(base > 0 ? base * (line.priceRate ?? 1) : 1)));
}

// What a fixed buy line pays, one price for a bot and a player. Our choice,
// not C4 (C4 gives only the NPC buy-back at half the datapack price): the
// merchant pays half again the NPC buy-back x the server's Adena rate, so a
// buy store reads as a plausible buyer at x1 and at x50 alike. An explicit
// line price replaces it. It stays under 0.9 of the cheapest repeatable NPC or
// fixed-store supply, so nobody buys an item to sell it straight back here.
const BUY_OVER_NPC = 1.5;
function buyLinePrice(line) {
    const base = basePrice(line.selfId);
    const price = line.price !== undefined ? Number(line.price)
        : BotEconomyPricing.scalePrice(Math.floor(NpcSellRules.npcBuyPrice(base) * BUY_OVER_NPC));
    return Math.min(price, buyCeiling(line.selfId));
}

// The most any standing bid pays for an item (a fixed buy line, a crafter's material
// bid): under 0.9 of its cheapest repeatable NPC or fixed-store supply, so nobody buys
// it to sell it straight back; Infinity where nothing sells it.
function buyCeiling(selfId) {
    return Math.floor(cheapestPurchase(selfId) * BUYBACK_RATIO);
}

// A bot is paid the line price alone: it reaches a board bid through its own
// sale decision, which answers bids before the fixed buyers.
function botPriceFor(store, line) {
    return Number(store.storeType) === BUY ? buyLinePrice(line) : configuredPrice(line);
}

// Configured supply is independent of the board. Index it once per loaded config
// and rate profile (the Adena rate of the player's rows, the anchor's rates).
let fixedConfig = null;
let fixedRate = null;
let sellers = new Map();
let fixedMinimums = new Map();
function refreshFixedOffers() {
    const config = invoke('GameServer/Bot/MerchantStoreConfigs');
    const rates = invoke('GameServer/ProgressionRates').profile(), rate = `${rates.adena}:${rates.exp}`;
    if (fixedConfig === config && fixedRate === rate) return;
    fixedConfig = config;
    fixedRate = rate;
    sellers = new Map();
    fixedMinimums = new Map();
    const openMinimums = new Map();
    for (const [name, store] of Object.entries(config)) {
        if (Number(store?.storeType) !== SELL) continue;
        for (const line of store.items || []) {
            if (!(Number(line.count ?? 1) > 0)) continue;
            const id = Number(line.selfId);
            const price = configuredPrice(line);
            // A row sold to named classes or a role only (a crafter's or trader's gear row) is no
            // buyer's price where an open row sells the item; a scroll sold to the spoiler line only keeps its.
            if (!line.buyerClasses && !line.buyerRole) openMinimums.set(id, Math.min(openMinimums.get(id) ?? Infinity, price));
            fixedMinimums.set(id, Math.min(fixedMinimums.get(id) ?? Infinity, price));
            if (store.town) {
                if (!sellers.has(id)) sellers.set(id, []);
                sellers.get(id).push({ town: store.town, price, sourceName: name, reserve: line.reserve === true,
                    ...(line.buyerClasses ? { buyerClasses: line.buyerClasses, hourlyStock: Number(line.hourlyStock) } : {}),
                    ...(line.buyerRole ? { buyerRole: line.buyerRole } : {}),
                    ...(line.consignment ? { consignment: true } : {}),
                    ...(line.boardMarkup ? { boardMarkup: Number(line.boardMarkup) } : {}) });
            }
        }
    }
    for (const [id, price] of openMinimums) fixedMinimums.set(id, price);
}

// The cheapest repeatable supply of an item: NPC shops and the configured city
// stores. forBot: only where a bot may buy it (the NPC, the configured reserve
// rows: FixedShotOffers), the one price every bot purchase path reads; a graded
// shot's is the crafters' ask ceiling (CrafterStock.shotCeiling: they alone sell
// it to bots).
function cheapestPurchase(selfId, { forBot = false } = {}) {
    refreshFixedOffers();
    const id = Number(selfId);
    if (forBot && production.GRADED_SHOTS.has(id)) return require('./CrafterStock').shotCeiling(id);
    const minimum = forBot ? FixedShotOffers.lowestPrice(id) : fixedMinimums.get(id) ?? Infinity;
    // A reserve piece reaches a bot only through a supplier's board line, priced up to
    // the suppliers' ask ceiling (its anchor), never at the suppliers' consignment cost.
    if (forBot && Number.isFinite(minimum) && require('./PriceAnchor').anchor(id) > 0)
        return require('./CrafterStock').askCeiling(id);
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

// A graded shot's replacement cost: the board's cheapest public ask, at most the
// crafters' ask ceiling (`ceiling`: cheapestPurchase's); with no ceiling (the switch
// removes the crafters' shots) and no ask, recent paid trades, else the native
// materials-and-labour estimate. A valuation, not a supply.
function shotPrice(id, ceiling) {
    const board = boardSource ? boardSource()
        : isMainThread ? invoke('GameServer/AfkTrade/AfkTradeService').boardIndex() : null;
    const ask = board?.first(id, SELL, { enchant: 0,
        accept: row => ['shop', 'sell_ad'].includes(row.kind) && Number(row.count) > 0
            && Number(row.price) > 0 && Number.isFinite(Number(row.price)) });
    const quoted = Math.min(ceiling, Number(ask?.price || Infinity));
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
    const price = production.GRADED_SHOTS.has(Number(id)) ? shotPrice(Number(id), npc) : npc;
    return Number.isFinite(price) ? price : Math.max(0, basePrice(id));
}

module.exports = { BUYBACK_RATIO, botPriceFor, buyCeiling, configuredPrice, buyQuote, cheapestPurchase, botPurchasePrice: id => cheapestPurchase(id, { forBot: true }), botNpcListPrice, botBuyPrice,
    priceFor, sellersOf, useBoard: source => { boardSource = source; } };
