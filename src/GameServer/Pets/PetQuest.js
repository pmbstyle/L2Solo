const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const Response = invoke('GameServer/Network/Response');
function count(state, id) { return state.session.actor.backpack.fetchItemFromSelfId(id)?.fetchAmount() || 0; }
async function step(state, variables, takes = [], gives = [], status = 'started') {
    const actor = state.session.actor;
    const next = { state: status, variables: Object.fromEntries(Object.entries(variables).map(([key,value]) => [key,String(value)])) };
    const rewards = gives.map(([selfId, amount]) => {
        const template = DataCache.items.find(item => item.selfId === selfId);
        if (!template) throw new Error(`Missing pet quest item ${selfId}`);
        return {selfId, amount, name: template.template.name, stackable: template.etc.stackable};
    });
    const rows = await Database.applyPetQuestStep(actor.fetchId(), state.quest.id,
        { state: state.state, variables: state.variables }, next, takes.map(([selfId,amount]) => ({selfId,amount})), rewards);
    for (const row of rows) {
        const item = actor.backpack.fetchItemRaw(row.id);
        if (!row.amount) actor.backpack.items = actor.backpack.items.filter(item => item.fetchId() !== row.id);
        else if (item) item.setAmount(row.amount);
        else actor.backpack.insertItem(row.id, row.selfId, row);
    }
    state.state = next.state;
    state.variables = next.variables;
    state.session.dataSendToMe(Response.itemsList(actor.backpack.fetchItems()));
    state.playSound(status === 'created' ? 'ItemSound.quest_finish' : 'ItemSound.quest_itemget');
}
async function evolve(state) {
    const session = state.session, actor = session.actor, pet = actor.pet;
    const id = pet.fetchPetControlItemObjectId();
    const old = actor.backpack.fetchItemRaw(id);
    pet.evolving = true;
    try {
        await pet.inventoryTail;
        invoke('GameServer/Npc/SummonControl').stop(session, pet);
        // Teardown logs save errors; evolution must instead require a durable snapshot.
        await invoke('GameServer/Pets/PetRuntime').persist(pet);
        invoke('GameServer/Npc/SummonControl').unsummon(session, actor, pet);
        await pet.teardownTail;
        old.petInUse = true;
        const row = await Database.evolveHatchling(actor.fetchId(), id);
        actor.backpack.items = actor.backpack.items.filter(item => item.fetchId() !== id);
        actor.backpack.insertItem(id, row.selfId, row);
        state.state = 'created'; state.variables = {};
        session.dataSendToMe(Response.itemsList(actor.backpack.fetchItems()));
        state.playSound('ItemSound.quest_finish');
    } catch (error) {
        pet.evolving = false;
        if (actor.pet !== pet) {
            old.petInUse = false;
            if (session.actor === actor) actor.backpack.spawnPetFromItem(session, { itemObjectId: id, npcId: pet.fetchSelfId() });
        }
        throw error;
    }
}
async function abort(state) {
    const takes = (state.quest.questItems || []).map(id => [id, count(state, id)]).filter(([, amount]) => amount > 0);
    await step(state, {}, takes, [], 'created');
}
module.exports = { count, step, evolve, abort };
