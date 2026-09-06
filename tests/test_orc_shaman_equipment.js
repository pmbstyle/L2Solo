const assert = require('assert');
require('../src/Global');
const DataCache = invoke('GameServer/DataCache');
DataCache.init();
const BotGear = invoke('GameServer/Bot/AI/BotGear');
const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const Upgrade = invoke('GameServer/Bot/AI/BotEquipmentUpgrade');
const Item = invoke('GameServer/Item/Item');
const Hints = invoke('GameServer/Bot/AI/GearSkillHints');
const byId = (id) => DataCache.items.find((item) => Number(item.selfId) === id);
const bone = byId(178);
const handAxe = DataCache.items.find((item) => item.template?.name === 'Hand Axe');
const state = { level: 28, adena: 1000000, stats: { classId: 50, role: 'buffer' } };

for (const level of [20, 28, 39]) {
    const plan = BotGear.planFor({ classId: 50, level });
    const weapon = byId(plan.items.find((item) => [7, 14].includes(item.slot)).selfId);
    assert.strictEqual(plan.role, 'buffer');
    assert.strictEqual(plan.style, 'heavy');
    assert.strictEqual(weapon.etc.slot, 7);
    assert.strictEqual(weapon.template.kind, 'Weapon.Blunt');
    assert(weapon.stats.pAtk > weapon.stats.mAtk);
    assert(plan.items.some((item) => item.slot === 8));
}
assert(!Planner.suitable(bone, state, 'buffer'));
assert(Planner.suitable(handAxe, state, 'buffer'));
assert(Planner.isSlotUpgrade(handAxe, [bone], 'buffer', 50),
    'a staff must not block physical weapon acquisition');

const owned = (item, equipped = false) => ({
    selfId: item.selfId, amount: 1, slot: item.etc.slot, equipped,
    equippedSlots: equipped ? [item.etc.slot] : [], equippedCount: equipped ? 1 : 0
});
state.inventory = { [bone.selfId]: owned(bone, true) };
assert(!Planner.staticNpcKitAdequate(state));
const shop = Planner.staticNpcUpgradePlan(state, {
    findMarketOffer: (item) => item.selfId === handAxe.selfId
        ? { sourceType: 'npc', town: 'Gludin', price: handAxe.template.price } : null
});
assert.strictEqual(shop?.target?.selfId, handAxe.selfId,
    'existing D staff must trigger a compatible NPC replacement');

const shield = DataCache.items.find((item) => item.template?.kind === 'Armor.Shield' && item.etc.rank === 'd');
const inventory = { ...state.inventory, [handAxe.selfId]: owned(handAxe), [shield.selfId]: owned(shield) };
let reconciled = Planner.equipInventoryUpgrades({ ...state, inventory }, inventory);
assert.strictEqual(reconciled[bone.selfId].equipped, false);
assert.strictEqual(reconciled[bone.selfId].amount, 1, 'replacement must preserve the old item');
assert.strictEqual(reconciled[handAxe.selfId].equipped, true);
// Once the two-handed weapon is replaced, the next normal refresh can equip a shield.
reconciled = Planner.equipInventoryUpgrades({ ...state, inventory: reconciled }, reconciled);
assert.strictEqual(reconciled[shield.selfId].equipped, true);

const oldStaff = new Item(901, { selfId: 178, name: 'Bone Staff', kind: 'Weapon.Blunt',
    price: 409000, rank: 'd', slot: 14, pAtk: 39, mAtk: 35, equipped: true });
const replacement = new Item(902, { selfId: handAxe.selfId, name: 'Hand Axe', kind: 'Weapon.Blunt',
    price: handAxe.template.price, rank: 'd', slot: 7, pAtk: handAxe.stats.pAtk, mAtk: handAxe.stats.mAtk });
const robe = new Item(903, { name: 'Cursed Tunic', kind: 'Armor.Fabric',
    price: 62600, rank: 'd', slot: 10, pDef: 39, maxMp: 106, equipped: true });
const heavy = new Item(904, { name: 'Heavy chest', kind: 'Armor.Chain',
    price: 100000, rank: 'd', slot: 10, pDef: 50 });
const items = [oldStaff, replacement, robe, heavy];
const actor = {
    fetchClassId: () => 50, fetchLevel: () => 28,
    backpack: {
        fetchItems: () => items,
        fetchEquippedWeapon: () => oldStaff,
        fetchPaperdollId: (slot) => slot === 10 ? 903 : undefined,
        fetchItemRaw: (id) => items.find((item) => item.fetchId() === id)
    }
};
const upgrades = Upgrade.findBestUpgrades({ actor });
assert(upgrades.some(({ item }) => item === replacement), 'hot shaman must replace its staff');
assert(upgrades.some(({ item }) => item === heavy), 'robe bonus MP must not block heavy armor');
const fullRobe = new Item(905, { name: 'Full robe', kind: 'Armor.Fabric',
    price: 100000, rank: 'd', slot: 15, pDef: 90, maxMp: 150, equipped: true });
items.splice(items.indexOf(robe), 1, fullRobe);
actor.backpack.fetchPaperdollId = (slot) => [10, 15].includes(slot) ? 905 : undefined;
assert(!Upgrade.findBestUpgrades({ actor }).some(({ item }) => item === heavy),
    'an incomplete heavy layout must not strip an existing full-body robe');
const hint = Hints.forCharacter({ classId: 50, level: 28 });
assert.strictEqual(hint.weapon, 'one_handed_blunt');
assert.strictEqual(hint.armor, 'heavy');
assert(hint.consumables.includes('soulshots'));
assert(!hint.skills.some((skill) => skill.name === 'Heal'), 'shaman hints must use its actual skill family');
console.log('Orc Shaman equipment and replacement checks passed');
