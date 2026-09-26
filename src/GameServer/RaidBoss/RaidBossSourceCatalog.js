const DataCache = invoke('GameServer/DataCache');

let cachedNpcs = null;
let cachedSpawns = null;
let cached = [];

function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function spawnRows() {
    const bossIds = new Set((DataCache.npcs || [])
        .filter((npc) => npc?.template?.raidBoss === true)
        .map((npc) => number(npc.selfId)));
    return (DataCache.npcSpawns || []).flatMap((area) => (area.spawns || [])
        .filter((spawn) => bossIds.has(number(spawn.selfId)))
        .map((spawn) => ({ area, spawn })));
}

function arrivalPoints(center, distance = 650) {
    return Array.from({ length: 8 }, (_, index) => {
        const angle = Math.PI * 2 * index / 8;
        return {
            locX: Math.round(number(center.locX) + Math.cos(angle) * distance),
            locY: Math.round(number(center.locY) + Math.sin(angle) * distance),
            locZ: number(center.locZ)
        };
    });
}

function buildProfiles() {
    const npcById = new Map((DataCache.npcs || []).map((npc) => [number(npc.selfId), npc]));
    return spawnRows().flatMap(({ spawn }) => {
        const npc = npcById.get(number(spawn.selfId));
        const center = spawn.coords?.[0];
        if (!npc || !center) return [];
        const level = Math.max(1, number(npc.template?.level, 1));
        return [{
            id: `raid:${number(npc.selfId)}`,
            name: npc.template?.name || spawn.name || `Raid Boss ${npc.selfId}`,
            center: { locX: number(center.locX), locY: number(center.locY), locZ: number(center.locZ) },
            minLevel: Math.max(1, level - 5),
            maxLevel: level + 8,
            avgLevel: level,
            density: 1,
            npcNames: [npc.template?.name || spawn.name].filter(Boolean),
            npcSelfIds: [number(npc.selfId)],
            npcEntries: [{ selfId: number(npc.selfId), name: npc.template?.name || spawn.name, level, count: 1 }],
            arrivalPoints: arrivalPoints(center),
            levelCounts: { [level]: 1 },
            dominantLevels: [{ level, count: 1 }],
            area: null,
            tags: ['raid_boss'],
            tagsAuthoritative: true,
            capacity: 999,
            localStarterRegions: [],
            localUntilLevel: null,
            route: 'raid_boss',
            rewards: {
                exp: Math.max(0, number(npc.rewards?.exp)),
                sp: Math.max(0, number(npc.rewards?.sp)),
                adenaMin: 0,
                adenaMax: 0
            },
            mob: {
                hp: Math.max(1, number(npc.vitals?.maxHp, 1)),
                damage: Math.max(1, number(npc.stats?.pAtk, 1)),
                hitDelayMs: 1600
            },
            risk: 100,
            raidBoss: true,
            sharedEncounter: true,
            raidBossTemplateId: number(npc.selfId),
            respawnSeconds: require('./RespawnPolicy').RESPAWN_DELAY_MS / 1000,
            respawnBiasSeconds: 0
        }];
    }).sort((left, right) => left.avgLevel - right.avgLevel
        || left.raidBossTemplateId - right.raidBossTemplateId);
}

function all() {
    if (cachedNpcs !== DataCache.npcs || cachedSpawns !== DataCache.npcSpawns) {
        cachedNpcs = DataCache.npcs;
        cachedSpawns = DataCache.npcSpawns;
        cached = buildProfiles();
    }
    return cached;
}

function liveTemplateIds() {
    try {
        const world = invoke('GameServer/World/World');
        const index = invoke('GameServer/World/RaidEntityIndex');
        return new Set(index.bosses(world)
            .filter((boss) => !boss.isDead?.() && Number(boss.fetchHp?.() ?? 1) > 0)
            .map((boss) => number(boss.fetchSelfId?.()))
            .filter(Boolean));
    } catch (_) {
        return new Set();
    }
}

function available() {
    const live = liveTemplateIds();
    if (!live.size) return [];
    return all().filter((profile) => live.has(profile.raidBossTemplateId));
}

function findById(id) {
    return all().find((profile) => String(profile.id) === String(id)) || null;
}

module.exports = { all, available, findById, liveTemplateIds };
