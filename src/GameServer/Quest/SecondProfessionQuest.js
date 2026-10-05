// C4 second-profession trials share transactional hand-ins and personal spawns.
const Step = require('./QuestStep');
const World = invoke('GameServer/World/World');
const DataCache = invoke('GameServer/DataCache');
const NpcIndex = invoke('GameServer/World/NpcObjectIndex');

const count = (state, id) => state.session.actor.backpack.fetchItems()
    .filter(item => item.fetchSelfId() === id && (!item.fetchEquipped() || state.quest.equippedQuestItems?.includes(id)))
    .reduce((sum, item) => sum + item.fetchAmount(), 0);
const has = (state, takes) => takes.every(([id, amount]) => count(state, id) >= amount);
const link = (id, event, label) => `<a action="bypass -h quest ${id} ${event}">${label}</a>`;
const page = (state, text, action = '') => `<html><body>${state.quest.name}:<br><br>${text}<br><br>${action}</body></html>`;
const itemName = id => DataCache.items.find(item => item.selfId === id)?.template.name || String(id);
const npcName = id => DataCache.npcs.find(npc => npc.selfId === id)?.template.name || String(id);

async function step(state, cond, options = {}) {
    const accepting = !state.isStarted() && !state.isCompleted();
    const result = await Step.apply(state, { ...options,
        variables: { ...state.variables, ...options.variables, cond: String(cond) } });
    state.playSound(options.status === 'completed' ? 'ItemSound.quest_finish'
        : accepting ? 'ItemSound.quest_accept' : 'ItemSound.quest_middle');
    return result;
}

function personalSpawns(state, selfId) {
    return (World.npc?.spawns || []).filter(npc =>
        npc.questSpawn?.ownerId === state.session.actor.fetchId()
        && npc.questSpawn?.questId === state.quest.id
        && (!selfId || npc.fetchSelfId() === selfId));
}

function owns(state, npc) {
    // A queued kill may outlive corpse decay; its server-owned actor still
    // carries provenance. Client talk snapshots cannot supply this metadata.
    const actual = NpcIndex.find(World, npc.fetchId()) || (npc.questSpawn ? npc : null);
    return actual?.questSpawn?.ownerId === state.session.actor.fetchId()
        && actual.questSpawn.questId === state.quest.id && actual.fetchSelfId() === npc.fetchSelfId();
}

function clearSpawns(state, selfId) {
    for (const npc of personalSpawns(state, selfId)) {
        state.removeRadar(npc.fetchLocX(), npc.fetchLocY(), npc.fetchLocZ());
        World.despawnQuestNpc(npc, state.session);
    }
}

function clearRadars(state) {
    for (const coords of state.quest.radarPoints || []) state.removeRadar(...coords);
    if (state.get('encounter')) state.removeRadar(...JSON.parse(state.get('encounter')));
}

function spawn(state, id, coords, despawnDelay = 600000) {
    const existing = personalSpawns(state, id).find(npc => !npc.isDead());
    if (existing) {
        state.addRadar(existing.fetchLocX(), existing.fetchLocY(), existing.fetchLocZ());
        return existing;
    }
    clearSpawns(state, id);
    const [locX, locY, locZ] = coords;
    const npc = state.addSpawn(id, { locX, locY, locZ, despawnDelay });
    npc?.questSpawn?.timer?.unref?.();
    state.addRadar(locX, locY, locZ);
    return npc;
}

// Multiple opponents of the same template belong to one personal encounter.
// Reopening its dialogue fills only the missing, unfinished opponents.
function spawnGroup(state, id, positions, remaining) {
    const all = personalSpawns(state, id);
    const alive = all.filter(npc => !npc.isDead());
    for (const npc of all.filter(npc => npc.isDead())) {
        state.removeRadar(npc.fetchLocX(), npc.fetchLocY(), npc.fetchLocZ());
        World.despawnQuestNpc(npc, state.session);
    }
    const needed = Math.min(positions.length, Math.max(0, remaining));
    const vacant = positions.filter(([x, y, z]) => !alive.some(npc =>
        npc.fetchLocX() === x && npc.fetchLocY() === y && npc.fetchLocZ() === z));
    for (const [locX, locY, locZ] of vacant) {
        if (alive.length >= needed) break;
        const npc = state.addSpawn(id, { locX, locY, locZ, despawnDelay: 600000 });
        npc?.questSpawn?.timer?.unref?.();
        if (npc) alive.push(npc);
    }
    for (const npc of alive) state.addRadar(npc.fetchLocX(), npc.fetchLocY(), npc.fetchLocZ());
    return alive;
}

function coords(npc, fallback) {
    const values = [npc.fetchLocX?.(), npc.fetchLocY?.(), npc.fetchLocZ?.()].map(Number);
    return values.every(Number.isFinite) ? values : fallback;
}

async function abort(state) {
    const encounter = state.get('encounter');
    await Step.apply(state, { status: 'created', variables: {},
        removeRecipes: state.quest.questRecipes || [],
        takes: state.quest.questItems.map(id => [id, count(state, id)]) });
    clearSpawns(state);
    for (const coords of state.quest.radarPoints || []) state.removeRadar(...coords);
    if (encounter) state.removeRadar(...JSON.parse(encounter));
}

module.exports = { count, has, link, page, step, owns, spawn, spawnGroup, clearSpawns, clearRadars, coords,
    personalSpawns, itemName, npcName, abort };
