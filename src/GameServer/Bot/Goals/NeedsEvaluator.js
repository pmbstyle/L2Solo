const SurvivalFloor = invoke('GameServer/Bot/Population/SurvivalFloor');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');

function cleanupGoal(need) {
    return {
        type: 'sell_inventory',
        priority: 96,
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
        },
        blockers: []
    };
}

// Survival is a hard native floor. Every voluntary activity is one leaf of
// the same wish network; there is no weapon/material/sale priority ladder.
function evaluate(state = {}, options = {}) {
    const timestamp = Number(options.now) || Date.now();
    const floor = SurvivalFloor.forState(state, timestamp);
    if (floor?.action === 'revive') return [{ type: 'recover', priority: 100,
        target: { alive: true }, plan: { kind: 'revive', expectedBenefit: 'restore_life' }, blockers: [] }];
    if (floor?.action === 'rest') return [{ type: 'recover', priority: 100,
        target: { hpPct: floor.hpRatio, mpPct: floor.mpRatio },
        plan: { kind: 'rest', expectedBenefit: 'restore_vitals' }, blockers: [] }];
    if (floor?.action === 'unload') return [{ ...cleanupGoal(floor), priority: 100 }];
    const errand = invoke('GameServer/Bot/Economy/ColdMarketService').pendingErrand(state, timestamp);
    if (errand?.town && errand.selfId > 0) return [{ type: 'market_errand', priority: 80,
        target: { itemId: errand.selfId, amount: errand.amount },
        plan: { kind: 'market_buy', expectedBenefit: 'market_errand', marketTown: errand.town, purpose: errand.purpose },
        blockers: [] }];
    const context = Economy.forState(state, { ...options, timestamp });
    const leaf = context.network.activity;
    if (!leaf) return [];
    const itemId = Number(leaf.itemId || (typeof leaf.object === 'number' ? leaf.object : leaf.object?.itemId) || 0);
    const wish = context.network.queue.find(row => row.key === leaf.rootKey);
    const common = { priority: 50, blockers: [], inputHash: require('../Fnv1a').fnv1a32(context.inputKey),
        plan: { kind: leaf.kind, spotId: leaf.spotId || state.spotId, npcId: leaf.npcId,
            recipeId: leaf.recipeId, wishKey: leaf.rootKey, estimatedCost: leaf.price,
            targetId: leaf.targetId, economyActivity: leaf.activity } };
    if (leaf.activity === 'shopping' && itemId) {
        const gear = require('../../Item/ItemTemplateIndex').find(invoke('GameServer/DataCache').items, itemId);
        const slot = Number(gear?.etc?.slot || 0);
        const itemName = state.inventory?.[String(itemId)]?.name
            || gear?.template?.name || `Item ${itemId}`;
        const offer = context.board?.heads(itemId, 1, { excludeOwner: state.characterId })?.[0];
        const npc = invoke('GameServer/Bot/Economy/MarketOpportunity').npcOffersAll(itemId)[0];
        const town = offer?.town || npc?.town || state.currentRegion;
        return [{ ...common, type: slot ? 'upgrade_gear' : 'buy_craft_material',
            target: { itemId, itemName, itemSlot: slot, amount: Math.max(1, Math.ceil(leaf.amount || wish?.object?.amount || 1)), adena: leaf.amount > 0 ? leaf.price / leaf.amount : leaf.price },
            plan: { ...common.plan, expectedBenefit: slot ? 'market_search_for_gear' : 'market_buy_craft_material',
                marketTown: town, sourceType: offer ? 'afk' : npc ? 'npc' : null,
                purpose: wish?.object?.kind, requiredAdena: 0, reserve: Economy.survivalReserve(state) } }];
    }
    if (leaf.activity === 'selling') return [{ ...common, type: 'sell_inventory',
        target: { itemIds: leaf.items || [], itemCount: leaf.items?.length || 0 },
        plan: { ...common.plan, kind: 'market_sell', expectedBenefit: 'market_sale_inventory' } }];
    if (leaf.activity === 'improving') return [{ ...common, type: 'improving', target: { improvement: leaf.improvement },
        plan: { ...common.plan, marketTown: 'Giran', expectedBenefit: 'improvement' } }];
    if (leaf.activity === 'hunting') return [{ ...common, type: leaf.funding ? 'earn_adena' : 'progress_level',
        target: leaf.funding ? { adena: wish?.price || 0 } : { level: Number(state.level) + 1 },
        plan: { ...common.plan, kind: 'farm_route', expectedBenefit: leaf.funding ? 'adena_and_loot' : 'experience_and_sp' } }];
    return [{ ...common, type: leaf.activity, target: { itemId, targetId: leaf.targetId },
        plan: { ...common.plan, expectedBenefit: leaf.activity } }];
}
module.exports = { evaluate, cleanupGoal };
