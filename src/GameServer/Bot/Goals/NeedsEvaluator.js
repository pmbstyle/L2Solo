const BotGear = invoke('GameServer/Bot/AI/BotGear');
const DataCache = invoke('GameServer/DataCache');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');

const RANK_ORDER = ['none', 'd', 'c', 'b', 'a', 's'];

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
    const desiredRank = String(build.grade || 'none').toLowerCase();
    const classId = Number(state.stats?.classId || build.classId || 0);
    const plan = BotGear.planFor({ classId, level: Number(state.level || build.level || 1) });
    const desiredWeapon = plan.items.find((item) => Number(item.slot) === 7) || null;
    const currentWeapon = equipment.find((item) => Number(item.slot) === 7) || null;
    if (!desiredWeapon || currentWeapon && rankIndex(currentWeapon.rank) >= rankIndex(desiredRank)) return null;

    const template = (DataCache.items || []).find((item) => Number(item.selfId) === Number(desiredWeapon.selfId));
    const price = Math.max(1, Number(template?.template?.price || 0));
    return {
        currentWeapon,
        desiredRank,
        desiredWeapon: {
            selfId: Number(desiredWeapon.selfId),
            name: desiredWeapon.name || template?.template?.name || `Item ${desiredWeapon.selfId}`,
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
        const requiredAdena = Math.max(0, gear.desiredWeapon.price - Number(state.adena || 0));
        candidates.push({
            type: 'upgrade_gear',
            priority: requiredAdena > 0 ? 72 : 58,
            target: {
                equipmentSlot: 'weapon',
                requiredRank: gear.desiredRank,
                currentItemId: gear.currentWeapon?.selfId || null,
                itemId: gear.desiredWeapon.selfId,
                itemName: gear.desiredWeapon.name,
                adena: gear.desiredWeapon.price
            },
            plan: {
                ...routePlan(state, spot),
                expectedBenefit: requiredAdena > 0 ? 'adena_for_weapon_upgrade' : 'market_search_for_weapon',
                estimatedCost: gear.desiredWeapon.price,
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

    const sale = ItemDisposition.saleSummary(state);
    if (sale.itemCount >= 3 || sale.marketValue >= 1000) {
        candidates.push({
            type: 'sell_inventory',
            priority: 54,
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
