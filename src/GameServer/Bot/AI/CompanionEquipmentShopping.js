const World = invoke('GameServer/World/World');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const TownNpcCatalog = invoke('GameServer/Bot/Economy/TownNpcCatalog');

const MAX_PURCHASES_PER_VISIT = 12;

function actorAdena(bot) {
    return Number(bot.backpack?.fetchItemFromSelfId?.(57)?.fetchAmount?.() || 0);
}

function currentState(session, bot, town) {
    const previous = session.coldLifeState || {};
    const inventory = LifeState.inventorySummaryFromItems(bot.backpack?.fetchItems?.() || []);
    return {
        ...previous,
        characterId: Number(bot.fetchId()),
        name: bot.fetchName?.() || previous.name,
        level: Number(bot.fetchLevel?.() || previous.level || 1),
        adena: actorAdena(bot),
        currentRegion: town.name,
        loc: {
            locX: Number(bot.fetchLocX()),
            locY: Number(bot.fetchLocY()),
            locZ: Number(bot.fetchLocZ())
        },
        stats: {
            ...(previous.stats || {}),
            classId: Number(bot.fetchClassId?.() ?? previous.stats?.classId ?? 0),
            role: session.botStatus?.role || previous.stats?.role || null
        },
        inventory
    };
}

function liveMerchantOffer(offer) {
    return offer?.sourceType === 'private_store'
        && offer.session?.actor
        && String(offer.session.accountId || '').startsWith('bot_');
}

function affordableOffers(target, state, town) {
    const reserve = GearAcquisitionPlanner.operationalAdenaReserve(state);
    const budget = Math.max(0, Number(state.adena || 0) - reserve);
    return MarketOpportunity.hotOffers(target.selfId, {
        town: town.name,
        buyerCharacterId: state.characterId
    }).filter((offer) => (
        Number(offer.price) <= budget
        && (offer.sourceType === 'npc' || liveMerchantOffer(offer))
    ));
}

function ownedTargetAmount(state, plan) {
    const selfId = Number(plan?.target?.selfId || 0);
    const item = state.inventory?.[String(selfId)] || state.inventory?.[selfId];
    return Number(item?.amount || 0);
}

function pendingTargetAmount(plan) {
    const selfId = Number(plan?.target?.selfId || 0);
    const componentAmount = (plan?.combine?.requirements || [])
        .filter((requirement) => Number(requirement.selfId) === selfId)
        .reduce((sum, requirement) => sum + Number(requirement.amount || 0), 0);
    return Math.max(1, componentAmount);
}

function checkedPlan(session, state, town, options = {}) {
    const previous = state.stats?.equipmentPlan;
    const excludedSlots = new Set((options.excludedSlots || []).map(Number));
    if (previous?.strategy === 'market'
        && Number(previous.target?.selfId || 0) > 0
        && !excludedSlots.has(Number(previous.target?.slot || 0))
        && ownedTargetAmount(state, previous) < pendingTargetAmount(previous)
        && affordableOffers(previous.target, state, town).length > 0) {
        return { ...previous, status: previous.status || 'active' };
    }

    const findNpcOffer = (target) => affordableOffers(target, state, town)
        .find((offer) => offer.sourceType === 'npc') || null;
    const findMarketOffer = (target) => affordableOffers(target, state, town)[0] || null;
    return GearAcquisitionPlanner.planFor(state, {
        spots: [],
        findNpcOffer,
        findMarketOffer,
        excludedSlots: [...excludedSlots]
    });
}

function npcTarget(offer, bot, town) {
    return TownNpcCatalog.targetForNpc(town.name, offer.sourceId, {
        from: { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() },
        worldSpawns: World.npc?.spawns || []
    }) || {
        actorId: null,
        npcSelfId: Number(offer.sourceId),
        name: offer.sourceName || `NPC ${offer.sourceId}`,
        locX: Number(offer.locX ?? town.x),
        locY: Number(offer.locY ?? town.y),
        locZ: Number(offer.locZ ?? town.z),
        town: town.name
    };
}

function merchantTarget(offer, town) {
    const actor = offer.session.actor;
    return {
        actorId: Number(actor.fetchId()),
        name: actor.fetchName(),
        locX: Number(actor.fetchLocX()),
        locY: Number(actor.fetchLocY()),
        locZ: Number(actor.fetchLocZ()),
        town: offer.town || town.name
    };
}

function planErrand(session, bot, town, purchaseCount = 0, excludedSlots = []) {
    if (!town?.name || purchaseCount >= MAX_PURCHASES_PER_VISIT) return null;
    const state = currentState(session, bot, town);
    const plan = checkedPlan(session, state, town, { excludedSlots });
    session.coldLifeState = {
        ...state,
        stats: { ...(state.stats || {}), equipmentPlan: plan }
    };

    if (plan?.status !== 'active' || plan.strategy !== 'market' || !plan.target?.selfId) return null;
    const offers = affordableOffers(plan.target, state, town);
    const offer = offers.find((candidate) => candidate.sourceType === plan.market?.sourceType) || offers[0];
    if (!offer) return null;

    return {
        kind: offer.sourceType === 'npc' ? 'npc_equipment_purchase' : 'market_purchase',
        sourceType: offer.sourceType,
        sourceId: offer.sourceId,
        itemId: Number(plan.target.selfId),
        itemName: offer.itemName || plan.target.name,
        slot: Number(plan.target.slot || 0),
        price: Number(offer.price),
        purchaseCount,
        excludedSlots: [...excludedSlots],
        target: offer.sourceType === 'npc'
            ? npcTarget(offer, bot, town)
            : merchantTarget(offer, town)
    };
}

function alternateNpcErrand(session, bot, town, errand) {
    if (errand?.kind !== 'npc_equipment_purchase' || !town?.name) return null;
    const state = currentState(session, bot, town);
    const reserve = GearAcquisitionPlanner.operationalAdenaReserve(state);
    const budget = Math.max(0, Number(state.adena || 0) - reserve);
    const failedSourceIds = new Set([
        ...(errand.failedSourceIds || []).map(Number),
        Number(errand.sourceId || 0)
    ]);
    const offer = MarketOpportunity.npcOffers(errand.itemId, town.name)
        .filter((candidate) => (
            candidate.available !== false
            && Number(candidate.price || 0) > 0
            && Number(candidate.price) <= budget
            && !failedSourceIds.has(Number(candidate.sourceId))
        ))
        .sort((left, right) => Number(left.price) - Number(right.price)
            || Math.hypot(Number(left.locX) - bot.fetchLocX(), Number(left.locY) - bot.fetchLocY())
                - Math.hypot(Number(right.locX) - bot.fetchLocX(), Number(right.locY) - bot.fetchLocY()))[0];
    if (!offer) return null;

    return {
        ...errand,
        sourceId: Number(offer.sourceId),
        itemName: offer.itemName || errand.itemName,
        price: Number(offer.price),
        failedSourceIds: [...failedSourceIds],
        target: npcTarget(offer, bot, town)
    };
}

module.exports = {
    MAX_PURCHASES_PER_VISIT,
    alternateNpcErrand,
    currentState,
    planErrand
};
