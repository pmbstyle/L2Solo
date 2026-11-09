'use strict';
// The gear errands a bot failed where it acts (hot: a refused gear purchase, a failed
// dual sword combination or unseal, ShoppingState; cold: a gear buy that failed on the
// item, ColdMarketService.tryPurchase): each raises goal_failed { kind: 'gear_errand', key },
// its key (the item, else the product or recipe) kept in stats.gearMarks, owned here,
// written by Situations' raise (raisedFacts), which wakes the gear plan with the build
// (its source failed, Situations.delta). Read by the gear plan
// (GearAcquisitionPlanner.replanContextFor excludes the items), the build's purchase
// reader (WishPurchaseEvidence: no purchase of a marked item, so no power root or
// material leaf takes it again) and the body's errand planner
// (CompanionEquipmentShopping.planErrand plans none of them).
// A mark lives until a situation that changes what the same errand would meet (LIFETIME,
// declared on Situations' forgets, applied by every raise on both threads): a new board
// offer of its item (offer_posted { itemId }: that mark alone), the wallet reaching the
// build's threshold (goal_affordable:focus: the money a refused buy lacked), the bot's own
// gear or grade moving (gear_changed, grade_changed: what it wants and what its gear rules
// admit). Not the gear plan review its failure woke: that review plans without it, and the
// next failure's review would take it again, a loop while the town visit lasts. No clock.
// Our choice after C4 play: a player refused at a shop does not walk back for the same item
// until he hears an offer of it, has the money or his gear moved.
// [{ key }], at most MAX_MARKS (the oldest dropped, counted by the caller).
const MAX_MARKS = 8;
const LIFETIME = Object.freeze(['offer_posted', 'goal_affordable:focus', 'gear_changed', 'grade_changed']);
const marksOf = stats => Array.isArray(stats?.gearMarks) ? stats.gearMarks : [];
const keyOf = value => Number(value) > 0 ? Number(value) : null;
// The key a gear errand names.
const errandKey = errand => keyOf(errand?.itemId) ?? keyOf(errand?.productId) ?? keyOf(errand?.recipeId);
function withMark(stats, key, dropped = null) {
    const id = keyOf(key);
    if (id === null) return undefined;
    const marks = [...marksOf(stats).filter(mark => mark.key !== id), { key: id }];
    if (marks.length > MAX_MARKS) dropped?.();
    return marks.slice(-MAX_MARKS);
}
const marked = (stats, key) => keyOf(key) !== null && marksOf(stats).some(mark => mark.key === keyOf(key));
// The marks situation `name` (one of LIFETIME) leaves: { gearMarks, forgot: how many went },
// or {} when it forgets none.
function forget(stats, name, payload = null) {
    const marks = marksOf(stats), item = name === 'offer_posted' ? keyOf(payload?.itemId) : null;
    if (!marks.length || name === 'offer_posted' && item === null) return {};
    const kept = item === null ? [] : marks.filter(mark => mark.key !== item);
    return kept.length === marks.length ? {} : { gearMarks: kept, forgot: marks.length - kept.length };
}
const keys = stats => marksOf(stats).map(mark => mark.key);
module.exports = { MAX_MARKS, LIFETIME, errandKey, withMark, marked, forget, keys };
