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
const cache = new Map();
const pendingWrites = new Map();
let initialized = false;
let initStarted = false;
let initPromise = null;

function now() {
    return Date.now();
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
    return DataCache.items.find((item) => Number(item.selfId) === Number(selfId)) || null;
}

function itemName(selfId, fallback = '') {
    return itemTemplate(selfId)?.template?.name || fallback || `Item ${selfId}`;
}

function inventorySummaryFromItems(items = []) {
    return items.reduce((summary, item) => {
        const selfId = Number(item.fetchSelfId ? item.fetchSelfId() : item.selfId);
        const amount = Number(item.fetchAmount ? item.fetchAmount() : item.amount || 0);
        if (!selfId || amount <= 0) return summary;

        const key = String(selfId);
        summary[key] = {
            selfId,
            name: item.fetchName ? item.fetchName() : item.name || itemName(selfId),
            amount: Number(summary[key]?.amount || 0) + amount,
            equipped: !!(item.fetchEquipped ? item.fetchEquipped() : item.equipped),
            stackable: !!(item.fetchStackable ? item.fetchStackable() : item.stackable),
            slot: Number(item.fetchSlot ? item.fetchSlot() : item.slot || 0),
            rank: item.fetchRank ? item.fetchRank() : item.rank || itemTemplate(selfId)?.etc?.rank || 'none',
            kind: item.fetchKind ? item.fetchKind() : item.kind || itemTemplate(selfId)?.template?.kind || ''
        };
        return summary;
    }, {});
}

function equipmentSummaryFromInventory(inventory = {}) {
    return Object.values(inventory)
        .filter((item) => item.equipped)
        .map((item) => ({
            selfId: Number(item.selfId),
            name: item.name || itemName(item.selfId),
            slot: Number(item.slot || 0),
            rank: item.rank || 'none',
            kind: item.kind || ''
        }))
        .sort((a, b) => a.slot - b.slot || a.selfId - b.selfId);
}

function inventoryAdena(inventory) {
    return Number(inventory?.[57]?.amount || inventory?.['57']?.amount || 0);
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

function syncInventoryItem(characterId, existingItems, item) {
    const selfId = Number(item.selfId || 0);
    const amount = Number(item.amount || 0);
    if (!selfId || amount < 0) return Promise.resolve(null);

    const existing = existingItems.find((row) => Number(row.selfId) === selfId);
    if (existing) {
        let chain = Promise.resolve(null);
        if (Number(existing.amount || 0) !== amount) {
            chain = chain.then(() => Database.updateItemAmount(characterId, existing.id, amount));
        }
        const equipped = !!item.equipped;
        const slot = Number(item.slot || existing.slot || 0);
        if (!!existing.equipped !== equipped || Number(existing.slot || 0) !== slot) {
            chain = chain.then(() => Database.updateItemEquipState(characterId, existing.id, equipped, slot));
        }
        return chain;
    }

    if (amount === 0) return Promise.resolve(null);

    const template = itemTemplate(selfId);
    return Database.setItem(characterId, {
        selfId,
        name: item.name || itemName(selfId),
        amount,
        equipped: !!item.equipped,
        slot: Number(item.slot || template?.etc?.slot || 0)
    });
}

function syncInventorySummary(characterId, inventory) {
    const entries = Object.values(inventory || {});
    if (!entries.length) return Promise.resolve(null);

    return Database.fetchItems(characterId).then((existingItems) => (
        entries.reduce((chain, item) => (
            chain.then(() => syncInventoryItem(characterId, existingItems, item))
        ), Promise.resolve())
    ));
}

function normalize(row) {
    const stats = parseJson(row.statsJson, {});
    const inventory = parseJson(row.inventorySummary, {});

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
        clanId: actor.fetchClanId ? Number(actor.fetchClanId()) || 0 : 0,
        route: currentSpot?.route || null,
        build: GearSkillHints.forCharacter(actor, { role: session.botStatus?.role || null }),
        equipment: equipmentSummaryFromInventory(inventory),
        leaderId: session.followPlayerSession?.actor?.fetchId ? Number(session.followPlayerSession.actor.fetchId()) : null,
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
    return {
        characterId: state.characterId,
        accountName: state.accountName || '',
        characterName: state.name || '',
        level: Number(state.level || 1),
        exp: Number(state.exp || 0),
        sp: Number(state.sp || 0),
        adena: Number(state.adena || 0),
        homeRegion: state.homeRegion || null,
        currentRegion: state.currentRegion || null,
        spotId: state.spotId || null,
        activity: state.activity || 'hunting',
        phase: state.phase || 'cold',
        activityStartedAt: state.timing?.activityStartedAt || null,
        nextResolveAt: state.timing?.nextResolveAt || null,
        lastResolvedAt: state.timing?.lastResolvedAt || null,
        lastHotAt: state.timing?.lastHotAt || null,
        locX: state.loc?.locX || 0,
        locY: state.loc?.locY || 0,
        locZ: state.loc?.locZ || 0,
        hp: state.vitals?.hp || 0,
        maxHp: state.vitals?.maxHp || 0,
        mp: state.vitals?.mp || 0,
        maxMp: state.vitals?.maxMp || 0,
        targetLevelBand: state.levelBand || levelBand(state.level),
        deathCount: state.stats?.deaths || 0,
        partyId: state.party?.partyId || null,
        inventorySummary: safeJson(state.inventory || {}),
        statsJson: safeJson(state.stats || {}),
        updatedAt: now()
    };
}

function addColumn(name, definition) {
    return Database.execute([
        `ALTER TABLE ${TABLE} ADD COLUMN ${name} ${definition}`,
        []
    ]).catch((err) => {
        if (err.code === 'ER_DUP_FIELDNAME' || err.errno === 1060) return null;
        throw err;
    });
}

function ensureColumns() {
    return Promise.all([
        addColumn('level', 'INT NOT NULL DEFAULT 1 AFTER characterName'),
        addColumn('exp', 'BIGINT NOT NULL DEFAULT 0 AFTER level'),
        addColumn('sp', 'BIGINT NOT NULL DEFAULT 0 AFTER exp'),
        addColumn('adena', 'BIGINT NOT NULL DEFAULT 0 AFTER sp')
    ]);
}

function save(row) {
    return Database.execute([
        `INSERT INTO ${TABLE} (
            characterId, accountName, characterName, level, exp, sp, adena, homeRegion, currentRegion,
            spotId, activity, phase, activityStartedAt, nextResolveAt,
            lastResolvedAt, lastHotAt, locX, locY, locZ, hp, maxHp, mp, maxMp,
            targetLevelBand, deathCount, partyId, inventorySummary, statsJson, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            accountName = VALUES(accountName),
            characterName = VALUES(characterName),
            level = VALUES(level),
            exp = VALUES(exp),
            sp = VALUES(sp),
            adena = VALUES(adena),
            homeRegion = VALUES(homeRegion),
            currentRegion = VALUES(currentRegion),
            spotId = VALUES(spotId),
            activity = VALUES(activity),
            phase = VALUES(phase),
            activityStartedAt = VALUES(activityStartedAt),
            nextResolveAt = VALUES(nextResolveAt),
            lastResolvedAt = VALUES(lastResolvedAt),
            lastHotAt = VALUES(lastHotAt),
            locX = VALUES(locX),
            locY = VALUES(locY),
            locZ = VALUES(locZ),
            hp = VALUES(hp),
            maxHp = VALUES(maxHp),
            mp = VALUES(mp),
            maxMp = VALUES(maxMp),
            targetLevelBand = VALUES(targetLevelBand),
            deathCount = VALUES(deathCount),
            partyId = VALUES(partyId),
            inventorySummary = VALUES(inventorySummary),
            statsJson = VALUES(statsJson),
            updatedAt = VALUES(updatedAt)`,
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
        inventory: observedInventory
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

function recoverStaleCraftWaits() {
    const timestamp = now();
    return Database.execute([
        `UPDATE ${TABLE}
        SET activity = 'hunting',
            activityStartedAt = ?,
            nextResolveAt = ?,
            statsJson = JSON_SET(COALESCE(statsJson, '{}'), '$.lastReason', 'startup_craft_wait_recovery'),
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

const BotLifeState = {
    init() {
        if (initialized) return Promise.resolve(true);
        if (initStarted) return initPromise;
        initStarted = true;

        initPromise = Database.execute([
            `CREATE TABLE IF NOT EXISTS ${TABLE} (
                characterId INT NOT NULL,
                accountName VARCHAR(16) NOT NULL DEFAULT '',
                characterName VARCHAR(35) NOT NULL DEFAULT '',
                homeRegion VARCHAR(64) NULL,
                currentRegion VARCHAR(64) NULL,
                spotId VARCHAR(32) NULL,
                activity VARCHAR(32) NOT NULL DEFAULT 'hunting',
                phase VARCHAR(16) NOT NULL DEFAULT 'cold',
                activityStartedAt BIGINT NULL,
                nextResolveAt BIGINT NULL,
                lastResolvedAt BIGINT NULL,
                lastHotAt BIGINT NULL,
                locX INT NOT NULL DEFAULT 0,
                locY INT NOT NULL DEFAULT 0,
                locZ INT NOT NULL DEFAULT 0,
                hp INT NOT NULL DEFAULT 0,
                maxHp INT NOT NULL DEFAULT 0,
                mp INT NOT NULL DEFAULT 0,
                maxMp INT NOT NULL DEFAULT 0,
                targetLevelBand VARCHAR(16) NULL,
                deathCount INT NOT NULL DEFAULT 0,
                partyId VARCHAR(64) NULL,
                inventorySummary TEXT NULL,
                statsJson TEXT NULL,
                updatedAt BIGINT NOT NULL DEFAULT 0,
                PRIMARY KEY (characterId),
                INDEX phase_nextResolveAt (phase, nextResolveAt),
                INDEX accountName (accountName)
            )`,
            []
        ]).then(() => ensureColumns()).then(() => recoverStaleHotStates()).then(() => recoverStaleCraftWaits()).then(() => hydrateCache()).then((count) => {
            const repairs = [...cache.values()]
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
            }), Promise.resolve()).then(() => count);
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
            const nextState = {
                ...marketState,
                phase: 'cold',
                activity: 'merchant',
                loc: { ...storeLoc },
                timing: { ...(marketState.timing || {}), activityStartedAt: timestamp, nextResolveAt: timestamp + 60000 },
                stats: {
                    ...(marketState.stats || {}),
                    marketStore: {
                        ...(marketState.stats.marketStore || {}),
                        loc: { ...storeLoc },
                        items: (store?.items || []).map((item) => ({
                            selfId: Number(item.selfId), price: Number(item.price), count: Number(item.count), name: item.name || itemName(item.selfId)
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
                    nextResolveAt: now() + 60000
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

        return Database.execute([
            `SELECT * FROM ${TABLE}
            WHERE phase = 'cold'
            AND activity <> 'pk_hunting'
            AND (partyId IS NULL OR partyId = '')
            AND (nextResolveAt IS NULL OR nextResolveAt <= ?)
            -- Travel and crafting are finite state transitions. They must
            -- outrank a large resting/hunting backlog, otherwise a bot can
            -- remain on its way to a station forever after a restart.
            ORDER BY CASE
                WHEN activity IN ('traveling', 'crafting') THEN 0
                -- Startup craft recovery is a one-shot replan.  Serve it
                -- before the normal hunting backlog so a repaired station
                -- wait immediately selects its missing raw material.
                WHEN JSON_UNQUOTE(JSON_EXTRACT(statsJson, '$.lastReason')) = 'startup_craft_wait_recovery' THEN 1
                WHEN activity = 'dead' THEN 2
                ELSE 3
            END ASC,
            COALESCE(nextResolveAt, 0) ASC,
                CASE
                -- A rate-model rollout must promptly replace persisted kill estimates.
                WHEN JSON_UNQUOTE(JSON_EXTRACT(statsJson, '$.equipmentPlan.expectedKills')) IS NOT NULL
                    AND COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(statsJson, '$.equipmentPlan.rateModelVersion')) AS UNSIGNED), 0) < 2 THEN 0
                WHEN activity = 'dead' THEN 1
                WHEN activity IN ('traveling', 'shopping', 'merchant', 'crafting') THEN 2
                ELSE 3
                END ASC
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

    coldPartyCandidates(limit = 80) {
        if (!initialized) return Promise.resolve([]);
        const safeLimit = Math.max(1, Math.min(500, Number(limit) || 80));

        return Database.execute([
            `SELECT states.* FROM ${TABLE} states
            INNER JOIN (
                SELECT spotId, COUNT(*) AS candidateCount, MIN(updatedAt) AS oldestAt
                FROM ${TABLE}
                WHERE phase = 'cold'
                AND (partyId IS NULL OR partyId = '')
                AND spotId IS NOT NULL
                AND activity IN ('hunting', 'resting')
                GROUP BY spotId
            ) party_spots ON party_spots.spotId = states.spotId
            WHERE states.phase = 'cold'
            AND (states.partyId IS NULL OR states.partyId = '')
            AND states.spotId IS NOT NULL
            AND states.activity IN ('hunting', 'resting')
            ORDER BY party_spots.candidateCount DESC, party_spots.oldestAt ASC, states.level ASC, states.updatedAt ASC
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

    assignParty(state, partyId, role = 'dps', leaderId = 0) {
        if (!state || !partyId) return Promise.resolve(null);

        const nextState = {
            ...state,
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
                backgroundPartyId: partyId
            },
            updatedAt: now()
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

    applyResolve(state, result) {
        if (!state || !result) return Promise.resolve(null);

        const timestamp = now();
        const exp = Number(state.exp || 0) + Number(result.materialize?.exp || 0);
        const sp = Number(state.sp || 0) + Number(result.materialize?.sp || 0);
        const level = levelForExp(exp, Number(state.level || 1));
        const materializedItems = result.materialize?.items || [];
        const materializedAdenaItems = materializedItems
            .filter((item) => Number(item.selfId) === 57)
            .reduce((sum, item) => sum + Number(item.amount || 0), 0);
        const adena = Number(state.adena || 0) + Number(result.materialize?.adena || 0) + materializedAdenaItems;
        const stats = {
            ...(state.stats || {}),
            fightsWon: Number(state.stats?.fightsWon || 0) + Number(result.debug?.wins || 0),
            fightsResolved: Number(state.stats?.fightsResolved || 0) + Number(result.debug?.fights || 0),
            deaths: Number(result.patch?.deathCount || state.stats?.deaths || 0),
            expEarned: Number(state.stats?.expEarned || 0) + Number(result.materialize?.exp || 0),
            spEarned: Number(state.stats?.spEarned || 0) + Number(result.materialize?.sp || 0),
            adenaEarned: Number(state.stats?.adenaEarned || 0) + Number(result.materialize?.adena || 0) + materializedAdenaItems,
            route: result.debug?.route || state.stats?.route || null,
            lastResolveDebug: result.debug || null
        };
        const inventory = { ...(state.inventory || {}) };
        materializedItems.filter((item) => Number(item.selfId) !== 57).forEach((item) => {
            const key = String(item.selfId);
            inventory[key] = {
                selfId: item.selfId,
                name: item.name || inventory[key]?.name || itemName(item.selfId),
                amount: Number(inventory[key]?.amount || 0) + Number(item.amount || 0),
                kind: item.kind || inventory[key]?.kind || itemTemplate(item.selfId)?.template?.kind || '',
                rank: item.rank || inventory[key]?.rank || itemTemplate(item.selfId)?.etc?.rank || 'none'
            };
        });
        if (adena > 0) {
            inventory['57'] = {
                selfId: 57,
                name: inventory['57']?.name || 'Adena',
                amount: adena
            };
        }

        const nextActivity = result.patch?.activity || state.activity;
        const nextState = {
            ...state,
            level,
            exp,
            sp,
            adena,
            phase: 'cold',
            activity: nextActivity,
            spotId: result.patch?.spotId || state.spotId,
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
                ...(result.patch?.stats || {})
            },
            inventory,
            updatedAt: timestamp
        };
        const knownProfileLevel = Number(nextState.stats?.classProgressionLevel || 0);
        const knownProfileClassId = Number(nextState.stats?.classProgressionClassId ?? nextState.stats?.classId);
        const currentClassId = Number(nextState.stats?.classId || 0);
        const needsClassProgression = knownProfileLevel < level || knownProfileClassId !== currentClassId;
        const progression = needsClassProgression
            ? BotClassProgression.reconcile({
                characterId: nextState.characterId,
                classId: currentClassId,
                level,
                seed: nextState.name || nextState.characterId
            })
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
            const row = rowFromState(progressedState);

            return save(row)
            .then(() => Database.updateCharacterExperience(row.characterId, row.level, row.exp, row.sp))
            .then(() => Database.updateCharacterVitals(row.characterId, row.hp, row.maxHp, row.mp, row.maxMp))
            .then(() => syncInventorySummary(row.characterId, progressedState.inventory))
            .then(() => {
                const snapshot = normalize(row);
                cache.set(snapshot.characterId, snapshot);
                return snapshot;
            })
            .catch((err) => {
                utils.infoWarn('BotLife', 'failed to apply resolve for %s: %s', state.name, err.message);
                return null;
            });
        });
    },

    marketGoalCandidates(limit = 8) {
        if (!initialized) return Promise.resolve([]);
        const safeLimit = Math.max(1, Math.min(50, Number(limit) || 8));
        return Database.execute([
            `SELECT states.* FROM ${TABLE} states
            INNER JOIN bot_goal_state goals ON goals.characterId = states.characterId
            WHERE states.phase = 'cold'
            AND (states.partyId IS NULL OR states.partyId = '')
            AND states.activity NOT IN ('traveling', 'shopping', 'merchant', 'crafting', 'dead', 'pk_hunting')
            AND goals.goalJson LIKE '%"type":"sell_inventory"%'
            ORDER BY states.updatedAt ASC
            LIMIT ${safeLimit}`,
            []
        ]).then((rows) => rows.map((row) => {
            const state = normalize(row);
            cache.set(state.characterId, state);
            return state;
        })).catch((err) => {
            utils.infoWarn('BotLife', 'failed to fetch market-goal candidates: %s', err.message);
            return [];
        });
    },

    refreshInventory(state) {
        if (!state?.characterId) return Promise.resolve(state || null);
        return Database.fetchItems(state.characterId).then((items) => {
            // Cold progression owns virtual item counts between hot
            // materializations. The character inventory remains authoritative
            // for equip flags, so a stale snapshot cannot sell worn gear.
            const physicalInventory = inventorySummaryFromItems(items || []);
            const inventory = { ...(state.inventory || {}) };
            Object.entries(physicalInventory).forEach(([key, item]) => {
                const previous = inventory[key] || {};
                inventory[key] = {
                    ...previous,
                    ...item,
                    amount: Math.max(Number(previous.amount || 0), Number(item.amount || 0)),
                    equipped: !!previous.equipped || !!item.equipped,
                    slot: Number(item.slot || previous.slot || 0)
                };
            });
            return {
                ...state,
                adena: Math.max(Number(state.adena || 0), inventoryAdena(inventory)),
                inventory,
                stats: {
                    ...(state.stats || {}),
                    equipment: equipmentSummaryFromInventory(inventory)
                }
            };
        }).catch((err) => {
            utils.infoWarn('BotLife', 'failed to refresh inventory for %s: %s', state.name, err.message);
            return state;
        });
    },

    leaveParty(state, reason = 'party_break') {
        if (!state?.characterId) return Promise.resolve(null);
        const nextState = {
            ...state,
            party: { ...(state.party || {}), partyId: null, leaderId: null },
            stats: { ...(state.stats || {}), backgroundPartyId: null, partyBreakReason: reason },
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

    applyMarketPurchase(state, offer) {
        const selfId = Number(offer?.selfId || 0);
        const price = Number(offer?.price || 0);
        if (!state || !selfId || price <= 0 || Number(state.adena || 0) < price) return Promise.resolve(null);

        const template = itemTemplate(selfId);
        if (!template) return Promise.resolve(null);
        const slot = Number(template.etc?.slot || 0);
        if (!slot) return Promise.resolve(null);
        const inventory = { ...(state.inventory || {}) };
        Object.keys(inventory).forEach((key) => {
            if (Number(inventory[key]?.slot || 0) === slot) inventory[key] = { ...inventory[key], equipped: false };
        });
        inventory['57'] = { ...(inventory['57'] || {}), selfId: 57, name: 'Adena', amount: Number(state.adena) - price };
        inventory[String(selfId)] = {
            ...(inventory[String(selfId)] || {}),
            selfId,
            name: template.template?.name || offer.itemName || itemName(selfId),
            amount: Number(inventory[String(selfId)]?.amount || 0) + 1,
            equipped: true,
            slot,
            rank: template.etc?.rank || 'none',
            kind: template.template?.kind || ''
        };
        const equipment = equipmentSummaryFromInventory(inventory);
        const nextState = {
            ...state,
            adena: Number(state.adena) - price,
            activity: 'shopping',
            inventory,
            stats: {
                ...(state.stats || {}),
                equipment,
                marketRetryAfter: null,
                marketLead: null,
                lastMarketPurchase: { selfId, price, sourceType: offer.sourceType, sourceId: offer.sourceId, at: now() }
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
                utils.infoWarn('BotLife', 'failed market purchase for %s: %s', state.name, err.message);
                return null;
            });
    },

    applyMarketSale(state, offer, qty = 1) {
        const selfId = Number(offer?.selfId || 0);
        const count = Math.max(1, Number(qty) || 1);
        const price = Number(offer?.price || 0);
        const currentItem = state?.inventory?.[String(selfId)];
        if (!state || !selfId || price <= 0) return Promise.resolve(null);

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
                return snapshot;
            }).catch((err) => {
                utils.infoWarn('BotLife', 'failed market sale for %s: %s', state.name, err.message);
                return null;
            });
    },

    applyNpcLiquidation(state, candidates = []) {
        if (!state || !Array.isArray(candidates) || !candidates.length) return Promise.resolve(state);
        const inventory = { ...(state.inventory || {}) };
        let payout = 0;
        const sold = [];
        candidates.forEach((candidate) => {
            const selfId = Number(candidate.selfId || 0);
            const existing = inventory[String(selfId)];
            const amount = Math.min(Number(existing?.amount || 0), Math.max(0, Number(candidate.count || 0)));
            const price = Math.max(0, Number(candidate.npcPrice || 0));
            if (!selfId || amount <= 0 || price <= 0 || existing?.equipped) return;
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
                lastNpcLiquidation: { payout, sold, at: now() }
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

module.exports = BotLifeState;
