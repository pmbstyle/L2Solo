const BuyerActivity = invoke('GameServer/Bot/Economy/MarketBuyerActivity');
const Pricing = invoke('GameServer/Bot/Economy/BotEconomyPricing');
const ChatterItems = require('../AI/BotChatterItems');

const ITEM_COOLDOWN_MS = 20 * 60 * 1000;
const MIN_AD_LOT_BASE_ADENA = 5000;

function itemKey(type, line) {
    return `${type}:${Number(line.selfId)}:${Number(line.enchant || 0)}`;
}

function valid(shop, line, minLotValue) {
    return [1, 3].includes(Number(shop.storeType))
        && Number(shop.ownerId) > 0 && Number(line.selfId) > 0
        && !ChatterItems.isRoutineSupply(line.selfId, line.name)
        && Number(line.count) > 0 && Number.isSafeInteger(Number(line.price))
        && Number(line.price) > 0
        && Number(line.price) * Number(line.count) >= minLotValue
        && (Number(shop.storeType) !== 3 || Number(shop.escrowAdena) >= Number(line.price));
}

function minLotValue() {
    return Pricing.scalePrice(MIN_AD_LOT_BASE_ADENA);
}

// The board's books and the bots' candidate lines: a function of the shops
// alone, so a caller may keep it until the board changes (BotTradeChat).
function index(shops, minLot = minLotValue()) {
    const books = new Map();
    const candidates = [];
    for (const shop of shops) {
        for (const line of shop.lines || []) {
            if (!valid(shop, line, minLot)) continue;
            const type = Number(shop.storeType);
            const id = itemKey(0, line);
            const book = books.get(id) || { minAsk: Infinity, secondAsk: Infinity,
                askOffers: 0, maxBid: 0 };
            const price = Number(line.price);
            if (type === 1) {
                book.askOffers += 1;
                if (price < book.minAsk) {
                    book.secondAsk = book.minAsk;
                    book.minAsk = price;
                } else if (price < book.secondAsk) book.secondAsk = price;
            } else book.maxBid = Math.max(book.maxBid, price);
            books.set(id, book);
            if (String(shop.ownerAccount || '').startsWith('bot_')) {
                candidates.push({ shop, line, type, id, price });
            }
        }
    }
    return { minLotValue: minLot, books, candidates };
}

// The pick reads the clock, the cooldowns and the buyers: every call.
function pick({ books, candidates }, { now, lastItemAt, lastOwnerAt, lastTownAt, preferredSide }) {
    let best = null;
    let preferred = null;
    for (const candidate of candidates) {
        const { shop, line, type, id, price } = candidate;
        if (now - (lastOwnerAt.get(Number(shop.ownerId))?.at ?? -Infinity) < 8 * 60 * 1000
            || now - (lastItemAt.get(itemKey(type, line)) ?? -Infinity) < ITEM_COOLDOWN_MS) continue;
        const book = books.get(id);
        const recentBuyers = BuyerActivity.count(line.selfId);
        let score;
        if (type === 1) {
            if (price > book.minAsk * 1.05) continue;
            const bargain = book.secondAsk < Infinity && book.secondAsk >= price * 1.1;
            if (book.askOffers > 4 && !recentBuyers && book.maxBid < price && !bargain) continue;
            score = Math.min(recentBuyers, 5) * 12 + (bargain ? 25 : 0)
                + (book.askOffers <= 2 ? 12 : 0) + Math.min(10, Math.log10(price * Number(line.count) + 1) * 2);
        } else {
            if (price < book.maxBid * 0.95) continue;
            score = 20 + (book.minAsk < Infinity && price >= book.minAsk * 0.8 ? 12 : 0)
                + Math.min(10, Math.log10(price * Number(line.count) + 1) * 2);
        }
        if (now - (lastTownAt.get(String(shop.town)) ?? -Infinity) < 5 * 60 * 1000) score -= 10;
        const ranked = { ...candidate, score };
        const better = (left, right) => !right || left.score > right.score
            || left.score === right.score && (Number(left.shop.ownerId) < Number(right.shop.ownerId)
                || Number(left.shop.ownerId) === Number(right.shop.ownerId)
                    && Number(left.line.selfId) < Number(right.line.selfId));
        if (better(ranked, best)) best = ranked;
        if (type === preferredSide && better(ranked, preferred)) preferred = ranked;
    }
    return preferred || best;
}

function choose(shops, context) {
    return pick(index(shops), context);
}

module.exports = { choose, index, pick, minLotValue, itemKey, ITEM_COOLDOWN_MS, MIN_AD_LOT_BASE_ADENA };
