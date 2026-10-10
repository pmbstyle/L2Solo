const Policy = require('./WealthCraftPolicy');
const Profit = require('./CraftProfitPolicy');
const Workshops = require('./CraftWorkshopService');
const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');
const Karma = require('../../Karma');
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const LifeEvents = invoke('GameServer/Bot/Population/BotLifeEvents');
const CraftShopService = invoke('GameServer/Bot/Economy/CraftShopService');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const PurchaseFunding = invoke('GameServer/Bot/Economy/PurchaseFunding');
const MarketTelemetry = invoke('GameServer/Bot/Economy/MarketTelemetry');
const Commit = require('./EconomyCommit');
const { personalOfferAllowed } = require('../Population/PartyAdmission');

const inFlight = new Set();

// Spending rechecks a single worker-selected native batch/exit. It uses the
// current scalar purse and at most five indexed input quotes; it never builds
// wishes, a catalogue scan, or a new quantity optimisation on main.
function recheck(state, step = {}, knownRecipes = Workshops.cachedRecipes(state.characterId)) {
    const recipe = Recipes.resolveByRecipeId(Number(step.recipeId)), batches = Number(step.batches || 1);
    const packet = state.stats?.money;
    if (!recipe || !CraftShopService.canCraft(state, recipe) || !Number.isSafeInteger(batches)
        || batches < 1 || batches > 64 || !Array.isArray(packet) || !(packet[0] > 0) || !(packet[1] > 0)) return null;
    const template = ItemTemplateIndex.find(DataCache.items, Number(recipe.productId));
    if (!template) return null;
    const board = AfkTrade.boardIndex();
    const context = { hourAdena: Number(packet[0]), moneyPrice: Number(packet[1]),
        ...invoke('GameServer/Bot/Population/ColdOccupationSources').craftLabour(state), fixedBatches: batches };
    const trip = Profit.tripFor(state, context); context.trip = trip;
    const learning = !(knownRecipes || []).some(row => Number(row.recipeId ?? row) === Number(recipe.recipeId));
    let scrollQuote = null;
    if (learning) {
        if (!Array.isArray(step.scroll) || !ItemDisposition.canLearnRecipe(state, { selfId: Number(recipe.recipeItemId) })) return null;
        const owned = require('./WealthCraftDecision').freeAmount(state, state.inventory?.[recipe.recipeItemId] || {});
        if (!owned) {
            if (step.scroll.length !== 2) return null;
            scrollQuote = board.list(recipe.recipeItemId, AfkTrade.SELL).slice(0, 5).find(row =>
                Number(row.lineId) === Number(step.scroll[0]) && Number(row.revision) === Number(step.scroll[1])
                && Number(row.ownerId) !== Number(state.characterId) && Number(row.count) >= 1
                && Number(row.price) > 0 && !Number(row.enchant || 0) && personalOfferAllowed(row, state));
            if (!scrollQuote) return null;
        }
        context.recipeInput = Number(recipe.recipeItemId);
    }
    let exit = null;
    if (Array.isArray(step.exit) && step.exit.length === 4) {
        const [recordId, lineId, price, revision] = step.exit.map(Number);
        const compact = step.exit[0] == null && step.exit[2] == null;
        if (recordId > 0 || compact) {
            const line = compact ? board.list(recipe.productId, AfkTrade.BUY).slice(0, 5)
                .find(row => Number(row.lineId) === lineId) : board.records.get(recordId)?.find(row => Number(row.lineId) === lineId);
            if (!line || line.storeType !== AfkTrade.BUY || line.revision !== revision || !compact && line.price !== price || line.count <= 0
                || line.ownerId === Number(state.characterId) || line.selfId !== Number(recipe.productId)
                || !personalOfferAllowed(line, state)) return null;
            exit = { type: 'afk', conditional: line.custodyPolicy === 1, price: Number(line.price), count: line.count, town: line.town, offer: require('../../AfkTrade/BoardIndex').offerFields(line) };
        } else {
            const fixed = staticExits(recipe, template)[lineId - 1];
            if (!fixed || Number(fixed.price) !== price) return null;
            exit = fixed;
        }
    } else {
        // Legacy compact packets are accepted only through a bounded current
        // indexed look. New packets preserve the selected quote identity.
        const lines = board.list(recipe.productId, AfkTrade.BUY);
        for (let at = 0; at < Math.min(5, lines.length); at++) {
            const line = lines[at];
            if (line.ownerId !== Number(state.characterId) && line.count > 0 && personalOfferAllowed(line, state)) {
                exit = { type: 'afk', conditional: line.custodyPolicy === 1, price: line.price, count: line.count, town: line.town,
                    offer: require('../../AfkTrade/BoardIndex').offerFields(line) }; break;
            }
        }
        if (!exit) exit = staticExits(recipe, template)[0] || null;
    }
    if (!exit) return null;
    exit = { ...exit, trip: trip(exit.town), tripDetails: trip.details?.(exit.town) };
    let cheaperUnits = 0;
    const asks = board.list(recipe.productId, AfkTrade.SELL);
    for (let at = 0; at < Math.min(5, asks.length); at++) if (asks[at].ownerId !== Number(state.characterId)
        && asks[at].price < exit.price) cheaperUnits += asks[at].count;
    exit.cheaperUnits = cheaperUnits;
    // Raw indexed depth is the same view the worker receives. A competitive
    // tail can change F(q), so the selected forecast remains unsupported.
    if (exit.type === 'afk' && asks.length > 5 && Number(asks[5].price) < exit.price
        && cheaperUnits < exit.count) return null;
    exit = require('./PriceDecision').prospectiveExit(state, exit, { board, timestamp: Date.now() });
    const ownedFor = id => {
        const row = state.inventory?.[id];
        if (!row) return null;
        const protectedCount = Math.max(Number(row.protectedAmount || 0), Number(row.starterMobLootAmount || 0),
            Number(row.reservedAmount || 0), Number(state.stats?.clanMaterialDemand?.[id] || 0));
        const count = require('./WealthCraftDecision').freeAmount(state, row, { [id]: protectedCount });
        const item = ItemTemplateIndex.find(DataCache.items, Number(id));
        let value = invoke('GameServer/Items/NpcSellRules').npcBuyPrice(Number(item?.template?.price || 0));
        const bids = board.list(id, AfkTrade.BUY);
        for (let at = 0; at < Math.min(5, bids.length); at++) if (bids[at].ownerId !== Number(state.characterId)) value = Math.max(value, bids[at].price);
        for (const fixed of staticExits({ productId: id }, item)) value = Math.max(value, fixed.price);
        return { count: Number(id) === Number(recipe.productId) ? Math.max(0, count - Number(step.ownReserve || 0)) : count,
            unitValue: value };
    };
    const ownOutput = board.ownerLines(state.characterId).filter(line => line.storeType === AfkTrade.SELL
        && line.custodyPolicy !== 1 && line.selfId === Number(recipe.productId) && !Number(line.enchant || 0));
    if (ownOutput.some(line => line.price !== Number(exit.price))) return null;
    context.existingOutput = Number(ownedFor(Number(recipe.productId))?.count || 0)
        + ownOutput.reduce((sum, line) => sum + Number(line.count), 0)
        + Number(state.acceptedIncoming?.[recipe.productId] || 0);
    const planFor = (id, amount) => {
        if (learning && Number(id) === Number(recipe.recipeItemId)) {
            if (!scrollQuote || amount !== 1) return null;
            const travel = trip(scrollQuote.town);
            return { town: scrollQuote.town, units: 1, whole: true, cost: Number(scrollQuote.price),
                landed: Number(scrollQuote.price) + travel, tripDetails: trip.details?.(scrollQuote.town),
                lines: [{ line: scrollQuote, count: 1, price: Number(scrollQuote.price) }], npc: 0 };
        }
        const groups = new Map(), lines = board.list(id, AfkTrade.SELL);
        for (let at = 0; at < Math.min(5, lines.length); at++) {
            const line = lines[at];
            if (line.ownerId === Number(state.characterId) || Number(line.enchant || 0) || !personalOfferAllowed(line, state)) continue;
            if (!groups.has(line.town)) groups.set(line.town, { lines: [], npcPrice: 0 });
            groups.get(line.town).lines.push(line);
        }
        if (require('./ProductionPolicy').allowsNpcShot(id)) {
            const sources = require('../Population/ColdOccupationSources'); sources.initialise();
            for (const row of sources.npcOffersFor(id)) {
                if (!groups.has(row.town)) groups.set(row.town, { lines: [], npcPrice: 0 });
                const group = groups.get(row.town);
                group.npcPrice = group.npcPrice ? Math.min(group.npcPrice, Number(row.price)) : Number(row.price);
            }
        }
        let best = null;
        for (const [town, group] of groups) {
            const filled = require('./OfferQuery').fill(group.lines, amount, { excludeOwner: state.characterId, npcPrice: group.npcPrice });
            const travel = trip(town), landed = filled.cost + travel;
            if (filled.units < amount || !Number.isFinite(landed)) continue;
            if (!best || landed < best.landed) best = { town, ...filled, whole: true, landed,
                tripDetails: trip.details?.(town), npcPrice: group.npcPrice, quoteDepth: 5 };
        }
        return best;
    };
    if (learning) context.recipeStock = ownedFor(Number(recipe.recipeItemId));
    const candidate = Policy.evaluateBasket({ state, recipe, batches, planFor, exit, ownedFor, context });
    if (!candidate || !(candidate.valueHours > 0)) return null;
    const cash = candidate.basket.cashCost + candidate.basket.actualCashFees;
    const r = cash > 0 ? candidate.valueHours / cash : Infinity;
    return cash <= PurchaseFunding.spendable(state, 0, { r }) ? { ...candidate, template, r, learning } : null;
}

function eligible(state) {
    if (!state || state.phase !== 'cold' || !['hunting', 'resting', 'shopping'].includes(state.activity)
        || invoke('GameServer/Bot/Economy/ColdMarketService').pendingErrand(state)
        || state.party?.partyId || state.partyId || Karma.closesTowns(state.stats?.karma)
        || state.stats?.craftStationId || /^bot_craft_\d+$/i.test(String(state.accountName || ''))) return false;
    if (!CraftShopService.isServiceCrafter(state)) return false;
    if (CraftShopService.craftLevelFor(state) <= 0) return false;
    if (state.stats?.equipmentPlan?.strategy === 'craft'
        && ['active', 'component_ready', 'ready_to_craft'].includes(state.stats.equipmentPlan.status)) return false;
    const previousCraft = state.stats?.wealthCraft;
    if (previousCraft?.outcome === 'waiting_for_buyer') {
        const outputId = Number(previousCraft.productId || 0);
        const inInventory = Number(state.inventory?.[String(outputId)]?.amount || 0) > 0;
        const inShop = AfkTrade.ownerRecords(state.characterId).some((record) => Number(record.storeType) === AfkTrade.SELL
            && (record.lines || []).some((line) => Number(line.selfId) === outputId && Number(line.count) > 0));
        if (inInventory || inShop) return false;
    }
    return true;
}

function staticExits(recipe, template) {
    return require('./WealthCraftDecision').staticExits(recipe, template);
}


function chooseOpportunity(state, knownRecipes, context = Profit.contextFor(state)) {
    return require('./WealthCraftDecision').chooseOpportunity(state, knownRecipes, context, {
        board: AfkTrade.boardIndex(), timestamp: context.timestamp,
        planPurchase: (...args) => invoke('GameServer/Bot/Economy/ColdMarketService').planPurchase(...args),
        offersFor: (id, side, characterId) => AfkTrade.offers(id, side, { characterId }), staticExits
    });
}

async function refreshCraftedInventory(state, recipe) {
    const inventory = { ...(state.inventory || {}) };
    for (const material of recipe.materials || []) delete inventory[String(material.selfId)];
    delete inventory[String(recipe.productId)];
    return LifeState.refreshInventory({ ...state, inventory });
}

function materialRows(items, recipe, batches = 1) { return Profit.materials(items, recipe, batches); }

function withOutcome(state, opportunity, outcome, extras = {}) {
    return {
        ...state,
        stats: {
            ...(state.stats || {}),
            ...(['sold', 'waiting_for_buyer'].includes(outcome) ? { production: {
                ...(state.stats?.production || {}),
                crafts: Number(state.stats?.production?.crafts || 0) + 1,
                profit: Number(state.stats?.production?.profit || 0) + (outcome === 'sold' ? Number(extras.profit || 0) : 0)
            } } : {}),
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
    if (opportunity.exit.type === 'afk' && !personalOfferAllowed(opportunity.exit.offer, state)) {
        return { state, crafted: false, reason: 'buyer_changed' };
    }
    const recipe = opportunity.recipe;
    const batches = Math.min(64, Math.max(1, Number(opportunity.batches || 1)));
    if (!Number.isSafeInteger(batches) || Number(state.vitals?.mp || 0) < Number(recipe.mpCost || 0) * batches) {
        return { state, crafted: false, reason: 'mp_changed' };
    }
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
        // Knowledge is authoritative in the book, not the capped public
        // workshop. Acquired knowledge survives a later buyer/material loss.
        const knowledge = await acquireRecipe(current, opportunity);
        current = knowledge.state; spent += knowledge.spent;
        if (!knowledge.ready) return { state: current, crafted: false, reason: knowledge.reason, spent };
        // Each input is bought in its town (the one purchase path): here, or
        // the bot goes there and the craft waits for the next look.
        const ColdMarket = invoke('GameServer/Bot/Economy/ColdMarketService');
        const inputs = opportunity.basket.purchases.filter(purchase => Number(purchase.selfId) !== Number(recipe.recipeItemId))
            .map(purchase => ({ selfId: purchase.selfId,
            amount: recipe.materials.filter(row => Number(row.selfId) === Number(purchase.selfId))
                .reduce((sum, row) => sum + Number(row.amount) * batches, 0),
            options: { towns: [purchase.town], npc: Number(purchase.npc || 0) > 0, purpose: 'wealth_craft',
                r: opportunity.r, money: PurchaseFunding.spendable(current, 0, { r: opportunity.r }),
                quoteDepth: 5, sourcePlan: purchase } }));
        const bought = await ColdMarket.acquireMaterials(current, inputs);
        current = bought.state || current; spent += Number(bought.spent || 0);
        if (bought.pending) return { state: current, crafted: false, pending: true, spent };
        if (bought.hot) return { state: current, crafted: false, reason: 'bot_went_hot', spent };
        if (!bought.ready && (bought.traveling || current.stats?.marketErrand)) {
            return { state: current, crafted: false, reason: 'buying_trip', spent };
        }
        if (!bought.ready) throw Error('purchase_unavailable');
    } catch (error) {
        const failed = withOutcome(current, opportunity, 'purchase_failed',
            { spent, error: String(error?.message || error) });
        return { state: await LifeState.upsertState(failed, 'wealth_craft_purchase_failed') || failed,
            crafted: false, reason: 'purchase_failed' };
    }

    const items = await Database.fetchItems(current.characterId);
    const materials = materialRows(items, recipe, batches);
    if (!materials) {
        const failed = withOutcome(current, opportunity, 'materials_changed', { spent });
        return { state: await LifeState.upsertState(failed, 'wealth_craft_materials_changed') || failed,
            crafted: false, reason: 'materials_changed' };
    }

    if (opportunity.exit.type === 'afk' && (!personalOfferAllowed(opportunity.exit.offer, current)
        || current.currentRegion === opportunity.exit.offer.town && !AfkTrade.offers(recipe.productId, AfkTrade.BUY,
        { characterId: current.characterId }).some((offer) => (
        Number(offer.recordId) === Number(opportunity.exit.offer.recordId)
            && Number(offer.lineId) === Number(opportunity.exit.offer.lineId)
            && Number(offer.expectedRevision) === Number(opportunity.exit.offer.expectedRevision)
            && Number(offer.price) === Number(opportunity.exit.price)
            && Number(offer.count) > 0
    )))) {
        const changed = withOutcome(current, opportunity, 'buyer_changed', { spent });
        return { state: await LifeState.upsertState(changed, 'wealth_craft_buyer_changed') || changed,
            crafted: false, reason: 'buyer_changed' };
    }

    const product = {
        selfId: Number(recipe.productId),
        name: opportunity.template.template?.name || '',
        amount: Number(recipe.productCount) * batches,
        stackable: !!opportunity.template.etc?.stackable,
        slot: Number(opportunity.template.etc?.slot || 0)
    };
    let success = false, units = 0;
    let remainingMp = Number(current.vitals?.mp || 0);
    let admission = null;
    try {
        admission = await Commit.admit(current, Commit.KINDS.craft);
        current = admission.state;
        const crafted = await Database.craftInventoryItems(current.characterId, {
            materials, product, coldState: current, recipeId: Number(recipe.recipeId), batches,
            economyCommand: admission.command
        });
        if (crafted?.coldLifeRow) current = Commit.acceptRow(crafted.coldLifeRow);
        success = crafted?.success === true;
        units = Number(crafted?.units || 0);
        remainingMp = Number(crafted?.mp ?? current.vitals?.mp);
    } catch (error) {
        const failed = withOutcome(current, opportunity, 'craft_rejected',
            { spent, error: String(error?.message || error) });
        return { state: await LifeState.upsertState(failed, 'wealth_craft_rejected') || failed,
            crafted: false, reason: 'craft_rejected' };
    } finally { if (admission) Commit.finish(current.characterId, admission.command); }

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
        const saleCount = Math.min(units, Number(exit.count || units));
        const saved = await LifeState.applyNpcLiquidation(current, [{ selfId: recipe.productId,
            count: saleCount, npcPrice: Number(exit.price) }], {
            source: 'wealth_craft', town: exit.town, buyerName: exit.buyerName
        });
        const payout = Number(saved?.adena || 0) - Number(current.adena || 0);
        if (saved && payout > 0) {
            current = saved;
            sold = saleCount >= units;
            revenue = payout;
            MarketTelemetry.staticBuyerSale?.([{
                selfId: recipe.productId, name: product.name, count: saleCount,
                npcPrice: Number(exit.price), buyerName: exit.buyerName, buyerTown: exit.town
            }], payout, {
                sellerCharacterId: current.characterId, sellerName: current.name, town: exit.town
            });
        }
    } else if (current.activity === 'shopping' && current.currentRegion === exit.offer.town) {
        // A buy ad is answered in its town (E45); elsewhere the product waits
        // for the bot's sale, which goes there when it pays (MarketPricing.disposition).
        const offer = AfkTrade.offers(recipe.productId, AfkTrade.BUY, { characterId: current.characterId })
            .find((entry) => Number(entry.recordId) === Number(exit.offer.recordId)
                && Number(entry.lineId) === Number(exit.offer.lineId)
                && Number(entry.expectedRevision) === Number(exit.offer.expectedRevision)
                && Number(entry.price) === Number(exit.price)
                && Number(entry.count) > 0);
        const saleCount = Math.min(units, Number(offer?.count || 0));
        const productRow = (await Database.fetchItems(current.characterId))
            .find((item) => Number(item.selfId) === Number(recipe.productId)
                && Number(item.amount) >= saleCount && !item.equipped);
        if (offer && productRow) {
            try {
                const trade = await AfkTrade.sellToShop(current.characterId, offer.store, recipe.productId,
                    saleCount, { objectId: Number(productRow.id), lineId: offer.lineId,
                        expectedPrice: Number(offer.price), expectedRevision: offer.expectedRevision, coldState: current });
                if (trade.pending) return { state: LifeState.cachedState(current.characterId) || current, crafted: true, sold: false, pending: true, spent, revenue: 0 };
                const done = AfkTrade.committedTrade(trade, current.characterId);
                if (done.committed) {
                    const actualUnits = Number(trade.amount ?? trade.units ?? 0);
                    revenue = Number(trade.totalPrice ?? trade.received ?? 0);
                    sold = actualUnits >= units;
                    current = done.state || current;
                    if (done.hot) return { state: current, crafted: true, sold, spent, revenue, reason: 'bot_went_hot' };
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

async function tryCraft(state) {
    if (!eligible(state)) return { state, crafted: false, reason: 'ineligible' };
    const characterId = Number(state.characterId);
    if (inFlight.has(characterId)) return { state, crafted: false, reason: 'in_flight' };
    inFlight.add(characterId);
    try {
        const decision = invoke('GameServer/Bot/Population/ColdSimulationCoordinator').economyDecisions.decided(state);
        const step = require('./ShotCraftPolicy').unpackStep(decision?.shot);
        if (!step?.wealth) return { state, crafted: false, reason: 'no_profit' };
        const book = await Workshops.knownFor(characterId);
        const opportunity = recheck(state, step.wealth, book);
        if (!opportunity) return { state, crafted: false, reason: 'no_profit' };
        return await execute(state, opportunity);
    } catch (error) {
        utils.infoWarn('BotWealth', 'wealth craft failed for %s: %s', state.name, error?.message || String(error));
        return { state: LifeState.snapshot(characterId) || state, crafted: false, reason: 'error' };
    } finally {
        inFlight.delete(characterId);
    }
}

function opportunities(state, { hourAdena, worth, timestamp = Date.now() } = {}) {
    if (!eligible(state)) return [];
    const known = state.stats?.workshop?.entries || [];
    const opportunity = chooseOpportunity(state, known, { hourAdena, hunt: { perHour: hourAdena }, worth, timestamp, insideContext: true,
        ...invoke('GameServer/Bot/Population/ColdOccupationSources').craftLabour(state, timestamp) });
    return opportunity ? [{ ...opportunity, value: opportunity.expectedProfit, activity: 'crafting' }] : [];
}

async function acquireRecipe(state, opportunity) {
    const recipe = opportunity.recipe;
    // The cached book is dropped by every learning (recipesChanged), so the
    // check after learning reads the native book once more.
    const knows = async () => (await Workshops.knownFor(state.characterId)).includes(Number(recipe.recipeId));
    if (await knows()) return { state, ready: true, spent: 0 };
    let current = state, spent = 0;
    const free = () => require('./WealthCraftDecision').freeAmount(current,
        current.inventory?.[recipe.recipeItemId] || {});
    if (!free()) {
        const purchase = opportunity.basket.purchases.find(row => Number(row.selfId) === Number(recipe.recipeItemId));
        if (!purchase || purchase.count !== 1 || !purchase.lines?.length) return { state, ready: false, spent, reason: 'recipe_unavailable' };
        const result = await invoke('GameServer/Bot/Economy/ColdMarketService').acquire(current, recipe.recipeItemId, 1, {
            towns: [purchase.town], npc: false, purpose: 'recipe', r: opportunity.r,
            money: PurchaseFunding.spendable(current, 0, { r: opportunity.r }),
            maxPrice: Number(purchase.cost), quoteDepth: 5, sourcePlan: purchase
        });
        current = result.state || current; spent += Number(result.spent || 0);
        if (result.pending) return { state: current, ready: false, pending: true, spent };
        if (result.hot || current.phase !== 'cold') return { state: current, ready: false, spent, reason: 'bot_went_hot' };
        if (!free()) return { state: current, ready: false, spent,
            reason: result.traveling || current.stats?.marketErrand ? 'buying_trip' : 'recipe_unavailable' };
    }
    current = await LifeState.learnCraftableRecipes(current, { recipeIds: [Number(recipe.recipeId)] }) || current;
    return { state: current, ready: await knows(), spent, reason: 'recipe_not_learned' };
}
module.exports = { eligible, chooseOpportunity, opportunities, tryCraft, execute, recheck, acquireRecipe };
