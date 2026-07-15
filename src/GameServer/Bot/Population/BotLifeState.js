const Database = invoke('Database');
const Metrics  = invoke('GameServer/Bot/Population/PopulationMetrics');
const DataCache = invoke('GameServer/DataCache');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');

const TABLE = 'bot_life_state';
const GearSkillHints = invoke('GameServer/Bot/AI/GearSkillHints');
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
            lastHotAt = VALUES(lastHotAt),
            locX = VALUES(locX),
            locY = VALUES(locY),
            locZ = VALUES(locZ),
            hp = VALUES(hp),
            maxHp = VALUES(maxHp),
            mp = VALUES(mp),
            maxMp = VALUES(maxMp),
            targetLevelBand = VALUES(targetLevelBand),
            partyId = VALUES(partyId),
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
        AND activity <> 'merchant'`,
        [timestamp + 30000, timestamp]
    ]).then((result) => {
        const recovered = Number(result?.affectedRows || 0);
        if (recovered > 0) {
            utils.infoWarn('BotLife', 'recovered %d stale hot states as cold on startup', recovered);
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
        ]).then(() => ensureColumns()).then(() => recoverStaleHotStates()).then(() => hydrateCache()).then((count) => {
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

        const row = recordFromSession(session, 'hot', reason);
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
            LIMIT ${safeLimit * 3}`,
            [minX, maxX, minY, maxY]
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
            ORDER BY COALESCE(nextResolveAt, 0) ASC
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
            `SELECT * FROM ${TABLE}
            WHERE phase = 'cold'
            AND (partyId IS NULL OR partyId = '')
            AND spotId IS NOT NULL
            AND activity IN ('hunting', 'resting')
            ORDER BY spotId ASC, level ASC, updatedAt ASC
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

    clearParty(partyId) {
        if (!initialized || !partyId) return Promise.resolve(0);

        return Database.execute([
            `UPDATE ${TABLE} SET partyId = NULL, updatedAt = ? WHERE partyId = ?`,
            [now(), partyId]
        ]).then((result) => {
            let cleared = 0;
            cache.forEach((state, characterId) => {
                if (state.party?.partyId === partyId) {
                    cache.set(characterId, {
                        ...state,
                        party: {
                            ...(state.party || {}),
                            partyId: null,
                            leaderId: null
                        },
                        updatedAt: now()
                    });
                    cleared += 1;
                }
            });
            return result?.affectedRows || cleared;
        }).catch((err) => {
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

        const nextState = {
            ...state,
            level,
            exp,
            sp,
            adena,
            phase: 'cold',
            activity: result.patch?.activity || state.activity,
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
        const row = rowFromState(nextState);

        return save(row)
            .then(() => Database.updateCharacterExperience(row.characterId, row.level, row.exp, row.sp))
            .then(() => Database.updateCharacterVitals(row.characterId, row.hp, row.maxHp, row.mp, row.maxMp))
            .then(() => syncInventorySummary(row.characterId, nextState.inventory))
            .then(() => {
                const snapshot = normalize(row);
                cache.set(snapshot.characterId, snapshot);
                return snapshot;
            })
            .catch((err) => {
                utils.infoWarn('BotLife', 'failed to apply resolve for %s: %s', state.name, err.message);
                return null;
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
        if (!state || !selfId || price <= 0 || Number(currentItem?.amount || 0) < count) return Promise.resolve(null);

        const inventory = { ...(state.inventory || {}) };
        inventory[String(selfId)] = { ...currentItem, amount: Number(currentItem.amount) - count };
        inventory['57'] = {
            ...(inventory['57'] || {}),
            selfId: 57,
            name: 'Adena',
            amount: Number(state.adena || 0) + (price * count)
        };
        const nextState = {
            ...state,
            adena: Number(state.adena || 0) + (price * count),
            inventory,
            stats: {
                ...(state.stats || {}),
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
