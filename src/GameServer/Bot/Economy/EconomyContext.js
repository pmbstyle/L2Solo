'use strict';

const GearThreat = require('./GearThreat');

const ItemIndex = require('../../Item/ItemTemplateIndex');
const Valuation = require('./EconomicValuation');
const Providers = require('./WishProviders');
const { WishNetwork, remember, admitRoots, remainingQuantity } = require('./WishNetwork');
const { isMainThread } = require('node:worker_threads');
const Diagnostics = require('./EconomyDiagnostics');
const { fnv1a32 } = require('../Fnv1a');
const engine = new WishNetwork();
const Trip = require('./EconomicTrip');
let routeAnchors = new WeakMap();
let mainColdForState = null;
let runtime = {};
const extensions = new Map();
function configure(providers = {}) { runtime = providers; reset(); }
function registerProvider(key, provider) {
    if (typeof provider !== 'function') throw new TypeError('invalid_economy_provider');
    extensions.set(key, provider); reset();
}
// actorKey -> { key, reads, plan, stateRef, gearThreat } of bots: bounded
// (WishNetwork.remember). The plan is data (planOf); a reader gets view().
const cache = new Map();
let planningContexts = 0;
function setPlanningContexts(count) {
    planningContexts = Math.max(0, Math.min(64, Math.floor(Number(count) || 0)));
    while (cache.size > 64 - planningContexts) {
        const key = cache.keys().next().value; cache.delete(key); engine.forget(key, 'planning_capacity');
        if (Diagnostics.active()) { Diagnostics.count('context', 'eviction', 'planning_capacity'); noteRelease(key, 'planning_capacity'); }
    }
}
// Groups apart, so a party composition that weighs many candidate groups
// never evicts the bots' own reviews: `group:<partyId>` -> { key, ids,
// context }, removed when the party ends (forgetGroup) and bounded besides;
// a proposed composition (`proposal:` party id) is built and not kept.
const groups = new Map();
const GROUP_LIMIT = 256;
// Shadow count (perf item 1, diagnostics only): per actor the hash of its last
// input key, when that build ran and what released its context since, to count
// rebuilds whose inputs equal the bot's previous request (a retained context
// would have served them), how long after it, and what dropped the context
// (perf B1: only a short gap is reachable within the worker's memory budget).
// The entry also keeps the hash of the plan that build produced (focus, queue
// with funding, activity, dormant), so a rebuild is counted by whether its
// inputs and its plan repeated the actor's previous build: how many rebuilds
// change nothing a bot does (the B5 question). It never decides anything.
const lastKeyHashes = new Map();
const LAST_KEY_LIMIT = 8192;
const GAP_BUCKETS = [[1000, 'lt1s'], [5000, '1_5s'], [15000, '5_15s'], [30000, '15_30s'], [60000, '30_60s'], [120000, '60_120s']];
const gapBucket = ms => GAP_BUCKETS.find(([limit]) => ms < limit)?.[1] || 'ge120s';
// A build forState did not keep stays 'unkept': a later release of an older
// kept context of the same actor is not its release.
function noteRelease(actorKey, reason) {
    const last = lastKeyHashes.get(actorKey);
    if (last && last.released !== 'unkept') last.released = reason;
}
const positive = value => Math.max(0, Number(value) || 0);
// What a bot acts on from its plan: the focus key, the ordered queue with its
// funding, the chosen activity and the dormant keys; prices and play-hour
// stamps inside focus/dormant rows are not acted on. Shadow count only.
const planHash = network => fnv1a32(JSON.stringify([network.focus?.[0] ?? null, (network.queue || []).map(row => [row.key, row.funded === true]),
    network.activity?.key ?? network.activity?.kind ?? null, (network.dormant || []).map(row => Array.isArray(row) ? row[0] : row)]));

function stateForActor(actor, session = actor?.session) {
    const stored = session?.coldLifeState || {};
    const current = invoke('GameServer/Bot/Population/BotLifeState').cachedState?.(actor.fetchId?.());
    const inventory = {};
    const physicalInventory = actor.backpack?.fetchItems?.() || [];
    for (const item of physicalInventory) {
        const id = Number(item.fetchSelfId?.());
        if (!id) continue;
        const amount = positive(item.fetchAmount?.());
        const equipped = !!item.fetchEquipped?.();
        const previous = inventory[id];
        inventory[id] = { selfId: id, amount: amount + positive(previous?.amount),
            equipped: equipped || previous?.equipped, equippedCount: Number(equipped) + positive(previous?.equippedCount),
            slot: equipped ? Number(item.fetchSlot?.()) : previous?.slot || 0,
            enchant: item.fetchEnchantLevel?.() ?? item.fetchEnchant?.() ?? 0, stackable: item.fetchStackable?.(),
            instances: [...(previous?.instances || []), { id: item.fetchId?.(), selfId: id, amount, equipped,
                slot: Number(item.fetchSlot?.() || 0), enchant: item.fetchEnchantLevel?.() ?? item.fetchEnchant?.() ?? 0 }] };
    }
    const hotKit = invoke('GameServer/Bot/Population/ColdCombatProfile').capture(actor);
    const state = { ...stored, characterId: actor.fetchId?.(), level: actor.fetchLevel?.(), inventory, physicalInventory,
        clanId: Number(actor.fetchClanId?.() ?? stored.clanId ?? stored.stats?.clanId ?? 0),
        craftLevel: actor.backpack?.fetchDwarvenCraftLevel?.(actor) ?? stored.craftLevel,
        acceptedIncoming: current?.acceptedIncoming || stored.acceptedIncoming || {},
        incomingPending: current ? current.incomingPending === true : stored.incomingPending === true,
        adena: actor.backpack?.fetchItemFromSelfId?.(57)?.fetchAmount?.() || 0,
        sp: actor.fetchSp?.() ?? stored.sp,
        spotId: session?.currentSpot?.id || stored.spotId,
        stats: { ...session?.heldEconomy?.statsPacket, ...session?.decisionStats, ...stored.stats, coldCombat: hotKit, hennas: [...(session?.hennas || stored.stats?.hennas || [])], soulCrystalQuest: session?.questStates?.get(350)?.isStarted() === true || stored.stats?.soulCrystalQuest, classId: actor.fetchClassId?.(), exp: actor.fetchExp?.(), karma: actor.fetchKarma?.(), pk: actor.fetchPk?.() },
        party: session?.hotBackgroundPartyId ? { partyId: session.hotBackgroundPartyId, role: stored.party?.role } : null,
        activity: session?.plan || 'hunting' };
    const loc = { locX: Number(actor.fetchLocX?.()), locY: Number(actor.fetchLocY?.()), locZ: Number(actor.fetchLocZ?.()) };
    if (!Object.values(loc).every(Number.isFinite)) Object.assign(loc, stored.loc || {});
    state.loc = loc;
    return routeState(state, session);
}
function routeState(state, session) {
    if (!session || typeof session !== 'object') return state;
    const frame = Trip.frame(state); frame.loc = null;
    const event = JSON.stringify([state.spotId, state.stats?.decisionSeq, frame]);
    const held = routeAnchors.get(session);
    const anchor = held?.event === event ? held : { event, loc: state.loc };
    routeAnchors.set(session, anchor);
    return { ...state, loc: anchor.loc };
}
function inputKey(state, deps = {}) {
    const stats = state.stats || {};
    const items = Object.values(state.inventory || {}).map(row => [row.selfId, row.amount, row.equippedCount || row.equipped,
        row.slot, row.enchant, row.stackable, row.starterMobLootAmount, row.kind, row.rank,
        row.reservedAmount, row.protectedAmount, row.protected, row.acceptedCustomer, row.assignedClan, row.available,
        (row.instances || []).map(item=>[item.id,item.enchant,item.slot,item.equipped,item.amount].join('/')).join(';')].join(':')).sort().join(',');
    // A native bag change, own sample or relation revision is an input event.
    // No timing poll, no world-wide counter: the board and the market are
    // inputs only through the items the bot read (see `market` in forState).
    return [state.level, stats.classId, state.craftLevel ?? stats.dwarvenCraftLevel, items, positive(state.adena), stats.decisionSeq, stats.activityLeaf, stats.visitEvery?.[0], stats.visitEvery?.[1],
        deps.workshop?.recipeId, deps.workshop?.productId, deps.workshop?.incomePerHour, deps.workshop?.cycleHours,
        Providers.recipeIds(state, deps).join(','), deps.producerRevision ?? '',
        Number(state.vitals?.mp), positive(deps.buyOrderEscrow),
        Math.floor(positive(stats.frustration) * 10), stats.karma, stats.clanId, state.clanId, state.party?.partyId, state.partyId,
        stats.generatedCold, stats.race, stats.marketSellRetryAfter,
        Number(stats.marketSellRetryAfter || 0) > Number(deps.timestamp || Date.now()),
        invoke('GameServer/Bot/Economy/ItemDisposition').reservationInputKey(state), JSON.stringify(stats.clanMaterialDemand || null),
        state.spotId, deps.gearThreatMask ?? GearThreat.maskFor(state, deps), stats.huntEfficiency?.[0]?.at, deps.memory?.revision || stats.memoryRevision || 0,
        deps.inputKey || '', deps.mode || '', state.incomingPending, JSON.stringify(state.acceptedIncoming || null), Trip.key(state), deps.routeRows ? 'route_ready' : deps.tripCost ? 'route_given' : 'route_pending', stats.pk, stats.soulCrystalQuest, (stats.hennas || []).join(','),
        Math.floor(positive(stats.exp ?? state.exp) / Math.max(1, positive(state.level) ** 2 * 100)),
        deps.knowledgeEnabled ?? invoke('GameServer/Bot/AI/KnowledgeLearning').knowledgeEnabled(),
        stats.production?.crafts || 0, positive(state.sp),
        (stats.coldCombat?.skills || state.skills || []).map(row => `${row.selfId}:${row.level}`).join(',')].join('|');
}
// The market as an input of one bot: the board lines and the counter of each
// item its review read, as tokens at the time of reading. The context stays
// valid while every token holds; a deal or a line of another item, anywhere
// in the world, rebuilds nobody (design 16.5). Not inputs, by the same rule:
// the all-counter average a counter without its own move falls back to
// (MarketCounters.moveOf) and PriceBelief's hourly demand cache.
function marketToken(board, id, deps = {}) {
    const Counters = invoke('GameServer/Bot/Economy/MarketCounters');
    return `${board?.itemRevision ? board.itemRevision(id) : '-'}|${Counters.revisionOf(Counters.counterOf(id))}|${deps.workshopRevision?.(id) || 0}`;
}
function marketHolds(board, reads, deps) {
    for (const [id, token] of reads) if (marketToken(board, id, deps) !== token) return false;
    return true;
}
function marketKey(reads) {
    let hash = 0x811c9dc5;
    for (const [id, token] of reads) {
        const text = `${id}=${token};`;
        for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
    }
    return hash.toString(16);
}
// Board reads of the review go through here while it is built, so each
// item it looked at is remembered with its token. Later readers of
// context.board (a market look, a sale) do not widen what the review
// depends on.
function watchedBoard(board, watch) {
    if (!board) return board;
    return Object.assign(Object.create(board), {
        first: (selfId, ...rest) => { watch(selfId); return board.first(selfId, ...rest); },
        list: (selfId, ...rest) => { watch(selfId); return board.list(selfId, ...rest); },
        ...(board.heads ? { heads: (selfId, ...rest) => { watch(selfId); return board.heads(selfId, ...rest); } } : {})
    });
}
function defaultProducerSource(state, board) {
    const index = invoke('GameServer/Bot/Population/ColdOccupationSources').recipeIndex(board);
    const level = invoke('GameServer/Bot/Economy/CraftEligibility').craftLevelFor(state), scope = index.scopeFor(level);
    return { recipes: index.rowsFor(level), scope, revision: index.revision(scope) };
}
function resolved(state, deps, production = true) {
    deps = { ...runtime, ...deps };
    if (typeof deps.board === 'function') deps.board = deps.board();
    if (!deps.board && isMainThread) deps.board = invoke('GameServer/AfkTrade/AfkTradeService').boardIndex();
    if (typeof deps.spots === 'function') deps.spots = deps.spots();
    if (typeof deps.memory === 'function') deps.memory = deps.memory(state.characterId);
    // Stock, survival and own shot-use readers need only the hunt foundation.
    // Production sources and recipe books belong to the full wish review.
    if (production) {
        if (typeof deps.workshop === 'function') deps.workshop = deps.workshop(state.characterId);
        if (typeof deps.knownRecipes === 'function') deps.knownRecipes = deps.knownRecipes(state.characterId);
        if (!deps.fixedProductionOffersFor) deps.fixedProductionOffersFor = invoke('GameServer/Bot/Population/ColdOccupationSources').fixedBuyerOffersFor;
        if (!deps.producerSource && deps.board) deps.producerSource = defaultProducerSource;
        if (typeof deps.producerSource === 'function') {
            const source = deps.producerSource(state, deps.board);
            deps.producerRecipes = source?.recipes;
            deps.producerRevision = source?.revision;
            if (source?.scope != null) deps.onSourceScope?.(source.scope);
        }
        if (isMainThread && !Object.hasOwn(deps, 'workshop')) deps.workshop = craftIncome(state);
        if (isMainThread && !Object.hasOwn(deps, 'workshops')) {
            const Workshops = invoke('GameServer/Bot/Economy/CraftWorkshopService');
            deps.workshops = Workshops.publicForRecipe;
            deps.workshopRevision = Workshops.publicRecipeDigest;
        }
        if (isMainThread && !Object.hasOwn(deps, 'knownRecipes')) {
            const Workshops = invoke('GameServer/Bot/Economy/CraftWorkshopService');
            if (Workshops.bookFor(state.characterId) !== null) deps.knownRecipes = Workshops.cachedRecipes(state.characterId);
        }
        if (typeof deps.buyOrderEscrow === 'function') deps.buyOrderEscrow = deps.buyOrderEscrow(state.characterId);
    }
    if (!deps.spots && isMainThread) deps.spots = invoke('GameServer/Bot/Population/SpotProfiles').ensure();
    if (!deps.npcOffersFor && isMainThread) deps.npcOffersFor = id => {
        const Sources = invoke('GameServer/Bot/Population/ColdOccupationSources');
        Sources.initialise(); return Sources.npcOffersFor(id);
    };
    return deps;
}
function personaOf(state, deps) {
    return deps.persona || invoke('GameServer/Bot/AI/BotPersona').of(state) || { traits: {}, understanding: 0.3 };
}
function pricing(state, persona, board, timestamp, deps, read = () => {}, prices = new Map()) {
    const Belief = invoke('GameServer/Bot/Economy/PriceBelief');
    const knowledgeEnabled = deps.knowledgeEnabled ?? invoke('GameServer/Bot/AI/KnowledgeLearning').knowledgeEnabled();
    const priceCtx = { characterId: state.characterId, understanding: persona.understanding ?? 0.3,
        marketTrades: state.marketTrades, knowledgeEnabled, board, timestamp };
    return { knowledgeEnabled, prices, price: id => {
        read(id);
        if (!prices.has(Number(id))) {
            const belief = Belief.prior(id, priceCtx);
            prices.set(Number(id), belief ? Math.exp(belief.mu) : 0);
        }
        return prices.get(Number(id));
    } };
}
// Price future carried scroll uses only if a review needs extra stock.
// Resolve the known hunt through the existing catalogue index; a merchant
// location during a town visit is never a future hunting origin.
function scrollHoursFor(state, spots, bestSpotId) {
    if (invoke('GameServer/Karma').closesTowns(state.stats?.karma)) return 0;
    const origin = invoke('GameServer/Bot/AI/SpotIndex').spotById(spots, bestSpotId)?.center
        || state.stats?.marketReturn?.loc || (state.activity === 'hunting' ? state.loc : null);
    if (!origin || ![origin.locX, origin.locY, origin.locZ].every(Number.isFinite)
        || origin.locX === 0 && origin.locY === 0) return 0;
    const Trip = invoke('GameServer/Bot/Population/ColdTrip'), Routes = invoke('GameServer/Bot/Travel/TravelRoutes');
    const destination = Routes.landingTown(origin);
    const routeState = { ...state, loc: origin, inventory: { 736: { amount: 0 } } };
    const walking = Trip.townPlan(routeState, destination);
    const recall = Trip.townPlan({ ...routeState, inventory: { 736: { amount: 1 } } }, destination);
    return walking && recall && recall.scroll ? Math.max(0, walking.durationMs - recall.durationMs) / 3600000 : 0;
}
// stock(kind) and kitCost(id) over the kit data of one review: the build and
// every later view of its plan answer from the same numbers. Prices go
// through the caller's price reader, so each read joins the review's inputs.
function kitReader(data, price, scrollUseHours) {
    const stock = kind => {
        if (kind === 'scrolls') {
            const current = data.scrolls,
                target = invoke('GameServer/Bot/Travel/ScrollStock').TARGET_AMOUNT, survivalTarget = 1;
            const missing = Math.max(0, target - Math.max(current, survivalTarget));
            const benefitPerUnit = current < target ? scrollUseHours() : 0;
            return { itemId: 736, usePerHour: 0, current, hours: Infinity, targetHours: data.targetHours, target,
                survivalTarget, survivalMissing: Math.max(0, survivalTarget - current), missing,
                unitPrice: price(736), benefitPerUnit, benefitHours: missing * benefitPerUnit, needed: current < target };
        }
        const shots = kind === 'shots';
        const row = shots ? data.shots : data.potions;
        const { itemId, use, current } = row;
        const wantedTarget = Math.max(Math.ceil(use), Math.ceil(use * data.targetHours));
        // Useful owned stock need not justify expensive replacement stock.
        const target = row.canRestock ? wantedTarget : Math.min(current, wantedTarget);
        // Forecast consumption may be fractional; both purchase tranches use
        // the same whole-unit survival stock so their sum remains executable.
        const survivalTarget = row.canRestock ? Math.ceil(use) : Math.min(current, Math.ceil(use));
        const survivalMissing = Math.max(0, survivalTarget - current);
        const missing = Math.max(0, target - Math.max(current, survivalTarget));
        const benefitPerUnit = use > 0 ? row.benefit / use : 0;
        const benefitHours = missing * benefitPerUnit;
        return { itemId: Number(itemId), usePerHour: use, ...(shots ? { ownedUsePerHour: row.ownedUsePerHour, beginnerCurrent: row.beginnerCurrent,
                beginnerUsePerHour: row.beginnerUsePerHour, paidUsePerHour: row.paidUsePerHour } : {}),
            current, hours: use > 0 ? current / use : Infinity,
            targetHours: data.targetHours, target, survivalTarget, missing, survivalMissing, unitPrice: price(itemId), benefitPerUnit, benefitHours,
            needed: use > 0 && current < survivalTarget };
    };
    const kit = [stock('shots'), stock('potions')];
    const escapeCost = data.closed ? 0 : price(736) * Math.max(0, 1 - data.scrolls);
    // A known executable quote pays whole missing units once. The personal
    // price estimate still values an unseen option; it must not underfund
    // a concrete merchant's mandatory stock and trigger repeated tiny fills.
    const kitCost = (id, unitPrice = null) => {
        const quoted = Number.isFinite(unitPrice) && unitPrice > 0;
        if (Number(id) === 736 && data.closed) return 0;
        if (Number(id) === 736) return quoted ? unitPrice * Math.max(0, 1 - data.scrolls) : escapeCost;
        return kit.filter(row => row.itemId === Number(id)).reduce((sum, row) => sum
            + row.survivalMissing
                * (quoted ? unitPrice : row.unitPrice), 0);
    };
    return { stock, kitCost, kit, escapeCost };
}
// The bot's hour, death and karma prices and its stock of shots and potions:
// the part of a review that needs no wish network. forState builds on it and
// basics() returns it alone, so a reader that wants only these never builds
// the network, and both give the same numbers.
function foundation(state, deps, persona, timestamp, price) {
    const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
    const Table = invoke('GameServer/Bot/AI/SpotValueTable');
    const role = state.party?.role || state.stats?.role || invoke('GameServer/Bot/AI/BotRoles').inferRole(state.stats?.classId || 0);
    const tableRole = role === 'melee' ? 'dps' : role === 'nuker' ? 'mage' : role === 'crafter' ? 'spoiler' : role;
    let hunt = Hunt.huntIncome(state, timestamp, deps.mode);
    const incomeRoute = require('./EquipmentIncomeRoute').select(state, { ...deps, timestamp, price,
        required: invoke('GameServer/Bot/AI/PersonalGearProgression').assess(state).required });
    if (incomeRoute) {
        const row = incomeRoute.row;
        hunt = { perHour: row.income * Hunt.onSpotShare(state), perKill: row.kills > 0 ? row.income / row.kills : 0,
            expPerHour: row.exp * Hunt.onSpotShare(state), source: 'route', spotId: incomeRoute.spot.id,
            progressSpotId: incomeRoute.spot.id, useShots: row.useShots };
    }
    const lostGearHours = hunt.perHour > 0 ? Valuation.pkDropValue(state, price) / hunt.perHour : 0;
    const bestSpotId = hunt.spotId || state.spotId;
    const walkBackHours = invoke('GameServer/Bot/Economy/WalkBack').hours(bestSpotId, state, deps.spots || invoke('GameServer/Bot/AI/SpotService').spots);
    const deathHours = Valuation.deathHours(state, { ...hunt, lostGearHours, walkBackHours });
    const spotTable = bestSpotId ? Table.value(bestSpotId, tableRole, state.level, hunt.useShots !== false) : null;
    const bestTable = spotTable || Table.best(tableRole, state.level, hunt.useShots !== false);
    const ShotStock = invoke('GameServer/Inventory/ShotStock');
    const shotPlan = ShotStock.planForState(state);
    const shotItemId = shotPlan.selfId;
    const potionItemId = invoke('GameServer/Bot/AI/HealingPotionStock').purchasePotionFor(state).selfId;
    const withoutShots = bestSpotId ? Table.value(bestSpotId, tableRole, state.level, false) : null;
    const shotPolicy = ShotStock.usePolicy(state, { plan: shotPlan, bestTable, withoutShots,
        hourAdena: Hunt.huntHour(hunt, state), unitPrice: price(shotItemId) });
    const shotBenefit = shotPolicy.benefit;
    const beginnerCurrent = ShotStock.beginnerAmount(state, shotPlan);
    const shotUse = positive(state.inventory?.[shotItemId]?.amount) + beginnerCurrent > 0
        ? shotPolicy.usePerHour : shotPolicy.purchaseUsePerHour;
    const potionUse = positive(bestTable?.potions);
    let bagHours = 2;
    const hasBagForecast = spotTable?.stacks !== null && spotTable?.stacks !== undefined;
    if (hasBagForecast) {
        const Floor = invoke('GameServer/Bot/Population/SurvivalFloor'), Data = invoke('GameServer/DataCache');
        const race = state.stats?.race ?? Data.classTemplates?.find(row => Number(row.classId) === Number(state.stats?.classId || 0))?.template?.race;
        // ARCH-NOTE: size the E9 bag interval on the bag after its
        // planned kit stacks exist. Otherwise an empty shot/potion row uses
        // no slot, its refill uses one, and the shorter interval immediately
        // sells part of that refill back to the NPC. Existing stacks retain
        // the exact physical free-slot formula; zero-use stock reserves none.
        const plannedSlots = Number(shotUse > 0 && !positive(state.inventory?.[shotItemId]?.amount) && !beginnerCurrent)
            + Number(potionUse > 0 && !positive(state.inventory?.[potionItemId]?.amount));
        let slotLimit = Floor.inventoryLimit(race);
        const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
        const saleLimit = Disposition.soloSaleSlotLimit(state, timestamp);
        if (saleLimit !== null) {
            // Stock cannot be its own reason for an earlier town visit. Keep
            // the entire usable kit while checking known free saleable loot.
            const keptAmounts = { [shotItemId]: positive(state.inventory?.[shotItemId]?.amount),
                ...invoke('GameServer/Bot/AI/HealingPotionStock').keptAmounts(state, { targetAmount: Infinity }),
                736: positive(state.inventory?.[736]?.amount) };
            if (Disposition.saleCandidates(state, { keptAmounts, preparedReservations: deps.saleReservations,
                presenceOnly: true })) slotLimit = Math.min(slotLimit, saleLimit);
        }
        const free = Math.max(0, slotLimit - Floor.stateInventory(state, Data.items).slots - plannedSlots);
        bagHours = free === 0 ? 0 : spotTable.stacks > 0 ? free / spotTable.stacks : 24;
    }
    const Visits = invoke('GameServer/Bot/Economy/TownVisitInterval');
    // Bag space bounds a planned outing; it never chooses its duration.
    // Keep the existing initial estimate until actual town visits teach one.
    const targetHours = hasBagForecast
        ? Math.min(Visits.targetHours(state.stats), Visits.targetHours({}, bagHours))
        : Visits.targetHours(state.stats);
    // The kit as data (perf C1): what stock() and kitCost() read, so a kept
    // plan answers them later without this build scope.
    const kitData = { targetHours, scrolls: positive(state.inventory?.[736]?.amount),
        closed: invoke('GameServer/Karma').closesTowns(state.stats?.karma), scrollHours: undefined,
        shots: { itemId: shotItemId, use: shotUse, current: positive(state.inventory?.[shotItemId]?.amount) + beginnerCurrent,
            canRestock: shotPolicy.purchaseUsePerHour > 0, benefit: shotBenefit, ownedUsePerHour: shotPolicy.usePerHour,
            beginnerCurrent, beginnerUsePerHour: shotPolicy.beginnerUsePerHour, paidUsePerHour: shotPolicy.paidUsePerHour },
        potions: { itemId: potionItemId, use: potionUse, current: positive(state.inventory?.[potionItemId]?.amount),
            canRestock: true, benefit: positive(bestTable?.deaths) * deathHours } };
    const { stock, kitCost, kit, escapeCost } = kitReader(kitData, price,
        () => kitData.scrollHours ??= scrollHoursFor(state, deps.spots, bestSpotId));
    const reserve = escapeCost + kit.reduce((sum, row) => sum + row.survivalMissing * row.unitPrice, 0);
    return { tableRole, hunt, hourAdena: Hunt.huntHour(hunt, state), survivalReserve: reserve, kitCost, kit: kitData,
        lostGearHours, bestSpotId, deathHours, bestTable, stock,
        riskWeight: Valuation.riskWeight(state, persona),
        expectedDeathHours: positive(bestTable?.deaths) * deathHours,
        karmaHours: Valuation.karmaHours(state, { ...hunt, lostGearHours, deathsPerHour: positive(bestTable?.deaths) }) };
}
function basics(state = {}, deps = {}) {
    deps = resolved(state, deps, false);
    const timestamp = Number(deps.timestamp || Date.now());
    const persona = personaOf(state, deps);
    const board = deps.board || (isMainThread ? invoke('GameServer/AfkTrade/AfkTradeService').boardIndex() : null);
    const { price } = pricing(state, persona, board, timestamp, deps);
    return { persona, price, timestamp, ...foundation(state, deps, persona, timestamp, price) };
}
function stockFor(state, kind, deps = {}) { return basics(state, deps).stock(kind); }
function forState(state = {}, deps = {}) {
    const diagnostic = Diagnostics.active();
    if (diagnostic) Diagnostics.count('context', 'request');
    if (diagnostic && isMainThread && state.phase === 'cold') {
        const caller = deps.caller || 'other';
        mainColdForState ||= new Map();
        const slot = mainColdForState.has(caller) || mainColdForState.size < 63 ? caller : 'overflow';
        mainColdForState.set(slot, (mainColdForState.get(slot) || 0) + 1);
    }
    deps = resolved(state, deps);
    if (typeof deps.routeRows === 'function') deps.routeRows = deps.routeRows(state);
    if (!deps.tripCost && !deps.routeRows && isMainThread)
        deps.routeRows = preparedRouteRows(state) || invoke('GameServer/Bot/Population/ColdSimulationCoordinator').routeRows?.(state);
    const timestamp = Number(deps.timestamp || Date.now());
    const actorKey = deps.actorKey || `character:${Number(state.characterId || 0)}`;
    const sourceBoard = deps.board || (isMainThread ? invoke('GameServer/AfkTrade/AfkTradeService').boardIndex() : null);
    const held = deps.rememberContext === false ? null : cache.get(actorKey);
    // A valid completed card survives planner-slot reuse or card eviction;
    // the same route is repriced with the current hour value, never a wallet.
    if (!deps.routeRows && held?.plan.routeKey === Trip.key(state)) deps.routeRows = held.plan.routeRows;
    const gearThreat = GearThreat.prepare(state, deps, held?.gearThreat);
    deps.gearThreatMask = gearThreat.mask;
    const key = inputKey(state, { ...deps, timestamp });
    // A caller that needs the member's graph nodes (a worker group solve)
    // builds unless the held entry kept them (the main thread keeps them).
    if (held?.key === key && (isMainThread || held.stateRef.deref() === state) && (!deps.withNodes || held.projection)
        && marketHolds(sourceBoard, held.reads, deps)) {
        if (deps.onSourceRead) for (const id of held.reads.keys()) deps.onSourceRead(id);
        if (diagnostic) {
            Diagnostics.count('context', 'hit', 'same_inputs');
            // The gap is measured from the last use, as the cache keeps by last use.
            const last = lastKeyHashes.get(actorKey);
            if (last) last.at = Date.now();
        }
        held.gearThreat = gearThreat;
        remember(cache, actorKey, held);
        // A late price read of a held plan joins its inputs, as in its build.
        const late = id => { id = Number(id); if (held.reads.has(id)) return;
            held.reads.set(id, marketToken(sourceBoard, id, deps)); deps.onSourceRead?.(id); };
        return view(state, held.plan, deps, { board: sourceBoard, read: late, projection: held.projection });
    }
    const started = diagnostic ? performance.now() : 0;
    // Identity replacement is the worker's technical safety backstop, not an
    // economic event. An input-key mismatch is named as a dependency change;
    // it does not claim which historical event caused it.
    const diagnosticReason = !diagnostic ? null : !held ? 'not_retained' : held.key !== key
        ? 'input_dependency_changed' : !isMainThread && held.stateRef.deref() !== state ? 'state_publication'
        : deps.withNodes && !held.projection ? 'nodes_needed' : 'used_market_changed';
    if (diagnostic) Diagnostics.count('context', 'miss', diagnosticReason);
    let shadowSame = false, previousPlan = null, shadowEntry = null;
    if (diagnostic) {
        const hash = fnv1a32(key), last = lastKeyHashes.get(actorKey), at = Date.now();
        const same = last?.hash === hash;
        shadowSame = same; previousPlan = last?.plan ?? null;
        Diagnostics.count('context', 'shadow', `${diagnosticReason}:${same ? 'same_key' : 'new_key'}`);
        if (same) {
            Diagnostics.count('context', 'shadow_gap', gapBucket(Math.max(0, at - last.at)));
            // 'capacity' (LRU), 'planning_capacity', 'unkept' (forState did not keep it) or the owner's forgetContext reason.
            if (diagnosticReason === 'not_retained') Diagnostics.count('context', 'shadow_released', last.released || 'unknown');
        }
        const kept = deps.rememberContext !== false && planningContexts < 64;
        shadowEntry = { hash, at, released: kept ? null : 'unkept', plan: null };
        remember(lastKeyHashes, actorKey, shadowEntry, LAST_KEY_LIMIT);
    }
    const reads = new Map();
    let building = true;
    // MVP-6 Bounds: while a gear candidate's arena is built its reads wait
    // in its own scope; the provider keeps the scopes whose descriptors
    // survive the final cut, so a rejected candidate's items never become
    // inputs of the review.
    let scope = null;
    const read = id => { id = Number(id); if (reads.has(id)) return;
        if (scope) { if (!scope.has(id)) scope.set(id, marketToken(sourceBoard, id, deps)); return; }
        reads.set(id, marketToken(sourceBoard, id, deps)); deps.onSourceRead?.(id);
    };
    const watch = id => { if (building) read(id); };
    const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
    const Table = invoke('GameServer/Bot/AI/SpotValueTable');
    const persona = personaOf(state, deps);
    const board = watchedBoard(sourceBoard, watch);
    // A price is remembered, so every price read counts, also a late one
    // through context.price: its item joins the review's inputs.
    const { price, prices, knowledgeEnabled } = pricing(state, persona, board, timestamp, deps, read);
    const base = foundation(state, deps, persona, timestamp, price);
    const own = Hunt.sampledRows(state, timestamp, deps.mode);
    const calibrations = own.flatMap(row => {
        const value = Table.value(row.spotId, base.tableRole, state.level, true);
        return value?.exp > 0 ? [Math.max(0, row.exp) / row.cycleMs * 3600000 / value.exp] : [];
    });
    const calibration = calibrations.length ? calibrations.reduce((sum, value) => sum + value, 0) / calibrations.length : 1;
    const context = { inputKey: key, actorKey, state, timestamp, gearThreatMask: gearThreat.mask, persona, board, hunt: base.hunt, price, buyback, calibration,
        riskWeight: base.riskWeight, bestSpotId: base.bestSpotId, deathHours: base.deathHours, lostGearHours: base.lostGearHours,
        karmaHours: base.karmaHours, expectedDeathHours: base.expectedDeathHours, stock: base.stock,
        survivalReserve: base.survivalReserve, kitCost: base.kitCost, hourAdena: base.hourAdena,
        readScope: { open: () => (scope = new Map()), close: () => { scope = null; },
            keep: kept => { for (const [id, token] of kept) if (!reads.has(id)) { reads.set(id, token); deps.onSourceRead?.(id); } } } };
    const workshop = Object.hasOwn(deps, 'workshop') ? deps.workshop : isMainThread
        ? craftIncome(state, { hourAdena: base.hourAdena, worth: price, timestamp }) : null;
    context.workshop = workshop || { recipeId: 0, productId: 0, incomePerHour: NaN, cycleHours: NaN };
    const productive = workshop?.known !== false && workshop?.incomePerHour > 0 && Number.isFinite(workshop.incomePerHour)
        && workshop.cycleHours > 0 && Number.isFinite(workshop.cycleHours);
    if (productive) { watch(workshop.productId); context.hourAdena = Math.max(context.hourAdena, workshop.incomePerHour); }
    context.routeKey = Trip.key(state); context.routeRows = Array.isArray(deps.routeRows) && deps.routeRows.length === Trip.towns.length ? deps.routeRows : null;
    context.routePending = !deps.tripCost && !context.routeRows;
    const tripHour = context.hourAdena;
    context.trip = deps.tripCost || Trip.preparedReader(context.routeRows || [], { hourAdena: tripHour });
    context.spotValue = invoke('GameServer/Bot/Economy/SpotEconomics').create(state, { ...deps, timestamp, persona, price, deathHours: context.deathHours });
    if (state.incomingPending) {
        // ARCH-NOTE: an oversized incoming projection waits on the existing
        // settlement/preparation owner. Never replace unknown stock with zero
        // demand or renew the decision seed while that input is unavailable.
        context.network = { inputKey: key, queue: [], activity: null, plans: new Map(), demands: new Map(),
            focus: state.stats?.wishFocus || null, dormant: state.stats?.dormantWishes || [],
            moneyPrice: positive(state.stats?.money?.[1]), hourAdena: context.hourAdena, available: 0,
            decisionSeq: state.stats?.decisionSeq || 0, activityLeaf: state.stats?.activityLeaf || 0 };
        context.moneyPrice = context.network.moneyPrice; context.gapHorizonHours = 0;
        context.watchList = []; context.intentPending = true;
        context.itemUsefulness = () => 0; context.worth = price; context.purchaseBudget = () => 0;
        context.statsPacket = { wishFocus: context.network.focus, dormantWishes: context.network.dormant,
            decisionSeq: context.network.decisionSeq, activityLeaf: context.network.activityLeaf,
            money: state.stats?.money || [0, 0, base.survivalReserve, 0] };
        if (shadowEntry) {
            const plan = planHash(context.network); shadowEntry.plan = plan;
            if (previousPlan !== null) Diagnostics.count('context', 'shadow_plan', `${shadowSame ? 'same_key' : 'new_key'}:${plan === previousPlan ? 'same_plan' : 'new_plan'}`);
        }
        return view(state, planOf(context, base, { key, market: null, tripHour, prices }), deps, { price, kit: base, board, read, spotValue: context.spotValue, trip: context.trip });
    }
    // One stock reader for the provider's gear witnesses and the network
    // build; the projection is read lazily once it exists (stock roots).
    context.wallet = positive(state.adena) + positive(deps.buyOrderEscrow);
    context.stockFor = stockReader(state, rootKey => context.projection?.nodes.find(node => node.key === rootKey)?.object?.itemId);
    const extra = [...extensions.values()].flatMap(provider => provider(state, context) || []);
    const projection = Providers.build(state, context, { ...deps, nodes: [...(deps.nodes || []), ...extra] });
    context.projection = projection;
    if (productive) projection.moneyPaths.push({ activity: 'crafting', kind: 'production', recipeId: workshop.recipeId,
        object: workshop.productId, incomePerHour: workshop.incomePerHour,
        cycleHours: workshop.cycleHours, repeatable: true });
    const market = marketKey(reads);
    const networkKey = `${key}#${market}`;
    const network = engine.build({ actorKey, inputKey: networkKey, ...projection,
        remembered: deps.rememberContext !== false,
        stockFor: context.stockFor,
        characterId: state.characterId, decisionSeq: state.stats?.decisionSeq, activityLeaf: state.stats?.activityLeaf,
        wallet: context.wallet, survivalReserve: base.survivalReserve,
        playedHours: positive(state.stats?.playedHours), persona,
        previous: { focus: state.stats?.wishFocus, dormant: state.stats?.dormantWishes },
        hourAdena: context.hourAdena, riskWeight: context.riskWeight,
        caller: deps.caller || 'economy_context', trigger: deps.trigger || diagnosticReason || 'context_build' });
    context.inputKey = networkKey;
    context.horizonHours = projection.horizon;
    context.network = network;
    context.moneyPrice = network.moneyPrice;
    context.hourAdena = network.hourAdena;
    // Affordability removes a funding gap, not the benefit lost while waiting.
    const urgent = network.gap || network.queue.find(row => row.key === network.focus?.[0]) || network.queue[0];
    context.gapHorizonHours = !urgent ? 0 : urgent.key === 'stock:shots' ? base.stock('shots').targetHours
        : urgent.key === 'stock:potions' ? base.stock('potions').targetHours : projection.horizon;
    Object.assign(context, valueReaders(state, network, projection.values, persona, knowledgeEnabled,
        base.kitCost, () => context.statsPacket.money));
    context.watchList = invoke('GameServer/Bot/Economy/TradeIntent').project(state, network, projection, id => context.worth(id) ?? price(id));
    context.intentPending = context.watchList === null;
    context.watchList ||= [];
    const Funding = invoke('GameServer/Bot/Economy/PurchaseFunding');
    context.statsPacket = { wishFocus: network.focus, dormantWishes: network.dormant,
        decisionSeq: network.decisionSeq, activityLeaf: network.activityLeaf,
        money: Funding.packetFor(network, context.hourAdena, base.survivalReserve) };
    building = false;

    if (diagnostic) {
        Diagnostics.count('context', 'build', diagnosticReason);
        Diagnostics.duration('context', performance.now() - started);
        const plan = planHash(network);
        if (shadowEntry) shadowEntry.plan = plan;
        if (previousPlan !== null) Diagnostics.count('context', 'shadow_plan',
            `${shadowSame ? 'same_key' : 'new_key'}:${plan === previousPlan ? 'same_plan' : 'new_plan'}`);
    }
    if (diagnostic && Diagnostics.enabled(state.characterId)) Diagnostics.push({ owner: state.characterId,
        caller: deps.caller || 'economy_context', trigger: deps.trigger || diagnosticReason,
        phase: 'wish_context', reason: diagnosticReason, inputHash: fnv1a32(networkKey),
        decisionSeq: network.decisionSeq, activityLeaf: network.activityLeaf,
        revision: state.simulation?.revision, wallet: positive(state.adena), escrow: positive(deps.buyOrderEscrow),
        available: network.available, reserve: base.survivalReserve, wishKey: network.focus?.[0] });
    const plan = planOf(context, base, { key, market, tripHour, projection, knowledgeEnabled, prices });
    if (deps.rememberContext !== false && planningContexts < 64) {
        if (diagnostic && !cache.has(actorKey) && cache.size >= 64 - planningContexts) {
            Diagnostics.count('context', 'eviction', 'capacity');
            noteRelease(cache.keys().next().value, 'capacity');
        }
        // The main thread keeps the graph nodes as before (its group solve
        // reads them on a hit); the worker keeps the plan only (perf C1).
        remember(cache, actorKey, { key, reads, plan, stateRef: new WeakRef(state), gearThreat,
            projection: isMainThread ? projection : null }, 64 - planningContexts);
    }
    return view(state, plan, deps, { price, kit: base, board, read, spotValue: context.spotValue, trip: context.trip, projection });
}
// Plan as data (perf C1). A built context's closures hold the wish network,
// the projection and the whole build scope (~60 KB per bot); what its readers
// act on is a few KB of results. The cache keeps this plan, and every reader,
// the building caller included, gets view(state, plan, deps): the same fields
// and functions, answered from the plan, the state it is given and the kit
// data, without a second wish build.
// Plan nodes keep only what post-build readers walk: the materials of the
// decision card (ColdEconomyDecision.capture), TradeIntent.project and
// npcOwnsPurchase, WishProviders.personalCraftPlan. Shared nodes stay shared.
// A requirement row without its plan is looked up by key in network.plans
// (personalCraftPlan); `unresolved` collects those keys for the kept map.
const NODE_FIELDS = ['kind', 'sourceType', 'quoted', 'executable', 'recipeId', 'missingAmount', 'improvement', 'batches'];
const NO_REQUIREMENTS = Object.freeze([]);
function planTrimmer(unresolved = new Set()) {
    const seen = new Map();
    const trim = plan => {
        if (!plan || typeof plan !== 'object') return plan;
        if (seen.has(plan)) return seen.get(plan);
        // Absent fields stay absent and an empty requirement list is one
        // shared frozen array: a bot keeps ~20 nodes, most of them buys.
        const out = {};
        for (const field of NODE_FIELDS) if (plan[field] !== undefined) out[field] = plan[field];
        if (plan.workshop) out.workshop = { characterId: plan.workshop.characterId, price: plan.workshop.price,
            loc: plan.workshop.loc, townName: plan.workshop.townName };
        seen.set(plan, out);
        if (plan.grossRequirements) out.grossRequirements = plan.grossRequirements.map(row => ({ key: row.key,
            amount: row.amount, ...(row.once ? { once: true } : {}) }));
        if (plan.intentionPath !== undefined) out.intentionPath = trim(plan.intentionPath);
        if (plan.requirements) out.requirements = !plan.requirements.length ? NO_REQUIREMENTS : plan.requirements.map(row => {
            if (!row.plan) unresolved.add(row.key);
            return { key: row.key, amount: row.amount, plan: trim(row.plan) };
        });
        return out;
    };
    return trim;
}
// Queue rows keep the fields read after the build (funding, the money packet
// ratio, the card, trade intents, gear and companion choices). network.plans
// keeps the item plans (TradeIntent.npcOwnsPurchase asks by `item:<id>`) and
// the plans of requirement rows that have none, not every graph node.
function compactNetwork(network) {
    const unresolved = new Set(), trim = planTrimmer(unresolved);
    const row = wish => ({ key: wish.key, object: wish.object, price: wish.price, valueHours: wish.valueHours,
        ratio: wish.ratio, funded: wish.funded, plan: trim(wish.plan) });
    const queue = (network.queue || []).map(row);
    const at = network.gap ? (network.queue || []).indexOf(network.gap) : -1;
    const leaf = network.activity;
    const activity = !leaf ? leaf : { ...leaf,
        ...(leaf.requirements ? { requirements: leaf.requirements.map(item => ({ ...item, plan: trim(item.plan) })) } : {}),
        ...(leaf.intentionPath ? { intentionPath: trim(leaf.intentionPath) } : {}) };
    const all = network.plans || new Map(), plans = new Map();
    for (const [key, plan] of all) if (key.startsWith('item:')) plans.set(key, trim(plan));
    for (const key of unresolved) if (!plans.has(key) && all.has(key)) plans.set(key, trim(all.get(key)));
    return { ...network, queue, gap: !network.gap ? network.gap : at >= 0 ? queue[at] : row(network.gap), activity, plans };
}
// The build's prices of what the plan's own numbers were made from (the
// kit, the queue, the watch list): a later view starts from them, so its
// stock rows and kit costs agree with the plan's reserve and money packet.
// Other items are priced by the view (~8 of ~140 prices per bot are kept).
function planPrices(prices, kit, context) {
    const ids = [736, kit.shots.itemId, kit.potions.itemId,
        ...(context.network?.queue || []).map(row => row.object?.itemId), ...(context.watchList || []).map(row => row.itemId)];
    const kept = new Map();
    for (const id of ids) if (prices.has(Number(id))) kept.set(Number(id), prices.get(Number(id)));
    return kept;
}
function planOf(context, base, { key, market, tripHour, projection = null, knowledgeEnabled, prices }) {
    const stockRoots = new Map();
    for (const node of projection?.nodes || [])
        if (node.key.startsWith('stock:') && !stockRoots.has(node.key)) stockRoots.set(node.key, node.object?.itemId);
    return { pending: !projection, key, market, actorKey: context.actorKey, timestamp: context.timestamp,
        gearThreatMask: context.gearThreatMask, persona: context.persona, hunt: context.hunt, calibration: context.calibration,
        riskWeight: context.riskWeight, bestSpotId: context.bestSpotId, deathHours: context.deathHours,
        lostGearHours: context.lostGearHours, karmaHours: context.karmaHours, expectedDeathHours: context.expectedDeathHours,
        survivalReserve: context.survivalReserve, kit: base.kit, hourAdena: context.hourAdena, workshop: context.workshop,
        routeKey: context.routeKey, routeRows: context.routeRows, routePending: context.routePending, tripHour,
        network: compactNetwork(context.network), moneyPrice: context.moneyPrice, gapHorizonHours: context.gapHorizonHours,
        watchList: context.watchList, intentPending: context.intentPending, statsPacket: context.statsPacket,
        wallet: context.wallet, horizonHours: context.horizonHours, values: projection?.values, stockRoots, knowledgeEnabled,
        prices: planPrices(prices, base.kit, context), gearPlanMemo: undefined };
}
// What a review's stock reader, usefulness, worth and purchase budget read:
// one copy for the build and every later view of its plan.
function stockReader(state, rootItem) {
    return (id, rootKey) => ({ owned: rootKey.startsWith('stock:') && rootItem(rootKey) === id
        ? positive(state.inventory?.[id]?.amount) : invoke('GameServer/Bot/Economy/WealthCraftDecision').freeAmount(state, state.inventory?.[id] || {}),
    incoming: positive(state.acceptedIncoming?.[id]) });
}
function valueReaders(state, network, values, persona, knowledgeEnabled, kitCost, money) {
    const itemUsefulness = id => invoke('GameServer/Bot/Population/ColdEconomyDecision').personalUsefulness(
        network.demands.get(`item:${id}`) || values.get(Number(id)) || 0,
        state, persona.understanding, knowledgeEnabled, id);
    const Funding = invoke('GameServer/Bot/Economy/PurchaseFunding');
    return { itemUsefulness,
        worth: id => network.moneyPrice > 0 ? itemUsefulness(id) / network.moneyPrice : null,
        purchaseBudget: id => {
            const wish = network.queue.find(row => Number(row.object?.itemId) === Number(id));
            return Funding.spendable({ ...state, stats: { ...state.stats, money: money() } }, 0,
                Funding.stockTerms(wish, id, kitCost(id)));
        } };
}
// Spot values are read inside a build (providers); a later view makes its
// reader only when asked.
function lazySpotValue(state, plan, deps) {
    let reader;
    return (...args) => (reader ||= invoke('GameServer/Bot/Economy/SpotEconomics').create(state,
        { ...deps, timestamp: plan.timestamp, persona: plan.persona, deathHours: plan.deathHours }))(...args);
}
const buyback = id => invoke('GameServer/Items/NpcSellRules')
    .npcBuyPrice(Number(ItemIndex.find(invoke('GameServer/DataCache').items, id)?.template?.price || 0));
// One reader's context over a plan. `built` carries the building call's own
// readers (prices with their memo, kit, spot value, trip, the projection);
// a later view makes its own from the plan. The state is the caller's, held
// only by this view. Functions read the plan, never a build scope.
function view(state, plan, deps, built = {}) {
    // A later view starts from the build's prices of the plan's own items.
    const price = built.price || pricing(state, plan.persona, built.board, plan.timestamp, deps, built.read, new Map(plan.prices)).price;
    const { stock, kitCost } = built.kit || kitReader(plan.kit, price,
        () => plan.kit.scrollHours ??= scrollHoursFor(state, deps.spots, plan.bestSpotId));
    const network = plan.network;
    const context = { inputKey: plan.market === null ? plan.key : `${plan.key}#${plan.market}`, actorKey: plan.actorKey, state,
        timestamp: plan.timestamp, gearThreatMask: plan.gearThreatMask, persona: plan.persona, board: built.board, hunt: plan.hunt,
        price, buyback, calibration: plan.calibration, riskWeight: plan.riskWeight, bestSpotId: plan.bestSpotId,
        deathHours: plan.deathHours, lostGearHours: plan.lostGearHours, karmaHours: plan.karmaHours,
        expectedDeathHours: plan.expectedDeathHours, stock, survivalReserve: plan.survivalReserve, kitCost,
        hourAdena: plan.hourAdena, workshop: plan.workshop, routeKey: plan.routeKey, routeRows: plan.routeRows,
        routePending: plan.routePending,
        trip: built.trip || deps.tripCost || Trip.preparedReader(plan.routeRows || [], { hourAdena: plan.tripHour }),
        spotValue: built.spotValue || lazySpotValue(state, plan, deps),
        network, moneyPrice: plan.moneyPrice, gapHorizonHours: plan.gapHorizonHours, watchList: plan.watchList,
        intentPending: plan.intentPending, statsPacket: plan.statsPacket };
    // The plan is the identity of one decision for memos kept beside it
    // (a refused trip, the gear plan choice), not this view object.
    Object.defineProperty(context, 'plan', { value: plan });
    Object.defineProperty(context, 'gearPlanMemo', { get: () => plan.gearPlanMemo, set: memo => { plan.gearPlanMemo = memo; } });
    if (plan.pending) {
        context.itemUsefulness = () => 0; context.worth = price; context.purchaseBudget = () => 0;
        return context;
    }
    context.wallet = plan.wallet;
    context.stockFor = stockReader(state, rootKey => plan.stockRoots.get(rootKey));
    // A later view has the usefulness values only; a group solve that needs
    // the members' nodes rebuilds them (forGroup).
    context.projection = built.projection || { values: plan.values };
    context.horizonHours = plan.horizonHours;
    Object.assign(context, valueReaders(state, network, plan.values, plan.persona, plan.knowledgeEnabled,
        kitCost, () => context.statsPacket.money));
    return context;
}
function survivalReserve(state = {}) {
    return Array.isArray(state.stats?.money) ? positive(state.stats.money[2]) : basics(state).survivalReserve;
}
function forActor(actor, session, deps = {}) { return forState(stateForActor(actor, session), deps); }
function craftIncome(state) {
    // The guarded worker publication is the only production income reader on
    // main. A missing result leaves the independently supported hunt baseline.
    if (isMainThread) {
        const coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
        return coordinator.economyDecisions?.workshopFor?.(state)
            || { recipeId: 0, productId: 0, incomePerHour: NaN, cycleHours: NaN };
    }
    return { recipeId: 0, productId: 0, incomePerHour: NaN, cycleHours: NaN };
}
function forGroup(group, members, deps = {}) {
    const diagnostic = Diagnostics.active();
    if (diagnostic) Diagnostics.count('context_group', 'request');
    const selected = (members || []).slice(0, 9);
    const prepared = deps.memberContexts;
    if (prepared !== undefined && (!Array.isArray(prepared) || prepared.length !== selected.length
        || prepared.some((context, i) => !context?.projection?.nodes || context.state !== selected[i])))
        throw new Error('party_member_context_mismatch');
    const contexts = prepared || selected.map(state => forState(state, { ...deps, caller: 'groupContext' }));
    const first = contexts[0];
    if (!first) {
        if (diagnostic) Diagnostics.count('context_group', 'miss', 'empty_group');
        return null;
    }
    const actorKey = `group:${group.id || group.partyId}`;
    const proposal = deps.rememberGroup === false || String(group.id || group.partyId || '').startsWith('proposal:');
    const wallet = positive(group.adena ?? group.wallet);
    const key = [wallet, ...contexts.map(context => context.inputKey)].join('|');
    const held = proposal ? null : groups.get(actorKey);
    // The key holds every member's network key (its inputs and the market
    // items its review read), so equal keys are equal member plans (perf C1:
    // a member's later view is a new object over the same plan).
    if (held?.key === key) {
        if (diagnostic) Diagnostics.count('context_group', 'hit', 'same_members');
        return remember(groups, actorKey, held, GROUP_LIMIT).context;
    }
    const started = diagnostic ? performance.now() : 0;
    if (diagnostic) Diagnostics.count('context_group', 'miss', proposal ? 'uncached_proposal'
        : !held ? 'not_retained' : 'input_dependency_changed');
    const nodes = [], roots = [];
    // Each member keeps its actual wishes/effects. Namespaced dependencies
    // enter the group's one purse and one engine, never a second evaluator.
    // A worker member's later view keeps only its usefulness values: the
    // same call that made it builds again asking for the nodes (perf C1).
    const sources = contexts.map((context, i) => context.projection?.nodes ? context.projection
        : forState(selected[i], { ...deps, caller: 'groupContext', withNodes: true }).projection);
    for (let i = 0; i < contexts.length; i++) {
        const source = sources[i];
        const prefix = `${i}:`;
        // The group solve has no stock reader: a member's path with gross
        // inputs only (Task 2 readers) orders what the member does not hold
        // for one batch, and pays its held units at their exit value.
        const held = new Map(source.nodes.map(node => [node.key, node]));
        const missing = path => {
            const requirements = [];
            let ownValue = 0;
            for (const row of path.grossRequirements) {
                const id = row.key.startsWith('item:') ? Number(row.key.slice(5)) : 0;
                const stock = id ? contexts[i].stockFor?.(id, '') || {} : {};
                const { toOrder: order, toExecute } = remainingQuantity({ required: row.amount,
                    freePhysical: positive(stock.owned), acceptedIncoming: positive(stock.incoming) });
                const node = held.get(row.key);
                ownValue += (row.amount - toExecute) * positive(Number.isFinite(node?.exitValue) ? node.exitValue : node?.price);
                if (order > 0) requirements.push({ ...row, amount: order });
            }
            return { requirements, ownInputOpportunityValue: positive(path.ownInputOpportunityValue) + ownValue };
        };
        for (const node of source.nodes) nodes.push({ ...node, key: prefix + node.key,
            paths: (node.paths || []).map(path => {
                const own = path.requirements || !path.grossRequirements ? null : missing(path);
                return { ...path, ...own, ...(path.town ? { tripScope: contexts[i].actorKey } : {}),
                requirements: (own?.requirements || path.requirements || [])
                .map(row => ({ ...row, key: prefix + row.key })),
                ...(path.grossRequirements ? { grossRequirements: path.grossRequirements.map(row => ({ ...row, key: prefix + row.key })) } : {}) };
            }) });
        roots.push(...source.roots.map(key => prefix + key));
    }
    const byKey = new Map(nodes.map(node => [node.key, node]));
    roots.sort((a, b) => positive(byKey.get(b).valueHours) / Math.max(1, positive(byKey.get(b).price))
        - positive(byKey.get(a).valueHours) / Math.max(1, positive(byKey.get(a).price)));
    // MVP-6: the same admission as one member's projection; a root whose
    // union does not fit is pending and the smaller ones still proceed.
    const { roots: admitted, kept } = admitRoots(roots, byKey);
    const network = engine.build({ actorKey, inputKey: key, remembered: false, nodes: nodes.filter(node => kept.has(node.key)), roots: admitted,
        wallet, playedHours: positive(group.playedHours), persona: group.persona || first.persona,
        previous: { focus: group.wishFocus, dormant: group.dormantWishes },
        hourAdena: contexts.reduce((sum, context) => sum + context.hunt.perHour, 0),
        moneyPaths: sources[0].moneyPaths, riskWeight: first.riskWeight });
    const groupHunt = { ...first.hunt, perHour: contexts.reduce((sum, member) => sum + member.hunt.perHour, 0),
        expPerHour: contexts.reduce((sum, member) => sum + member.hunt.expPerHour, 0) };
    const context = { ...first, actorKey, inputKey: key, network, routePending: contexts.some(member => member.routePending), hunt: groupHunt, groupIncomePerHour: groupHunt.perHour,
        moneyPrice: network.moneyPrice,
        hourAdena: network.hourAdena, statsPacket: { wishFocus: network.focus, dormantWishes: network.dormant } };
    context.itemUsefulness = id => contexts.reduce((sum, member) => sum + member.itemUsefulness(id), 0);
    context.worth = id => network.moneyPrice > 0 ? context.itemUsefulness(id) / network.moneyPrice : null;
    if (diagnostic) {
        Diagnostics.count('context_group', 'build');
        Diagnostics.duration('context_group', performance.now() - started);
    }
    if (!proposal) {
        if (diagnostic && !groups.has(actorKey) && groups.size >= GROUP_LIMIT)
            Diagnostics.count('context_group', 'eviction', 'capacity');
        remember(groups, actorKey, { key, ids: contexts.map(member => Number(member.state.characterId)), context }, GROUP_LIMIT);
    }
    return context;
}
function preparedRouteRows(state) {
    const plan = cache.get(`character:${Number(state.characterId)}`)?.plan;
    return plan?.routeKey === Trip.key(state) ? plan.routeRows : null;
}
function forgetGroup(partyId) {
    if (groups.delete(`group:${partyId}`) && Diagnostics.active()) Diagnostics.count('context_group', 'eviction', 'group_release');
}
function forgetContext(id, reason = 'explicit_invalidation', expectedState = null) {
    id = Number(id);
    const key = `character:${id}`;
    if (expectedState && cache.get(key)?.stateRef.deref() !== expectedState) return;
    if (cache.delete(key) && Diagnostics.active()) { Diagnostics.count('context', 'eviction', reason); noteRelease(key, reason); }
    engine.forget(key, reason);
    for (const [groupKey, held] of groups) {
        if (held.ids.includes(id)) {
            groups.delete(groupKey);
            if (Diagnostics.active()) Diagnostics.count('context_group', 'eviction', reason);
        }
    }
}
function forget(id) {
    forgetContext(id);
    invoke('GameServer/Bot/Population/ColdCombatProfile').forgetBuild(id);
}
function reset() {
    if (Diagnostics.active() && cache.size) Diagnostics.count('context', 'eviction', 'reset', cache.size);
    if (Diagnostics.active() && groups.size) Diagnostics.count('context_group', 'eviction', 'reset', groups.size);
    cache.clear(); groups.clear(); engine.clear(); lastKeyHashes.clear(); routeAnchors = new WeakMap();
}
function size() { return { context: cache.size, engine: engine.cache.size, groups: groups.size }; }

module.exports = { size, setPlanningContexts, forState, forActor, forGroup, forgetGroup, basics, stockFor, stateForActor, routeState, preparedRouteRows, inputKey, survivalReserve, forgetContext, forget, reset, configure, registerProvider,
    craftIncome, summary: () => ({ mainColdForState: Diagnostics.active() ? Object.fromEntries(mainColdForState || []) : null }),
    resetCounters: () => { mainColdForState = null; } };
