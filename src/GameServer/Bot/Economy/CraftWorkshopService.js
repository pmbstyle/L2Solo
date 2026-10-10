'use strict';
const Profit = require('./CraftProfitPolicy');
const Commit = require('./EconomyCommit');
const recipes = () => invoke('GameServer/Items/C4RecipeItems');
const life = () => invoke('GameServer/Bot/Population/BotLifeState');
const byRecipe = new Map();
const owners = new Map();
const publicDigests = new Map(), publicScopeDigests = new Map();
const publicCandidates = new (require('./PublicWorkshopIndex').PublicWorkshopIndex)();
function togglePublicDigest(row, direction = 1) {
    const productId = Number(recipes().resolveByRecipeId(row[1])?.productId || 0);
    if (!productId) return;
    const hash = invoke('GameServer/Bot/Fnv1a').fnv1a32(JSON.stringify(row));
    const scope = invoke('GameServer/Bot/Economy/MarketCounters').counterOf(productId);
    for (const [index, key] of [[publicDigests, productId], [publicScopeDigests, scope]]) {
        const prior = index.get(key) || { xor: 0, sum: 0, count: 0 };
        const next = { xor: (prior.xor ^ hash) >>> 0, sum: (prior.sum + direction * hash) >>> 0,
            count: prior.count + direction };
        if (next.count > 0) index.set(key, next); else index.delete(key);
    }
}
function publicRecipeDigest(productId) {
    const value = publicDigests.get(Number(productId));
    return value ? `${value.xor}:${value.sum}:${value.count}` : '0:0:0';
}
function publicScopeDigest(scope) {
    const value = publicScopeDigests.get(scope);
    return value ? `${value.xor}:${value.sum}:${value.count}` : '0:0:0';
}
function candidateRow(row) {
    return { characterId: row[0], recipeId: row[1], price: row[2], entryPrice: row[2],
        townName: row[3], loc: { locX: row[4], locY: row[5], locZ: row[6] }, capacityBatches: row[7] };
}
const inputOwners = new Map();
const ownerInputs = new Map();
const crafters = new Map();
const knownRecipes = new Map();
const encodedRecipes = new Map();
function recipesChanged(id) { knownRecipes.delete(Number(id)); encodedRecipes.delete(Number(id)); }
let inputIds = null;
function watchedInputs() {
    if (!inputIds) {
        inputIds = new Set();
        for (const recipe of Object.values(recipes().loadRecipeItems())) {
            if (recipe.type === 'dwarven') inputIds.add(Number(recipe.recipeItemId));
        }
        for (const id of invoke('GameServer/Bot/Economy/ProductionPolicy').GRADED_SHOTS) inputIds.add(id);
    }
    return inputIds;
}
let unsubscribe = null;
let unsubscribeOwnership = null;

function remove(id, { recipes: dropRecipes = true, publish = true } = {}) {
    const removedRecipes = owners.get(Number(id)) || [];
    for (const row of publicRecipeRows(id)) { togglePublicDigest(row, -1); publicCandidates.remove(`w:${Number(id)}:${row[1]}`); }
    if (publish) for (const recipeId of removedRecipes) invoke('GameServer/Bot/Population/ColdTableChannel').shared
        .changed('board', { key: `w:${Number(id)}:${recipeId}`, removed: true });
    invoke('GameServer/Bot/Economy/ShotMarketIndex').native().remove(id);
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
    const previousRows = publicRecipeRows(id);
    remove(id, { recipes: state?.phase !== 'cold', publish: false });
    const publishRows = () => {
        const rows = publicRecipeRows(id), keys = new Set(rows.map(row => row[1]));
        const channel = invoke('GameServer/Bot/Population/ColdTableChannel').shared;
        for (const row of previousRows) if (!keys.has(row[1])) channel.changed('board', { key: `w:${id}:${row[1]}`, removed: true });
        for (const row of rows) {
            const prior = previousRows.find(old => old[1] === row[1]);
            if (!prior || row.some((value, at) => value !== prior[at])) channel.changed('board', [`w:${id}:${row[1]}`, ...row]);
        }
    };
    if (!state || state.phase !== 'cold') { publishRows(); return; }
    invoke('GameServer/Bot/Economy/ShotMarketIndex').native().update(state);
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
        || state.partyId || state.party?.partyId || ['dead', 'traveling'].includes(state.activity)) { publishRows(); return; }
    const ids = [];
    for (const entry of shop.entries || []) {
        const recipeId = Number(entry.recipeId);
        if (!byRecipe.has(recipeId)) byRecipe.set(recipeId, new Map());
        byRecipe.get(recipeId).set(id, state); // Original canonical source, never a second actor/state book.
        ids.push(recipeId);
    }
    owners.set(id, ids);
    ids.publicRows = Object.freeze(buildPublicRecipeRows(id).map(row => Object.freeze(row)));
    for (const row of publicRecipeRows(id)) { togglePublicDigest(row); publicCandidates.put(`w:${id}:${row[1]}`, candidateRow(row)); }
    publishRows();
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
    let best = null;
    for (const row of publicForRecipe(recipeId, customer)) {
        const selected = lookup(row.characterId, recipeId, customer);
        if (!selected) continue;
        const priced = { id: `workshop_${row.characterId}`, ...row, workshop: true,
            price: selected.price, entryPrice: selected.entryPrice };
        if (!best || priced.price < best.price || priced.price === best.price && priced.characterId < best.characterId) best = priced;
    }
    return best;
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
async function craft(ownerId, recipeId, customerId, { expectedPrice = null, expectedRevision = null,
    batches = 1, original = null, random = Math.random, funding = { r: 1 } } = {}) {
    const database = invoke('Database');
    let customer = life().cachedState(customerId);
    let admitted = null;
    try {
        // Recovery retains the original identity and precedes the current
        // quote, recipe book and already-consumed material checks.
        if (original) {
            if (!customer) throw Error('workshop customer unavailable');
            admitted = await Commit.admit(customer, Commit.KINDS.craft, original);
            const result = await database.craftForCustomer(Number(ownerId), Number(customerId), {
                economyCommand: admitted.command });
            if (result.customerState) Commit.acceptRow(result.customerState);
            if (result.crafterState) Commit.acceptRow(result.crafterState);
            return result;
        }
        const crafter = life().cachedState(ownerId);
        const recipe = recipes().resolveByRecipeId(recipeId);
        const [physical] = await database.execute(['SELECT * FROM characters WHERE id = ?', [customerId]]);
        if (!physical || !crafter || !recipe || !Number.isSafeInteger(batches) || batches < 1 || batches > 64) {
            throw new Error('workshop unavailable');
        }
        customer ||= { characterId: Number(customerId), clanId: physical.clanId, stats: {} };
        const quoteValue = quote(crafter, customer, recipeId);
        if (!quoteValue || expectedPrice !== null && Number(expectedPrice) !== quoteValue.price
            || expectedRevision !== null && Number(expectedRevision) !== Number(crafter.simulation?.revision || 0)) {
            throw new Error('workshop price changed');
        }
        const materials = Profit.materials(await database.fetchItems(customerId), recipe, batches);
        if (!materials) throw new Error('workshop materials missing');
        const template = invoke('GameServer/Item/ItemTemplateIndex').find(invoke('GameServer/DataCache').items, recipe.productId);
        if (!template) throw new Error('workshop product missing');
        if (customer.phase) {
            admitted = await Commit.admit(customer, Commit.KINDS.craft);
            customer = admitted.state;
        }
        const product = { selfId: recipe.productId, amount: recipe.productCount * batches,
            name: template.template.name, stackable: !!template.etc?.stackable, slot: Number(template.etc?.slot || 0) };
        const result = await database.craftForCustomer(Number(ownerId), Number(customerId), {
            materials, product: admitted || Profit.succeeds(recipe, random) ? product : null,
            price: quoteValue.price * batches, crafterMp: Number(crafter.vitals.mp) - Number(recipe.mpCost) * batches,
            adena: { name: 'Adena' }, economyCommand: admitted?.command, funding, random,
            workshop: { recipeId, batches, entryPrice: quoteValue.entryPrice, fee: quoteValue.price * batches,
                crafterRevision: crafter.simulation?.revision || 0, customerRevision: customer.simulation?.revision || 0 }
        });
        if (result.crafterState) Commit.acceptRow(result.crafterState);
        if (result.customerState) Commit.acceptRow(result.customerState);
        return result;
    } catch (error) {
        // The caller keeps this bounded original header when delivery fails;
        // no new attempt is inferred from the leftover materials.
        if (admitted) error.economyCommand = admitted.command;
        throw error;
    } finally {
        if (admitted) Commit.finish(customerId, admitted.command);
    }
}

async function knownFor(id) {
    id = Number(id);
    let known = knownRecipes.get(id);
    if (!known) {
        known = (await invoke('Database').fetchCharacterRecipes(id)).map(row => Number(row.recipeId));
        knownRecipes.set(id, known);
    }
    return known;
}
function cachedRecipes(id) { return knownRecipes.get(Number(id)) || []; }
function bookFor(id) {
    id = Number(id);
    if (!knownRecipes.has(id)) return null;
    if (!encodedRecipes.has(id)) encodedRecipes.set(id, invoke('GameServer/Bot/Economy/RecipeBookCodec').pack(knownRecipes.get(id)));
    return encodedRecipes.get(id);
}
async function review(state) {
    init();
    const rules = invoke('GameServer/Bot/Economy/CraftShopService');
    if (!state || !rules.isServiceCrafter(state) || state.phase !== 'cold') {
        if (state) register(state);
        return state;
    }
    const id = Number(state.characterId);
    const known = await knownFor(id);
    const current = life().cachedState(state.characterId);
    if (current && current !== state) return current;
    const prior = new Map((state.stats?.workshop?.entries || []).map(entry => [Number(entry.recipeId), entry]));
    // A Giran station is a workshop for bots as for the player (E212): its
    // own station list at the station fee, never a learned price.
    const fees = rules.isStationService(state)
        ? new Map(rules.profileFor(state).entries.map(entry => [Number(entry.recipeId), entry.price])) : null;
    const entries = known.map(id => recipes().resolveByRecipeId(id)).filter(recipe => recipe
        && rules.canCraft(state, recipe) && (!fees || fees.has(Number(recipe.recipeId))))
        .slice(0, rules.MAX_PUBLIC_RECIPES).map(recipe => ({ recipeId: recipe.recipeId, ...(fees
            ? { ...prior.get(recipe.recipeId), price: fees.get(Number(recipe.recipeId)), firstPrice: fees.get(Number(recipe.recipeId)) }
            : servicePrice(recipe, prior.get(recipe.recipeId), state)) }));
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
function inputStateFor(ownerId) {
    ownerId = Number(ownerId);
    const crafter = crafters.get(ownerId);
    if (crafter) return crafter;
    const itemId = ownerInputs.get(ownerId)?.values().next().value;
    return itemId === undefined ? null : inputOwners.get(itemId)?.get(ownerId) || null;
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
// Existing public recipe index is the source; only its published fee, place
// and present physical capacity cross the worker boundary. No foreign book.
// The owner's save revision is not part of the public offer: it changes on
// every save and would republish the row and invalidate every customer's
// market read. Execution validates the live owner (lookup, craft revision).
function publicRecipeRows(ownerId) { return owners.get(Number(ownerId))?.publicRows || []; }
// ARCH-NOTE: capacity is published as a power-of-two floor (0, 1, 2, 4 .. 64)
// so MP regeneration republishes the row only when capacity halves or doubles;
// a plan may see up to half of the present batches. Execution recounts MP.
function capacityBucket(batches) {
    if (!(batches >= 1)) return 0;
    let bucket = 1;
    while (bucket * 2 <= batches) bucket *= 2;
    return bucket;
}
function buildPublicRecipeRows(ownerId) {
    const id = Number(ownerId), result = [];
    for (const recipeId of owners.get(id) || []) {
        const state = byRecipe.get(recipeId)?.get(id);
        const entry = state?.stats?.workshop?.entries?.find(row => Number(row.recipeId) === recipeId);
        const recipe = recipes().resolveByRecipeId(recipeId);
        if (!state || !entry || !recipe || ![state.loc?.locX, state.loc?.locY, state.loc?.locZ].every(Number.isFinite)) continue;
        const capacity = Math.min(64, Math.floor(Number(state.vitals?.mp || 0) / Math.max(1, Number(recipe.mpCost || 0))));
        result.push([id, recipeId, Number(entry.price),
            state.currentRegion, state.loc.locX, state.loc.locY, state.loc.locZ, capacityBucket(capacity)]);
    }
    return result;
}
function publicForRecipe(recipeId, customer = {}) {
    return publicCandidates.candidates(recipeId, customer.characterId);
}
function* publicRows() {
    for (const id of owners.keys()) for (const row of publicRecipeRows(id)) yield [`w:${id}:${row[1]}`, ...row];
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
module.exports = { init, register, remove, recipesChanged, knownFor, cachedRecipes, bookFor, review, find, publicForRecipe, publicRecipeRows, publicRows, publicRecipeDigest, publicScopeDigest, itemFingerprint: publicRecipeDigest, quote, discount, boardRecords, lookup, craft, inputSources, inputStateFor, crafterCandidates, publishDemand };
