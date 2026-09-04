'use strict';

// Maintained by the world's spawn/grid lifecycle, plus legacy direct removals
// (Sweep and summon death). Whole-world replacement uses indexSpawnsInGrid;
// normal corpse batches can replace the array after removing each member.
// Object IDs are immutable for the lifetime of an NPC. Keep the actual actor,
// not a combat snapshot: HP, target and death checks still read live state.
const indexes = new WeakMap();

function reset(world) {
    if (!world?.npc) return;
    indexes.set(world.npc, { byId: new Map(), ids: new WeakMap() });
}

function add(world, npc) {
    const index = indexes.get(world?.npc);
    if (!index || !npc?.fetchId) return;
    const id = npc.fetchId();
    index.byId.set(id, npc);
    index.ids.set(npc, id);
}

function remove(world, npc) {
    const index = indexes.get(world?.npc);
    if (!index || !npc || !index.ids.has(npc)) return;
    const id = index.ids.get(npc);
    // A delayed corpse cleanup must not evict a replacement object.
    if (index.byId.get(id) === npc) index.byId.delete(id);
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

module.exports = { reset, add, remove, find };
