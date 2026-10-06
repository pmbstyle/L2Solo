const refreshPartyMemberships = require('../../World/PartyMembershipPublication');
const World = invoke('GameServer/World/World');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const PurchaseFunding = invoke('GameServer/Bot/Economy/PurchaseFunding');
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

function affordableOffers(target, state, town, session) {
    // ARCH-NOTE: Player companion errands use the player's choice; autonomous bots spend only on their funded item.
    const budget = PurchaseFunding.spendable(state, 0, session.partyCompanion === true
        ? { upperBound: true } : { itemId: target.selfId });
    const offer = MarketOpportunity.bestOffer(target.selfId, {
        town: town.name,
        buyerCharacterId: state.characterId,
        budget,
        accept: (candidate) => candidate.sourceType === 'npc'
            || ['afk_player_store', 'afk_bot_store'].includes(candidate.sourceType)
    });
    return offer ? [offer] : [];
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
    // Autonomous hot bots buy the same funded leaf as cold actors. Player
    // companion requests retain their explicitly assigned native errands.
    if (session.partyCompanion !== true) {
        const economy = invoke('GameServer/Bot/Economy/EconomyContext').forState(state);
        const leaf = economy.network.activity;
        const selfId = Number(leaf?.itemId || 0);
        if (leaf?.activity !== 'shopping' || !selfId) return { plan: null, offers: [] };
        const item = require('../../Item/ItemTemplateIndex').find(invoke('GameServer/DataCache').items, selfId);
        const amount = Math.max(1, Math.ceil(leaf.amount || 1));
        const budget = Math.min(PurchaseFunding.spendable(state, 0, { itemId: selfId }) / amount, economy.worth(selfId) ?? Infinity);
        const offer = MarketOpportunity.bestOffer(selfId, { town: town.name, buyerCharacterId: state.characterId, budget });
        return { plan: offer ? { status: 'active', strategy: 'market',
            target: { selfId, name: item?.template?.name, slot: Number(item?.etc?.slot || 0) }, amount,
            market: { sourceType: offer.sourceType } } : null, offers: offer ? [offer] : [] };
    }
    const previous = state.stats?.equipmentPlan;
    const excludedSlots = new Set((options.excludedSlots || []).map(Number));
    const offerCache = new Map();
    const offersFor = (target) => {
        const selfId = Number(target?.selfId || 0);
        if (!offerCache.has(selfId)) offerCache.set(selfId, affordableOffers(target, state, town, session));
        return offerCache.get(selfId);
    };
    const previousOffers = previous?.target?.selfId ? offersFor(previous.target) : [];
    if (previous?.strategy === 'market'
        && Number(previous.target?.selfId || 0) > 0
        && !excludedSlots.has(Number(previous.target?.slot || 0))
        && ownedTargetAmount(state, previous) < pendingTargetAmount(previous)
        && previousOffers.length > 0) {
        return { plan: { ...previous, status: previous.status || 'active' }, offers: previousOffers };
    }

    const findNpcOffer = (target) => offersFor(target)
        .find((offer) => offer.sourceType === 'npc') || null;
    const findMarketOffer = (target) => offersFor(target)[0] || null;
    const plan = GearAcquisitionPlanner.planFor(state, {
        spots: [],
        findNpcOffer,
        findMarketOffer,
        excludedSlots: [...excludedSlots]
    });
    return { plan, offers: plan?.target?.selfId ? offersFor(plan.target) : [] };
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
    return MarketOpportunity.offerTarget(offer, town.name);
}

function planErrand(session, bot, town, purchaseCount = 0, excludedSlots = []) {
    if (!town?.name || purchaseCount >= MAX_PURCHASES_PER_VISIT) return null;
    const state = currentState(session, bot, town);
    const unseal = invoke('GameServer/Bot/AI/BotMammonUnseal').plan(session,bot,town,state);
    if (unseal) return unseal;
    const DualCraft = invoke('GameServer/Bot/AI/CompanionDualSwordCrafting');
    const prepared = DualCraft.plan(session,bot,town,state);
    if (prepared.handled) return prepared.errand;
    const checked = checkedPlan(session, state, town, { excludedSlots });
    const plan = checked.plan;
    session.coldLifeState = {
        ...state,
        stats: { ...(state.stats || {}), equipmentPlan: plan }
    };
    refreshPartyMemberships([session], invoke);

    const combination = DualCraft.plan(session,bot,town,session.coldLifeState,plan);
    if (combination.handled) return combination.errand;

    if (plan?.status !== 'active' || plan.strategy !== 'market' || !plan.target?.selfId) return null;
    const offers = checked.offers;
    const offer = offers.find((candidate) => candidate.sourceType === plan.market?.sourceType) || offers[0];
    if (!offer) return null;

    return {
        kind: offer.sourceType === 'npc' ? 'npc_equipment_purchase' : 'market_purchase',
        sourceType: offer.sourceType,
        sourceId: offer.sourceId,
        lineId: Number(offer.lineId || 0) || null,
        itemId: Number(plan.target.selfId),
        itemName: offer.itemName || plan.target.name,
        slot: Number(plan.target.slot || 0),
        price: Number(offer.price),
        amount: Math.min(Number(offer.count || Infinity), Number(plan.amount || 1)),
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
    const budget = PurchaseFunding.spendable(state, 0, session.partyCompanion === true
        ? { upperBound: true } : { itemId: errand.itemId });
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
