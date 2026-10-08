'use strict';

// Maintained by the world's spawn/grid lifecycle, plus legacy direct removals
// (Sweep and summon death). Whole-world replacement uses indexSpawnsInGrid;
// normal corpse batches can replace the array after removing each member.
// Object IDs are immutable for the lifetime of an NPC. Keep the actual actor,
// not a combat snapshot: HP, target and death checks still read live state.
const indexes = new WeakMap();

function reset(world) {
    if (!world?.npc) return;
    indexes.set(world.npc, { byId: new Map(), byTemplate: new Map(), ids: new WeakMap() });
}

function add(world, npc) {
    const index = indexes.get(world?.npc);
    if (!index || !npc?.fetchId) return;
    const id = npc.fetchId();
    if (index.ids.has(npc)) return;
    const previous = index.byId.get(id);
    if (previous && previous !== npc) remove(world, previous);
    index.byId.set(id, npc);
    const selfId = npc.fetchSelfId?.();
    index.ids.set(npc, { id, selfId });
    if (selfId) {
        if (!index.byTemplate.has(selfId)) index.byTemplate.set(selfId, new Set());
        index.byTemplate.get(selfId).add(npc);
    }
}

function remove(world, npc) {
    const index = indexes.get(world?.npc);
    if (!index || !npc || !index.ids.has(npc)) return;
    const { id, selfId } = index.ids.get(npc);
    // A delayed corpse cleanup must not evict a replacement object.
    if (index.byId.get(id) === npc) index.byId.delete(id);
    const group = index.byTemplate.get(selfId);
    group?.delete(npc);
    if (group?.size === 0) index.byTemplate.delete(selfId);
    index.ids.delete(npc);
}

function find(world, id) {
    if (id === null || id === undefined) return null;
    const index = indexes.get(world?.npc);
    if (index) return index.byId.get(id) || null;
    // Lightweight worlds which do not run the grid lifecycle retain the
    // original lookup. Never rebuild or scan on a live indexed cache miss.
    return (world?.npc?.spawns || []).find((npc) => npc?.fetchId?.() === id) || null;
}

function nearTemplate(world, selfId, locX, locY, radius) {
    const index = indexes.get(world?.npc);
    const candidates = index ? index.byTemplate.get(selfId) || [] : world?.npc?.spawns || [];
    for (const npc of candidates) if (npc.fetchSelfId?.() === selfId
        && Math.hypot(npc.fetchLocX() - locX, npc.fetchLocY() - locY) <= radius) return npc;
    return null;
}

module.exports = { reset, add, remove, find, nearTemplate };
