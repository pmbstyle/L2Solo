const BotGear = invoke('GameServer/Bot/AI/BotGear');
const DataCache = invoke('GameServer/DataCache');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');

const RANK_ORDER = ['none', 'd', 'c', 'b', 'a', 's'];
// Weapons make the largest immediate difference, then core armour.  The two
// ring/earring slots deliberately stay out of the first pass: the compact
// inventory snapshot identifies equipment by item id, so duplicate jewellery
// cannot yet be distinguished reliably.
const EQUIPMENT_PRIORITY = [7, 10, 15, 11, 8, 6, 9, 12, 3];
const EQUIPMENT_SLOT_NAMES = {
    3: 'necklace',
    6: 'head',
    7: 'weapon',
    8: 'shield',
    9: 'hands',
    10: 'chest',
    11: 'pants',
    12: 'feet',
    15: 'full_armor'
};

function percentage(value, maximum) {
    const max = Math.max(1, Number(maximum) || 0);
    return Math.max(0, Math.min(1, Number(value) / max));
}

function rankIndex(rank) {
    const index = RANK_ORDER.indexOf(String(rank || 'none').toLowerCase());
    return index >= 0 ? index : 0;
}

function equipmentNeed(state) {
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
    if (!desiredItem) return null;

    const currentItem = equipment.find((item) => Number(item.slot) === Number(desiredItem.slot)) || null;
    const desiredRank = String(desiredItem.rank || build.grade || 'none').toLowerCase();

    const template = (DataCache.items || []).find((item) => Number(item.selfId) === Number(desiredItem.selfId));
    const price = Math.max(1, Number(template?.template?.price || 0));
    return {
        currentItem,
        desiredRank,
        slot: Number(desiredItem.slot),
        slotName: EQUIPMENT_SLOT_NAMES[Number(desiredItem.slot)] || `slot_${desiredItem.slot}`,
        desiredItem: {
            selfId: Number(desiredItem.selfId),
            name: desiredItem.name || template?.template?.name || `Item ${desiredItem.selfId}`,
            price
        }
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
        const requiredAdena = Math.max(0, gear.desiredItem.price - Number(state.adena || 0));
        const weaponUpgrade = gear.slot === 7;
        candidates.push({
            type: 'upgrade_gear',
            priority: requiredAdena > 0 ? 72 : 58,
            target: {
                equipmentSlot: gear.slotName,
                requiredRank: gear.desiredRank,
                currentItemId: gear.currentItem?.selfId || null,
                itemId: gear.desiredItem.selfId,
                itemName: gear.desiredItem.name,
                adena: gear.desiredItem.price
            },
            plan: {
                ...routePlan(state, spot),
                expectedBenefit: requiredAdena > 0
                    ? weaponUpgrade ? 'adena_for_weapon_upgrade' : 'adena_for_gear_upgrade'
                    : weaponUpgrade ? 'market_search_for_weapon' : 'market_search_for_gear',
                estimatedCost: gear.desiredItem.price,
                requiredAdena
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

    const sale = ItemDisposition.saleSummary(state);
    if (sale.itemCount >= 3 || sale.marketValue >= 1000) {
        candidates.push({
            type: 'sell_inventory',
            // A full bag is capital, not a reason to keep grinding with no
            // adena. Recovery and death still win, but an equipped bot with
            // useful surplus should reach the market before another generic
            // earn-adena / upgrade-funding loop.
            priority: 74,
            target: { itemCount: sale.itemCount, marketValue: sale.marketValue },
            plan: { kind: 'market_sell', expectedBenefit: 'market_sale_inventory', risk: 0 },
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
