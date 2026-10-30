const DiagnosticConfig = require('../Bot/Population/PopulationConfig');
const Diagnostics = require('../Bot/Economy/EconomyDiagnostics');
const ItemTemplateIndex = require('../Item/ItemTemplateIndex');
const DataCache = invoke('GameServer/DataCache');
const NpcVisibility = invoke('GameServer/World/NpcVisibility');
const RaidEntityIndex = invoke('GameServer/World/RaidEntityIndex');

// One manager for every Lisvus minion group: raid bosses and ordinary group
// leaders (data/Npcs/Minions). Lisvus keeps the raid rules apart: only raid
// minions return on a timer while their boss lives and leave with its death.
// An ordinary leader's minions spawn with it, are not replaced while it lives,
// outlive it, and give way to a fresh group when its spawn brings it back.
const groupsByBoss = new Map();
const minionTemplates = new Map();
// The last ordinary leader of each spawn definition, to replace its group.
const leaderBySpawnDefinition = new WeakMap();
// C4/Lisvus Config.RAID_MINION_RESPAWN_TIME defaults to five minutes.
const MINION_RESPAWN_DELAY_MS = 300000;
// Raid groups short of minions, group -> boss: a minion leaving the world adds
// its group (a death, and RaidEntityIndex announces every removal, with or
// without a death) and the alarm visits only these.
const refillDue = new Map();
// One timer on the nearest respawnAt of refillDue, for the world start() bound.
const alarm = { world: null, timer: null, at: 0 };
const telemetry = {
    // Fills that spawned at least one minion.
    refills: 0,
    // Groups the tick looked at; the tick must not touch the other groups.
    groupVisits: 0,
    // Groups first marked short by a removal no death announced.
    removalFeeds: 0,
    engagements: 0,
    minionsAlerted: 0,
    lastEngagementAt: 0,
    lastBossObjectId: null,
    lastAttackerId: null
};

[
    ...require('../../../data/Npcs/Minions/c4_raid_bosses.json'),
    ...require('../../../data/Npcs/Minions/c4_group_leaders.json')
].forEach((row) => {
    if (!groupsByBoss.has(Number(row.bossId))) groupsByBoss.set(Number(row.bossId), []);
    groupsByBoss.get(Number(row.bossId)).push({
        minionId: Number(row.minionId),
        min: Number(row.min),
        max: Number(row.max)
    });
});

function randomCount(min, max, random = Math.random) {
    const low = Math.max(1, Number(min) || 1);
    const high = Math.max(low, Number(max) || low);
    return low + Math.floor(random() * (high - low + 1));
}

function templateFor(minionId) {
    const id = Number(minionId);
    if (!minionTemplates.has(id)) {
        minionTemplates.set(id, ItemTemplateIndex.find(DataCache.npcs, id) || null);
    }
    return minionTemplates.get(id);
}

function isRaidBoss(boss) {
    return boss?.fetchIsRaidBoss?.() === true;
}

function bossAlive(boss) {
    return boss.state?.fetchDead?.() !== true && boss.isDead?.() !== true;
}

function liveNpc(world, npc) {
    return RaidEntityIndex.has(world, npc);
}

function aliveMinions(world, group) {
    group.members = group.members.filter((minion) => liveNpc(world, minion));
    return group.members.filter((minion) => minion.state?.fetchDead?.() !== true && minion.isDead?.() !== true);
}

function minionCoords(boss, random = Math.random) {
    const angle = random() * Math.PI * 2;
    const radius = 80 + random() * 220;
    return {
        locX: Math.round(Number(boss.fetchLocX?.() || 0) + Math.cos(angle) * radius),
        locY: Math.round(Number(boss.fetchLocY?.() || 0) + Math.sin(angle) * radius),
        locZ: Number(boss.fetchLocZ?.() || 0),
        head: Math.floor(random() * 65536)
    };
}

// The minions an ordinary group leader of the spot catalogue brings
// (SpawnNpcs.catalogueSpawns): each group's count and places as attachBoss
// and spawnMinion draw them, from the catalogue's seeded `random`.
function catalogueMinions(leader, random) {
    const minions = [];
    for (const group of groupsByBoss.get(Number(leader?.fetchSelfId?.() || 0)) || []) {
        const template = templateFor(group.minionId);
        if (!template) continue;
        for (let left = randomCount(group.min, group.max, random); left > 0; left--) {
            minions.push({ template, coords: minionCoords(leader, random), link: { minionLeader: leader, minionGroup: group } });
        }
    }
    return minions;
}

function spawnMinion(world, boss, group) {
    const template = templateFor(group.minionId);
    if (!template || !bossAlive(boss)) return null;

    const SpawnNpcs = invoke('GameServer/World/Generics/SpawnNpcs');
    // The boss ids mark raid entities for raid rules and bot safety; an
    // ordinary minion is a plain monster that only knows its leader.
    const link = isRaidBoss(boss) ? {
        minionBossTemplateId: Number(boss.fetchSelfId?.() || 0),
        minionBossObjectId: Number(boss.fetchId?.() || 0),
        minionGroup: group
    } : { minionLeader: boss, minionGroup: group };
    const minion = SpawnNpcs.spawnChildNpc(world, template, minionCoords(boss), link);
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
    if (!isRaidBoss(boss) && boss.spawnDefinition) {
        const previous = leaderBySpawnDefinition.get(boss.spawnDefinition);
        if (previous && previous !== boss) removeMinions(world, previous);
        leaderBySpawnDefinition.set(boss.spawnDefinition, boss);
    }

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
    if (!boss || !attacker || !bossAlive(boss) || attacker.isDead?.() === true) return 0;
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
    if (DiagnosticConfig.developerDiagnostics && alerted > 0 && isRaidBoss(boss)) {
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
    return minion?.minionLeader || RaidEntityIndex.bossFor(world, minion);
}

// Lisvus TARGET_CLAN of a minion: its leader and the leader's live minions.
function leaderGroup(world, leader) {
    const members = [leader];
    leader?.minionState?.groups?.forEach((group) => members.push(...aliveMinions(world, group)));
    return members;
}

// C4/Lisvus treats a minion hit as an attack on the raid group. The leader
// joins the fight first, then calls every other idle minion to the attacker.
// Keep the native guard: an already engaged leader does not retarget its
// existing encounter just because a second minion was hit.
function onMinionAttacked(world, minion, attacker, sourceSession) {
    if (!minion || !attacker || minion.state?.fetchDead?.() === true || attacker.isDead?.() === true) return 0;

    const boss = bossForMinion(world, minion);
    if (!boss || !bossAlive(boss) || boss.state?.fetchCombats?.() === true) return 0;

    const session = sourceSession || {
        dataSendToMeAndOthers() {},
        dataSendToMe() {}
    };
    boss.enterCombatState?.(session, attacker);
    if (boss.state?.fetchCombats?.() !== true) return 0;
    return onBossAttacked(world, boss, attacker, session);
}

// A group that lost a minion waits one respawn delay from the first loss.
function markShort(boss, group) {
    if (!boss?.minionState || !group) return false;
    if (!group.respawnAt) group.respawnAt = Date.now() + MINION_RESPAWN_DELAY_MS;
    refillDue.set(group, boss);
    armRefill();
    return true;
}

function onMinionDeath(world, minion) {
    return markShort(RaidEntityIndex.bossFor(world, minion), minion?.minionGroup);
}

// Every removal of a live raid minion (despawn, cleanup) passes
// RaidEntityIndex.remove: the group is short whether or not a death announced
// it. A corpse swept from the spawn list without that call (SpoilSweep) had its
// death announce the group already. A boss that dropped its state (its death,
// a leader's replacement) takes no refill.
RaidEntityIndex.onMinionRemoved((minion, boss) => {
    const group = minion.minionGroup;
    const announced = refillDue.has(group);
    if (markShort(boss, group) && !announced) {
        DiagnosticConfig.developerDiagnostics && (telemetry.removalFeeds += 1);
    }
});

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

// A raid boss's death and an ordinary leader's replacement remove the group.
function removeMinions(world, boss, sourceSession) {
    const state = boss?.minionState;
    if (!state) return 0;
    // Detached first: the removals below must not mark the groups short.
    boss.minionState = null;
    let removed = 0;
    state.groups.forEach((group) => {
        group.members.forEach((minion) => {
            if (cleanupMinion(world, minion, sourceSession)) removed++;
        });
        group.members = [];
    });
    return removed;
}

function stats() {
    if (!DiagnosticConfig.developerDiagnostics) return { enabled: false };
    return { ...telemetry };
}

// One group of a live boss: refill it when its respawn time came. Returns the
// minions spawned; leaves the group in refillDue while it waits.
function maintainGroup(world, boss, group, now) {
    const alive = aliveMinions(world, group).length;
    if (alive >= group.desired) {
        group.respawnAt = 0;
        refillDue.delete(group);
        return 0;
    }
    if (!group.respawnAt) group.respawnAt = now + MINION_RESPAWN_DELAY_MS;
    if (now < group.respawnAt) return 0;
    const before = group.members.length;
    fillGroup(world, boss, group);
    group.respawnAt = 0;
    // A spawn that failed keeps the group due and starts its next wait.
    if (aliveMinions(world, group).length >= group.desired) refillDue.delete(group);
    else group.respawnAt = now + MINION_RESPAWN_DELAY_MS;
    const spawned = Math.max(0, group.members.length - before);
    DiagnosticConfig.developerDiagnostics && spawned > 0 && (telemetry.refills += 1);
    return spawned;
}

function maintain(world, now = Date.now()) {
    if (!world?.npc?.spawns) return 0;
    let spawned = 0;
    for (const [group, boss] of refillDue) {
        // A boss that died, left the world or lost the group drops it: its
        // death removed the minions, and its return attaches a fresh group.
        if (!bossAlive(boss) || !liveNpc(world, boss) || boss.minionState?.groups?.includes(group) !== true) {
            refillDue.delete(group);
            continue;
        }
        DiagnosticConfig.developerDiagnostics && (telemetry.groupVisits += 1);
        spawned += maintainGroup(world, boss, group, now);
    }
    armRefill();
    return spawned;
}

// Sleeps until the nearest respawnAt of a short group. Called wherever that
// can move: a group marked short, the end of a refill pass, start. A short
// group is a refill wait, so no group short means no timer.
function armRefill() {
    if (!alarm.world) return;
    let dueAt = Infinity;
    for (const group of refillDue.keys()) dueAt = Math.min(dueAt, group.respawnAt || 0);
    if (dueAt === Infinity) {
        clearTimeout(alarm.timer);
        alarm.timer = null;
        alarm.at = 0;
        return;
    }
    if (alarm.timer && alarm.at <= dueAt) return;
    clearTimeout(alarm.timer);
    alarm.at = dueAt;
    alarm.timer = setTimeout(onRefillAlarm, Math.max(1, dueAt - Date.now()));
    alarm.timer.unref?.();
}

function onRefillAlarm() {
    alarm.timer = null;
    alarm.at = 0;
    const spawned = maintain(alarm.world);
    DiagnosticConfig.developerDiagnostics && Diagnostics.count('raid_minions', spawned > 0 ? 'wake' : 'empty', 'refill');
}

function start(world) {
    stop(alarm.world);
    if (!world?.npc) return null;
    alarm.world = world;
    armRefill();
    return alarm;
}

function stop(world) {
    if (!world || alarm.world !== world) return;
    clearTimeout(alarm.timer);
    alarm.world = null;
    alarm.timer = null;
    alarm.at = 0;
}

module.exports = {
    MINION_RESPAWN_DELAY_MS,
    attachBoss,
    catalogueMinions,
    onBossAttacked,
    onMinionAttacked,
    onMinionDeath,
    onBossDeath: removeMinions,
    removeMinions,
    leaderGroup,
    maintain,
    start,
    stop,
    stats,
    groupsByBoss
};
