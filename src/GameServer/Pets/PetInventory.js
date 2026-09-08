const Rules = require('./PetRules');
const { gear } = require('../../../data/Pets/c4-gear.json');
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const Item = invoke('GameServer/Item/Item');
const Response = invoke('GameServer/Network/Response');
function runtime() { return invoke('GameServer/Pets/PetRuntime'); }
function items(pet) {
    return (pet.petData?.inventory || []).map(row => {
        let result;
        DataCache.fetchItemFromSelfId(row.selfId, template => { result = new Item(row.id, { ...utils.crushOb(template), ...row }); });
        return result;
    }).filter(Boolean);
}
function equipmentStats(pet) {
    const result = { pAtk: 0, mAtk: 0, pDef: 0, mDef: 0 };
    for (const item of pet.petData.inventory) {
        const entry = gear[item.selfId];
        if (!item.equipped || !entry || !compatible(pet, entry)) continue;
        for (const stat of Object.keys(result)) result[stat] += entry.stats[stat] || 0;
        if (entry.slot === 'weapon') {
            result.atkSpd = entry.stats.pAtkSpd;
            result.critical = entry.stats.rCrit;
        }
    }
    return result;
}
function compatible(pet, entry) {
    const type = Rules.typeForNpc(pet.fetchSelfId());
    return !type?.ownerShare && entry.category === type?.category;
}
function publish(pet) { pet.ownerSession?.dataSendToMe?.(Response.petItemList(items(pet))); }
function queue(pet, work) {
    const task = (pet.inventoryTail || Promise.resolve()).catch(() => {}).then(work);
    pet.inventoryTail = task.catch(() => {});
    return task;
}
function active(session) {
    const pet = session.actor?.pet;
    if (!pet?.petData || pet.evolving || pet.ownerTeleport || pet.petData.dead || pet.petData.expired || session.actor.isDead?.() || session.actor.mounted || session.actor.fetchMounted?.()) return null;
    if (session.activeTrade || session.trade || session.botTrade || session.actor.fetchPrivateStoreType?.() || session.actor.fetchStoreType?.()) return null;
    return pet;
}
async function apply(pet, command) {
    const session = pet.ownerSession;
    const actor = session?.actor;
    if (!actor || actor.pet !== pet || pet.petData.dead || pet.petData.expired) throw new Error('Pet inventory unavailable');
    if (session.persistenceMode === 'ephemeral') throw new Error('Pet inventory is unavailable in ephemeral encounters');
    await runtime().persist(pet);
    const result = await Database.transferPetInventory(actor.fetchId(), pet.fetchPetControlItemObjectId(), command);
    pet.petData.inventory = result.inventory;
    const row = result.playerItem;
    if (row) {
        const existing = actor.backpack.fetchItemRaw(row.id);
        if (!row.amount) actor.backpack.items = actor.backpack.items.filter(item => item.fetchId() !== row.id);
        else if (existing) existing.setAmount(row.amount);
        else actor.backpack.insertItem(row.id, row.selfId, row);
    }
    actor.backpack.fetchItemRaw(pet.fetchPetControlItemObjectId())?.setPetData(runtime().snapshot(pet));
    runtime().applyStats(pet);
    pet.setHp(Math.min(pet.fetchHp(), pet.fetchMaxHp()));
    publish(pet);
    session.dataSendToMe?.(Response.itemsList(actor.backpack.fetchItems()));
    runtime().publish(pet);
    return result;
}
function transfer(session, itemId, amount, direction) {
    const pet = active(session);
    if (!pet) return Promise.reject(new Error('No active pet'));
    return queue(pet, async () => {
        if (active(session) !== pet) throw new Error('Pet changed');
        const item = direction === 'deposit' ? session.actor.backpack.fetchItemRaw(itemId) : items(pet).find(item => item.fetchId() === itemId);
        if (!item || !Number.isSafeInteger(amount) || amount < 1 || amount > item.fetchAmount() || (!item.fetchStackable() && amount !== 1)) throw new Error('Invalid item transfer');
        if (item.fetchKind().includes('Quest') || Rules.TYPES[item.fetchSelfId()] || item.fetchEquipped()) throw new Error('Item cannot be transferred');
        if (direction === 'deposit' && items(pet).reduce((sum, entry) => sum + entry.fetchMass() * entry.fetchAmount(), 0) + item.fetchMass() * amount > Rules.POLICY.inventoryWeight) throw new Error('Pet weight limit');
        return apply(pet, { direction, itemId, amount, stackable: item.fetchStackable() });
    });
}
function foodValue(itemId) {
    const itemSkill = invoke('GameServer/Items/C4ItemSkills').resolve(itemId);
    if (!itemSkill) return 0;
    const template = DataCache.skills.find(skill => skill.selfId === itemSkill.skillId);
    if (!template) return 0;
    const Skill = invoke('GameServer/Model/Skill');
    return Number(new Skill({ ...utils.crushOb(template), ...template.levels[0] }).fetchSemantic().feed) || 0;
}
async function consumeFood(pet, item) {
    const feed = foodValue(item.fetchSelfId());
    if (feed <= 0) throw new Error('Unknown pet food');
    await apply(pet, { direction: 'consume', itemId: item.fetchId(), amount: 1 });
    pet.setCurrentFeed(pet.fetchCurrentFeed() + feed);
    await runtime().persist(pet);
    pet.ownerSession.dataSendToMe?.(Response.consoleText(1527, [{ kind: 3, value: item.fetchSelfId() }]));
    runtime().publish(pet);
}
function use(session, itemId) {
    const pet = active(session);
    if (!pet) return Promise.reject(new Error('No active pet'));
    return queue(pet, async () => {
        if (active(session) !== pet) throw new Error('Pet changed');
        const item = items(pet).find(item => item.fetchId() === itemId);
        if (!item) throw new Error('Pet item missing');
        if (Rules.typeForNpc(pet.fetchSelfId()).food.includes(item.fetchSelfId())) return consumeFood(pet, item);
        const entry = gear[item.fetchSelfId()];
        if (!entry || !compatible(pet, entry)) throw new Error('Incompatible pet equipment');
        return apply(pet, { direction: 'equip', itemId, amount: 1, equipped: !item.fetchEquipped(),
            equipIds: Object.keys(gear).filter(id => gear[id].slot === entry.slot).map(Number) });
    });
}
function autoFeed(pet) {
    return queue(pet, async () => {
        if (pet.ownerSession?.actor?.pet !== pet || pet.petData.dead || pet.petData.expired) return;
        const ids = Rules.typeForNpc(pet.fetchSelfId()).food;
        const available = items(pet);
        const food = ids.map(id => available.find(item => item.fetchSelfId() === id)).find(Boolean);
        if (food) await consumeFood(pet, food);
    });
}
function autoFeedMounted(pet) {
    return queue(pet, async () => {
        const actor = pet.ownerSession?.actor;
        if (!actor || actor.pet !== pet || !(actor.fetchMounted?.() || actor.mounted)) return;
        const food = Rules.typeForNpc(pet.fetchSelfId()).food.map(id=>actor.backpack.fetchItemFromSelfId(id)).find(Boolean);
        if (!food || pet.ownerSession.persistenceMode === 'ephemeral') return;
        await runtime().persist(pet);
        const result = await Database.feedMountedPet(actor.fetchId(),pet.fetchPetControlItemObjectId(),food.fetchId(),foodValue(food.fetchSelfId()));
        if (result.remaining) food.setAmount(result.remaining);
        else actor.backpack.items = actor.backpack.items.filter(item=>item!==food);
        pet.setCurrentFeed(result.currentFeed);
        pet.ownerSession.dataSendToMe(Response.itemsList(actor.backpack.fetchItems()));
    });
}
function rename(session, name) {
    const pet = active(session);
    if (!pet || pet.petData.name || !/^[A-Za-z0-9]{2,16}$/.test(name)) return Promise.reject(new Error('Invalid pet name'));
    pet.petData.name = name;
    pet.model.name = name;
    runtime().publish(pet);
    return runtime().persist(pet);
}
module.exports = { items, equipmentStats, compatible, publish, active, transfer, use, autoFeed, autoFeedMounted, rename, foodValue, gear };
