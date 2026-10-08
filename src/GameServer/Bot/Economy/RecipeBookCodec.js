'use strict';
const Recipes = invoke('GameServer/Items/C4RecipeItems');
let ids, positions;
function catalog() {
    if (!ids) {
        ids = Object.freeze([...new Set(Object.values(Recipes.loadRecipeItems())
            .filter(row => row.type === 'dwarven').map(row => Number(row.recipeId)))].sort((a, b) => a - b));
        positions = new Map(ids.map((id, at) => [id, at]));
    }
    return ids;
}
function pack(known) {
    const rows = catalog(), bytes = Buffer.alloc(Math.ceil(rows.length / 8));
    for (const value of known || []) {
        const at = positions.get(Number(value.recipeId ?? value));
        if (at !== undefined) bytes[at >> 3] |= 1 << (at & 7);
    }
    return bytes.toString('base64');
}
function unpack(value) {
    const rows = catalog();
    if (typeof value !== 'string' || value.length > Math.ceil(rows.length / 8 / 3) * 4) return null;
    const bytes = Buffer.from(value, 'base64');
    if (bytes.length !== Math.ceil(rows.length / 8) || bytes.toString('base64') !== value) return null;
    const result = [];
    for (let at = 0; at < rows.length; at++) if (bytes[at >> 3] & (1 << (at & 7))) result.push({ recipeId: rows[at] });
    return result;
}
module.exports = { pack, unpack };
