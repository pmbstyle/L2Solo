const assert = require('assert');
require('../src/Global');
const Data = invoke('GameServer/DataCache');
Data.init();
const Gear = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');

// Gladiators and Bladedancers may use only dual swords, which NPCs do not
// sell: the dual-sword bridge combines two D blades (two Sabers, 899.8k each
// at x10). Until they hold one, a weapon their previous profession could use
// counts as usable, so the unfunded dual sword no longer
// freezes the rest of the kit; the dual sword stays their weapon target.
const byName = (name) => Data.items.find((item) => item.template?.name === name);
const broadsword = byName('Broadsword');
const bow = byName('Bow');
const holding = (classId, item, adena) => ({
    characterId: 9500000 + classId, level: 42, adena, stats: { classId, role: 'dps' },
    inventory: {
        [item.selfId]: { selfId: Number(item.selfId), amount: 1, equipped: true, equippedSlots: [Number(item.etc.slot)], slot: Number(item.etc.slot) },
        57: { selfId: 57, amount: adena }
    }
});
const spendable = (state) => state.adena - Gear.operationalAdenaReserve(state);

for (const classId of [2, 34]) {
    const modest = holding(classId, broadsword, 120000);
    assert.strictEqual(Gear.combatReadiness(modest).hasWeapon, true,
        `class ${classId}: the previous profession's sword counts until a dual sword`);
    assert.strictEqual(Gear.npcWeaponBridgePlan(modest), null, `class ${classId}: no bridge freeze`);
    const kit = Gear.staticNpcUpgradePlan(modest);
    assert(kit && !kit.combine && Number(kit.market.price) <= spendable(modest),
        `class ${classId}: an affordable kit piece is bought while the dual sword is unaffordable`);

    const broke = holding(classId, broadsword, 0);
    const saving = Gear.staticNpcUpgradePlan(broke);
    assert(saving?.combine?.resultId, `class ${classId}: with nothing affordable the kit saves for the dual sword`);

    const rich = holding(classId, broadsword, 20000000);
    const dual = Gear.staticNpcUpgradePlan(rich);
    assert(dual?.combine?.resultId && Number(dual.market?.price) <= spendable(rich),
        `class ${classId}: an affordable dual sword is the kit weapon`);

    // Money for one blade but not for the whole combination: the dual sword
    // is not funded, so the affordable kit piece comes first.
    const oneBlade = holding(classId, broadsword, 600000);
    const oneBladeKit = Gear.staticNpcUpgradePlan(oneBlade);
    assert(oneBladeKit && !oneBladeKit.combine, `class ${classId}: a half-funded dual sword does not jump ahead of armour`);
    assert.strictEqual(Gear.npcWeaponBridgePlan(oneBlade), null, `class ${classId}: no bridge for a half-funded dual sword`);

    // Only weapons the previous profession could use count: no staves or caster swords.
    for (const name of ['Willow Staff', 'Sword of Magic', "Apprentice's Wand"]) {
        assert.strictEqual(Gear.combatReadiness(holding(classId, byName(name), 0)).hasWeapon, false,
            `class ${classId}: ${name} is not a Warrior / Palus Knight weapon`);
    }

    const unarmed = holding(classId, bow, 0);
    assert.strictEqual(Gear.combatReadiness(unarmed).hasWeapon, false, `class ${classId}: a bow is not usable`);
    assert(Gear.npcWeaponBridgePlan(unarmed)?.combine, `class ${classId}: without a usable weapon the dual-sword bridge applies`);
}
console.log('Dual-sword class interim weapon checks passed');
