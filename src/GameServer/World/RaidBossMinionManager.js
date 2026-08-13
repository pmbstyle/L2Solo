const DataCache = invoke('GameServer/DataCache');
const NpcVisibility = invoke('GameServer/World/NpcVisibility');
const RaidEntityIndex = invoke('GameServer/World/RaidEntityIndex');

const groupsByBoss = new Map();
const minionTemplates = new Map();
const MINION_MAINTENANCE_INTERVAL_MS = 5000;
// C4/Lisvus Config.RAID_MINION_RESPAWN_TIME defaults to five minutes.
const MINION_RESPAWN_DELAY_MS = 300000;
const telemetry = {
    engagements: 0,
    minionsAlerted: 0,
    lastEngagementAt: 0,
    lastBossObjectId: null,
    lastAttackerId: null
};

require('../../../data/Npcs/Minions/c4_raid_bosses.json').forEach((row) => {
    if (!groupsByBoss.has(Number(row.bossId))) groupsByBoss.set(Number(row.bossId), []);
    groupsByBoss.get(Number(row.bossId)).push({
        minionId: Number(row.minionId),
        min: Number(row.min),
        max: Number(row.max)
    });
});

function randomCount(min, max) {
    const low = Math.max(1, Number(min) || 1);
    const high = Math.max(low, Number(max) || low);
    return low + Math.floor(Math.random() * (high - low + 1));
}

function templateFor(minionId) {
    const id = Number(minionId);
    if (!minionTemplates.has(id)) {
        minionTemplates.set(id, DataCache.npcs?.find((npc) => Number(npc.selfId) === id) || null);
    }
    return minionTemplates.get(id);
}

function liveNpc(world, npc) {
    return RaidEntityIndex.has(world, npc);
}

function aliveMinions(world, group) {
    group.members = group.members.filter((minion) => liveNpc(world, minion));
    return group.members.filter((minion) => minion.state?.fetchDead?.() !== true && minion.isDead?.() !== true);
}

function minionCoords(boss) {
    const angle = Math.random() * Math.PI * 2;
    const radius = 80 + Math.random() * 220;
    return {
        locX: Math.round(Number(boss.fetchLocX?.() || 0) + Math.cos(angle) * radius),
        locY: Math.round(Number(boss.fetchLocY?.() || 0) + Math.sin(angle) * radius),
        locZ: Number(boss.fetchLocZ?.() || 0),
        head: Math.floor(Math.random() * 65536)
    };
}

function spawnMinion(world, boss, group) {
    const template = templateFor(group.minionId);
    if (!template || boss.state?.fetchDead?.() === true) return null;

    const SpawnNpcs = invoke('GameServer/World/Generics/SpawnNpcs');
    const minion = SpawnNpcs.spawnChildNpc(world, template, minionCoords(boss), {
        minionBossTemplateId: Number(boss.fetchSelfId?.() || 0),
        minionBossObjectId: Number(boss.fetchId?.() || 0),
        minionGroup: group
    });
    if (minion) group.members.push(minion);
    return minion;
}

function fillGroup(world, boss, group, count = group.desired) {
    const live = aliveMinions(world, group).length;
    for (let index = live; index < count; index++) spawnMinion(world, boss, group);
}

function attachBoss(world, boss) {
    const bossId = Number(boss?.fetchSelfId?.() || 0);
    const definitions = groupsByBoss.get(bossId) || [];
    if (!boss || definitions.length === 0 || boss.minionState) return boss?.minionState || null;

    const state = {
        boss,
        groups: definitions.map((definition) => ({
            ...definition,
            desired: randomCount(definition.min, definition.max),
            members: [],
            respawnAt: 0
        }))
    };
    boss.minionState = state;
    state.groups.forEach((group) => fillGroup(world, boss, group));
    return state;
}

function onBossAttacked(world, boss, attacker, sourceSession) {
    if (!boss || !attacker || boss.state?.fetchDead?.() === true || attacker.isDead?.() === true) return 0;
    const state = boss.minionState || attachBoss(world, boss);
    if (!state) return 0;

    const session = sourceSession || {
        dataSendToMeAndOthers() {},
        dataSendToMe() {}
    };
    let alerted = 0;
    state.groups.forEach((group) => {
        aliveMinions(world, group).forEach((minion) => {
            if (minion.state?.fetchCombats?.() === true) return;
            try {
                minion.enterCombatState?.(session, attacker);
                if (minion.state?.fetchCombats?.() === true) alerted++;
            } catch (_) {}
        });
    });
    // `alerted > 0` is naturally edge-triggered: later hits see the same
    // minions already in combat, so one encounter produces one concise line.
    if (alerted > 0) {
        const observedAt = Date.now();
        telemetry.engagements += 1;
        telemetry.minionsAlerted += alerted;
        telemetry.lastEngagementAt = observedAt;
        telemetry.lastBossObjectId = Number(boss.fetchId?.() || 0) || null;
        telemetry.lastAttackerId = Number(attacker.fetchId?.() || 0) || null;
        console.info(
            'RaidCombat :: engaged boss=%s attacker=%s minionsAlerted=%d',
            telemetry.lastBossObjectId || 'unknown',
            telemetry.lastAttackerId || 'unknown',
            alerted
        );
    }
    return alerted;
}

function bossForMinion(world, minion) {
    return RaidEntityIndex.bossFor(world, minion);
}

// C4/Lisvus treats a minion hit as an attack on the raid group. The leader
// joins the fight first, then calls every other idle minion to the attacker.
// Keep the native guard: an already engaged leader does not retarget its
// existing encounter just because a second minion was hit.
function onMinionAttacked(world, minion, attacker, sourceSession) {
    if (!minion || !attacker || minion.state?.fetchDead?.() === true || attacker.isDead?.() === true) return 0;

    const boss = bossForMinion(world, minion);
    if (
        !boss ||
        boss.state?.fetchDead?.() === true ||
        boss.isDead?.() === true ||
        boss.state?.fetchCombats?.() === true
    ) return 0;

    const session = sourceSession || {
        dataSendToMeAndOthers() {},
        dataSendToMe() {}
    };
    boss.enterCombatState?.(session, attacker);
    if (boss.state?.fetchCombats?.() !== true) return 0;
    return onBossAttacked(world, boss, attacker, session);
}

function onMinionDeath(world, minion) {
    const boss = RaidEntityIndex.bossFor(world, minion);
    const group = minion?.minionGroup;
    if (!boss?.minionState || !group) return false;
    if (!group.respawnAt) group.respawnAt = Date.now() + MINION_RESPAWN_DELAY_MS;
    return true;
}

function cleanupMinion(world, minion, sourceSession) {
    if (!liveNpc(world, minion)) return false;
    const objectId = minion.fetchId?.();
    try {
        minion.destructor?.(sourceSession || { dataSendToMeAndOthers() {}, dataSendToMe() {} });
    } catch (_) {}
    world.removeNpcFromGrid?.(minion);
    const index = world.npc.spawns.indexOf(minion);
    if (index >= 0) world.npc.spawns.splice(index, 1);
    NpcVisibility.deleteKnownNpc(world, sourceSession, objectId);
    return true;
}

function onBossDeath(world, boss, sourceSession) {
    const state = boss?.minionState;
    if (!state) return 0;
    let removed = 0;
    state.groups.forEach((group) => {
        group.members.forEach((minion) => {
            if (cleanupMinion(world, minion, sourceSession)) removed++;
        });
        group.members = [];
    });
    boss.minionState = null;
    return removed;
}

function stats() {
    return { ...telemetry };
}

function maintain(world, now = Date.now()) {
    if (!world?.npc?.spawns) return 0;
    let spawned = 0;
    RaidEntityIndex.bosses(world).forEach((boss) => {
        if (boss.state?.fetchDead?.() === true || boss.isDead?.() === true) return;
        const state = boss.minionState || attachBoss(world, boss);
        state?.groups?.forEach((group) => {
            const alive = aliveMinions(world, group).length;
            if (alive >= group.desired) {
                group.respawnAt = 0;
                return;
            }
            if (!group.respawnAt) group.respawnAt = now + MINION_RESPAWN_DELAY_MS;
            if (now >= group.respawnAt) {
                const before = group.members.length;
                fillGroup(world, boss, group);
                spawned += Math.max(0, group.members.length - before);
                group.respawnAt = 0;
            }
        });
    });
    return spawned;
}

function start(world) {
    stop(world);
    if (!world?.npc) return null;
    world.npc.raidBossMinionTicker = setInterval(() => maintain(world), MINION_MAINTENANCE_INTERVAL_MS);
    world.npc.raidBossMinionTicker.unref?.();
    return world.npc.raidBossMinionTicker;
}

function stop(world) {
    if (!world?.npc?.raidBossMinionTicker) return;
    clearInterval(world.npc.raidBossMinionTicker);
    world.npc.raidBossMinionTicker = undefined;
}

module.exports = {
    MINION_RESPAWN_DELAY_MS,
    attachBoss,
    onBossAttacked,
    onMinionAttacked,
    onMinionDeath,
    onBossDeath,
    maintain,
    start,
    stop,
    stats,
    groupsByBoss
};
