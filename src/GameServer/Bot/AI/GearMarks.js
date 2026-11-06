'use strict';
// The gear errands a bot failed where it acts (hot: a refused gear purchase, a failed
// dual sword combination or unseal, ShoppingState; cold: a gear buy that failed on the
// item, ColdMarketService.tryPurchase): each raises goal_failed { kind: 'gear_errand', key },
// its key (the item, else the product or recipe) kept in stats.gearMarks, owned here,
// written by Situations' raise (raisedFacts). That mark is all the gear plan hears of
// the failure (the failure wakes the build, not the gear plan). Read by the gear plan
// (GearAcquisitionPlanner.replanContextFor excludes the items), the build's purchase
// reader (WishPurchaseEvidence: no purchase of a marked item, so no power root or
// material leaf takes it again) and the body's errand planner
// (CompanionEquipmentShopping.planErrand plans none of them). A mark lives until the
// bot's next gear plan review, woken by its own situations (a level, gear, a death):
// that review plans without it and drops it (afterReview, at decided(gear_plan)). No clock.
// [{ key }], at most MAX_MARKS (the oldest dropped, counted by the caller).
const MAX_MARKS = 8;
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
// The marks after a gear plan review: none (the review planned without them).
const afterReview = () => null;
const keys = stats => marksOf(stats).map(mark => mark.key);
module.exports = { MAX_MARKS, errandKey, withMark, marked, afterReview, keys };
