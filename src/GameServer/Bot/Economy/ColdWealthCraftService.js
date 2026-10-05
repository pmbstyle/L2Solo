const Policy = require('./WealthCraftPolicy');
const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');
const Karma = require('../../Karma');
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const LifeEvents = invoke('GameServer/Bot/Population/BotLifeEvents');
const CraftShopService = invoke('GameServer/Bot/Economy/CraftShopService');
const StaticBuyerService = invoke('GameServer/Bot/Economy/StaticBuyerService');
const StaticMerchantPricing = invoke('GameServer/Bot/Economy/StaticMerchantPricing');
const MerchantStoreConfigs = invoke('GameServer/Bot/MerchantStoreConfigs');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const PurchaseFunding = invoke('GameServer/Bot/Economy/PurchaseFunding');
const BotPersona = invoke('GameServer/Bot/AI/BotPersona');
const MarketTelemetry = invoke('GameServer/Bot/Economy/MarketTelemetry');

const SCAN_INTERVAL_MS = 5 * 60 * 1000;
const lastEmptyScan = new Map();
const inFlight = new Set();

function eligible(state) {
    if (!state || state.phase !== 'cold' || !['hunting', 'resting', 'shopping'].includes(state.activity)
        || state.stats?.marketErrand
        || state.party?.partyId || state.partyId || Karma.closesTowns(state.stats?.karma)
        || state.stats?.craftStationId || /^bot_craft_\d+$/i.test(String(state.accountName || ''))) return false;
    if (!CraftShopService.isServiceCrafter(state)) return false;
    if (CraftShopService.craftLevelFor(state) <= 0) return false;
    if (state.stats?.equipmentPlan?.strategy === 'craft'
        && ['active', 'component_ready', 'ready_to_craft'].includes(state.stats.equipmentPlan.status)) return false;
    // A bot asking for something on the board keeps its money for that.
    if (invoke('GameServer/Bot/Economy/BotAfkMarketService').buyOrderEscrow(state.characterId) > 0) return false;
    const previousCraft = state.stats?.wealthCraft;
    if (previousCraft?.outcome === 'waiting_for_buyer') {
        const outputId = Number(previousCraft.productId || 0);
        const inInventory = Number(state.inventory?.[String(outputId)]?.amount || 0) > 0;
        const inShop = AfkTrade.ownerRecords(state.characterId).some((record) => Number(record.storeType) === AfkTrade.SELL
            && (record.lines || []).some((line) => Number(line.selfId) === outputId && Number(line.count) > 0));
        if (inInventory || inShop) return false;
    }
    return BotPersona.of(state)?.primaryDrive === 'wealth';
}

function staticExits(recipe, template) {
    if (!String(template?.template?.kind || '').startsWith('Other.Material')) return [];
    return [...new Set(Object.values(MerchantStoreConfigs)
        .filter((store) => Number(store?.storeType) === AfkTrade.BUY && store.town)
        .map((store) => store.town))]
        .flatMap((town) => StaticBuyerService.buyersInTown(town).flatMap((buyer) => {
            const line = (buyer.items || []).find((item) => Number(item.selfId) === Number(recipe.productId));
            const price = line ? StaticMerchantPricing.priceFor(buyer, line) : 0;
            return Number.isFinite(price) && price > 0
                ? [{ type: 'static', price, count: Number(recipe.productCount), town, buyerName: buyer.name }] : [];
        }));
}

// The buyers of a craft: the buy ads on the board, each answered in its town
// (its trip counts against the profit, E45), and the static buyers (until
// step 3.6).
function exitsFor(state, recipe, template, trip) {
    const dynamic = AfkTrade.offers(recipe.productId, AfkTrade.BUY, { characterId: state.characterId })
        .map((offer) => ({ type: 'afk', price: Number(offer.price), count: Number(offer.count), offer, trip: trip(offer.town) }));
    return [...dynamic, ...staticExits(recipe, template)].sort((a, b) => b.price - a.price);
}

function chooseOpportunity(state, knownRecipes) {
    let best = null;
    // An active market gear plan keeps what its purchase needs (price and
    // reserve): inputs are bought only with the rest of the wallet. A bot
    // with its own buy order does not craft at all (eligible), so no escrow.
    const gearPlan = state.stats?.equipmentPlan;
    const budgetState = { ...state, adena: gearPlan?.status === 'active' && gearPlan.strategy === 'market'
        ? PurchaseFunding.surplus(state, gearPlan.market?.price, gearPlan.market?.reserve)
        : PurchaseFunding.budget(state) };
    // Each input is one purchase in the town where it costs the least with
    // the trip (the one purchase path): its landed price is the input's cost.
    const ColdMarket = invoke('GameServer/Bot/Economy/ColdMarketService');
    const trip = ColdMarket.tripFrom(state);
    const planCache = new Map();
    const ownStock = new Map(ItemDisposition.saleCandidates(state, { unlimited: true })
        .map((item) => [Number(item.selfId), item]));
    const ownValueCache = new Map();
    const planFor = (selfId, missing) => {
        const key = `${selfId}:${missing}`;
        if (!planCache.has(key)) planCache.set(key, ColdMarket.planPurchase(state, selfId, missing, { npc: false, cost: trip }));
        return planCache.get(key);
    };
    const ownedFor = (selfId) => {
        const stock = ownStock.get(Number(selfId));
        if (!stock || Number(stock.count || 0) <= 0) return null;
        if (!ownValueCache.has(selfId)) {
            const fixedBids = staticExits({ productId: selfId, productCount: 1 },
                ItemTemplateIndex.find(DataCache.items, selfId));
            // A buy ad is worth its price less the trip to answer it.
            const dynamicBids = AfkTrade.offers(selfId, AfkTrade.BUY, { characterId: state.characterId });
            ownValueCache.set(selfId, Math.max(Number(stock.price || 0),
                ...fixedBids.map((bid) => Number(bid.price || 0)),
                ...dynamicBids.map((bid) => Number(bid.price || 0)
                    - trip(bid.town) / Math.max(1, Math.min(Number(stock.count), Number(bid.count) || 1)))));
        }
        return { count: Number(stock.count), unitValue: ownValueCache.get(selfId) };
    };
    for (const known of knownRecipes || []) {
        const recipe = Recipes.resolveByRecipeId(known.recipeId);
        if (!recipe || recipe.type !== 'dwarven' || !CraftShopService.canCraft(state, recipe)) continue;
        const template = ItemTemplateIndex.find(DataCache.items, recipe.productId);
        if (!template || !recipe.materials?.length) continue;
        const exits = exitsFor(state, recipe, template, trip);
        if (!exits.length) continue;
        const candidate = Policy.opportunityFor(budgetState, recipe, planFor, exits, ownedFor);
        if (candidate && (!best || candidate.expectedProfit > best.expectedProfit)) {
            best = { ...candidate, template };
        }
    }
    return best;
}

async function refreshCraftedInventory(state, recipe) {
    const inventory = { ...(state.inventory || {}) };
    for (const material of recipe.materials || []) delete inventory[String(material.selfId)];
    delete inventory[String(recipe.productId)];
    return LifeState.refreshInventory({ ...state, inventory });
}

function materialRows(items, recipe) {
    const selected = [];
    for (const material of recipe.materials || []) {
        let missing = Number(material.amount || 0);
        for (const row of items || []) {
            if (missing <= 0) break;
            if (Number(row.selfId) !== Number(material.selfId) || row.equipped) continue;
            const amount = Math.min(missing, Number(row.amount || 0));
            if (amount <= 0) continue;
            selected.push({ id: Number(row.id), selfId: Number(material.selfId), amount });
            missing -= amount;
        }
        if (missing > 0) return null;
    }
    return selected;
}

function withOutcome(state, opportunity, outcome, extras = {}) {
    return {
        ...state,
        stats: {
            ...(state.stats || {}),
            wealthCraft: {
                recipeId: Number(opportunity.recipe.recipeId),
                productId: Number(opportunity.recipe.productId),
                inputCost: Number(opportunity.basket.cost),
                expectedProfit: Number(opportunity.expectedProfit),
                outcome,
                at: Date.now(),
                ...extras
            }
        }
    };
}

async function execute(state, opportunity) {
    const recipe = opportunity.recipe;
    if (opportunity.basket.owned.length) {
        const physical = await Database.fetchItems(state.characterId);
        if (opportunity.basket.owned.some((stock) => physical
            .filter((item) => Number(item.selfId) === Number(stock.selfId) && !item.equipped)
            .reduce((count, item) => count + Number(item.amount || 0), 0) < Number(stock.count))) {
            return { state, crafted: false, reason: 'owned_materials_changed' };
        }
    }
    let current = await LifeState.upsertState(withOutcome(state, opportunity, 'buying'), 'wealth_craft_started');
    if (!current) return { state, crafted: false, reason: 'state_write_rejected' };
    let spent = 0;
    try {
        // Each input is bought in its town (the one purchase path): here, or
        // the bot goes there and the craft waits for the next look.
        const ColdMarket = invoke('GameServer/Bot/Economy/ColdMarketService');
        for (const purchase of opportunity.basket.purchases) {
            const bought = await ColdMarket.acquire(current, purchase.selfId, purchase.count,
                { towns: [purchase.town], npc: false, purpose: 'wealth_craft' });
            // The bot went hot: the actor holds the materials; the craft stops here.
            if (bought.hot) return { state: current, crafted: false, reason: 'bot_went_hot', spent };
            if (!bought.bought && (bought.traveling || bought.state?.stats?.marketErrand)) {
                return { state: bought.state, crafted: false, reason: 'buying_trip', spent };
            }
            if (!bought.bought) throw new Error('purchase_unavailable');
            spent += purchase.cost;
            current = bought.state;
        }
    } catch (error) {
        const failed = withOutcome(current, opportunity, 'purchase_failed',
            { spent, error: String(error?.message || error) });
        return { state: await LifeState.upsertState(failed, 'wealth_craft_purchase_failed') || failed,
            crafted: false, reason: 'purchase_failed' };
    }

    const items = await Database.fetchItems(current.characterId);
    const materials = materialRows(items, recipe);
    if (!materials) {
        const failed = withOutcome(current, opportunity, 'materials_changed', { spent });
        return { state: await LifeState.upsertState(failed, 'wealth_craft_materials_changed') || failed,
            crafted: false, reason: 'materials_changed' };
    }

    if (opportunity.exit.type === 'afk' && current.currentRegion === opportunity.exit.offer.town
        && !AfkTrade.offers(recipe.productId, AfkTrade.BUY,
        { characterId: current.characterId }).some((offer) => (
        Number(offer.sourceId) === Number(opportunity.exit.offer.sourceId)
            && Number(offer.price) >= Number(opportunity.exit.price)
            && Number(offer.count) >= Number(recipe.productCount)
    ))) {
        const changed = withOutcome(current, opportunity, 'buyer_changed', { spent });
        return { state: await LifeState.upsertState(changed, 'wealth_craft_buyer_changed') || changed,
            crafted: false, reason: 'buyer_changed' };
    }

    const success = Number(recipe.successRate || 0) >= 100
        || Math.random() * 100 < Number(recipe.successRate || 0);
    const product = success ? {
        selfId: Number(recipe.productId),
        name: opportunity.template.template?.name || '',
        amount: Number(recipe.productCount),
        stackable: !!opportunity.template.etc?.stackable,
        slot: Number(opportunity.template.etc?.slot || 0)
    } : null;
    const remainingMp = Math.max(0, Number(current.vitals?.mp || 0) - Number(recipe.mpCost || 0));
    try {
        const crafted = await Database.craftInventoryItems(current.characterId, {
            materials, product, coldState: current, mp: remainingMp
        });
        if (crafted?.coldLifeRow) current = LifeState.acceptLifecycleRow(crafted.coldLifeRow);
    } catch (error) {
        const failed = withOutcome(current, opportunity, 'craft_rejected',
            { spent, error: String(error?.message || error) });
        return { state: await LifeState.upsertState(failed, 'wealth_craft_rejected') || failed,
            crafted: false, reason: 'craft_rejected' };
    }

    current = await refreshCraftedInventory({ ...current, vitals: {
        ...(current.vitals || {}), mp: remainingMp
    } }, recipe);
    current = await LifeState.upsertState(withOutcome(current, opportunity, success ? 'crafted' : 'failed_roll',
        { spent }), 'wealth_craft_resolved') || current;
    if (!success) {
        await LifeEvents.record(current.characterId, 'wealth_craft_failed',
            `${current.name} failed to craft ${opportunity.template.template?.name || `item ${recipe.productId}`}`, {
                recipeId: recipe.recipeId, productId: recipe.productId,
                spent, inputValue: opportunity.basket.cost
            }, 1);
        return { state: current, crafted: false, reason: 'failed_roll' };
    }

    let sold = false;
    let revenue = 0;
    const exit = opportunity.exit;
    if (exit.type === 'static') {
        const saved = await LifeState.applyNpcLiquidation(current, [{ selfId: recipe.productId,
            count: Number(recipe.productCount), npcPrice: Number(exit.price) }], {
            source: 'wealth_craft', town: exit.town, buyerName: exit.buyerName
        });
        const payout = Number(saved?.adena || 0) - Number(current.adena || 0);
        if (saved && payout >= Number(exit.price) * Number(recipe.productCount)) {
            current = saved;
            sold = true;
            revenue = payout;
            MarketTelemetry.staticBuyerSale?.([{
                selfId: recipe.productId, name: product.name, count: Number(recipe.productCount),
                npcPrice: Number(exit.price), buyerName: exit.buyerName, buyerTown: exit.town
            }], payout, {
                sellerCharacterId: current.characterId, sellerName: current.name, town: exit.town
            });
        }
    } else if (current.activity === 'shopping' && current.currentRegion === exit.offer.town) {
        // A buy ad is answered in its town (E45); elsewhere the product waits
        // for the bot's sale, which goes there when it pays (MarketPricing.disposition).
        const offer = AfkTrade.offers(recipe.productId, AfkTrade.BUY, { characterId: current.characterId })
            .find((entry) => Number(entry.sourceId) === Number(exit.offer.sourceId)
                && Number(entry.price) >= Number(exit.price)
                && Number(entry.count) >= Number(recipe.productCount));
        const productRow = (await Database.fetchItems(current.characterId))
            .find((item) => Number(item.selfId) === Number(recipe.productId)
                && Number(item.amount) >= Number(recipe.productCount) && !item.equipped);
        if (offer && productRow) {
            try {
                const trade = await AfkTrade.sellToShop(current.characterId, offer.store, recipe.productId,
                    Number(recipe.productCount), { objectId: Number(productRow.id), lineId: offer.lineId,
                        expectedPrice: Number(offer.price), coldState: current });
                const done = AfkTrade.committedTrade(trade, current.characterId);
                const payout = Number(done.state?.adena || 0) - Number(current.adena || 0);
                if (done.hot) {
                    // The actor holds the payout; the settlement below is not written for a hot bot.
                    sold = true;
                    revenue = Number(offer.price) * Number(recipe.productCount);
                } else if (done.state && payout >= Number(offer.price) * Number(recipe.productCount)) {
                    current = done.state;
                    sold = true;
                    revenue = payout;
                }
            } catch (_) {
                // The output remains in inventory for the normal sale policy.
            }
        }
    }
    const outcome = sold ? 'sold' : 'waiting_for_buyer';
    const settled = withOutcome(current, opportunity, outcome,
        { spent, revenue, profit: sold ? revenue - Number(opportunity.basket.cost) : null,
            cashGain: sold ? revenue - spent : null });
    current = await LifeState.upsertState(settled, `wealth_craft_${outcome}`) || settled;
    await LifeEvents.record(current.characterId, 'wealth_craft', `${current.name} crafted ${product.name}${sold ? ` for ${revenue - Number(opportunity.basket.cost)} Adena profit` : ''}`, {
        recipeId: recipe.recipeId, productId: recipe.productId, spent, inputValue: opportunity.basket.cost, revenue,
        outcome, exit: exit.type
    }, sold ? 2 : 1);
    return { state: current, crafted: true, sold, spent, revenue, reason: outcome };
}

async function tryCraft(state, timestamp = Date.now()) {
    if (!eligible(state)) return { state, crafted: false, reason: 'ineligible' };
    const characterId = Number(state.characterId);
    if (inFlight.has(characterId)) return { state, crafted: false, reason: 'in_flight' };
    if (timestamp - Number(lastEmptyScan.get(characterId) || 0) < SCAN_INTERVAL_MS) {
        return { state, crafted: false, reason: 'scan_cooldown' };
    }
    inFlight.add(characterId);
    try {
        const known = await Database.fetchCharacterRecipes(characterId);
        const opportunity = chooseOpportunity(state, known);
        if (!opportunity) {
            lastEmptyScan.set(characterId, timestamp);
            return { state, crafted: false, reason: 'no_profit' };
        }
        lastEmptyScan.delete(characterId);
        return await execute(state, opportunity);
    } catch (error) {
        utils.infoWarn('BotWealth', 'wealth craft failed for %s: %s', state.name, error?.message || String(error));
        return { state: LifeState.snapshot(characterId) || state, crafted: false, reason: 'error' };
    } finally {
        inFlight.delete(characterId);
    }
}

module.exports = { eligible, chooseOpportunity, tryCraft };
