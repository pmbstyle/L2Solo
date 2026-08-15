const Database = invoke('Database');
const Metrics  = invoke('GameServer/Bot/Population/PopulationMetrics');
const DataCache = invoke('GameServer/DataCache');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const CraftShopService = invoke('GameServer/Bot/Economy/CraftShopService');
const SpotService = invoke('GameServer/Bot/AI/SpotService');

const TABLE = 'bot_life_state';
const GearSkillHints = invoke('GameServer/Bot/AI/GearSkillHints');
const BotClassProgression = invoke('GameServer/Bot/BotClassProgression');
const BotRoles = invoke('GameServer/Bot/AI/BotRoles');
const BotEquipmentCompatibility = invoke('GameServer/Bot/AI/BotEquipmentCompatibility');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const ColdCombatProfile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const WorldAreaCatalog = invoke('GameServer/World/WorldAreaCatalog');
const cache = new Map();
const pendingWrites = new Map();
let initialized = false;
let initStarted = false;
let initPromise = null;

function isCriticalSnapshotReason(reason = '', state = null) {
    if (state?.activity === 'dead') return true;
    return /death|dead|loot|drop|adena|inventory|market|trade|economy|shop|warehouse|sell|buy|purchase|equip|equipment|handoff|revive|resurrect/i.test(String(reason));
}

function notifyColdSnapshot(state, reason = 'state_changed', options = {}) {
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

function levelForExp(exp, fallback = 1) {
    const value = Number(exp || 0);
    const table = DataCache.experience || [];
    for (let i = 0; i < table.length - 1; i++) {
        if (value >= table[i] && value < table[i + 1]) {
            return i + 1;
        }
    }
    return fallback;
}

function itemTemplate(selfId) {
    return (DataCache.items || []).find((item) => Number(item.selfId) === Number(selfId)) || null;
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
    return Object.fromEntries(Object.entries(inventory || {}).map(([key, item]) => {
        const selfId = Number(item?.selfId || key);
        return [key, { ...(item || {}), stackable: itemStackable(selfId, item) }];
    }));
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
            kind: item.kind || ''
        })))
        .sort((a, b) => a.slot - b.slot || a.selfId - b.selfId);
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
    if (!equipmentTargetFulfilled(state.stats, state.inventory)) return state;
    const stats = { ...(state.stats || {}) };
    delete stats.equipmentPlan;
    delete stats.partyRequest;
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
    const role = state.stats?.role || BotRoles.inferRole(classId);
    const twoHanded = hasEquippedTwoHandedWeapon(state);
    const incompatiblePlan = Number(state.stats?.equipmentPlan?.target?.slot || 0) === 8 && twoHanded;
    const incompatibleEquippedShield = Object.values(state.inventory || {}).some((item) => (
        Number(itemTemplate(item?.selfId)?.etc?.slot || item?.slot || 0) === 8
        && GearAcquisitionPlanner.equippedSlotsFor(item, item.slot).includes(8)
        && (!BotEquipmentCompatibility.usesShield(role, classId) || twoHanded)
    ));
    return incompatiblePlan || incompatibleEquippedShield;
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
    const count = Number(qty);
    const template = itemTemplate(selfId);
    if (!template || !Number.isSafeInteger(count) || count <= 0) return null;
    const slot = Number(template.etc?.slot || 0);
    if (slot <= 0) return null;

    const combinationAmount = (state.stats?.equipmentPlan?.combine?.requirements || [])
        .filter((requirement) => Number(requirement.selfId) === selfId)
        .reduce((sum, requirement) => sum + Number(requirement.amount || 0), 0);
    const capacity = Math.max([1, 2, 4, 5].includes(slot) ? 2 : 1, combinationAmount);
    const owned = Math.max(0, Number(state.inventory?.[String(selfId)]?.amount || 0));
    if (owned + count > capacity) return 'already_owned';
    if (slot === 8 && hasEquippedTwoHandedWeapon(state)) return 'incompatible_loadout';
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

function syncInventorySummary(characterId, inventory) {
    return Database.syncInventorySummary(characterId, inventory);
}

function targetCombatTelemetry(previous = {}, debug = {}, timestamp = now()) {
    const targetNpcId = Number(debug?.targetNpcId || 0);
    if (targetNpcId <= 0) return null;
    const targetKey = String(targetNpcId);
    const defeatedNpcIds = (Array.isArray(debug.foughtNpcIds) ? debug.foughtNpcIds : debug.defeatedNpcIds || [])
        .map(Number)
        .filter((npcId) => npcId > 0);
    const targetKills = defeatedNpcIds.filter((npcId) => npcId === targetNpcId).length;
    const interruptions = defeatedNpcIds.length - targetKills;
    const add = (current = {}) => ({
        resolves: Number(current.resolves || 0) + 1,
        defeated: Number(current.defeated || 0) + defeatedNpcIds.length,
        targetKills: Number(current.targetKills || 0) + targetKills,
        interruptions: Number(current.interruptions || 0) + interruptions,
        lastDefeatedNpcIds: defeatedNpcIds,
        lastResolvedAt: timestamp
    });
    const limitTargets = (values) => Object.fromEntries(Object.entries(values)
        .sort(([, left], [, right]) => Number(right.lastResolvedAt || 0) - Number(left.lastResolvedAt || 0))
        .slice(0, 24));
    const targets = { ...(previous.targets || {}) };
    const current = add(targets[targetKey]);
    targets[targetKey] = current;
    const populationTargets = { ...(previous.populationTargets || {}) };
    if (!debug.aggregate || debug.populationTelemetryOwner === true) {
        populationTargets[targetKey] = add(populationTargets[targetKey]);
    }

    return {
        ...(previous || {}),
        targetNpcId,
        ...current,
        targets: limitTargets(targets),
        populationTargets: limitTargets(populationTargets)
    };
}

function compactResolveDebug(debug = {}) {
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
    const stats = parseJson(row.statsJson, {});
    const inventory = normalizeInventoryStackability(parseJson(row.inventorySummary, {}));

    return {
        characterId: Number(row.characterId),
        accountName: row.accountName || '',
        name: row.characterName || '',
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
        inventory,
        simulation: {
            ownerId: row.simulationOwner || 'legacy_main',
            revision: Math.max(0, Number(row.simulationRevision || 0)),
            leaseId: row.simulationLeaseId || null,
            leaseUntil: Math.max(0, Number(row.simulationLeaseUntil || 0))
        },
        updatedAt: Number(row.updatedAt || 0)
    };
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
        role: session.botStatus?.role || null,
        classId: actor.fetchClassId ? Number(actor.fetchClassId()) : null,
        // A freshly spawned bot may cool before it has gone through a cold
        // resolve. Persist the completed profile here so it is never picked
        // up by the one-off legacy migration on a later restart.
        classProgressionLevel: actor.fetchLevel(),
        classProgressionClassId: actor.fetchClassId ? Number(actor.fetchClassId()) : null,
        clanId: actor.fetchClanId ? Number(actor.fetchClanId()) || 0 : 0,
        route: currentSpot?.route || null,
        build: GearSkillHints.forCharacter(actor, { role: session.botStatus?.role || null }),
        equipment: equipmentSummaryFromInventory(inventory),
        // Cold combat must start from the exact same character model as the
        // hot session: equipped item totals, learned skills and live effects.
        // The resolver rebuilds those values deterministically after effects
        // expire, rather than retaining a stale buffed total indefinitely.
        coldCombat: ColdCombatProfile.capture(actor, timestamp),
        leaderId: session.followPlayerSession?.actor?.fetchId ? Number(session.followPlayerSession.actor.fetchId()) : null,
        supplyErrand: session.companionShopping?.kind === 'player_resource_purchase'
            ? {
                workflowId: session.companionShopping.workflowId || null,
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
        statsJson: safeJson(stats),
        updatedAt: timestamp
    };
}

function rowFromState(state) {
    const persistedState = reconcileFulfilledEquipmentPlan(state);
    return {
        characterId: persistedState.characterId,
        accountName: persistedState.accountName || '',
        characterName: persistedState.name || '',
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
        statsJson: safeJson(persistedState.stats || {}),
        // Legacy lifecycle writes are fenced in SQLite by simulationOwner, but
        // `save()` intentionally does not rewrite the ownership columns. Keep
        // the authoritative ownership snapshot on the transient row as well,
        // otherwise normalize(row) resets the in-memory revision to zero and
        // the cold worker rejects the resulting lifecycle ACK as stale.
        simulationOwner: persistedState.simulation?.ownerId || 'legacy_main',
        simulationRevision: Math.max(0, Number(persistedState.simulation?.revision || 0)),
        simulationLeaseId: persistedState.simulation?.leaseId || null,
        simulationLeaseUntil: Math.max(0, Number(persistedState.simulation?.leaseUntil || 0)),
        updatedAt: now()
    };
}

function save(row) {
    return Database.execute([
        `INSERT INTO ${TABLE} (
            characterId, accountName, characterName, level, exp, sp, adena, homeRegion, currentRegion,
            spotId, activity, phase, activityStartedAt, nextResolveAt,
            lastResolvedAt, lastHotAt, locX, locY, locZ, hp, maxHp, mp, maxMp,
            targetLevelBand, deathCount, partyId, inventorySummary, statsJson, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(characterId) DO UPDATE SET
            accountName = excluded.accountName,
            characterName = excluded.characterName,
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
            statsJson = excluded.statsJson,
            updatedAt = excluded.updatedAt
        WHERE ${TABLE}.simulationOwner = 'legacy_main'`,
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
            row.updatedAt
        ]
    ]).then((result) => {
        if (result && typeof result.affectedRows === 'number' && result.affectedRows !== 1) {
            const error = new Error(`bot life state ownership conflict for ${row.characterId}`);
            error.code = 'BOT_LIFE_STATE_OWNERSHIP_CONFLICT';
            throw error;
        }
        Metrics.recordDbFlush();
        return result;
    });
}

function hydrateCache() {
    return Database.execute([
        `SELECT * FROM ${TABLE}`,
        []
    ]).then((rows) => {
        rows.forEach((row) => {
            const state = normalize(row);
            cache.set(state.characterId, state);
        });
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
    return knownLevel < Number(level || 1) || knownClassId !== Number(classId);
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
        seed: state.name || state.characterId
    }).then((resolved) => {
        const classId = Number(resolved.classId || currentClassId);
        const role = BotRoles.inferRole(classId);
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
                build: GearSkillHints.forCharacter({ classId, level }, { role }),
                classProgressionLevel: level,
                classProgressionClassId: classId,
                classTransitions: resolved.transitions?.length
                    ? [...(state.stats?.classTransitions || []), ...resolved.transitions]
                    : state.stats?.classTransitions || []
            }
        };
        if (resolved.transitions?.length) delete progressedState.stats.equipmentPlan;
        return refreshColdCombatProfile(reconcileEquipmentInventory(progressedState));
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
            SELECT partyId FROM bot_background_parties WHERE status <> 'active'
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
    const observedStats = parseJson(observed.statsJson, {});
    const observedInventory = parseJson(observed.inventorySummary, {});
    const timestamp = now();
    return {
        ...state,
        accountName: observed.accountName,
        name: observed.characterName,
        level: observed.level,
        exp: observed.exp,
        sp: observed.sp,
        adena: observed.adena,
        phase,
        activity: options.activity || state.activity || observed.activity,
        loc: options.loc || state.loc || { locX: observed.locX, locY: observed.locY, locZ: observed.locZ },
        vitals: { hp: observed.hp, maxHp: observed.maxHp, mp: observed.mp, maxMp: observed.maxMp },
        levelBand: observed.targetLevelBand || state.levelBand,
        timing: {
            ...(state.timing || {}),
            activityStartedAt: timestamp,
            nextResolveAt: options.nextResolveAt ?? state.timing?.nextResolveAt ?? null,
            lastHotAt: phase === 'hot' ? timestamp : state.timing?.lastHotAt || null
        },
        stats: { ...(state.stats || {}), ...observedStats, lastReason: reason },
        inventory: preserveStarterLootProvenance(state.inventory, observedInventory)
    };
}

// A stale cold snapshot can retain the previous hunting region while its
// physical coordinate is still on the Giran trading square.  Coordinates are
// authoritative here: currentRegion is plan context, not a location proof.
const GIRAN_MARKET_PLAZA = Object.freeze({
    minX: 80911,
    // Public stations and the north-east edge of the actual trading square
    // extend beyond the conservative stall-placement rectangle.
    maxX: 83750,
    minY: 147662,
    maxY: 149550
});

function isOnGiranMarketPlaza(loc = {}) {
    return Number(loc.locX) >= GIRAN_MARKET_PLAZA.minX
        && Number(loc.locX) <= GIRAN_MARKET_PLAZA.maxX
        && Number(loc.locY) >= GIRAN_MARKET_PLAZA.minY
        && Number(loc.locY) <= GIRAN_MARKET_PLAZA.maxY;
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
        AND activity IN ('traveling', 'shopping', 'merchant', 'crafting', 'dead')
        AND json_extract(statsJson, '$.partyRequest.status') = 'open'`,
        [timestamp]
    ]).then((result) => {
        const cleared = Number(result?.affectedRows || 0);
        if (cleared > 0) {
            utils.infoWarn('BotLife', 'cleared %d passive party requests on startup', cleared);
        }
        return cleared;
    });
}

function expireStalePartyRequests(limit = 0) {
    const timestamp = now();
    const requiredMaxAge = Math.max(30000, Number(Config.partyRequestMaxAgeMs) || 15 * 60 * 1000);
    const preferredMaxAge = Math.max(30000, Number(Config.partyPreferredMaxAgeMs) || 5 * 60 * 1000);
    const cooldownMs = Math.max(30000, Number(Config.partyRequestCooldownMs) || 5 * 60 * 1000);
    // Spread the next eligible formation attempts over at most two minutes so
    // a restart cannot turn one historical queue into a new SQLite spike.
    const staggerMs = Math.min(120000, Math.max(0, Math.floor(cooldownMs / 2)));
    const safeLimit = Math.max(0, Math.min(500, Number(limit) || 0));
    const staleSelection = `phase = 'cold'
        AND simulationOwner = 'legacy_main'
        AND (partyId IS NULL OR partyId = '')
        AND activity IN ('hunting', 'resting', 'party_wait')
        AND json_extract(statsJson, '$.partyRequest.status') = 'open'
        AND CAST(json_extract(statsJson, '$.partyRequest.requestedAt') AS INTEGER) <=
            CASE WHEN json_extract(statsJson, '$.partyRequest.priority') = 'required' THEN ? ELSE ? END`;
    const target = safeLimit > 0
        ? `characterId IN (
                SELECT characterId FROM ${TABLE}
                WHERE ${staleSelection}
                ORDER BY updatedAt ASC, characterId ASC
                LIMIT ${safeLimit}
            )`
        : staleSelection;
    const sql = `UPDATE ${TABLE}
        SET statsJson = json_set(
                COALESCE(statsJson, '{}'),
                '$.partyRequest.status', 'deferred',
                '$.partyRequest.deferredUntil', ? + (ABS(characterId) % ?),
                '$.partyRequest.expiredAt', ?,
                '$.partyRequest.attempts', COALESCE(CAST(json_extract(statsJson, '$.partyRequest.attempts') AS INTEGER), 0) + 1
            ),
            updatedAt = ?
        WHERE ${target}`;
    const params = [
        timestamp + cooldownMs,
        Math.max(1, staggerMs),
        timestamp,
        timestamp,
        timestamp - requiredMaxAge,
        timestamp - preferredMaxAge
    ];
    const staleParams = [timestamp - requiredMaxAge, timestamp - preferredMaxAge];
    const selectStale = () => Database.execute([
        `SELECT characterId, statsJson FROM ${TABLE} WHERE ${target}`,
        staleParams
    ]);
    const updateCache = (rows) => {
        (rows || []).forEach((row) => {
            const characterId = Number(row.characterId || 0);
            const cached = cache.get(characterId);
            if (!cached) return;
            const request = parseJson(row.statsJson, {}).partyRequest;
            if (request?.status !== 'open') return;
            if (cached.stats?.partyRequest?.status !== 'open') return;
            cache.set(characterId, {
                ...cached,
                updatedAt: timestamp,
                stats: {
                    ...(cached.stats || {}),
                    partyRequest: {
                        ...request,
                        status: 'deferred',
                        deferredUntil: timestamp + cooldownMs + (Math.abs(characterId) % Math.max(1, staggerMs)),
                        expiredAt: timestamp,
                        attempts: Number(request.attempts || 0) + 1
                    }
                }
            });
        });
    };
    const waitForPending = (rows) => Promise.all((rows || [])
        .map((row) => pendingWrites.get(Number(row.characterId || 0)))
        .filter(Boolean)
        .map((pending) => pending.catch(() => null)));
    return selectStale()
        .then((rows) => waitForPending(rows).then(() => selectStale()))
        .then((rows) => Database.execute([sql, params]).then((result) => {
            if (Number(result?.affectedRows || 0) > 0) updateCache(rows);
            const expired = Number(result?.affectedRows || 0);
            if (expired > 0) {
                utils.infoWarn('BotLife', 'deferred %d stale party requests', expired);
            }
            return expired;
        }));
}

function discardInvalidEquipmentPlans() {
    const timestamp = now();
    return Database.execute([
        `UPDATE ${TABLE}
        SET statsJson = json_remove(COALESCE(statsJson, '{}'), '$.equipmentPlan'),
            updatedAt = ?
        WHERE json_extract(statsJson, '$.equipmentPlan.target') IS NOT NULL
        AND (
            COALESCE(CAST(json_extract(statsJson, '$.equipmentPlan.target.selfId') AS INTEGER), 0) <= 0
            OR TRIM(COALESCE(json_extract(statsJson, '$.equipmentPlan.target.name'), '')) IN ('', '0')
        )`,
        [timestamp]
    ]).then((result) => {
        const discarded = Number(result?.affectedRows || 0);
        if (discarded > 0) {
            utils.infoWarn('BotLife', 'discarded %d invalid equipment plans on startup', discarded);
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
        SET statsJson = json_remove(COALESCE(statsJson, '{}'), '$.equipmentPlan', '$.partyRequest'),
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

function reconcileIncompatibleShields() {
    const affected = [...cache.values()].filter(hasIncompatibleShield);
    let reconciledCount = 0;
    return affected.reduce((chain, state) => chain.then(() => {
        const reconciled = reconcileIncompatibleShieldState(state);
        const row = rowFromState(reconciled);
        return save(row)
            .then(() => syncInventorySummary(row.characterId, reconciled.inventory))
            .then(() => {
                cache.set(row.characterId, normalize(row));
                reconciledCount += 1;
            })
            .catch((err) => {
                utils.infoWarn('BotLife', 'failed shield reconciliation for %d: %s', row.characterId, err.message);
            });
    }), Promise.resolve()).then(() => {
        if (reconciledCount > 0) {
            utils.infoWarn('BotLife', 'reconciled %d incompatible persisted shield loadouts or plans on startup', reconciledCount);
        }
        return reconciledCount;
    });
}

const BotLifeState = {
    init() {
        if (initialized) return Promise.resolve(true);
        if (initStarted) return initPromise;
        initStarted = true;

        initPromise = Database.execute(['SELECT 1', []], 'schema:bot-life')
            // A process restart invalidates every in-process logical owner,
            // even when its wall-clock lease had time remaining. Reclaim the
            // rows before any legacy startup repair can touch them.
            .then(() => invoke('GameServer/Bot/Population/ColdSimulationOwner').recoverStartupLeases())
            .then(() => recoverStaleHotStates()).then(() => recoverDissolvedPartyMembers()).then(() => recoverStaleCraftWaits()).then(() => migrateAcquisitionPartyWaits()).then(() => clearPassivePartyRequests()).then(() => expireStalePartyRequests()).then(() => discardInvalidEquipmentPlans()).then(() => discardFulfilledEquipmentPlans()).then(() => hydrateCache()).then((count) => {
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
                        cache.set(state.characterId, state);
                    });
            }), Promise.resolve())
                .then(() => reconcileIncompatibleShields())
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
        const marketState = session.coldMarketState;
        const craftState = refreshCraftShop(session.coldCraftState);
        if (marketState?.stats?.marketStore) {
            row.activity = 'merchant';
            row.currentRegion = marketState.currentRegion || row.currentRegion;
            row.spotId = marketState.spotId || row.spotId;
            row.inventorySummary = safeJson(marketState.inventory || {});
            row.adena = Number(marketState.adena || row.adena || 0);
            row.statsJson = safeJson({ ...(marketState.stats || {}), lastReason: reason });
        } else if (craftState?.stats?.craftShop) {
            row.activity = 'crafting';
            row.currentRegion = craftState.currentRegion || row.currentRegion;
            row.spotId = craftState.spotId || row.spotId;
            row.statsJson = safeJson({ ...(craftState.stats || {}), lastReason: reason });
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
            cache.set(characterId, snapshot);
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
        if (!session || !session.actor) return Promise.resolve(null);

        const marketState = session.coldMarketState;
        const craftState = refreshCraftShop(session.coldCraftState);
        if (marketState?.stats?.marketStore) {
            const actor = session.actor;
            const store = actor.fetchPrivateStore?.();
            const timestamp = now();
            const storeLoc = marketState.stats.marketStore.loc || marketState.loc;
            const persistedItems = new Map((marketState.stats.marketStore.items || []).map((item) => [Number(item.selfId), item]));
            const nextState = {
                ...marketState,
                phase: 'cold',
                activity: 'merchant',
                loc: { ...storeLoc },
                timing: {
                    ...(marketState.timing || {}),
                    activityStartedAt: timestamp,
                    nextResolveAt: Number(marketState.stats?.marketStore?.expiresAt || 0) || timestamp + 60000
                },
                stats: {
                    ...(marketState.stats || {}),
                    marketStore: {
                        ...(marketState.stats.marketStore || {}),
                        loc: { ...storeLoc },
                        items: (store?.items || []).map((item) => ({
                            ...(persistedItems.get(Number(item.selfId)) || {}),
                            selfId: Number(item.selfId), price: Number(item.price), count: Number(item.count), name: item.name || itemName(item.selfId),
                            rank: item.rank || persistedItems.get(Number(item.selfId))?.rank || itemTemplate(item.selfId)?.etc?.rank || 'none'
                        }))
                    }
                }
            };
            return this.upsertState(nextState, reason);
        }

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
                    nextResolveAt: null
                },
                stats: { ...(craftState.stats || {}), lastReason: reason },
                inventory: parseJson(row.inventorySummary, {})
            };
            return this.upsertState(nextState, reason);
        }

        if (session.coldLifeState) {
            const preserved = recoverOrphanedGiranState(session.coldLifeState);
            const nextState = mergeSessionIntoLifeState(session, preserved, 'cold', reason, {
                loc: preserved.loc,
                nextResolveAt: now() + 30000 + Math.round(Math.random() * 90000)
            });
            session.coldLifeState = nextState;
            return this.upsertState(nextState, reason);
        }

        const row = {
            ...recordFromSession(session, 'cold', reason),
            nextResolveAt: now() + 30000 + Math.round(Math.random() * 90000)
        };
        const characterId = row.characterId;
        const previous = pendingWrites.get(characterId) || Promise.resolve();
        const ready = initialized ? Promise.resolve(true) : this.init();
        const next = previous.then(() => ready).then((isReady) => {
            if (!isReady) {
                throw new Error('state table unavailable');
            }
            return save(row);
        }).then(() => Database.updateCharacterLocation(row.characterId, {
            locX: row.locX,
            locY: row.locY,
            locZ: row.locZ
        })).then(() => Database.updateCharacterExperience(row.characterId, row.level, row.exp, row.sp))
            .then(() => Database.updateCharacterVitals(row.characterId, row.hp, row.maxHp, row.mp, row.maxMp))
            .then(() => {
                const snapshot = normalize(row);
                cache.set(characterId, snapshot);
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

        const safeRadius = Math.max(1, Number(radius) || 6000);
        const safeLimit = Math.max(1, Math.min(100, Number(limit) || 10));
        const minX = Number(loc.locX) - safeRadius;
        const maxX = Number(loc.locX) + safeRadius;
        const minY = Number(loc.locY) - safeRadius;
        const maxY = Number(loc.locY) + safeRadius;

        return Database.execute([
            `SELECT * FROM ${TABLE}
            WHERE phase = 'cold'
            AND activity <> 'pk_hunting'
            AND locX BETWEEN ? AND ?
            AND locY BETWEEN ? AND ?
            ORDER BY ((locX - ?) * (locX - ?)) + ((locY - ?) * (locY - ?)) ASC
            LIMIT ${safeLimit * 3}`,
            [minX, maxX, minY, maxY, Number(loc.locX), Number(loc.locX), Number(loc.locY), Number(loc.locY)]
        ]).then((rows) => rows.map((row) => normalize(row))
            .map((state) => {
                const dx = state.loc.locX - Number(loc.locX);
                const dy = state.loc.locY - Number(loc.locY);
                return { state, distance: Math.sqrt(dx * dx + dy * dy) };
            })
            .filter((item) => item.distance <= safeRadius)
            .sort((a, b) => a.distance - b.distance)
            .slice(0, safeLimit)
            .map((item) => {
                cache.set(item.state.characterId, item.state);
                return item.state;
            })).catch((err) => {
                utils.infoWarn('BotLife', 'failed to fetch nearby cold states: %s', err.message);
                return [];
            });
    },

    dueCold(limit = 10, at = now()) {
        if (!initialized) return Promise.resolve([]);
        const safeLimit = Math.max(1, Math.min(100, Number(limit) || 10));
        // A changed drop model can make an active direct-drop route unsafe.
        // Pull only fighting bots forward: resting and travelling states are
        // intentionally event-scheduled and cannot hurt themselves while
        // they wait for their persisted deadline.
        const staleRateModelPlan = `json_extract(statsJson, '$.equipmentPlan.status') = 'active'
                AND json_extract(statsJson, '$.equipmentPlan.expectedKills') IS NOT NULL
                AND COALESCE(CAST(json_extract(statsJson, '$.equipmentPlan.rateModelVersion') AS INTEGER), 0) < ${GearAcquisitionPlanner.RATE_MODEL_VERSION}`;
        const pendingEquipmentSpotReplan = `activity IN ('hunting', 'resting')
                AND json_extract(statsJson, '$.equipmentPlan.status') = 'active'
                AND json_extract(statsJson, '$.equipmentPlan.next.spotId') IS NOT NULL
                AND json_extract(statsJson, '$.equipmentPlan.next.spotId') <> COALESCE(spotId, '')`;

        return Database.execute([
            `SELECT * FROM ${TABLE}
            WHERE phase = 'cold'
            AND activity <> 'pk_hunting'
            AND (partyId IS NULL OR partyId = '')
            AND simulationOwner = 'legacy_main'
            -- Cold stores settle on trade/expiry events, and craft-service
            -- stations are materialized on demand.  Neither belongs in the
            -- combat scheduler's periodic queue.
            AND NOT (activity = 'merchant' AND json_extract(statsJson, '$.marketStore') IS NOT NULL)
            AND NOT (activity = 'crafting' AND json_extract(statsJson, '$.craftShop') IS NOT NULL)
            AND (
                nextResolveAt IS NULL OR nextResolveAt <= ?
                OR (activity = 'hunting' AND (${staleRateModelPlan}))
            )
            -- Travel, the arrived market action, and crafting are finite
            -- state transitions. They must outrank a large resting/hunting
            -- backlog, otherwise a bot can remain at a market or station
            -- for minutes after it is already due.
            ORDER BY CASE
                -- Replan active combat before it can continue using a stale
                -- target level or drop-rate estimate.
                WHEN ${staleRateModelPlan} THEN 0
                WHEN activity IN ('traveling', 'shopping', 'crafting') THEN 1
                -- An active equipment plan whose next source is elsewhere
                -- must get a chance to start gatekeeper travel before the
                -- ordinary hunting backlog keeps resolving the old spot.
                WHEN ${pendingEquipmentSpotReplan} THEN 2
                -- Startup craft recovery is a one-shot replan.  Serve it
                -- before the normal hunting backlog so a repaired station
                -- wait immediately selects its missing raw material.
                WHEN json_extract(statsJson, '$.lastReason') = 'startup_craft_wait_recovery' THEN 3
                WHEN activity = 'dead' THEN 4
                ELSE 5
            END ASC,
            COALESCE(nextResolveAt, 0) ASC
            LIMIT ${safeLimit}`,
            [at]
        ]).then((rows) => rows.map((row) => {
            const state = normalize(row);
            cache.set(state.characterId, state);
            return state;
        })).catch((err) => {
            utils.infoWarn('BotLife', 'failed to fetch due cold states: %s', err.message);
            return [];
        });
    },

    legacyMarketTownCandidates(limit = 10, routingVersion = 1) {
        if (!initialized) return Promise.resolve([]);
        const safeLimit = Math.max(1, Math.min(25, Number(limit) || 10));
        const version = Math.max(1, Number(routingVersion) || 1);
        return Database.execute([
            `SELECT * FROM ${TABLE}
            WHERE phase = 'cold'
            AND activity = 'merchant'
            AND json_extract(statsJson, '$.marketStore') IS NOT NULL
            AND COALESCE(CAST(json_extract(statsJson, '$.marketStore.marketTownRoutingVersion') AS INTEGER), 0) < ?
            AND COALESCE(CAST(json_extract(statsJson, '$.marketStore.expiresAt') AS INTEGER), 0) > ?
            ORDER BY updatedAt ASC
            LIMIT ${safeLimit}`,
            [version, Date.now()]
        ]).then((rows) => rows.map((row) => {
            const state = normalize(row);
            cache.set(state.characterId, state);
            return state;
        })).catch((err) => {
            utils.infoWarn('BotLife', 'failed to fetch legacy market-town candidates: %s', err.message);
            return [];
        });
    },

    expiredMarketStoreCandidates(limit = 10, timestamp = Date.now()) {
        if (!initialized) return Promise.resolve([]);
        const safeLimit = Math.max(1, Math.min(25, Number(limit) || 10));
        return Database.execute([
            `SELECT * FROM ${TABLE}
            WHERE phase = 'cold'
            AND activity = 'merchant'
            AND json_extract(statsJson, '$.marketStore') IS NOT NULL
            AND COALESCE(CAST(json_extract(statsJson, '$.marketStore.expiresAt') AS INTEGER), 0) <= ?
            ORDER BY updatedAt ASC
            LIMIT ${safeLimit}`,
            [Number(timestamp) || Date.now()]
        ]).then((rows) => rows.map((row) => {
            const state = normalize(row);
            cache.set(state.characterId, state);
            return state;
        })).catch((err) => {
            utils.infoWarn('BotLife', 'failed to fetch expired market stores: %s', err.message);
            return [];
        });
    },

    marketStoreMaintenanceCandidates(limit = 10, timestamp = Date.now()) {
        if (!initialized) return Promise.resolve([]);
        const safeLimit = Math.max(1, Math.min(25, Number(limit) || 10));
        const at = Number(timestamp) || Date.now();
        return Database.execute([
            `SELECT * FROM ${TABLE}
            WHERE phase = 'cold'
            AND activity = 'merchant'
            AND json_extract(statsJson, '$.marketStore') IS NOT NULL
            AND (
                COALESCE(CAST(json_extract(statsJson, '$.marketStore.expiresAt') AS INTEGER), 0) <= ?
                OR (
                    COALESCE(CAST(json_extract(statsJson, '$.marketStore.storeType') AS INTEGER), 1) = 1
                    AND COALESCE(
                        CAST(json_extract(statsJson, '$.marketStore.nextReviewAt') AS INTEGER),
                        CAST(json_extract(statsJson, '$.marketStore.openedAt') AS INTEGER),
                        0
                    ) <= ?
                )
            )
            ORDER BY CASE
                WHEN COALESCE(CAST(json_extract(statsJson, '$.marketStore.expiresAt') AS INTEGER), 0) <= ? THEN 0
                ELSE 1
            END ASC,
            updatedAt ASC
            LIMIT ${safeLimit}`,
            [at, at, at]
        ]).then((rows) => rows.map((row) => {
            const state = normalize(row);
            cache.set(state.characterId, state);
            return state;
        })).catch((err) => {
            utils.infoWarn('BotLife', 'failed to fetch market maintenance candidates: %s', err.message);
            return [];
        });
    },

    migrateLegacyClassProgression(limit = 5) {
        if (!initialized) return Promise.resolve([]);
        const safeLimit = Math.max(1, Math.min(20, Number(limit) || 5));
        const candidates = Array.from(cache.values())
            // Hot bots own a live Actor instance. Their class is reconciled
            // through activation/level-up, not behind that actor's back.
            .filter((state) => state.phase === 'cold')
            .filter((state) => !pendingWrites.has(state.characterId))
            .filter((state) => classProgressionNeeded(
                state,
                Number(state.stats?.classId || 0),
                Number(state.level || 1)
            ))
            .sort((a, b) => Number(a.updatedAt || 0) - Number(b.updatedAt || 0))
            .slice(0, safeLimit);

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
                AND json_extract(statsJson, '$.partyRequest.status') = 'open'
                AND json_extract(statsJson, '$.partyRequest.priority') = 'required'`
            : "activity IN ('hunting', 'resting', 'party_wait')";
        const stateActivityClause = partyRequiredOnly
            ? `states.activity IN ('hunting', 'resting', 'party_wait')
                AND json_extract(states.statsJson, '$.partyRequest.status') = 'open'
                AND json_extract(states.statsJson, '$.partyRequest.priority') = 'required'`
            : "states.activity IN ('hunting', 'resting', 'party_wait')";
        const objectiveSpot = "COALESCE(json_extract(statsJson, '$.partyRequest.spotId'), json_extract(statsJson, '$.equipmentPlan.next.spotId'), spotId)";
        const stateObjectiveSpot = "COALESCE(json_extract(states.statsJson, '$.partyRequest.spotId'), json_extract(states.statsJson, '$.equipmentPlan.next.spotId'), states.spotId)";

        return Database.execute([
            `SELECT states.* FROM ${TABLE} states
            INNER JOIN (
                SELECT ${objectiveSpot} AS candidateSpot, COUNT(*) AS candidateCount, MIN(updatedAt) AS oldestAt
                FROM ${TABLE}
                WHERE phase = 'cold'
                AND (partyId IS NULL OR partyId = '')
                AND spotId IS NOT NULL
                AND ${activityClause}
                GROUP BY candidateSpot
            ) party_spots ON party_spots.candidateSpot = ${stateObjectiveSpot}
            WHERE states.phase = 'cold'
            AND (states.partyId IS NULL OR states.partyId = '')
            AND states.spotId IS NOT NULL
            AND ${stateActivityClause}
            ORDER BY
                CASE
                    WHEN json_extract(states.statsJson, '$.partyRequest.status') = 'open'
                        AND json_extract(states.statsJson, '$.partyRequest.priority') = 'required' THEN 0
                    WHEN json_extract(states.statsJson, '$.partyRequest.status') = 'open' THEN 1
                    ELSE 2
                END ASC,
                party_spots.candidateCount DESC, party_spots.oldestAt ASC,
                states.level ASC, states.updatedAt ASC
            LIMIT ${safeLimit}`,
            []
        ]).then((rows) => rows.map((row) => {
            const state = normalize(row);
            cache.set(state.characterId, state);
            return state;
        })).catch((err) => {
            utils.infoWarn('BotLife', 'failed to fetch party candidates: %s', err.message);
            return [];
        });
    },

    statesForParties(partyIds = []) {
        const ids = [...new Set((partyIds || []).map((partyId) => String(partyId || '')).filter(Boolean))];
        if (!initialized || !ids.length) return Promise.resolve(new Map());

        const placeholders = ids.map(() => '?').join(', ');
        return Database.execute([
            `SELECT * FROM ${TABLE}
            WHERE phase = 'cold'
            AND partyId IN (${placeholders})
            ORDER BY partyId ASC, level DESC, characterId ASC`,
            ids
        ]).then((rows) => {
            const grouped = new Map(ids.map((partyId) => [partyId, []]));
            rows.forEach((row) => {
                const state = normalize(row);
                cache.set(state.characterId, state);
                const partyId = String(row.partyId || '');
                if (!grouped.has(partyId)) grouped.set(partyId, []);
                grouped.get(partyId).push(state);
            });
            return grouped;
        }).catch((err) => {
            utils.infoWarn('BotLife', 'failed to fetch %d parties: %s', ids.length, err.message);
            return new Map(ids.map((partyId) => [partyId, []]));
        });
    },

    coldPartyCandidateCount(partyRequiredOnly = false) {
        if (!initialized) return Promise.resolve(0);
        const activityClause = partyRequiredOnly
            ? `activity IN ('hunting', 'resting', 'party_wait')
                AND json_extract(statsJson, '$.partyRequest.status') = 'open'
                AND json_extract(statsJson, '$.partyRequest.priority') = 'required'`
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
            ? `states.activity IN ('hunting', 'resting', 'party_wait')
                AND json_extract(states.statsJson, '$.partyRequest.status') = 'open'
                AND json_extract(states.statsJson, '$.partyRequest.priority') = 'required'`
            : "states.activity IN ('hunting', 'resting', 'party_wait')";
        const objectiveSpot = "COALESCE(json_extract(states.statsJson, '$.partyRequest.spotId'), json_extract(states.statsJson, '$.equipmentPlan.next.spotId'), states.spotId)";

        return Database.execute([
            `SELECT * FROM (
                SELECT states.*,
                    ROW_NUMBER() OVER (
                        PARTITION BY ${objectiveSpot}
                        ORDER BY states.updatedAt ASC, states.level ASC, states.characterId ASC
                    ) AS candidateRank
                FROM ${TABLE} states
                WHERE states.phase = 'cold'
                AND (states.partyId IS NULL OR states.partyId = '')
                AND ${objectiveSpot} IN (${placeholders})
                AND ${activityClause}
            ) ranked
            WHERE candidateRank <= ${safeLimit}
            ORDER BY spotId ASC, candidateRank ASC`,
            uniqueSpots
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

    assignParty(state, partyId, role = 'dps', leaderId = 0) {
        if (!state || !partyId) return Promise.resolve(null);

        const hasPartyRequest = state.stats?.partyRequest?.status === 'open';
        const wasWaitingForParty = state.activity === 'party_wait'
            || state.stats?.lastReason === 'acquisition_party_wait'
            || (hasPartyRequest && state.activity !== 'resting');
        const timestamp = now();
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
                nextResolveAt: wasWaitingForParty ? null : state.timing?.nextResolveAt
            },
            updatedAt: timestamp
        };
        const row = rowFromState(nextState);

        return save(row).then(() => {
            const snapshot = normalize(row);
            cache.set(snapshot.characterId, snapshot);
            return snapshot;
        }).catch((err) => {
            utils.infoWarn('BotLife', 'failed to assign %s to party %s: %s', state.name, partyId, err.message);
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

    prepareResolve(state, result, options = {}) {
        if (!state || !result) return Promise.resolve(null);

        const timestamp = Number(options.timestamp || now());
        const exp = Number(state.exp || 0) + Number(result.materialize?.exp || 0);
        const sp = Number(state.sp || 0) + Number(result.materialize?.sp || 0);
        const level = levelForExp(exp, Number(state.level || 1));
        const materializedItems = result.materialize?.items || [];
        const materializedAdenaItems = materializedItems
            .filter((item) => Number(item.selfId) === 57)
            .reduce((sum, item) => sum + Number(item.amount || 0), 0);
        const adena = Number(state.adena || 0) + Number(result.materialize?.adena || 0) + materializedAdenaItems;
        const targetCombat = targetCombatTelemetry(state.stats?.targetCombat, result.debug, timestamp);
        const nextSpotId = result.patch?.spotId || state.spotId;
        const previousRisk = state.stats?.spotRisk;
        const spotRisk = String(previousRisk?.spotId || '') === String(nextSpotId || '')
            ? previousRisk
            : {
                spotId: nextSpotId || null,
                enteredAt: timestamp,
                deathsAtEntry: Number(state.stats?.deaths || 0),
                fightsAtEntry: Number(state.stats?.fightsResolved || 0)
            };
        // Resolver patches often carry a projected copy of the previous
        // stats so they can add lifecycle-specific fields such as cooldowns,
        // rest deadlines, travel state, or party affinity.  Merge that copy
        // first, then stamp the counters owned by this resolve.  Reversing
        // this order silently restores the previous counters after every
        // solo/party fight (including deaths).
        const patchedStats = {
            ...(state.stats || {}),
            ...(result.patch?.stats || {})
        };
        const stats = {
            ...patchedStats,
            fightsWon: Number(state.stats?.fightsWon || 0) + Number(result.debug?.wins || 0),
            fightsResolved: Number(state.stats?.fightsResolved || 0) + Number(result.debug?.fights || 0),
            deaths: Number(result.patch?.deathCount ?? state.stats?.deaths ?? 0),
            expEarned: Number(state.stats?.expEarned || 0) + Number(result.materialize?.exp || 0),
            spEarned: Number(state.stats?.spEarned || 0) + Number(result.materialize?.sp || 0),
            adenaEarned: Number(state.stats?.adenaEarned || 0) + Number(result.materialize?.adena || 0) + materializedAdenaItems,
            route: result.debug?.route || state.stats?.route || null,
            lastResolveDebug: compactResolveDebug(result.debug),
            ...(targetCombat ? { targetCombat } : {})
        };
        const inventory = { ...(state.inventory || {}) };
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
                // Party combat carries a projected combat snapshot in patch.stats.
                // Keep lifecycle telemetry from this resolve authoritative over
                // that snapshot, which still contains the previous tick's data.
                ...(targetCombat ? { targetCombat } : {}),
                ...(nextActivity === 'dead' ? { partyRequest: null } : {}),
                lastResolveDebug: compactResolveDebug(result.debug),
                equipment: equipmentSummaryFromInventory(equippedInventory)
            },
            inventory: equippedInventory,
            updatedAt: timestamp
        };
        const knownProfileLevel = Number(nextState.stats?.classProgressionLevel || 0);
        const knownProfileClassId = Number(nextState.stats?.classProgressionClassId ?? nextState.stats?.classId);
        const currentClassId = Number(nextState.stats?.classId || 0);
        const needsClassProgression = knownProfileLevel < level || knownProfileClassId !== currentClassId;
        const progression = needsClassProgression
            ? (options.projectClassProgression === true ? Promise.resolve(BotClassProgression.plan({
                classId: currentClassId,
                level,
                seed: nextState.name || nextState.characterId
            })) : BotClassProgression.reconcile({
                characterId: nextState.characterId,
                classId: currentClassId,
                level,
                seed: nextState.name || nextState.characterId
            }))
            : Promise.resolve({ classId: currentClassId, transitions: [] });

        return progression.then((resolved) => {
            const classId = Number(resolved.classId || currentClassId);
            const role = BotRoles.inferRole(classId);
            const progressedState = {
                ...nextState,
                party: { ...(nextState.party || {}), role },
                stats: {
                    ...(nextState.stats || {}),
                    classId,
                    role,
                    build: GearSkillHints.forCharacter({ classId, level }, { role }),
                    classProgressionLevel: level,
                    classProgressionClassId: classId,
                    classTransitions: resolved.transitions?.length
                        ? [...(nextState.stats?.classTransitions || []), ...resolved.transitions]
                        : nextState.stats?.classTransitions || []
                }
            };
            if (resolved.transitions?.length) delete progressedState.stats.equipmentPlan;
            const equippedProgressedState = reconcileEquipmentInventory(progressedState);
            const profileReady = needsClassProgression
                ? (options.projectClassProgression === true
                    ? projectColdCombatProfile(equippedProgressedState, timestamp)
                    : refreshColdCombatProfile(equippedProgressedState))
                : Promise.resolve(equippedProgressedState);

            return profileReady.then((profiledState) => {
                if (options.persist === false) {
                    return {
                        ...reconcileFulfilledEquipmentPlan(profiledState),
                        updatedAt: timestamp
                    };
                }
                const row = rowFromState(profiledState);
                return save(row)
                    .then(() => Database.updateCharacterExperience(row.characterId, row.level, row.exp, row.sp))
                    .then(() => Database.updateCharacterVitals(row.characterId, row.hp, row.maxHp, row.mp, row.maxMp))
                    .then(() => syncInventorySummary(row.characterId, profiledState.inventory))
                    .then(() => {
                        const snapshot = normalize(row);
                        cache.set(snapshot.characterId, snapshot);
                        notifyColdSnapshot(snapshot, nextActivity === 'dead' ? 'death' : 'resolve', {
                            critical: nextActivity === 'dead'
                                || materializedItems.length > 0
                                || Number(result.materialize?.adena || 0) > 0
                                || (result.events || []).length > 0
                        });
                        return snapshot;
                    })
                    .catch((err) => {
                        utils.infoWarn('BotLife', 'failed to apply resolve for %s: %s', state.name, err.message);
                        return null;
                    });
            });
        });
    },

    applyResolve(state, result) {
        return this.prepareResolve(state, result, { persist: true });
    },

    syncResolvedState(state) {
        if (!state?.characterId) return Promise.resolve(null);
        const row = rowFromState(state);
        return Database.updateCharacterExperience(row.characterId, row.level, row.exp, row.sp)
            .then(() => Database.updateCharacterVitals(row.characterId, row.hp, row.maxHp, row.mp, row.maxMp))
            .then(() => syncInventorySummary(row.characterId, state.inventory || {}))
            .then(() => state);
    },

    marketGoalCandidates(limit = 8, timestamp = now()) {
        if (!initialized) return Promise.resolve([]);
        const safeLimit = Math.max(1, Math.min(50, Number(limit) || 8));
        return Database.execute([
            `SELECT states.* FROM ${TABLE} states
            INNER JOIN bot_goal_state goals ON goals.characterId = states.characterId
            WHERE states.phase = 'cold'
            AND (states.partyId IS NULL OR states.partyId = '')
            AND states.activity NOT IN ('traveling', 'shopping', 'merchant', 'crafting', 'dead', 'pk_hunting')
            AND COALESCE(CAST(json_extract(states.statsJson, '$.marketSellRetryAfter') AS INTEGER), 0) <= ?
            AND goals.goalJson LIKE '%"type":"sell_inventory"%'
            ORDER BY states.updatedAt ASC
            LIMIT ${safeLimit}`,
            [Number(timestamp) || now()]
        ]).then((rows) => rows.map((row) => {
            const state = normalize(row);
            cache.set(state.characterId, state);
            return state;
        })).catch((err) => {
            utils.infoWarn('BotLife', 'failed to fetch market-goal candidates: %s', err.message);
            return [];
        });
    },

    refreshInventory(state, options = {}) {
        if (!state?.characterId) return Promise.resolve(state || null);
        return Database.fetchItems(state.characterId).then((items) => {
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
                ? syncInventorySummary(state.characterId, equipped).then(() => refreshed)
                : refreshed;
        }).catch((err) => {
            utils.infoWarn('BotLife', 'failed to refresh inventory for %s: %s', state.name, err.message);
            return state;
        });
    },

    leaveParty(state, reason = 'party_break') {
        if (!state?.characterId) return Promise.resolve(null);
        const releasedFromObjective = ['party_objective_complete', 'party_session_rotation'].includes(reason);
        const nextActivity = releasedFromObjective && state.activity === 'grouped'
            ? 'hunting'
            : state.activity;
        const nextState = {
            ...state,
            activity: nextActivity,
            party: { ...(state.party || {}), partyId: null, leaderId: null },
            stats: {
                ...(state.stats || {}),
                backgroundPartyId: null,
                partyBreakReason: reason,
                partyRequest: null
            },
            timing: releasedFromObjective
                ? { ...(state.timing || {}), activityStartedAt: now(), nextResolveAt: now() + 30000 }
                : state.timing,
            updatedAt: now()
        };
        const row = rowFromState(nextState);
        return save(row).then(() => {
            const snapshot = normalize(row);
            cache.set(snapshot.characterId, snapshot);
            return snapshot;
        }).catch((err) => {
            utils.infoWarn('BotLife', 'failed to remove %s from party: %s', state.name, err.message);
            return null;
        });
    },

    syncMarketSession(session, reason = 'hot_market_sync') {
        const state = session?.coldMarketState;
        const actor = session?.actor;
        if (!state || !actor?.backpack?.fetchItems) return Promise.resolve(null);
        const inventory = inventorySummaryFromItems(actor.backpack.fetchItems());
        const liveStore = actor.fetchPrivateStore?.();
        const hasLines = liveStore && (liveStore.items || []).some((item) => Number(item.count || 0) > 0);
        const persistedItems = new Map((state.stats?.marketStore?.items || []).map((item) => [Number(item.selfId), item]));
        const marketStore = hasLines ? {
            ...(state.stats?.marketStore || {}),
            storeType: Number(liveStore.storeType || state.stats?.marketStore?.storeType || 1),
            budgetBacked: liveStore.budgetBacked === true || state.stats?.marketStore?.budgetBacked === true,
            items: (liveStore.items || []).map((item) => ({
                ...(persistedItems.get(Number(item.selfId)) || {}),
                ...item
            }))
        } : null;
        const nextState = {
            ...state,
            phase: 'hot',
            activity: marketStore ? 'merchant' : 'shopping',
            adena: inventoryAdena(inventory),
            inventory,
            stats: {
                ...(state.stats || {}),
                marketStore,
                marketWanted: marketStore ? state.stats?.marketWanted || null : null,
                equipment: equipmentSummaryFromInventory(inventory)
            },
            timing: {
                ...(state.timing || {}),
                nextResolveAt: marketStore ? Number(marketStore.expiresAt || 0) || null : now()
            }
        };
        return this.upsertState(nextState, reason).then((saved) => {
            if (saved) session.coldMarketState = saved;
            return saved;
        });
    },

    applyMarketPurchase(state, offer, qty = 1) {
        const selfId = Number(offer?.selfId || 0);
        const price = Number(offer?.price || 0);
        const count = Number(qty);
        if (!Number.isSafeInteger(count) || count <= 0) return Promise.resolve(null);
        const totalPrice = price * count;
        if (!state || !selfId || price <= 0 || Number(state.adena || 0) < totalPrice) return Promise.resolve(null);

        const template = itemTemplate(selfId);
        if (!template) return Promise.resolve(null);
        const slot = Number(template.etc?.slot || 0);
        const pairSlots = [1, 2].includes(slot) ? [1, 2] : [4, 5].includes(slot) ? [4, 5] : [];
        if (slot > 0 && count > 1 && (!pairSlots.length || count > 2)) return Promise.resolve(null);
        if (marketPurchaseBlocker(state, offer, count)) return Promise.resolve(null);
        const inventory = Object.fromEntries(Object.entries(state.inventory || {}).map(([key, item]) => [key, {
            ...item,
            ...(Array.isArray(item?.equippedSlots) ? { equippedSlots: [...item.equippedSlots] } : {})
        }]));
        let purchaseSlots = [];
        if (pairSlots.length) {
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
        } else if (slot) {
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
            equipped: pairSlots.length ? purchaseSlots.length > 0 : slot > 0,
            equippedCount: pairSlots.length ? purchaseSlots.length : slot > 0 ? 1 : 0,
            equippedSlots: pairSlots.length ? purchaseSlots : slot > 0 ? [slot] : [],
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
            activity: 'shopping',
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
            .then(() => syncInventorySummary(row.characterId, nextState.inventory))
            .then(() => {
                const snapshot = normalize(row);
                cache.set(snapshot.characterId, snapshot);
                notifyColdSnapshot(snapshot, 'market_purchase', { critical: true });
                return snapshot;
            }).catch(async (err) => {
                utils.infoWarn('BotLife', 'failed market purchase for %s: %s', state.name, err.message);
                const restored = await this.restoreMarketState(state, 'market_purchase_persist_rollback');
                if (!restored) utils.infoWarn('BotLife', 'failed to compensate market purchase for %s', state.name);
                return null;
            });
    },

    restoreMarketState(state, reason = 'market_transaction_rollback') {
        if (!state?.characterId || !state.inventory) return Promise.resolve(null);
        const nextState = {
            ...state,
            stats: { ...(state.stats || {}), lastReason: reason },
            updatedAt: now()
        };
        const row = rowFromState(nextState);
        return save(row)
            .then(() => syncInventorySummary(row.characterId, nextState.inventory))
            .then(() => {
                const snapshot = normalize(row);
                cache.set(snapshot.characterId, snapshot);
                notifyColdSnapshot(snapshot, 'market_sale', { critical: true });
                return snapshot;
            }).catch((error) => {
                utils.infoWarn('BotLife', 'failed market rollback for %s: %s', state.name, error?.message || String(error));
                return null;
            });
    },

    applyMarketSale(state, offer, qty = 1) {
        const selfId = Number(offer?.selfId || 0);
        const count = Math.max(1, Number(qty) || 1);
        const price = Number(offer?.price || 0);
        const currentItem = state?.inventory?.[String(selfId)];
        if (!state || !selfId || price <= 0) return Promise.resolve(null);
        const equippedCount = Math.max(0, Number(currentItem?.equippedCount ?? (currentItem?.equipped ? 1 : 0)));
        if (currentItem && Number(currentItem.amount || 0) - equippedCount < count) return Promise.resolve(null);

        const inventory = { ...(state.inventory || {}) };
        // A hot private store can sell before an older cold snapshot has been
        // refreshed from the character inventory. The store is authoritative
        // for the transaction, otherwise sold stock returns after a restart.
        inventory[String(selfId)] = {
            ...(currentItem || {}),
            selfId,
            name: currentItem?.name || offer?.storeItem?.name || itemName(selfId),
            amount: Math.max(0, Number(currentItem?.amount || 0) - count)
        };
        inventory['57'] = {
            ...(inventory['57'] || {}),
            selfId: 57,
            name: 'Adena',
            amount: Number(state.adena || 0) + (price * count)
        };
        const marketStore = state.stats?.marketStore;
        const marketItems = (marketStore?.items || []).map((item) => {
            if (Number(item.selfId) !== selfId) return item;
            const remaining = offer?.storeItem && Number.isFinite(Number(offer.storeItem.count))
                ? Math.max(0, Number(offer.storeItem.count))
                : Math.max(0, Number(item.count || 0) - count);
            return { ...item, count: remaining };
        });
        const nextState = {
            ...state,
            adena: Number(state.adena || 0) + (price * count),
            inventory,
            stats: {
                ...(state.stats || {}),
                ...(marketStore ? { marketStore: { ...marketStore, items: marketItems } } : {}),
                lastMarketSale: {
                    selfId,
                    qty: count,
                    price,
                    buyerCharacterId: Number(offer.buyerCharacterId || 0) || null,
                    at: now()
                }
            },
            updatedAt: now()
        };
        const row = rowFromState(nextState);
        return save(row)
            .then(() => syncInventorySummary(row.characterId, inventory))
            .then(() => {
                const snapshot = normalize(row);
                cache.set(snapshot.characterId, snapshot);
                notifyColdSnapshot(snapshot, 'npc_liquidation', { critical: true });
                return snapshot;
            }).catch(async (err) => {
                utils.infoWarn('BotLife', 'failed market sale for %s: %s', state.name, err.message);
                const restored = await this.restoreMarketState(state, 'market_sale_persist_rollback');
                if (!restored) utils.infoWarn('BotLife', 'failed to compensate market sale for %s', state.name);
                return null;
            });
    },

    applyNpcLiquidation(state, candidates = [], options = {}) {
        if (!state || !Array.isArray(candidates) || !candidates.length) return Promise.resolve(state);
        const inventory = { ...(state.inventory || {}) };
        let payout = 0;
        const sold = [];
        candidates.forEach((candidate) => {
            const selfId = Number(candidate.selfId || 0);
            const existing = inventory[String(selfId)];
            const equippedCount = Math.max(0, Number(existing?.equippedCount ?? (existing?.equipped ? 1 : 0)));
            const amount = Math.min(
                Math.max(0, Number(existing?.amount || 0) - equippedCount),
                Math.max(0, Number(candidate.count || 0))
            );
            const price = Math.max(0, Number(candidate.npcPrice || 0));
            if (!selfId || amount <= 0 || price <= 0) return;
            inventory[String(selfId)] = { ...existing, amount: Number(existing.amount) - amount };
            payout += amount * price;
            sold.push({ selfId, amount, price });
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
                lastNpcLiquidation: { payout, sold, at: now(), ...options }
            },
            updatedAt: now()
        };
        const row = rowFromState(nextState);
        return save(row)
            .then(() => syncInventorySummary(row.characterId, inventory))
            .then(() => {
                const snapshot = normalize(row);
                cache.set(snapshot.characterId, snapshot);
                return snapshot;
            }).catch((err) => {
                utils.infoWarn('BotLife', 'failed NPC liquidation for %s: %s', state.name, err.message);
                return null;
            });
    },

    upsertState(state, reason = 'seed') {
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
        const row = rowFromState(nextState);
        const characterId = row.characterId;
        const previous = pendingWrites.get(characterId) || Promise.resolve();
        const ready = initialized ? Promise.resolve(true) : this.init();
        const next = previous.then(() => ready).then((isReady) => {
            if (!isReady) {
                throw new Error('state table unavailable');
            }
            return save(row);
        }).then(() => Database.updateCharacterLocation(row.characterId, {
            locX: row.locX,
            locY: row.locY,
            locZ: row.locZ
        })).then(() => Database.updateCharacterExperience(row.characterId, row.level, row.exp, row.sp))
            .then(() => Database.updateCharacterVitals(row.characterId, row.hp, row.maxHp, row.mp, row.maxMp))
            .then(() => {
                const snapshot = normalize(row);
                cache.set(characterId, snapshot);
                notifyColdSnapshot(snapshot, reason);
                return snapshot;
            })
            .catch((err) => {
                utils.infoWarn('BotLife', 'failed to upsert %s: %s', row.characterName, err.message);
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
        const summary = {
            due: 0,
            highLevel: 0,
            replans: 0,
            oldestAgeMs: 0
        };

        cache.forEach((state) => {
            if (state.phase !== 'cold'
                || (state.simulation?.ownerId && state.simulation.ownerId !== 'legacy_main')
                || state.activity === 'pk_hunting'
                || state.partyId
                || state.party?.partyId
                || (state.activity === 'merchant' && state.stats?.marketStore)
                || (state.activity === 'crafting' && state.stats?.craftShop)) {
                return;
            }

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
            summary.oldestAgeMs = Math.max(summary.oldestAgeMs, Math.max(0, timestamp - dueAt));
        });

        return summary;
    },

    targetCombatSummary() {
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

    expireStalePartyRequests(limit = 0) {
        if (!initialized) return Promise.resolve(0);
        return expireStalePartyRequests(limit);
    },

    cachedState(characterId) {
        return cache.get(Number(characterId)) || null;
    },

    acceptSimulationOwnership(characterId, result = {}, committedState = null) {
        const id = Number(characterId);
        const current = cache.get(id);
        if (!current && !committedState) return null;
        const next = {
            ...(current || {}),
            ...(committedState || {}),
            simulation: {
                ownerId: result.ownerId || 'legacy_main',
                revision: Math.max(0, Number(result.revision || 0)),
                leaseId: result.leaseId || null,
                leaseUntil: Math.max(0, Number(result.leaseUntil || 0))
            }
        };
        cache.set(id, next);
        return next;
    },

    allStates(limit = 500) {
        const safeLimit = Math.max(1, Math.min(2000, Number(limit) || 500));
        return Array.from(cache.values())
            .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
            .slice(0, safeLimit);
    },

    levelHistogram() {
        if (!initialized) {
            return Promise.resolve({ levels: [], phases: {}, total: 0 });
        }

        return Database.execute([
            `SELECT phase, level, COUNT(*) AS count
            FROM ${TABLE}
            GROUP BY phase, level
            ORDER BY level ASC`,
            []
        ]).then((rows) => {
            const levels = [];
            const phases = {};
            let total = 0;

            rows.forEach((row) => {
                const phase = row.phase || 'cold';
                const level = Number(row.level || 1);
                const count = Number(row.count || 0);

                levels.push({ phase, level, count });
                if (!phases[phase]) phases[phase] = 0;
                phases[phase] += count;
                total += count;
            });

            return { levels, phases, total };
        }).catch((err) => {
            utils.infoWarn('BotLife', 'failed to read level histogram: %s', err.message);
            return { levels: [], phases: {}, total: 0 };
        });
    }
};

BotLifeState.canonicalizeAreaState = canonicalizeAreaState;
BotLifeState.inventorySummaryFromItems = inventorySummaryFromItems;
BotLifeState.marketPurchaseBlocker = marketPurchaseBlocker;
BotLifeState.normalizeInventoryStackability = normalizeInventoryStackability;
BotLifeState.reconcileEquipmentInventory = reconcileEquipmentInventory;
BotLifeState.reconcileFulfilledEquipmentPlan = reconcileFulfilledEquipmentPlan;
BotLifeState.reconcileIncompatibleShieldState = reconcileIncompatibleShieldState;

module.exports = BotLifeState;
