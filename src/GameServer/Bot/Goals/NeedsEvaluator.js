const FailureLog = require('../../../FailureLog');
const SurvivalFloor = invoke('GameServer/Bot/Population/SurvivalFloor');
const ColdEconomyDecision = require('../Population/ColdEconomyDecision');
const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const DataCache = invoke('GameServer/DataCache');
const Network = invoke('GameServer/Bot/Economy/WishNetwork');

function cleanupGoal(need) {
    return {
        type: 'sell_inventory',
        target: {
            itemCount: need.slots,
            npcOnlySlots: need.npcOnlySlots,
            cleanupReason: need.reason
        },
        plan: {
            kind: 'market_sell',
            expectedBenefit: 'market_sale_inventory',
            risk: 0,
            cleanupReason: need.reason
        }
    };
}

// Survival is a hard native floor. Every voluntary activity is one leaf of
// the same wish network; there is no weapon/material/sale priority ladder.
// The needs come in their order: the survival floor (recover, unload), the
// pending errand, else the held card's leaf. Main and the worker read the same.
function evaluate(state = {}, options = {}) {
    const timestamp = Number(options.now) || Date.now();
    const floor = SurvivalFloor.forState(state, timestamp);
    if (floor?.action === 'revive') return [{ type: 'recover',
        target: { alive: true }, plan: { kind: 'revive', expectedBenefit: 'restore_life' } }];
    if (floor?.action === 'rest') return [{ type: 'recover',
        target: { hpPct: floor.hpRatio, mpPct: floor.mpRatio },
        plan: { kind: 'rest', expectedBenefit: 'restore_vitals' } }];
    let context = options.economy;
    if (floor?.action === 'unload') {
        const supply = state.stats?.equipmentPlan?.clanGoal?.clanId ? require('../Economy/ClanCrystalSupply') : null;
        if (floor.reason === 'no_slot' && supply?.requirement(state)) {
            context ||= ColdEconomyDecision.economyFor(state, { ...options, timestamp });
            if (!supply.freesSpace(state, context.network.activity)) return [cleanupGoal(floor)];
        } else return [cleanupGoal(floor)];
    }
    const errand = Object.hasOwn(options, 'errand') ? options.errand
        : invoke('GameServer/Bot/Economy/ColdMarketService').pendingErrand(state, timestamp);
    // On a visit, an errand of another town waits for the visit's end (its own trip then):
    // this town's stops come first, so no visit stands idle on another town's errand.
    const elsewhere = state.activity === 'shopping' && errand?.town && errand.town !== state.currentRegion;
    if (errand?.town && errand.selfId > 0 && !elsewhere) return [{ type: 'market_errand',
        target: { itemId: errand.selfId, amount: errand.amount },
        plan: { kind: 'market_buy', expectedBenefit: 'market_errand', marketTown: errand.town, purpose: errand.purpose } }];
    context ||= ColdEconomyDecision.economyFor(state, { ...options, timestamp });
    options.onEconomy?.(context);
    const leaf = context.network.activity;
    if (!leaf) return [];
    const itemId = Number(leaf.itemId || (typeof leaf.object === 'number' ? leaf.object : leaf.object?.itemId) || 0);
    const wish = context.wish || context.network.queue?.find(row => row.key === leaf.rootKey);
    let amount = 0, estimatedCost = leaf.price;
    if (leaf.activity === 'shopping' && itemId) {
        // The card's amount to order; only units that reached the bag or
        // accepted incoming since that decision fill it.
        amount = ColdEconomyDecision.remainingToOrder(leaf, state, context.state || state, itemId);
        if (!amount) return [];
        if (amount < leaf.amount) estimatedCost = leaf.price / leaf.amount * amount;
    }
    const common = { plan: { kind: leaf.kind, spotId: leaf.spotId || state.spotId, npcId: leaf.npcId,
            recipeId: leaf.recipeId, wishKey: leaf.rootKey, estimatedCost,
            targetId: leaf.targetId, economyActivity: leaf.activity } };
    if (leaf.activity === 'shopping' && itemId) {
        const gear = ItemTemplateIndex.find(DataCache.items, itemId);
        const slot = Number(gear?.etc?.slot || 0);
        const input = String(leaf.rootKey || '').startsWith('power:')
            && Network.rootItem(leaf.rootKey) !== itemId;
        const equipment = slot && !input;
        const itemName = state.inventory?.[String(itemId)]?.name
            || gear?.template?.name || `Item ${itemId}`;
        // Town, source and price are the core's (the card); no second quote look.
        const ratio = invoke('GameServer/Bot/Economy/PurchaseFunding').leafRatio(leaf, wish);
        return [{ ...common, type: equipment ? 'upgrade_gear' : 'buy_craft_material',
            target: { itemId, itemName, itemSlot: slot, amount,
                adena: leaf.unitPrice ?? (leaf.amount > 0 ? leaf.price / leaf.amount : leaf.price) },
            plan: { ...common.plan, expectedBenefit: equipment ? 'market_search_for_gear' : 'market_buy_craft_material',
                marketTown: leaf.town || state.currentRegion, sourceType: leaf.sourceType || null,
                ...(leaf.sourceType === 'afk' && leaf.unitPrice > 0 ? { priceSource: 'offer' } : {}),
                // The root's own bids the buyer takes back to pay the step (WishNetwork).
                ...(leaf.bids?.length ? { bids: leaf.bids } : {}),
                ...(Number.isFinite(leaf.valueHours)
                    ? { valueHours: leaf.amount > 0 ? leaf.valueHours * amount / leaf.amount : leaf.valueHours } : {}),
                // Its funded root's place in the money queue (the card's r, or
                // the full network's root) funds it: PurchaseFunding.goalTerms.
                ...(ratio > 0 ? { valueRate: ratio } : {}),
                purpose: wish?.object?.kind, reserve: Economy.refillReserve(state) } }];
    }
    if (leaf.activity === 'selling') return [{ ...common, type: 'sell_inventory',
        target: { itemIds: leaf.items || [], itemCount: leaf.items?.length || 0 },
        plan: { ...common.plan, kind: 'market_sell', expectedBenefit: 'market_sale_inventory',
            marketTown: options.saleTown || leaf.town || invoke('GameServer/Bot/Economy/MarketTownPolicy').saleTown(state, timestamp).town } }];
    if (leaf.activity === 'improving') return [{ ...common, type: 'improving', target: { improvement: leaf.improvement },
        plan: { ...common.plan, marketTown: 'Giran', expectedBenefit: 'improvement' } }];
    if (leaf.activity === 'hunting') return [{ ...common, type: leaf.funding ? 'earn_adena' : 'progress_level',
        target: leaf.funding ? { adena: wish?.price || 0 } : { level: Number(state.level) + 1 },
        plan: { ...common.plan, kind: 'farm_route', expectedBenefit: leaf.funding ? 'adena_and_loot' : 'experience_and_sp' } }];
    return [{ ...common, type: leaf.activity, target: { itemId, targetId: leaf.targetId },
        plan: { ...common.plan, expectedBenefit: leaf.activity } }];
}
// A far bot's needs and its goal (the first need): computed where they are read,
// from the held card, the floor and the errands; nothing keeps a copy, so a
// purchase, an errand's end or a new card is the goal's change. Only a far
// (cold) bot has one here: a body near a player acts on the decision it holds
// (DecisionEvents.held).
function needs(state, options = {}) {
    return !state?.characterId || state.phase !== 'cold' ? null : evaluate(state, options);
}
function goal(state, options = {}) {
    return needs(state, options)?.[0] || null;
}
// A far bot's goal as a player is shown it (its status window, its clan's chat): read over
// the card it holds, current or not (ColdEconomyDecisions.inspect: a card outlives its row's
// next publication, a loot or a level, until the next decision), never counted as a card
// request. A failed read shows no goal: counted, never thrown into the player's window.
function shownGoal(state, options = {}) {
    if (!state?.characterId || state.phase !== 'cold') return null;
    try {
        const decisions = options.decisions || invoke('GameServer/Bot/Population/ColdSimulationCoordinator').economyDecisions;
        return goal(state, { ...options, economy: ColdEconomyDecision.view(state, decisions.inspect(state), options) });
    } catch (error) {
        FailureLog.note('needs.shown_goal', error);
        return null;
    }
}
module.exports = { evaluate, needs, goal, shownGoal, cleanupGoal };
