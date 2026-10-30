const ClanMembershipPolicy = require('../../Clan/ClanMembershipPolicy');
const LifeStateCache = require('./LifeStateCache');
const CharacterLocationRuntime = require('../../World/CharacterLocationRuntime');
const RefreshPartyMemberships = require('../../World/PartyMembershipPublication');
const ShopPlaces = require('../Economy/ShopPlaces');
const { isMainThread } = require('node:worker_threads');
const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');
const Database = invoke('Database');
const { CLIENT_VISIBILITY_RADIUS } = invoke('GameServer/World/WorldConstants');
const Metrics  = invoke('GameServer/Bot/Population/PopulationMetrics');
const DataCache = invoke('GameServer/DataCache');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const Consumption = require('../Economy/ConsumptionDiagnostics');
const Diagnostics = require('../Economy/EconomyDiagnostics');
const DecisionEvents = require('../AI/DecisionEvents');
const DecisionSections = require('../Economy/DecisionSections');
const PartyRequestPlanner = invoke('GameServer/Bot/Population/PartyRequestPlanner');
const CraftShopService = invoke('GameServer/Bot/Economy/CraftShopService');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const BotEnemyMemory = invoke('GameServer/Bot/AI/BotEnemyMemory');
const MerchantStoreConfigs = invoke('GameServer/Bot/MerchantStoreConfigs');
const { WorkerCommandAdmissionRefusal, checkWorkerCommandAdmission } = require('./WorkerCommandAdmission');
const NativeWriteCheckpoint = require('./NativeWriteCheckpoint');
const Uptime = require('./Uptime');
const EconomyCommit = require('../Economy/EconomyCommit');
const SavedStats = require('../SavedStats');

const TABLE = 'bot_life_state';
const BotClassProgression = invoke('GameServer/Bot/BotClassProgression');
const BotRoles = invoke('GameServer/Bot/AI/BotRoles');
const BotEquipmentCompatibility = invoke('GameServer/Bot/AI/BotEquipmentCompatibility');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const ColdCombatProfile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const InventorySummary = invoke('GameServer/Bot/Population/InventorySummary');
const SpotRiskPolicy = invoke('GameServer/Bot/Population/SpotRiskPolicy');
const WorldAreaCatalog = invoke('GameServer/World/WorldAreaCatalog');
const ProgressionCap = invoke('GameServer/Progression/ProgressionCap');
const workerProjectorRole = CharacterLocationRuntime.workerProjectorRole();
const cache = new LifeStateCache({ locationIndex: CharacterLocationRuntime.index, workerProjectorRole });
const marketCounts = new Map();

function recentLimit(limit) {
    return Math.max(1, Math.min(2000, Number(limit) || 500));
}
const pendingWrites = new Map();
const changeListeners = new Set();
const marketReviewListeners = new Set();
// Pending ids only: each initial/new cold cache entry is examined once.
const classMigrationCandidates = new Map();
const classMigrationListeners = new Set();
function notifyClassMigrationPending() {
    for (const listener of classMigrationListeners) listener(classMigrationCandidates.size);
}
cache.subscribePublications(({ characterId, state, previousState }) => {
    if (workerProjectorRole) return;
    const id = Number(characterId);
    if (state?.phase !== 'cold') {
        if (classMigrationCandidates.delete(id)) notifyClassMigrationPending();
        return;
    }
    if (previousState?.phase === 'cold') return;
    if (classProgressionNeeded(state, Number(state.stats?.classId || 0), Number(state.level || 1))) {
        classMigrationCandidates.set(id, Number(state.updatedAt || 0));
        notifyClassMigrationPending();
    }
});
let initialized = false;
let initStarted = false;
let initPromise = null;

function notifyMarketReviewState(state, previous) {
    if (!state?.characterId) return;
    const left = previous?.simulation || {};
    const right = state.simulation || {};
    if (previous?.phase === state.phase && left.revision === right.revision) return;
    for (const listener of marketReviewListeners) {
        try { listener(state.characterId); }
        catch (error) { utils.infoWarn('BotLife', 'market lifecycle listener failed: %s', error.message); }
    }
}

function isCriticalSnapshotReason(reason = '', state = null) {
    if (state?.activity === 'dead') return true;
    return /death|dead|loot|drop|adena|inventory|market|trade|economy|shop|warehouse|sell|buy|purchase|equip|equipment|handoff|revive|resurrect/i.test(String(reason));
}

function notifyColdSnapshot(state, reason = 'state_changed', options = {}) {
    invoke('GameServer/Clan/ClanService').syncColdMember(state);
    changeListeners.forEach((listener) => {
        try {
            listener(state, reason);
        } catch (error) {
            utils.infoWarn('BotLife', 'state change listener failed: %s', error.message);
        }
    });
    if (!state?.characterId || state.phase !== 'cold') return;
    const critical = options.critical === true || isCriticalSnapshotReason(reason, state);
    const handle = setImmediate(() => {
        try {
            const coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
            coordinator.markDirty?.(state, { reason, critical });
        } catch (_) {
            // The coordinator may not be loaded during the first state-table
            // hydration pass. The next worker bootstrap snapshot is complete.
        }
    });
    handle.unref?.();
}

// A near bot's body moved a fact (reason: bag, equip, level, death, revive,
// near_spot, activated): its row goes to its slot in the worker, whose one fact
// function decides whether that is an event. A delivery, not a save: neither
// the cache nor the database is written. The row is built on the next turn, so
// it reads the body after the change; several changes in one turn stay one
// queue entry per bot. The far poster's gate above stays for far bots.
function notifyNearFacts(session, reason) {
    if (!session?.accountId?.startsWith?.('bot_') || session.arenaEphemeral === true) return;
    // Ownership is persisted before enterWorld finishes. That provisional
    // body must not look like a changed kit to the occupation planner.
    if (session.populationActivating === true) return;
    const handle = setImmediate(() => {
        try {
            const actor = session.actor;
            if (!actor || session.populationActivating === true) return;
            const current = cache.get(Number(actor.fetchId()));
            if (current?.phase !== 'hot') return;
            const row = mergeSessionIntoLifeState(session, session.coldLifeState || current, 'hot', reason,
                { physicalLocation: true });
            // The cached row owns the revision (the handoff moved it);
            // session.coldLifeState may lag it.
            row.simulation = current.simulation;
            // The spot the bot was given, as a far traveler counts at its
            // travel spot; loc stays physical.
            row.spotId = session.currentSpot?.id ?? row.spotId;
            row.updatedAt = now();
            // Not saved: the number of this post and the raise it carries.
            session.nearSeq = Number(session.nearSeq || 0) + 1;
            row.nearSeq = session.nearSeq;
            if (session.nearRaise) row.raise = { ...session.nearRaise };
            // lazy: cycle the coordinator requires this module at its top.
            invoke('GameServer/Bot/Population/ColdSimulationCoordinator').markDirty(row,
                { reason, critical: isCriticalSnapshotReason(reason, row) || !!row.raise, near: true });
        } catch (error) {
            utils.infoWarn('BotLife', 'near fact %s post failed: %s', reason, error.message);
        }
    });
    handle.unref?.();
}

function now() {
    return Date.now();
}

function hasStaleRateModelPlan(state) {
    const plan = state?.stats?.equipmentPlan;
    return state?.activity === 'hunting'
        && plan?.status === 'active'
        && plan?.expectedKills !== null
        && plan?.expectedKills !== undefined
        && Number(plan.rateModelVersion || 0) < GearAcquisitionPlanner.RATE_MODEL_VERSION;
}

function safeJson(value) {
    return JSON.stringify(value || {});
}

function parseJson(raw, fallback = {}) {
    if (!raw) return fallback;
    try {
        return JSON.parse(raw);
    } catch (err) {
        return fallback;
    }
}

function actorLocation(actor) {
    return {
        locX: actor.fetchLocX(),
        locY: actor.fetchLocY(),
        locZ: actor.fetchLocZ()
    };
}

function actorVitals(actor) {
    return {
        hp: actor.fetchHp(),
        maxHp: actor.fetchMaxHp(),
        mp: actor.fetchMp(),
        maxMp: actor.fetchMaxMp()
    };
}

function levelBand(level) {
    const value = Number(level || 1);
    return `${Math.max(1, value - 2)}-${value + 2}`;
}

function targetLevelBandForSession(session, level) {
    if (session.newbieAnchor) return `1-${Config.newbieAnchorMaxLevel}`;
    return levelBand(level);
}

function itemTemplate(selfId) {
    return ItemTemplateIndex.find(DataCache.items, selfId) || null;
}

function itemName(selfId, fallback = '') {
    return itemTemplate(selfId)?.template?.name || fallback || `Item ${selfId}`;
}

function itemStackable(selfId, item = {}) {
    const template = itemTemplate(selfId);
    if (template) return template.etc?.stackable === true;
    if (typeof item.fetchStackable === 'function') return !!item.fetchStackable();
    return item.stackable === true;
}

function normalizeInventoryStackability(inventory = {}) {
    const normalizedInventory = Object.fromEntries(Object.entries(inventory || {}).map(([key, item]) => {
        if (!item) return [key, item];
        const selfId = Number(item?.selfId || key);
        const normalized = { ...(item || {}), stackable: itemStackable(selfId, item) };
        // A formerly non-stackable type (dyes, recipes) now has one physical
        // stack. Old per-copy identities must not keep counting as bag slots.
        if (normalized.stackable) delete normalized.instances;
        return [key, normalized];
    }));
    // Repair legacy flags before completion can expand a count into copies.
    return InventorySummary.canonicalize(normalizedInventory);
}

function inventorySummaryFromItems(items = []) {
    return items.reduce((summary, item) => {
        const selfId = Number(item.fetchSelfId ? item.fetchSelfId() : item.selfId);
        const amount = Number(item.fetchAmount ? item.fetchAmount() : item.amount || 0);
        if (!selfId || amount <= 0) return summary;

        const key = String(selfId);
        const stackable = itemStackable(selfId, item);
        const equipped = !!(item.fetchEquipped ? item.fetchEquipped() : item.equipped);
        const slot = Number(item.fetchSlot ? item.fetchSlot() : item.slot || 0);
        const currentEnchant = Number(item.fetchEnchantLevel ? item.fetchEnchantLevel() : item.enchant || 0) || 0;
        if (!stackable) {
            const current = summary[key];
            const instances = [
                ...(current?.instances || []),
                {
                    id: Number(item.fetchId ? item.fetchId() : item.id) || null,
                    amount,
                    enchant: currentEnchant,
                    equipped,
                    slot
                }
            ];
            const equippedSlots = [...new Set(instances
                .filter((instance) => instance.equipped && Number(instance.slot) > 0)
                .map((instance) => Number(instance.slot)))].sort((a, b) => a - b);
            const enchantValues = [...new Set(instances.map((instance) => Number(instance.enchant) || 0))];
            summary[key] = {
                selfId,
                name: item.fetchName ? item.fetchName() : item.name || itemName(selfId),
                amount: instances.reduce((total, instance) => total + Number(instance.amount || 0), 0),
                equipped: equippedSlots.length > 0,
                equippedCount: equippedSlots.length,
                equippedSlots,
                stackable: false,
                slot: Number(current?.slot || slot),
                rank: item.fetchRank ? item.fetchRank() : item.rank || itemTemplate(selfId)?.etc?.rank || 'none',
                kind: item.fetchKind ? item.fetchKind() : item.kind || itemTemplate(selfId)?.template?.kind || '',
                enchant: enchantValues.length === 1 ? enchantValues[0] : null,
                instances
            };
            return summary;
        }

        const equippedSlots = [...new Set([
            ...(summary[key]?.equippedSlots || []),
            ...(equipped && slot > 0 ? [slot] : [])
        ])].sort((a, b) => a - b);
        const previousEnchant = summary[key]?.enchant;
        const enchant = previousEnchant === null || previousEnchant === undefined
            ? (summary[key] ? null : currentEnchant)
            : Number(previousEnchant) === currentEnchant ? currentEnchant : null;
        summary[key] = {
            selfId,
            name: item.fetchName ? item.fetchName() : item.name || itemName(selfId),
            amount: Number(summary[key]?.amount || 0) + amount,
            equipped: equippedSlots.length > 0,
            equippedCount: equippedSlots.length,
            equippedSlots,
            stackable: true,
            slot: Number(summary[key]?.slot || slot),
            rank: item.fetchRank ? item.fetchRank() : item.rank || itemTemplate(selfId)?.etc?.rank || 'none',
            kind: item.fetchKind ? item.fetchKind() : item.kind || itemTemplate(selfId)?.template?.kind || '',
            enchant
        };
        return summary;
    }, {});
}

function equipmentSummaryFromInventory(inventory = {}) {
    return Object.values(inventory)
        .flatMap((item) => GearAcquisitionPlanner.equippedSlotsFor(item, item.slot).map((slot) => ({
            selfId: Number(item.selfId),
            name: item.name || itemName(item.selfId),
            slot,
            rank: item.rank || 'none',
            kind: item.kind || '',
            enchant: Number((item.instances || []).find((instance) => (
                instance?.equipped && Number(instance.slot) === Number(slot)
            ))?.enchant ?? item.enchant ?? 0) || 0
        })))
        .sort((a, b) => a.slot - b.slot || a.selfId - b.selfId);
}

// The bag a bot physically holds, as its state: summary, Adena and worn gear
// rebuilt strictly from the item rows (an entry with no row drops out).
function inventoryStateFromItems(state, items = []) {
    const inventory = inventorySummaryFromItems(items || []);
    return {
        ...state,
        adena: inventoryAdena(inventory),
        inventory,
        stats: {
            ...(state.stats || {}),
            equipment: equipmentSummaryFromInventory(inventory)
        }
    };
}

function equipmentTargetFulfilled(stats = {}, inventory = {}) {
    const target = stats.equipmentPlan?.target;
    const selfId = Number(target?.selfId || 0);
    const slot = Number(target?.slot || 0);
    if (selfId <= 0 || slot <= 0) return false;
    const combineResultId = Number(stats.equipmentPlan?.combine?.resultId || 0);
    if (combineResultId > 0 && selfId !== combineResultId) return false;
    const item = inventory[String(selfId)];
    const equippedSlots = GearAcquisitionPlanner.equippedSlotsFor(item || {}, item?.slot);
    return !!item?.equipped
        && equippedSlots.some((equippedSlot) => (
            equippedSlot === slot
            || [7, 14].includes(equippedSlot) && [7, 14].includes(slot)
        ));
}

function reconcileFulfilledEquipmentPlan(state = {}) {
    const progress = invoke('GameServer/Bot/AI/EquipmentAcquisitionProgress');
    const plan = state.stats?.equipmentPlan;
    if (plan?.clanGoal?.goalKey && progress.componentAcquired(state, plan)) {
        state = { ...state, stats: { ...state.stats, clanEquipmentAcquisition: {
            goalKey: plan.clanGoal.goalKey, itemId: Number(plan.target.selfId),
            ...progress.componentRequirement(plan)
        } } };
    }
    if (!equipmentTargetFulfilled(state.stats, state.inventory)) return state;
    const stats = { ...(state.stats || {}) };
    if (Number(stats.marketWanted?.itemId || 0) === Number(plan?.target?.selfId || 0)) {
        stats.marketWanted = null;
        stats.marketRetryAfter = null;
        stats.marketLead = null;
    }
    delete stats.equipmentPlan;
    delete stats.partyRequest;
    delete stats.clanPartyObjective;
    return { ...state, stats };
}

function reconcileEquipmentInventory(state = {}) {
    const inventory = GearAcquisitionPlanner.equipInventoryUpgrades(state, state.inventory || {});
    return reconcileFulfilledEquipmentPlan({
        ...state,
        inventory,
        stats: {
            ...(state.stats || {}),
            equipment: equipmentSummaryFromInventory(inventory)
        }
    });
}

function preserveClanOwnedEquipmentState(incoming = {}, reason = '', current = null) {
    const authoritative = current || cache.get(Number(incoming.characterId)) || null;
    const currentPlan = authoritative?.stats?.equipmentPlan;
    if (!GearAcquisitionPlanner.clanGoalPlanLocked(authoritative || {}, currentPlan)) return incoming;
    if (['clan_equipment_goal', 'clan_equipment_beneficiary_rotated'].includes(String(reason))) return incoming;
    if (equipmentTargetFulfilled(authoritative.stats || {}, incoming.inventory || {})) return incoming;

    const currentGoalKey = String(currentPlan?.clanGoal?.goalKey || '');
    const incomingGoalKey = String(incoming?.stats?.equipmentPlan?.clanGoal?.goalKey || '');
    if (currentGoalKey && incomingGoalKey === currentGoalKey) return incoming;

    const stats = {
        ...(incoming.stats || {}),
        equipmentPlan: currentPlan
    };
    const currentObjective = authoritative.stats?.clanPartyObjective;
    if (!stats.clanPartyObjective
        && String(currentObjective?.clanGoalKey || '') === currentGoalKey) {
        stats.clanPartyObjective = currentObjective;
    }
    return { ...incoming, stats };
}

function equipmentCompletionSignal(state = {}) {
    const clanGoal = state.stats?.equipmentPlan?.clanGoal;
    if (!clanGoal?.clanId || !clanGoal?.goalKey) return null;
    if (!equipmentTargetFulfilled(state.stats, state.inventory)
        && !invoke('GameServer/Bot/AI/EquipmentAcquisitionProgress').componentAcquired(state)) return null;
    return {
        clanId: Number(clanGoal.clanId),
        goalKey: String(clanGoal.goalKey)
    };
}

// Equipment-advance keys this process has seen enqueued. A clan action key
// stays taken for good, live or finished (Database.enqueueClanAction), so a
// repeat of the same signal on every commit or save would only re-read it.
// A restart or the bound below costs one idempotent read per key. A world
// load is always a process restart (the launcher loads saves only while the
// server is stopped), so a key here never outlives its database.
const ENQUEUED_ADVANCE_LIMIT = 4096;
// A far bot counts as overdue (coldDue) past this: a step takes 2-5 s from
// its due time to its commit on main (user 2026-10-20).
const COLD_OVERDUE_MS = 10000;
const enqueuedAdvanceKeys = new Set();

function enqueueEquipmentGoalAdvance(signal) {
    if (!signal?.clanId || !signal.goalKey) return Promise.resolve(null);
    const actionKey = `clan:${signal.clanId}:equipment-advance:${signal.goalKey}`;
    if (enqueuedAdvanceKeys.has(actionKey)) {
        if (Diagnostics.active()) Diagnostics.count('clan_action', 'skip', 'equipment_advance_enqueued');
        return Promise.resolve(null);
    }
    return Database.enqueueClanAction({
        clanId: signal.clanId,
        actionKey,
        actionType: 'goal_plan',
        priority: 100,
        payload: {
            reason: 'equipment_goal_completed',
            goalKey: signal.goalKey
        }
    }).then((result) => {
        if (result?.ok) {
            if (enqueuedAdvanceKeys.size >= ENQUEUED_ADVANCE_LIMIT) enqueuedAdvanceKeys.clear();
            enqueuedAdvanceKeys.add(actionKey);
        }
        return result;
    }).catch((error) => {
        utils.infoWarn('BotLife', 'failed to enqueue clan equipment advance for %s: %s', signal.goalKey, error.message || error);
        return null;
    });
}

function enqueueEquipmentGoalAdvanceForState(state = {}) {
    return enqueueEquipmentGoalAdvance(equipmentCompletionSignal(state));
}

function hasEquippedTwoHandedWeapon(state = {}) {
    return Object.values(state.inventory || {}).some((item) => {
        const template = itemTemplate(item?.selfId);
        return Number(template?.etc?.slot || item?.slot || 0) === 14
            && String(template?.template?.kind || item?.kind || '').startsWith('Weapon.')
            && GearAcquisitionPlanner.equippedSlotsFor(item, item.slot).includes(14);
    });
}

function hasIncompatibleShield(state = {}) {
    const classId = Number(state.stats?.classId || 0);
    const role = state.stats?.role || BotRoles.inferRole({ classId, characterId: state.characterId });
    const twoHanded = hasEquippedTwoHandedWeapon(state);
    const incompatiblePlan = Number(state.stats?.equipmentPlan?.target?.slot || 0) === 8 && twoHanded;
    const incompatibleEquippedShield = Object.values(state.inventory || {}).some((item) => (
        Number(itemTemplate(item?.selfId)?.etc?.slot || item?.slot || 0) === 8
        && GearAcquisitionPlanner.equippedSlotsFor(item, item.slot).includes(8)
        && (!BotEquipmentCompatibility.usesShield(role, classId) || twoHanded)
    ));
    return incompatiblePlan || incompatibleEquippedShield;
}

function hasConflictingWeapons(state = {}) {
    let weapons = 0;
    for (const item of Object.values(state.inventory || {})) {
        const template = itemTemplate(item?.selfId);
        if (!String(template?.template?.kind || item?.kind || '').startsWith('Weapon.')) continue;
        weapons += GearAcquisitionPlanner.equippedSlotsFor(item, template?.etc?.slot || item.slot)
            .filter((slot) => slot === 7 || slot === 14).length;
        if (weapons > 1) return true;
    }
    return false;
}

function reconcileIncompatibleShieldState(state = {}) {
    const reconciledEquipment = reconcileEquipmentInventory(state);
    const stats = { ...(reconciledEquipment.stats || {}) };
    if (Number(stats.equipmentPlan?.target?.slot || 0) === 8
        && hasEquippedTwoHandedWeapon(reconciledEquipment)) {
        delete stats.equipmentPlan;
        delete stats.partyRequest;
    }
    return { ...reconciledEquipment, stats };
}

function inventoryAdena(inventory) {
    return Number(inventory?.[57]?.amount || inventory?.['57']?.amount || 0);
}

function marketPurchaseBlocker(state = {}, offer = {}, qty = 1) {
    const selfId = Number(offer?.selfId || 0);
    const warBlocker = require('./PartyMarketBreak').warSupplyPurchaseBlocker(state, selfId);
    if (warBlocker) return warBlocker;
    const count = Number(qty);
    const template = itemTemplate(selfId);
    if (!template || !Number.isSafeInteger(count) || count <= 0) return null;
    const slot = Number(template.etc?.slot || 0);
    if (slot <= 0) return null;

    const combinationAmount = (state.stats?.equipmentPlan?.combine?.requirements || [])
        .filter((requirement) => Number(requirement.selfId) === selfId)
        .reduce((sum, requirement) => sum + Number(requirement.amount || 0), 0);
    const crystalInput = invoke('GameServer/Bot/Economy/BotCrystallization').inputAmount(state, selfId);
    const crystalWorn = crystalInput ? GearAcquisitionPlanner.equippedSlotsFor(state.inventory?.[String(selfId)] || {}, slot).length : 0;
    const capacity = Math.max([1, 2, 4, 5].includes(slot) ? 2 : 1, combinationAmount, crystalInput + crystalWorn);
    const owned = Math.max(0, Number(state.inventory?.[String(selfId)]?.amount || 0));
    if (owned + count > capacity) return 'already_owned';
    const loadout = template.etc?.rank === 'c' && Number(state.level) < 40
        ? invoke('GameServer/Bot/AI/PersonalGearProgression').preparation(state) || state : state;
    if (!crystalInput && slot === 8 && hasEquippedTwoHandedWeapon(loadout)) return 'incompatible_loadout';
    return null;
}

function refreshCraftShop(state = {}) {
    if (!state.stats?.craftShop) return state;
    const craftShop = CraftShopService.profileFor(state);
    return {
        ...state,
        loc: { ...(craftShop.loc || state.loc || {}) },
        stats: { ...(state.stats || {}), craftStationId: craftShop.stationId, craftShop }
    };
}

// reason names the action for the economy journal.
function syncInventorySummary(characterId, inventory, reason = null, options) {
    return Database.syncInventorySummary(characterId, inventory, reason, options);
}

// A town trip is paid when it starts (a Scroll of Escape, a gatekeeper fee:
// ColdTrip.toTown debits the stored inventory); its items follow the first
// time the trip is written.
function syncNewTripPayment(state, previous) {
    const travel = state?.stats?.travel;
    if (!travel?.paid || Number(previous?.stats?.travel?.startedAt) === Number(travel.startedAt)) return Promise.resolve();
    return syncInventorySummary(state.characterId, state.inventory || {}, 'trip_payment');
}

function targetCombatTelemetry(previous = {}, debug = {}, timestamp = now()) {
    if (debug?.targetOnSpot !== 1) return null;
    const targetNpcId = Number(debug?.targetNpcId || 0);
    if (targetNpcId <= 0) return null;
    const targetKey = String(targetNpcId);
    const defeatedNpcIds = (Array.isArray(debug.foughtNpcIds) ? debug.foughtNpcIds : debug.defeatedNpcIds || [])
        .map(Number)
        .filter((npcId) => npcId > 0);
    const targetKills = defeatedNpcIds.filter((npcId) => npcId === targetNpcId).length;
    const interruptions = defeatedNpcIds.length - targetKills;
    // A population entry holds counters only; the last fight's NPC list is
    // the bot's own (top level, GearThreat reads it), never one per target.
    const add = (current = {}) => ({
        resolves: Number(current.resolves || 0) + 1,
        defeated: Number(current.defeated || 0) + defeatedNpcIds.length,
        targetKills: Number(current.targetKills || 0) + targetKills,
        interruptions: Number(current.interruptions || 0) + interruptions,
        lastResolvedAt: timestamp
    });
    const limitTargets = (values) => Object.fromEntries(Object.entries(values)
        .sort(([, left], [, right]) => Number(right.lastResolvedAt || 0) - Number(left.lastResolvedAt || 0))
        .slice(0, 24));
    // The bot's own counter continues itself: the population map stops growing
    // for a party member that is not the population telemetry owner.
    const current = add(Number(previous.targetNpcId) === targetNpcId
        ? previous
        : previous.populationTargets?.[targetKey] || {});
    const populationTargets = { ...(previous.populationTargets || {}) };
    if (!debug.aggregate || debug.populationTelemetryOwner === true) {
        populationTargets[targetKey] = add(populationTargets[targetKey]);
    }
    const retained = { ...(previous || {}) };
    delete retained.targets;

    return {
        ...retained,
        targetNpcId,
        ...current,
        lastDefeatedNpcIds: defeatedNpcIds,
        populationTargets: limitTargets(populationTargets)
    };
}

function compactResolveDebug(debug = {}) {
    if (Config.developerDiagnostics !== true) return null;
    return {
        route: debug.route || null,
        partyId: debug.partyId || null,
        targetNpcId: Number(debug.targetNpcId || 0) || null,
        wins: Number(debug.wins || 0),
        fights: Number(debug.fights || 0),
        defeated: Array.isArray(debug.defeatedNpcIds) ? debug.defeatedNpcIds.slice(-8).map(Number) : [],
        at: now()
    };
}

function normalize(row) {
    const stats = SpotRiskPolicy.marksInSteps(SavedStats.merge(row.statsJson, row.mindJson), Date.now());
    delete stats.marketTrades;
    delete stats.priceBeliefs;
    // The retired combat profile hold record (no reader).
    if (stats.coldCombat) delete stats.coldCombat.profileHold;
    const inventory = normalizeInventoryStackability(parseJson(row.inventorySummary, {}));

    return ClanMembershipPolicy.reconcileState({
        characterId: Number(row.characterId),
        accountName: row.accountName || '',
        name: row.characterName || '',
        // The generated name and look versions: the seeder redoes a lower one.
        nameGeneratorVersion: Number(row.nameGeneratorVersion || 0),
        appearanceVersion: Number(row.appearanceVersion || 0),
        level: Number(row.level || 1),
        exp: Number(row.exp || 0),
        sp: Number(row.sp || 0),
        adena: Number(row.adena || 0),
        phase: row.phase || 'cold',
        activity: row.activity || 'hunting',
        homeRegion: row.homeRegion || null,
        currentRegion: row.currentRegion || null,
        spotId: row.spotId || null,
        loc: {
            locX: Number(row.locX || 0),
            locY: Number(row.locY || 0),
            locZ: Number(row.locZ || 0)
        },
        vitals: {
            hp: Number(row.hp || 0),
            maxHp: Number(row.maxHp || 0),
            mp: Number(row.mp || 0),
            maxMp: Number(row.maxMp || 0)
        },
        levelBand: row.targetLevelBand || null,
        timing: {
            activityStartedAt: row.activityStartedAt ? Number(row.activityStartedAt) : null,
            nextResolveAt: row.nextResolveAt ? Number(row.nextResolveAt) : null,
            lastResolvedAt: row.lastResolvedAt ? Number(row.lastResolvedAt) : null,
            lastHotAt: row.lastHotAt ? Number(row.lastHotAt) : null
        },
        party: {
            partyId: row.partyId || null,
            role: stats.role || null,
            leaderId: stats.leaderId || null
        },
        stats,
        marketTrades: marketCounts.get(Number(row.characterId)) || {},
        inventory,
        ...(row.acceptedIncoming === undefined ? {} : { acceptedIncoming: row.acceptedIncoming || {} }),
        ...(row.incomingPending ? { incomingPending: true } : {}),
        simulation: { revision: Math.max(0, Number(row.simulationRevision || 0)) },
        updatedAt: Number(row.updatedAt || 0)
    });
}

// A main write that moved a far row's revision hands back the written number
// (`simulationRevision`); a cached copy patched by hand takes it, unless the
// cache already holds a newer one.
function movedSimulation(current, written) {
    const revision = Number(written?.simulationRevision);
    if (!Number.isSafeInteger(revision) || Number(current.simulation?.revision || 0) >= revision) return current.simulation;
    return { ...current.simulation, revision };
}

// A market purchase that failed after its save writes the bot's state from
// before it back (applyMarketPurchase's own compensation; NPC and configured
// merchant purchases only, board deals are one transaction).
function rewriteMarketState(state, reason) {
    if (!state?.characterId || !state.inventory) return Promise.resolve(null);
    const nextState = {
        ...state,
        stats: { ...(state.stats || {}), lastReason: reason },
        updatedAt: now()
    };
    const row = rowFromState(nextState);
    return save(row)
        .then(() => syncInventorySummary(row.characterId, nextState.inventory, 'market_restore'))
        .then(() => {
            const snapshot = normalize(row);
            cache.set(snapshot.characterId, snapshot);
            notifyColdSnapshot(snapshot, 'market_sale', { critical: true });
            return snapshot;
        }).catch((error) => {
            utils.infoWarn('BotLife', 'failed market rollback for %s: %s', state.name, error?.message || String(error));
            return null;
        });
}

function recordFromSession(session, phase, reason = '') {
    const actor = session.actor;
    const loc = actorLocation(actor);
    const vitals = actorVitals(actor);
    const currentSpot = session.currentSpot || null;
    const timestamp = now();
    const characterId = Number(actor.fetchId());
    const inventory = inventorySummaryFromItems(actor.backpack?.fetchItems ? actor.backpack.fetchItems() : []);
    const stats = {
        tradeMeeting: cache.get(characterId)?.stats?.tradeMeeting || null,
        ...Object.fromEntries(['playedHours', 'economyClock', 'frustration', 'lifelongKills', 'peoplePoints'].map(key => [key, session.coldLifeState?.stats?.[key] ?? cache.get(characterId)?.stats?.[key] ?? 0])),
        peopleEpisode: session.coldLifeState?.stats?.peopleEpisode ?? cache.get(characterId)?.stats?.peopleEpisode ?? null,
        ...(session.peopleKnowledge || {}),
        playedHours: invoke('GameServer/Social/RelationshipContext').playedHours(session, timestamp),
        pk: Number(actor.fetchPk?.() || 0),
        role: session.botStatus?.role || null,
        deathExperience: actor.deathExperience ? { ...actor.deathExperience } : null,
        karma: Number(actor.fetchKarma?.() || 0),
        pvpEncounter: session.pvpEncounter || cache.get(characterId)?.stats?.pvpEncounter || null,
        coldPvp: { ...(cache.get(characterId)?.stats?.coldPvp || {}),
            ...invoke('GameServer/Social/CombatHelpMemory').threatSnapshot(actor, timestamp),
            flagUntil: actor.fetchPvpFlag?.() === 1 ? Number(session.pvpFlagUntil || 0) : 0 },
        pvpEnemies: BotEnemyMemory.snapshot(session),
        pvpIncidents: invoke('GameServer/Social/PvpResponsibility').snapshot(actor, timestamp),
        revengeUntil: Math.max(Number(session.nextRevengeAt || 0), Number(cache.get(characterId)?.stats?.revengeUntil || 0)),
        clanGearExchangeRevision: Number(cache.get(characterId)?.stats?.clanGearExchangeRevision || 0),
        clanLevelSpVersion: Number(cache.get(characterId)?.stats?.clanLevelSpVersion || 0),
        clanInventoryRevision: Number(cache.get(characterId)?.stats?.clanInventoryRevision || 0),
        clanMembershipVersion: Number(cache.get(characterId)?.stats?.clanMembershipVersion || 0),
        classId: actor.fetchClassId ? Number(actor.fetchClassId()) : null,
        // A freshly spawned bot may cool before it has gone through a cold
        // resolve. Persist the completed profile here so it is never picked
        // up by the one-off legacy migration on a later restart.
        classProgressionLevel: actor.fetchLevel(),
        classProgressionClassId: actor.fetchClassId ? Number(actor.fetchClassId()) : null,
        clanId: cache.get(characterId)?.stats?.clanMembershipVersion
            ? Number(cache.get(characterId).stats.clanId || 0)
            : actor.fetchClanId ? Number(actor.fetchClanId()) || 0 : 0,
        clanHallVisit: session.clanHallVisit === undefined ? session.coldLifeState?.stats?.clanHallVisit || null : session.clanHallVisit,
        clanHallRetryAt: session.clanHallRetryAt ?? session.coldLifeState?.stats?.clanHallRetryAt ?? 0,
        route: currentSpot?.route || null,
        equipment: equipmentSummaryFromInventory(inventory),
        // Cold combat must start from the exact same character model as the
        // hot session: equipped item totals, learned skills and live effects.
        // The resolver rebuilds those values deterministically after effects
        // expire, rather than retaining a stale buffed total indefinitely.
        coldCombat: ColdCombatProfile.capture(actor, timestamp),
        hennas: [...(session.hennas || [])],
        soulCrystalQuest: session.questStates?.get(350)?.isStarted() === true,
        leaderId: session.followPlayerSession?.actor?.fetchId ? Number(session.followPlayerSession.actor.fetchId()) : null,
        supplyErrand: session.companionShopping?.kind === 'player_resource_purchase'
            ? {
                workflowId: session.companionShopping.workflowId || null,
                meetingToken: typeof session.companionShopping.meetingToken === 'string'
                    && session.companionShopping.meetingToken.length <= 80 ? session.companionShopping.meetingToken : null,
                itemSelfId: Number(session.companionShopping.itemId || 0) || null,
                amount: Number(session.companionShopping.amount || 0) || null,
                phase: session.supplyErrandPhase || 'cold',
                startedAt: Number(session.companionShopping.startedAt || 0) || null,
                expiresAt: Number(session.companionShopping.expiresAt || 0) || null
            }
            : null,
        newbieAnchor: !!session.newbieAnchor,
        lastReason: reason
    };

    return {
        characterId,
        accountName: session.accountId || '',
        characterName: actor.fetchName(),
        nameGeneratorVersion: Number(cache.get(characterId)?.nameGeneratorVersion || 0),
        appearanceVersion: Number(cache.get(characterId)?.appearanceVersion || 0),
        level: actor.fetchLevel(),
        exp: actor.fetchExp() || 0,
        sp: actor.fetchSp() || 0,
        adena: inventoryAdena(inventory),
        homeRegion: session.homeRegion || null,
        currentRegion: session.homeRegion || null,
        spotId: currentSpot?.id || null,
        activity: session.plan || 'hunting',
        phase,
        activityStartedAt: timestamp,
        nextResolveAt: null,
        lastResolvedAt: null,
        lastHotAt: phase === 'hot' ? timestamp : null,
        locX: loc.locX,
        locY: loc.locY,
        locZ: loc.locZ,
        hp: vitals.hp,
        maxHp: vitals.maxHp,
        mp: vitals.mp,
        maxMp: vitals.maxMp,
        targetLevelBand: targetLevelBandForSession(session, actor.fetchLevel()),
        deathCount: 0,
        partyId: null,
        inventorySummary: safeJson(inventory),
        ...SavedStats.statsColumns(stats),
        updatedAt: timestamp
    };
}

function rowFromState(state) {
    state = ClanMembershipPolicy.reconcileState(state);
    const inventory = InventorySummary.canonicalize(state?.inventory);
    const equipmentAdvance = equipmentCompletionSignal({ ...state, inventory });
    const persistedState = reconcileFulfilledEquipmentPlan({
        ...state,
        inventory
    });
    return {
        characterId: persistedState.characterId,
        accountName: persistedState.accountName || '',
        characterName: persistedState.name || '',
        nameGeneratorVersion: Number(persistedState.nameGeneratorVersion || 0),
        appearanceVersion: Number(persistedState.appearanceVersion || 0),
        level: Number(persistedState.level || 1),
        exp: Number(persistedState.exp || 0),
        sp: Number(persistedState.sp || 0),
        adena: Number(persistedState.adena || 0),
        homeRegion: persistedState.homeRegion || null,
        currentRegion: persistedState.currentRegion || null,
        spotId: persistedState.spotId || null,
        activity: persistedState.activity || 'hunting',
        phase: persistedState.phase || 'cold',
        activityStartedAt: persistedState.timing?.activityStartedAt || null,
        nextResolveAt: persistedState.timing?.nextResolveAt || null,
        lastResolvedAt: persistedState.timing?.lastResolvedAt || null,
        lastHotAt: persistedState.timing?.lastHotAt || null,
        locX: persistedState.loc?.locX || 0,
        locY: persistedState.loc?.locY || 0,
        locZ: persistedState.loc?.locZ || 0,
        hp: persistedState.vitals?.hp || 0,
        maxHp: persistedState.vitals?.maxHp || 0,
        mp: persistedState.vitals?.mp || 0,
        maxMp: persistedState.vitals?.maxMp || 0,
        targetLevelBand: persistedState.levelBand || levelBand(persistedState.level),
        deathCount: persistedState.stats?.deaths || 0,
        partyId: persistedState.party?.partyId || null,
        inventorySummary: safeJson(persistedState.inventory || {}),
        ...SavedStats.statsColumns(persistedState.stats),
        // `save()` does not bind the revision: a far row's revision moves in
        // SQL and save() writes the moved number back here. Until then the row
        // carries the state's own, so normalize(row) never resets the cached
        // revision to zero.
        simulationRevision: Math.max(0, Number(persistedState.simulation?.revision || 0)),
        equipmentAdvance,
        updatedAt: now()
    };
}

// The session's own snapshots carry the authority of its row just saved
// (phase, revision, hot time): after markHot what the actor writes from them (a
// hot merchant's sale, its haggling) keeps the row hot and passes the economy
// admission, though markHot's save moved the far row's revision and stamped its
// hot time; a cold job's older snapshot is still rejected by save(); after the
// hand-back a late write that copies the phase from them stays cold.
function setSessionSnapshotsAuthority(session, saved) {
    const { phase, simulation } = saved, lastHotAt = saved.timing?.lastHotAt ?? null;
    for (const key of ['coldLifeState', 'coldMarketState', 'coldCraftState']) {
        if (session?.[key]) session[key] = { ...session[key], phase, simulation,
            timing: { ...session[key].timing, lastHotAt } };
    }
    RefreshPartyMemberships([session], invoke);
}

function save(row, options = {}) {
    // ARCH-NOTE: strip retired counters even when an old caller supplies them on a new row.
    const proposedStats = parseJson(row.statsJson, {});
    if (proposedStats.marketTrades || proposedStats.priceBeliefs) {
        delete proposedStats.marketTrades;
        delete proposedStats.priceBeliefs;
        row.statsJson = safeJson(proposedStats);
    }
    // A hot row belongs to the actor in the world; only markCold hands it back
    // to the cold population. A cold row proposed over it comes from a job that
    // started while the bot was cold: reject it like the stale writers below.
    if (cache.get(Number(row.characterId))?.phase === 'hot' && row.phase !== 'hot' && options.releaseHot !== true) {
        const error = new Error(`stale cold state over the hot row of ${row.characterId}`);
        error.code = 'BOT_LIFE_STATE_OWNERSHIP_CONFLICT';
        return Promise.reject(error);
    }
    const proposed = { activity: row.activity, stats: proposedStats };
    const reconciled = ClanMembershipPolicy.reconcileState(ClanMembershipPolicy.preserveGoalInvalidation(
        proposed, cache.get(Number(row.characterId))?.stats));
    if (reconciled !== proposed) {
        row.activity = reconciled.activity;
        row.statsJson = safeJson(reconciled.stats);
    }
    // An async lifecycle step may still hold the inventory from before an
    // exchange. Reject it before its subsequent inventory sync restores gear.
    const exchangeRevision = Number(cache.get(Number(row.characterId))?.stats?.clanGearExchangeRevision || 0);
    if (exchangeRevision > Number(reconciled.stats.clanGearExchangeRevision || 0)) {
        const error = new Error(`stale inventory before clan equipment exchange for ${row.characterId}`);
        error.code = 'BOT_LIFE_STATE_OWNERSHIP_CONFLICT';
        return Promise.reject(error);
    }
    const spVersion = Number(cache.get(Number(row.characterId))?.stats?.clanLevelSpVersion || 0);
    if (spVersion > Number(reconciled.stats.clanLevelSpVersion || 0)) {
        const error = new Error(`stale SP before clan level-up for ${row.characterId}`);
        error.code = 'BOT_LIFE_STATE_OWNERSHIP_CONFLICT';
        return Promise.reject(error);
    }
    // A job can retain its old snapshot across a serialized name/look
    // migration. Keep the latest metadata on the row also used to rebuild
    // the cache, while allowing the job's unrelated lifecycle update.
    const current = cache.get(Number(row.characterId));
    const nameVersion = Number(current?.nameGeneratorVersion || 0);
    if (nameVersion > 0 && nameVersion >= Number(row.nameGeneratorVersion || 0)) {
        row.characterName = current.name;
        row.nameGeneratorVersion = nameVersion;
    }
    row.appearanceVersion = Math.max(Number(row.appearanceVersion || 0), Number(current?.appearanceVersion || 0));
    const beforeWrite = Object.getOwnPropertyDescriptor(options, 'beforeWrite');
    const databaseOptions = beforeWrite ? Object.defineProperty({}, 'beforeWrite', beforeWrite) : undefined;
    const statement = [
        `INSERT INTO ${TABLE} (
            characterId, accountName, characterName, level, exp, sp, adena, homeRegion, currentRegion,
            spotId, activity, phase, activityStartedAt, nextResolveAt,
            lastResolvedAt, lastHotAt, locX, locY, locZ, hp, maxHp, mp, maxMp,
            targetLevelBand, deathCount, partyId, inventorySummary, statsJson, updatedAt,
            nameGeneratorVersion, appearanceVersion, mindJson
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(characterId) DO UPDATE SET
            accountName = excluded.accountName,
            characterName = excluded.characterName,
            nameGeneratorVersion = excluded.nameGeneratorVersion,
            appearanceVersion = excluded.appearanceVersion,
            level = excluded.level,
            exp = excluded.exp,
            sp = excluded.sp,
            adena = excluded.adena,
            homeRegion = excluded.homeRegion,
            currentRegion = excluded.currentRegion,
            spotId = excluded.spotId,
            activity = excluded.activity,
            phase = excluded.phase,
            activityStartedAt = excluded.activityStartedAt,
            nextResolveAt = excluded.nextResolveAt,
            lastResolvedAt = excluded.lastResolvedAt,
            lastHotAt = excluded.lastHotAt,
            locX = excluded.locX,
            locY = excluded.locY,
            locZ = excluded.locZ,
            hp = excluded.hp,
            maxHp = excluded.maxHp,
            mp = excluded.mp,
            maxMp = excluded.maxMp,
            targetLevelBand = excluded.targetLevelBand,
            deathCount = excluded.deathCount,
            partyId = excluded.partyId,
            inventorySummary = excluded.inventorySummary,
            -- Native takeover/release/restore owns player membership. A late
            -- actor snapshot cannot revive or remove that ownership marker.
            statsJson = json_set(json_patch(json_remove(${EconomyCommit.preserveLeafSql(
                "json_remove(excluded.statsJson, '$.marketTrades', '$.priceBeliefs')")}, '$.playerPartyTakeover', '$.constPartySession'),
                json_object('playerPartyTakeover', json_extract(bot_life_state.statsJson, '$.playerPartyTakeover'),
                    'constPartySession', json_extract(bot_life_state.statsJson, '$.constPartySession'))),
                '$.hennas', json_array(
                    (SELECT symbolId FROM character_hennas WHERE characterId = excluded.characterId AND slot = 1),
                    (SELECT symbolId FROM character_hennas WHERE characterId = excluded.characterId AND slot = 2),
                    (SELECT symbolId FROM character_hennas WHERE characterId = excluded.characterId AND slot = 3))),
            -- The mind rides under the same guard as the body: a near bot's
            -- mind on main is the worker's copy, the next save carries the
            -- same copy, and a refused save is a stale actor snapshot, so a
            -- second unguarded statement would buy nothing. Over a far row
            -- (old phase cold) the revision fences it: a save built on the
            -- row's revision writes its mind (a worker packet main applies
            -- for a lifecycle step, a purchase's money); one built on an
            -- older copy (the row moved past it since) keeps the row's. The
            -- hot->cold hand-off (old phase hot) carries main's. RETURNING
            -- hands the written mind back, so the cache and the snapshot the
            -- worker receives carry the row's.
            mindJson = CASE WHEN ${TABLE}.phase = 'cold' AND ${TABLE}.simulationRevision > ?
                THEN ${TABLE}.mindJson ELSE excluded.mindJson END,
            updatedAt = excluded.updatedAt,
            -- A main write to a far row moves its revision: a worker step
            -- begun before it is refused stale_revision and rebases.
            ${Database.MOVE_FAR_REVISION}
        WHERE COALESCE(json_extract(${TABLE}.statsJson, '$.clanInventoryRevision'), 0)
              <= COALESCE(json_extract(excluded.statsJson, '$.clanInventoryRevision'), 0)
          AND COALESCE(json_extract(${TABLE}.statsJson, '$.clanLevelSpVersion'), 0)
              <= COALESCE(json_extract(excluded.statsJson, '$.clanLevelSpVersion'), 0)
          AND COALESCE(json_extract(${TABLE}.statsJson, '$.clanMembershipVersion'), 0)
              <= COALESCE(json_extract(excluded.statsJson, '$.clanMembershipVersion'), 0)`,
        [
            row.characterId,
            row.accountName,
            row.characterName,
            row.level,
            row.exp,
            row.sp,
            row.adena,
            row.homeRegion,
            row.currentRegion,
            row.spotId,
            row.activity,
            row.phase,
            row.activityStartedAt,
            row.nextResolveAt,
            row.lastResolvedAt,
            row.lastHotAt,
            row.locX,
            row.locY,
            row.locZ,
            row.hp,
            row.maxHp,
            row.mp,
            row.maxMp,
            row.targetLevelBand,
            row.deathCount,
            row.partyId,
            row.inventorySummary,
            row.statsJson,
            row.updatedAt,
            Number(row.nameGeneratorVersion || 0),
            Number(row.appearanceVersion || 0),
            row.mindJson,
            // The revision the save was built on (the mind's fence above).
            Math.max(0, Number(row.simulationRevision || 0))
        ]
    ];
    NativeWriteCheckpoint.bindRow(beforeWrite?.value, statement, row.characterId);
    return Database.saveBotLifeState(statement, databaseOptions, row.characterId).then((result) => {
        if (result && typeof result.affectedRows === 'number' && result.affectedRows !== 1) {
            const error = new Error(`bot life state ownership conflict for ${row.characterId}`);
            error.code = 'BOT_LIFE_STATE_OWNERSHIP_CONFLICT';
            Metrics.recordLegacyOwnershipConflict();
            throw error;
        }
        Metrics.recordDbFlush();
        row.statsJson = result.statsJson;
        if (result.mindJson !== undefined) row.mindJson = result.mindJson;
        // The cache built from this row takes the row's revision (moved by
        // this write on a far row), not the older one the caller's state carried.
        if (result.simulationRevision !== undefined) row.simulationRevision = Number(result.simulationRevision);
        return enqueueEquipmentGoalAdvance(row.equipmentAdvance).then(() => result);
    });
}

// A main write of only its own fields to a far bot (a party's plan or
// departure for a member, the seed pass's station crafter), built on the copy
// main read before: only the given fields are written (`stats`: top-level
// stats keys, `columns`: row columns), held on that copy's revision, and the
// write moves it. A write that moved the row in between (the bot's own review,
// its training, a craft, a sale) wins and nothing is written: false, and the
// caller compares again on its next pass (a party marks its re-plan due).
function writeHeldOnRevision(member, { stats = {}, columns = {} }, reason) {
    const id = Number(member.characterId);
    const statsEntries = Object.entries(stats), columnEntries = Object.entries(columns);
    const assignments = [
        ...(statsEntries.length ? [`statsJson = json_set(COALESCE(statsJson, '{}'), ${statsEntries.map(() => '?, json(?)').join(', ')})`] : []),
        ...columnEntries.map(([name]) => `${name} = ?`),
        'simulationRevision = simulationRevision + 1', 'updatedAt = ?'
    ];
    const params = [
        ...statsEntries.flatMap(([key, value]) => [`$.${key}`, JSON.stringify(value ?? null)]),
        ...columnEntries.map(([, value]) => value),
        now(), id, Number(member.simulation?.revision || 0)
    ];
    return module.exports.serializeClanLevelUp(id, () => Database.execute([`UPDATE ${TABLE} SET ${assignments.join(', ')}
        WHERE characterId = ? AND phase = 'cold' AND simulationRevision = ?
        RETURNING *`, params, { read: true }]))
        .then(([row] = []) => {
            if (!row) return false;
            const snapshot = module.exports.acceptNewerLifecycleRow(row);
            if (snapshot) notifyColdSnapshot(snapshot, reason, { critical: true });
            return snapshot;
        }).catch((error) => {
            utils.infoWarn('BotLife', 'failed held write %s for %s: %s', reason, id, error.message);
            return null;
        });
}

// The world was paused while the server was down (L136): every persisted due
// time moves by the downtime, so a restart does not make all bots due at once,
// and so does lastResolvedAt: the step's length is now - lastResolvedAt
// (ColdSimulationKernel), so an unmoved stamp would credit the downtime as
// hunting time (fights, mob share, regen) the bot never lived.
// Downtime = the moment the shift runs - the last row write before this
// process start, measured once per boot: the pause ends at the shift, so the
// boot time before it is neither credited as lived time nor makes bots due.
// BackgroundPartyState moves its party due times by the same value.
let bootPause = null;
function measureBootPause() {
    const startedAt = Math.floor(Uptime.SERVER_STARTED_AT);
    return bootPause ||= Database.execute([
        `SELECT MAX(updatedAt) AS lastWriteAt FROM ${TABLE} WHERE updatedAt < ?`, [startedAt]
    ]).then(([row] = []) => {
        const lastWriteAt = Number(row?.lastWriteAt);
        return { startedAt, downtimeMs: lastWriteAt > 0 ? now() - lastWriteAt : 0 };
    });
}

// Runs first in init, before the boot repairs, so a row they rewrite (a stale
// hot row keeps its old due) is moved too; a row written after this process
// start keeps its timers. The row moves with the cache: the worker's first command checkpoint
// (nextResolveAt included) is fenced against the row (NativeWriteCheckpoint).
// updatedAt moves by the same delta, so the next boot measures from this shift
// even if no bot commits before it (a crash loop would compound otherwise).
function shiftDueTimesByDowntime() {
    return measureBootPause().then(({ startedAt, downtimeMs }) => {
        if (!(downtimeMs > 0)) return 0;
        return Database.execute([
            `UPDATE ${TABLE} SET nextResolveAt = nextResolveAt + ?, lastResolvedAt = lastResolvedAt + ?, updatedAt = updatedAt + ?
            WHERE (nextResolveAt > 0 OR lastResolvedAt > 0) AND updatedAt > 0 AND updatedAt < ?`,
        [downtimeMs, downtimeMs, downtimeMs, startedAt]
        ]).then((result) => {
            const shifted = Number(result?.affectedRows || 0);
            utils.infoWarn('BotLife', 'cold hydrate: shifted %d due times by %d ms', shifted, downtimeMs);
            return shifted;
        });
    });
}

function hydrateCache() {
    return Database.execute([
        `SELECT states.*, (SELECT json_group_array(json_object('slot', slot, 'symbolId', symbolId))
            FROM character_hennas WHERE characterId = states.characterId) AS nativeHennas,
            EXISTS(SELECT 1 FROM character_quests WHERE characterId = states.characterId AND questId = 350 AND state = 'started') AS nativeCrystalQuest,
            CASE WHEN COALESCE(json_extract(states.statsJson, '$.coldCombat.skillSource'), '') NOT IN ('hot', 'database')
                OR (json_extract(states.statsJson, '$.coldCombat.skillSource') = 'database'
                    AND COALESCE(json_extract(states.statsJson, '$.coldCombat.version'), 0) < ${ColdCombatProfile.PROFILE_VERSION})
                THEN (SELECT json_group_array(json_object('selfId', selfId, 'level', level))
                    FROM skills WHERE characterId = states.characterId) END AS nativeLearnedSkills
            FROM ${TABLE} states`,
        []
    ]).then(async (rows) => {
        for (const row of rows) {
            let state = normalize(row);
            const storedHennas = state.stats.hennas;
            state.stats.hennas = [null,null,null];
            for (const symbol of parseJson(row.nativeHennas, [])) state.stats.hennas[symbol.slot - 1] = symbol.symbolId;
            const hennaRepair = JSON.stringify(storedHennas) !== JSON.stringify(state.stats.hennas);
            if (row.nativeLearnedSkills != null) {
                state.stats.coldCombat = ColdCombatProfile.legacySnapshot(state, parseJson(row.nativeLearnedSkills, []), now());
            }
            // Once per bot at load: an old seed's base counts hennas a cold draw may have changed since.
            const seedRepair = ColdCombatProfile.oldSeedRepair(state.stats.coldCombat);
            if (seedRepair) state.stats.coldCombat = seedRepair;
            if (row.nativeLearnedSkills != null || hennaRepair || seedRepair) {
                // Startup repair precedes cache publication and worker reads.
                // Use the existing guarded save; do not learn/spend here.
                if (state.phase === 'cold') {
                    const repaired = rowFromState(state);
                    await save(repaired);
                    state = normalize(repaired);
                }
            }
            delete row.nativeLearnedSkills;
            state.stats.soulCrystalQuest = !!row.nativeCrystalQuest;
            cache.set(state.characterId, state);
            invoke('GameServer/Bot/Economy/CraftWorkshopService').register(state);
        }
        const ordered = [...classMigrationCandidates].sort((a, b) => a[1] - b[1]);
        classMigrationCandidates.clear();
        for (const [id, at] of ordered) classMigrationCandidates.set(id, at);
        return rows.length;
    });
}

function preserveStarterLootProvenance(previousInventory = {}, observedInventory = {}) {
    return Object.entries(observedInventory).reduce((inventory, [key, item]) => {
        const protectedAmount = Math.min(
            Number(item?.amount || 0),
            Math.max(0, Number(previousInventory?.[key]?.starterMobLootAmount || 0))
        );
        inventory[key] = protectedAmount > 0 ? { ...item, starterMobLootAmount: protectedAmount } : item;
        return inventory;
    }, {});
}

function classProgressionNeeded(state, classId, level) {
    const knownLevel = Number(state.stats?.classProgressionLevel || 0);
    const knownClassId = Number(state.stats?.classProgressionClassId ?? state.stats?.classId);
    return knownLevel < Number(level || 1) || knownClassId !== Number(classId)
        || invoke('GameServer/Skills/SkillBookCatalog').needsTraining(state);
}

// The far bots main trains after a commit: cold, alive.
function mainTrainsFar(state) {
    return !!state && state.phase === 'cold' && state.activity !== 'dead';
}

function refreshColdCombatProfile(state) {
    return Database.fetchSkills(state.characterId).then((skills) => ({
        ...state,
        stats: {
            ...(state.stats || {}),
            // Class progression writes skills directly to the character
            // table. Keep the cold model in lockstep so its next fight uses
            // the same ranks and newly learned abilities as a hot bot.
            coldCombat: ColdCombatProfile.legacySnapshot(state, skills, now())
        }
    }));
}

function projectColdCombatProfile(state, timestamp = now()) {
    return Promise.resolve({
        ...state,
        stats: {
            ...(state.stats || {}),
            coldCombat: ColdCombatProfile.treeSnapshot(state, timestamp)
        }
    });
}

function applyClassProgression(state, profile = {}) {
    const level = Number(profile.level || state.level || 1);
    const currentClassId = Number(profile.classId ?? state.stats?.classId ?? 0);
    if (!classProgressionNeeded(state, currentClassId, level)) return Promise.resolve(state);

    return BotClassProgression.reconcile({
        characterId: state.characterId,
        classId: currentClassId,
        level,
        seed: state.characterId
    }).then((resolved) => {
        const classId = Number(resolved.classId || currentClassId);
        const role = BotRoles.inferRole({ classId, characterId: state.characterId });
        const progressedState = {
            ...state,
            level,
            exp: profile.exp ?? state.exp,
            sp: profile.sp ?? state.sp,
            party: { ...(state.party || {}), role },
            stats: {
                ...(state.stats || {}),
                classId,
                role,
                classProgressionLevel: level,
                classProgressionClassId: classId,
                classTransitions: resolved.transitions?.length
                    ? [...(state.stats?.classTransitions || []), ...resolved.transitions]
                    : state.stats?.classTransitions || []
            }
        };
        if (resolved.transitions?.length) delete progressedState.stats.equipmentPlan;
        return refreshColdCombatProfile(reconcileEquipmentInventory(
            invoke('GameServer/Skills/SkillBookCatalog').applyTraining(progressedState, resolved)));
    });
}

function recoverStaleHotStates() {
    const timestamp = now();
    return Database.execute([
        `UPDATE ${TABLE}
        SET phase = 'cold',
            activity = CASE
                WHEN activity IN ('following', 'shopping', 'getting_buffed', 'fleeing', 'pk_fleeing') THEN 'hunting'
                ELSE activity
            END,
            nextResolveAt = COALESCE(nextResolveAt, ?),
            updatedAt = ?
        WHERE phase = 'hot'
        -- Static merchant bots are spawned from MerchantConfigs on startup.
        -- Market and craft services stored in the cold population do not have
        -- a startup owner, so retaining their hot phase would leave a database
        -- ghost after a restart instead of a visible Giran station.
        AND (activity <> 'merchant' OR statsJson LIKE '%"marketStore"%')
        `,
        [timestamp + 30000, timestamp]
    ]).then((result) => {
        const recovered = Number(result?.affectedRows || 0);
        if (recovered > 0) {
            utils.infoWarn('BotLife', 'recovered %d stale hot states as cold on startup', recovered);
        }
        return recovered;
    });
}

function removeRetiredStaticMerchantStates() {
    const configuredNames = Object.keys(MerchantStoreConfigs);
    const configuredClause = configuredNames.length
        ? `AND characterName NOT IN (${configuredNames.map(() => '?').join(', ')})`
        : '';

    return Database.execute([
        `DELETE FROM ${TABLE}
        WHERE phase = 'hot'
        AND activity = 'merchant'
        AND json_extract(statsJson, '$.marketStore') IS NULL
        ${configuredClause}
        -- retired_static_merchant
        `,
        configuredNames
    ]).then((result) => {
        const removed = Number(result?.affectedRows || 0);
        if (removed > 0) {
            utils.infoWarn('BotLife', 'removed %d retired static merchant lifecycle states', removed);
        }
        return removed;
    });
}

function recoverDissolvedPartyMembers() {
    const timestamp = now();
    return Database.execute([
        `UPDATE ${TABLE}
        SET partyId = NULL,
            activity = CASE WHEN activity = 'grouped' THEN 'hunting' ELSE activity END,
            activityStartedAt = ?,
            nextResolveAt = ?,
            statsJson = json_set(
                COALESCE(statsJson, '{}'),
                '$.backgroundPartyId', NULL,
                '$.partyBreakReason', 'orphaned_dissolved_party',
                '$.lastReason', 'orphaned_dissolved_party'
            ),
            updatedAt = ?
        WHERE partyId IN (
            SELECT partyId FROM bot_background_parties WHERE status NOT IN ('active', 'hot')
        )`,
        [timestamp, timestamp, timestamp]
    ]).then((result) => {
        const recovered = Number(result?.affectedRows || 0);
        if (recovered > 0) {
            utils.infoWarn('BotLife', 'released %d bot(s) from dissolved background parties', recovered);
        }
        return recovered;
    });
}

function mergeSessionIntoLifeState(session, state, phase, reason = '', options = {}) {
    const observed = recordFromSession(session, phase, reason);
    const observedStats = SavedStats.merge(observed.statsJson, observed.mindJson);
    const observedInventory = parseJson(observed.inventorySummary, {});
    const timestamp = now();
    const physicalLoc = options.physicalLocation
        ? { locX: observed.locX, locY: observed.locY, locZ: observed.locZ } : null;
    const physicalSpot = physicalLoc ? SpotService.findCurrentSpot(physicalLoc) : null;
    const physicalActivity = physicalLoc && ['hunting', 'resting', 'shopping', 'pk_hunting'].includes(observed.activity)
        ? observed.activity : null;
    const merged = {
        ...state,
        accountName: observed.accountName,
        name: observed.characterName,
        level: observed.level,
        exp: observed.exp,
        sp: observed.sp,
        adena: observed.adena,
        phase,
        activity: physicalActivity || options.activity || state.activity || observed.activity,
        loc: physicalLoc || options.loc || state.loc || { locX: observed.locX, locY: observed.locY, locZ: observed.locZ },
        spotId: physicalLoc ? physicalSpot?.id || null : state.spotId,
        currentRegion: physicalLoc
            ? WorldAreaCatalog.resolve(physicalLoc)?.name || physicalSpot?.name || state.currentRegion
            : state.currentRegion,
        vitals: { hp: observed.hp, maxHp: observed.maxHp, mp: observed.mp, maxMp: observed.maxMp },
        levelBand: observed.targetLevelBand || state.levelBand,
        timing: {
            ...(state.timing || {}),
            activityStartedAt: timestamp,
            nextResolveAt: options.nextResolveAt ?? state.timing?.nextResolveAt ?? null,
            lastResolvedAt: options.lastResolvedAt ?? state.timing?.lastResolvedAt ?? null,
            lastHotAt: phase === 'hot' ? timestamp : state.timing?.lastHotAt || null
        },
        stats: {
            ...(state.stats || {}), ...observedStats, lastReason: reason,
            ...(physicalLoc ? {
                travel: null,
                restUntil: physicalActivity === 'resting' ? timestamp + 30000 : null
            } : {})
        },
        inventory: preserveStarterLootProvenance(state.inventory, observedInventory)
    };
    // The cold row of every cooling writer (writeColdRow, partySessionSnapshot
    // for the party and PvP cooldowns) takes the near raise still unanswered.
    if (phase === 'cold') DecisionEvents.applyPendingRaise(session, merged.stats);
    return merged;
}

// A stale cold snapshot can retain the previous hunting region while its
// physical coordinate is still on the Giran trading square.  Coordinates are
// authoritative here: currentRegion is plan context, not a location proof.
function isOnGiranMarketPlaza(loc = {}) {
    return ShopPlaces.isOnSquare('Giran', loc);
}

function shouldRecoverOrphanedGiranState(state = {}) {
    if (!state.spotId || !isOnGiranMarketPlaza(state.loc)) return false;
    if (['traveling', 'shopping', 'merchant', 'crafting'].includes(state.activity)) return false;
    const stats = state.stats || {};
    // An ordinary bot may be in Giran only while traveling, shopping, or
    // running a store. Any remaining market/craft metadata on a resting or
    // hunting bot is stale context, not an active reason to occupy the plaza.
    return !stats.marketStore && !stats.craftShop;
}

function recoverOrphanedGiranState(state = {}) {
    if (!shouldRecoverOrphanedGiranState(state)) return state;
    const spot = SpotService.findById(state.spotId);
    if (!spot?.center) return state;
    return {
        ...state,
        currentRegion: state.homeRegion || state.currentRegion,
        loc: SpotService.randomPointNear(spot, 400),
        timing: { ...(state.timing || {}), nextResolveAt: now() + 30000 }
    };
}

function sameLocation(left, right, tolerance = 8) {
    if (!left || !right) return false;
    return ['locX', 'locY', 'locZ'].every((key) => {
        const a = Number(left[key]);
        const b = Number(right[key]);
        return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;
    });
}

function canonicalizeAreaState(state = {}) {
    const previousRegion = state.currentRegion;
    const previousStats = state.stats || {};
    const currentSpot = state.spotId ? SpotService.findById(state.spotId) : null;
    const area = WorldAreaCatalog.resolve(state.loc);
    const returnSpot = previousStats.marketReturn?.spotId
        ? SpotService.findById(previousStats.marketReturn.spotId)
        : null;
    const returnArea = WorldAreaCatalog.resolve(returnSpot?.center || previousStats.marketReturn?.loc);
    const travelSpot = previousStats.travel?.spotId
        ? SpotService.findById(previousStats.travel.spotId)
        : null;
    const travelArea = WorldAreaCatalog.resolve(travelSpot?.center || previousStats.travel?.to);
    if (!area && !returnArea && !travelArea) return state;

    const regionChanged = Boolean(area && previousRegion !== area.name);
    const areaIdChanged = Boolean(area && previousStats.canonicalAreaId !== area.id);
    const returnChanged = Boolean(previousStats.marketReturn && returnArea
        && previousStats.marketReturn.regionName !== returnArea.name);
    const travelChanged = Boolean(previousStats.travel && travelArea
        && previousStats.travel.regionName !== travelArea.name);
    const currentAtCenter = Boolean(area && currentSpot?.center
        && ['hunting', 'resting'].includes(state.activity)
        && sameLocation(state.loc, currentSpot.center));
    const returnAtCenter = Boolean(returnArea && returnSpot?.center
        && sameLocation(previousStats.marketReturn?.loc, returnSpot.center));
    const travelAtCenter = Boolean(travelArea && travelSpot?.center
        && sameLocation(previousStats.travel?.to, travelSpot.center));
    if (!regionChanged && !areaIdChanged && !returnChanged && !travelChanged
        && !currentAtCenter && !returnAtCenter && !travelAtCenter) return state;

    const stats = { ...previousStats };
    if (area) stats.canonicalAreaId = area.id;
    if (returnChanged || returnAtCenter) {
        stats.marketReturn = {
            ...previousStats.marketReturn,
            regionName: returnArea.name,
            loc: returnAtCenter
                ? SpotService.arrivalPointForState(state, returnSpot)
                : previousStats.marketReturn.loc
        };
    }
    if (travelChanged || travelAtCenter) {
        stats.travel = {
            ...previousStats.travel,
            regionName: travelArea.name,
            to: travelAtCenter
                ? SpotService.arrivalPointForState(state, travelSpot)
                : previousStats.travel.to
        };
    }

    const migratedLoc = currentAtCenter
        ? SpotService.arrivalPointForState(state, currentSpot)
        : state.loc;
    if (currentAtCenter && stats.travel?.from && sameLocation(stats.travel.from, state.loc)) {
        stats.travel = { ...stats.travel, from: migratedLoc };
    }

    const promptSoloReplan = (regionChanged || currentAtCenter)
        && !state.party?.partyId
        && ['hunting', 'resting'].includes(state.activity);
    const timestamp = now();
    return {
        ...state,
        currentRegion: area?.name || previousRegion,
        loc: migratedLoc,
        stats,
        timing: promptSoloReplan ? {
            ...(state.timing || {}),
            nextResolveAt: Math.min(
                Number(state.timing?.nextResolveAt || timestamp + 120000),
                timestamp + 5000 + (Number(state.characterId || 0) % 115000)
            )
        } : state.timing
    };
}

function recoverStaleCraftWaits() {
    const timestamp = now();
    return Database.execute([
        `UPDATE ${TABLE}
        SET activity = 'hunting',
            activityStartedAt = ?,
            nextResolveAt = ?,
            statsJson = json_set(COALESCE(statsJson, '{}'), '$.lastReason', 'startup_craft_wait_recovery'),
            updatedAt = ?
        WHERE phase = 'cold'
        AND activity = 'crafting'
        AND statsJson LIKE '%"lastReason":"cold_craft_wait"%'`,
        [timestamp, timestamp, timestamp]
    ]).then((result) => {
        const recovered = Number(result?.affectedRows || 0);
        if (recovered > 0) {
            utils.infoWarn('BotLife', 'recovered %d stale craft waits as hunting on startup', recovered);
        }
        return recovered;
    });
}

function migrateAcquisitionPartyWaits() {
    const timestamp = now();
    const replanAt = timestamp + 30000;
    return Database.execute([
        `UPDATE ${TABLE}
        SET activity = 'hunting',
            activityStartedAt = ?,
            nextResolveAt = ?,
            statsJson = json_set(
                COALESCE(statsJson, '{}'),
                '$.partyWaitUntil', NULL,
                '$.restUntil', NULL,
                '$.lastReason', 'party_request_recovery'
            ),
            updatedAt = ?
        WHERE phase = 'cold'
        AND activity IN ('resting', 'party_wait')
        AND (partyId IS NULL OR partyId = '')
        AND json_extract(statsJson, '$.lastReason') = 'acquisition_party_wait'
        AND COALESCE(CAST(json_extract(statsJson, '$.restUntil') AS INTEGER), 0) = 0`,
        [timestamp, replanAt, timestamp]
    ]).then((result) => {
        const migrated = Number(result?.affectedRows || 0);
        if (migrated > 0) {
            utils.infoWarn('BotLife', 'migrated %d acquisition party waits to event scheduling', migrated);
        }
        return migrated;
    });
}

function clearPassivePartyRequests() {
    const timestamp = now();
    return Database.execute([
        `UPDATE ${TABLE}
        SET statsJson = json_remove(COALESCE(statsJson, '{}'), '$.partyRequest'),
            updatedAt = ?
        WHERE phase = 'cold'
        AND (partyId IS NULL OR partyId = '')
        AND activity IN ('traveling', 'shopping', 'merchant', 'crafting', 'dead', 'clan_hall')
        AND partyRequestStatus = 'open'`,
        [timestamp]
    ]).then((result) => {
        const cleared = Number(result?.affectedRows || 0);
        if (cleared > 0) {
            utils.infoWarn('BotLife', 'cleared %d passive party requests on startup', cleared);
        }
        return cleared;
    });
}

// RETURNING couples publication to the rows actually changed, including native
// revisions. A claim already in transit must fail its old revision even before
// the critical snapshot reaches the worker.
function publishDeferredPartyRequests(rows) {
    for (const row of rows) {
        const snapshot = module.exports.acceptNewerLifecycleRow(row);
        if (snapshot) notifyColdSnapshot(snapshot, 'party_request_deferred', { critical: true });
    }
}

// Start-up only: a request left open across a restart is deferred once here;
// at run time each request expires at its own deadline (PartyAssemblyEvents).
function expireStalePartyRequests() {
    const timestamp = now();
    const requiredMaxAge = PartyRequestPlanner.maxAgeMs('required');
    const preferredMaxAge = PartyRequestPlanner.maxAgeMs('preferred');
    const cooldownMs = PartyRequestPlanner.cooldownMs();
    // Spread the next eligible formation attempts over at most two minutes so
    // a restart cannot turn one historical queue into a new SQLite spike.
    const staggerMs = Math.min(120000, Math.max(0, Math.floor(cooldownMs / 2)));
    const target = `phase = 'cold'
        AND (partyId IS NULL OR partyId = '')
        AND activity IN ('hunting', 'resting', 'party_wait')
        AND partyRequestStatus = 'open'
        AND partyRequestedAt <= ?
        AND (COALESCE(partyRequestPriority, '') <> 'required' OR partyRequestedAt <= ?)`;
    const sql = `UPDATE ${TABLE}
        SET statsJson = json_set(
                COALESCE(statsJson, '{}'),
                '$.partyRequest.status', 'deferred',
                '$.partyRequest.deferredUntil', ? + (ABS(characterId) % ?),
                '$.partyRequest.expiredAt', ?,
                '$.partyRequest.attempts', COALESCE(CAST(json_extract(statsJson, '$.partyRequest.attempts') AS INTEGER), 0) + 1
            ),
            simulationRevision = COALESCE(simulationRevision, 0) + 1,
            updatedAt = ?
        WHERE ${target} RETURNING *`;
    const params = [
        timestamp + cooldownMs,
        Math.max(1, staggerMs),
        timestamp,
        timestamp,
        timestamp - preferredMaxAge,
        timestamp - requiredMaxAge
    ];
    const staleParams = [timestamp - preferredMaxAge, timestamp - requiredMaxAge];
    const selectStale = () => Database.execute([
        `SELECT characterId FROM ${TABLE} WHERE ${target}`,
        staleParams
    ]);
    const waitForPending = (rows) => Promise.all((rows || [])
        .map((row) => pendingWrites.get(Number(row.characterId || 0)))
        .filter(Boolean)
        .map((pending) => pending.catch(() => null)));
    return selectStale()
        .then(waitForPending)
        .then(() => Database.execute([sql, params, { read: true }]))
        .then((rows) => {
            publishDeferredPartyRequests(rows);
            if (rows.length) utils.infoWarn('BotLife', 'deferred %d stale party requests', rows.length);
            return rows.length;
        });
}

function deferUnformablePartyRequests(characterIds = [], reason = 'no_compatible_level_match') {
    const ids = [...new Set((characterIds || []).map((id) => Number(id)).filter(Boolean))].slice(0, 500);
    if (!ids.length) return Promise.resolve(0);

    const timestamp = now();
    const cooldownMs = PartyRequestPlanner.cooldownMs();
    const staggerMs = Math.min(120000, Math.max(0, Math.floor(cooldownMs / 2)));
    const placeholders = ids.map(() => '?').join(', ');
    const selection = `characterId IN (${placeholders})
        AND phase = 'cold'
        AND (partyId IS NULL OR partyId = '')
        AND activity IN ('hunting', 'resting', 'party_wait')
        AND partyRequestStatus = 'open'
        AND partyRequestPriority = 'required'`;
    const selectCurrent = () => Database.execute([
        `SELECT characterId FROM ${TABLE} WHERE ${selection}`,
        ids
    ]);
    const waitForPending = (rows) => Promise.all((rows || [])
        .map((row) => pendingWrites.get(Number(row.characterId || 0)))
        .filter(Boolean)
        .map((pending) => pending.catch(() => null)));
    const sql = `UPDATE ${TABLE}
        SET statsJson = json_set(
                COALESCE(statsJson, '{}'),
                '$.partyRequest.status', 'deferred',
                '$.partyRequest.deferredUntil', ? + (ABS(characterId) % ?),
                '$.partyRequest.expiredAt', ?,
                '$.partyRequest.attempts', COALESCE(CAST(json_extract(statsJson, '$.partyRequest.attempts') AS INTEGER), 0) + 1,
                '$.partyRequest.lastReason', ?
            ),
            simulationRevision = COALESCE(simulationRevision, 0) + 1,
            updatedAt = ?
        WHERE ${selection} RETURNING *`;
    const params = [
        timestamp + cooldownMs,
        Math.max(1, staggerMs),
        timestamp,
        String(reason || 'no_compatible_level_match'),
        timestamp,
        ...ids
    ];
    return selectCurrent()
        .then(waitForPending)
        .then(() => Database.execute([sql, params, { read: true }]))
        .then((rows) => {
            publishDeferredPartyRequests(rows);
            if (rows.length) utils.infoWarn('BotLife', 'deferred %d unformable party requests reason=%s', rows.length, String(reason || 'unknown'));
            return rows.length;
        });
}

function discardInvalidEquipmentPlans() {
    const timestamp = now();
    // Wish-network plans persist identity and slot, not redundant catalog
    // labels. A missing saved name must not erase a valid goal and its inputs.
    const validTargets = (DataCache.items || []).filter(GearAcquisitionPlanner.isRealCatalogItem)
        .map(item => Number(item.selfId));
    return Database.execute([
        `UPDATE ${TABLE}
        SET statsJson = json_remove(COALESCE(statsJson, '{}'), '$.equipmentPlan', '$.partyRequest', '$.clanPartyObjective'),
            updatedAt = ?
        WHERE json_extract(statsJson, '$.equipmentPlan.target') IS NOT NULL
        AND (
            COALESCE(CAST(json_extract(statsJson, '$.equipmentPlan.target.selfId') AS INTEGER), 0) <= 0
            OR (
                json_extract(statsJson, '$.equipmentPlan.status') = 'active'
                AND json_extract(statsJson, '$.equipmentPlan.expectedKills') IS NOT NULL
                AND COALESCE(CAST(json_extract(statsJson, '$.equipmentPlan.rateModelVersion') AS INTEGER), 0) < ?
                AND (
                    activity = 'hunting'
                    OR COALESCE(CAST(json_extract(statsJson, '$.equipmentPlan.clanGoal.clanId') AS INTEGER), 0) > 0
                )
            )
            OR CAST(json_extract(statsJson, '$.equipmentPlan.target.selfId') AS INTEGER)
                NOT IN (SELECT CAST(value AS INTEGER) FROM json_each(?))
        )`,
        [timestamp, GearAcquisitionPlanner.RATE_MODEL_VERSION, JSON.stringify(validTargets)]
    ]).then((result) => {
        const discarded = Number(result?.affectedRows || 0);
        if (discarded > 0) {
            utils.infoWarn('BotLife', 'discarded %d invalid or stale equipment plans on startup', discarded);
        }
        return discarded;
    });
}

function discardFulfilledEquipmentPlans() {
    const timestamp = now();
    return Database.execute([
        `WITH plan_targets AS (
            SELECT characterId,
                CAST(json_extract(statsJson, '$.equipmentPlan.target.selfId') AS INTEGER) AS targetId,
                CAST(json_extract(statsJson, '$.equipmentPlan.target.slot') AS INTEGER) AS targetSlot,
                COALESCE(CAST(json_extract(statsJson, '$.equipmentPlan.combine.resultId') AS INTEGER), 0) AS combineResultId,
                '$."' || CAST(json_extract(statsJson, '$.equipmentPlan.target.selfId') AS INTEGER) || '"' AS inventoryPath
            FROM ${TABLE}
            WHERE CAST(json_extract(statsJson, '$.equipmentPlan.target.selfId') AS INTEGER) > 0
              AND CAST(json_extract(statsJson, '$.equipmentPlan.target.slot') AS INTEGER) > 0
        ), fulfilled_equipment_plans AS (
            SELECT targets.characterId
            FROM plan_targets targets
            INNER JOIN ${TABLE} states ON states.characterId = targets.characterId
            WHERE (targets.combineResultId <= 0 OR targets.targetId = targets.combineResultId)
              AND CAST(json_extract(states.inventorySummary, targets.inventoryPath || '.equipped') AS INTEGER) = 1
              AND (
                CAST(json_extract(states.inventorySummary, targets.inventoryPath || '.slot') AS INTEGER) = targets.targetSlot
                OR (
                    targets.targetSlot IN (7, 14)
                    AND CAST(json_extract(states.inventorySummary, targets.inventoryPath || '.slot') AS INTEGER) IN (7, 14)
                )
                OR EXISTS (
                    SELECT 1
                    FROM json_each(COALESCE(json_extract(states.inventorySummary, targets.inventoryPath || '.equippedSlots'), '[]')) slots
                    WHERE CAST(slots.value AS INTEGER) = targets.targetSlot
                       OR targets.targetSlot IN (7, 14) AND CAST(slots.value AS INTEGER) IN (7, 14)
                )
              )
        )
        UPDATE ${TABLE}
        SET statsJson = json_remove(COALESCE(statsJson, '{}'), '$.equipmentPlan', '$.partyRequest', '$.clanPartyObjective'),
            updatedAt = ?
        WHERE characterId IN (SELECT characterId FROM fulfilled_equipment_plans)`,
        [timestamp]
    ]).then((result) => {
        const discarded = Number(result?.affectedRows || 0);
        if (discarded > 0) {
            utils.infoWarn('BotLife', 'discarded %d fulfilled equipment plans on startup', discarded);
        }
        return discarded;
    });
}

function reconcilePersistedLoadouts() {
    // Startup runs before workers/actors publish: repair legacy hand conflicts
    // through the same class-aware optimizer used by normal cold equipment.
    const affected = [...cache.values()].filter((state) => hasIncompatibleShield(state) || hasConflictingWeapons(state));
    let reconciledCount = 0;
    return affected.reduce((chain, state) => chain.then(() => {
        const reconciled = reconcileIncompatibleShieldState(state);
        const row = rowFromState(reconciled);
        return save(row)
            .then(() => syncInventorySummary(row.characterId, reconciled.inventory, 'loadout_reconcile'))
            .then(() => {
                cache.set(row.characterId, normalize(row));
                reconciledCount += 1;
            })
            .catch((err) => {
                utils.infoWarn('BotLife', 'failed loadout reconciliation for %d: %s', row.characterId, err.message);
            });
    }), Promise.resolve()).then(() => {
        if (reconciledCount > 0) {
            utils.infoWarn('BotLife', 'reconciled %d conflicting persisted weapons or incompatible shield loadouts on startup', reconciledCount);
        }
        return reconciledCount;
    });
}

const BotLifeState = {
    notifyNearFacts,

    // Boot only: { startedAt, downtimeMs } of this restart, measured once (L136).
    bootPause() {
        return measureBootPause();
    },

    passiveWorkerStateSources(role) {
        if (!workerProjectorRole || role !== workerProjectorRole || initialized || initStarted) {
            throw new TypeError('invalid_worker_projector_role');
        }
        return cache.passiveWorkerStateSources(role);
    },

    init() {
        if (workerProjectorRole) return Promise.reject(new TypeError('worker_projector_lifecycle_init'));
        if (initialized) return Promise.resolve(true);
        if (initStarted) return initPromise;
        initStarted = true;

        initPromise = Database.execute(['SELECT 1', []], 'schema:bot-life')
            .then(() => shiftDueTimesByDowntime())
            .then(() => Database.fetchBotMarketCounts()).then((rows) => {
                marketCounts.clear();
                for (const row of rows) {
                    const counts = marketCounts.get(Number(row.characterId)) || {};
                    counts[row.counter] = Number(row.deals);
                    marketCounts.set(Number(row.characterId), counts);
                }
            })
            .then(() => invoke('GameServer/Clan/ClanSupplyPolicy').init())
            .then(() => Database.reconcileBotClanMembership()).then(({ repairedMembers, repairedParties }) => {
                if (repairedMembers || repairedParties) {
                    utils.infoWarn('BotLife', 'reconciled clan membership and crafting goals: bots=%d parties=%d', repairedMembers, repairedParties);
                }
            })
            .then(() => Database.execute([`UPDATE ${TABLE}
                SET statsJson = json_set(COALESCE(statsJson, '{}'), '$.karma',
                    (SELECT karma FROM characters WHERE id = characterId))
                WHERE COALESCE(json_extract(statsJson, '$.karma'), 0)
                    <> (SELECT karma FROM characters WHERE id = characterId)`, []]))
            .then(() => Database.reconcileBotClanGoals?.()).then(() => removeRetiredStaticMerchantStates()).then(() => Database.recoverConstPartyActivities()).then(() => recoverStaleHotStates()).then(() => recoverDissolvedPartyMembers()).then(() => recoverStaleCraftWaits()).then(() => migrateAcquisitionPartyWaits()).then(() => clearPassivePartyRequests()).then(() => expireStalePartyRequests()).then(() => discardInvalidEquipmentPlans()).then(() => discardFulfilledEquipmentPlans()).then(() => hydrateCache()).then((count) => {
            const repairs = [...cache.values()]
                .map(canonicalizeAreaState)
                .map(recoverOrphanedGiranState)
                .filter((state) => state !== cache.get(state.characterId));
            return repairs.reduce((chain, state) => chain.then(() => {
                const row = rowFromState(state);
                // The next activation reads characters.loc*, not only the
                // lifecycle row.  Repair both stores or an old Giran
                // coordinate brings the visible bot pile back after restart.
                return save(row)
                    .then(() => Database.updateCharacterLocation(row.characterId, {
                        locX: row.locX,
                        locY: row.locY,
                        locZ: row.locZ
                    }))
                    .then(() => {
                        // Publish the saved checkpoint, including its new
                        // updatedAt. The pre-save state makes every native
                        // worker command stale against the repaired SQL row.
                        cache.set(state.characterId, normalize(row));
                    });
            }), Promise.resolve())
                .then(() => reconcilePersistedLoadouts())
                .then(() => count);
        }).then((count) => {
            initialized = true;
            utils.infoSuccess('BotLife', 'state table ready states=%d', count);
            return true;
        }).catch((err) => {
            utils.infoWarn('BotLife', 'state table unavailable: %s', err.message);
            return false;
        });

        return initPromise;
    },

    async settleWrites(ids) {
        await Promise.all(ids.map(id => pendingWrites.get(Number(id)) || Promise.resolve()));
    },

    releasePlayerPartyTakeover(session) {
        const id = Number(session?.actor?.fetchId?.());
        const takeover = session?.coldLifeState?.stats?.playerPartyTakeover
            || cache.get(id)?.stats?.playerPartyTakeover;
        if (!takeover?.playerId || session.partyCompanion || session.followPlayerSession) return Promise.resolve(null);
        // Later hot/cold snapshots must not revive an ownership marker whose
        // departure is already queued. Earlier writes settle before the patch.
        for (const key of ['coldLifeState', 'coldMarketState', 'coldCraftState']) {
            if (!session[key]?.stats?.playerPartyTakeover) continue;
            const stats = { ...session[key].stats, leaderId: null };
            delete stats.playerPartyTakeover;
            session[key] = { ...session[key], stats };
        }
        const previous = pendingWrites.get(id) || Promise.resolve();
        const next = previous.then(() => Database.releasePlayerPartyTakeover({
            characterId: id, playerId: takeover.playerId, partyId: takeover.partyId,
            isDetached: () => !session.partyCompanion && !session.followPlayerSession && !session.hotBackgroundPartyId
        })).then((row) => {
            if (!row) return null;
            const snapshot = this.acceptLifecycleRow(row);
            if (!session.partyCompanion && !session.followPlayerSession) session.coldLifeState = snapshot;
            return snapshot;
        }).catch((error) => {
            utils.infoWarn('BotLife', 'failed to release player party for %s: %s', id, error.message);
            return null;
        });
        const tracked = next.finally(() => {
            if (pendingWrites.get(id) === tracked) pendingWrites.delete(id);
        });
        pendingWrites.set(id, tracked);
        return next;
    },

    // Accept a row another transaction wrote for this bot, unless the cache already
    // holds a newer cold revision of it.
    acceptNewerLifecycleRow(row) {
        if (!row) return null;
        const current = cache.get(Number(row.characterId));
        if (current && (current.phase !== 'cold' || Number(current.simulation?.revision || 0) > Number(row.simulationRevision))) return null;
        return this.acceptLifecycleRow(row);
    },

    // A command refused because the row moved past the cache (NativeWriteCheckpoint
    // drift): the row is the owner of the checkpoint; read it back so the next
    // command carries it instead of retrying the same stale copy forever (L127).
    // A handoff in flight is published by its owner, not here.
    reloadRow(characterId, drift = []) {
        const id = Number(characterId);
        if (drift.includes('phase')) return Promise.resolve(null);
        return Database.execute(['SELECT * FROM bot_life_state WHERE characterId = ? LIMIT 1', [id]], 'bot-life:reload').then(([row]) => {
            if (!row || row.phase !== 'cold') return null;
            if (Diagnostics.active()) Diagnostics.count('command', 'checkpoint_reload', drift.join(','));
            return this.acceptNewerLifecycleRow(row);
        });
    },

    acceptLifecycleRow(row) {
        const snapshot = normalize(row);
        const current = cache.get(snapshot.characterId);
        if (Number(current?.simulation?.revision || 0) > Number(snapshot.simulation?.revision || 0)) return current;
        if (row.acceptedIncoming === undefined && current?.acceptedIncoming) {
            snapshot.acceptedIncoming = current.acceptedIncoming;
            if (current.incomingPending) snapshot.incomingPending = true;
        }
        if (Number(current?.stats?.clanLevelSpVersion || 0) > Number(snapshot.stats?.clanLevelSpVersion || 0)) return current;
        cache.set(snapshot.characterId, snapshot);
        notifyMarketReviewState(snapshot, current);
        if (snapshot.incomingPending !== current?.incomingPending || JSON.stringify(snapshot.acceptedIncoming) !== JSON.stringify(current?.acceptedIncoming || {}))
            notifyColdSnapshot(snapshot, 'trade_incoming', { critical: true });
        invoke('GameServer/Clan/ClanService').syncColdMember(snapshot);
        return snapshot;
    },

    // Warehouse transfers patch the physical projection repeatedly; their stats
    // stay untouched until the one final metadata patch.
    acceptInventoryProjection(row) {
        const current = cache.get(Number(row?.characterId));
        if (!current || !row?.inventoryPatch || current.phase !== row.phase
            || Number(current.simulation?.revision || 0) >= Number(row.simulationRevision)) return current || null;
        const inventory = { ...current.inventory };
        for (const [id, item] of Object.entries(row.inventoryPatch)) {
            if (item) inventory[id] = item;
            else delete inventory[id];
        }
        const snapshot = { ...current, inventory, adena: Number(row.adena),
            ...(row.acceptedIncoming !== undefined ? { acceptedIncoming: row.acceptedIncoming || {} } : {}),
            vitals: { ...current.vitals, mp: Number(row.mp) }, updatedAt: Number(row.updatedAt),
            simulation: { ...current.simulation, revision: Number(row.simulationRevision) } };
        if (row.acceptedIncoming !== undefined) {
            if (row.incomingPending) snapshot.incomingPending = true;
            else delete snapshot.incomingPending;
        }
        cache.set(snapshot.characterId, snapshot);
        notifyMarketReviewState(snapshot, current);
        invoke('GameServer/Clan/ClanService').syncColdMember(snapshot);
        return snapshot;
    },

    // The clan's market demand lives in its leader's row; the write moves that
    // row, so the cached copy takes it back (else the leader's next claim is
    // refused once on the old revision).
    syncClanMarketDemandSignal(signal) {
        return Database.syncClanMarketDemandSignal(signal).then((result) => {
            if (result?.row) this.acceptNewerLifecycleRow(result.row);
            return result;
        });
    },

    acceptWarehouseWithdrawal(row) {
        const current = cache.get(Number(row?.characterId));
        if (!current) return null;
        if (Number(current.stats?.lastWarehouseWithdrawal?.at || 0) > Number(row.withdrawal.at)) return current;
        const newerTiming = Number(current.simulation?.revision || 0) > Number(row.simulationRevision)
            || Number(current.updatedAt || 0) > Number(row.updatedAt);
        const snapshot = { ...current, simulation: movedSimulation(current, row),
            stats: { ...current.stats, lastWarehouseWithdrawal: row.withdrawal, ...(row.market ? { marketSellRetryAfter: null } : {}) },
            timing: newerTiming ? current.timing : { ...current.timing, nextResolveAt: row.nextResolveAt ? Number(row.nextResolveAt) : null } };
        cache.set(snapshot.characterId, snapshot);
        notifyColdSnapshot(snapshot, 'cold_warehouse_withdrawal');
        return snapshot;
    },

    // A committed deal publishes only learning here. A cold worker keeps its
    // inventory; delayed postcommit handlers cannot rewind later counts.
    acceptMarketTrades(characterId, counts) {
        const id = Number(characterId);
        const merged = { ...(marketCounts.get(id) || {}) };
        for (const [key, value] of Object.entries(counts)) merged[key] = Math.max(Number(merged[key] || 0), Number(value));
        marketCounts.set(id, merged);
        const current = cache.get(id);
        if (!current) return null;
        const snapshot = { ...current, marketTrades: merged };
        cache.set(id, snapshot);
        return snapshot;
    },

    partySessionSnapshot(session, state, phase, reason) {
        const snapshot = mergeSessionIntoLifeState(session, state, phase, reason, { physicalLocation: true });
        snapshot.activity = 'grouped';
        snapshot.spotId = state.spotId;
        snapshot.party = { ...state.party };
        snapshot.stats = { ...snapshot.stats, role: state.party.role, leaderId: state.party.leaderId };
        return snapshot;
    },

    markHot(session, reason = 'hot') {
        if (!session || !session.actor) return Promise.resolve(null);

        const preservedState = session.coldLifeState;
        const row = preservedState
            ? rowFromState(mergeSessionIntoLifeState(session, preservedState, 'hot', reason, {
                // The activation position can be deliberately near a player.
                // It is not the bot's durable background location.
                loc: preservedState.loc
            }))
            : recordFromSession(session, 'hot', reason);
        const craftState = refreshCraftShop(session.coldCraftState);
        if (craftState?.stats?.craftShop) {
            row.activity = 'crafting';
            row.currentRegion = craftState.currentRegion || row.currentRegion;
            row.spotId = craftState.spotId || row.spotId;
            Object.assign(row, SavedStats.statsColumns({ ...(craftState.stats || {}),
                pvpEnemies: BotEnemyMemory.snapshot(session), lastReason: reason }));
        }
        const characterId = row.characterId;
        const previous = pendingWrites.get(characterId) || Promise.resolve();
        const ready = initialized ? Promise.resolve(true) : this.init();
        const next = previous.then(() => ready).then((isReady) => {
            if (!isReady) {
                throw new Error('state table unavailable');
            }
            return save(row);
        }).then(() => {
            const snapshot = normalize(row);
            const current = cache.get(characterId);
            cache.set(characterId, snapshot);
            setSessionSnapshotsAuthority(session, snapshot);
            notifyMarketReviewState(snapshot, current);
            // The kernel's fence removed the far record: this post gives the
            // near bot its slot back at the next snapshot page ('activated'
            // is not critical, so it waits for the page, not a flush).
            notifyNearFacts(session, 'activated');
            return snapshot;
        }).catch((err) => {
            utils.infoWarn('BotLife', 'failed to mark %s hot: %s', row.characterName, err.message);
            return null;
        });

        const tracked = next.finally(() => {
            if (pendingWrites.get(characterId) === tracked) {
                pendingWrites.delete(characterId);
            }
        });
        pendingWrites.set(characterId, tracked);
        return next;
    },

    markCold(session, reason = 'cooldown') {
        return this.writeColdRow(session, reason).then((saved) => {
            if (saved) setSessionSnapshotsAuthority(session, saved);
            return saved;
        });
    },

    // markCold's write: the next cold row built from the actor or its craft state.
    writeColdRow(session, reason = 'cooldown') {
        if (!session || !session.actor) return Promise.resolve(null);

        const membership = cache.get(Number(session.actor.fetchId()))?.stats;
        const membershipStats = membership?.clanMembershipVersion ? {
            clanId: membership.clanId,
            clanMembershipVersion: membership.clanMembershipVersion,
            clanDiscipline: membership.clanDiscipline
        } : {};
        const craftState = refreshCraftShop(session.coldCraftState);
        if (craftState?.stats?.craftShop) {
            const row = recordFromSession(session, 'cold', reason);
            const craftShop = craftState.stats.craftShop;
            const nextState = {
                ...craftState,
                level: row.level,
                exp: row.exp,
                sp: row.sp,
                adena: row.adena,
                phase: 'cold',
                activity: 'crafting',
                currentRegion: craftState.currentRegion || craftShop.town || 'Giran',
                loc: { ...(craftShop.loc || craftState.loc || {}) },
                vitals: { hp: row.hp, maxHp: row.maxHp, mp: row.mp, maxMp: row.maxMp },
                timing: {
                    ...(craftState.timing || {}),
                    activityStartedAt: now(),
                    nextResolveAt: null,
                    // The hot time is lived: the first cold step starts now (T126).
                    lastResolvedAt: now()
                },
                stats: { ...(craftState.stats || {}), ...membershipStats, pvpEnemies: BotEnemyMemory.snapshot(session), lastReason: reason },
                inventory: parseJson(row.inventorySummary, {})
            };
            // Built without mergeSessionIntoLifeState: the near raise joins here.
            DecisionEvents.applyPendingRaise(session, nextState.stats);
            return this.upsertState(nextState, reason, { releaseHot: true });
        }

        if (session.coldLifeState) {
            const physicalLocation = session.populationLocationPolicy === 'physical';
            const preserved = physicalLocation ? session.coldLifeState : recoverOrphanedGiranState(session.coldLifeState);
            const nextState = mergeSessionIntoLifeState(session, preserved, 'cold', reason, {
                physicalLocation,
                loc: preserved.loc,
                nextResolveAt: now() + 30000 + Math.round(Math.random() * 90000),
                // The hot time is lived: the first cold step's length starts now (T126).
                lastResolvedAt: now()
            });
            session.coldLifeState = nextState;
            RefreshPartyMemberships([session], invoke);
            return this.upsertState(nextState, reason, { releaseHot: true });
        }

        const row = {
            ...recordFromSession(session, 'cold', reason),
            nextResolveAt: now() + 30000 + Math.round(Math.random() * 90000),
            lastResolvedAt: now()
        };
        const characterId = row.characterId;
        const previous = pendingWrites.get(characterId) || Promise.resolve();
        const ready = initialized ? Promise.resolve(true) : this.init();
        const next = previous.then(() => ready).then((isReady) => {
            if (!isReady) {
                throw new Error('state table unavailable');
            }
            return save(row, { releaseHot: true });
        }).then(() => Database.updateCharacterLocation(row.characterId, {
            locX: row.locX,
            locY: row.locY,
            locZ: row.locZ
        })).then(() => Database.updateCharacterExperience(row.characterId, row.level, row.exp, row.sp))
            .then(() => Database.updateCharacterVitals(row.characterId, row.hp, row.maxHp, row.mp, row.maxMp))
            .then(() => {
                const snapshot = normalize(row);
                const current = cache.get(characterId);
                cache.set(characterId, snapshot);
                notifyMarketReviewState(snapshot, current);
                return snapshot;
            }).catch((err) => {
                utils.infoWarn('BotLife', 'failed to mark %s cold: %s', row.characterName, err.message);
                return null;
            });

        const tracked = next.finally(() => {
            if (pendingWrites.get(characterId) === tracked) {
                pendingWrites.delete(characterId);
            }
        });
        pendingWrites.set(characterId, tracked);
        return next;
    },

    snapshot(characterId) {
        return cache.get(Number(characterId)) || null;
    },

    // The row of a bot that is in the world as an actor, else null. A hot row
    // belongs to the actor: the AFK sync and the cold market jobs never write
    // a cold state over it (markCold writes the next cold state).
    hotRow(characterId) {
        const current = cache.get(Number(characterId));
        return current?.phase === 'hot' ? current : null;
    },

    findByCharacterId(characterId) {
        const id = Number(characterId);
        if (!Number.isSafeInteger(id) || id <= 0) return Promise.resolve(null);
        const cached = cache.get(id);
        if (cached) return Promise.resolve(cached);
        if (!initialized) return Promise.resolve(null);

        return Database.execute([
            `SELECT * FROM ${TABLE} WHERE characterId = ? LIMIT 1`,
            [id]
        ]).then((rows) => {
            if (!rows[0]) return null;
            const state = normalize(rows[0]);
            cache.set(state.characterId, state);
            return state;
        }).catch(() => null);
    },

    findByName(name) {
        const lookup = String(name || '').toLowerCase();
        for (const state of cache.values()) {
            if (String(state.name || '').toLowerCase() === lookup) return Promise.resolve(state);
        }

        if (!initialized || !lookup) return Promise.resolve(null);
        return Database.execute([
            `SELECT * FROM ${TABLE} WHERE LOWER(characterName) = ? LIMIT 1`,
            [lookup]
        ]).then((rows) => {
            if (!rows[0]) return null;
            const state = normalize(rows[0]);
            cache.set(state.characterId, state);
            return state;
        }).catch(() => null);
    },

    coldNear(loc, radius, limit = 10) {
        if (!initialized || !loc) return Promise.resolve([]);
        const safeRadius = Math.max(1, Number(radius) || CLIENT_VISIBILITY_RADIUS);
        const safeLimit = Math.max(1, Math.min(100, Number(limit) || 10));
        return Promise.resolve(cache.near(loc, safeRadius, safeLimit));
    },

    // Cold walkers near a point (honest travel): LifeStateCache.walkersNear.
    walkersNear(loc, radius, at = now()) {
        if (!initialized || !loc) return [];
        return cache.walkersNear(loc, Math.max(1, Number(radius) || CLIENT_VISIBILITY_RADIUS), at);
    },

    walkerCount() {
        return cache.walkers.size;
    },

    pendingClassProgressionMigration() { return classMigrationCandidates.size; },

    subscribeClassProgressionMigration(listener) {
        classMigrationListeners.add(listener);
        return () => classMigrationListeners.delete(listener);
    },

    migrateLegacyClassProgression(limit = 5) {
        if (!initialized) return Promise.resolve([]);
        const safeLimit = Math.max(1, Math.min(20, Number(limit) || 5));
        const ids = [];
        for (const id of classMigrationCandidates.keys()) { ids.push(id); if (ids.length >= safeLimit) break; }
        // A pending native write is not an attempted migration. Keep that
        // candidate for the next bounded pass after its write settles.
        for (const id of ids) if (!pendingWrites.has(id)) classMigrationCandidates.delete(id);
        notifyClassMigrationPending();
        const candidates = ids.map(id => cache.get(id))
            .filter(state => state?.phase === 'cold' && !pendingWrites.has(state.characterId));

        return candidates.reduce((chain, state) => chain.then((migrated) => (
            Database.execute([
                'SELECT id, classId, level, exp, sp FROM characters WHERE id = ? LIMIT 1',
                [state.characterId]
            ]).then((rows) => {
                const character = rows[0];
                if (!character) return migrated;
                return applyClassProgression(state, character).then((progressedState) => {
                    if (progressedState === state) return migrated;
                    const row = rowFromState(progressedState);
                    return save(row).then(() => {
                        const snapshot = normalize(row);
                        cache.set(snapshot.characterId, snapshot);
                        return [...migrated, snapshot];
                    });
                });
            }).catch((err) => {
                utils.infoWarn('BotLife', 'legacy class progression failed for %s: %s', state.name, err.message);
                return migrated;
            })
        )), Promise.resolve([]));
    },

    migrateLegacyColdCombatProfiles(limit = 5) {
        if (!initialized) return Promise.resolve([]);
        const safeLimit = Math.max(1, Math.min(20, Number(limit) || 5));
        const candidates = Array.from(cache.values())
            .filter((state) => state.phase === 'cold')
            // Profiles made by the first cold resolver used the class tree
            // before this migration existed.  They have a profile but not an
            // authoritative skill source, so replace their skills once too.
            .filter((state) => ColdCombatProfile.needsDatabaseBackfill(state.stats?.coldCombat))
            .filter((state) => !pendingWrites.has(state.characterId))
            .sort((a, b) => Number(a.updatedAt || 0) - Number(b.updatedAt || 0))
            .slice(0, safeLimit);

        return candidates.reduce((chain, state) => chain.then((migrated) => (
            Database.fetchSkills(state.characterId).then((skills) => {
                const nextState = {
                    ...state,
                    stats: {
                        ...(state.stats || {}),
                        coldCombat: ColdCombatProfile.legacySnapshot(state, skills, now())
                    },
                    updatedAt: now()
                };
                const row = rowFromState(nextState);
                return save(row).then(() => {
                    const snapshot = normalize(row);
                    cache.set(snapshot.characterId, snapshot);
                    return [...migrated, snapshot];
                });
            }).catch((err) => {
                utils.infoWarn('BotLife', 'legacy cold combat profile failed for %s: %s', state.name, err.message);
                return migrated;
            })
        )), Promise.resolve([]));
    },

    statesForParty(partyId) {
        if (!initialized || !partyId) return Promise.resolve([]);

        return Database.execute([
            `SELECT * FROM ${TABLE}
            WHERE phase = 'cold'
            AND partyId = ?
            ORDER BY level DESC, characterId ASC`,
            [partyId]
        ]).then((rows) => rows.map((row) => {
            const state = normalize(row);
            cache.set(state.characterId, state);
            return state;
        })).catch((err) => {
            utils.infoWarn('BotLife', 'failed to fetch party %s states: %s', partyId, err.message);
            return [];
        });
    },

    coldPartyCandidates(limit = 80, partyRequiredOnly = false) {
        if (!initialized) return Promise.resolve([]);
        const safeLimit = Math.max(1, Math.min(500, Number(limit) || 80));
        const activityClause = partyRequiredOnly
            ? `activity IN ('hunting', 'resting', 'party_wait')
                AND partyRequestStatus = 'open'
                AND partyRequestPriority = 'required'`
            : "activity IN ('hunting', 'resting', 'party_wait')";

        return Database.execute([
            `WITH eligible AS MATERIALIZED (
                SELECT characterId, partyObjectiveSpot AS candidateSpot,
                    partyRequestStatus, partyRequestPriority, updatedAt, level
                FROM ${TABLE}
                WHERE phase = 'cold'
                AND (partyId IS NULL OR partyId = '')
                AND spotId IS NOT NULL
                AND ${activityClause}
            ), party_spots AS MATERIALIZED (
                SELECT candidateSpot, COUNT(*) AS candidateCount, MIN(updatedAt) AS oldestAt
                FROM eligible
                GROUP BY candidateSpot
            ), ranked AS MATERIALIZED (
                SELECT eligible.characterId,
                    CASE
                        WHEN eligible.partyRequestStatus = 'open'
                            AND eligible.partyRequestPriority = 'required' THEN 0
                        WHEN eligible.partyRequestStatus = 'open' THEN 1
                        ELSE 2
                    END AS requestRank,
                    party_spots.candidateCount, party_spots.oldestAt,
                    eligible.level, eligible.updatedAt
                FROM eligible
                INNER JOIN party_spots ON party_spots.candidateSpot = eligible.candidateSpot
                ORDER BY requestRank ASC,
                    party_spots.candidateCount DESC, party_spots.oldestAt ASC,
                    eligible.level ASC, eligible.updatedAt ASC
                LIMIT ${safeLimit}
            )
            SELECT states.* FROM ranked
            INNER JOIN ${TABLE} states ON states.characterId = ranked.characterId
            ORDER BY ranked.requestRank ASC,
                ranked.candidateCount DESC, ranked.oldestAt ASC,
                ranked.level ASC, ranked.updatedAt ASC`,
            [],
            { read: true }
        ]).then((rows) => rows.map((row) => {
            const state = normalize(row);
            cache.set(state.characterId, state);
            return state;
        })).catch((err) => {
            utils.infoWarn('BotLife', 'failed to fetch party candidates: %s', err.message);
            return [];
        });
    },

    cachedStatesForParties(parties = []) {
        // The write-behind cache owns the newest member state. No publication or database read occurs here.
        return new Map(parties.map(party => [String(party.partyId), (party.memberIds || [])
            .map(id => cache.get(Number(id)))
            .filter(state => state?.phase === 'cold' && String(state.party?.partyId || '') === String(party.partyId))
            .sort((a, b) => Number(b.level) - Number(a.level) || Number(a.characterId) - Number(b.characterId))]));
    },

    coldPartyCandidateCount(partyRequiredOnly = false) {
        if (!initialized) return Promise.resolve(0);
        const activityClause = partyRequiredOnly
            ? `activity IN ('hunting', 'resting', 'party_wait')
                AND partyRequestStatus = 'open'
                AND partyRequestPriority = 'required'`
            : "activity IN ('hunting', 'resting', 'party_wait')";

        return Database.execute([
            `SELECT COUNT(*) AS candidateCount FROM ${TABLE}
            WHERE phase = 'cold'
            AND (partyId IS NULL OR partyId = '')
            AND spotId IS NOT NULL
            AND ${activityClause}`,
            []
        ]).then((rows) => Number(rows[0]?.candidateCount || 0)).catch((err) => {
            utils.infoWarn('BotLife', 'failed to count party candidates: %s', err.message);
            return 0;
        });
    },

    coldPartyCandidatesForSpots(spotIds = [], limitPerSpot = 40, partyRequiredOnly = false) {
        if (!initialized) return Promise.resolve([]);
        const uniqueSpots = Array.from(new Set((spotIds || []).map((spotId) => String(spotId || '')).filter(Boolean)));
        if (!uniqueSpots.length) return Promise.resolve([]);
        const safeLimit = Math.max(1, Math.min(100, Number(limitPerSpot) || 40));
        const placeholders = uniqueSpots.map(() => '?').join(', ');
        const activityClause = partyRequiredOnly
            ? `activity IN ('hunting', 'resting', 'party_wait')
                AND partyRequestStatus = 'open'
                AND partyRequestPriority = 'required'`
            : "activity IN ('hunting', 'resting', 'party_wait')";

        return Database.execute([
            `WITH ranked AS MATERIALIZED (
                SELECT characterId, partyObjectiveSpot,
                    ROW_NUMBER() OVER (
                        PARTITION BY partyObjectiveSpot
                        ORDER BY updatedAt ASC, level ASC, characterId ASC
                    ) AS candidateRank
                FROM ${TABLE}
                WHERE phase = 'cold'
                AND (partyId IS NULL OR partyId = '')
                AND partyObjectiveSpot IN (${placeholders})
                AND ${activityClause}
            ), selected AS MATERIALIZED (
                SELECT characterId, partyObjectiveSpot, candidateRank
                FROM ranked
                WHERE candidateRank <= ${safeLimit}
            )
            SELECT states.* FROM selected
            INNER JOIN ${TABLE} states ON states.characterId = selected.characterId
            ORDER BY selected.partyObjectiveSpot ASC, selected.candidateRank ASC`,
            uniqueSpots,
            { read: true }
        ]).then((rows) => rows.map((row) => {
            const state = normalize(row);
            cache.set(state.characterId, state);
            return state;
        })).catch((err) => {
            utils.infoWarn('BotLife', 'failed to fetch party candidates by spot: %s', err.message);
            return [];
        });
    },

    partyRequirementCounts(partyIds = []) {
        if (!initialized) return Promise.resolve([]);
        const ids = Array.from(new Set((partyIds || []).map((partyId) => String(partyId || '')).filter(Boolean)));
        if (!ids.length) return Promise.resolve([]);
        const placeholders = ids.map(() => '?').join(', ');

        return Database.execute([
            `SELECT partyId,
                COUNT(*) AS memberCount,
                SUM(CASE WHEN json_extract(statsJson, '$.equipmentPlan.requiresParty') = 1 THEN 1 ELSE 0 END) AS requiredMembers,
                MIN(updatedAt) AS oldestAt
            FROM ${TABLE}
            WHERE phase = 'cold'
            AND partyId IN (${placeholders})
            GROUP BY partyId`,
            ids
        ]).then((rows) => rows.map((row) => ({
            partyId: String(row.partyId || ''),
            memberCount: Number(row.memberCount || 0),
            requiredMembers: Number(row.requiredMembers || 0),
            oldestAt: Number(row.oldestAt || 0)
        }))).catch((err) => {
            utils.infoWarn('BotLife', 'failed to count party requirements: %s', err.message);
            return [];
        });
    },

    preparePartyReview(state, nextState) {
        if (!state?.party?.partyId || state.characterId !== nextState?.characterId) return null;
        const row = rowFromState({ ...nextState, updatedAt: now() });
        return { row, snapshot: normalize(row), expectedUpdatedAt: Number(state.updatedAt || 0),
            expectedPartyId: state.party.partyId };
    },

    preparePartyAssignment(state, partyId, role = 'dps', leaderId = 0, partyNextResolveAt = null) {
        if (!state || !partyId) return null;
        const hasPartyRequest = state.stats?.partyRequest?.status === 'open';
        const wasWaitingForParty = state.activity === 'party_wait'
            || state.stats?.lastReason === 'acquisition_party_wait'
            || (hasPartyRequest && state.activity !== 'resting');
        const timestamp = now();
        const scheduledPartyAt = Number(partyNextResolveAt || 0);
        const nextState = {
            ...state,
            activity: wasWaitingForParty ? 'grouped' : state.activity,
            party: {
                ...(state.party || {}),
                partyId,
                role,
                leaderId
            },
            stats: {
                ...(state.stats || {}),
                role,
                leaderId,
                backgroundPartyId: partyId,
                partyWaitUntil: null,
                restUntil: wasWaitingForParty ? null : state.stats?.restUntil || null,
                lastReason: wasWaitingForParty ? 'party_assigned' : state.stats?.lastReason,
                partyRequest: null
            },
            timing: {
                ...(state.timing || {}),
                activityStartedAt: wasWaitingForParty ? timestamp : state.timing?.activityStartedAt,
                nextResolveAt: wasWaitingForParty
                    ? (scheduledPartyAt > 0 ? scheduledPartyAt : timestamp + 1000)
                    : state.timing?.nextResolveAt
            },
            updatedAt: timestamp
        };
        const row = rowFromState(nextState);
        return {
            row,
            snapshot: normalize(row),
            expectedUpdatedAt: Number(state.updatedAt || 0),
            expectedPartyId: state.party?.partyId || null
        };
    },

    acceptPartyAssignments(prepared = [], committedRows = []) {
        const rows = new Map((committedRows || []).map(row => [Number(row.characterId), row]));
        return (prepared || []).map((entry) => entry?.snapshot).filter(Boolean).map((planned) => {
            const row = rows.get(planned.characterId);
            const snapshot = row ? normalize(row) : planned;
            cache.set(snapshot.characterId, snapshot);
            // Party membership changes the worker scheduling partition. Push
            // the committed state immediately instead of waiting for the old
            // solo due token to discover the assignment through a rejected
            // claim.
            notifyColdSnapshot(snapshot, 'party_assigned', { critical: true });
            return snapshot;
        });
    },

    assignParty(state, partyId, role = 'dps', leaderId = 0, partyNextResolveAt = null) {
        const prepared = this.preparePartyAssignment(state, partyId, role, leaderId, partyNextResolveAt);
        if (!prepared) return Promise.resolve(null);

        return save(prepared.row).then(() => {
            prepared.snapshot = normalize(prepared.row);
            this.acceptPartyAssignments([prepared]);
            return prepared.snapshot;
        }).catch((err) => {
            if (err?.code !== 'BOT_LIFE_STATE_OWNERSHIP_CONFLICT') {
                utils.infoWarn('BotLife', 'failed to assign %s to party %s: %s', state.name, partyId, err.message);
            }
            return null;
        });
    },

    clearParty(partyId, reason = 'party_dissolved') {
        if (!initialized || !partyId) return Promise.resolve(0);

        return this.statesForParty(partyId).then((members) => (
            members.reduce((chain, member) => (
                chain.then((cleared) => this.leaveParty(member, reason)
                    .then((updated) => cleared + (updated ? 1 : 0)))
            ), Promise.resolve(0))
        )).catch((err) => {
            utils.infoWarn('BotLife', 'failed to clear party %s: %s', partyId, err.message);
            return 0;
        });
    },

    releaseDissolvedPartyMembers(partyId, reason = 'orphaned_dissolved_party') {
        if (!initialized || !partyId) return Promise.resolve(0);

        // A runtime party reconciliation can discover members after the
        // party row has already been dissolved. Release every cold member
        // here with the normal party departure transition.
        return this.statesForParty(partyId).then((members) => (
            members.reduce((chain, member) => (
                chain.then((released) => this.leaveParty(member, reason)
                    .then((updated) => released + (updated ? 1 : 0)))
            ), Promise.resolve(0))
        )).catch((err) => {
            utils.infoWarn('BotLife', 'failed to release dissolved party %s: %s', partyId, err.message);
            return 0;
        });
    },

    async prepareResolve(state, result, options = {}) {
        if (!state || !result) return Promise.resolve(null);
        if (workerProjectorRole && (options.persist !== false || options.projectClassProgression !== true)) {
            return Promise.reject(new TypeError('worker_projector_projection_required'));
        }
        const workerOptions = Object.prototype.hasOwnProperty.call(options, 'workerAdmission')
            ? { workerAdmission: options.workerAdmission } : null;

        const timestamp = Number(options.timestamp || now());
        // The row's write stamp (updatedAt), a write-order key main compares:
        // the real now. A far step resolved as of its due, ahead of now
        // (ColdSimulationKernel stepLeadMs), names the real now here.
        const writtenAt = Number(options.writtenAt || timestamp);
        const experienceAward = ProgressionCap.applyAward(state.exp, result.materialize?.exp);
        const progressionLevel = ProgressionCap.levelForExperience(experienceAward.totalExp, Number(state.level || 1));
        let progressionState = { ...state, exp: experienceAward.totalExp, level: progressionLevel };
        const nextDeathsForPenalty = Number(result.patch?.deathCount ?? state.stats?.deaths ?? 0);
        const newDeath = (result.patch?.activity === 'dead' || result.debug?.died === true)
            && nextDeathsForPenalty > Number(state.stats?.deaths || 0);
        if (newDeath) {
            progressionState = invoke('GameServer/Progression/DeathExperience').applyColdDeath(progressionState, {
                timestamp,
                cold: true
            }).state;
        } else if (result.patch?.restoreExpPercent !== undefined) {
            progressionState = invoke('GameServer/Progression/DeathExperience').restoreCold(progressionState, {
                restoreExpPercent: result.patch.restoreExpPercent,
                timestamp
            }).state;
        } else if (result.patch?.clearDeathExperience) {
            progressionState = invoke('GameServer/Progression/DeathExperience')
                .clearCold(progressionState, result.patch.clearDeathExperience);
        }
        const exp = progressionState.exp;
        const sp = Number(state.sp || 0) + Number(result.materialize?.sp || 0);
        const level = progressionState.level;
        const materializedItems = result.materialize?.items || [];
        const materializedAdenaItems = materializedItems
            .filter((item) => Number(item.selfId) === 57)
            .reduce((sum, item) => sum + Number(item.amount || 0), 0);
        const adena = Number(state.adena || 0) + Number(result.materialize?.adena || 0) + materializedAdenaItems;
        const targetCombat = targetCombatTelemetry(state.stats?.targetCombat, result.debug, timestamp);
        const nextSpotId = result.patch?.spotId || state.spotId;
        const previousRisk = state.stats?.spotRisk;
        const previousDeaths = Number(state.stats?.deaths || 0);
        const nextDeaths = Number(result.patch?.deathCount ?? previousDeaths);
        const spotRisk = state.party?.partyId || state.partyId ? previousRisk : SpotRiskPolicy.recordResolve(previousRisk, {
            spotId: nextSpotId || null,
            timestamp,
            totalDeaths: previousDeaths,
            totalFights: Number(state.stats?.fightsResolved || 0),
            totalWins: Number(state.stats?.fightsWon || 0),
            deaths: Math.max(0, nextDeaths - previousDeaths),
            fights: Number(result.debug?.fights || 0),
            wins: Number(result.debug?.wins || 0),
            // Only completed, abandoned hunts count. Pending encounter slices
            // and pre-fight recovery have zero completed fights.
            failedHunts: Math.max(0, Number(result.debug?.fights || 0)
                - Number(result.debug?.wins || 0) - Math.max(0, nextDeaths - previousDeaths))
        });
        const soloRiskState = { ...state, spotId: nextSpotId, stats: { ...state.stats, spotRisk } };
        const soloPressure = !(state.party?.partyId || state.partyId) && SpotRiskPolicy.deathPressure(soloRiskState);
        const newlyFailedSpot = soloPressure && !SpotRiskPolicy.activeBackoffs(state, timestamp)
            .some(entry => entry.spotId === nextSpotId);
        const failedSpotState = newlyFailedSpot ? SpotRiskPolicy.withBackoff(soloRiskState,
            SpotRiskPolicy.backoffForStates([soloRiskState], nextSpotId, timestamp), timestamp) : null;
        // Resolver patches often carry a projected copy of the previous
        // stats so they can add lifecycle-specific fields such as cooldowns,
        // rest deadlines, travel state, or party affinity.  Merge that copy
        // first, then stamp the counters owned by this resolve.  Reversing
        // this order silently restores the previous counters after every
        // solo/party fight (including deaths).
        const patchedStats = {
            ...(progressionState.stats || {}),
            ...(result.patch?.stats || {}),
            ...(progressionState.stats?.deathExperience
                ? { deathExperience: progressionState.stats.deathExperience }
                : {})
        };
        // Every writer of stats.travel also makes the bot `traveling`, and
        // arrival clears it. A trip on a bot that neither was nor stays
        // traveling is a leftover; the route (BotRoute) would skip the bot forever.
        if (patchedStats.travel && state.activity !== 'traveling'
            && (result.patch?.activity || state.activity) !== 'traveling') patchedStats.travel = null;
        const stats = {
            ...patchedStats,
            karma: Math.max(0, Number(state.stats?.karma || 0) - Math.floor(
                experienceAward.accepted / invoke('GameServer/Karma').XP_DIVIDER)),
            fightsWon: Number(state.stats?.fightsWon || 0) + Number(result.debug?.wins || 0),
            fightsResolved: Number(state.stats?.fightsResolved || 0) + Number(result.debug?.fights || 0),
            deaths: Number(result.patch?.deathCount ?? state.stats?.deaths ?? 0),
            expEarned: Number(state.stats?.expEarned || 0) + experienceAward.accepted,
            spEarned: Number(state.stats?.spEarned || 0) + Number(result.materialize?.sp || 0),
            adenaEarned: Number(state.stats?.adenaEarned || 0) + Number(result.materialize?.adena || 0) + materializedAdenaItems,
            route: result.debug?.route || state.stats?.route || null,
            lastResolveDebug: compactResolveDebug(result.debug),
            lastExperienceAward: {
                requested: experienceAward.requested,
                accepted: experienceAward.accepted,
                discarded: experienceAward.discarded
            },
            ...(targetCombat ? { targetCombat } : {})
        };
        const inventory = { ...(state.inventory || {}) };
        // ARCH-NOTE: the resolver already consumed authored summon materials
        // from its private combat inventory. Lifecycle normally rebuilds from
        // the input (shots/potions have separate counters), so carry only these
        // native cast-cost decreases before adding this round's loot.
        const summonClass = Number(state.stats?.classId || 0);
        const summonProfile = result.patch?.inventory && { ...(result.patch.stats?.coldCombat || state.stats?.coldCombat || {}),
            classId: summonClass, characterId: BotRoles.botCharacterId(state) };
        if (summonProfile && (BotRoles.isSummoner(summonProfile) || BotRoles.isNecromancer(summonClass))) {
            const materialIds = new Set([...ColdCombatProfile.summonSkills(summonProfile),
                ...ColdCombatProfile.corpseSummonSkills(summonProfile)]
                .filter(skill => Number(skill.itemId) > 0 && Number(skill.itemCount) > 0)
                .map(skill => String(skill.itemId)));
            for (const id of materialIds) {
                const stock = inventory[id], remaining = Number(result.patch.inventory[id]?.amount);
                if (stock && Number.isFinite(remaining) && remaining >= 0 && remaining < Number(stock.amount)) {
                    inventory[id] = { ...stock, amount: remaining };
                }
            }
        }
        materializedItems.filter((item) => Number(item.selfId) !== 57).forEach((item) => {
            const key = String(item.selfId);
            const amount = Number(item.amount || 0);
            const kind = item.kind || inventory[key]?.kind || itemTemplate(item.selfId)?.template?.kind || '';
            const protectedStarterLoot = Number(item.sourceMobLevel || 0) > 0
                && Number(item.sourceMobLevel) <= 5
                && !String(kind).startsWith('Other.Material')
                ? amount
                : 0;
            const nextAmount = Number(inventory[key]?.amount || 0) + amount;
            const starterMobLootAmount = Math.min(
                nextAmount,
                Number(inventory[key]?.starterMobLootAmount || 0) + protectedStarterLoot
            );
            inventory[key] = {
                selfId: item.selfId,
                name: item.name || inventory[key]?.name || itemName(item.selfId),
                amount: nextAmount,
                kind,
                rank: item.rank || inventory[key]?.rank || itemTemplate(item.selfId)?.etc?.rank || 'none',
                ...(starterMobLootAmount > 0 ? { starterMobLootAmount } : {})
            };
        });
        if (adena > 0) {
            inventory['57'] = {
                selfId: 57,
                name: inventory['57']?.name || 'Adena',
                amount: adena
            };
        }

        // Cold combat spends the same persisted shot stock that hot combat uses.
        // Resolve telemetry is already available here, so this adds no market
        // lookup or extra inventory query to the simulation tick. shotActions
        // counts the shots this bot's own casts, skills and landed normal
        // attacks loaded from this stock (BackgroundResolver.coldShotSupply).
        const consumeFacts = Config.developerDiagnostics === true ? [] : null;
        const shotActions = Math.max(0, Number(result.debug?.shotActions || 0));
        if (shotActions > 0) {
            const Shots = invoke('GameServer/Inventory/ShotStock');
            const shot = Shots.planForState(state);
            const beginnerId = invoke('GameServer/Items/C4BeginnerShots').selfIdFor(shot.kind, shot.rank);
            // The private combat inventory already contains exact consumption,
            // including beginner exhaustion followed by ordinary charges. Carry
            // only those decreases, preserving this resolve's new loot.
            for (const selfId of [shot.selfId, beginnerId].filter(Boolean)) {
                const stock = inventory[String(selfId)], original = state.inventory?.[selfId];
                if (!stock || !original) continue;
                const remaining = result.patch?.inventory?.[selfId]?.amount;
                const spent = Number.isFinite(remaining)
                    ? Math.max(0, Number(original.amount) - remaining)
                    : selfId === shot.selfId ? shotActions * shot.perAction : 0;
                inventory[String(selfId)] = { ...stock, amount: Math.max(0, Number(stock.amount) - spent) };
                if (consumeFacts && spent > 0) Consumption.fact(consumeFacts, selfId, Number(stock.amount),
                    inventory[String(selfId)].amount, 0);
            }
        }
        // Cold combat drinks healing potions from the same stock. The fight
        // debits only its own copy; drunkPotions counts the bottles by selfId
        // (BackgroundResolver.startColdPotion).
        for (const [selfId, count] of Object.entries(result.debug?.drunkPotions || {})) {
            const stock = inventory[String(selfId)];
            if (!stock || Number(stock.amount || 0) <= 0) continue;
            inventory[String(selfId)] = { ...stock, amount: Math.max(0, Number(stock.amount) - Number(count || 0)) };
            if (consumeFacts) Consumption.fact(consumeFacts, selfId, Number(stock.amount),
                inventory[String(selfId)].amount, 1);
        }

        if (consumeFacts) Consumption.attach(result, consumeFacts);
        const equippedInventory = GearAcquisitionPlanner.equipInventoryUpgrades({
            ...state,
            level,
            stats: { ...(state.stats || {}), ...(result.patch?.stats || {}) }
        }, inventory);
        const nextActivity = result.patch?.activity || state.activity;
        const nextState = {
            ...state,
            level,
            exp,
            sp,
            adena,
            phase: 'cold',
            activity: nextActivity,
            spotId: nextSpotId,
            currentRegion: result.patch?.currentRegion || state.currentRegion,
            loc: {
                ...(state.loc || {}),
                ...(result.patch?.loc || {})
            },
            vitals: {
                ...(state.vitals || {}),
                ...(result.patch?.vitals || {})
            },
            timing: {
                ...(state.timing || {}),
                activityStartedAt: nextActivity === state.activity
                    ? state.timing?.activityStartedAt
                    : timestamp,
                lastResolvedAt: timestamp,
                nextResolveAt: result.nextResolveAt || timestamp + 60000
            },
            stats: {
                ...stats,
                // Resolver patches commonly start from the prior state. Keep
                // the baseline stamped for this resolve's actual destination.
                spotRisk,
                // Save the failed ground before revival/physical movement can
                // change the routing origin and lose its exclusion.
                ...(failedSpotState ? { spotBackoffs: failedSpotState.stats.spotBackoffs } : {}),
                ...(!(state.party?.partyId || state.partyId) ? {
                    huntingRecovery: SpotRiskPolicy.recordRecovery(state, {
                        deaths: Math.max(0, nextDeaths - previousDeaths),
                        wins: Number(result.debug?.wins || 0), exp,
                        expBeforeDeath: experienceAward.totalExp,
                        pressure: soloPressure
                    })
                } : {}),
                // The one record of a hunting round, solo or a party member's
                // own share; the lifecycle owns actual death penalties and
                // capped XP, so the sample takes the net exp.
                ...invoke('GameServer/Bot/AI/BotHuntEfficiency').recordRound(state, result, {
                    spotId: nextSpotId, timestamp, exp: exp - Number(state.exp || 0)
                }),
                // Party combat carries a projected combat snapshot in patch.stats.
                // Keep lifecycle telemetry from this resolve authoritative over
                // that snapshot, which still contains the previous tick's data.
                ...(targetCombat ? { targetCombat } : {}),
                ...(nextActivity === 'dead' ? { partyRequest: null } : {}),
                lastResolveDebug: compactResolveDebug(result.debug),
                equipment: equipmentSummaryFromInventory(equippedInventory)
            },
            inventory: equippedInventory,
            updatedAt: writtenAt
        };
        // ARCH-NOTE: C1 lifecycle packets precede their fight; accept the
        // worker's focus event before classifying actual changed sections.
        // Direct projections receive an already projected packet as before.
        // Both threads: a worker step that decided before its round merges
        // that decision's packet here, so the event check below writes its
        // dirty bits after it (seen by the next decision point).
        const beforeResolvePacket = options.statsPacketBeforeResolve === true && options.statsPacket;
        if (beforeResolvePacket) Object.assign(nextState.stats, beforeResolvePacket);
        // A detour's stand-in pair (BackgroundResolver.resolveTravel) holds only
        // on the ground it names: any other spot write (a party arrival, the
        // party-wait fallback, a pull) ends it here, each step on both threads,
        // so a later return to that ground without the detour is an event.
        const standIn = nextState.stats.standIn;
        if (standIn && String(standIn.ground) !== String(nextState.spotId)) nextState.stats.standIn = null;
        let hard = [];
        if (state.activity === 'hunting') {
            // A round records its rewards/resources/sample immediately. It
            // renews the decision only for a meaningful dependent event; a
            // retry derives that one event from the same accepted input.
            let escrow = typeof options.moneyEscrowFor === 'function' ? options.moneyEscrowFor(nextState)
                : options.economyDeps?.buyOrderEscrow || 0;
            if (isMainThread && typeof options.moneyEscrowFor !== 'function') {
                // lazy: worker the native market owner is main-thread only; workers receive their mirrored escrow.
                escrow = invoke('GameServer/Bot/Economy/BotAfkMarketService').buyOrderEscrow(state.characterId);
            }
            // options.leaf: the step's held leaf (the worker's), whose own trip
            // and arrival raise nothing; none (main, a step without a plan):
            // every move is an event.
            hard = DecisionSections.events(state, nextState, escrow, options.leaf ?? null);
        }
        // The bot's step counter, the clock of its spot marks (SpotRiskPolicy):
        // +1 once per resolved step, whichever thread resolves it (hot actor
        // sessions never come here, so a near bot's marks wait until it is far).
        nextState.stats.stepCount = SpotRiskPolicy.stepCount(state) + 1;
        // The soft point (background thread, every far step, whatever its
        // round): money, income and the watched market against the bot's own
        // error; raised with the round's hard events in one bump.
        const soft = !isMainThread && typeof options.softInputFor === 'function'
            ? DecisionSections.softEvents(nextState, nextState.stats.wishSections, options.softInputFor(nextState, timestamp)) : [];
        // checkSections: the sections a failed cheap check of this step raised
        // before its projection (the worker's room at arrival), in the same bump.
        DecisionEvents.raiseSections(state, nextState, hard, soft, options.checkSections || []);
        // The worker's post-round economy ask: only a step that took no
        // decision before its round (a party member).
        if (!isMainThread && !state.stats?.tradeMeeting && !beforeResolvePacket) {
            const economyDeps = typeof options.economyDepsFor === 'function'
                ? await options.economyDepsFor(nextState) : options.economyDeps || {};
            const calculationDeps = { ...economyDeps, timestamp };
            const advised = typeof options.economyFor === 'function' ? await options.economyFor(nextState, calculationDeps) : null;
            const economy = advised || invoke('GameServer/Bot/Economy/EconomyContext').forState(nextState, calculationDeps);
            Object.assign(nextState.stats, economy.statsPacket);
            if (typeof options.onEconomy === 'function') options.onEconomy(economy, nextState);
        } else if (options.statsPacket && !beforeResolvePacket) Object.assign(nextState.stats, options.statsPacket);
        const knownProfileLevel = Number(nextState.stats?.classProgressionLevel || 0);
        const knownProfileClassId = Number(nextState.stats?.classProgressionClassId ?? nextState.stats?.classId);
        const currentClassId = Number(nextState.stats?.classId || 0);
        const needsClassProgression = knownProfileLevel < level || knownProfileClassId !== currentClassId
            || invoke('GameServer/Skills/SkillBookCatalog').needsTraining(nextState);
        const characterId = nextState.characterId;
        // The cached input remains current until this resolve publishes its
        // own snapshot. Recheck that capability at assigned native writers.
        const nativeWriteOptions = options.persist !== false && workerOptions ? {
            beforeWrite: NativeWriteCheckpoint.create(characterId, workerOptions)
        } : undefined;
        // ARCH-NOTE: Automatic skill/class writes keep private ROW version floors.
        // Training wraps the original native capability only; ROW/after-writers keep their advancing original proof.
        const trainingWriteOptions = nativeWriteOptions && needsClassProgression && options.projectClassProgression !== true
            ? { beforeWrite: Database.createColdTrainingGuard(state, () => {}, nativeWriteOptions.beforeWrite) }
            : nativeWriteOptions || (options.persist !== false && options.projectClassProgression !== true && needsClassProgression
                && state.phase === 'cold'
                ? { beforeWrite: Database.createColdTrainingGuard(state, () => {}) } : undefined);
        const progression = needsClassProgression
            ? (options.projectClassProgression === true ? Promise.resolve(BotClassProgression.plan({
                classId: currentClassId,
                level,
                seed: nextState.characterId
            })) : BotClassProgression.reconcile({
                characterId: nextState.characterId,
                classId: currentClassId,
                level,
                seed: nextState.characterId
            }, trainingWriteOptions))
            : Promise.resolve({ classId: currentClassId, transitions: [] });

        const prepared = progression.then((resolved) => {
            const classId = Number(resolved.classId || currentClassId);
            const role = BotRoles.inferRole({ classId, characterId: nextState.characterId });
            const progressedState = {
                ...nextState,
                party: { ...(nextState.party || {}), role },
                stats: {
                    ...(nextState.stats || {}),
                    classId,
                    role,
                    classProgressionLevel: level,
                    classProgressionClassId: classId,
                    classTransitions: resolved.transitions?.length
                        ? [...(nextState.stats?.classTransitions || []), ...resolved.transitions]
                        : nextState.stats?.classTransitions || []
                }
            };
            if (resolved.transitions?.length) delete progressedState.stats.equipmentPlan;
            const equippedProgressedState = reconcileEquipmentInventory(
                invoke('GameServer/Skills/SkillBookCatalog').applyTraining(progressedState, resolved));
            const profileReady = needsClassProgression
                ? (options.projectClassProgression === true
                    ? projectColdCombatProfile(equippedProgressedState, timestamp)
                    : refreshColdCombatProfile(equippedProgressedState))
                : Promise.resolve(equippedProgressedState);

            return profileReady.then((profiledState) => {
                if (options.persist === false) {
                    // reconcileEquipmentInventory already settled the plan on
                    // this same object; only a refreshed profile needs a recheck.
                    const settled = profiledState === equippedProgressedState;
                    if (Diagnostics.active()) Diagnostics.count('resolve_plan_reconcile', settled ? 'skipped' : 'rebuilt');
                    return {
                        ...(settled ? profiledState : reconcileFulfilledEquipmentPlan(profiledState)),
                        updatedAt: writtenAt
                    };
                }
                const row = rowFromState(profiledState);
                const characterId = row.characterId;
                return save(row, nativeWriteOptions)
                    .then(() => {
                        const deathRecord = profiledState.stats?.deathExperience;
                        if (newDeath && deathRecord?.pendingRestoration) {
                            return Database.applyCharacterDeathExperience({
                                characterId: row.characterId,
                                level: row.level,
                                expBeforeDeath: deathRecord.expBeforeDeath,
                                expLost: deathRecord.expLost,
                                expAfterDeath: row.exp,
                                deathContext: deathRecord.deathContext,
                                penaltyAppliedAt: deathRecord.penaltyAppliedAt,
                                karma: profiledState.stats?.karma,
                                sp: row.sp
                            }, nativeWriteOptions);
                        }
                        if (result.patch?.restoreExpPercent !== undefined) {
                            return Database.restoreCharacterDeathExperience(row.characterId, result.patch.restoreExpPercent, timestamp, nativeWriteOptions)
                                .then((restored) => restored || Database.updateCharacterExperience(row.characterId, row.level, row.exp, row.sp, nativeWriteOptions));
                        }
                        if (result.patch?.clearDeathExperience) {
                            return Database.clearCharacterDeathExperience(row.characterId, result.patch.clearDeathExperience, timestamp, nativeWriteOptions)
                                .then(() => Database.updateCharacterExperience(row.characterId, row.level, row.exp, row.sp, nativeWriteOptions));
                        }
                        return Number(state.stats?.karma || 0) > 0
                            ? Database.updateColdCharacterExperience(row.characterId, row.level, row.exp, row.sp, nativeWriteOptions)
                            : Database.updateCharacterExperience(row.characterId, row.level, row.exp, row.sp, nativeWriteOptions);
                    })
                    .then(() => Database.updateCharacterVitals(row.characterId, row.hp, row.maxHp, row.mp, row.maxMp, nativeWriteOptions))
                    .then(() => result.soulCrystals?.length
                        ? Database.applyColdSoulCrystalResults(row.characterId, result.soulCrystals, nativeWriteOptions || {}) : null)
                    .then(() => syncInventorySummary(row.characterId, profiledState.inventory, newDeath ? 'resolve_death' : 'resolve', nativeWriteOptions))
                    .then((deathDrop) => {
                        if (deathDrop?.inventory) {
                            // The published state carries the row the drop read back.
                            row.simulationRevision = deathDrop.revision;
                            row.inventorySummary = safeJson(deathDrop.inventory);
                            row.statsJson = safeJson({ ...parseJson(row.statsJson, {}), pkDropDeathSequence: deathDrop.deathSequence });
                            invoke('GameServer/Actor/Generics/PkDeathDrop').spawn(row.characterId, profiledState.loc, deathDrop.drops);
                        }
                        const publish = () => {
                            const snapshot = normalize(row);
                            cache.set(snapshot.characterId, snapshot);
                            notifyColdSnapshot(snapshot, nextActivity === 'dead' ? 'death' : 'resolve', {
                                critical: nextActivity === 'dead'
                                    || materializedItems.length > 0
                                    || Number(result.materialize?.adena || 0) > 0
                                    || (result.events || []).length > 0
                            });
                            if (consumeFacts) Consumption.publish(snapshot.characterId, consumeFacts, { source: 'cold_commit', commandId: options.workerAdmission?.commandId, revision: snapshot.simulation?.revision });
                            return snapshot;
                        };
                        return nativeWriteOptions ? Database.publishBotResolvedState(characterId, nativeWriteOptions, publish) : publish();
                    })
                    .catch((err) => {
                        if (err instanceof WorkerCommandAdmissionRefusal) throw err;
                        utils.infoWarn('BotLife', 'failed to apply resolve for %s: %s', state.name, err.message);
                        return null;
                    });
            });
        });
        // Projections and commands without skill grants keep their existing promise/handler path.
        if (trainingWriteOptions === nativeWriteOptions) return prepared;
        return prepared.catch(error => {
            if (Database.isColdTrainingSourceRetired(error)) return null;
            throw error;
        });
    },

    applyResolve(state, result, options = {}) {
        return this.serializeClanLevelUp(state.characterId, () => {
            checkWorkerCommandAdmission(state, options);
            const preparedOptions = { persist: true };
            if (Object.prototype.hasOwnProperty.call(options, 'workerAdmission')) {
                preparedOptions.workerAdmission = options.workerAdmission;
            }
            // ARCH-NOTE: C1/E3 lifecycle commands carry the worker's money queue;
            // main preparation must retain that packet without rebuilding it.
            if (Object.prototype.hasOwnProperty.call(options, 'statsPacket')) {
                preparedOptions.statsPacket = options.statsPacket;
                preparedOptions.statsPacketBeforeResolve = true;
            }
            return this.prepareResolve(state, result, preparedOptions);
        });
    },

    // A far bot main owns has class training to do (level, class or a skill book
    // in its bag): the commit ack names a `training` review from it.
    trainingNeeded(state) {
        return mainTrainsFar(state) && classProgressionNeeded(state, state.stats?.classId, state.level);
    },

    reviewTrainingAfterCommit(state, options = {}) {
        if (!mainTrainsFar(state)) return Promise.resolve(state);
        return this.serializeClanLevelUp(state.characterId, async () => {
            if (cache.get(state.characterId) !== state) return cache.get(state.characterId) || state;
            if (!classProgressionNeeded(state, state.stats?.classId, state.level)) return state;
            const beforeWrite = Database.createColdTrainingGuard(state, () => {
                options.beforeWrite?.();
                if (cache.get(state.characterId) !== state) throw Error('cold_training_source_retired');
            });
            const resolved = await BotClassProgression.reconcile({ characterId: state.characterId,
                classId: state.stats?.classId || 0, level: state.level, seed: state.characterId }, { beforeWrite });
            const row = await Database.publishColdTraining(state.characterId, resolved, { beforeWrite });
            return this.acceptLifecycleRow(row, 'automatic_skills');
        });
    },

    enqueueEquipmentGoalAdvanceForState,

    shouldRecoverOrphanedGiranState,

    coldPartyCandidateProjections() {
        if (!initialized) return Promise.resolve([]);

        // Party discovery deliberately reads only the fields used by
        // objective grouping, composition, persona intent and affinity. The
        // full inventory/cold-combat payload is hydrated after selection.
        return Database.execute([
            `SELECT characterId, characterName, bot_life_state.level, activity, spotId,
                activityStartedAt, updatedAt, simulationRevision,
                payloadJson
            FROM ${TABLE} INDEXED BY bot_life_state_party_candidate_projection
            INNER JOIN bot_party_candidate_projection USING (characterId)
            WHERE phase = 'cold'
            AND (partyId IS NULL OR partyId = '')
            AND NOT EXISTS (
                SELECT 1 FROM clan_operation_members reserved
                WHERE reserved.characterId = bot_life_state.characterId
                AND reserved.status = 'active'
            )
            AND spotId IS NOT NULL
            AND activity IN ('hunting', 'resting', 'party_wait')
            AND COALESCE(json_extract(payloadJson, '$[4].strategy'), '') <> 'market'`,
            [],
            { read: true }
        ], 'bot-life:party-candidate-projection').then((rows) => rows.map((row) => {
            const projected = parseJson(row.payloadJson, []);
            // Match json_extract's scalar types and the old JSON-field decoder.
            const scalar = value => typeof value === 'boolean' ? Number(value) : value;
            const role = scalar(projected[0]) || null;
            const generatedIndex = scalar(projected[1]);
            const [partyRequest, clanPartyObjective, equipmentPlan, partyHistory] = projected.slice(2)
                .map(value => typeof value === 'string' ? parseJson(value, null) : scalar(value));
            return {
                characterId: Number(row.characterId),
                name: row.characterName || '',
                level: Number(row.level || 1),
                phase: 'cold',
                activity: row.activity || 'hunting',
                spotId: row.spotId || null,
                timing: {
                    activityStartedAt: row.activityStartedAt ? Number(row.activityStartedAt) : null
                },
                party: { partyId: null, role, leaderId: null },
                stats: {
                    ...(role ? { role } : {}),
                    ...(generatedIndex !== null && generatedIndex !== undefined
                        ? { generatedIndex }
                        : {}),
                    ...(partyRequest ? { partyRequest } : {}),
                    ...(clanPartyObjective ? { clanPartyObjective } : {}),
                    ...(equipmentPlan ? { equipmentPlan } : {}),
                    ...(partyHistory ? { partyHistory } : {})
                },
                simulation: { revision: Math.max(0, Number(row.simulationRevision || 0)) },
                updatedAt: Number(row.updatedAt || 0),
                projection: true
            };
        })).catch((err) => {
            utils.infoWarn('BotLife', 'failed to fetch party candidate projection: %s', err.message);
            return [];
        });
    },

    clanOperationCandidates(options = {}) {
        if (!initialized) return Promise.resolve([]);
        if (['classIds', 'maxLevel', 'unclanned', 'cursor'].some(key => Object.hasOwn(options, key))) {
            return this.clanRecruitmentCandidates(options);
        }
        const targetClanId = Math.max(0, Number(options.targetClanId) || 0);
        const minimumLevel = Math.max(1, Math.floor(Number(options.minLevel) || 1));
        const targetLevel = Math.max(minimumLevel, Math.floor(Number(options.targetLevel) || minimumLevel));
        const limit = Math.max(1, Math.min(128, Math.floor(Number(options.limit) || 64)));

        return Database.execute([
            `SELECT states.*, c.clanId AS candidateClanId, c.classId AS candidateClassId,
                c.username AS candidateUsername
            FROM ${TABLE} states
            INNER JOIN characters c ON c.id = states.characterId
            WHERE states.phase = 'cold'
            AND (states.partyId IS NULL OR states.partyId = '')
            AND states.spotId IS NOT NULL
            AND states.activity IN ('hunting', 'resting', 'party_wait')
            AND states.level >= ?
            AND c.clanId <> ?
            AND (
                c.username LIKE 'bot_pop_%'
                OR c.username LIKE 'bot_scale_%'
                OR states.accountName LIKE 'bot_pop_%'
                OR states.accountName LIKE 'bot_scale_%'
                OR CAST(json_extract(states.statsJson, '$.generatedCold') AS INTEGER) = 1
            )
            AND c.username NOT LIKE 'bot_craft_%'
            AND states.accountName NOT LIKE 'bot_craft_%'
            AND json_extract(states.statsJson, '$.craftStationId') IS NULL
            AND json_extract(states.statsJson, '$.craftShop') IS NULL
            AND NOT EXISTS (
                SELECT 1 FROM clan_operation_members reserved
                WHERE reserved.characterId = states.characterId
                AND reserved.status = 'active'
            )
            ORDER BY CASE WHEN c.clanId = 0 THEN 0 ELSE 1 END,
                ABS(states.level - ?), states.updatedAt ASC, states.characterId ASC
            LIMIT ${limit}`,
            [minimumLevel, targetClanId, targetLevel],
            { read: true }
        ], 'bot-life:clan-operation-candidates').then((rows) => rows.map((row) => {
            const state = normalize(row);
            state.clanId = Number(row.candidateClanId || 0);
            state.classId = Number(row.candidateClassId || state.stats?.classId || 0);
            state.partyId = state.party.partyId;
            state.stats = {
                ...(state.stats || {}),
                classId: state.classId,
                clanId: state.clanId
            };
            return state;
        })).catch((err) => {
            utils.infoWarn('BotLife', 'failed to fetch clan operation candidates: %s', err.message);
            return [];
        });
    },

    clanRecruitmentCandidates(options = {}) {
        if (!initialized) return Promise.resolve([]);
        const classIds = options.classIds === undefined ? null
            : [...new Set((options.classIds || []).map(Number).filter(id => Number.isSafeInteger(id) && id >= 0))];
        if (classIds && !classIds.length) return Promise.resolve([]);
        const minLevel = Math.max(1, Math.floor(Number(options.minLevel) || 1));
        const maxLevel = Math.min(100, Math.floor(Number(options.maxLevel) || 100));
        if (maxLevel < minLevel) return Promise.resolve([]);
        const limit = Math.max(1, Math.min(64, Math.floor(Number(options.limit) || 64)));
        const targetClanId = Math.max(0, Number(options.targetClanId) || 0);
        const cursor = options.cursor;
        if (cursor && ![cursor.classId, cursor.level, cursor.characterId].every(value => Number.isSafeInteger(value) && value >= 0)) return Promise.resolve([]);
        const unclanned = options.unclanned !== false;
        const classClause = classIds ? `AND candidate.classId IN (${classIds.map(() => '?').join(',')})` : '';
        const cursorClause = cursor ? 'AND (candidate.classId,candidate.level,candidate.characterId) > (?,?,?)' : '';
        const params = [unclanned ? 0 : targetClanId, ...(classIds || []), minLevel, maxLevel,
            ...(cursor ? [cursor.classId, cursor.level, cursor.characterId] : [])];
        return Database.execute([
            `SELECT states.*, candidate.classId AS candidateClassId, candidate.clanId AS candidateClanId
            FROM bot_party_candidate_projection candidate INDEXED BY bot_party_candidate_recruitment
            CROSS JOIN ${TABLE} states ON states.characterId = candidate.characterId
            WHERE candidate.joinAvailability = 1 AND candidate.clanId ${unclanned ? '=' : '<>'} ?
            ${classClause} AND candidate.level BETWEEN ? AND ? ${cursorClause}
            AND NOT EXISTS (SELECT 1 FROM clan_operation_members reserved
                WHERE reserved.characterId = candidate.characterId AND reserved.status = 'active')
            ${options.excludeTradeMeetings ? 'AND NOT EXISTS (SELECT 1 FROM board_trade_participants t WHERE t.characterId=candidate.characterId AND t.meetingId IS NOT NULL)' : ''}
            ORDER BY candidate.classId,candidate.level,candidate.characterId LIMIT ${limit}`,
            params, { read: true }
        ], 'bot-life:clan-recruitment-candidates').then(rows => rows.map(row => {
            const state = normalize(row);
            state.classId = Number(row.candidateClassId);
            state.clanId = Number(row.candidateClanId);
            state.partyId = state.party.partyId;
            state.stats = { ...state.stats, classId: state.classId, clanId: state.clanId };
            state.candidateCursor = { classId: state.classId, level: state.level, characterId: state.characterId };
            return state;
        })).catch(err => {
            utils.infoWarn('BotLife', 'failed to fetch clan recruitment candidates: %s', err.message);
            return [];
        });
    },

    statesByIds(characterIds = [], options = {}) {
        if (!initialized) return Promise.resolve([]);
        const ids = [...new Set((characterIds || []).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))]
            .slice(0, 64);
        if (!ids.length) return Promise.resolve([]);
        const placeholders = ids.map(() => '?').join(', ');
        const unassignedClause = `${options.unassigned ? "AND (partyId IS NULL OR partyId = '')" : ''}
            ${options.unassigned || options.excludeReserved ? `AND NOT EXISTS (
                SELECT 1 FROM clan_operation_members reserved
                WHERE reserved.characterId = bot_life_state.characterId
                AND reserved.status = 'active'
            )` : ''}`;

        return Database.execute([
            `SELECT ${TABLE}.*, c.classId AS canonicalClassId, c.clanId AS canonicalClanId FROM ${TABLE}
            INNER JOIN characters c ON c.id = ${TABLE}.characterId
            WHERE characterId IN (${placeholders})
            ${unassignedClause}`,
            ids,
            { read: true }
        ], 'bot-life:states-by-id').then((rows) => rows.map((row) => {
            const state = normalize(row);
            state.classId = Number(row.canonicalClassId ?? state.stats?.classId ?? 0);
            state.clanId = Number(row.canonicalClanId || 0);
            state.stats = { ...state.stats, classId: state.classId, clanId: state.clanId };
            cache.set(state.characterId, state);
            // The cache feeds cold worker snapshots: an own flat partyId outlives
            // a party release (the release clears only party.partyId), so the
            // released bot would stay a party member to the due list and the
            // kernel. Clan readers get it on a copy.
            return { ...state, partyId: state.party.partyId };
        })).catch((err) => {
            utils.infoWarn('BotLife', 'failed to hydrate %d party candidate(s): %s', ids.length, err.message);
            return [];
        });
    },

    refreshInventory(state, options = {}) {
        if (!state?.characterId) return Promise.resolve(state || null);
        return Database.fetchItems(state.characterId, 'life_refresh_inventory').then((items) => {
            // Cold progression owns virtual item counts between hot
            // materializations. The character inventory remains authoritative
            // for equip flags, so a stale snapshot cannot sell worn gear.
            const physicalInventory = inventorySummaryFromItems(items || []);
            const inventory = { ...(state.inventory || {}) };
            Object.entries(physicalInventory).forEach(([key, item]) => {
                const previous = inventory[key] || {};
                // A present physical row is authoritative for paperdoll state.
                // Persisted slots are only retained for items absent from the
                // physical snapshot, so unequipping can shrink the slot set.
                const equippedSlots = GearAcquisitionPlanner.equippedSlotsFor(item, item.slot);
                inventory[key] = {
                    ...previous,
                    ...item,
                    amount: Math.max(Number(previous.amount || 0), Number(item.amount || 0)),
                    equipped: equippedSlots.length > 0,
                    equippedCount: equippedSlots.length,
                    equippedSlots,
                    slot: Number(item.slot || previous.slot || 0)
                };
            });
            const equipped = options.equip === true
                ? GearAcquisitionPlanner.equipInventoryUpgrades(state, inventory)
                : inventory;
            const refreshed = {
                ...state,
                adena: Math.max(Number(state.adena || 0), inventoryAdena(equipped)),
                inventory: equipped,
                stats: {
                    ...(state.stats || {}),
                    equipment: equipmentSummaryFromInventory(equipped)
                }
            };
            return options.equip === true
                ? syncInventorySummary(state.characterId, equipped, 'refresh').then(() => refreshed)
                : refreshed;
        }).catch((err) => {
            utils.infoWarn('BotLife', 'failed to refresh inventory for %s: %s', state.name, err.message);
            return state;
        });
    },

    leaveParty(state, reason = 'party_break', options = {}) {
        if (!state?.characterId) return Promise.resolve(null);
        const read = state;
        if (invoke('GameServer/Bot/Population/RaidSoloBoundary').stale(state)) state = invoke('GameServer/Bot/Population/RaidSoloBoundary').clear(state);
        const timestamp = now();
        const cached = cache.get(Number(state.characterId));
        const partyTravel = state.stats?.travel?.reason === 'party_spot_replan';
        // `grouped` and party-route travel are not valid solo lifecycle
        // states. Every detachment reason must return them to an actionable
        // route, including capacity reclamation and friend priority.
        const needsSoloResume = state.activity === 'grouped' || partyTravel;
        const nextActivity = needsSoloResume ? 'hunting' : state.activity;
        const nextState = {
            ...state,
            activity: nextActivity,
            party: { ...(state.party || {}), partyId: null, leaderId: null },
            stats: {
                ...(state.stats || {}),
                ...(partyTravel ? { travel: null } : {}),
                backgroundPartyId: null,
                partyBreakReason: reason,
                partyRequest: null
            },
            timing: needsSoloResume
                ? { ...(state.timing || {}), activityStartedAt: timestamp, nextResolveAt: timestamp + 30000 }
                : state.timing,
            updatedAt: timestamp
        };
        // A party's release of a far member (applyWorkerPartyRequirements):
        // only what the departure changes is written, held on the revision of
        // the copy passed; false when a member write beat it. Its travel is
        // kept or dropped, never a new paid trip, so no trip payment follows.
        if (options.heldOnRevision === true) {
            return writeHeldOnRevision(read, {
                stats: Object.fromEntries(Object.entries(nextState.stats).filter(([key, value]) => value !== read.stats?.[key])),
                columns: {
                    partyId: null,
                    ...(nextState.spotId !== read.spotId ? { spotId: nextState.spotId || null } : {}),
                    ...(needsSoloResume ? { activity: nextActivity, activityStartedAt: timestamp, nextResolveAt: timestamp + 30000 } : {})
                }
            }, `party_left_${reason}`);
        }
        const row = rowFromState(nextState);
        if (options.ownerHandoff === true) {
            return invoke('GameServer/Bot/Population/ColdSimulationOwner').handoffToMain(state, {
                nextState,
                timestamp,
                allowParty: true,
                allowLifecycle: true
            }).then((result) => (result?.ok ? syncNewTripPayment(nextState, cached).then(() => result) : result)).then((result) => {
                if (!result?.ok) {
                    utils.infoWarn('BotLife', 'failed owner handoff while removing %s from party: %s', state.name, result?.reason || 'unknown');
                    return null;
                }
                Metrics.recordDbFlush();
                const snapshot = cache.get(Number(state.characterId)) || normalize({ ...row, simulationRevision: result.revision });
                notifyColdSnapshot(snapshot, `party_left_${reason}`, { critical: true });
                return snapshot;
            }).catch((err) => {
                utils.infoWarn('BotLife', 'failed to remove %s from party: %s', state.name, err.message);
                return null;
            });
        }
        return save(row).then(() => syncNewTripPayment(nextState, cached)).then(() => {
            const snapshot = normalize(row);
            cache.set(snapshot.characterId, snapshot);
            // Without this transition snapshot the worker retains the old
            // `party_member` catalog entry forever and never recreates a solo
            // due token. Membership transitions are P0 lifecycle changes.
            notifyColdSnapshot(snapshot, `party_left_${reason}`, { critical: true });
            return snapshot;
        }).catch((err) => {
            utils.infoWarn('BotLife', 'failed to remove %s from party: %s', state.name, err.message);
            return null;
        });
    },

    syncExternalInventory(characterId, reason = 'external_inventory_sync', previousState = null, options = {}) {
        const id = Number(characterId);
        const state = previousState || cache.get(id);
        if (!id || !state) return Promise.resolve(null);
        return Database.fetchItems(id, 'life_sync_external_inventory').then((items) => {
            const refreshed = { ...inventoryStateFromItems(state, items), updatedAt: now() };
            const fromAfkTrade = options.autoEquip !== false && String(reason).startsWith('afk_trade_');
            const reconciled = fromAfkTrade ? reconcileEquipmentInventory(refreshed) : refreshed;
            const equipmentChanged = fromAfkTrade && JSON.stringify(refreshed.stats.equipment)
                !== JSON.stringify(reconciled.stats.equipment);
            return this.upsertState(reconciled, reason).then((saved) => (
                saved && equipmentChanged
                    ? syncInventorySummary(id, saved.inventory, 'external').then(() => saved)
                    : saved
            ));
        });
    },

    applyMarketPurchase(state, offer, qty = 1, options = {}) {
        const selfId = Number(offer?.selfId || 0);
        const price = Number(offer?.price || 0);
        const count = Number(qty);
        if (!Number.isSafeInteger(count) || count <= 0) return Promise.resolve(null);
        const totalPrice = price * count;
        if (!state || !selfId || price <= 0 || Number(state.adena || 0) < totalPrice) return Promise.resolve(null);

        const template = itemTemplate(selfId);
        if (!template) return Promise.resolve(null);
        const slot = Number(template.etc?.slot || 0);
        const crystalInput = invoke('GameServer/Bot/Economy/BotCrystallization').inputAmount(state, selfId);
        const wearable = !crystalInput && GearAcquisitionPlanner.equipmentCandidate(template, state);
        const pairSlots = [1, 2].includes(slot) ? [1, 2] : [4, 5].includes(slot) ? [4, 5] : [];
        if (!crystalInput && slot > 0 && count > 1 && (!pairSlots.length || count > 2)) return Promise.resolve(null);
        if (marketPurchaseBlocker(state, offer, count)) return Promise.resolve(null);
        const inventory = Object.fromEntries(Object.entries(state.inventory || {}).map(([key, item]) => [key, {
            ...item,
            ...(Array.isArray(item?.equippedSlots) ? { equippedSlots: [...item.equippedSlots] } : {})
        }]));
        let purchaseSlots = crystalInput ? GearAcquisitionPlanner.equippedSlotsFor(inventory[String(selfId)] || {}, slot) : [];
        if (wearable && pairSlots.length) {
            const requestedSlot = Number(offer?.equipSlot || 0);
            const existingSlots = GearAcquisitionPlanner.equippedSlotsFor(inventory[String(selfId)] || {}, slot);
            const occupied = new Set(Object.values(inventory).flatMap((item) => GearAcquisitionPlanner.equippedSlotsFor(item, item.slot)));
            for (let index = 0; index < count; index += 1) {
                const desired = pairSlots.includes(requestedSlot) && !purchaseSlots.includes(requestedSlot)
                    ? requestedSlot
                    : pairSlots.find((candidate) => !occupied.has(candidate) && !purchaseSlots.includes(candidate))
                        || pairSlots.find((candidate) => !existingSlots.includes(candidate) && !purchaseSlots.includes(candidate));
                if (desired) purchaseSlots.push(desired);
            }
            purchaseSlots.forEach((desiredSlot) => Object.keys(inventory).forEach((key) => {
                if (Number(key) === selfId) return;
                const owned = inventory[key];
                const remaining = GearAcquisitionPlanner.equippedSlotsFor(owned, owned.slot).filter((value) => value !== desiredSlot);
                inventory[key] = {
                    ...owned,
                    equipped: remaining.length > 0,
                    equippedCount: remaining.length,
                    equippedSlots: remaining
                };
            }));
            purchaseSlots = [...new Set([...existingSlots, ...purchaseSlots])].slice(0, pairSlots.length).sort((a, b) => a - b);
        } else if (wearable && slot) {
            Object.keys(inventory).forEach((key) => {
                if (GearAcquisitionPlanner.equippedSlotsFor(inventory[key], inventory[key]?.slot).includes(slot)) {
                    inventory[key] = { ...inventory[key], equipped: false, equippedCount: 0, equippedSlots: [] };
                }
            });
        }
        inventory['57'] = { ...(inventory['57'] || {}), selfId: 57, name: 'Adena', amount: Number(state.adena) - totalPrice };
        inventory[String(selfId)] = {
            ...(inventory[String(selfId)] || {}),
            selfId,
            name: template.template?.name || offer.itemName || itemName(selfId),
            amount: Number(inventory[String(selfId)]?.amount || 0) + count,
            equipped: crystalInput ? purchaseSlots.length > 0 : wearable && (pairSlots.length ? purchaseSlots.length > 0 : slot > 0),
            equippedCount: crystalInput ? purchaseSlots.length : wearable ? pairSlots.length ? purchaseSlots.length : slot > 0 ? 1 : 0 : 0,
            equippedSlots: crystalInput ? purchaseSlots : wearable ? pairSlots.length ? purchaseSlots : slot > 0 ? [slot] : [] : [],
            stackable: slot === 0 || !!inventory[String(selfId)]?.stackable,
            slot,
            rank: template.etc?.rank || 'none',
            kind: template.template?.kind || ''
        };
        const equipment = equipmentSummaryFromInventory(inventory);
        const purchaseStats = { ...(state.stats || {}) };
        const purchasedState = {
            ...state,
            adena: Number(state.adena) - totalPrice,
            // A bot in town is shopping; a purchase made for it where it hunts
            // (the clan's goal purchase) leaves its activity alone.
            activity: options.keepActivity ? state.activity : 'shopping',
            inventory,
            stats: {
                ...purchaseStats,
                equipment,
                marketRetryAfter: null,
                marketWanted: null,
                marketLead: null,
                lastMarketPurchase: { selfId, qty: count, price, totalPrice, sourceType: offer.sourceType, sourceId: offer.sourceId, at: now() }
            },
            updatedAt: now()
        };
        // The purchased row is only an input to the shared equipment
        // optimizer.  Persisting the optimistic slot assignment directly can
        // leave mutually-exclusive items (most visibly a polearm and shield)
        // equipped at once and can finish a plan that was never fulfilled.
        const nextState = slot > 0 ? reconcileEquipmentInventory(purchasedState) : purchasedState;
        const row = rowFromState(nextState);
        return save(row)
            .then(() => syncInventorySummary(row.characterId, nextState.inventory, 'market_purchase'))
            .then(() => {
                const snapshot = normalize(row);
                cache.set(snapshot.characterId, snapshot);
                notifyColdSnapshot(snapshot, 'market_purchase', { critical: true });
                return snapshot;
            }).catch(async (err) => {
                utils.infoWarn('BotLife', 'failed market purchase for %s: %s', state.name, err.message);
                const restored = await rewriteMarketState(state, 'market_purchase_persist_rollback');
                if (!restored) utils.infoWarn('BotLife', 'failed to compensate market purchase for %s', state.name);
                return null;
            });
    },

    applyNpcLiquidation(state, candidates = []) {
        if (!state || !Array.isArray(candidates) || !candidates.length) return Promise.resolve(state);
        const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
        const reserved = Disposition.reservedEquipmentAmounts(state);
        const inventory = { ...(state.inventory || {}) };
        let payout = 0;
        const sold = [];
        candidates.forEach((candidate) => {
            const selfId = Number(candidate.selfId || 0);
            const existing = inventory[String(selfId)];
            if (!existing || selfId === 57 || Disposition.isGradeCrystal(candidate)
                || invoke('GameServer/Items/C4BeginnerShots').isRestricted(selfId)) return;
            const free = Disposition.saleFreeAmount(state, existing, reserved);
            const equippedCount = Math.max(0, Number(existing?.equippedCount ?? (existing?.equipped ? 1 : 0)));
            const amount = Math.min(
                Math.max(0, Number(existing?.amount || 0) - equippedCount),
                Math.max(0, Number(candidate.count || 0)), free
            );
            const price = Math.max(0, Number(candidate.npcPrice || 0));
            if (!selfId || !Number.isFinite(amount) || !Number.isFinite(price) || amount <= 0 || price <= 0) return;
            inventory[String(selfId)] = { ...existing, amount: Number(existing.amount) - amount };
            payout += amount * price;
            sold.push([selfId, amount, price]);
        });
        if (!sold.length) return Promise.resolve(state);

        inventory['57'] = {
            ...(inventory['57'] || {}),
            selfId: 57,
            name: 'Adena',
            amount: Number(state.adena || 0) + payout
        };
        const nextState = {
            ...state,
            adena: Number(state.adena || 0) + payout,
            inventory,
            stats: {
                ...(state.stats || {}),
                lastNpcLiquidation: invoke('GameServer/Bot/LastOperations').compact({ at: now(), payout: Math.round(payout) }, sold, { field: 'sold' })
            },
            updatedAt: now()
        };
        const row = rowFromState(nextState);
        return save(row)
            .then(() => syncInventorySummary(row.characterId, inventory, 'npc_liquidation'))
            .then(() => {
                const snapshot = normalize(row);
                cache.set(snapshot.characterId, snapshot);
                return snapshot;
            }).catch((err) => {
                utils.infoWarn('BotLife', 'failed NPC liquidation for %s: %s', state.name, err.message);
                return null;
            });
    },

    applyConsumablePurchase(state, purchasePatch, reason = 'consumable_restock') {
        if (!state || !purchasePatch?.purchase || !purchasePatch.inventory) return Promise.resolve(state || null);
        const nextState = {
            ...state,
            adena: Number(purchasePatch.adena || 0),
            inventory: purchasePatch.inventory,
            stats: {
                ...(state.stats || {}),
                lastConsumablePurchase: purchasePatch.purchase,
                lastReason: reason
            },
            updatedAt: now()
        };
        const row = rowFromState(nextState);
        return save(row)
            .then(() => syncInventorySummary(row.characterId, nextState.inventory, 'consumable_purchase'))
            .then(() => {
                const snapshot = normalize(row);
                cache.set(snapshot.characterId, snapshot);
                notifyColdSnapshot(snapshot, reason, { critical: true });
                return snapshot;
            }).catch((err) => {
                utils.infoWarn('BotLife', 'failed consumable restock for %s: %s', state.name, err.message);
                return null;
            });
    },

    applyClanWarehouseExchange(request, publish = null) {
        const id = Number(request.characterId);
        const previous = pendingWrites.get(id) || Promise.resolve();
        const next = previous.then(() => Database.exchangeClanWarehouseEquipment(request)).then((result) => {
            if (!result?.ok) return result;
            const snapshot = normalize(result.state);
            cache.set(id, snapshot);
            // Publish the committed paperdoll before yielding back to hot AI.
            if (publish) publish({ ...result, state: snapshot });
            notifyColdSnapshot(snapshot, 'clan_warehouse_equipment', { critical: true });
            invoke('GameServer/Bot/AI/BotClanChat').onWarehouse(snapshot, result, request.clanId);
            return { ...result, state: snapshot };
        }).catch((error) => {
            utils.infoWarn('BotLife', 'failed clan warehouse exchange for %d: %s', id, error.message || error);
            return { ok: false, reason: 'exchange_error', characterId: id, error };
        });
        const tracked = next.finally(() => {
            if (pendingWrites.get(id) === tracked) pendingWrites.delete(id);
        });
        pendingWrites.set(id, tracked);
        return tracked;
    },

    serializeClanLevelUp(characterId, work) {
        const id = Number(characterId);
        const previous = pendingWrites.get(id) || Promise.resolve();
        const next = previous.then(work);
        const tracked = next.catch(() => {}).finally(() => {
            if (pendingWrites.get(id) === tracked) pendingWrites.delete(id);
        });
        pendingWrites.set(id, tracked);
        return next;
    },

    // writeHeldOnRevision for a caller outside this module; `inventory` is
    // saved as the row's bag summary the way a full save writes it.
    writeHeldFields(read, { stats = {}, columns = {}, inventory = null }, reason) {
        return writeHeldOnRevision(read, { stats: { ...stats, lastReason: reason }, columns: inventory
            ? { ...columns, inventorySummary: safeJson(InventorySummary.canonicalize(inventory)) }
            : columns }, reason);
    },

    // One member's plan from its party's requirement refresh
    // (PopulationService.applyWorkerPartyRequirements), held on the revision
    // of the copy read (writeHeldOnRevision: false when a member write beat
    // it). A clan-locked plan or a foreign clan's goal is not replaced, as the
    // full save would not replace it (null: nothing to write).
    writePartyRequirementPlan(member, plan = null) {
        const id = Number(member?.characterId), reason = 'party_requirement_refresh';
        if (!id) return Promise.resolve(null);
        const next = preserveClanOwnedEquipmentState({ ...member, stats: { ...(member.stats || {}), equipmentPlan: plan } },
            reason, member);
        if (next.stats.equipmentPlan !== plan || ClanMembershipPolicy.reconcileState(next).stats.equipmentPlan !== plan) {
            return Promise.resolve(null);
        }
        return writeHeldOnRevision(member, { stats: { equipmentPlan: plan, lastReason: reason } }, reason);
    },

    retireMarketErrand(characterId, expected) {
        const current = cache.get(Number(characterId));
        if (!current || current.phase !== 'cold' || !expected) return Promise.resolve(null);
        const Errands = require('./CombinedErrandPolicy');
        const next = Errands.complete(current, expected);
        if (JSON.stringify(next.stats.marketErrands) === JSON.stringify(current.stats.marketErrands || [])
            && JSON.stringify(next.stats.marketErrand) === JSON.stringify(current.stats.marketErrand || null)) return Promise.resolve(null);
        return writeHeldOnRevision(current, { stats: { marketErrands: next.stats.marketErrands,
            marketErrand: next.stats.marketErrand, lastReason: 'market_errand_need_changed' } }, 'market_errand_need_changed');
    },

    acceptClanLevelSpState(row) {
        const snapshot = normalize(row);
        cache.set(snapshot.characterId, snapshot);
        notifyColdSnapshot(snapshot, 'clan_level_sp', { critical: true });
        return snapshot;
    },

    acceptClanMembershipState(row) {
        const snapshot = normalize(row);
        cache.set(snapshot.characterId, snapshot);
        notifyColdSnapshot(snapshot, 'clan_membership', { critical: true });
        return snapshot;
    },

    acceptClanCraftState(row) {
        const snapshot = normalize(row);
        cache.set(snapshot.characterId, snapshot);
        notifyColdSnapshot(snapshot, 'clan_craft', { critical: true });
        return snapshot;
    },

    applyClanMaterialTransfer(request, withdraw = false) {
        const id = Number(request.characterId);
        const previous = pendingWrites.get(id) || Promise.resolve();
        const next = previous.then(() => withdraw
            ? Database.transferClanWarehouseToMember({ ...request, allowParty: true })
            : Database.transferInventoryToClanWarehouse({ ...request, allowParty: true }))
            .then(result => {
                if (!result?.ok || !result.state) return result;
                const snapshot = normalize(result.state);
                cache.set(id, snapshot);
                notifyColdSnapshot(snapshot, 'clan_material_transfer', { critical: true });
                return { ...result, state: snapshot };
            });
        const tracked = next.catch(() => {}).finally(() => {
            if (pendingWrites.get(id) === tracked) pendingWrites.delete(id);
        });
        pendingWrites.set(id, tracked);
        return next;
    },

    learnCraftableRecipes(state, { recipeIds = null } = {}) {
        if (!state?.characterId) return Promise.resolve(state || null);
        if (!recipeIds) {
            const leaf = invoke('GameServer/Bot/Population/ColdSimulationCoordinator').economyDecisions.decided(state)?.activity;
            recipeIds = leaf?.activity === 'crafting' && Number(leaf.recipeId) > 0 ? [Number(leaf.recipeId)] : [];
        }
        if (!recipeIds.length) return Promise.resolve(state);
        const candidates = Object.values(state.inventory || {})
            .filter((item) => ItemDisposition.canLearnRecipe(state, item))
            .sort((left, right) => Number(left.selfId || 0) - Number(right.selfId || 0));
        if (!candidates.length) return Promise.resolve(state);

        return Database.fetchCharacterRecipes(state.characterId).then(async rows => {
            const known = new Set((rows || []).map(row => Number(row.recipeId)));
            const recipes = candidates.filter(item => Number(item.amount || 0) > 0).flatMap(item => {
                const decision = ItemDisposition.recipeDisposition(state, item, [...known]);
                return decision?.action === 'learn' && recipeIds.includes(Number(decision.recipe.recipeId))
                    ? [{ ...decision.recipe, name: item.name }] : [];
            });
            if (!recipes.length) return state;
            let saved = state, changed = false;
            for (const recipe of recipes) {
                const admitted = await EconomyCommit.admit(saved, EconomyCommit.KINDS.learn);
                let learned;
                try { learned = await Database.learnColdRecipes(state.characterId, [recipe], admitted.state,
                    { economyCommand: admitted.command }); }
                finally { EconomyCommit.finish(state.characterId, admitted.command); }
                if (learned.learned?.length) changed = true;
                if (learned.coldLifeRow) saved = EconomyCommit.acceptRow(learned.coldLifeRow);
                if (saved.phase !== 'cold' || this.hotRow(saved.characterId)) break;
            }
            if (changed) invoke('GameServer/Bot/Economy/CraftWorkshopService').recipesChanged(state.characterId);
            notifyColdSnapshot(saved, 'recipe_book_learned', { critical: true });
            return saved;
        }).catch(error => {
            utils.infoWarn('BotLife', 'failed recipe-book reconciliation for %s: %s', state.name, error.message || error);
            return state;
        });
    },

    // options.releaseHot: markCold's write, the one that hands a hot row back.
    upsertState(state, reason = 'seed', options = {}) {
        if (!state || !state.characterId) return Promise.resolve(null);

        const timestamp = now();
        const nextState = {
            ...state,
            phase: state.phase || 'cold',
            activity: state.activity || 'hunting',
            timing: {
                ...(state.timing || {}),
                activityStartedAt: state.timing?.activityStartedAt || timestamp,
                nextResolveAt: state.timing?.nextResolveAt || timestamp + 30000 + Math.round(Math.random() * 90000)
            },
            stats: {
                ...(state.stats || {}),
                lastReason: reason
            },
            updatedAt: timestamp
        };
        const characterId = Number(nextState.characterId);
        const previous = pendingWrites.get(characterId) || Promise.resolve();
        const ready = initialized ? Promise.resolve(true) : this.init();
        let paidTrip = null;
        const next = previous.then(() => ready).then((isReady) => {
            if (!isReady) {
                throw new Error('state table unavailable');
            }
            const cached = cache.get(characterId);
            const protectedState = preserveClanOwnedEquipmentState(nextState, reason, cached);
            paidTrip = () => syncNewTripPayment(protectedState, cached);
            const row = rowFromState(protectedState);
            return save(row, { releaseHot: options.releaseHot === true }).then(() => row);
        }).then((row) => Database.updateCharacterLocation(row.characterId, {
            locX: row.locX,
            locY: row.locY,
            locZ: row.locZ
        }).then(() => row)).then((row) => Database.updateCharacterExperience(row.characterId, row.level, row.exp, row.sp).then(() => row))
            .then((row) => Database.updateCharacterVitals(row.characterId, row.hp, row.maxHp, row.mp, row.maxMp).then(() => row))
            .then((row) => paidTrip().then(() => row))
            .then((row) => {
                const snapshot = normalize(row);
                const current = cache.get(characterId);
                cache.set(characterId, snapshot);
                notifyMarketReviewState(snapshot, current);
                notifyColdSnapshot(snapshot, reason);
                return snapshot;
            })
            .catch((err) => {
                if (err?.code !== 'BOT_LIFE_STATE_OWNERSHIP_CONFLICT') {
                    utils.infoWarn('BotLife', 'failed to upsert %s: %s', nextState.name || characterId, err.message);
                }
                return null;
            });

        const tracked = next.finally(() => {
            if (pendingWrites.get(characterId) === tracked) {
                pendingWrites.delete(characterId);
            }
        });
        pendingWrites.set(characterId, tracked);
        return next;
    },

    counts() {
        const counts = { cold: 0, warm: 0, hot: 0, total: 0 };
        cache.forEach((state) => {
            if (counts[state.phase] === undefined) counts[state.phase] = 0;
            counts[state.phase] += 1;
            counts.total += 1;
        });
        return counts;
    },

    coldDueSummary(timestamp = now()) {
        // overdue: due longer than a step takes from its time to its commit
        // on main; a bot inside that span is being stepped, not queued.
        const summary = {
            due: 0,
            overdue: 0,
            highLevel: 0,
            replans: 0,
            oldestAgeMs: 0,
            // The bot waiting longest: the summary names it when it passes 60 s.
            oldest: null
        };

        const noteOldest = (state, dueAt, ageMs) => {
            if (ageMs <= summary.oldestAgeMs && summary.oldest) return;
            summary.oldestAgeMs = Math.max(0, ageMs);
            summary.oldest = { characterId: state.characterId, name: state.name, activity: state.activity,
                dueAt, lastResolvedAt: Number(state.timing?.lastResolvedAt || 0) };
        };
        cache.forEach((state) => {
            if (state.phase !== 'cold'
                || state.activity === 'pk_hunting'
                || state.party?.partyId
                || (state.activity === 'crafting' && state.stats?.craftShop)) {
                return;
            }
            // An arrived trader waits on the native meeting event; its old
            // resolve deadline is not a task waiting in the worker's heap.
            if (state.stats?.tradeMeeting
                && require('./ColdSimulationKernel').lifecycleKind(state) === 'event_driven') return;
            const nextResolveAt = Number(state.timing?.nextResolveAt || 0);
            if (nextResolveAt > timestamp && !hasStaleRateModelPlan(state)) return;

            summary.due += 1;
            if (Number(state.level || 1) >= 16) summary.highLevel += 1;
            const plan = state.stats?.equipmentPlan;
            if (plan?.status === 'active'
                && plan.next?.spotId
                && plan.next.spotId !== state.spotId) {
                summary.replans += 1;
            }

            const dueAt = nextResolveAt > 0 ? nextResolveAt : Number(state.updatedAt || timestamp);
            if (timestamp - dueAt > COLD_OVERDUE_MS) summary.overdue += 1;
            noteOldest(state, dueAt, timestamp - dueAt);
        });

        return summary;
    },

    targetCombatSummary() {
        if (Config.developerDiagnostics !== true) return null;
        return Array.from(cache.values()).reduce((summary, state) => {
            const targets = state.stats?.targetCombat?.populationTargets || {};
            const values = Object.values(targets);
            if (!values.length) return summary;
            summary.bots += 1;
            values.forEach((telemetry) => {
                summary.resolves += Number(telemetry.resolves || 0);
                summary.defeated += Number(telemetry.defeated || 0);
                summary.targetKills += Number(telemetry.targetKills || 0);
                summary.interruptions += Number(telemetry.interruptions || 0);
            });
            return summary;
        }, { bots: 0, resolves: 0, defeated: 0, targetKills: 0, interruptions: 0 });
    },

    partyRequestSummary(timestamp = now()) {
        return Array.from(cache.values()).reduce((summary, state) => {
            const request = state.stats?.partyRequest;
            if (request?.status !== 'open') return summary;
            const priority = request.priority === 'required' ? 'required' : 'preferred';
            summary.total += 1;
            summary[priority] += 1;
            if (priority === 'required') {
                const reason = request.partyNeedReason || 'unknown';
                summary.requiredReasons[reason] = (summary.requiredReasons[reason] || 0) + 1;
            }
            if (state.activity === 'party_wait') summary.blocked += 1;
            const ageMs = Math.max(0, timestamp - Number(request.requestedAt || timestamp));
            summary.maxAgeMs = Math.max(summary.maxAgeMs, ageMs);
            return summary;
        }, { total: 0, required: 0, preferred: 0, blocked: 0, maxAgeMs: 0, requiredReasons: {} });
    },


    deferUnformablePartyRequests(characterIds = [], reason = 'no_compatible_level_match') {
        if (!initialized) return Promise.resolve(0);
        return deferUnformablePartyRequests(characterIds, reason);
    },

    cachedState(characterId) {
        return cache.get(Number(characterId)) || null;
    },

    rememberEnemies(session) {
        const id = Number(session?.actor?.fetchId?.());
        if (!initialized || !cache.has(id)) return Promise.resolve(false);
        const previous = pendingWrites.get(id) || Promise.resolve();
        const next = previous.catch(() => {}).then(async () => {
            const enemies = BotEnemyMemory.snapshot(session);
            const incidents = invoke('GameServer/Social/PvpResponsibility').snapshot(session.actor);
            const people = session.peopleKnowledge;
            const current = cache.get(id);
            if (!current || current.phase !== 'hot' || (JSON.stringify(current.stats?.pvpEnemies || []) === JSON.stringify(enemies)
                && JSON.stringify(current.stats?.pvpIncidents || []) === JSON.stringify(incidents)
                && (!people || current.stats?.peoplePoints === people.peoplePoints && current.stats?.peopleEpisode === people.peopleEpisode))) return false;
            await Database.execute([
                `UPDATE ${TABLE} SET statsJson = json_patch(json_set(COALESCE(statsJson, '{}'), '$.pvpEnemies', json(?), '$.pvpIncidents', json(?)), json(?)) WHERE characterId = ? AND phase = 'hot'`,
                [JSON.stringify(enemies), JSON.stringify(incidents), JSON.stringify(people || {}), id]
            ], 'bot:enemy-memory');
            const latest = cache.get(id);
            if (latest) cache.set(id, { ...latest, stats: { ...(latest.stats || {}), ...(people || {}), pvpEnemies: enemies, pvpIncidents: incidents } });
            return true;
        }).catch(error => {
            utils.infoWarn('BotLife', 'failed enemy memory for %s: %s', id, error.message);
            return false;
        });
        const tracked = next.finally(() => { if (pendingWrites.get(id) === tracked) pendingWrites.delete(id); });
        pendingWrites.set(id, tracked);
        return tracked;
    },

    acceptNameMetadata(characterId, name, version) {
        const id = Number(characterId);
        if (!cache.has(id)) return Promise.resolve(null);
        const previous = pendingWrites.get(id) || Promise.resolve();
        const next = previous.then(() => Database.updateGeneratedBotName(id, name, version)).then((written) => {
            const current = cache.get(id);
            if (!current) return null;
            // The write moved a far row's revision; the cache carries the new one.
            const simulation = movedSimulation(current, written);
            const snapshot = { ...current, name, nameGeneratorVersion: version, simulation };
            cache.set(id, snapshot);
            const World = invoke('GameServer/World/World');
            for (const session of World.user?.sessions || []) {
                if (Number(session.actor?.fetchId?.()) !== id) continue;
                session.actor.model.name = name;
                session.name = name;
                for (const key of ['coldLifeState', 'coldMarketState', 'coldCraftState']) {
                    if (session[key]) session[key] = { ...session[key], name, nameGeneratorVersion: version, simulation };
                }
                RefreshPartyMemberships([session], invoke);
                if (session.actor.fetchIsOnline?.()) {
                    const Response = invoke('GameServer/Network/Response');
                    session.dataSendToMe?.(Response.userInfo(session.actor));
                    session.dataSendToOthers?.(Response.charInfo(session.actor), session.actor);
                }
            }
            invoke('GameServer/Clan/ClanService').renameMember(id, name);
            invoke('GameServer/AfkTrade/AfkTradeService').renameOwner(id, name);
            notifyColdSnapshot(snapshot, 'generated_name_migration', { critical: true });
            return snapshot;
        });
        const tracked = next.finally(() => { if (pendingWrites.get(id) === tracked) pendingWrites.delete(id); });
        pendingWrites.set(id, tracked);
        return tracked;
    },

    acceptAppearanceMetadata(characterId, sex, appearanceVersion) {
        const id = Number(characterId);
        if (!cache.has(id)) return Promise.resolve(null);
        const normalizedSex = Number(sex) & 1;
        const version = Math.max(1, Number(appearanceVersion) || 1);
        const previous = pendingWrites.get(id) || Promise.resolve();
        const next = previous.then(() => Database.updateGeneratedBotAppearance(id, normalizedSex, version))
            .then((result) => {
                if (!result?.ok) throw new Error(result?.reason || 'generated appearance migration failed');
                const current = cache.get(id);
                if (!current) return null;
                const snapshot = { ...current, appearanceVersion: version, simulation: movedSimulation(current, result) };
                cache.set(id, snapshot);
                notifyColdSnapshot(snapshot, 'generated_appearance_migration');
                return snapshot;
            }).catch((error) => {
                utils.infoWarn('BotLife', 'failed appearance migration for %s: %s', id, error.message || error);
                return null;
            });

        const tracked = next.finally(() => {
            if (pendingWrites.get(id) === tracked) {
                pendingWrites.delete(id);
            }
        });
        pendingWrites.set(id, tracked);
        return next;
    },

    subscribeChanges(listener) {
        if (typeof listener !== 'function') return () => {};
        changeListeners.add(listener);
        return () => changeListeners.delete(listener);
    },

    subscribePublications(listener, options = {}) {
        return cache.subscribePublications(listener, options);
    },

    subscribeMarketReviewChanges(listener) {
        if (typeof listener !== 'function') return () => {};
        marketReviewListeners.add(listener);
        return () => marketReviewListeners.delete(listener);
    },

    acceptSimulationOwnership(characterId, result = {}, committedState = null) {
        const id = Number(characterId);
        const current = cache.get(id);
        if (!current && !committedState) return null;
        if (committedState && Number(current?.stats?.clanLevelSpVersion || 0) > Number(committedState.stats?.clanLevelSpVersion || 0)) return current;
        const next = {
            ...(current || {}),
            ...(committedState || {}),
            simulation: { revision: Math.max(0, Number(result.revision || 0)) }
        };
        cache.set(id, next);
        notifyMarketReviewState(next, current);
        invoke('GameServer/Clan/ClanService').syncColdMember(next);
        return next;
    },

    allStates(limit = 500) {
        return cache.recent(recentLimit(limit));
    },

    // Every cached state, newest first, with no 2000 bound: for the feeds to
    // the cold worker, which must see the whole population.
    everyState() {
        return cache.recent(cache.size);
    },

    // Spot occupancy kept up to date at every state write (the hot body's kill
    // share, SpotProfiles.spotHunters; the status line's per-spot count).
    occupancyIndex() {
        return cache.occupancy;
    },

    // For a caller that changed the cached state object in place, not through a write.
    refreshOccupancy(state) {
        if (workerProjectorRole) throw new TypeError('worker_projector_occupancy_write');
        if (state && cache.get(Number(state.characterId)) === state) cache.occupancy.update(state);
    },

    populationSeedStates() {
        // A hard population cap must see every identity, including old states
        // outside the bounded, recent-state views used by UI and planners.
        return Array.from(cache.values());
    },

    stateRevision() {
        return cache.revision;
    },

    async safetyPage(page = {}) {
        if (page === null || typeof page !== 'object' || Array.isArray(page)) {
            throw new TypeError('Lifecycle safety page options must be an object');
        }
        const { afterId = 0, limit = 64 } = page;
        let { highWaterId } = page;
        if (!Number.isSafeInteger(afterId) || afterId < 0
            || !Number.isSafeInteger(limit) || limit < 1 || limit > 64
            || (highWaterId !== undefined && (!Number.isSafeInteger(highWaterId) || highWaterId < 0))
            || (highWaterId === undefined ? afterId !== 0 : afterId > highWaterId)) {
            throw new RangeError('Invalid lifecycle safety page cursor or limit');
        }
        if (!Database.isReady()) {
            throw Object.assign(new Error('Lifecycle safety database is unavailable'), {
                code: 'BOT_LIFE_SAFETY_UNAVAILABLE'
            });
        }
        // Fix only the cycle's upper PK boundary; each page reads current rows.
        if (highWaterId === undefined) {
            const [maximum] = await Database.execute([
                `SELECT COALESCE(MAX(characterId), 0) AS highWaterId FROM ${TABLE}`, []
            ], 'bot-life:safety-high-water');
            highWaterId = maximum.highWaterId;
            if (!Number.isSafeInteger(highWaterId) || highWaterId < 0) {
                throw new RangeError('Invalid lifecycle safety high-water identity');
            }
        }
        if (afterId === highWaterId) {
            return { rows: [], cursor: { afterId, highWaterId }, done: true };
        }
        const rows = await Database.execute([
            `SELECT characterId, phase, activity, simulationRevision,
                activityStartedAt, nextResolveAt,
                lastResolvedAt, lastHotAt, updatedAt
            FROM ${TABLE}
            WHERE characterId > ? AND characterId <= ? ORDER BY characterId ASC LIMIT ?`,
            [afterId, highWaterId, limit]
        ], 'bot-life:safety-page');
        const lastId = rows.length ? rows[rows.length - 1].characterId : afterId;
        // An exact-size page may need an empty final read after a deleted tail.
        // Do not inspect limit+1 rows just to predict that final read.
        const done = rows.length < limit || lastId === highWaterId;
        return { rows, cursor: { afterId: done ? highWaterId : lastId, highWaterId }, done };
    },

    // Bots by phase and level, counted from the cache: it holds every row of
    // the table and is written with it, so the director needs no table scan.
    levelHistogram() {
        if (!initialized) {
            return Promise.resolve({ levels: [], phases: {}, total: 0 });
        }
        const counts = new Map();
        for (const state of cache.values()) {
            const phase = state.phase || 'cold';
            const level = Number(state.level || 1);
            const key = `${phase}\u0000${level}`;
            const row = counts.get(key);
            if (row) row.count += 1;
            else counts.set(key, { phase, level, count: 1 });
        }
        const levels = [...counts.values()].sort((a, b) => a.level - b.level);
        const phases = {};
        let total = 0;
        for (const row of levels) {
            phases[row.phase] = (phases[row.phase] || 0) + row.count;
            total += row.count;
        }
        return Promise.resolve({ levels, phases, total });
    }
};

BotLifeState.canonicalizeAreaState = canonicalizeAreaState;
BotLifeState.inventorySummaryFromItems = inventorySummaryFromItems;
BotLifeState.inventoryStateFromItems = inventoryStateFromItems;
BotLifeState.setSessionSnapshotsAuthority = setSessionSnapshotsAuthority;
BotLifeState.equipmentSummaryFromInventory = equipmentSummaryFromInventory;
BotLifeState.marketPurchaseBlocker = marketPurchaseBlocker;
BotLifeState.normalizeInventoryStackability = normalizeInventoryStackability;
BotLifeState.preserveClanOwnedEquipmentState = preserveClanOwnedEquipmentState;
BotLifeState.reconcileEquipmentInventory = reconcileEquipmentInventory;
BotLifeState.reconcileFulfilledEquipmentPlan = reconcileFulfilledEquipmentPlan;
BotLifeState.reconcileIncompatibleShieldState = reconcileIncompatibleShieldState;

BotLifeState.targetCombatTelemetry = targetCombatTelemetry;

module.exports = BotLifeState;
