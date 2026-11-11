'use strict';
// The gear errands a bot failed where it acts (hot: a failed dual sword combination or
// unseal, a town route that failed, ShoppingState; cold: a gear buy that failed on the item,
// ColdMarketService.tryPurchase; a purchase refused for money marks nothing, one refused at the
// seller only its quote, below): each raises goal_failed { kind: 'gear_errand', key, reason },
// its key (the item, else the product or recipe) kept in stats.gearMarks, owned here,
// written by Situations' raise (raisedFacts), which wakes the gear plan with the build
// (its source failed, Situations.delta). Read by the gear plan
// (GearAcquisitionPlanner.replanContextFor excludes the items), the build's purchase
// reader (WishPurchaseEvidence: no purchase of a marked item, so no power root or
// material leaf takes it again) and the body's errand planner
// (CompanionEquipmentShopping.planErrand plans none of them).
// A mark lives until a situation that changes what the same errand would meet (LIFETIME,
// declared on Situations' forgets, applied by every raise on both threads): the wallet
// reaching the build's threshold (goal_affordable:focus), the
// bot's own gear or grade moving (gear_changed, grade_changed: what it wants and what its gear
// rules admit). Not a board offer of the item: a marked item is no purchase, so the bot watches
// no offer of it. Not the gear plan review its failure woke: that review plans without it, and
// the next failure's review would take it again, a loop while the town visit lasts. No clock.
// Our choice after C4 play: a player whose gear rules refused the item does not walk back for it
// until he has the money or his gear moved.
// A shop step its buyer refused at the seller (SELLER_REFUSALS: no offer it can take at the
// card's price, the price refused, the line or stock gone or changed; cold:
// ColdMarketService.tryPurchase on arrival, hot: ShoppingState) raises goal_failed
// { kind: 'gear_errand', key, town, price, reason } and marks its quote, not the item:
// { key (the item), town, price } (the card's town and unit price). A purse short of it, a
// failed write, a busy or cancelled meeting, a stock limit or a full bag mark nothing: the
// seller did not refuse, their facts have other owners. The build's purchase reader and every
// buyer skip that offer (OfferQuery.admits), so the build that failure wakes moves to the next
// seller or holds rather than taking the same step again; the gear plan does not read it. A
// quote mark lives as an item mark does (LIFETIME); for a cold bot it ends too when a seller
// posts an offer its held build wants (offer_posted, QUOTE_LIFETIME: the stall may stand
// again); a hot bot hears no offer_posted, its quote marks last until LIFETIME. An offer at
// another price or town is another quote. Our choice after C4 play: a player turned away at a
// stall tries the next one, and looks again when someone shouts WTS.
// [{ key } | { key, town, price }]: at most MAX_MARKS item marks and MAX_QUOTES quote marks,
// each kind dropping only its own oldest (dropped('gear_mark' | 'quote_mark'), counted by the
// caller), so refused quotes never push out an item mark. A quote the cap drops marks its item
// instead, in place of that item's quotes (an item mark: its lifetime, the gear plan woken): a
// dropped quote would be taken and refused again while the bot stays in town. Our choice after
// C4 play: a player turned away at stall after stall stops asking for the item he was turned
// away for longest until his money or gear moves.
const MAX_MARKS = 8, MAX_QUOTES = 8;
const LIFETIME = Object.freeze(['goal_affordable:focus', 'gear_changed', 'grade_changed']);
const QUOTE_LIFETIME = Object.freeze(['offer_posted']);
// The refusals at the seller, by the cold buyer's reasons and the hot body's errors.
const SELLER_REFUSALS = new Set(['no_affordable_offer', 'low_tier_offer_missing', 'offer_changed',
    'trade_meeting_purchase_price_changed', 'trade_meeting_quote_changed', 'trade_meeting_stock_changed',
    'afk_trade_stock_changed', 'afk_trade_shop_changed', 'afk_trade_shop_unavailable', 'afk_trade_line_unavailable',
    'afk_trade_price_changed', 'afk_trade_pricing_changed', 'npc_offer_unavailable',
    'This store is not selling items.', 'Store listing changed.', 'Item is not available.', 'Store price changed.', 'Item is out of stock.',
    'private_store_unavailable', 'private_store_changed', 'private_store_stock_changed']);
const sellerRefused = reason => SELLER_REFUSALS.has(reason);
// The refusals for money (marking nothing), by the hot body's errors and the cold board writer's
// codes: the bag short of the line, or the line past the step's place in the money queue.
const FUNDING_REFUSALS = new Set(['Not enough Adena.', 'not_enough_adena', 'insufficient_adena', 'economy_funding_changed', 'npc_line_not_funded']);
// The board's and the meeting's refusals of a buy that are no seller's and no money's: the
// buyer's or the seller's party busy, the meeting queue full, the buyer anchored to a meeting
// elsewhere or in another preparation, its authority moved since the decision
// (TradeMeetingService.prepareTrade, stage), the record now trading by meeting only
// (Database.buyFromAfkTradeShop), the meeting cancelled before it traded, the hot body's
// session gone during the deal (AfkTradeService.admitBotTrade). They mark nothing.
const BUY_REFUSALS = new Set(['trade_meeting_party_busy', 'trade_meeting_backpressure',
    'trade_meeting_point_changed', 'trade_meeting_authority_changed', 'trade_meeting_player_at_point', 'trade_meeting_required',
    'trade_meeting_preparation_busy', 'trade_meeting_cancelled', 'economy_session_changed']);
// A store or board buy's error, hot and cold: 'funding' (FUNDING_REFUSALS), 'seller'
// (SELLER_REFUSALS: its quote marked), 'refused' (BUY_REFUSALS, or a named refusal of the
// writer: writerRefused, Database.refused(error), passed in so no rule here reads the
// database), else 'failed': anything else, a broken invariant included, the caller counts.
function buyRefusal(error, writerRefused = false) {
    const code = error?.message;
    if (FUNDING_REFUSALS.has(code)) return 'funding';
    if (SELLER_REFUSALS.has(code)) return 'seller';
    return BUY_REFUSALS.has(code) || writerRefused ? 'refused' : 'failed';
}
const marksOf = stats => Array.isArray(stats?.gearMarks) ? stats.gearMarks : [];
const keyOf = value => Number(value) > 0 ? Number(value) : null;
// The key a gear errand names.
const errandKey = errand => keyOf(errand?.itemId) ?? keyOf(errand?.productId) ?? keyOf(errand?.recipeId);
// quote: { town, price } of a refused offer (a mark of that quote only), else the item's.
// dropped(owner): told the oldest mark of the new mark's kind went past its cap.
// The facts written: { gearMarks, quote: true when the mark is a quote's }, undefined: no key.
function withMark(stats, key, dropped = null, quote = null) {
    const id = keyOf(key);
    if (id === null) return undefined;
    const mark = quote ? { key: id, town: String(quote.town), price: Number(quote.price) } : { key: id };
    const marks = [...marksOf(stats).filter(row => row.key !== id || row.town !== mark.town || row.price !== mark.price), mark];
    const kind = marks.filter(row => (row.town !== undefined) === !!quote);
    if (quote && kind.length <= MAX_QUOTES) return { gearMarks: marks, quote: true };
    if (!quote && kind.length <= MAX_MARKS) return { gearMarks: marks };
    dropped?.(quote ? 'quote_mark' : 'gear_mark');
    if (!quote) return { gearMarks: marks.filter(row => row !== kind[0]) };
    // The dropped quote's item is marked in place of its quotes.
    const item = kind[0].key;
    return withMark({ gearMarks: marks.filter(row => row.key !== item || row.town === undefined) }, item, dropped);
}
// The quote a raise's payload names ({ town, price }), else null.
const quoteOf = payload => typeof payload?.town === 'string' && payload.town && Number(payload.price) > 0
    ? { town: payload.town, price: Number(payload.price) } : null;
const marked = (stats, key) => keyOf(key) !== null && marksOf(stats).some(mark => mark.key === keyOf(key) && mark.town === undefined);
// Whether an offer (a sell line or another source's offer: selfId, town, price) is a refused quote.
function refused(stats, offer) {
    const marks = marksOf(stats);
    if (!marks.length) return false;
    const id = Number(offer?.selfId), price = Number(offer?.price);
    return marks.some(mark => mark.town !== undefined && mark.key === id && mark.town === offer.town && mark.price === price);
}
// The marks a situation of LIFETIME leaves (none): { gearMarks, forgot: how many went },
// or {} when it forgets none.
function forget(stats) {
    const marks = marksOf(stats);
    return marks.length ? { gearMarks: [], forgot: marks.length } : {};
}
// The marks a situation of QUOTE_LIFETIME leaves (the item marks; quote: no item moved).
function forgetQuotes(stats) {
    const marks = marksOf(stats), items = marks.filter(mark => mark.town === undefined);
    return items.length < marks.length ? { gearMarks: items, forgot: marks.length - items.length, quote: true } : {};
}
// The items marked (the gear plan's exclusions), and the refused quotes [key, town, price].
const keys = stats => marksOf(stats).filter(mark => mark.town === undefined).map(mark => mark.key);
const quotes = stats => marksOf(stats).filter(mark => mark.town !== undefined).map(mark => [mark.key, mark.town, mark.price]);
module.exports = { MAX_MARKS, MAX_QUOTES, LIFETIME, QUOTE_LIFETIME, errandKey, withMark, quoteOf, sellerRefused, buyRefusal, marked, refused, forget, forgetQuotes, keys, quotes };
