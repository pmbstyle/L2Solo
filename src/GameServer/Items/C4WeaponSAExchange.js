const data = require('../../../data/Items/weapon_sa_exchanges.json');
const byId = new Map(data.recipes.map(recipe => [recipe.id, recipe]));
const blacksmiths = new Set(data.blacksmiths);
const crystalIds = new Set(Object.keys(require('../../../data/Items/soul_crystals.json').crystals).map(Number));
function station(npcId) {
    if (Number(npcId) === 8126) return 'mammon';
    if (Number(npcId) === 8092) return 'blackMarket';
    return blacksmiths.has(Number(npcId)) ? 'blacksmith' : null;
}
function resolve(npcId, recipeId) {
    const recipe = byId.get(recipeId);
    return recipe?.station === station(npcId) ? recipe : null;
}
function options(npcId, sourceId, operation) {
    return data.recipes.filter(r => r.station === station(npcId) && r.sourceId === Number(sourceId) && r.operation === operation);
}
// Lisvus tax-only Adena ingredients are a tax base, not a service fee. The
// current world has no castle tax service, so its effective rate is zero.
function costs(recipe) {
    // Installation requires only the weapon and its exact Soul Crystal at every
    // grade. Keep sourced material costs for reference and possible restoration.
    return recipe.operation === 'install'
        ? recipe.costs.filter(cost => crystalIds.has(cost.selfId))
        : recipe.costs;
}
function links(npcId) {
    const kind = station(npcId);
    if (!kind) return '';
    return '<br>' + (kind !== 'blackMarket' ? '<a action="bypass -h weapon-sa menu install">Install a weapon special ability</a><br>' : '')
        + (kind !== 'blacksmith' ? '<a action="bypass -h weapon-sa menu remove">Remove a weapon special ability</a><br>' : '');
}
module.exports = { station, resolve, options, costs, links, recipes: data.recipes };
