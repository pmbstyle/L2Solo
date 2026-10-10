// Native shot decisions, shared by town reviews and the cold worker.
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const CraftShopService = invoke('GameServer/Bot/Economy/CraftShopService');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const Profit = require('./CraftProfitPolicy');
const Basket = require('./WealthCraftPolicy');
const Wealth = require('./WealthCraftDecision');
const { isMainThread } = require('node:worker_threads');
const PurchaseFunding = require('./PurchaseFunding');
const SHOT_RECIPE_IDS = [20, 21, 22, 23, 24, 317, 318, 319, 320, 321,
    323, 324, 325, 326, 327];
const SHOT_PRODUCT_IDS = new Set(SHOT_RECIPE_IDS
    .map((id) => Number(Recipes.resolveByRecipeId(id)?.productId || 0)).filter(Boolean));
const SHOT_RECIPE_ITEM_IDS = new Set(SHOT_RECIPE_IDS
    .map((id) => Number(Recipes.resolveByRecipeId(id)?.recipeItemId || 0)).filter(Boolean));
const CRYSTAL_BY_RANK = { d: 1458, c: 1459, b: 1460, a: 1461, s: 1462 };
const SHOT_RANK_BY_ID = new Map([
    [1463, 'd'], [2510, 'd'], [3948, 'd'],
    [1464, 'c'], [2511, 'c'], [3949, 'c'],
    [1465, 'b'], [2512, 'b'], [3950, 'b'],
    [1466, 'a'], [2513, 'a'], [3951, 'a'],
    [1467, 's'], [2514, 's'], [3952, 's']
]);
let townNames;
function townCode(town) {
    townNames ||= Object.values(require('../../World/TownRespawn').towns).map(row => row.name);
    return townNames.indexOf(town) + 1;
}
function townForCode(code) {
    townNames ||= Object.values(require('../../World/TownRespawn').towns).map(row => row.name);
    return townNames[Number(code) - 1] || null;
}
function selectionFor(route) {
    if (!route) return null;
    const offer = route.exit?.offer;
    const personal = route.context?.stock?.('shots') || route.personalStock;
    const ownReserve = Number(personal?.itemId) === Number(route.recipe.productId) ? Math.max(0, Number(personal.target || 0)) : 0;
    const exit = offer ? [Number(offer.recordId), Number(offer.lineId), Number(route.exit.price),
        Number(offer.revision ?? offer.expectedRevision)] : route.exit?.type === 'use'
        ? [-1, Number(route.exit.ownUseUnits), Number(route.exit.ownUseUnitHours), ownReserve] : null;
    const source = route.gear;
    let gear = null;
    if (source) {
        const quote = source.offer || source;
        const code = source.source === 'craft' ? Number(source.recipe?.recipeId) : source.source === 'owned' ? -1
            : source.source === 'npc' ? -2 : source.source === 'crystals' ? -3 : 0;
        gear = [Number(source.selfId), code, code === 0 ? Number(quote.recordId || 0) : townCode(source.town),
            code === 0 ? Number(quote.lineId || 0) : 0, Number(source.price || 0),
            code === 0 ? Number(quote.revision ?? quote.expectedRevision ?? 0) : 0];
    }
    return { recipeId: Number(route.recipe.recipeId), batches: Number(route.batches),
        ...(exit?.every(Number.isFinite) ? { exit } : {}), ...(gear ? { gear } : {}), ...(ownReserve > 0 ? { ownReserve } : {}) };
}
function fundedDemand(index, productId, price, characterId) {
    let units = 0;
    const seen = new Set();
    for (const signal of index.shotDemand.get(Number(productId)) || []) {
        if (Number(signal.characterId) === Number(characterId) || Number(signal.maxPrice) < price) continue;
        // Compatibility amount/budget fields are public quote depth, never a
        // foreign wallet. Repeated representations of one line count once.
        const key = signal.needId || (signal.authority ? `${signal.authority.recordId}:${signal.authority.lineId}` : signal);
        if (seen.has(key)) continue;
        seen.add(key); units += Math.max(0, Number(signal.amount || 0));
    }
    return units;
}


function recipeTarget(state, index = null, knownRecipeIds = [], selectedRecipeId = 0) {
    if (!index) return null;
    const known = new Set(knownRecipeIds.map(Number));
    let best = null;
    for (const id of SHOT_RECIPE_IDS) {
        if (known.has(id) || selectedRecipeId && Number(id) !== selectedRecipeId) continue;
        const recipe = Recipes.resolveByRecipeId(id);
        if (!recipe || !CraftShopService.canCraft(state, recipe)) continue;
        const route = craftCandidate(state, recipe, index);
        if (!route) continue;
        const asks = index.offersFor(Number(recipe.recipeItemId), 1, state.characterId);
        let ask = null;
        for (const offer of asks) if (Number(offer.price) > 0 && Number(offer.count) > 0
            && (!ask || Number(offer.price) < Number(ask.price))) ask = offer;
        const owned = Number(state.inventory?.[recipe.recipeItemId]?.amount || 0) > 0;
        const bids = index.offersFor(Number(recipe.recipeItemId), 3, state.characterId);
        let sale = null;
        for (const bid of bids) if (Number(bid.count) > 0 && (!sale || bid.price > sale.price)) sale = bid;
        const decision = Wealth.recipePaths(state, recipe, { route,
            acquisition: ask ? { available: true, price: Number(ask.price), hours: Number(route.context?.trip?.details?.(ask.town)?.hours || 0) } : null,
            sale, context: route.context });
        if (!['learn', 'acquire'].includes(decision.best.kind)) continue;
        const entry = { recipe, route, recipeDecision: decision, owned };
        if (!best || decision.best.valueHours > best.recipeDecision.best.valueHours) best = entry;
    }
    return best;
}

function availableMaterial(state, selfId) {
    const reserved = ItemDisposition.reservedEquipmentAmounts(state);
    return Math.max(0, Number(state.inventory?.[selfId]?.amount || 0)
        - Math.max(Number(reserved[selfId] || 0), Number(state.stats?.clanMaterialDemand?.[selfId] || 0)));
}

function scrapCraftRoutes(state, knownRecipes, index) {
    const routes = [];
    const owned = new Map(ItemDisposition.saleCandidates(state, { unlimited: true })
        .map(item => [Number(item.selfId), item]));
    const prices = new Map();
    const purchasePrice = id => {
        if (!prices.has(id)) {
            const offers = index.offersFor(id, 1, state.characterId);
            prices.set(id, { offers, npc: Number(index.npcPrice.get(id) || Infinity) });
        }
        return prices.get(id);
    };
    for (const known of knownRecipes) {
        const recipe = Recipes.resolveByRecipeId(known.recipeId);
        const template = recipe && index.itemTemplates.get(Number(recipe.productId));
        if (!recipe || recipe.type !== 'dwarven' || !CraftShopService.canCraft(state, recipe)
            || Number(recipe.successRate) !== 100 || Number(recipe.productCount) !== 1
            || !/^(Weapon|Armor)\./.test(String(template?.template?.kind || ''))
            || Number(template?.etc?.cristals || 0) <= 0 || Number(recipe.mpCost) >= Number(state.vitals?.mp || 0)) continue;
        let cost = 0, cash = 0;
        const inputs = [];
        for (const material of recipe.materials || []) {
            const id = Number(material.selfId), amount = Number(material.amount);
            const stock = owned.get(id);
            const own = Math.min(amount, Number(stock?.count || 0));
            const { offers, npc } = purchasePrice(id);
            // Each ingredient must have a concrete source for the whole deficit.
            const offer = offers.filter(o => Number(o.count) >= amount - own && Number(o.price) > 0)
                .sort((a, b) => a.price - b.price)[0];
            const price = Math.min(npc, Number(offer?.price || Infinity));
            if (own < amount && !Number.isFinite(price)) { cost = Infinity; break; }
            const spend = own < amount ? (amount - own) * price : 0;
            cost += own * Number(stock?.price || 0) + spend;
            cash += spend;
            inputs.push({ selfId: id, amount, npcPrice: npc, maxPrice: price });
        }
        if (!Number.isFinite(cost) || cost <= 0 || cash > PurchaseFunding.spendable(state, 0, { upperBound: true })) continue;
        routes.push({ selfId: Number(recipe.productId), rank: template.etc.rank,
            source: 'craft', crystals: Number(template.etc.cristals), price: cost, cash,
            unitValue: cost / Number(template.etc.cristals), recipe, inputs });
    }
    return routes;
}

function crystalRoute(state, rank, crystalId, required, index) {
    const routes = (index.gear.get(rank) || []).filter(gear => gear.ownerId !== Number(state.characterId)
        && gear.price <= PurchaseFunding.spendable(state, 0, { upperBound: true }))
        .map(gear => ({ ...gear, cash: gear.price, unitValue: gear.price / gear.crystals }));
    routes.push(...(index.scrapCraftRoutes || []).filter(route => route.rank === rank));
    for (const stock of ItemDisposition.saleCandidates(state, { unlimited: true })) {
        const template = index.itemTemplates.get(Number(stock.selfId));
        if (template?.etc?.rank !== rank || Number(template?.etc?.cristals || 0) < required
            || !/^(Weapon|Armor)\./.test(String(template?.template?.kind || ''))
            || stock.npcComparable === false || Number(stock.enchant || 0) > 0) continue;
        routes.push({ selfId: Number(stock.selfId), source: 'owned', crystals: Number(template.etc.cristals),
            price: stock.price, cash: 0, unitValue: stock.price / Number(template.etc.cristals) });
    }
    for (const offer of index.offersFor(crystalId, 1, state.characterId)) {
        if (Number(offer.price) <= 0 || Number(offer.count) < required) continue;
        routes.push({ selfId: crystalId, source: 'crystals', ownerId: Number(offer.sourceId),
            price: Number(offer.price), unitValue: Number(offer.price), cash: Number(offer.price) * required,
            crystals: Number(offer.count), town: offer.town, offer });
    }
    return routes.filter(route => route.cash <= PurchaseFunding.spendable(state, 0, { upperBound: true }))
        .sort((a, b) => a.unitValue - b.unitValue || a.cash - b.cash)[0] || null;
}

function nativeShotOptions(state, index, context) {
    const trip = context.trip || Profit.tripFor(state, context);
    const reserved = ItemDisposition.reservedEquipmentAmounts(state), ownStock = new Map();
    const stock = context.stock?.('shots');
    for (const key in state.inventory || {}) {
        const row = state.inventory[key], id = Number(row.selfId || key);
        // Accepted incoming shots are the seller's own output too; the reserve
        // for its own use comes off their sum (the recheck's rule).
        const shot = String(index.itemTemplates.get(id)?.template?.kind || '').startsWith('Other.Shot');
        let free = Wealth.freeAmount(state, row, reserved) + (shot ? Number(state.acceptedIncoming?.[id] || 0) : 0);
        if (Number(stock?.itemId) === id) free = Math.max(0, free - Number(stock.target || 0));
        if (free) ownStock.set(id, { count: free, unitValue: Number(context.independentPrice?.(id)
            ?? context.price?.(id) ?? ItemDisposition.priceFor(state, row, index.itemTemplates.get(id))) });
    }
    for (const key in state.acceptedIncoming || {}) {
        const id = Number(key), template = index.itemTemplates.get(id);
        if (ownStock.has(id) || state.inventory?.[id] || !String(template?.template?.kind || '').startsWith('Other.Shot')) continue;
        const free = Math.max(0, Number(state.acceptedIncoming[key] || 0) - (Number(stock?.itemId) === id ? Number(stock.target || 0) : 0));
        if (free) ownStock.set(id, { count: free, unitValue: Number(context.independentPrice?.(id)
            ?? context.price?.(id) ?? ItemDisposition.priceFor(state, { selfId: id }, template)) });
    }
    const preparePurchase = function* (owner, id, amount, query = {}) {
        let plan = null;
        if (index.planPurchase) plan = index.planPurchase(id, amount, query);
        else if (isMainThread) plan = invoke('GameServer/Bot/Economy/ColdMarketService').planPurchase(owner, id, amount, query);
        if (!plan?.whole) {
            const towns = new Map();
            for (const offer of index.offersFor(id, 1, state.characterId)) {
                if (!(offer.price > 0) || !(offer.count > 0)) continue;
                const town = offer.town;
                if (!towns.has(town)) towns.set(town, []);
                towns.get(town).push(offer);
                yield 'quote';
            }
            for (const [town, offers] of towns) {
                const filled = invoke('GameServer/Bot/Economy/OfferQuery').fill(offers, amount, { excludeOwner: owner.characterId });
                const travel = trip(town), landed = filled.cost + travel;
                if (filled.units >= amount && Number.isFinite(landed)
                    && (!plan?.whole || landed < plan.landed)) plan = { ...filled, town, whole: true, landed,
                    tripDetails: trip.details?.(town) };
                yield 'candidate';
            }
        }
        yield 'quote';
        return plan;
    };
    const prepareExits = function* (owner, recipe) {
        const exits = [];
        for (const quote of index.offersFor(Number(recipe.productId), 3, owner.characterId)) {
            if (!(quote.price > 0) || !(quote.count > 0)) continue;
            // The whole ask list, own lines included: the recheck reads the raw board list.
            const { cheaperUnits, limit } = require('./PriceDecision').exitCompetition(
                index.offersFor(Number(recipe.productId), 1),
                { ownerId: owner.characterId, price: Number(quote.price), enchant: Number(quote.enchant || 0), count: Number(quote.count) });
            yield 'quote';
            exits.push({ type: 'afk', conditional: !!quote.conditional, price: Number(quote.price), count: Number(quote.count), cheaperUnits,
                ...(limit ? { applicableUnits: NaN } : {}), town: quote.town, trip: trip(quote.town), tripDetails: trip.details?.(quote.town), offer: quote });
            yield 'quote';
        }
        return exits;
    };
    return { context: { ...context, trip }, options: { ownStock, stock, preparePurchase, prepareExits,
        prepareTrip: function* (town) { yield 'trip'; return trip.details?.(town) || { known: true, hours: 0, fees: 0 }; },
        gearRowsFor: rank => index.gear.get(rank) || [], itemTemplate: id => index.itemTemplates.get(Number(id)),
        knownRecipes: (index.scrapCraftRoutes || []).map(row => ({ recipeId: row.recipe.recipeId })) } };
}
function craftCandidate(state, recipe, index) {
    const context = index.context || Profit.contextFor(state, index.at);
    const input = nativeShotOptions(state, index, context);
    return Basket.drain(recipeShotSearch(state, recipe, input.context, input.options));
}

function batchCount(state, candidate) {
    const mpPerBatch = Number(candidate.recipe.mpCost || 0);
    const ownCrystals = availableMaterial(state, candidate.crystalId);
    const potential = ownCrystals + Number(candidate.gear?.crystals || 0);
    const availableMp = Number(state.vitals?.mp || 0) - Number(candidate.gear?.recipe?.mpCost || 0);
    return Math.max(0, Math.min(64, Number(candidate.batches || 1),
        Math.floor(potential / candidate.requiredCrystals), mpPerBatch > 0 ? Math.floor(availableMp / mpPerBatch) : 64));
}

function eligible(state, now = Date.now()) {
    return state?.phase === 'cold' && ['hunting', 'resting', 'shopping', 'grouped'].includes(state.activity)
        && CraftShopService.isServiceCrafter(state) && CraftShopService.craftLevelFor(state) >= 2
        && !state.party?.partyId && !state.partyId && !state.stats?.craftStationId
        && !invoke('GameServer/Bot/Population/CombinedErrandPolicy').pending(state, now).length
        && !(state.stats?.equipmentPlan?.strategy === 'craft'
            && ['active', 'component_ready', 'ready_to_craft'].includes(state.stats.equipmentPlan.status));
}
function decide(state, index, knownRecipeIds = []) {
    if (!eligible(state, index.at)) return null;
    // Existing published workshop entries also carry learned gear recipes
    // for the unchanged scrap-craft rule; shot DB ids arrive in context.
    const ids = new Set([...knownRecipeIds.map(Number), ...(state.stats?.workshop?.entries || []).map(row => Number(row.recipeId))]);
    const known = [...ids].map(recipeId => ({ recipeId }));
    const shotRecipes = known.map(row => Recipes.resolveByRecipeId(row.recipeId))
        .filter(recipe => recipe && SHOT_RECIPE_IDS.includes(Number(recipe.recipeId))
            && CraftShopService.canCraft(state, recipe));
    const view = { ...index, scrapCraftRoutes: scrapCraftRoutes(state, known, index) };
    const candidate = shotRecipes.map(recipe => craftCandidate(state, recipe, view)).filter(Boolean)
        .sort((a, b) => b.valueHours - a.valueHours)[0];
    if (candidate) {
        const batches = batchCount(state, candidate);
        if (batches > 0) return { craft: { ...selectionFor(candidate), batches } };
    }
    const selected = recipeTarget(state, view, shotRecipes.map(recipe => Number(recipe.recipeId)));
    return selected ? { recipeTarget: Number(selected.recipe.recipeId), recipeRoute: selectionFor(selected.route) } : null;
}
// Heavy shot planning uses the same bounded basket/outcome iterator as wealth.
// Source adapters provide one indexed quote/route per yield; native rechecks
// use the synchronous convenience adapter only for the selected recipe/quantity.
function* recipeShotSearch(state, recipe, context, options = {}) {
    const rank = SHOT_RANK_BY_ID.get(Number(recipe.productId)), crystalId = CRYSTAL_BY_RANK[rank];
    const output = options.itemTemplate?.(recipe.productId) || invoke('GameServer/Item/ItemTemplateIndex')
        .find(invoke('GameServer/DataCache').items, Number(recipe.productId));
    const required = new Map();
    for (const row of recipe.materials || []) {
        required.set(Number(row.selfId), Number(required.get(Number(row.selfId)) || 0) + Number(row.amount));
        yield 'ingredient';
    }
    const requiredCrystals = Number(required.get(crystalId) || 0);
    const oreRows = [];
    for (const entry of required) { if (entry[0] !== crystalId) oreRows.push(entry); yield 'ingredient'; }
    if (!output || !requiredCrystals || oreRows.length !== 1) return null;
    const [oreId, oreAmount] = oreRows[0], ore = { selfId: oreId, amount: oreAmount };
    const ownStock = options.ownStock || new Map();
    const ownFor = id => ownStock.get(Number(id)) || null;
    const trip = context.trip;
    const prepareCrystal = function* (id, missing, allocation = {}) {
        const availableOwn = inputId => {
            const stock = ownFor(inputId);
            return stock ? { ...stock, count: Math.max(0, stock.count - Number(allocation.allocated?.get(inputId) || 0)) } : null;
        };
        let best = options.preparePurchase ? yield* options.preparePurchase(state, id, missing, { npc: false, cost: trip }) : null;
        if (best?.whole) best = { ...best, gear: { selfId: id, source: 'crystals', price: best.cost / missing,
            cash: best.cost, crystals: missing, town: best.town }, score: best.landed };
        else best = null;
        const consider = function* (gear) {
            if (!gear) return;
            if (Number(gear.ownerId) === Number(state.characterId) || Number(gear.crystals) < missing) return;
            const details = ['owned', 'craft'].includes(gear.source) ? { known: true,
                hours: Number(gear.travelHours || 0), fees: 0 }
                : options.prepareTrip ? yield* options.prepareTrip(gear.town) : trip?.details?.(gear.town);
            yield 'trip';
            if (!details?.known) return;
            const cash = Number(gear.cash ?? (gear.source === 'owned' ? 0 : gear.price));
            const ownedValue = Number(gear.ownedValue ?? Math.max(0, Number(gear.price) - cash));
            const mp = Number(gear.recipe?.mpCost || 0), processingHours = mp ? mp / Number(context.mpPerHour) : 0;
            if (!Number.isFinite(processingHours) || !Number.isFinite(cash) || cash < 0 || !Number.isFinite(ownedValue)) return;
            const travel = details.hours * Number(context.hourAdena) + details.fees;
            const score = cash + ownedValue + travel + processingHours * Number(context.hourAdena);
            if (!best || score < best.score) best = { town: gear.town, units: missing, whole: true,
                cost: cash, ownedValue, landed: cash + travel, tripDetails: details,
                processingHours, extraMp: mp, repeatable: false, residualValue: 0, gear, score,
                ownedInputs: gear.ownedInputs };
        };
        for (const row of options.gearRowsFor?.(rank) || []) {
            yield 'edge';
            if (!row) continue;
            yield* consider({ ...row, cash: Number(row.price), ownedValue: 0 });
        }
        for (const [selfId, held] of ownStock) {
            yield 'stock';
            const template = options.itemTemplate?.(selfId) || invoke('GameServer/Item/ItemTemplateIndex')
                .find(invoke('GameServer/DataCache').items, selfId);
            if (!(availableOwn(selfId)?.count > 0) || template?.etc?.rank !== rank || !(Number(template.etc.cristals) >= missing)
                || !/^(Weapon|Armor)\./.test(String(template?.template?.kind || ''))) continue;
            yield* consider({ selfId, source: 'owned', crystals: Number(template.etc.cristals), cash: 0,
                price: Number(held.unitValue), ownedValue: Number(held.unitValue), town: state.currentRegion,
                ownedInputs: [{ selfId, count: 1, unitValue: Number(held.unitValue) }] });
        }
        for (const known of options.knownRecipes || []) {
            const scrap = Recipes.resolveByRecipeId(Number(known.recipeId ?? known));
            yield 'recipe';
            if (!scrap || scrap.type !== 'dwarven' || Number(scrap.successRate) !== 100 || Number(scrap.productCount) !== 1
                || !CraftShopService.canCraft(state, scrap) || Number(scrap.mpCost) >= Number(state.vitals?.mp || 0)) continue;
            const template = options.itemTemplate?.(scrap.productId) || invoke('GameServer/Item/ItemTemplateIndex')
                .find(invoke('GameServer/DataCache').items, Number(scrap.productId));
            if (template?.etc?.rank !== rank || !(Number(template.etc.cristals) >= missing)
                || !/^(Weapon|Armor)\./.test(String(template?.template?.kind || ''))) continue;
            const inputs = yield* Basket.prepareBasket(scrap, () => null, availableOwn, 1, {
                ...context, preparePurchase: (inputId, amount) => options.preparePurchase(state, inputId, amount, { npc: true, cost: trip }) });
            if (!inputs) continue;
            const materialInputs = [], materialAmounts = new Map(), inputQuotes = new Map();
            for (const purchase of inputs.purchases) { inputQuotes.set(purchase.selfId, purchase); yield 'quote'; }
            for (const row of scrap.materials || []) {
                materialAmounts.set(Number(row.selfId), Number(materialAmounts.get(Number(row.selfId)) || 0) + Number(row.amount));
                yield 'ingredient';
            }
            for (const [selfId, amount] of materialAmounts) {
                const purchase = inputQuotes.get(selfId);
                materialInputs.push({ selfId, amount, maxPrice: purchase ? purchase.cost / purchase.count : Infinity });
                yield 'ingredient';
            }
            yield* consider({ selfId: Number(scrap.productId), source: 'craft', recipe: scrap,
                crystals: Number(template.etc.cristals), cash: inputs.cashCost + inputs.actualCashFees,
                price: inputs.cost, ownedValue: inputs.ownedValue, travelHours: inputs.travelHours,
                town: state.currentRegion, inputs: materialInputs, ownedInputs: inputs.owned,
                purchases: inputs.purchases });
        }
        return best;
    };
    const preparePurchase = (id, amount, allocation) => Number(id) === crystalId ? prepareCrystal(id, amount, allocation)
        : options.preparePurchase(state, id, amount, { npc: true, cost: trip });
    const exits = options.prepareExits ? yield* options.prepareExits(state, recipe, output, trip) : [];
    const personal = options.stock || context.stock?.('shots');
    if (Number(personal?.itemId) === Number(recipe.productId)) {
        const missing = Math.max(0, Number(personal.survivalMissing || 0) + Number(personal.missing || 0));
        const unitValue = Number(personal.benefitHours || 0) / Math.max(1, Number(personal.target || missing));
        if (missing && unitValue > 0) exits.push({ type: 'use', price: 0, count: 0, ownUseUnits: missing,
            ownUseUnitHours: unitValue, residualUnitValue: 0 });
    }
    const selected = yield* Basket.searchQuantity({ state: { ...state,
        adena: PurchaseFunding.spendable(state, 0, { upperBound: true }) }, recipe, exits, ownedFor: ownFor,
        planFor: () => null, context: { ...context, preparePurchase } });
    if (!selected) return null;
    const cash = selected.basket.cashCost + selected.basket.actualCashFees;
    const r = cash > 0 ? selected.valueHours / cash : Infinity;
    if (cash > PurchaseFunding.spendable(state, 0, { r })) return null;
    const orePurchase = selected.basket.purchases.find(row => row.selfId === oreId);
    const crystalPurchase = selected.basket.purchases.find(row => row.selfId === crystalId);
    return { ...selected, output, rank, crystalId, requiredCrystals, ore,
        orePrice: orePurchase ? orePurchase.cost / orePurchase.count : Number(ownFor(oreId)?.unitValue || 0),
        gear: crystalPurchase?.source || null, salePrice: selected.exit.price,
        profit: selected.expectedProfit, cost: selected.basket.cost, demand: selected.exit.count,
        r, context, personalStock: personal };
}
function* shotSearch(state, knownRecipes, context, options) {
    const ids = new Set();
    for (const row of knownRecipes || []) { ids.add(Number(row.recipeId ?? row)); yield 'recipe'; }
    for (const id of unpackKnown(options.knownShotRecipes || [])) { ids.add(id); yield 'recipe'; }
    let best = null, recipeChoice = null;
    const shared = { ...options, knownRecipes };
    for (const id of SHOT_RECIPE_IDS) {
        const recipe = Recipes.resolveByRecipeId(id);
        yield 'recipe';
        if (!recipe || !CraftShopService.canCraft(state, recipe)) continue;
        const route = yield* recipeShotSearch(state, recipe, context, shared);
        if (!route) continue;
        if (ids.has(id)) {
            if (!best || route.valueHours > best.valueHours) best = route;
            continue;
        }
        const owned = Number(state.inventory?.[recipe.recipeItemId]?.amount || 0) > 0;
        const scrollPurchase = !owned && options.preparePurchase
            ? yield* options.preparePurchase(state, Number(recipe.recipeItemId), 1, { npc: false, cost: context.trip }) : null;
        const scrollExits = options.prepareExits ? yield* options.prepareExits(state,
            { productId: recipe.recipeItemId }, { template: { kind: 'Other.Recipe' } }, context.trip) : [];
        let sale = null;
        for (const exit of scrollExits) { if (!sale || exit.price > sale.price) sale = exit; yield 'quote'; }
        const decision = Wealth.recipePaths(state, recipe, { route, sale,
            acquisition: scrollPurchase?.whole ? { available: true, price: scrollPurchase.cost,
                hours: scrollPurchase.tripDetails?.hours || 0 } : null, context });
        yield 'utility';
        if (['learn', 'acquire'].includes(decision.best.kind)
            && (!recipeChoice || decision.best.valueHours > recipeChoice.valueHours)) recipeChoice = {
            recipe, route, decision, valueHours: decision.best.valueHours };
    }
    if (recipeChoice && (!best || recipeChoice.valueHours > best.valueHours)) {
        options.onSelection?.(recipeChoice.valueHours);
        return {
        recipeTarget: Number(recipeChoice.recipe.recipeId), recipeRoute: selectionFor(recipeChoice.route) };
    }
    options.onSelection?.(Number(best?.valueHours || 0));
    return best ? { craft: selectionFor(best) } : null;
}
function createShot(state, knownRecipes, context, options = {}) {
    const cursor = { iterator: null, done: false, value: null, stage: 0, units: 0, mode: 'action', selectedValueHours: 0 };
    cursor.iterator = shotSearch(state, knownRecipes, context, { ...options,
        onSelection: value => { cursor.selectedValueHours = value; } });
    return cursor;
}
const stepShot = Wealth.stepAction;
function resultShot(cursor) { return cursor.done ? cursor.value : null; }

// ARCH-NOTE: the native catalogue has fifteen shot recipes. Ordinary contexts
// carry <=8 IDs; a rare larger collection uses one negative 15-bit bitmap, so
// every known recipe is retained within the fixed eight-number/64-byte budget.
function packKnown(ids) {
    const shot = [...new Set(ids.map(Number))].filter(id => SHOT_RECIPE_IDS.includes(id));
    if (shot.length <= 8) return shot;
    return [-1 - shot.reduce((mask, id) => mask | (1 << SHOT_RECIPE_IDS.indexOf(id)), 0)];
}
function unpackKnown(ids = []) {
    if (ids.length === 1 && Number(ids[0]) < 0) {
        const mask = -1 - Number(ids[0]);
        return SHOT_RECIPE_IDS.filter((id, at) => mask & (1 << at));
    }
    return ids.map(Number).filter(id => SHOT_RECIPE_IDS.includes(id));
}
// The command header reserves 59 B. Sparse tuples retain source identity in
// the remaining 69 B; exact public revisions let native rechecks recover the
// unchanged price/record from the same bounded indexed view.
function packStep(step) {
    const sparseExit = row => !row ? [] : row[0] > 0 || row[0] == null ? [Number(row[1]), Number(row[3])]
        : row[0] === -1 ? [0, Number(row[1]), Number(row[2]), Number(row[3])]
            : [-Number(row[1]), Number(row[2])];
    const sparseGear = row => !row ? [] : Number(row[1]) === 0 ? [Number(row[0]), 0, Number(row[3]), Number(row[5])]
        : Number(row[1]) === -2 ? [Number(row[0]), -2, Number(row[2]), Number(row[4])]
            : Number(row[1]) === -3 ? [Number(row[0]), -3, Number(row[2])] : [Number(row[0]), Number(row[1])];
    const tuple = action => {
        const row = [Number(action.recipeId), Number(action.batches)];
        if (action.exit || action.gear || action.ownReserve) row.push(sparseExit(action.exit));
        if (action.gear || action.ownReserve) row.push(sparseGear(action.gear));
        if (action.ownReserve) row.push(Number(action.ownReserve));
        if (action.scroll) {
            while (row.length < 5) row.push(null);
            row.push(action.scroll.map(Number));
        }
        return row;
    };
    if (step?.craft) return { craft: tuple(step.craft) };
    if (step?.recipeTarget && step.recipeRoute) return { recipeTarget: tuple(step.recipeRoute) };
    if (step?.wealth) return { wealth: tuple({ ...step.wealth, batches: step.wealth.batches || 1 }) };
    return step;
}
function unpackStep(step) {
    const action = row => {
        const result = { recipeId: Number(row[0]), batches: Number(row[1]) };
        if (Array.isArray(row[5])) result.scroll = row[5].map(Number);
        if (Array.isArray(row[2])) {
            const exit = row[2], gear = row[3];
            if (exit.length === 2) result.exit = exit[0] > 0 ? [null, Number(exit[0]), null, Number(exit[1])]
                : [0, -Number(exit[0]), Number(exit[1]), 0];
            else if (exit.length === 4 && exit[0] === 0) result.exit = [-1, Number(exit[1]), Number(exit[2]), Number(exit[3])];
            if (Array.isArray(gear) && gear.length >= 2) result.gear = gear[1] === 0
                ? [Number(gear[0]), 0, null, Number(gear[2]), null, Number(gear[3])]
                : [Number(gear[0]), Number(gear[1]), Number(gear[2] || 0), 0, Number(gear[3] || 0), 0];
            if (row[4] > 0) result.ownReserve = Number(row[4]);
        } else {
            // Existing durable compact packets retain their former six fields.
            if (row.length >= 6 && !Array.isArray(row[5]) && (row[2] !== 0 || row[3] > 0)) result.exit = row.slice(2, 6).map(Number);
            if (row.length >= 12 && row[6] > 0) result.gear = row.slice(6, 12).map(Number);
            if (row.length === 13 && row[12] > 0) result.ownReserve = Number(row[12]);
        }
        return result;
    };
    if (Array.isArray(step?.craft)) return { craft: action(step.craft) };
    if (Array.isArray(step?.recipeTarget)) return { recipeTarget: Number(step.recipeTarget[0]), recipeRoute: action(step.recipeTarget) };
    if (Array.isArray(step?.wealth)) return { wealth: action(step.wealth) };
    if (typeof step?.wealth === 'number') return { wealth: { recipeId: step.wealth, batches: 1 } };
    return step;
}

module.exports = { SHOT_RECIPE_IDS, SHOT_PRODUCT_IDS, SHOT_RECIPE_ITEM_IDS, CRYSTAL_BY_RANK,
    availableMaterial, fundedDemand, recipeTarget, scrapCraftRoutes, crystalRoute, craftCandidate,
    batchCount, eligible, decide, packKnown, unpackKnown, packStep, unpackStep,
    recipeShotSearch, createShot, stepShot, resultShot, selectionFor, townCode, townForCode };
