const telemetry = {
    rebuilds: 0,
    objectsScanned: 0,
    lookups: 0,
    adds: 0,
    removes: 0
};

function positiveId(value) {
    const id = Number(value);
    return Number.isInteger(id) && id > 0 ? id : null;
}

function objectId(actor) {
    return positiveId(actor?.fetchId?.());
}

function templateId(actor) {
    return positiveId(
        actor?.fetchSelfId?.()
        ?? actor?.fetchTemplateId?.()
        ?? actor?.selfId
        ?? actor?.model?.selfId
    );
}

function isRaidBoss(actor) {
    return actor?.fetchIsRaidBoss?.() === true
        || actor?.model?.raidBoss === true
        || actor?.template?.raidBoss === true;
}

function addToSetMap(map, key, value) {
    if (!key) return;
    const values = map.get(key) || new Set();
    values.add(value);
    map.set(key, values);
}

function removeFromSetMap(map, key, value) {
    if (!key) return;
    const values = map.get(key);
    if (!values) return;
    values.delete(value);
    if (values.size === 0) map.delete(key);
}

function createState(spawns) {
    return {
        source: spawns,
        indexedCount: 0,
        tracked: new WeakSet(),
        membership: new WeakMap(),
        bossesByObjectId: new Map(),
        bossesByTemplateId: new Map(),
        minionsByBossObjectId: new Map(),
        minionsByBossTemplateId: new Map()
    };
}

function reset(world) {
    if (!world?.npc) return null;
    const spawns = Array.isArray(world.npc.spawns) ? world.npc.spawns : [];
    const state = createState(spawns);
    world.npc.raidEntityIndex = state;
    return state;
}

function removeMembership(state, npc, membership) {
    if (!membership) return;
    if (membership.raidBoss) {
        if (state.bossesByObjectId.get(membership.objectId) === npc) {
            state.bossesByObjectId.delete(membership.objectId);
        }
        removeFromSetMap(state.bossesByTemplateId, membership.templateId, npc);
    }
    if (membership.raidMinion) {
        removeFromSetMap(state.minionsByBossObjectId, membership.bossObjectId, npc);
        removeFromSetMap(state.minionsByBossTemplateId, membership.bossTemplateId, npc);
    }
    state.membership.delete(npc);
}

function indexObject(state, npc, { count = true } = {}) {
    if (!npc || (typeof npc !== 'object' && typeof npc !== 'function')) return false;
    const alreadyTracked = state.tracked.has(npc);
    removeMembership(state, npc, state.membership.get(npc));

    const raidBoss = isRaidBoss(npc);
    const bossObjectId = positiveId(npc.minionBossObjectId);
    const bossTemplateId = positiveId(npc.minionBossTemplateId);
    const raidMinion = !!(bossObjectId || bossTemplateId);
    const membership = {
        raidBoss,
        raidMinion,
        objectId: objectId(npc),
        templateId: templateId(npc),
        bossObjectId,
        bossTemplateId
    };

    if (raidBoss && membership.objectId) {
        state.bossesByObjectId.set(membership.objectId, npc);
        addToSetMap(state.bossesByTemplateId, membership.templateId, npc);
    }
    if (raidMinion) {
        addToSetMap(state.minionsByBossObjectId, bossObjectId, npc);
        addToSetMap(state.minionsByBossTemplateId, bossTemplateId, npc);
    }
    if (raidBoss || raidMinion) state.membership.set(npc, membership);

    if (!alreadyTracked) {
        state.tracked.add(npc);
        if (count) state.indexedCount += 1;
    }
    return true;
}

function rebuild(world) {
    const state = reset(world);
    if (!state) return null;
    const spawns = state.source;
    spawns.forEach((npc) => indexObject(state, npc));
    telemetry.rebuilds += 1;
    telemetry.objectsScanned += spawns.length;
    return state;
}

function ensure(world) {
    if (!world?.npc) return null;
    const spawns = Array.isArray(world.npc.spawns) ? world.npc.spawns : [];
    const state = world.npc.raidEntityIndex;
    if (!state || state.source !== spawns || state.indexedCount !== spawns.length) {
        return rebuild(world);
    }
    return state;
}

function add(world, npc) {
    if (!world?.npc || !npc) return false;
    let state = world.npc.raidEntityIndex;
    if (!state || state.source !== world.npc.spawns) state = rebuild(world);
    if (!state) return false;
    const wasTracked = state.tracked.has(npc);
    indexObject(state, npc);
    if (!wasTracked) telemetry.adds += 1;
    return true;
}

function remove(world, npc) {
    if (!world?.npc || !npc) return false;
    let state = world.npc.raidEntityIndex;
    if (!state || state.source !== world.npc.spawns) state = rebuild(world);
    if (!state || !state.tracked.has(npc)) return false;
    removeMembership(state, npc, state.membership.get(npc));
    state.tracked.delete(npc);
    state.indexedCount = Math.max(0, state.indexedCount - 1);
    telemetry.removes += 1;
    return true;
}

function bossByObjectId(world, id) {
    telemetry.lookups += 1;
    return ensure(world)?.bossesByObjectId.get(positiveId(id)) || null;
}

function bossByTemplateId(world, id) {
    telemetry.lookups += 1;
    const bosses = ensure(world)?.bossesByTemplateId.get(positiveId(id));
    return bosses?.values().next().value || null;
}

function bossFor(world, target) {
    if (!target) return null;
    if (isRaidBoss(target)) return target;
    telemetry.lookups += 1;
    const state = ensure(world);
    if (!state) return null;
    const bossObjectId = positiveId(target.minionBossObjectId);
    const bossTemplateId = positiveId(target.minionBossTemplateId);
    return (bossObjectId && state.bossesByObjectId.get(bossObjectId))
        || (bossTemplateId && state.bossesByTemplateId.get(bossTemplateId)?.values().next().value)
        || null;
}

function entitiesForRaid(world, raid) {
    telemetry.lookups += 1;
    const state = ensure(world);
    if (!state || !raid) return [];
    const bossObjectId = positiveId(raid.bossId);
    const bossTemplateId = positiveId(raid.bossTemplateId);
    const boss = (bossObjectId && state.bossesByObjectId.get(bossObjectId))
        || (bossTemplateId && state.bossesByTemplateId.get(bossTemplateId)?.values().next().value)
        || null;
    // This preserves the old behavior: orphan minions do not form a raid by
    // themselves after their authoritative boss object has left the world.
    if (!boss) return [];

    const entities = new Set([boss]);
    const resolvedObjectId = objectId(boss);
    const resolvedTemplateId = templateId(boss);
    state.minionsByBossObjectId.get(resolvedObjectId)?.forEach((npc) => entities.add(npc));
    state.minionsByBossTemplateId.get(resolvedTemplateId)?.forEach((npc) => entities.add(npc));
    return [...entities];
}

function bosses(world) {
    telemetry.lookups += 1;
    return [...(ensure(world)?.bossesByObjectId.values() || [])];
}

function has(world, npc) {
    return ensure(world)?.tracked.has(npc) === true;
}

function stats(world) {
    const state = ensure(world);
    const minions = new Set();
    state?.minionsByBossObjectId.forEach((values) => values.forEach((npc) => minions.add(npc)));
    state?.minionsByBossTemplateId.forEach((values) => values.forEach((npc) => minions.add(npc)));
    return {
        ...telemetry,
        bosses: state?.bossesByObjectId.size || 0,
        minions: minions.size,
        indexed: state?.indexedCount || 0
    };
}

function resetStatsForTests() {
    Object.keys(telemetry).forEach((key) => { telemetry[key] = 0; });
}

module.exports = {
    reset,
    rebuild,
    ensure,
    add,
    remove,
    bossByObjectId,
    bossByTemplateId,
    bossFor,
    entitiesForRaid,
    bosses,
    has,
    stats,
    resetStatsForTests
};
