'use strict';
// Public candidates by recipe and town. Publication events maintain the same
// order as a board quote: one cheap usable source per reachable town, without
// sorting or scanning a crowded recipe at the customer's decision.
const knownTowns = new Set(require('./EconomicTrip').towns);
const compare = (left, right) => Number(left.price) - Number(right.price)
    || Number(left.characterId) - Number(right.characterId);
function position(rows, value) {
    let low = 0, high = rows.length;
    while (low < high) { const mid = (low + high) >>> 1;
        if (compare(rows[mid], value) < 0) low = mid + 1; else high = mid;
    }
    return low;
}
class PublicWorkshopIndex {
    constructor() { this.recipes = new Map(); this.keys = new Map(); }
    remove(key) {
        const prior = this.keys.get(key);
        if (!prior) return;
        const towns = this.recipes.get(prior.recipeId), rows = towns.get(prior.townName);
        const at = position(rows, prior);
        if (rows[at] === prior) rows.splice(at, 1);
        if (!rows.length) towns.delete(prior.townName);
        if (!towns.size) this.recipes.delete(prior.recipeId);
        this.keys.delete(key);
    }
    put(key, row) {
        this.remove(key);
        if (!knownTowns.has(row.townName) || !(row.capacityBatches > 0)
            || !Number.isSafeInteger(row.price) || row.price < 0
            || !Number.isSafeInteger(row.characterId) || row.characterId <= 0
            || !Number.isSafeInteger(row.recipeId) || row.recipeId <= 0
            || ![row.loc?.locX, row.loc?.locY, row.loc?.locZ].every(Number.isFinite)) return;
        let towns = this.recipes.get(row.recipeId);
        if (!towns) this.recipes.set(row.recipeId, towns = new Map());
        let rows = towns.get(row.townName);
        if (!rows) towns.set(row.townName, rows = []);
        rows.splice(position(rows, row), 0, row);
        this.keys.set(key, row);
    }
    *candidates(recipeId, excludeOwner = 0) {
        for (const rows of this.recipes.get(Number(recipeId))?.values() || []) {
            const first = rows[0].characterId === Number(excludeOwner) ? rows[1] : rows[0];
            if (first) yield first;
        }
    }
    clear() { this.recipes.clear(); this.keys.clear(); }
}
module.exports = { PublicWorkshopIndex };
