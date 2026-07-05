const assert = require('assert');

require('../src/Global');

const BackpackModel = invoke('GameServer/Model/Backpack');
const C4EquipmentItemSkills = invoke('GameServer/Items/C4EquipmentItemSkills');
const EffectStats = invoke('GameServer/Effects/EffectStats');

function equippedArmor({ id, selfId = id, slot, pDef = 0, mDef = 0, evasion = 0, bonusMp = 0, shieldRate = 20 }) {
    return {
        isArmor: () => true,
        isWeapon: () => false,
        fetchEquipped: () => true,
        fetchSlot: () => slot,
        fetchId: () => id,
        fetchSelfId: () => selfId,
        fetchPDef: () => pDef,
        fetchMDef: () => mDef,
        fetchEvasion: () => evasion,
        fetchBonusMp: () => bonusMp,
        fetchShieldRate: () => shieldRate
    };
}

function backpack(items = []) {
    const bp = new BackpackModel(Array.from({ length: 16 }, () => ({})));
    bp.items = items;
    return bp;
}

const naked = backpack();
assert.strictEqual(naked.fetchTotalArmorPDef(false), 76, 'naked fighter P.Def should keep base body-part defaults');

const chestAndPants = backpack([
    equippedArmor({ id: 1, slot: 10, pDef: 100 }),
    equippedArmor({ id: 2, slot: 11, pDef: 50 })
]);
assert.strictEqual(chestAndPants.fetchTotalArmorPDef(false), 177, 'separate chest and pants should contribute their P.Def');

const fullBody = backpack([
    equippedArmor({ id: 3, slot: 15, pDef: 200 })
]);
assert.strictEqual(fullBody.fetchTotalArmorPDef(false), 227, 'full-body armor should contribute its P.Def once as torso armor');

const fullBodyWithPaperdollDupes = backpack([
    equippedArmor({ id: 4, slot: 15, pDef: 200, evasion: 3, bonusMp: 100 })
]);
fullBodyWithPaperdollDupes.equipPaperdoll(15, 4, 60);
assert.strictEqual(fullBodyWithPaperdollDupes.fetchTotalArmorEvasion(), 3, 'full-body armor evasion should not be counted from duplicated paperdoll slots');
assert.strictEqual(fullBodyWithPaperdollDupes.fetchTotalArmorBonusMp(), 100, 'full-body armor bonus MP should not be counted from duplicated paperdoll slots');

const jewelry = backpack([
    equippedArmor({ id: 5, slot: 1, mDef: 11 }),
    equippedArmor({ id: 6, slot: 2, mDef: 13 }),
    equippedArmor({ id: 7, slot: 3, mDef: 20 }),
    equippedArmor({ id: 8, slot: 4, mDef: 7 }),
    equippedArmor({ id: 9, slot: 5, mDef: 9 })
]);
assert.strictEqual(jewelry.fetchTotalArmorMDef(), 60, 'both earrings, both rings, and necklace should contribute M.Def');

const shield = backpack([
    equippedArmor({ id: 10, slot: 8, pDef: 190, evasion: -8, shieldRate: 20 })
]);
assert.strictEqual(shield.fetchTotalShieldPDef(), 190, 'shield P.Def should be available for shield block mitigation');
assert.strictEqual(shield.fetchTotalShieldRate(), 20, 'shield rate should be available for shield block rolls');
assert.strictEqual(shield.fetchTotalArmorEvasion(), -8, 'shield evasion penalty should contribute to armor evasion');

function equipmentSkillItem(id, selfId) {
    return {
        fetchId: () => id,
        fetchSelfId: () => selfId,
        fetchEquipped: () => true
    };
}

const baiumActor = { effects: {} };
C4EquipmentItemSkills.sync(baiumActor, [equipmentSkillItem(11, 6658)]);
assert.strictEqual(EffectStats.multiplier(baiumActor, 'poisonVuln'), 0.2, 'Ring of Baium should apply poison resistance');
assert.strictEqual(EffectStats.add(baiumActor, 'pAccuracyCombatAdd'), 2, 'Ring of Baium should apply accuracy');
assert.strictEqual(EffectStats.multiplier(baiumActor, 'pCritDamageMul'), 1.15, 'Ring of Baium should apply critical damage');
assert.strictEqual(EffectStats.multiplier(baiumActor, 'rootVuln'), 0.4, 'Ring of Baium should apply root resistance');
assert.strictEqual(EffectStats.multiplier(baiumActor, 'pAtkSpdMul'), 1.04, 'Ring of Baium should apply attack speed');
assert.strictEqual(EffectStats.multiplier(baiumActor, 'castSpdMul'), 1.04, 'Ring of Baium should apply casting speed');

const valakasActor = { effects: {} };
C4EquipmentItemSkills.sync(valakasActor, [equipmentSkillItem(12, 6657)]);
assert.strictEqual(EffectStats.add(valakasActor, 'maxHpAdd'), 445, 'Necklace of Valakas should apply HP');
assert.strictEqual(EffectStats.multiplier(valakasActor, 'pAtkMul'), 1.04, 'Necklace of Valakas should apply P.Atk');
assert.strictEqual(EffectStats.multiplier(valakasActor, 'mAtkMul'), 1.08, 'Necklace of Valakas should apply M.Atk');
assert.strictEqual(EffectStats.multiplier(valakasActor, 'fireVuln'), 0.85, 'Necklace of Valakas should apply fire resistance');
assert.strictEqual(EffectStats.multiplier(valakasActor, 'sleepVuln'), 0.2, 'Necklace of Valakas should apply sleep resistance');
assert.strictEqual(EffectStats.add(valakasActor, 'reflectDam'), 5, 'Necklace of Valakas should apply reflect damage');

console.log('Armor stat checks passed');
