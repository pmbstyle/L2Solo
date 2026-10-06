'use strict';
const Profit = require('./CraftProfitPolicy');
const recipes = () => invoke('GameServer/Items/C4RecipeItems');
const life = () => invoke('GameServer/Bot/Population/BotLifeState');
const byRecipe = new Map();
const owners = new Map();
const inputOwners = new Map();
const ownerInputs = new Map();
const crafters = new Map();
const knownRecipes = new Map();
function recipesChanged(id) { knownRecipes.delete(Number(id)); }
let inputIds = null;
function watchedInputs() {
    if (!inputIds) {
        inputIds = new Set();
        for (const recipe of Object.values(recipes().loadRecipeItems())) {
            if (recipe.type === 'dwarven') inputIds.add(Number(recipe.recipeItemId));
        }
        for (const id of require('./ProductionPolicy').GRADED_SHOTS) inputIds.add(id);
    }
    return inputIds;
}
let unsubscribe = null;
let unsubscribeOwnership = null;

function remove(id, { recipes: dropRecipes = true } = {}) {
    if (dropRecipes) recipesChanged(id);
    for (const recipeId of owners.get(Number(id)) || []) {
        const records = byRecipe.get(recipeId);
        records?.delete(Number(id));
        if (!records?.size) byRecipe.delete(recipeId);
    }
    owners.delete(Number(id));
    for (const itemId of ownerInputs.get(Number(id)) || []) {
        const records = inputOwners.get(itemId);
        records?.delete(Number(id));
        if (!records?.size) inputOwners.delete(itemId);
    }
    ownerInputs.delete(Number(id));
    crafters.delete(Number(id));
}
function register(state) {
    const id = Number(state?.characterId);
    remove(id, { recipes: state?.phase !== 'cold' });
    if (!state || state.phase !== 'cold') return;
    const items = new Set([...watchedInputs()].filter(itemId => Number(state.inventory?.[itemId]?.amount || 0) > 0));
    if (state.stats?.shotDemand?.itemId) items.add(Number(state.stats.shotDemand.itemId));
    if (state.stats?.shotRecipeDemand?.itemId) items.add(Number(state.stats.shotRecipeDemand.itemId));
    for (const itemId of items) {
        if (!inputOwners.has(itemId)) inputOwners.set(itemId, new Map());
        inputOwners.get(itemId).set(id, state);
    }
    ownerInputs.set(id, items);
    if (invoke('GameServer/Bot/Economy/CraftShopService').isServiceCrafter(state)) crafters.set(id, state);
    else recipesChanged(id);
    const shop = state?.stats?.workshop;
    if (!shop || state.phase !== 'cold' || state.simulation?.ownerId !== 'legacy_main' || Number(state.vitals?.hp) <= 0
        || state.partyId || state.party?.partyId || ['dead', 'traveling'].includes(state.activity)) return;
    const ids = [];
    for (const entry of shop.entries || []) {
        const recipeId = Number(entry.recipeId);
        if (!byRecipe.has(recipeId)) byRecipe.set(recipeId, new Map());
        byRecipe.get(recipeId).set(id, state); // Original canonical source, never a second actor/state book.
        ids.push(recipeId);
    }
    owners.set(id, ids);
}
function init() {
    if (!unsubscribe) unsubscribe = life().subscribeChanges(register);
    if (!unsubscribeOwnership) unsubscribeOwnership = life().subscribeMarketReviewChanges(id => {
        const current = life().cachedState(id);
        if (current) register(current); else remove(id);
    });
}
function discount(crafter, customer, trust = 0) {
    const clan = Number(crafter.clanId || crafter.stats?.clanId || 0);
    if (!clan || clan !== Number(customer.clanId || customer.stats?.clanId || 0)) return 0;
    const persona = invoke('GameServer/Bot/AI/BotPersona').of(crafter);
    const empathy = Math.max(0, Math.min(1, Number(persona?.traits?.empathy || 0)));
    return empathy * Math.max(0, Math.min(1, (Number(trust) + 100) / 200));
}
function quote(crafter, customer, recipeId) {
    const entry = crafter.stats?.workshop?.entries?.find(row => Number(row.recipeId) === Number(recipeId));
    if (!entry) return null;
    const memory = invoke('GameServer/Social/InteractionMemoryRuntime');
    const identity = state => ({ id: Number(state.characterId), clanId: Number(state.clanId || state.stats?.clanId || 0) });
    const relation = memory.assess(identity(crafter), identity(customer), {}, Date.now()).personal;
    const price = Math.max(0, Math.floor(Number(entry.price) * (1 - discount(crafter, customer, relation?.trust))));
    return { price, entryPrice: Number(entry.price) };
}
function find(recipeId, customer) {
    const candidates = [];
    for (const [id, state] of byRecipe.get(Number(recipeId)) || []) {
        if (id === Number(customer.characterId) || life().cachedState(id) !== state || state.phase !== 'cold'
            || state.simulation?.ownerId !== 'legacy_main') continue;
        const recipe = recipes().resolveByRecipeId(recipeId);
        if (!recipe || Number(state.vitals?.mp || 0) < Number(recipe.mpCost)) continue;
        const priced = quote(state, customer, recipeId);
        if (priced) candidates.push({ id: `workshop_${id}`, characterId: id, loc: state.loc,
            townName: state.currentRegion, workshop: true, recipeId: Number(recipeId), ...priced,
            revision: Number(state.simulation?.revision || 0) });
    }
    return candidates.sort((a, b) => a.price - b.price || a.characterId - b.characterId)[0] || null;
}
function servicePrice(recipe, previous, state) {
    const Belief = invoke('GameServer/Bot/Economy/PriceBelief');
    const first = invoke('GameServer/Bot/Economy/CraftShopService').productPrice(recipe);
    const belief = { mu: Math.log(Math.max(1, first)), K: Belief.S0 };
    const observations = [];
    for (const [id, peer] of byRecipe.get(Number(recipe.recipeId)) || []) {
        if (id === Number(state.characterId) || life().cachedState(id) !== peer) continue;
        const price = peer.stats.workshop.entries.find(entry => Number(entry.recipeId) === Number(recipe.recipeId))?.price;
        if (price > 0) observations.push([Math.log(price), 1]);
    }
    const paid = Number(previous?.earned || 0), filled = Number(previous?.fills || 0);
    if (paid > 0 && filled > 0) observations.push([Math.log(paid / filled), filled]);
    Belief.learn(belief, observations);
    return { ...previous, price: Math.max(1, Math.round(Math.exp(belief.mu))), firstPrice: first };
}
async function craft(ownerId, recipeId, customerId, { expectedPrice = null } = {}) {
    const database = invoke('Database');
    const crafter = life().cachedState(ownerId);
    const recipe = recipes().resolveByRecipeId(recipeId);
    const [physical] = await database.execute(['SELECT * FROM characters WHERE id = ?', [customerId]]);
    if (!physical || !crafter || !recipe) throw new Error('workshop unavailable');
    const customer = life().cachedState(customerId) || { characterId: Number(customerId), clanId: physical.clanId, stats: {} };
    const quoteValue = quote(crafter, customer, recipeId);
    if (!quoteValue || expectedPrice !== null && Number(expectedPrice) !== quoteValue.price) throw new Error('workshop price changed');
    const materials = Profit.materials(await database.fetchItems(customerId), recipe);
    if (!materials) throw new Error('workshop materials missing');
    const template = require('../../Item/ItemTemplateIndex').find(invoke('GameServer/DataCache').items, recipe.productId);
    if (!template) throw new Error('workshop product missing');
    const result = await database.craftForCustomer(Number(ownerId), Number(customerId), {
        materials, product: Profit.succeeds(recipe) ? { selfId: recipe.productId, amount: recipe.productCount,
            name: template.template.name, stackable: !!template.etc?.stackable, slot: Number(template.etc?.slot || 0) } : null,
        price: quoteValue.price, crafterMp: Number(crafter.vitals.mp) - Number(recipe.mpCost), adena: { name: 'Adena' },
        workshop: { recipeId, batches: 1, entryPrice: quoteValue.entryPrice, fee: quoteValue.price,
            crafterRevision: crafter.simulation?.revision || 0, customerRevision: customer.simulation?.revision || 0 }
    });
    if (result.crafterState) life().acceptLifecycleRow(result.crafterState);
    if (result.customerState) life().acceptLifecycleRow(result.customerState);
    return result;
}
async function review(state) {
    init();
    const rules = invoke('GameServer/Bot/Economy/CraftShopService');
    if (!state || !rules.isServiceCrafter(state) || state.stats?.craftStationId || state.phase !== 'cold') {
        if (state) register(state);
        return state;
    }
    const id = Number(state.characterId);
    let known = knownRecipes.get(id);
    if (!known) {
        known = (await invoke('Database').fetchCharacterRecipes(id)).map(row => Number(row.recipeId));
        knownRecipes.set(id, known);
    }
    const current = life().cachedState(state.characterId);
    if (current && current !== state) return current;
    const prior = new Map((state.stats?.workshop?.entries || []).map(entry => [Number(entry.recipeId), entry]));
    const entries = known.map(id => recipes().resolveByRecipeId(id)).filter(recipe => recipe
        && rules.canCraft(state, recipe)).slice(0, rules.MAX_PUBLIC_RECIPES).map(recipe => ({ recipeId: recipe.recipeId,
        ...servicePrice(recipe, prior.get(recipe.recipeId), state) }));
    const previous = state.stats?.workshop?.entries || [];
    if (!entries.length && !previous.length) { remove(state.characterId, { recipes: false }); return state; }
    if (entries.length === previous.length && entries.every((entry, i) =>
        Number(entry.recipeId) === Number(previous[i].recipeId)
        && ['price', 'firstPrice', 'earned', 'fills'].every(key => Number(entry[key] || 0) === Number(previous[i][key] || 0)))) {
        register(state); return state;
    }
    const next = { ...state, stats: { ...state.stats, workshop: { title: `${state.name}'s workshop`,
        entries, town: state.currentRegion, loc: state.loc } } };
    const saved = await life().upsertState(next, 'workshop_updated') || state;
    register(saved);
    return saved;
}
function inputSources(itemId) {
    return [...(inputOwners.get(Number(itemId))?.values() || [])].filter(state => life().cachedState(state.characterId) === state);
}
function crafterCandidates(limit = 16) {
    const result = [], count = Math.min(crafters.size, limit);
    const iterator = crafters.entries();
    for (let inspected = 0; inspected < count; inspected++) {
        const [id, state] = iterator.next().value;
        crafters.delete(id); crafters.set(id, state);
        if (life().cachedState(state.characterId) === state) result.push(state);
    }
    return result;
}

function lookup(ownerId, recipeId, customer) {
    const state = byRecipe.get(Number(recipeId))?.get(Number(ownerId));
    if (!state || life().cachedState(ownerId) !== state) return null;
    return { state, recipe: recipes().resolveByRecipeId(recipeId), ...quote(state, customer, recipeId) };
}
function boardRecords() {
    return [...owners.keys()].flatMap(id => {
        const state = life().cachedState(id);
        if (!state?.stats?.workshop || state.phase !== 'cold') return [];
        return [{ id: `workshop_${id}`, kind: 'workshop', ownerId: id, ownerName: state.name,
            town: state.currentRegion, loc: state.loc, title: state.stats.workshop.title,
            entries: state.stats.workshop.entries, revision: state.simulation?.revision || 0 }];
    });
}
async function publishDemand(state, recipe, productPrice, context) {
    for (const material of recipe.materials || []) {
        const missing = Math.max(0, Number(material.amount) - Number(state.inventory?.[material.selfId]?.amount || 0));
        if (!missing) continue;
        let others = 0;
        for (const other of recipe.materials || []) if (other !== material) {
            const value = Profit.inputValue(other.selfId, state, context);
            if (!(value > 0)) return state;
            others += value * Number(other.amount);
        }
        const margin = Profit.margin(recipe, productPrice, others, context);
        const input = Profit.inputValue(material.selfId, state, context);
        const cash = missing * input;
        const r = margin?.profit > 0 && cash > 0 ? margin.profit / context.hourAdena / cash : 0;
        const budget = invoke('GameServer/Bot/Economy/PurchaseFunding').spendable(state, 0, { r });
        const worth = margin && margin.profit / Number(material.amount);
        if (!(worth > 0)) continue;
        const price = Math.floor(Math.min(worth, budget / missing));
        if (price < 1) continue;
        const result = await invoke('GameServer/Bot/Economy/BotAfkMarketService').openBuyAd(state, {
            type: 'buy_craft_material', status: 'active', target: { itemId: material.selfId, amount: missing,
                adena: price }, plan: { estimatedCost: price, valueRate: r, expectedBenefit: 'market_buy_craft_material', priceSource: 'recipe_margin' }
        });
        return result.state || state; // One owned money focus; the next input follows its fill event.
    }
    return state;
}
module.exports = { init, register, remove, recipesChanged, review, find, quote, discount, boardRecords, lookup, craft, inputSources, crafterCandidates, publishDemand };
