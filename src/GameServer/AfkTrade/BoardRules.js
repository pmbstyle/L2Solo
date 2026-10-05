// The board (design section 4): every record is a row of the author's AFK
// shop table with a kind. A shop is the author's AFK shop and stands in the
// world; ads and orders have no place in the world and no appearance.
// A sell record holds its items in its lines; a buy record holds its escrow.

const SELL = 1;
const BUY = 3;
const KINDS = ['shop', 'sell_ad', 'buy_ad', 'order'];

// Every record lives 12 hours of server uptime (user, 2026-10-05): the
// deadlines move by the downtime at start (Database.shiftBoardDeadlines).
const LIFETIME_MS = 12 * 60 * 60 * 1000;

// Per-bot caps (user, 2026-10-05): 3 shop lines + 5 sell ads + 5 buy ads +
// 1 order. A record over its cap is refused; the caller keeps the item or
// the money.
const BOT_SHOP_LINES = 3;
const BOT_RECORDS = { sell_ad: 5, buy_ad: 5, order: 1 };

function isKind(kind) {
    return KINDS.includes(String(kind));
}

// An ad is one item: a sell ad holds it, a buy ad and an order its escrow.
function storeTypeFor(kind, storeType) {
    if (kind === 'sell_ad') return SELL;
    if (kind === 'buy_ad' || kind === 'order') return BUY;
    return Number(storeType);
}

function isBotAccount(account) {
    return String(account || '').startsWith('bot_');
}

module.exports = { SELL, BUY, KINDS, LIFETIME_MS, BOT_SHOP_LINES, BOT_RECORDS, isKind, storeTypeFor, isBotAccount };
