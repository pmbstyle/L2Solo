const BotGear = invoke('GameServer/Bot/AI/BotGear');
const DataCache = invoke('GameServer/DataCache');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const GearLifecycle = invoke('GameServer/Bot/AI/GearLifecycle');
const PersonaEconomicPolicy = invoke('GameServer/Bot/Economy/PersonaEconomicPolicy');
const WealthInvestmentPolicy = invoke('GameServer/Bot/Economy/WealthInvestmentPolicy');

const RANK_ORDER = ['none', 'd', 'c', 'b', 'a', 's'];
const NPC_GEAR_PRIORITY = {
    weapon: 88,
    armor: 87,
    jewelry: 78,
    other: 76
};
// Weapons make the largest immediate difference, then core armour. Paired
// jewellery is represented by its concrete paperdoll sides in cold inventory,
// so both copies participate in ordinary progression.
const EQUIPMENT_PRIORITY = [7, 10, 15, 11, 8, 6, 9, 12, 3, 1, 2, 4, 5];
const EQUIPMENT_SLOT_NAMES = {
    1: 'right_earring',
    2: 'left_earring',
    3: 'necklace',
    4: 'right_ring',
    5: 'left_ring',
    6: 'head',
    7: 'weapon',
    8: 'shield',
    9: 'hands',
    10: 'chest',
    11: 'pants',
    12: 'feet',
    15: 'full_armor'
};

let itemIndexSource = null;
let itemIndex = new Map();

function itemBySelfId(selfId) {
    const items = DataCache.items || [];
    if (itemIndexSource !== items) {
        itemIndexSource = items;
        itemIndex = new Map(items.map((item) => [Number(item.selfId), item]));
    }
    return itemIndex.get(Number(selfId)) || null;
}

function percentage(value, maximum) {
    const max = Math.max(1, Number(maximum) || 0);
    return Math.max(0, Math.min(1, Number(value) / max));
}

function rankIndex(rank) {
    const index = RANK_ORDER.indexOf(String(rank || 'none').toLowerCase());
    return index >= 0 ? index : 0;
}

function affordableNpcGearPriority(gear = {}) {
    if (!gear.npcProgression) return null;
    const slotPriority = GearLifecycle.slotPriority(gear.slot);
    if (slotPriority === 3) return NPC_GEAR_PRIORITY.weapon;
    if (slotPriority === 2) return NPC_GEAR_PRIORITY.armor;
    if (slotPriority === 1) return NPC_GEAR_PRIORITY.jewelry;
    return NPC_GEAR_PRIORITY.other;
}

function equipmentNeed(state) {
    if (!GearLifecycle.isGearFocusActive(state)) return null;
    const equipment = state.stats?.equipment;
    if (!Array.isArray(equipment)) return null;

    const build = state.stats?.build || {};
    const classId = Number(state.stats?.classId || build.classId || 0);
    const plan = BotGear.planFor({ classId, level: Number(state.level || build.level || 1) });
    const desiredItem = EQUIPMENT_PRIORITY
        .map((slot) => plan.items.find((item) => Number(item.slot) === slot))
        .find((item) => {
            if (!item) return false;
            const currentItem = equipment.find((equipped) => Number(equipped.slot) === Number(item.slot));
            const desiredRank = String(item.rank || build.grade || 'none').toLowerCase();
            return !currentItem || rankIndex(currentItem.rank) < rankIndex(desiredRank);
        }) || null;
    const acquisitionPlan = state.stats?.equipmentPlan;
    // Drop/craft acquisition is executed by the cold resolver itself, not by
    // a market goal. This also covers ready/blocked craft states: turning a
    // temporarily blocked C-grade recipe into a generic Giran shopping trip
    // would make an unavailable NPC item stall normal leveling. A later plan
    // refresh can still switch to a concrete market offer when one exists.
    if (['direct_drop', 'craft'].includes(acquisitionPlan?.strategy)
        || acquisitionPlan?.status === 'blocked') return null;
    const plannedTarget = acquisitionPlan?.strategy === 'market' && acquisitionPlan?.target
        ? itemBySelfId(acquisitionPlan.target.selfId)
        : null;
    const plannedSlot = Number(acquisitionPlan?.target?.slot || plannedTarget?.etc?.slot || 0);
    const plannedAlreadyEquipped = plannedTarget && plannedSlot > 0 && equipment.some((item) => (
        Number(item.slot) === plannedSlot && Number(item.selfId) === Number(plannedTarget.selfId)
    ));
    const npcOnlyTier = Number(state.level || build.level || 1) < 40;
    const concreteNpcPlan = acquisitionPlan?.status === 'active'
        && acquisitionPlan?.strategy === 'market'
        && acquisitionPlan?.market?.sourceType === 'npc'
        && plannedTarget;
    // No-grade and D-grade equipment is owned by GearAcquisitionPlanner's
    // concrete NPC-shop plan. Do not fall back to an exact BotGear catalog
    // item after the NPC kit is already adequate (or while its purchased
    // target is waiting for the next resolver pass): that loses the shop town
    // and turns ordinary starter gear into a generic Giran WTB goal.
    if (npcOnlyTier && (!concreteNpcPlan || plannedAlreadyEquipped)) return null;
    const selectedItem = plannedTarget && !plannedAlreadyEquipped ? plannedTarget : desiredItem;
    if (!selectedItem) return null;

    const currentItem = equipment.find((item) => Number(item.slot) === Number(selectedItem.etc?.slot || selectedItem.slot)) || null;
    const desiredRank = String(selectedItem.etc?.rank || selectedItem.rank || build.grade || 'none').toLowerCase();

    // A just-completed market plan remains on the state until the next
    // resolver pass.  Once its target is equipped, the generic build may pick
    // a different next slot; do not send that new purchase to the old offer's
    // town or fund it with the old price.
    const usingPlannedTarget = Number(selectedItem.selfId) === Number(plannedTarget?.selfId);
    const template = itemBySelfId(selectedItem.selfId);
    const plannedMarket = usingPlannedTarget ? acquisitionPlan?.market : null;
    const price = Math.max(1, Number(plannedMarket?.price || template?.template?.price || 0));
    return {
        currentItem,
        desiredRank,
        slot: Number(selectedItem.etc?.slot || selectedItem.slot),
        slotName: EQUIPMENT_SLOT_NAMES[Number(selectedItem.etc?.slot || selectedItem.slot)] || `slot_${selectedItem.etc?.slot || selectedItem.slot}`,
        desiredItem: {
            selfId: Number(selectedItem.selfId),
            name: selectedItem.name || selectedItem.template?.name || template?.template?.name || `Item ${selectedItem.selfId}`,
            price
        },
        marketTown: plannedMarket?.town || null,
        reserve: Number(plannedMarket?.reserve || 0),
        clanRequired: acquisitionPlan?.clanGoal?.priority === 'required',
        npcProgression: plannedMarket?.sourceType === 'npc'
            || acquisitionPlan?.partyNeedReason === 'npc_progression'
    };
}

function routePlan(state, spot) {
    return {
        kind: state.party?.partyId ? 'party_route' : 'farm_route',
        routeId: spot?.route?.id || state.stats?.route?.id || null,
        spotId: spot?.id || state.spotId || null,
        expectedBenefit: 'experience_and_sp',
        risk: Number(spot?.risk || 0)
    };
}

function evaluate(state = {}, options = {}) {
    const timestamp = Number(options.now) || Date.now();
    const spot = options.spot || null;
    const level = Math.max(1, Number(state.level || 1));
    const hpPct = percentage(state.vitals?.hp, state.vitals?.maxHp);
    const mpPct = percentage(state.vitals?.mp, state.vitals?.maxMp);
    const candidates = [];

    if (state.activity === 'dead' || hpPct <= 0.05) {
        candidates.push({
            type: 'recover',
            priority: 100,
            target: { condition: 'alive_and_recovered' },
            plan: { kind: 'town_return', expectedBenefit: 'safe_recovery', risk: 0 },
            blockers: [],
            nextReviewAt: timestamp + 60000
        });
        return candidates;
    }

    const gear = equipmentNeed(state);
    if (gear) {
        const requiredAdena = Math.max(0, gear.desiredItem.price + gear.reserve - Number(state.adena || 0));
        const weaponUpgrade = gear.slot === 7;
        const wealthInvestment = WealthInvestmentPolicy.investmentOpportunity(state, gear.desiredItem.price);
        const npcPurchasePriority = requiredAdena === 0 ? affordableNpcGearPriority(gear) : null;
        const clanPurchasePriority = requiredAdena === 0 && gear.clanRequired ? 89 : null;
        candidates.push({
            type: 'upgrade_gear',
            // An affordable static-shop upgrade must outrank inventory sales,
            // otherwise the bot can keep opening sell stores while carrying
            // enough Adena for the weapon or armour that unlocks progression.
            // Recovery remains higher at 90, and jewellery stays below the
            // weapon/core-armour priorities while still beating a normal sale.
            // A funded clan assignment is stronger than a voluntary wealth
            // sale, but recovery and forced inventory cleanup still win.
            priority: clanPurchasePriority
                || npcPurchasePriority
                || (wealthInvestment?.affordable ? 81 : requiredAdena > 0 ? 72 : 58),
            target: {
                equipmentSlot: gear.slotName,
                requiredRank: gear.desiredRank,
                currentItemId: gear.currentItem?.selfId || null,
                itemId: gear.desiredItem.selfId,
                itemName: gear.desiredItem.name,
                itemSlot: gear.slot,
                adena: gear.desiredItem.price
            },
            plan: {
                ...routePlan(state, spot),
                expectedBenefit: requiredAdena > 0
                    ? weaponUpgrade ? 'adena_for_weapon_upgrade' : 'adena_for_gear_upgrade'
                    : weaponUpgrade ? 'market_search_for_weapon' : 'market_search_for_gear',
                estimatedCost: gear.desiredItem.price,
                reserve: gear.reserve,
                requiredAdena,
                marketTown: gear.marketTown,
                ...(wealthInvestment ? {
                    personaDrive: 'wealth',
                    wealthInvestment: {
                        reason: wealthInvestment.reason,
                        affordable: wealthInvestment.affordable,
                        reserve: wealthInvestment.reserve,
                        spotRisk: wealthInvestment.pressure
                    }
                } : {})
            },
            blockers: spot ? [] : ['missing_spot'],
            nextReviewAt: timestamp + 10 * 60 * 1000
        });
    }

    if (hpPct < 0.35 || mpPct < 0.2 || state.activity === 'resting') {
        candidates.push({
            type: 'recover',
            priority: 90,
            target: { hpPct: 0.8, mpPct: 0.65 },
            plan: { kind: 'rest', expectedBenefit: 'restore_vitals', risk: 0 },
            blockers: [],
            nextReviewAt: timestamp + 60000
        });
    }

    const minimumAdena = Math.max(120, level * 120);
    if (Number(state.adena || 0) < minimumAdena) {
        candidates.push({
            type: 'earn_adena',
            priority: 65,
            target: { adena: minimumAdena },
            plan: { ...routePlan(state, spot), expectedBenefit: 'adena_and_loot' },
            blockers: spot ? [] : ['missing_spot'],
            nextReviewAt: timestamp + 8 * 60 * 1000
        });
    }

    const craftPlan = state.stats?.equipmentPlan;
    const wantedMaterial = craftPlan?.marketFallback && craftPlan?.next?.itemId
        ? craftPlan.materials?.find((material) => Number(material.selfId) === Number(craftPlan.next.itemId))
        : null;
    if (wantedMaterial?.missing > 0 && Number(state.stats?.marketRetryAfter || 0) <= timestamp) {
        candidates.push({
            type: 'buy_craft_material',
            priority: 82,
            target: {
                itemId: Number(wantedMaterial.selfId),
                itemName: (state.inventory?.[String(wantedMaterial.selfId)] || {}).name || `Material ${wantedMaterial.selfId}`,
                amount: Number(wantedMaterial.missing)
            },
            plan: { kind: 'market_buy', expectedBenefit: 'market_buy_craft_material', recipeId: craftPlan.recipeId },
            blockers: [],
            nextReviewAt: timestamp + 10 * 60 * 1000
        });
    }

    const inventoryCleanup = ItemDisposition.inventoryCleanupNeed(state, { now: timestamp });
    if (inventoryCleanup) {
        candidates.push({
            type: 'sell_inventory',
            // An over-capacity bag is an actionable safety problem: it blocks
            // native trades and keeps every later drop in the same failure
            // loop.  Keep recovery/death above it, but outrank ordinary
            // progression and adena gathering.
            priority: 96,
            target: {
                itemCount: inventoryCleanup.slots,
                npcOnlySlots: inventoryCleanup.npcOnlySlots,
                cleanupReason: inventoryCleanup.reason
            },
            plan: {
                kind: 'market_sell',
                expectedBenefit: 'market_sale_inventory',
                risk: 0,
                cleanupReason: inventoryCleanup.reason
            },
            blockers: [],
            nextReviewAt: timestamp + 10 * 60 * 1000
        });
    }

    const sale = ItemDisposition.saleSummary(state);
    const wealthSale = PersonaEconomicPolicy.wealthSaleOpportunity(state, sale);
    if (sale.itemCount >= 3 || sale.marketValue >= 1000 || wealthSale) {
        candidates.push({
            type: 'sell_inventory',
            // A full bag is capital, not a reason to keep grinding with no
            // adena. Recovery and death still win, but an equipped bot with
            // useful surplus should reach the market before another generic
            // earn-adena / upgrade-funding loop.
            priority: 74 + Number(wealthSale?.priorityBonus || 0),
            target: {
                itemCount: sale.itemCount,
                marketValue: sale.marketValue,
                focusItem: wealthSale?.focus || null
            },
            plan: {
                kind: 'market_sell',
                expectedBenefit: 'market_sale_inventory',
                risk: 0,
                personaDrive: wealthSale ? 'wealth' : null,
                personaReason: wealthSale?.reason || null
            },
            blockers: [],
            nextReviewAt: timestamp + 10 * 60 * 1000
        });
    }

    candidates.push({
        type: 'progress_level',
        priority: 35,
        target: { level: level + 1 },
        plan: routePlan(state, spot),
        blockers: spot ? [] : ['missing_spot'],
        nextReviewAt: timestamp + 12 * 60 * 1000
    });

    return candidates;
}

module.exports = { evaluate };
