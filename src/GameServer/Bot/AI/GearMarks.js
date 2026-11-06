'use strict';
// The gear errands a bot failed where it acts (a refused gear purchase, a failed dual
// sword combination or unseal: ShoppingState raises goal_failed { kind: 'gear_errand',
// key }): their keys (the item, else the recipe or product) in stats.gearMarks, owned
// here, written by Situations' raise (raisedFacts), read by the gear plan
// (GearAcquisitionPlanner.replanContextFor excludes the items) and the body's errand
// planner (CompanionEquipmentShopping.planErrand plans none of them). A mark lives until
// the bot's next own situation that wakes its gear plan: the review the failure woke
// keeps it (fresh), the next drops it (afterReview, at decided(gear_plan)). No clock.
// [{ key, fresh }], at most MAX_MARKS (the oldest dropped, counted by the caller).
const MAX_MARKS = 8;
const marksOf = stats => Array.isArray(stats?.gearMarks) ? stats.gearMarks : [];
const keyOf = value => Number(value) > 0 ? Number(value) : null;
// The key a gear errand names.
const errandKey = errand => keyOf(errand?.itemId) ?? keyOf(errand?.productId) ?? keyOf(errand?.recipeId);
function withMark(stats, key, dropped = null) {
    const id = keyOf(key);
    if (id === null) return undefined;
    const marks = [...marksOf(stats).filter(mark => mark.key !== id), { key: id, fresh: true }];
    if (marks.length > MAX_MARKS) dropped?.();
    return marks.slice(-MAX_MARKS);
}
const marked = (stats, key) => keyOf(key) !== null && marksOf(stats).some(mark => mark.key === keyOf(key));
// The marks after a gear plan review: the fresh ones stay (stale now), the rest go.
function afterReview(stats) {
    const kept = marksOf(stats).filter(mark => mark.fresh).map(mark => ({ key: mark.key, fresh: false }));
    return kept.length ? kept : null;
}
const keys = stats => marksOf(stats).map(mark => mark.key);
module.exports = { MAX_MARKS, errandKey, withMark, marked, afterReview, keys };
