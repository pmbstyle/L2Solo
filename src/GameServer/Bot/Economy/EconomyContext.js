'use strict';

const ItemIndex = require('../../Item/ItemTemplateIndex');
const Valuation = require('./EconomicValuation');
const Providers = require('./WishProviders');
const { WishNetwork, remember } = require('./WishNetwork');
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
// actorKey -> { key, reads, context } of bots: bounded (WishNetwork.remember).
const cache = new Map();
let planningContexts = 0;
function setPlanningContexts(count) {
    planningContexts = Math.max(0, Math.min(64, Math.floor(Number(count) || 0)));
    while (cache.size > 64 - planningContexts) {
        const key = cache.keys().next().value; cache.delete(key); engine.forget(key, 'planning_capacity');
        if (Diagnostics.active()) Diagnostics.count('context', 'eviction', 'planning_capacity');
    }
}
// Groups apart, so a party composition that weighs many candidate groups
// never evicts the bots' own reviews: `group:<partyId>` -> { key, members,
// context }, removed when the party ends (forgetGroup) and bounded besides;
// a proposed composition (`proposal:` party id) is built and not kept.
const groups = new Map();
const GROUP_LIMIT = 256;
const positive = value => Math.max(0, Number(value) || 0);

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
        row.slot, row.enchant, row.stackable, row.starterMobLootAmount, row.kind, row.rank, (row.instances || []).map(item=>[item.id,item.enchant,item.slot,item.equipped,item.amount].join('/')).join(';')].join(':')).sort().join(',');
    // A native bag change, own sample or relation revision is an input event.
    // No timing poll, no world-wide counter: the board and the market are
    // inputs only through the items the bot read (see `market` in forState).
    return [state.level, stats.classId, items, positive(state.adena), stats.decisionSeq, stats.activityLeaf, stats.visitEvery?.[0], stats.visitEvery?.[1],
        deps.workshop?.recipeId, deps.workshop?.productId, deps.workshop?.incomePerHour, deps.workshop?.cycleHours,
        Providers.recipeIds(state, deps).join(','),
        Number(state.vitals?.mp), positive(deps.buyOrderEscrow),
        Math.floor(positive(stats.frustration) * 10), stats.karma, stats.clanId, state.clanId, state.party?.partyId, state.partyId,
        stats.generatedCold, stats.race, stats.marketSellRetryAfter,
        Number(stats.marketSellRetryAfter || 0) > Number(deps.timestamp || Date.now()),
        invoke('GameServer/Bot/Economy/ItemDisposition').reservationInputKey(state), JSON.stringify(stats.clanMaterialDemand || null),
        state.spotId, stats.huntEfficiency?.[0]?.at, deps.memory?.revision || stats.memoryRevision || 0,
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
function resolved(state, deps) {
    deps = { ...runtime, ...deps };
    if (typeof deps.board === 'function') deps.board = deps.board();
    if (typeof deps.spots === 'function') deps.spots = deps.spots();
    if (typeof deps.memory === 'function') deps.memory = deps.memory(state.characterId);
    if (typeof deps.workshop === 'function') deps.workshop = deps.workshop(state.characterId);
    if (isMainThread && !Object.hasOwn(deps, 'workshop')) deps.workshop = craftIncome(state);
    if (isMainThread && !Object.hasOwn(deps, 'workshops')) {
        const Workshops = require('./CraftWorkshopService');
        deps.workshops = Workshops.publicForRecipe;
        deps.workshopRevision = Workshops.publicRecipeDigest;
    }
    if (isMainThread && !Object.hasOwn(deps, 'knownRecipes')) {
        const Workshops = require('./CraftWorkshopService');
        if (Workshops.bookFor(state.characterId) !== null) deps.knownRecipes = Workshops.cachedRecipes(state.characterId);
    }
    if (typeof deps.buyOrderEscrow === 'function') deps.buyOrderEscrow = deps.buyOrderEscrow(state.characterId);
    if (!deps.spots && isMainThread) deps.spots = invoke('GameServer/Bot/Population/SpotProfiles').ensure();
    if (!deps.npcOffersFor && isMainThread) deps.npcOffersFor = id => {
        const Sources = require('../Population/ColdOccupationSources');
        Sources.initialise(); return Sources.npcOffersFor(id);
    };
    return deps;
}
function personaOf(state, deps) {
    return deps.persona || invoke('GameServer/Bot/AI/BotPersona').of(state) || { traits: {}, understanding: 0.3 };
}
function pricing(state, persona, board, timestamp, deps, read = () => {}) {
    const Belief = invoke('GameServer/Bot/Economy/PriceBelief');
    const prices = new Map();
    const knowledgeEnabled = deps.knowledgeEnabled ?? invoke('GameServer/Bot/AI/KnowledgeLearning').knowledgeEnabled();
    const priceCtx = { characterId: state.characterId, understanding: persona.understanding ?? 0.3,
        marketTrades: state.marketTrades, knowledgeEnabled, board, timestamp };
    return { knowledgeEnabled, price: id => {
        read(id);
        if (!prices.has(Number(id))) {
            const belief = Belief.prior(id, priceCtx);
            prices.set(Number(id), belief ? Math.exp(belief.mu) : 0);
        }
        return prices.get(Number(id));
    } };
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
    const hunt = Hunt.huntIncome(state, timestamp, deps.mode);
    const lostGearHours = hunt.perHour > 0 ? Valuation.pkDropValue(state, price) / hunt.perHour : 0;
    const bestSpotId = hunt.spotId || state.spotId;
    const walkBackHours = require('./WalkBack').hours(bestSpotId, state, deps.spots || invoke('GameServer/Bot/AI/SpotService').spots);
    const deathHours = Valuation.deathHours(state, { ...hunt, lostGearHours, walkBackHours });
    const spotTable = bestSpotId ? Table.value(bestSpotId, tableRole, state.level, true) : null;
    const bestTable = spotTable || Table.best(tableRole, state.level, true);
    const { selfId: shotItemId, perAction: shotPerAction } = invoke('GameServer/Inventory/ShotStock').planForState(state);
    const potionItemId = invoke('GameServer/Bot/AI/HealingPotionStock').purchasePotionFor(state).selfId;
    const rawShots = shotPerAction > 0 ? positive(bestTable?.shots) : 0;
    const withoutShots = bestSpotId ? Table.value(bestSpotId, tableRole, state.level, false) : null;
    const shotBenefit = Math.max(0, 1 - positive(withoutShots?.exp) / Math.max(1, positive(bestTable?.exp)));
    const shotUse = shotBenefit < rawShots * price(shotItemId) / Hunt.huntHour(hunt, state) ? 0 : rawShots;
    const potionUse = positive(bestTable?.potions);
    let bagHours = 2;
    const hasBagForecast = spotTable?.stacks !== null && spotTable?.stacks !== undefined;
    if (hasBagForecast) {
        const Floor = require('../Population/SurvivalFloor'), Data = invoke('GameServer/DataCache');
        const race = state.stats?.race ?? Data.classTemplates?.find(row => Number(row.classId) === Number(state.stats?.classId || 0))?.template?.race;
        // ARCH-NOTE: size the E9 bag interval on the bag after its
        // planned kit stacks exist. Otherwise an empty shot/potion row uses
        // no slot, its refill uses one, and the shorter interval immediately
        // sells part of that refill back to the NPC. Existing stacks retain
        // the exact physical free-slot formula; zero-use stock reserves none.
        const plannedSlots = Number(shotUse > 0 && !positive(state.inventory?.[shotItemId]?.amount))
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
    const Visits = require('./TownVisitInterval');
    // Bag space bounds a planned outing; it never chooses its duration.
    // Keep the existing initial estimate until actual town visits teach one.
    const targetHours = hasBagForecast
        ? Math.min(Visits.targetHours(state.stats), Visits.targetHours({}, bagHours))
        : Visits.targetHours(state.stats);
    // Price future carried scroll uses only if this review needs extra stock.
    // Resolve the known hunt through the existing catalogue index; a merchant
    // location during a town visit is never a future hunting origin.
    let scrollHours;
    const scrollUseHours = () => {
        if (scrollHours !== undefined) return scrollHours;
        scrollHours = 0;
        if (invoke('GameServer/Karma').closesTowns(state.stats?.karma)) return scrollHours;
        const origin = invoke('GameServer/Bot/AI/SpotIndex').spotById(deps.spots, bestSpotId)?.center
            || state.stats?.marketReturn?.loc || (state.activity === 'hunting' ? state.loc : null);
        if (!origin || ![origin.locX, origin.locY, origin.locZ].every(Number.isFinite)
            || origin.locX === 0 && origin.locY === 0) return scrollHours;
        const Trip = require('../Population/ColdTrip'), Routes = require('../Travel/TravelRoutes');
        const destination = Routes.landingTown(origin);
        const routeState = { ...state, loc: origin, inventory: { 736: { amount: 0 } } };
        const walking = Trip.townPlan(routeState, destination);
        const recall = Trip.townPlan({ ...routeState, inventory: { 736: { amount: 1 } } }, destination);
        if (walking && recall && recall.scroll) scrollHours = Math.max(0, walking.durationMs - recall.durationMs) / 3600000;
        return scrollHours;
    };
    const stock = kind => {
        if (kind === 'scrolls') {
            const current = positive(state.inventory?.[736]?.amount),
                target = require('../Travel/ScrollStock').TARGET_AMOUNT, survivalTarget = 1;
            const missing = Math.max(0, target - Math.max(current, survivalTarget));
            const benefitPerUnit = current < target ? scrollUseHours() : 0;
            return { itemId: 736, usePerHour: 0, current, hours: Infinity, targetHours, target,
                survivalTarget, survivalMissing: Math.max(0, survivalTarget - current), missing,
                unitPrice: price(736), benefitPerUnit, benefitHours: missing * benefitPerUnit, needed: current < target };
        }
        const shots = kind === 'shots';
        const itemId = shots ? shotItemId : potionItemId;
        const use = shots ? shotUse : potionUse;
        const current = positive(state.inventory?.[itemId]?.amount);
        const target = Math.max(Math.ceil(use), Math.ceil(use * targetHours));
        // Forecast consumption may be fractional; both purchase tranches use
        // the same whole-unit survival stock so their sum remains executable.
        const survivalTarget = Math.ceil(use);
        const survivalMissing = Math.max(0, survivalTarget - current);
        const missing = Math.max(0, target - Math.max(current, survivalTarget));
        const benefitPerUnit = use > 0
            ? (shots ? shotBenefit : positive(bestTable?.deaths) * deathHours) / use : 0;
        const benefitHours = missing * benefitPerUnit;
        return { itemId: Number(itemId), usePerHour: use, current, hours: use > 0 ? current / use : Infinity,
            targetHours, target, survivalTarget, missing, survivalMissing, unitPrice: price(itemId), benefitPerUnit, benefitHours,
            needed: use > 0 && current < survivalTarget };
    };
    const kit = [stock('shots'), stock('potions')];
    const escapeCost = invoke('GameServer/Karma').closesTowns(state.stats?.karma) ? 0
        : price(736) * Math.max(0, 1 - positive(state.inventory?.[736]?.amount));
    // A known executable quote pays whole missing units once. The personal
    // price estimate still values an unseen option; it must not underfund
    // a concrete merchant's mandatory stock and trigger repeated tiny fills.
    const kitCost = (id, unitPrice = null) => {
        const quoted = Number.isFinite(unitPrice) && unitPrice > 0;
        if (Number(id) === 736 && invoke('GameServer/Karma').closesTowns(state.stats?.karma)) return 0;
        if (Number(id) === 736) return quoted
            ? unitPrice * Math.max(0, 1 - positive(state.inventory?.[736]?.amount)) : escapeCost;
        return kit.filter(row => row.itemId === Number(id)).reduce((sum, row) => sum
            + row.survivalMissing
                * (quoted ? unitPrice : row.unitPrice), 0);
    };
    const reserve = escapeCost + kit.reduce((sum, row) => sum + row.survivalMissing * row.unitPrice, 0);
    return { tableRole, hunt, hourAdena: Hunt.huntHour(hunt, state), survivalReserve: reserve, kitCost,
        lostGearHours, bestSpotId, deathHours, bestTable, stock,
        riskWeight: Valuation.riskWeight(state, persona),
        expectedDeathHours: positive(bestTable?.deaths) * deathHours,
        karmaHours: Valuation.karmaHours(state, { ...hunt, lostGearHours, deathsPerHour: positive(bestTable?.deaths) }) };
}
function basics(state = {}, deps = {}) {
    deps = resolved(state, deps);
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
    if (!deps.routeRows && held?.context.routeKey === Trip.key(state)) deps.routeRows = held.context.routeRows;
    const key = inputKey(state, { ...deps, timestamp });
    if (held?.key === key && (isMainThread || held.context.state === state)
        && marketHolds(sourceBoard, held.reads, deps)) {
        if (deps.onSourceRead) for (const id of held.reads.keys()) deps.onSourceRead(id);
        if (diagnostic) Diagnostics.count('context', 'hit', 'same_inputs');
        return remember(cache, actorKey, held).context;
    }
    const started = diagnostic ? performance.now() : 0;
    // Identity replacement is the worker's technical safety backstop, not an
    // economic event. An input-key mismatch is named as a dependency change;
    // it does not claim which historical event caused it.
    const diagnosticReason = !diagnostic ? null : !held ? 'not_retained' : held.key !== key
        ? 'input_dependency_changed' : !isMainThread && held.context.state !== state ? 'state_publication' : 'used_market_changed';
    if (diagnostic) Diagnostics.count('context', 'miss', diagnosticReason);
    const reads = new Map();
    let building = true;
    const read = id => { id = Number(id); if (!reads.has(id)) {
        reads.set(id, marketToken(sourceBoard, id, deps)); deps.onSourceRead?.(id);
    } };
    const watch = id => { if (building) read(id); };
    const Data = invoke('GameServer/DataCache');
    const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
    const Table = invoke('GameServer/Bot/AI/SpotValueTable');
    const persona = personaOf(state, deps);
    const board = watchedBoard(sourceBoard, watch);
    // A price is remembered, so every price read counts, also a late one
    // through context.price: its item joins the review's inputs.
    const { price, knowledgeEnabled } = pricing(state, persona, board, timestamp, deps, read);
    const base = foundation(state, deps, persona, timestamp, price);
    const buyback = id => invoke('GameServer/Items/NpcSellRules')
        .npcBuyPrice(Number(ItemIndex.find(Data.items, id)?.template?.price || 0));
    const own = Hunt.sampledRows(state, timestamp, deps.mode);
    const calibrations = own.flatMap(row => {
        const value = Table.value(row.spotId, base.tableRole, state.level, true);
        return value?.exp > 0 ? [Math.max(0, row.exp) / row.cycleMs * 3600000 / value.exp] : [];
    });
    const calibration = calibrations.length ? calibrations.reduce((sum, value) => sum + value, 0) / calibrations.length : 1;
    const Tendency = require('../AI/TendencyRoll');
    const context = { inputKey: key, actorKey, state, timestamp, persona, board, hunt: base.hunt, price, buyback, calibration,
        riskWeight: base.riskWeight, bestSpotId: base.bestSpotId, deathHours: base.deathHours, lostGearHours: base.lostGearHours,
        karmaHours: base.karmaHours, expectedDeathHours: base.expectedDeathHours, stock: base.stock,
        survivalReserve: base.survivalReserve, kitCost: base.kitCost, hourAdena: base.hourAdena };
    const workshop = Object.hasOwn(deps, 'workshop') ? deps.workshop : isMainThread
        ? craftIncome(state, { hourAdena: base.hourAdena, worth: price, timestamp }) : null;
    context.workshop = workshop || { recipeId: 0, productId: 0, incomePerHour: NaN, cycleHours: NaN };
    const productive = workshop?.known !== false && workshop?.incomePerHour > 0 && Number.isFinite(workshop.incomePerHour)
        && workshop.cycleHours > 0 && Number.isFinite(workshop.cycleHours);
    if (productive) { watch(workshop.productId); context.hourAdena = Math.max(context.hourAdena, workshop.incomePerHour); }
    context.routeKey = Trip.key(state); context.routeRows = Array.isArray(deps.routeRows) && deps.routeRows.length === Trip.towns.length ? deps.routeRows : null;
    context.routePending = !deps.tripCost && !context.routeRows;
    context.trip = deps.tripCost || Trip.preparedReader(context.routeRows || [], { hourAdena: context.hourAdena });
    context.spotValue = require('./SpotEconomics').create(state, { ...deps, timestamp, persona, deathHours: context.deathHours });
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
        return context;
    }
    const extra = [...extensions.values()].flatMap(provider => provider(state, context) || []);
    const projection = Providers.build(state, context, { ...deps, nodes: [...(deps.nodes || []), ...extra] });
    if (productive) projection.moneyPaths.push({ activity: 'crafting', kind: 'production', recipeId: workshop.recipeId,
        object: workshop.productId, incomePerHour: workshop.incomePerHour,
        cycleHours: workshop.cycleHours, repeatable: true });
    const networkKey = `${key}#${marketKey(reads)}`;
    const network = engine.build({ actorKey, inputKey: networkKey, ...projection,
        remembered: deps.rememberContext !== false,
        stockFor: (id, rootKey) => ({ owned: rootKey.startsWith('stock:') && projection.nodes.find(node => node.key === rootKey)?.object?.itemId === id
            ? positive(state.inventory?.[id]?.amount) : require('./WealthCraftDecision').freeAmount(state, state.inventory?.[id] || {}),
        incoming: positive(state.acceptedIncoming?.[id]) }),
        characterId: state.characterId, decisionSeq: state.stats?.decisionSeq, activityLeaf: state.stats?.activityLeaf,
        wallet: positive(state.adena) + positive(deps.buyOrderEscrow), survivalReserve: base.survivalReserve,
        playedHours: positive(state.stats?.playedHours), persona,
        previous: { focus: state.stats?.wishFocus, dormant: state.stats?.dormantWishes },
        hourAdena: context.hourAdena, riskWeight: context.riskWeight,
        caller: deps.caller || 'economy_context', trigger: deps.trigger || diagnosticReason || 'context_build' });
    context.inputKey = networkKey;
    context.horizonHours = projection.horizon;
    context.projection = projection;
    context.network = network;
    context.moneyPrice = network.moneyPrice;
    context.hourAdena = network.hourAdena;
    // Affordability removes a funding gap, not the benefit lost while waiting.
    const urgent = network.gap || network.queue.find(row => row.key === network.focus?.[0]) || network.queue[0];
    context.gapHorizonHours = !urgent ? 0 : urgent.key === 'stock:shots' ? base.stock('shots').targetHours
        : urgent.key === 'stock:potions' ? base.stock('potions').targetHours : projection.horizon;
    context.itemUsefulness = id => (network.demands.get(`item:${id}`) || projection.values.get(Number(id)) || 0)
        * (knowledgeEnabled ? 1 + (1 - Number(persona.understanding ?? 0.3))
            * (2 * Tendency.roll('usefulness', state.characterId, id) - 1) : 1);
    context.worth = id => network.moneyPrice > 0 ? context.itemUsefulness(id) / network.moneyPrice : null;
    context.watchList = require('./TradeIntent').project(state, network, projection, id => context.worth(id) ?? price(id));
    context.intentPending = context.watchList === null;
    context.watchList ||= [];
    const Funding = require('./PurchaseFunding');
    context.statsPacket = { wishFocus: network.focus, dormantWishes: network.dormant,
        decisionSeq: network.decisionSeq, activityLeaf: network.activityLeaf,
        money: Funding.packetFor(network, context.hourAdena, base.survivalReserve) };
    context.purchaseBudget = id => {
        const wish = network.queue.find(row => Number(row.object?.itemId) === Number(id));
        return Funding.spendable({ ...state, stats: { ...state.stats, money: context.statsPacket.money } }, 0,
            { itemId: id, ...(wish ? { r: Funding.significant(wish.ratio) } : {}), survivalCost: base.kitCost(id) });
    };
    building = false;

    if (diagnostic) {
        Diagnostics.count('context', 'build', diagnosticReason);
        Diagnostics.duration('context', performance.now() - started);
    }
    if (diagnostic && Diagnostics.enabled(state.characterId)) Diagnostics.push({ owner: state.characterId,
        caller: deps.caller || 'economy_context', trigger: deps.trigger || diagnosticReason,
        phase: 'wish_context', reason: diagnosticReason, inputHash: fnv1a32(networkKey),
        decisionSeq: network.decisionSeq, activityLeaf: network.activityLeaf,
        revision: state.simulation?.revision, wallet: positive(state.adena), escrow: positive(deps.buyOrderEscrow),
        available: network.available, reserve: base.survivalReserve, wishKey: network.focus?.[0] });
    if (deps.rememberContext !== false && planningContexts < 64) {
        if (diagnostic && !cache.has(actorKey) && cache.size >= 64 - planningContexts)
            Diagnostics.count('context', 'eviction', 'capacity');
        remember(cache, actorKey, { key, reads, context }, 64 - planningContexts);
    }
    return context;
}
function survivalReserve(state = {}) {
    return Array.isArray(state.stats?.money) ? positive(state.stats.money[2]) : basics(state).survivalReserve;
}
function forActor(actor, session, deps = {}) { return forState(stateForActor(actor, session), deps); }
function craftIncome(state, { hourAdena, worth, timestamp = Date.now() } = {}) {
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
        || prepared.some((context, i) => !context?.projection || context.state !== selected[i])))
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
    // A member rebuilt on a late price read keeps its network key; the held
    // group copies its first member, so it is valid only with the same members.
    if (held?.key === key && held.members.every((member, i) => member === contexts[i])) {
        if (diagnostic) Diagnostics.count('context_group', 'hit', 'same_members');
        return remember(groups, actorKey, held, GROUP_LIMIT).context;
    }
    const started = diagnostic ? performance.now() : 0;
    if (diagnostic) Diagnostics.count('context_group', 'miss', proposal ? 'uncached_proposal'
        : !held ? 'not_retained' : held.key !== key ? 'input_dependency_changed' : 'member_publication');
    const nodes = [], roots = [];
    // Each member keeps its actual wishes/effects. Namespaced dependencies
    // enter the group's one purse and one engine, never a second evaluator.
    for (let i = 0; i < contexts.length; i++) {
        const source = contexts[i].projection;
        const prefix = `${i}:`;
        for (const node of source.nodes) nodes.push({ ...node, key: prefix + node.key,
            paths: (node.paths || []).map(path => ({ ...path, ...(path.quoted ? { tripScope: contexts[i].actorKey } : {}), requirements: (path.requirements || [])
                .map(row => ({ ...row, key: prefix + row.key })) })) });
        roots.push(...source.roots.map(key => prefix + key));
    }
    const byKey = new Map(nodes.map(node => [node.key, node]));
    roots.sort((a, b) => positive(byKey.get(b).valueHours) / Math.max(1, positive(byKey.get(b).price))
        - positive(byKey.get(a).valueHours) / Math.max(1, positive(byKey.get(a).price)));
    roots.length = Math.min(12, roots.length);
    const collect = () => { const seen = new Set(); const visit = key => { if (seen.has(key)) return;
        seen.add(key); for (const path of byKey.get(key)?.paths || []) for (const row of path.requirements || []) visit(row.key); };
        roots.forEach(visit); return seen; };
    let kept = collect();
    while (kept.size > 40 && roots.length) { roots.pop(); kept = collect(); }
    const network = engine.build({ actorKey, inputKey: key, remembered: false, nodes: nodes.filter(node => kept.has(node.key)), roots,
        wallet, playedHours: positive(group.playedHours), persona: group.persona || first.persona,
        previous: { focus: group.wishFocus, dormant: group.dormantWishes },
        hourAdena: contexts.reduce((sum, context) => sum + context.hunt.perHour, 0),
        moneyPaths: first.projection.moneyPaths, riskWeight: first.riskWeight });
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
        remember(groups, actorKey, { key, members: contexts, context }, GROUP_LIMIT);
    }
    return context;
}
function preparedRouteRows(state) {
    const context = cache.get(`character:${Number(state.characterId)}`)?.context;
    return context?.routeKey === Trip.key(state) ? context.routeRows : null;
}
function forgetGroup(partyId) {
    if (groups.delete(`group:${partyId}`) && Diagnostics.active()) Diagnostics.count('context_group', 'eviction', 'group_release');
}
function forgetContext(id, reason = 'explicit_invalidation', expectedState = null) {
    id = Number(id);
    const key = `character:${id}`;
    if (expectedState && cache.get(key)?.context.state !== expectedState) return;
    if (cache.delete(key) && Diagnostics.active()) Diagnostics.count('context', 'eviction', reason);
    engine.forget(key, reason);
    for (const [groupKey, held] of groups) {
        if (held.members.some(member => Number(member.state.characterId) === id)) {
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
    cache.clear(); groups.clear(); engine.clear(); routeAnchors = new WeakMap();
}
function size() { return { context: cache.size, engine: engine.cache.size, groups: groups.size }; }

module.exports = { size, setPlanningContexts, forState, forActor, forGroup, forgetGroup, basics, stockFor, stateForActor, routeState, preparedRouteRows, inputKey, survivalReserve, forgetContext, forget, reset, configure, registerProvider,
    craftIncome, summary: () => ({ mainColdForState: Diagnostics.active() ? Object.fromEntries(mainColdForState || []) : null }),
    resetCounters: () => { mainColdForState = null; } };
