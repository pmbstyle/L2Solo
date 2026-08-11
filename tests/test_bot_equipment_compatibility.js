const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
DataCache.init();

const ClassProgression = invoke('GameServer/ClassProgression');
const BotEquipmentCompatibility = invoke('GameServer/Bot/AI/BotEquipmentCompatibility');
const BotGear = invoke('GameServer/Bot/AI/BotGear');
const BotRoles = invoke('GameServer/Bot/AI/BotRoles');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');

function plannedItem(plan, slots) {
    const entry = plan.items.find((item) => slots.includes(Number(item.slot)));
    return entry && DataCache.items.find((item) => Number(item.selfId) === Number(entry.selfId));
}

const profiles = [
    { classId: 5, role: 'tank', armor: 'heavy', weapon: 'Weapon.Sword', shield: true },
    { classId: 8, role: 'dagger', armor: 'light', weapon: 'Weapon.Knife', shield: false },
    { classId: 9, role: 'archer', armor: 'light', weapon: 'Weapon.Bow', shield: false },
    { classId: 12, role: 'mage', armor: 'robe', weaponKinds: ['Weapon.Etc', 'Weapon.Sword', 'Weapon.Blunt'], shield: false },
    { classId: 2, role: 'dps', armor: 'heavy', weapon: 'Weapon.Dual', shield: false },
    { classId: 3, role: 'dps', armor: 'heavy', weapon: 'Weapon.Pole', shield: false },
    { classId: 21, role: 'buffer', armor: 'heavy', weapon: 'Weapon.Sword', shield: true },
    { classId: 34, role: 'buffer', armor: 'heavy', weapon: 'Weapon.Dual', shield: false },
    { classId: 45, role: 'dps', armor: 'heavy', weapon: 'Weapon.Blunt', shield: true },
    { classId: 46, role: 'dps', armor: 'heavy', weapon: 'Weapon.GreatSword', shield: false },
    { classId: 47, role: 'dps', armor: 'light', weapon: 'Weapon.DualFist', shield: false },
    { classId: 55, role: 'dps', armor: 'heavy', weapon: 'Weapon.Blunt', shield: true },
    { classId: 57, role: 'crafter', armor: 'heavy', weapon: 'Weapon.Blunt', shield: true }
];

profiles.forEach((expected) => {
    const plan = BotGear.planFor({ classId: expected.classId, level: 44 });
    const weapon = plannedItem(plan, [7, 14]);
    const torso = plannedItem(plan, [10, 15]);

    assert.strictEqual(plan.role, expected.role, `class ${expected.classId} role must stay stable`);
    assert.strictEqual(plan.style, expected.armor, `class ${expected.classId} must use ${expected.armor} armor`);
    if (expected.weapon) {
        assert.strictEqual(weapon?.template?.kind, expected.weapon, `class ${expected.classId} must generate its class weapon`);
    } else {
        assert(expected.weaponKinds.includes(weapon?.template?.kind), `class ${expected.classId} must generate a compatible caster weapon`);
    }
    assert.strictEqual(torso?.template?.kind, BotEquipmentCompatibility.armorKindFor(expected.role, expected.classId),
        `class ${expected.classId} torso must match its armor mastery`);
    assert.strictEqual(plan.items.some((item) => Number(item.slot) === 8), expected.shield,
        `class ${expected.classId} shield policy must match its weapon profile`);
});

assert.deepStrictEqual(BotEquipmentCompatibility.preferredWeaponKindsFor('dps', 2), ['Weapon.Dual']);
assert.deepStrictEqual(BotEquipmentCompatibility.weaponKindsFor('dps', 3), ['Weapon.Pole']);
assert.deepStrictEqual(BotEquipmentCompatibility.weaponKindsFor('buffer', 34), ['Weapon.Dual']);
assert.deepStrictEqual(BotEquipmentCompatibility.weaponKindsFor('dps', 46), ['Weapon.GreatSword', 'Weapon.Blunt', 'Weapon.Pole']);
assert.deepStrictEqual(BotEquipmentCompatibility.weaponKindsFor('dps', 55), ['Weapon.Blunt', 'Weapon.Pole']);

const secondClassGroups = [
    { ids: [2], weapons: ['Weapon.Dual', 'Weapon.Sword', 'Weapon.Blunt'], armor: 'heavy', shield: true },
    { ids: [3], weapons: ['Weapon.Pole'], armor: 'heavy', shield: false },
    { ids: [5, 6, 20, 33], weapons: ['Weapon.Sword', 'Weapon.Blunt'], armor: 'heavy', shield: true },
    { ids: [8, 23, 36], weapons: ['Weapon.Knife'], armor: 'light', shield: false },
    { ids: [9, 24, 37], weapons: ['Weapon.Bow'], armor: 'light', shield: false },
    { ids: [12, 13, 14, 16, 17, 27, 28, 30, 40, 41, 43, 51, 52], weapons: ['Weapon.Etc', 'Weapon.Sword', 'Weapon.Blunt'], armor: 'robe', shield: false },
    { ids: [21], weapons: ['Weapon.Sword', 'Weapon.Blunt'], armor: 'heavy', shield: true },
    { ids: [34], weapons: ['Weapon.Dual'], armor: 'heavy', shield: false },
    { ids: [46], weapons: ['Weapon.GreatSword', 'Weapon.Blunt', 'Weapon.Pole'], armor: 'heavy', shield: false },
    { ids: [48], weapons: ['Weapon.Fist', 'Weapon.DualFist'], armor: 'light', shield: false },
    { ids: [55, 57], weapons: ['Weapon.Blunt', 'Weapon.Pole'], armor: 'heavy', shield: true }
];
const coveredSecondClasses = new Set();

secondClassGroups.forEach((group) => group.ids.forEach((classId) => {
    coveredSecondClasses.add(classId);
    const role = BotRoles.inferRole(classId);
    const profile = BotEquipmentCompatibility.profileFor(role, classId);
    assert.deepStrictEqual(profile.weaponKinds, group.weapons, `second class ${classId} weapon families must match its mastery`);
    assert.strictEqual(profile.armorStyle, group.armor, `second class ${classId} armor must match its mastery`);
    assert.strictEqual(profile.shield, group.shield, `second class ${classId} shield policy must match its loadout`);
}));

const allSecondClasses = [...new Set(Object.values(ClassProgression.secondProfMap).flat().map(Number))].sort((left, right) => left - right);
assert.deepStrictEqual([...coveredSecondClasses].sort((left, right) => left - right), allSecondClasses,
    'the equipment matrix must cover every second-profession class');

Object.entries(ClassProgression.thirdClasses).forEach(([classId, thirdClass]) => {
    const thirdRole = BotRoles.inferRole(Number(classId));
    const parentRole = BotRoles.inferRole(thirdClass.parentClassId);
    assert.deepStrictEqual(
        BotEquipmentCompatibility.profileFor(thirdRole, Number(classId)),
        BotEquipmentCompatibility.profileFor(parentRole, thirdClass.parentClassId),
        `${thirdClass.name} must inherit its parent equipment profile`
    );
});

function catalogItem(kind, slot, rank = 'c') {
    return DataCache.items.find((item) => item.template?.kind === kind
        && Number(item.etc?.slot) === Number(slot)
        && String(item.etc?.rank) === rank
        && Number(item.template?.price || 0) > 0);
}

const chainChest = catalogItem('Armor.Chain', 10);
const leatherChest = catalogItem('Armor.Leather', 10);
const fabricChest = catalogItem('Armor.Fabric', 10);
const dualSword = catalogItem('Weapon.Dual', 14);
const pole = catalogItem('Weapon.Pole', 14);
const sword = catalogItem('Weapon.Sword', 7);

assert(GearAcquisitionPlanner.suitable(chainChest, { level: 44, stats: { classId: 21 } }, 'buffer'),
    'Sword Singer acquisition must accept heavy armor');
assert(!GearAcquisitionPlanner.suitable(fabricChest, { level: 44, stats: { classId: 21 } }, 'buffer'),
    'Sword Singer acquisition must reject robes');
assert(GearAcquisitionPlanner.suitable(leatherChest, { level: 44, stats: { classId: 47 } }, 'dps'),
    'Tyrant acquisition must accept light armor');
assert(!GearAcquisitionPlanner.suitable(chainChest, { level: 44, stats: { classId: 47 } }, 'dps'),
    'Tyrant acquisition must reject heavy armor');
assert(GearAcquisitionPlanner.suitable(dualSword, { level: 44, stats: { classId: 34 } }, 'buffer'),
    'Bladedancer acquisition must accept dual swords');
assert(!GearAcquisitionPlanner.suitable(sword, { level: 44, stats: { classId: 34 } }, 'buffer'),
    'Bladedancer acquisition must reject one-handed swords');
assert(GearAcquisitionPlanner.suitable(pole, { level: 44, stats: { classId: 3 } }, 'dps'),
    'Warlord acquisition must accept polearms');
assert(!GearAcquisitionPlanner.suitable(sword, { level: 44, stats: { classId: 3 } }, 'dps'),
    'Warlord acquisition must reject ordinary swords');

console.log('Bot equipment compatibility matrix checks passed');
