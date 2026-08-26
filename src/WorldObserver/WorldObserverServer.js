const http = require('http');
const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, 'public');
const ITEM_ICON_CATALOG_DIR = path.join(PUBLIC_DIR, 'item-icons');
const ITEM_ICON_MANIFEST_PATH = path.join(ITEM_ICON_CATALOG_DIR, 'index.json');
const BotBrainContext = invoke('GameServer/Bot/AI/BotBrainContext');
const BotPersona = invoke('GameServer/Bot/AI/BotPersona');
const BotServiceIdentity = invoke('GameServer/Bot/AI/BotServiceIdentity');
const ColdCombatProfile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const ClanCrestService = invoke('GameServer/Clan/ClanCrestService');
const ClanService = invoke('GameServer/Clan/ClanService');
const ClanSimulationConfig = invoke('GameServer/Clan/ClanSimulationConfig');
const Database = invoke('Database');
const PopulationConfig = invoke('GameServer/Bot/Population/PopulationConfig');
const PlayerActivitySignal = invoke('GameServer/Bot/Population/PlayerActivitySignal');
const DataCache = invoke('GameServer/DataCache');
const WorldAreaCatalog = invoke('GameServer/World/WorldAreaCatalog');
const WorldProjection = invoke('WorldObserver/WorldObserverProjection');
const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg'
};
const OBSERVER_IDLE_CACHE_MS = 2000;
const WORLD_EPOCH = `${process.pid}-${Date.now().toString(36)}`;
// The observer refreshes its map every 2s, but bot state is deliberately much
// slower-moving than the player-facing game world. Reuse the expensive
// 1776-state snapshot for 30s while a player is online instead of rebuilding
// it every 5-10s and adding avoidable main-process allocation/GC pressure.
const OBSERVER_PLAYER_CACHE_MS = 30000;
const OBSERVER_PARTY_CACHE_MS = 30000;
const snapshotCache = {
    json: null,
    etag: null,
    revision: 0,
    bytes: 0,
    generatedAt: 0,
    inFlight: null,
    builds: 0,
    hits: 0
};

const WORLD_BOUNDS = {
    minX: -131072,
    maxX: 229376,
    minY: -262144,
    maxY: 262144
};

const MAP_TILES = {
    source: 'https://github.com/npetrovski/l2-world-map',
    rawBaseUrl: 'https://raw.githubusercontent.com/npetrovski/l2-world-map/main/Maps',
    blockSize: 32768,
    blockPx: 900,
    x: { min: 16, max: 26, mid: 20 },
    y: { min: 10, max: 25, mid: 18 },
    missingTiles: [
        '17_14',
        '18_13',
        '26_13',
        '26_15',
        '26_16',
        '26_17',
        '26_18',
        '26_19'
    ],
    alternatives: [
        {
            name: 'L2J C4 common map',
            url: 'https://l2j.ru/img/maps/c4_all.jpg',
            note: 'large C4 poster map; needs manual coordinate calibration'
        },
        {
            name: 'PMfun Aden World Map C4 (big)',
            url: 'https://lineage.pmfun.com/data/maps/world/Aden%20World%20Map%20C4%20%28big%29.jpg',
            note: 'large C4 poster map; useful as a visual reference'
        }
    ]
};

const REGION_LABELS = [
    { name: 'Talking Island', locX: -84318, locY: 244579, kind: 'town' },
    { name: 'Gludin', locX: -80826, locY: 149775, kind: 'town' },
    { name: 'Gludio', locX: -12672, locY: 122776, kind: 'town' },
    { name: 'Dion', locX: 15664, locY: 142979, kind: 'town' },
    { name: 'Giran', locX: 83400, locY: 147943, kind: 'town' },
    { name: 'Oren', locX: 82960, locY: 53177, kind: 'town' },
    { name: 'Aden', locX: 146785, locY: 25813, kind: 'town' },
    { name: "Hunter's Village", locX: 117110, locY: 76883, kind: 'town' },
    { name: 'Heine', locX: 111395, locY: 219000, kind: 'town' },
    { name: 'Goddard', locX: 147725, locY: -56517, kind: 'town' },
    { name: 'Rune', locX: 43835, locY: -47749, kind: 'town' },
    { name: 'Elven Village', locX: 46934, locY: 51467, kind: 'starter' },
    { name: 'Dark Elven Village', locX: 9745, locY: 15606, kind: 'starter' },
    { name: 'Orc Village', locX: -44133, locY: -113911, kind: 'starter' },
    { name: 'Dwarven Village', locX: 115120, locY: -178212, kind: 'starter' }
];

function raidBossCatalog() {
    const templates = new Map((DataCache.npcs || [])
        .filter((npc) => npc?.template?.raidBoss === true)
        .map((npc) => [Number(npc.selfId), npc]));
    const seen = new Set();
    return (DataCache.npcSpawns || [])
        .flatMap((group) => group?.spawns || [])
        .map((spawn) => ({ spawn, npc: templates.get(Number(spawn?.selfId)) }))
        .filter(({ spawn, npc }) => {
            const id = Number(spawn?.selfId || 0);
            if (!npc || !Number.isInteger(id) || id <= 0 || seen.has(id)) return false;
            seen.add(id);
            return true;
        })
        .map(({ spawn, npc }) => ({
            id: Number(npc.selfId),
            name: npc.template.name || spawn.name || `Raid boss ${npc.selfId}`,
            level: Number(npc.template.level || 0),
            respawnMs: Math.max(0, Number(spawn.respawn || 0) * 1000),
            spawnLoc: spawn.coords?.[0]
                ? {
                    locX: Number(spawn.coords[0].locX),
                    locY: Number(spawn.coords[0].locY),
                    locZ: Number(spawn.coords[0].locZ)
                }
                : null
        }));
}

function raidBossLocation(loc) {
    if (!loc) return { name: 'Unknown location', area: null };
    const area = WorldAreaCatalog.publicArea(WorldAreaCatalog.resolve(loc));
    if (area) return { name: area.name, area };

    const nearest = REGION_LABELS
        .map((label) => ({
            label,
            distance: Math.hypot(Number(loc.locX) - label.locX, Number(loc.locY) - label.locY)
        }))
        .sort((left, right) => left.distance - right.distance)[0];
    return { name: nearest?.label?.name || 'Unknown location', area: null };
}

function liveRaidBosses(world) {
    return (world?.npc?.spawns || [])
        .filter((npc) => (
            npc?.fetchIsRaidBoss?.() === true &&
            npc?.state?.fetchDead?.() !== true &&
            npc?.isDead?.() !== true
        ));
}

function raidBossSnapshot(now = Date.now()) {
    const World = invoke('GameServer/World/World');
    const RaidBossState = invoke('GameServer/World/RaidBossState');
    const liveById = new Map(liveRaidBosses(World)
        .map((npc) => [Number(npc.fetchSelfId?.() || 0), npc])
        .filter(([id]) => id > 0));

    const bosses = raidBossCatalog().map((definition) => {
        const live = liveById.get(definition.id) || null;
        const persisted = RaidBossState.get(definition.id);
        const respawnAt = !live && Number(persisted?.respawnTime || 0) > now
            ? Number(persisted.respawnTime)
            : null;
        const loc = live ? actorLoc(live) : definition.spawnLoc;
        const location = raidBossLocation(loc);
        return {
            id: definition.id,
            name: definition.name,
            level: definition.level,
            status: live ? 'alive' : respawnAt ? 'respawning' : 'missing',
            objectId: live ? Number(live.fetchId?.() || 0) : null,
            loc,
            spawnLoc: definition.spawnLoc,
            location,
            respawnAt,
            remainingMs: respawnAt ? Math.max(0, respawnAt - now) : 0,
            respawnMs: definition.respawnMs
        };
    }).sort((left, right) => left.name.localeCompare(right.name));

    return {
        generatedAt: now,
        total: bosses.length,
        counts: {
            alive: bosses.filter((boss) => boss.status === 'alive').length,
            respawning: bosses.filter((boss) => boss.status === 'respawning').length,
            missing: bosses.filter((boss) => boss.status === 'missing').length
        },
        bosses
    };
}

function isEnabled() {
    const config = options.default.WorldObserver || {};
    return config.enabled !== false && String(config.enabled || 'true').toLowerCase() !== 'false';
}

function safePercent(value) {
    const number = Number(value || 0);
    return Math.max(0, Math.min(100, Math.round(number * 100)));
}

function actorLoc(actor) {
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
        hpPct: safePercent(actor.fetchHp() / Math.max(1, actor.fetchMaxHp())),
        mp: actor.fetchMp(),
        maxMp: actor.fetchMaxMp(),
        mpPct: safePercent(actor.fetchMp() / Math.max(1, actor.fetchMaxMp()))
    };
}

function normalizedClassId(value) {
    if (value === null || value === undefined || value === '') return null;
    const classId = Number(value);
    return Number.isInteger(classId) && classId >= 0 ? classId : null;
}

function className(value) {
    const classId = normalizedClassId(value);
    if (classId === null) return null;
    return (DataCache.classTemplates || [])
        .find((template) => Number(template.classId) === classId)
        ?.template?.class || null;
}

function classCatalog() {
    return (DataCache.classTemplates || [])
        .map((template) => ({
            classId: normalizedClassId(template.classId),
            className: template.template?.class || null
        }))
        .filter((entry) => entry.classId !== null && entry.className)
        .sort((left, right) => left.className.localeCompare(right.className, 'en', { sensitivity: 'base' }));
}

const RACE_NAMES = Object.freeze({
    0: 'Human',
    1: 'Elf',
    2: 'Dark Elf',
    3: 'Orc',
    4: 'Dwarf'
});

function normalizedRaceId(value, classId = null) {
    if (value !== null && value !== undefined && value !== '') {
        const raceId = Number(value);
        if (Number.isInteger(raceId) && RACE_NAMES[raceId]) return raceId;
    }
    const normalized = normalizedClassId(classId);
    if (normalized === null) return null;
    const raceId = Number((DataCache.classTemplates || [])
        .find((template) => Number(template.classId) === normalized)
        ?.template?.race);
    return Number.isInteger(raceId) && RACE_NAMES[raceId] ? raceId : null;
}

function raceMetadata(value, classId = null) {
    const raceId = normalizedRaceId(value, classId);
    return { raceId, raceName: raceId === null ? null : RACE_NAMES[raceId] };
}

function isPkActor(actor) {
    return Number(actor?.fetchKarma?.() || 0) > 0;
}

function realPlayerSessions() {
    const World = invoke('GameServer/World/World');
    return (World.user?.sessions || []).filter(PlayerActivitySignal.isRealPlayerSession);
}

function observerCacheTtl(now = Date.now()) {
    const World = invoke('GameServer/World/World');
    const sessions = World.user?.sessions || [];
    const activity = PlayerActivitySignal.observe({
        sessions,
        realPlayers: sessions.filter(PlayerActivitySignal.isRealPlayerSession),
        now,
        graceMs: PopulationConfig.playerProtectionGraceMs
    });
    if (activity.activeParty) return OBSERVER_PARTY_CACHE_MS;
    if (activity.protected) return OBSERVER_PLAYER_CACHE_MS;
    return OBSERVER_IDLE_CACHE_MS;
}

function compactPlayer(session) {
    const actor = session.actor;
    const classId = normalizedClassId(actor.fetchClassId?.());
    const race = raceMetadata(actor.fetchRace?.(), classId);
    const loc = actorLoc(actor);
    const area = WorldAreaCatalog.publicArea(WorldAreaCatalog.resolve(loc));
    return {
        id: actor.fetchId(),
        name: actor.fetchName(),
        level: actor.fetchLevel(),
        classId,
        className: className(classId),
        ...race,
        exp: Number(actor.fetchExp?.() || 0),
        adena: liveAdena(actor),
        equipmentValue: liveEquipmentValue(actor),
        loc,
        area,
        vitals: actorVitals(actor),
        online: !!actor.fetchIsOnline(),
        isPk: isPkActor(actor)
    };
}

function isStaticServiceSession(session) {
    return BotServiceIdentity.isStaticService(session);
}

function compactHotBot(status, pkIds = new Set(), session = null) {
    const classId = normalizedClassId(status.classId);
    const race = raceMetadata(session?.actor?.fetchRace?.(), classId);
    const area = WorldAreaCatalog.publicArea(WorldAreaCatalog.resolve(status.loc));
    return {
        id: status.id,
        name: status.name,
        phase: 'hot',
        level: status.level,
        classId,
        className: className(classId),
        ...race,
        exp: Number(session?.actor?.fetchExp?.() || 0),
        adena: liveAdena(session?.actor),
        equipmentValue: liveEquipmentValue(session?.actor),
        mode: status.mode,
        intent: status.intent,
        role: status.role,
        home: status.home,
        region: area?.name || status.region || status.home?.region || null,
        area,
        loc: status.loc,
        vitals: {
            hpPct: safePercent(status.vitals?.hpPct),
            mpPct: safePercent(status.vitals?.mpPct)
        },
        target: status.target ? {
            type: status.target.type,
            name: status.target.name || null,
            distance: status.target.distance ? Math.round(status.target.distance) : null
        } : null,
        party: status.party ? {
            leader: compactPartyLeader(status.party.leader),
            leaderId: Number(status.party.leader?.id || 0) || null,
            stance: status.party.stance,
            role: status.party.role
        } : null,
        spot: status.spot ? {
            id: status.spot.id,
            name: area?.name || status.spot.name,
            minLevel: status.spot.minLevel,
            maxLevel: status.spot.maxLevel,
            density: status.spot.density
        } : null,
        movement: status.movement,
        nearby: status.nearby,
        trade: status.trade,
        blockers: status.blockers || [],
        lastSocialEvent: status.lastSocialEvent || null,
        roleDecision: status.roleDecision || null,
        staticService: isStaticServiceSession(session),
        isPk: pkIds.has(Number(status.id))
    };
}

function compactStateBot(state, hotIds, leaderState = null) {
    if (hotIds.has(Number(state.characterId))) return null;
    const stats = state.stats || {};
    const classId = normalizedClassId(stats.classId ?? stats.classProgressionClassId);
    const race = raceMetadata(stats.race ?? state.race, classId);
    const leaderId = Number(state.party?.leaderId || stats.leaderId || 0) || null;
    const loc = state.loc || { locX: 0, locY: 0, locZ: 0 };
    const area = WorldAreaCatalog.publicArea(WorldAreaCatalog.resolve(loc));
    return {
        id: Number(state.characterId),
        name: state.name || 'Bot',
        phase: state.phase || 'cold',
        level: Number(state.level || 1),
        classId,
        className: className(classId),
        ...race,
        exp: Number(state.exp || 0),
        adena: Number(state.adena || 0),
        equipmentValue: coldEquipmentValue(state),
        mode: state.activity || 'hunting',
        intent: state.phase === 'warm' ? 'background_active' : 'background_resolve',
        role: state.party?.role || stats.role || 'dps',
        region: area?.name || state.currentRegion || state.homeRegion || null,
        area,
        home: {
            region: state.homeRegion || null,
            visitor: false
        },
        loc,
        vitals: {
            hpPct: safePercent(Number(state.vitals?.hp || 0) / Math.max(1, Number(state.vitals?.maxHp || 1))),
            mpPct: safePercent(Number(state.vitals?.mp || 0) / Math.max(1, Number(state.vitals?.maxMp || 1)))
        },
        target: null,
        party: state.party?.partyId ? {
            id: state.party.partyId,
            role: state.party.role || state.stats?.role || 'dps',
            leaderId,
            leader: coldPartyLeader(state, leaderState)
        } : null,
        spot: state.spotId ? { id: state.spotId, name: area?.name || state.spotId } : null,
        movement: { moving: false, towards: false, stuckTicks: 0 },
        nearby: null,
        trade: null,
        blockers: state.activity === 'dead' ? ['dead'] : [],
        updatedAt: state.updatedAt || 0,
        staticService: BotServiceIdentity.isStaticService(state),
        isPk: state.activity === 'pk_hunting'
    };
}

const EQUIPMENT_SLOTS = {
    1: 'earring',
    2: 'earring',
    3: 'necklace',
    4: 'ring',
    5: 'ring',
    6: 'head',
    7: 'weapon',
    8: 'shield',
    9: 'gloves',
    10: 'chest',
    11: 'legs',
    12: 'feet',
    13: 'cloak',
    14: 'two-handed weapon',
    15: 'full armor'
};
const projectionRuntime = {
    initialized: false,
    initializing: null,
    dynamicKeys: new Set(),
    unsubscribe: null
};
const PROJECTION_FIELDS = Object.freeze([
    'id', 'name', 'phase', 'mode', 'intent', 'role', 'level', 'classId', 'className',
    'raceId', 'exp', 'adena', 'equipmentValue', 'loc', 'area', 'region', 'online',
    'staticService', 'isPk', 'blockers', 'updatedAt'
]);

function equipmentSlot(slot) {
    if (typeof slot === 'string' && slot.trim() && !/^\d+$/.test(slot.trim())) return slot;
    return EQUIPMENT_SLOTS[Number(slot)] || (slot ? `slot ${slot}` : 'other');
}

let itemTemplateIndex = null;
let itemTemplateSource = null;
let itemIconCatalogCache = null;

function normalizeItemName(value) {
    return String(value || '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[’‘]/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

const CLAN_BOT_MEMBER_SQL = `(
    (
        c.username LIKE 'bot_pop_%'
        OR c.username LIKE 'bot_scale_%'
        OR life.accountName LIKE 'bot_pop_%'
        OR life.accountName LIKE 'bot_scale_%'
        OR json_extract(CASE WHEN json_valid(COALESCE(life.statsJson, '{}')) THEN life.statsJson ELSE '{}' END, '$.generatedCold') = 1
    )
    AND c.username NOT LIKE 'bot_craft_%'
    AND COALESCE(life.accountName, '') NOT LIKE 'bot_craft_%'
    AND COALESCE(json_extract(CASE WHEN json_valid(COALESCE(life.statsJson, '{}')) THEN life.statsJson ELSE '{}' END, '$.craftStationId'), '') = ''
    AND COALESCE(json_extract(CASE WHEN json_valid(COALESCE(life.statsJson, '{}')) THEN life.statsJson ELSE '{}' END, '$.craftShop'), '') = ''
)`;

function observerJson(raw, fallback = {}) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
    try {
        const value = JSON.parse(raw || '{}');
        return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
    } catch (_) {
        return fallback;
    }
}

function clanNumber(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function compactClanGoal(raw) {
    const goal = raw && raw.goal ? raw.goal : raw;
    if (!goal || typeof goal !== 'object') return null;
    const targetItemId = clanNumber(goal.target?.itemId) || null;
    const targetItemName = goal.target?.itemName || null;
    const targetIcon = targetItemId ? itemIconFor(null, targetItemId, targetItemName, null) : null;
    const target = goal.target ? {
        itemId: targetItemId,
        itemName: targetItemName,
        iconUrl: targetIcon?.url || null,
        npcId: clanNumber(goal.target.npcId || goal.plan?.sourceId) || null,
        npcName: goal.target.npcName || null
    } : null;
    if (target && clanNumber(goal.target.memberId) > 0) {
        target.memberId = clanNumber(goal.target.memberId);
        target.memberName = goal.target.memberName || null;
        target.memberLevel = clanNumber(goal.target.memberLevel) || null;
        target.slot = clanNumber(goal.target.slot) || null;
        target.grade = goal.target.grade || null;
        target.strategy = goal.target.strategy || null;
    }
    return {
        status: String(goal.status || ''),
        type: String(goal.type || ''),
        progress: clanNumber(goal.progress),
        required: clanNumber(goal.required),
        target,
        plan: goal.plan ? {
            kind: goal.plan.kind || null,
            reasonCode: goal.plan.reasonCode || null,
            label: goal.plan.label || null
        } : null,
        failureCount: clanNumber(goal.failureCount),
        updatedAt: clanNumber(goal.updatedAt || raw.updatedAt)
    };
}

function clanOverviewQuery() {
    return Database.execute([`
        WITH member_projection AS (
            SELECT c.id, c.clanId, c.level, c.isOnline,
                   CASE WHEN ${CLAN_BOT_MEMBER_SQL} THEN 1 ELSE 0 END AS isBot,
                   CASE WHEN c.isOnline = 1 OR life.phase = 'hot' THEN 1 ELSE 0 END AS isOnlineNow,
                   CASE WHEN life.phase = 'hot' THEN 1 ELSE 0 END AS isHot
            FROM characters c
            LEFT JOIN bot_life_state life ON life.characterId = c.id
            WHERE c.clanId != 0
        )
        SELECT clans.id, clans.name, clans.level, clans.leaderId,
               clans.crestId, clans.allyCrestId,
               leader.name AS leaderName,
               simulated.version AS simulationVersion,
               simulated.mode AS simulationMode,
               simulated.createdAt AS simulationCreatedAt,
               simulated.updatedAt AS simulationUpdatedAt,
               simulated.stateJson,
               COUNT(member_projection.id) AS memberCount,
               COALESCE(SUM(member_projection.isBot), 0) AS botMembers,
               COALESCE(SUM(CASE WHEN member_projection.isBot = 0 THEN 1 ELSE 0 END), 0) AS playerMembers,
               COALESCE(SUM(member_projection.isOnlineNow), 0) AS onlineMembers,
               COALESCE(SUM(CASE WHEN member_projection.isBot = 1 THEN member_projection.isOnlineNow ELSE 0 END), 0) AS botOnlineMembers,
               COALESCE(SUM(member_projection.isHot), 0) AS hotMembers,
               COALESCE(AVG(member_projection.level), 0) AS averageLevel,
               COALESCE(MAX(member_projection.level), 0) AS highestLevel,
               COALESCE(MIN(member_projection.level), 0) AS lowestLevel
        FROM clans
        LEFT JOIN characters leader ON leader.id = clans.leaderId
        LEFT JOIN member_projection ON member_projection.clanId = clans.id
        LEFT JOIN clan_simulation_clans simulated ON simulated.clanId = clans.id
        GROUP BY clans.id
        ORDER BY clans.level DESC, memberCount DESC, clans.name COLLATE NOCASE ASC
    `, [], { read: true }], 'observer:clans');
}

function clanAuxiliaryRows() {
    const bloodMarkId = Number(ClanSimulationConfig.bloodMarkItemId || 1419);
    return Promise.all([
        Database.execute([`
            SELECT clanId,
                   COALESCE(SUM(CASE WHEN selfId = 57 THEN amount ELSE 0 END), 0) AS adena,
                   COALESCE(SUM(CASE WHEN selfId = ? THEN amount ELSE 0 END), 0) AS bloodMarks,
                   COUNT(*) AS itemStacks
            FROM clan_warehouse_items
            WHERE amount > 0
            GROUP BY clanId
        `, [bloodMarkId]], 'observer:clan-warehouse'),
        Database.execute([`
            SELECT clanId, targetLevel, COUNT(*) AS entries, COALESCE(SUM(amount), 0) AS amount
            FROM clan_contributions
            GROUP BY clanId, targetLevel
            ORDER BY clanId ASC, targetLevel ASC
        `, []], 'observer:clan-contributions'),
        Database.execute([`
            SELECT clanId, COUNT(*) AS openDemands,
                   COALESCE(SUM(amount), 0) AS requestedUnits,
                   MAX(updatedAt) AS latestDemandAt
            FROM clan_market_demands
            WHERE status = 'open'
            GROUP BY clanId
        `, []], 'observer:clan-demands'),
        Database.execute([`
            SELECT clanId, COUNT(*) AS activeOperations,
                   MAX(createdAt) AS latestOperationAt
            FROM clan_operations
            WHERE status = 'active'
            GROUP BY clanId
        `, []], 'observer:clan-operations'),
        Database.execute([`
            SELECT clanId,
                   COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
                   COALESCE(SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END), 0) AS running,
                   MAX(updatedAt) AS latestActionAt
            FROM clan_actions
            WHERE status IN ('pending', 'running')
            GROUP BY clanId
        `, []], 'observer:clan-actions')
    ]).then(([warehouse, contributions, demands, operations, actions]) => ({ warehouse, contributions, demands, operations, actions }));
}

function compactClanOverview(row, auxiliary = {}) {
    const state = observerJson(row.stateJson);
    const warehouse = auxiliary.warehouse || {};
    const demand = auxiliary.demand || {};
    const operation = auxiliary.operation || {};
    const actions = auxiliary.actions || {};
    const memberCount = clanNumber(row.memberCount);
    const botMembers = clanNumber(row.botMembers);
    const id = clanNumber(row.id);
    const level = clanNumber(row.level);
    const crestId = clanNumber(row.crestId);
    const automationMode = row.simulationVersion
        ? String(row.simulationMode || 'autonomous')
        : null;
    return {
        id,
        name: String(row.name || ''),
        level,
        crestId,
        crestUrl: level >= 3 && id > 0 && crestId > 0 ? `/observer/api/clan/${id}/crest?v=${crestId}` : null,
        allyCrestId: clanNumber(row.allyCrestId),
        leaderId: clanNumber(row.leaderId) || null,
        leaderName: row.leaderName || null,
        automated: automationMode !== null,
        automationMode,
        autonomous: automationMode === 'autonomous',
        playerManaged: automationMode === 'player_managed',
        createdAt: clanNumber(row.simulationCreatedAt),
        updatedAt: clanNumber(row.simulationUpdatedAt || state.updatedAt),
        memberCount,
        botMembers,
        playerMembers: clanNumber(row.playerMembers),
        onlineMembers: clanNumber(row.onlineMembers),
        botOnlineMembers: clanNumber(row.botOnlineMembers),
        hotMembers: clanNumber(row.hotMembers),
        averageLevel: Math.round(clanNumber(row.averageLevel) * 10) / 10,
        highestLevel: clanNumber(row.highestLevel),
        lowestLevel: clanNumber(row.lowestLevel),
        warehouse: {
            adena: clanNumber(warehouse.adena),
            bloodMarks: clanNumber(warehouse.bloodMarks),
            itemStacks: clanNumber(warehouse.itemStacks)
        },
        contributions: auxiliary.contributions || [],
        market: {
            openDemands: clanNumber(demand.openDemands),
            requestedUnits: clanNumber(demand.requestedUnits),
            latestDemandAt: clanNumber(demand.latestDemandAt)
        },
        actions: {
            pending: clanNumber(actions.pending),
            running: clanNumber(actions.running),
            latestActionAt: clanNumber(actions.latestActionAt)
        },
        operations: {
            active: clanNumber(operation.activeOperations),
            latestAt: clanNumber(operation.latestOperationAt)
        },
        goal: compactClanGoal(state.goal)
    };
}

async function clanSnapshot() {
    const [rows, auxiliary] = await Promise.all([clanOverviewQuery(), clanAuxiliaryRows()]);
    const warehouseByClan = new Map(auxiliary.warehouse.map((row) => [Number(row.clanId), row]));
    const contributionsByClan = new Map();
    auxiliary.contributions.forEach((row) => {
        const clanId = Number(row.clanId);
        if (!contributionsByClan.has(clanId)) contributionsByClan.set(clanId, []);
        contributionsByClan.get(clanId).push({
            targetLevel: clanNumber(row.targetLevel),
            entries: clanNumber(row.entries),
            amount: clanNumber(row.amount)
        });
    });
    const demandsByClan = new Map(auxiliary.demands.map((row) => [Number(row.clanId), row]));
    const operationsByClan = new Map(auxiliary.operations.map((row) => [Number(row.clanId), row]));
    const actionsByClan = new Map(auxiliary.actions.map((row) => [Number(row.clanId), row]));
    const clans = rows.map((row) => compactClanOverview(row, {
        warehouse: warehouseByClan.get(Number(row.id)),
        contributions: contributionsByClan.get(Number(row.id)) || [],
        demand: demandsByClan.get(Number(row.id)),
        operation: operationsByClan.get(Number(row.id)),
        actions: actionsByClan.get(Number(row.id))
    }));
    const totals = clans.reduce((summary, clan) => {
        summary.members += clan.memberCount;
        summary.bots += clan.botMembers;
        summary.players += clan.playerMembers;
        summary.online += clan.onlineMembers;
        summary.autonomous += clan.autonomous ? 1 : 0;
        summary.playerManaged += clan.playerManaged ? 1 : 0;
        summary.levels[clan.level] = (summary.levels[clan.level] || 0) + 1;
        return summary;
    }, { members: 0, bots: 0, players: 0, online: 0, autonomous: 0, playerManaged: 0, levels: {} });
    return { generatedAt: Date.now(), total: clans.length, totals, clans };
}

function clanMemberQuery(clanId) {
    return Database.execute([`
        SELECT c.id, c.name, c.classId, c.race, c.level, c.exp, c.sp, c.clanId,
               c.isOnline, c.locX, c.locY, c.locZ, c.karma, c.pvp, c.pk,
               life.accountName, life.level AS lifeLevel, life.adena AS lifeAdena,
               life.activity, life.phase, life.homeRegion, life.currentRegion, life.spotId,
               life.partyId, life.locX AS lifeLocX, life.locY AS lifeLocY, life.locZ AS lifeLocZ,
               life.updatedAt AS lifeUpdatedAt, life.inventorySummary, life.statsJson,
               CASE WHEN ${CLAN_BOT_MEMBER_SQL} THEN 1 ELSE 0 END AS isBot
        FROM characters c
        LEFT JOIN bot_life_state life ON life.characterId = c.id
        WHERE c.clanId = ?
        ORDER BY c.level DESC, c.name COLLATE NOCASE ASC
    `, [Number(clanId)]], 'observer:clan-members');
}

function hotBotStatuses() {
    const BotManager = invoke('GameServer/Bot/BotManager');
    return new Map(BotManager.getAllBotStatuses()
        .filter((status) => status && status.available)
        .map((status) => [Number(status.id), {
            status,
            session: BotManager.findSessionById(Number(status.id))
        }]));
}

function compactClanMember(row, hotEntry = null, leaderId = 0) {
    const id = clanNumber(row.id);
    const stats = observerJson(row.statsJson);
    const isBot = Number(row.isBot) === 1;
    const hot = hotEntry?.status ? compactHotBot(hotEntry.status, new Set(), hotEntry.session) : null;
    const classId = hot?.classId ?? normalizedClassId(row.classId);
    const race = hot ? { raceId: hot.raceId, raceName: hot.raceName } : raceMetadata(row.race, classId);
    const loc = hot?.loc || {
        locX: clanNumber(row.lifeLocX || row.locX),
        locY: clanNumber(row.lifeLocY || row.locY),
        locZ: clanNumber(row.lifeLocZ || row.locZ)
    };
    const area = hot?.area || WorldAreaCatalog.publicArea(WorldAreaCatalog.resolve(loc));
    const inventory = observerJson(row.inventorySummary);
    const equipment = coldEquipmentValue({ inventory, stats });
    const online = !!hot || Number(row.isOnline) === 1 || String(row.phase || '') === 'hot';
    return {
        id,
        name: hot?.name || String(row.name || ''),
        kind: isBot ? 'bot' : 'player',
        isBot,
        isLeader: id === Number(leaderId),
        online,
        phase: hot ? 'hot' : isBot ? String(row.phase || 'cold') : online ? 'player' : 'offline',
        level: clanNumber(hot?.level || row.level || row.lifeLevel, 1),
        classId,
        className: hot?.className || className(classId),
        ...race,
        role: hot?.role || stats.role || 'member',
        activity: hot?.intent || String(row.activity || (online ? 'online' : 'offline')),
        mode: hot?.mode || null,
        region: hot?.region || area?.name || row.currentRegion || row.homeRegion || null,
        area,
        loc,
        partyId: hot?.party?.id || row.partyId || null,
        adena: hot ? hot.adena : Math.max(0, clanNumber(row.lifeAdena)),
        equipmentValue: hot ? hot.equipmentValue : equipment,
        exp: clanNumber(hot?.exp || row.exp),
        sp: clanNumber(row.sp),
        pvp: clanNumber(row.pvp),
        pk: clanNumber(row.pk),
        karma: clanNumber(row.karma),
        updatedAt: clanNumber(hot ? Date.now() : row.lifeUpdatedAt)
    };
}

function compactClanEvent(row) {
    const payload = observerJson(row.payloadJson);
    return {
        id: clanNumber(row.id),
        eventType: row.eventType || null,
        goalType: row.goalType || null,
        plan: row.plan || null,
        reasonCode: row.reasonCode || null,
        occurredAt: clanNumber(row.occurredAt),
        payload: compactClanGoal(payload)
    };
}

async function clanDetail(clanId) {
    const id = Number(clanId);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    const [directory, members, events, warehouse, contributions, demands, operation, actions] = await Promise.all([
        clanSnapshot(),
        clanMemberQuery(id),
        Database.fetchClanGoalEvents(id, 24),
        Database.fetchClanWarehouseItems(id),
        Database.fetchClanContributionSummary(id),
        Database.fetchClanMarketDemands({ clanId: id, status: null, limit: 40 }),
        Database.execute([`
            SELECT operations.*, COALESCE(member_counts.memberCount, 0) AS memberCount
            FROM clan_operations operations
            LEFT JOIN (
                SELECT operationId, COUNT(*) AS memberCount
                FROM clan_operation_members
                GROUP BY operationId
            ) member_counts ON member_counts.operationId = operations.id
            WHERE operations.clanId = ?
            ORDER BY operations.createdAt DESC, operations.id DESC
            LIMIT 1
        `, [id]], 'observer:clan-operation')
        , Database.fetchClanActions({ clanId: id, limit: 24 })
    ]);
    const overview = directory.clans.find((clan) => clan.id === id);
    if (!overview) return null;
    const row = await Database.execute([`
        SELECT clans.leaderId, simulated.stateJson
        FROM clans
        LEFT JOIN clan_simulation_clans simulated ON simulated.clanId = clans.id
        WHERE clans.id = ?
    `, [id]], 'observer:clan-detail');
    const leaderId = clanNumber(row[0]?.leaderId || overview.leaderId);
    const hot = hotBotStatuses();
    const memberViews = members.map((member) => compactClanMember(member, hot.get(Number(member.id)), leaderId));
    const operationRow = operation[0] || null;
    const operationMembers = operationRow
        ? await Database.execute([`
            SELECT members.characterId, characters.name, members.status
            FROM clan_operation_members members
            LEFT JOIN characters ON characters.id = members.characterId
            WHERE members.operationId = ?
            ORDER BY members.characterId ASC
        `, [Number(operationRow.id)]], 'observer:clan-operation-members')
        : [];
    return {
        generatedAt: Date.now(),
        clan: overview,
        members: memberViews,
        bots: memberViews.filter((member) => member.isBot),
        warehouse: warehouse.map((item) => ({
            id: clanNumber(item.id),
            selfId: clanNumber(item.selfId),
            name: item.name || `Item ${item.selfId}`,
            kind: item.kind || null,
            amount: clanNumber(item.amount),
            enchant: clanNumber(item.enchant),
            reservedAmount: clanNumber(item.reservedAmount)
        })),
        contributions: contributions.map((entry) => ({
            targetLevel: clanNumber(entry.targetLevel),
            entries: clanNumber(entry.entries),
            amount: clanNumber(entry.amount)
        })),
        demands: demands.map((demand) => ({
            id: clanNumber(demand.id),
            itemId: clanNumber(demand.itemId),
            amount: clanNumber(demand.amount),
            maxPrice: clanNumber(demand.maxPrice),
            goalKey: demand.goalKey || null,
            status: demand.status || null,
            createdAt: clanNumber(demand.createdAt),
            updatedAt: clanNumber(demand.updatedAt)
        })),
        actions: actions.map((action) => ({
            id: clanNumber(action.id),
            key: action.actionKey || null,
            type: action.actionType || null,
            priority: clanNumber(action.priority),
            status: action.status || null,
            attempt: clanNumber(action.attempt),
            availableAt: clanNumber(action.availableAt),
            updatedAt: clanNumber(action.updatedAt),
            resolvedAt: clanNumber(action.resolvedAt),
            reasonCode: action.reasonCode || null,
            result: observerJson(action.resultJson)
        })),
        operation: operationRow ? {
            id: clanNumber(operationRow.id),
            type: operationRow.operationType || null,
            status: operationRow.status || null,
            targetNpcId: clanNumber(operationRow.targetNpcId) || null,
            startedAt: clanNumber(operationRow.createdAt),
            completedAt: clanNumber(operationRow.resolvedAt),
            memberCount: clanNumber(operationRow.memberCount),
            members: operationMembers.map((member) => ({
                characterId: clanNumber(member.characterId),
                name: member.name || null,
                role: memberViews.find((view) => view.id === Number(member.characterId))?.role || null,
                status: member.status || null
            }))
        } : null,
        events: events.map(compactClanEvent)
    };
}

async function clanCrest(clanId) {
    const id = Number(clanId);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    const rows = await Database.execute([`
        SELECT clans.id AS clanId, clans.level, clans.crestId,
               crests.id, crests.kind, crests.data
        FROM clans
        JOIN clan_crests crests
          ON crests.id = clans.crestId
         AND crests.clanId = clans.id
         AND crests.kind = 'pledge'
        WHERE clans.id = ? AND clans.level >= 3
        LIMIT 1
    `, [id], { read: true }], 'observer:clan-crest');
    const row = rows[0];
    if (!row || Number(row.crestId || 0) <= 0 || !row.data) return null;
    const data = browserClanCrestData(row.data);
    return {
        clanId: clanNumber(row.clanId),
        id: clanNumber(row.id),
        kind: row.kind || 'pledge',
        data
    };
}

function dxt1Color(value) {
    const red = (value >> 11) & 0x1f;
    const green = (value >> 5) & 0x3f;
    const blue = value & 0x1f;
    return {
        r: (red << 3) | (red >> 2),
        g: (green << 2) | (green >> 4),
        b: (blue << 3) | (blue >> 2)
    };
}

function decodeDxt1Dds(source) {
    if (source.length < 136 || source.toString('ascii', 0, 4) !== 'DDS ' || source.toString('ascii', 84, 88) !== 'DXT1') return null;
    const width = source.readUInt32LE(16);
    const height = source.readUInt32LE(12);
    const blocksWide = Math.ceil(width / 4);
    const blocksHigh = Math.ceil(height / 4);
    if (width <= 0 || height <= 0 || width > 128 || height > 128 || source.length < 128 + (blocksWide * blocksHigh * 8)) return null;
    const pixels = Array.from({ length: width * height }, () => ({ r: 0, g: 0, b: 0, a: 0 }));
    let offset = 128;
    for (let blockY = 0; blockY < blocksHigh; blockY += 1) {
        for (let blockX = 0; blockX < blocksWide; blockX += 1) {
            const firstValue = source.readUInt16LE(offset);
            const secondValue = source.readUInt16LE(offset + 2);
            const first = { ...dxt1Color(firstValue), a: 255 };
            const second = { ...dxt1Color(secondValue), a: 255 };
            const palette = [first, second];
            if (firstValue > secondValue) {
                palette.push(
                    { r: Math.round(((2 * first.r) + second.r) / 3), g: Math.round(((2 * first.g) + second.g) / 3), b: Math.round(((2 * first.b) + second.b) / 3), a: 255 },
                    { r: Math.round((first.r + (2 * second.r)) / 3), g: Math.round((first.g + (2 * second.g)) / 3), b: Math.round((first.b + (2 * second.b)) / 3), a: 255 }
                );
            } else {
                palette.push(
                    { r: Math.round((first.r + second.r) / 2), g: Math.round((first.g + second.g) / 2), b: Math.round((first.b + second.b) / 2), a: 255 },
                    { r: 0, g: 0, b: 0, a: 0 }
                );
            }
            const indices = source.readUInt32LE(offset + 4);
            for (let pixel = 0; pixel < 16; pixel += 1) {
                const x = (blockX * 4) + (pixel % 4);
                const y = (blockY * 4) + Math.floor(pixel / 4);
                if (x < width && y < height) pixels[(y * width) + x] = palette[(indices >>> (pixel * 2)) & 0x03];
            }
            offset += 8;
        }
    }
    return { width, height, pixels };
}

function bmp24(pixels, width, height, sourceY = 0) {
    const rowStride = Math.ceil((width * 3) / 4) * 4;
    const pixelBytes = rowStride * height;
    const result = Buffer.alloc(54 + pixelBytes);
    result.write('BM', 0, 'ascii');
    result.writeUInt32LE(result.length, 2);
    result.writeUInt32LE(54, 10);
    result.writeUInt32LE(40, 14);
    result.writeInt32LE(width, 18);
    result.writeInt32LE(-height, 22);
    result.writeUInt16LE(1, 26);
    result.writeUInt16LE(24, 28);
    result.writeUInt32LE(pixelBytes, 34);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const color = pixels[((sourceY + y) * width) + x];
            const target = 54 + (y * rowStride) + (x * 3);
            result[target] = color.a ? color.b : 0;
            result[target + 1] = color.a ? color.g : 0;
            result[target + 2] = color.a ? color.r : 0;
        }
    }
    return result;
}

function crestRowScore(decoded, startY, height) {
    let score = 0;
    for (let y = startY; y < startY + height; y += 1) {
        for (let x = 0; x < decoded.width; x += 1) {
            const color = decoded.pixels[(y * decoded.width) + x];
            if (color.a) score += Math.max(color.r, color.g, color.b);
        }
    }
    return score;
}

function browserClanCrestData(data) {
    const source = Buffer.from(data || []);
    if (source.toString('ascii', 0, 2) === 'BM') return source;
    const decoded = decodeDxt1Dds(source);
    if (!decoded) return source;
    const displayHeight = decoded.width === 16 && decoded.height === 16 ? 12 : decoded.height;
    const bottomOffset = decoded.height - displayHeight;
    const sourceY = bottomOffset > 0 && crestRowScore(decoded, bottomOffset, displayHeight) > crestRowScore(decoded, 0, displayHeight)
        ? bottomOffset
        : 0;
    return bmp24(decoded.pixels, decoded.width, displayHeight, sourceY);
}

function itemIconCategory(kind) {
    const normalized = String(kind || '').toLowerCase();
    if (normalized.startsWith('weapon.')) return 'weapon';
    if (normalized === 'armor.shield') return 'shield';
    if (normalized === 'armor.jewel') return 'jewelry';
    if (normalized.startsWith('armor.')) return 'armor';
    return null;
}

function loadItemIconCatalog() {
    if (itemIconCatalogCache) return itemIconCatalogCache;

    try {
        const manifest = JSON.parse(fs.readFileSync(ITEM_ICON_MANIFEST_PATH, 'utf8'));
        const entries = Object.values(manifest.items || {})
            .filter((entry) => entry && entry.localFile);
        const bySelfId = new Map();
        const byNameAndCategory = new Map();
        const byFile = new Map();

        entries.forEach((entry) => {
            const selfId = Number(entry.selfId || 0);
            const fileName = path.basename(String(entry.localFile));
            if (selfId > 0) bySelfId.set(selfId, entry);
            byFile.set(fileName, entry);

            const normalizedName = normalizeItemName(entry.normalizedName || entry.name);
            const category = entry.category || null;
            if (normalizedName) {
                const key = `${category || 'any'}|${normalizedName}`;
                const bucket = byNameAndCategory.get(key) || [];
                bucket.push(entry);
                byNameAndCategory.set(key, bucket);
            }
        });

        itemIconCatalogCache = {
            available: true,
            itemCount: entries.length,
            bySelfId,
            byNameAndCategory,
            byFile
        };
    } catch (error) {
        itemIconCatalogCache = {
            available: false,
            itemCount: 0,
            bySelfId: new Map(),
            byNameAndCategory: new Map(),
            byFile: new Map(),
            error: error.message
        };
    }

    return itemIconCatalogCache;
}

function itemIconFor(item, selfId, name, kind) {
    const catalog = loadItemIconCatalog();
    if (!catalog.available) return null;

    const normalizedName = normalizeItemName(name);
    const category = itemIconCategory(kind);
    const exact = catalog.bySelfId.get(Number(selfId));
    const exactNameMatches = exact && (!normalizedName || normalizeItemName(exact.normalizedName || exact.name) === normalizedName);
    let entry = exactNameMatches ? exact : null;
    let match = entry ? 'selfId' : null;

    if (!entry && normalizedName) {
        const candidates = [
            ...(category ? catalog.byNameAndCategory.get(`${category}|${normalizedName}`) || [] : []),
            ...catalog.byNameAndCategory.get(`any|${normalizedName}`) || []
        ];
        entry = candidates[0] || null;
        match = entry ? 'name' : null;
    }

    if (!entry?.localFile) return null;
    const fileName = path.basename(String(entry.localFile));
    return {
        url: `/observer/item-icons/${encodeURIComponent(fileName)}`,
        fileName,
        source: entry.localSource || 'l2hub',
        detailUrl: entry.detailUrl || null,
        match
    };
}

function itemIconFilePath(fileName) {
    const catalog = loadItemIconCatalog();
    const safeName = String(fileName || '');
    if (!catalog.available || !safeName || safeName !== path.basename(safeName)) return null;
    const entry = catalog.byFile.get(safeName);
    if (!entry?.localFile) return null;

    const catalogRoot = path.resolve(ITEM_ICON_CATALOG_DIR);
    const filePath = path.resolve(catalogRoot, String(entry.localFile));
    if (!filePath.startsWith(`${catalogRoot}${path.sep}`)) return null;
    return filePath;
}

function itemTemplate(selfId) {
    const items = DataCache.items || [];
    if (!itemTemplateIndex || itemTemplateSource !== items) {
        itemTemplateSource = items;
        itemTemplateIndex = new Map(items.map((item) => [Number(item.selfId), item]));
    }
    return itemTemplateIndex.get(Number(selfId)) || null;
}

function itemSelfId(item) {
    return Number(item?.fetchSelfId?.() ?? item?.selfId ?? 0) || null;
}

function itemBaseValue(item) {
    const selfId = itemSelfId(item);
    const template = itemTemplate(selfId);
    return Math.max(0, Number(template?.template?.price ?? item?.fetchPrice?.() ?? item?.price ?? 0));
}

function equipmentValue(items = []) {
    return Math.round(items.reduce((total, item) => total + itemBaseValue(item), 0));
}

function liveEquippedItems(actor) {
    return (actor?.backpack?.fetchItems?.() || [])
        .filter((item) => item?.fetchEquipped?.());
}

function liveAdena(actor) {
    return Math.max(0, Number(actor?.backpack?.fetchItemFromSelfId?.(57)?.fetchAmount?.() || 0));
}

function liveEquipmentValue(actor) {
    return equipmentValue(liveEquippedItems(actor));
}

function coldEquippedItems(state) {
    const items = Array.isArray(state?.stats?.equipment) ? state.stats.equipment : [];
    if (items.length > 0) return items;
    return Object.values(state?.inventory || {}).filter((item) => item?.equipped);
}

function coldEquipmentValue(state) {
    return equipmentValue(coldEquippedItems(state));
}

function equipmentRank(value) {
    const rank = String(value || 'none').trim().toLowerCase().replaceAll('_', '-');
    return ['none', 'no-grade', 'nograde', '0'].includes(rank) ? 'no-grade' : rank;
}

function compactItem(item) {
    if (!item) return null;
    const template = itemTemplate(item.selfId || item.objectId);
    const selfId = Number(item.selfId || item.objectId || 0) || null;
    const name = item.name || template?.template?.name || 'Unknown item';
    const kind = item.kind || template?.template?.kind || '';
    const rawSlot = item.slotId ?? item.slot?.id ?? item.slot?.value ?? item.slot ?? template?.etc?.slot;
    const slotId = Number(rawSlot) || null;
    const stats = item.stats || template?.stats || null;
    const icon = itemIconFor(item, selfId, name, kind);
    return {
        selfId,
        name,
        slotId,
        slot: item.slot?.name || equipmentSlot(slotId || rawSlot),
        rank: equipmentRank(item.rank || template?.etc?.rank),
        kind,
        enchant: Number(item.enchant ?? item.enchantLevel ?? 0) || 0,
        price: Math.max(0, Number(item.price ?? template?.template?.price ?? 0) || 0),
        iconUrl: icon?.url || null,
        iconSource: icon?.source || null,
        iconMatch: icon?.match || null,
        stats: stats ? {
            pAtk: Number(stats.pAtk || 0),
            pAtkRnd: Number(stats.pAtkRnd || 0),
            mAtk: Number(stats.mAtk || 0),
            atkSpd: Number(stats.atkSpd || 0),
            pDef: Number(stats.pDef || 0),
            mDef: Number(stats.mDef || 0),
            evasion: Number(stats.evasion || 0),
            critical: Number(stats.critical || stats.crit || 0),
            accuracy: Number(stats.accuracy || stats.accur || 0),
            shieldRate: Number(stats.shieldRate || 0),
            bonusMp: Number(stats.bonusMp || stats.maxMp || 0),
            consumedMp: Number(stats.consumedMp || stats.mp || 0)
        } : null
    };
}

function liveItem(item) {
    if (!item) return null;
    return compactItem({
        selfId: item.fetchSelfId?.(),
        name: item.fetchName?.(),
        slot: item.fetchSlot?.(),
        rank: item.fetchRank?.(),
        kind: item.fetchKind?.(),
        enchant: item.fetchEnchantLevel?.(),
        price: item.fetchPrice?.(),
        stats: item.isWeapon?.() ? {
            pAtk: item.fetchPAtk?.(),
            pAtkRnd: item.fetchPAtkRnd?.(),
            mAtk: item.fetchMAtk?.(),
            atkSpd: item.fetchAtkSpd?.(),
            critical: item.fetchCritical?.(),
            accuracy: item.fetchAccur?.()
        } : item.isArmor?.() ? {
            pDef: item.fetchPDef?.(),
            mDef: item.fetchMDef?.(),
            evasion: item.fetchEvasion?.(),
            shieldRate: item.fetchShieldRate?.(),
            bonusMp: item.fetchBonusMp?.()
        } : null
    });
}

function liveEquipment(actor) {
    const backpack = actor?.backpack;
    if (!backpack) return null;
    const equipped = liveEquippedItems(actor).map(liveItem).filter(Boolean);
    return {
        weapon: liveItem(backpack.fetchEquippedWeapon?.()),
        equipped,
        totals: {
            pAtk: Number(backpack.fetchTotalWeaponPAtk?.() ?? actor.fetchPAtk?.() ?? 0),
            mAtk: Number(backpack.fetchTotalWeaponMAtk?.() ?? actor.fetchMAtk?.() ?? 0),
            pDef: Number(backpack.fetchTotalArmorPDef?.(actor.isSpellcaster?.()) ?? actor.fetchPDef?.() ?? 0),
            mDef: Number(backpack.fetchTotalArmorMDef?.() ?? actor.fetchMDef?.() ?? 0),
            load: Number(backpack.fetchTotalLoad?.() ?? 0)
        }
    };
}

function compactEquipment(equipment) {
    if (!equipment) return null;
    const equipped = Array.isArray(equipment.equipped)
        ? equipment.equipped.map(compactItem).filter(Boolean)
        : [];
    const weapon = compactItem(equipment.weapon) || equipped.find((item) => item.kind.startsWith('Weapon.')) || null;
    const totals = equipment.totals || null;
    return {
        weapon,
        equipped,
        totals: {
            pAtk: totals ? Number(totals.pAtk || 0) : null,
            mAtk: totals ? Number(totals.mAtk || 0) : null,
            pDef: totals ? Number(totals.pDef || 0) : null,
            mDef: totals ? Number(totals.mDef || 0) : null,
            load: totals ? Number(totals.load || 0) : null
        }
    };
}

function compactBuild(build) {
    if (!build) return null;
    const classId = normalizedClassId(build.classId);
    return {
        role: build.role || null,
        classId,
        className: className(classId),
        classFamily: build.classFamily || null,
        grade: build.grade || null,
        tier: build.tier || null,
        armor: build.armor || null,
        weapon: build.weapon || null,
        playstyle: build.playstyle || null,
        partyNeed: build.partyNeed || null,
        statPriority: Array.isArray(build.statPriority) ? build.statPriority.slice(0, 5) : [],
        exampleGear: Array.isArray(build.exampleGear) ? build.exampleGear.slice(0, 4) : [],
        skills: Array.isArray(build.skills) ? build.skills.slice(0, 6) : [],
        warnings: Array.isArray(build.warnings) ? build.warnings.slice(0, 3) : []
    };
}

function compactDecision(decision) {
    if (!decision) return null;
    return {
        action: decision.action || null,
        reason: decision.reason || null,
        targetId: Number(decision.targetId || 0) || null,
        targetName: decision.targetName || null,
        skillId: Number(decision.skillId || 0) || null,
        skillName: decision.skillName || null,
        score: Number.isFinite(Number(decision.score)) ? Number(decision.score) : null,
        reasons: Array.isArray(decision.reasons) ? decision.reasons.slice(0, 4) : []
    };
}

function fullVitals(vitals = {}) {
    return {
        hp: Number(vitals.hp || 0),
        maxHp: Number(vitals.maxHp || 0),
        hpPct: safePercent(vitals.hpPct ?? (Number(vitals.hp || 0) / Math.max(1, Number(vitals.maxHp || 1)))),
        mp: Number(vitals.mp || 0),
        maxMp: Number(vitals.maxMp || 0),
        mpPct: safePercent(vitals.mpPct ?? (Number(vitals.mp || 0) / Math.max(1, Number(vitals.maxMp || 1))))
    };
}

function effectiveColdCombat(state) {
    const combat = state.stats?.coldCombat || {};
    const inventoryItems = Object.values(state.inventory || {});
    const hasEquippedInventory = inventoryItems.some((item) => item?.equipped);
    const hasPersistedEquipment = (Array.isArray(state.stats?.equipment) && state.stats.equipment.length > 0)
        || hasEquippedInventory;
    if (!combat.base && !combat.equipment && !hasPersistedEquipment) return null;

    // Some generated/legacy cold rows have a skills-only coldCombat snapshot.
    // Rebuild the authoritative profile from the equipped inventory instead of
    // exposing an empty equipment block in the observer.
    const inventory = hasEquippedInventory
        ? state.inventory
        : combat.equipment
            ? {}
            : Object.fromEntries((state.stats?.equipment || []).map((item) => [
                String(item.selfId), { ...item, equipped: true }
            ]));
    const profile = ColdCombatProfile.profileFor({ ...state, inventory });
    return {
        pAtk: Number(profile.pAtk || 0),
        mAtk: Number(profile.mAtk || 0),
        pDef: Number(profile.pDef || 0),
        mDef: Number(profile.mDef || 0),
        critical: Number(profile.critical || 0),
        accuracy: Number(profile.accur || 0),
        evasion: Number(profile.evasion || 0),
        atkSpd: Number(profile.atkSpd || 0),
        castSpd: Number(profile.castSpd || 0),
        maxMp: Number(profile.maxMp || 0)
    };
}

function compactPartyLeader(leader) {
    if (!leader) return null;
    const id = Number(leader.id || leader.characterId || 0) || null;
    if (!id) return null;
    const classId = normalizedClassId(leader.classId);
    return {
        id,
        name: leader.name || null,
        level: Number(leader.level || 0) || null,
        classId,
        className: className(classId),
        role: leader.role || null,
        phase: leader.phase || null
    };
}

function coldPartyLeader(state, leaderState = null) {
    const leaderId = Number(state.party?.leaderId || state.stats?.leaderId || 0) || null;
    if (!leaderId) return null;
    if (leaderState) {
        return compactPartyLeader({
            id: leaderState.characterId,
            name: leaderState.name,
            level: leaderState.level,
            classId: leaderState.stats?.classId || leaderState.stats?.classProgressionClassId,
            role: leaderState.party?.role || leaderState.stats?.role,
            phase: leaderState.phase
        });
    }
    if (leaderId === Number(state.characterId)) {
        return compactPartyLeader({
            id: state.characterId,
            name: state.name,
            level: state.level,
            classId: state.stats?.classId || state.stats?.classProgressionClassId,
            role: state.party?.role || state.stats?.role,
            phase: state.phase
        });
    }
    return { id: leaderId, name: null, level: null, classId: null, role: null, phase: null };
}

function compactColdEquipment(state) {
    const items = Array.isArray(state.stats?.equipment) ? state.stats.equipment : [];
    const combat = effectiveColdCombat(state);
    return compactEquipment({
        weapon: items.find((item) => String(item.kind || '').startsWith('Weapon.')) || null,
        equipped: items,
        totals: combat
    });
}

function coldIntent(state) {
    const activity = state.activity || 'hunting';
    if (activity === 'dead') return 'dead';
    if (activity === 'resting') return 'recover';
    if (activity === 'traveling') return 'travel';
    if (activity === 'party_wait') return 'find_party';
    if (activity === 'merchant') return 'trade';
    if (activity === 'crafting') return 'craft';
    if (state.stats?.equipmentPlan?.next) return 'progress_gear';
    return 'background_hunting';
}

function compactColdPlan(state) {
    const plan = state.stats?.equipmentPlan;
    if (!plan) return null;
    return {
        status: plan.status || null,
        phase: plan.phase || null,
        grade: plan.grade || null,
        target: plan.target ? {
            name: plan.target.name || null,
            slot: equipmentSlot(plan.target.slot),
            selfId: Number(plan.target.selfId || 0) || null
        } : null,
        next: plan.next ? {
            spotId: plan.next.spotId || null,
            npcName: plan.next.npcName || null,
            itemId: Number(plan.next.itemId || 0) || null,
            kind: plan.next.kind || null
        } : null,
        expectedKills: Number(plan.expectedKills || 0) || null,
        requiresParty: !!plan.requiresParty,
        partyNeed: plan.partyNeed || null
    };
}

function compactActorClan(subject) {
    const characterId = Number(subject?.fetchId?.() || subject?.characterId || 0);
    const directClan = subject?.fetchClan?.() || null;
    const memberClan = characterId > 0
        ? ClanService.all().find((clan) => clan.members.some((member) => Number(member.id) === characterId))
        : null;
    const clanId = Number(directClan?.id || memberClan?.id || subject?.fetchClanId?.() || subject?.clanId || subject?.stats?.clanId || 0);
    if (clanId <= 0) return null;
    const clan = directClan || memberClan || ClanService.findById(clanId);
    return {
        id: clanId,
        name: clan?.name || null
    };
}

function compactHotDetail(status, session) {
    const context = BotBrainContext.compactStatus(session, status, '', {
        includeInventory: false,
        includeSkills: false
    });
    const pkIds = isPkActor(session?.actor) ? new Set([Number(status.id)]) : new Set();
    return {
        ...compactHotBot(status, pkIds, session),
        kind: 'bot',
        clan: compactActorClan(session?.actor),
        vitals: fullVitals(status.vitals),
        movement: status.movement || null,
        nearby: status.nearby || null,
        target: status.target || null,
        party: status.party || null,
        trade: status.trade || null,
        buffs: context?.buffs || status.buffs || null,
        debuffs: status.debuffs || [],
        timers: status.timers || {},
        decisions: Object.fromEntries(Object.entries(status.decisions || {}).map(([key, value]) => [key, compactDecision(value)])),
        build: compactBuild(status.build),
        equipment: compactEquipment(context?.equipment),
        persona: status.persona || null,
        social: status.social || null,
        ambient: status.ambient || null,
        inference: status.inference || null,
        updatedAt: Date.now()
    };
}

function compactPlayerDetail(session) {
    const actor = session?.actor;
    if (!actor) return null;
    const compact = compactPlayer(session);
    return {
        ...compact,
        kind: 'player',
        clan: compactActorClan(actor),
        phase: 'player',
        mode: compact.online ? 'online' : 'offline',
        intent: compact.online ? 'online' : 'offline',
        role: 'player',
        region: compact.area?.name || null,
        vitals: {
            ...actorVitals(actor),
            cp: Number(actor.fetchCp?.() || 0),
            maxCp: Number(actor.fetchMaxCp?.() || 0)
        },
        equipment: liveEquipment(actor),
        combat: {
            pAtk: Number(actor.fetchCollectivePAtk?.() ?? actor.fetchPAtk?.() ?? 0),
            mAtk: Number(actor.fetchCollectiveMAtk?.() ?? actor.fetchMAtk?.() ?? 0),
            pDef: Number(actor.fetchCollectivePDef?.() ?? actor.fetchPDef?.() ?? 0),
            mDef: Number(actor.fetchCollectiveMDef?.() ?? actor.fetchMDef?.() ?? 0),
            critical: Number(actor.fetchCollectiveCritical?.() ?? actor.fetchCritical?.() ?? 0),
            accuracy: Number(actor.fetchCollectiveAccur?.() ?? actor.fetchAccur?.() ?? 0),
            evasion: Number(actor.fetchCollectiveEvasion?.() ?? actor.fetchEvasion?.() ?? 0),
            atkSpd: Number(actor.fetchAtkSpd?.() || 0),
            castSpd: Number(actor.fetchCastSpd?.() || 0)
        },
        exp: Number(actor.fetchExp?.() || 0),
        sp: Number(actor.fetchSp?.() || 0),
        pvp: Number(actor.fetchPvp?.() || 0),
        pk: Number(actor.fetchPk?.() || 0),
        karma: Number(actor.fetchKarma?.() || 0),
        movementPacketTrace: Array.isArray(session.movementPacketTrace)
            ? session.movementPacketTrace.slice(-160)
            : [],
        updatedAt: Date.now()
    };
}

function compactColdDetail(state, leaderState = null) {
    const stats = state.stats || {};
    const classId = normalizedClassId(stats.classId ?? stats.classProgressionClassId);
    const lastResolve = stats.lastResolveDebug || null;
    const compact = compactStateBot(state, new Set(), leaderState);
    return {
        ...compact,
        kind: 'bot',
        clan: compactActorClan(state),
        classId,
        className: className(classId),
        phase: state.phase || 'cold',
        mode: state.activity || 'hunting',
        intent: coldIntent(state),
        region: compact.region,
        home: compact.home,
        vitals: fullVitals(state.vitals),
        party: state.party?.partyId ? {
            id: state.party.partyId,
            role: state.party.role || stats.role || 'dps',
            leaderId: Number(state.party.leaderId || stats.leaderId || 0) || null,
            leader: coldPartyLeader(state, leaderState)
        } : null,
        build: compactBuild(stats.build),
        equipment: compactColdEquipment(state),
        combat: effectiveColdCombat(state),
        adena: Number(state.adena || 0),
        exp: Number(state.exp || 0),
        sp: Number(state.sp || 0),
        timing: state.timing || {},
        counters: {
            fightsWon: Number(stats.fightsWon || 0),
            fightsResolved: Number(stats.fightsResolved || 0),
            deaths: Number(stats.deaths || 0),
            expEarned: Number(stats.expEarned || 0),
            spEarned: Number(stats.spEarned || 0),
            adenaEarned: Number(stats.adenaEarned || 0),
            partyGearReceived: Number(stats.partyGearReceived || 0)
        },
        lastResolve: lastResolve ? {
            route: lastResolve.route || null,
            targetNpcId: Number(lastResolve.targetNpcId || 0) || null,
            fights: Number(lastResolve.fights || 0),
            wins: Number(lastResolve.wins || 0),
            at: lastResolve.at || null
        } : null,
        plan: compactColdPlan(state),
        travel: stats.travel || null,
        goal: stats.goal || null,
        persona: BotPersona.generate(state),
        updatedAt: state.updatedAt || 0
    };
}

function countBy(items, field) {
    return items.reduce((counts, item) => {
        const value = item[field] || 'unknown';
        counts[value] = (counts[value] || 0) + 1;
        return counts;
    }, {});
}

function buildSyntheticEvents(bots) {
    return bots
        .filter((bot) => bot.phase === 'hot')
        .slice(0, 8)
        .map((bot) => {
            const detail = bot.target?.name ? `targeting ${bot.target.name}` :
                bot.spot?.name ? `near ${bot.spot.name}` :
                bot.party?.leader?.name ? `following ${bot.party.leader.name}` :
                bot.intent;
            return {
                type: bot.mode || 'bot',
                summary: `${bot.name} is ${detail}`,
                createdAt: Date.now(),
                weight: 1
            };
        });
}

function mapCooperatively(items, mapper, sliceBudgetMs = 4) {
    const values = Array.isArray(items) ? items : [];
    const result = [];
    let index = 0;

    return new Promise((resolve) => {
        const runSlice = () => {
            const deadline = Date.now() + Math.max(1, Number(sliceBudgetMs) || 1);
            while (index < values.length && Date.now() < deadline) {
                result.push(mapper(values[index], index));
                index += 1;
            }

            if (index >= values.length) {
                resolve(result);
                return;
            }

            // Observer work is diagnostic and must yield to game/network
            // callbacks between chunks. A full 1776-bot snapshot can otherwise
            // occupy the main event loop long enough to look like player lag.
            setImmediate(runSlice);
        };

        runSlice();
    });
}

async function collectWorldActors() {
    const BotManager = invoke('GameServer/Bot/BotManager');
    const LifeState = invoke('GameServer/Bot/Population/BotLifeState');

    const pkHotIds = new Set(BotManager.sessions
        .filter((session) => isPkActor(session.actor))
        .map((session) => Number(session.actor.fetchId())));
    const hotBots = BotManager.getAllBotStatuses()
        .filter((status) => status && status.available)
        .map((status) => compactHotBot(
            status,
            pkHotIds,
            BotManager.findSessionById(Number(status.id))
        ));
    const hotIds = new Set(hotBots.map((bot) => Number(bot.id)));
    // The previous 700-item cap made the observer silently report 735 bots
    // (35 hot + 700 cold) while PopulationStatus already knew about the full
    // persisted population. Keep the payload bounded by the cache contract,
    // but do not hide the rest of the world from the map.
    const states = LifeState.allStates(2000);
    const stateById = new Map(states.map((state) => [Number(state.characterId), state]));
    const stateBots = (await mapCooperatively(states, (state) => compactStateBot(
        state,
        hotIds,
        stateById.get(Number(state.party?.leaderId || state.stats?.leaderId))
    ))).filter(Boolean);
    const bots = [...hotBots, ...stateBots];
    const players = realPlayerSessions().map(compactPlayer);
    return { hotBots, bots, players, states, stateById };
}

function projectionActor(actor, kind) {
    const projected = {
        id: Number(actor.id),
        kind,
        name: actor.name || (kind === 'player' ? 'Player' : 'Bot'),
        phase: kind === 'player' ? 'player' : actor.phase,
        mode: kind === 'player' ? 'player' : actor.mode,
        intent: kind === 'player' ? (actor.online ? 'online' : 'offline') : actor.intent,
        role: kind === 'player' ? 'player' : actor.role,
        level: Number(actor.level || 1),
        classId: actor.classId,
        className: actor.className || null,
        raceId: actor.raceId,
        exp: Number(actor.exp || 0),
        adena: Number(actor.adena || 0),
        equipmentValue: Number(actor.equipmentValue || 0),
        loc: actor.loc || null,
        area: actor.area || null,
        region: actor.region || null,
        online: kind === 'player' ? !!actor.online : undefined,
        staticService: kind === 'bot' ? !!actor.staticService : undefined,
        isPk: !!actor.isPk,
        blockers: actor.blockers?.includes('dead') ? ['dead'] : [],
        updatedAt: Number(actor.updatedAt || 0) || undefined
    };
    return Object.fromEntries(Object.entries(projected).filter(([, value]) => value !== undefined));
}

function projectionRow(actor) {
    return PROJECTION_FIELDS.map((field) => actor[field] ?? null);
}

function bindColdProjection() {
    if (projectionRuntime.unsubscribe) return;
    const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
    projectionRuntime.unsubscribe = LifeState.subscribeChanges((state) => {
        if (!projectionRuntime.initialized || !state?.characterId) return;
        const BotManager = invoke('GameServer/Bot/BotManager');
        if (BotManager.findSessionById(Number(state.characterId))) return;
        const leaderId = Number(state.party?.leaderId || state.stats?.leaderId || 0);
        const actor = compactStateBot(state, new Set(), LifeState.cachedState(leaderId));
        if (actor) WorldProjection.apply({ upserts: [projectionActor(actor, 'bot')] });
    });
}

async function ensureWorldProjection() {
    if (projectionRuntime.initialized) return WorldProjection.snapshot();
    if (projectionRuntime.initializing) return projectionRuntime.initializing;
    projectionRuntime.initializing = collectWorldActors().then(({ bots, players }) => {
        const actors = [
            ...bots.map((actor) => projectionActor(actor, 'bot')),
            ...players.map((actor) => projectionActor(actor, 'player'))
        ];
        const result = WorldProjection.reset(actors);
        projectionRuntime.dynamicKeys = new Set([
            ...bots.filter((actor) => actor.phase === 'hot').map((actor) => `bot:${Number(actor.id)}`),
            ...players.map((actor) => `player:${Number(actor.id)}`)
        ]);
        projectionRuntime.initialized = true;
        bindColdProjection();
        return result;
    }).finally(() => {
        projectionRuntime.initializing = null;
    });
    return projectionRuntime.initializing;
}

async function refreshDynamicProjection() {
    await ensureWorldProjection();
    const BotManager = invoke('GameServer/Bot/BotManager');
    const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
    const pkHotIds = new Set(BotManager.sessions
        .filter((session) => isPkActor(session.actor))
        .map((session) => Number(session.actor.fetchId())));
    const hot = BotManager.getAllBotStatuses()
        .filter((status) => status && status.available)
        .map((status) => projectionActor(compactHotBot(
            status,
            pkHotIds,
            BotManager.findSessionById(Number(status.id))
        ), 'bot'));
    const players = realPlayerSessions().map((session) => projectionActor(compactPlayer(session), 'player'));
    const nextDynamicKeys = new Set([
        ...hot.map((actor) => `bot:${Number(actor.id)}`),
        ...players.map((actor) => `player:${Number(actor.id)}`)
    ]);
    const upserts = [...hot, ...players];
    const removals = [];
    projectionRuntime.dynamicKeys.forEach((key) => {
        if (nextDynamicKeys.has(key)) return;
        const [kind, rawId] = key.split(':');
        const id = Number(rawId);
        if (kind === 'bot') {
            const state = LifeState.cachedState(id);
            if (state) {
                const leaderId = Number(state.party?.leaderId || state.stats?.leaderId || 0);
                const actor = compactStateBot(state, new Set(), LifeState.cachedState(leaderId));
                if (actor) upserts.push(projectionActor(actor, 'bot'));
                else removals.push({ kind, id });
            } else removals.push({ kind, id });
        } else removals.push({ kind, id });
    });
    projectionRuntime.dynamicKeys = nextDynamicKeys;
    return WorldProjection.apply({ upserts, removals });
}

async function worldBootstrap() {
    await ensureWorldProjection();
    await refreshDynamicProjection();
    const projection = WorldProjection.snapshot();
    const actors = projection.actors;
    const status = worldStatus();
    return {
        ...status,
        epoch: WORLD_EPOCH,
        revision: projection.revision,
        bounds: WORLD_BOUNDS,
        mapTiles: MAP_TILES,
        labels: REGION_LABELS,
        classes: classCatalog(),
        actorFormat: 'row-v1',
        actorFields: PROJECTION_FIELDS,
        bots: actors.filter((actor) => actor.kind === 'bot').map(projectionRow),
        players: actors.filter((actor) => actor.kind === 'player').map(projectionRow)
    };
}

function worldStatus() {
    const PopulationStatus = invoke('GameServer/Bot/Population/PopulationStatus');
    const memory = process.memoryUsage();
    return {
        epoch: WORLD_EPOCH,
        generatedAt: Date.now(),
        uptimeMs: Math.round(process.uptime() * 1000),
        raidBosses: raidBossSnapshot(),
        population: PopulationStatus.counts(),
        runtime: {
            heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
            rssMb: Math.round(memory.rss / 1024 / 1024)
        }
    };
}

async function worldChanges(revision) {
    await ensureWorldProjection();
    await refreshDynamicProjection();
    return { epoch: WORLD_EPOCH, ...WorldProjection.changesSince(revision) };
}

async function snapshot() {
    const LifeEvents = invoke('GameServer/Bot/Population/BotLifeEvents');
    const PopulationStatus = invoke('GameServer/Bot/Population/PopulationStatus');
    const { hotBots, bots, players } = await collectWorldActors();
    const memory = process.memoryUsage();

    return LifeEvents.recent(18).then((events) => ({
        generatedAt: Date.now(),
        uptimeMs: Math.round(process.uptime() * 1000),
        bounds: WORLD_BOUNDS,
        mapTiles: MAP_TILES,
        labels: REGION_LABELS,
        classes: classCatalog(),
        raidBosses: raidBossSnapshot(),
        population: PopulationStatus.counts(),
        runtime: {
            heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
            rssMb: Math.round(memory.rss / 1024 / 1024)
        },
        players,
        bots,
        stats: {
            botsByPhase: countBy(bots, 'phase'),
            botsByMode: countBy(bots, 'mode'),
            botsByRole: countBy(bots, 'role'),
            activeTargets: hotBots.filter((bot) => bot.target).length,
            moving: hotBots.filter((bot) => bot.movement?.moving).length,
            blockers: hotBots.filter((bot) => bot.blockers?.length).length
        },
        events: events.length > 0 ? events : buildSyntheticEvents(bots)
    }));
}

function snapshotJson(now = Date.now()) {
    const ttlMs = observerCacheTtl(now);
    if (snapshotCache.json && now - snapshotCache.generatedAt < ttlMs) {
        snapshotCache.hits += 1;
        return Promise.resolve(snapshotCache.json);
    }
    if (snapshotCache.inFlight) {
        snapshotCache.hits += 1;
        return snapshotCache.inFlight;
    }

    snapshotCache.builds += 1;
    snapshotCache.inFlight = Promise.resolve()
        .then(() => snapshot())
        .then((data) => JSON.stringify(data))
        .then((json) => {
            snapshotCache.json = json;
            snapshotCache.generatedAt = Date.now();
            snapshotCache.revision += 1;
            snapshotCache.bytes = Buffer.byteLength(json);
            snapshotCache.etag = `W/"world-${snapshotCache.revision}-${snapshotCache.bytes}"`;
            return json;
        })
        .finally(() => {
            snapshotCache.inFlight = null;
        });
    return snapshotCache.inFlight;
}

async function botDetail(characterId) {
    const id = Number(characterId);
    if (!Number.isSafeInteger(id) || id <= 0) return null;

    const BotManager = invoke('GameServer/Bot/BotManager');
    const hotSession = BotManager.findSessionById(id);
    if (hotSession?.actor) {
        const status = BotManager.getBotStatus(hotSession);
        return status?.available ? compactHotDetail(status, hotSession) : null;
    }

    const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
    const state = await LifeState.findByCharacterId(id);
    if (!state) return null;

    const leaderId = Number(state.party?.leaderId || state.stats?.leaderId || 0) || null;
    let leaderState = leaderId === id ? state : null;
    if (leaderId && !leaderState) {
        const leaderSession = BotManager.findSessionById(leaderId);
        if (leaderSession?.actor) {
            const leaderStatus = BotManager.getBotStatus(leaderSession);
            leaderState = {
                characterId: leaderId,
                name: leaderSession.actor.fetchName(),
                level: leaderSession.actor.fetchLevel(),
                phase: 'hot',
                party: { role: leaderStatus?.role || null },
                stats: { classId: leaderSession.actor.fetchClassId?.(), role: leaderStatus?.role || null }
            };
        } else {
            leaderState = await LifeState.findByCharacterId(leaderId);
        }
    }
    return compactColdDetail(state, leaderState);
}

async function actorDetail(kind, characterId) {
    const id = Number(characterId);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    if (kind === 'player') {
        const playerSession = realPlayerSessions()
            .find((session) => Number(session.actor?.fetchId?.()) === id);
        return compactPlayerDetail(playerSession);
    }
    if (kind !== 'bot') return null;
    return botDetail(id);
}

function sendJson(response, data, statusCode = 200) {
    response.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
    });
    response.end(JSON.stringify(data));
}

function sendSnapshotJson(request, response, json) {
    const etag = snapshotCache.etag || `W/"world-0-${Buffer.byteLength(json)}"`;
    const headers = {
        'Cache-Control': 'no-cache',
        ETag: etag,
        'X-Observer-Revision': String(snapshotCache.revision || 0)
    };
    if (String(request.headers['if-none-match'] || '') === etag) {
        response.writeHead(304, headers);
        response.end();
        return;
    }
    response.writeHead(200, {
        ...headers,
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(json)
    });
    response.end(json);
}

function readJsonBody(request, maxBytes = 16384) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let bytes = 0;
        let settled = false;
        request.on('data', (chunk) => {
            if (settled) return;
            bytes += chunk.length;
            if (bytes > maxBytes) {
                settled = true;
                const error = new Error('Request body is too large');
                error.statusCode = 413;
                reject(error);
                return;
            }
            chunks.push(chunk);
        });
        request.on('end', () => {
            if (settled) return;
            try {
                const json = Buffer.concat(chunks).toString('utf8');
                resolve(json ? JSON.parse(json) : {});
            } catch (error) {
                error.statusCode = 400;
                reject(error);
            }
        });
        request.on('error', (error) => {
            if (!settled) reject(error);
        });
    });
}

function decodeClanCrestPixels(payload) {
    const width = Number(payload?.width);
    const height = Number(payload?.height);
    const encoded = String(payload?.pixels || '').trim();
    if (width !== 16 || height !== 12 || !encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
        return { ok: false, code: 'invalid_crest_pixels' };
    }
    const pixels = Buffer.from(encoded, 'base64');
    if (pixels.length !== width * height * 4) return { ok: false, code: 'invalid_crest_pixels' };
    return { ok: true, width, height, pixels };
}

async function updatePlayerManagedClanCrest(clanId, payload) {
    const id = Number(clanId);
    if (!Number.isSafeInteger(id) || id <= 0) return { ok: false, code: 'invalid_clan' };
    const decoded = decodeClanCrestPixels(payload);
    if (!decoded.ok) return decoded;
    const crestData = ClanCrestService.rgbaToDxt1Dds(decoded.pixels, decoded.width, decoded.height);
    const result = await ClanService.setPlayerManagedCrest(id, crestData);
    if (!result.ok) return result;
    return {
        ok: true,
        clanId: id,
        crestId: Number(result.crestId || 0),
        crestUrl: result.crestId ? `/observer/api/clan/${id}/crest?v=${Number(result.crestId)}` : null
    };
}

async function deletePlayerManagedClanCrest(clanId) {
    const id = Number(clanId);
    if (!Number.isSafeInteger(id) || id <= 0) return { ok: false, code: 'invalid_clan' };
    const result = await ClanService.setPlayerManagedCrest(id, Buffer.alloc(0));
    return result.ok ? { ok: true, clanId: id, crestId: 0, crestUrl: null, deleted: true } : result;
}

function clanCrestMutationStatus(result) {
    if (result?.ok) return 200;
    if (result?.code === 'target_not_player_managed' || result?.code === 'level_too_low') return 409;
    return 400;
}

function sendClanCrest(request, response, crest, url) {
    const etag = `W/"clan-crest-${crest.id}-${crest.data.length}"`;
    const versioned = String(url?.searchParams?.get('v') || '') === String(crest.id);
    const headers = {
        'Content-Type': 'image/bmp',
        'Content-Length': crest.data.length,
        'Cache-Control': versioned ? 'public, max-age=31536000, immutable' : 'no-cache',
        ETag: etag
    };
    if (String(request.headers['if-none-match'] || '') === etag) {
        delete headers['Content-Length'];
        response.writeHead(304, headers);
        response.end();
        return;
    }
    response.writeHead(200, headers);
    response.end(crest.data);
}

function sendFile(request, response, filePath) {
    fs.stat(filePath, (statError, stat) => {
        if (statError || !stat.isFile()) {
            response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            response.end('Not found');
            return;
        }
        const etag = `W/"asset-${stat.size}-${Math.floor(stat.mtimeMs)}"`;
        const cacheHeaders = {
            'Cache-Control': 'public, max-age=0, must-revalidate',
            ETag: etag,
            'Last-Modified': stat.mtime.toUTCString()
        };
        if (String(request.headers['if-none-match'] || '') === etag) {
            response.writeHead(304, cacheHeaders);
            response.end();
            return;
        }
        fs.readFile(filePath, (err, body) => {
            if (err) {
                response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                response.end('Not found');
                return;
            }
            response.writeHead(200, {
                ...cacheHeaders,
                'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream',
                'Content-Length': body.length
            });
            response.end(body);
        });
    });
}

function route(request, response) {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/' || url.pathname === '/observer') {
        response.writeHead(302, { Location: '/observer/' });
        response.end();
        return;
    }

    if (url.pathname === '/observer/api/snapshot') {
        snapshotJson()
            .then((json) => sendSnapshotJson(request, response, json))
            .catch((err) => sendJson(response, { error: err.message }, 500));
        return;
    }

    if (url.pathname === '/observer/api/world/bootstrap') {
        worldBootstrap()
            .then((data) => sendJson(response, data))
            .catch((err) => sendJson(response, { error: err.message }, 500));
        return;
    }

    if (url.pathname === '/observer/api/world/status') {
        try {
            sendJson(response, worldStatus());
        } catch (err) {
            sendJson(response, { error: err.message }, 500);
        }
        return;
    }

    if (url.pathname === '/observer/api/world/changes') {
        worldChanges(url.searchParams.get('since'))
            .then((data) => {
                if (!data.reset && !data.upserts.length && !data.removals.length) {
                    response.writeHead(204, {
                        'Cache-Control': 'no-store',
                        'X-Observer-Epoch': data.epoch,
                        'X-Observer-Revision': String(data.revision || 0)
                    });
                    response.end();
                    return;
                }
                sendJson(response, data);
            })
            .catch((err) => sendJson(response, { error: err.message }, 500));
        return;
    }

    if (url.pathname === '/observer/api/clans') {
        clanSnapshot()
            .then((data) => sendJson(response, data))
            .catch((err) => sendJson(response, { error: err.message }, 500));
        return;
    }

    const clanCrestMatch = url.pathname.match(/^\/observer\/api\/clan\/(\d+)\/crest$/);
    if (clanCrestMatch) {
        if (request.method === 'POST') {
            readJsonBody(request)
                .then((payload) => updatePlayerManagedClanCrest(clanCrestMatch[1], payload))
                .then((result) => sendJson(response, result, clanCrestMutationStatus(result)))
                .catch((err) => sendJson(response, { ok: false, error: err.message }, err.statusCode || 500));
            return;
        }
        if (request.method === 'DELETE') {
            deletePlayerManagedClanCrest(clanCrestMatch[1])
                .then((result) => sendJson(response, result, clanCrestMutationStatus(result)))
                .catch((err) => sendJson(response, { ok: false, error: err.message }, 500));
            return;
        }
        if (request.method !== 'GET') {
            response.writeHead(405, { Allow: 'GET, POST, DELETE' });
            response.end();
            return;
        }
        clanCrest(clanCrestMatch[1])
            .then((crest) => crest
                ? sendClanCrest(request, response, crest, url)
                : sendJson(response, { error: 'Clan crest not found' }, 404))
            .catch((err) => sendJson(response, { error: err.message }, 500));
        return;
    }

    const clanMatch = url.pathname.match(/^\/observer\/api\/clan\/(\d+)$/);
    if (clanMatch) {
        clanDetail(clanMatch[1])
            .then((data) => data
                ? sendJson(response, data)
                : sendJson(response, { error: 'Clan not found' }, 404))
            .catch((err) => sendJson(response, { error: err.message }, 500));
        return;
    }

    const botMatch = url.pathname.match(/^\/observer\/api\/bot\/(\d+)$/);
    if (botMatch) {
        botDetail(botMatch[1])
            .then((data) => data
                ? sendJson(response, data)
                : sendJson(response, { error: 'Bot not found' }, 404))
            .catch((err) => sendJson(response, { error: err.message }, 500));
        return;
    }

    const actorMatch = url.pathname.match(/^\/observer\/api\/actor\/(bot|player)\/(\d+)$/);
    if (actorMatch) {
        actorDetail(actorMatch[1], actorMatch[2])
            .then((data) => data
                ? sendJson(response, data)
                : sendJson(response, { error: 'Actor not found' }, 404))
            .catch((err) => sendJson(response, { error: err.message }, 500));
        return;
    }

    const itemIconMatch = url.pathname.match(/^\/observer\/item-icons\/([^/]+)$/);
    if (itemIconMatch) {
        let fileName = null;
        try {
            fileName = decodeURIComponent(itemIconMatch[1]);
        } catch (error) {
            fileName = null;
        }
        const filePath = itemIconFilePath(fileName);
        if (!filePath) {
            response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            response.end('Not found');
            return;
        }
        sendFile(request, response, filePath);
        return;
    }

    if (/^\/observer\/(?:world|rankings|raid-bosses(?:\/\d+)?|clans(?:\/\d+)?|actors\/(?:bot|player)\/\d+)\/?$/.test(url.pathname)) {
        sendFile(request, response, path.join(PUBLIC_DIR, 'index.html'));
        return;
    }

    if (url.pathname.startsWith('/observer/')) {
        const relative = url.pathname.replace(/^\/observer\/?/, '') || 'index.html';
        const safeRelative = path.normalize(relative).replace(/^(\.\.[/\\])+/, '');
        const filePath = path.join(PUBLIC_DIR, safeRelative);
        if (!filePath.startsWith(PUBLIC_DIR)) {
            response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
            response.end('Forbidden');
            return;
        }
        sendFile(request, response, filePath);
        return;
    }

    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
}

const WorldObserverServer = {
    server: null,
    compactPlayer,
    compactPlayerDetail,
    compactHotBot,
    compactStateBot,
    compactColdDetail,
    compactHotDetail,
    compactClanGoal,
    compactClanOverview,
    compactClanMember,
    compactActorClan,
    browserClanCrestData,
    decodeClanCrestPixels,
    updatePlayerManagedClanCrest,
    deletePlayerManagedClanCrest,
    clanCrest,
    clanSnapshot,
    clanDetail,
    compactItem,
    itemIconFilePath,
    classCatalog,
    actorDetail,
    raidBossCatalog,
    raidBossSnapshot,
    equipmentValue,
    itemIconCatalogStatus() {
        const catalog = loadItemIconCatalog();
        return {
            available: catalog.available,
            itemCount: catalog.itemCount,
            error: catalog.error || null
        };
    },
    snapshotJson,
    sendSnapshotJson,
    sendFile,
    worldBootstrap,
    worldChanges,
    worldStatus,
    observerCacheTtl,
    snapshotCacheStats() {
        return {
            generatedAt: snapshotCache.generatedAt,
            etag: snapshotCache.etag,
            revision: snapshotCache.revision,
            bytes: snapshotCache.bytes,
            builds: snapshotCache.builds,
            hits: snapshotCache.hits,
            hasValue: !!snapshotCache.json,
            inFlight: !!snapshotCache.inFlight
        };
    },

    init() {
        if (!isEnabled() || this.server) return;

        const config = options.default.WorldObserver || {};
        const hostname = config.hostname || '127.0.0.1';
        const port = Number(config.port || 8088);

        this.server = http.createServer(route);
        this.server.listen(port, hostname, () => {
            utils.infoSuccess('Observer', 'world observer ready at http://%s:%d/observer/', hostname, port);
        });

        this.server.on('error', (err) => {
            utils.infoWarn('Observer', 'world observer failed: %s', err.message);
        });
    }
};

module.exports = WorldObserverServer;
