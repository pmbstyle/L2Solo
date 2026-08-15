const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
DataCache.init();

const BotGear = invoke('GameServer/Bot/AI/BotGear');
const BotEquipmentUpgrade = invoke('GameServer/Bot/AI/BotEquipmentUpgrade');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const BotWeaponCompatibility = invoke('GameServer/Bot/AI/BotWeaponCompatibility');
const BotRoles = invoke('GameServer/Bot/AI/BotRoles');
const Item = invoke('GameServer/Item/Item');

assert.strictEqual(BotGear.ensureCharacterGear, undefined,
    'level-based gear plans must guide acquisition, not create free equipment on spawn');

function bySlot(plan, slot) {
    return plan.items.find((item) => Number(item.slot) === Number(slot));
}

function itemTemplate(selfId) {
    return DataCache.items.find((item) => Number(item.selfId) === Number(selfId));
}

const lowMage = BotGear.planFor({ classId: 10, level: 2 });
assert.strictEqual(lowMage.rank, 'none');
assert.strictEqual(lowMage.role, 'mage');
assert.ok(bySlot(lowMage, 10), 'low mage should wear an explicit tunic');
assert.ok(bySlot(lowMage, 11), 'low mage should wear explicit stockings');
assert.ok(!bySlot(lowMage, 15), 'low mage should not use full-body no-grade robes');
assert.ok(!bySlot(lowMage, 8), 'low mage should not auto-equip a shield');

const lowFighter = BotGear.planFor({ classId: 0, level: 2 });
assert.strictEqual(itemTemplate(bySlot(lowFighter, 10).selfId).template.kind, 'Armor.Leather');
assert.strictEqual(itemTemplate(bySlot(lowFighter, 11).selfId).template.kind, 'Armor.Leather');

const noGradeShield = DataCache.items.find((item) => item.template?.kind === 'Armor.Shield'
    && Number(item.etc?.slot) === 8 && String(item.etc?.rank || 'none') === 'none');
assert(noGradeShield, 'the datapack must contain a no-grade shield fixture');
const shieldInventory = {
    [noGradeShield.selfId]: {
        selfId: noGradeShield.selfId,
        name: noGradeShield.template.name,
        amount: 1,
        equipped: true,
        equippedCount: 1,
        equippedSlots: [8],
        slot: 8,
        rank: 'none',
        kind: 'Armor.Shield'
    }
};
const mageInventory = GearAcquisitionPlanner.equipInventoryUpgrades({
    level: 10,
    stats: { classId: 10, role: 'mage' }
}, shieldInventory);
assert.strictEqual(mageInventory[String(noGradeShield.selfId)].equipped, false,
    'cold equipment reconciliation must remove shields from classes that cannot use them');
const fighterInventory = GearAcquisitionPlanner.equipInventoryUpgrades({
    level: 10,
    stats: { classId: 0, role: 'dps' }
}, shieldInventory);
assert.strictEqual(fighterInventory[String(noGradeShield.selfId)].equipped, true,
    'shield-compatible fighters must retain an equipped shield');

const noviceDagger = BotGear.planFor({ classId: 7, level: 16 });
const weapon = itemTemplate(bySlot(noviceDagger, 7).selfId);
assert.ok(Number(weapon.stats.pAtk || 0) < 1000, 'no-grade bot gear should ignore anomalous weapon stats');

function wearable(id, data) {
    return new Item(id, {
        selfId: data.selfId || id,
        name: data.name || `item_${id}`,
        kind: data.kind,
        price: data.price ?? 100,
        rank: data.rank || 'none',
        pAtk: data.pAtk || 0,
        mAtk: data.mAtk || 0,
        pDef: data.pDef || 0,
        mDef: data.mDef || 0,
        maxMp: data.maxMp || 0,
        equipped: data.equipped || false,
        slot: data.slot
    });
}

function upgradeSession({ classId, level, items, paperdoll }) {
    const backpack = {
        fetchItems: () => items,
        fetchEquippedWeapon: () => items.find((item) => item.isWeapon() && item.fetchEquipped()),
        fetchPaperdollId: (slot) => paperdoll[slot]?.id,
        fetchItemRaw: (id) => items.find((item) => item.fetchId() === id)
    };

    return {
        accountId: 'bot_upgrade_test',
        actor: {
            backpack,
            fetchLevel: () => level,
            fetchClassId: () => classId
        }
    };
}

const fighterOldSword = wearable(1001, { kind: 'Weapon.Sword', slot: 7, pAtk: 8, mAtk: 4, equipped: true });
const fighterNewSword = wearable(1002, { kind: 'Weapon.Sword', slot: 7, pAtk: 12, mAtk: 5 });
let upgrades = BotEquipmentUpgrade.findBestUpgrades(upgradeSession({
    classId: 0,
    level: 10,
    items: [fighterOldSword, fighterNewSword],
    paperdoll: { 7: { id: 1001 } }
}));
assert.strictEqual(upgrades.length, 1, 'fighter should find one better weapon upgrade');
assert.strictEqual(upgrades[0].item.fetchId(), 1002);

const mageOldBlunt = wearable(1101, { kind: 'Weapon.Blunt', slot: 7, pAtk: 5, mAtk: 8, equipped: true });
const mageBow = wearable(1102, { kind: 'Weapon.Bow', slot: 7, pAtk: 80, mAtk: 1 });
const mageBlunt = wearable(1103, { kind: 'Weapon.Blunt', slot: 7, pAtk: 7, mAtk: 12 });
upgrades = BotEquipmentUpgrade.findBestUpgrades(upgradeSession({
    classId: 10,
    level: 10,
    items: [mageOldBlunt, mageBow, mageBlunt],
    paperdoll: { 7: { id: 1101 } }
}));
assert.strictEqual(upgrades.length, 1, 'mage should only upgrade to a suitable caster weapon');
assert.strictEqual(upgrades[0].item.fetchId(), 1103);

const demonFangsTemplate = itemTemplate(321);
assert.strictEqual(demonFangsTemplate.template.name, 'Demon Fangs', 'the regression fixture must use the real C4 caster weapon');
const healerOldBlunt = wearable(1120, { kind: 'Weapon.Blunt', slot: 7, pAtk: 10, mAtk: 8, equipped: true });
const demonFangs = wearable(1121, {
    selfId: demonFangsTemplate.selfId,
    name: demonFangsTemplate.template.name,
    kind: demonFangsTemplate.template.kind,
    price: demonFangsTemplate.template.price,
    rank: demonFangsTemplate.etc.rank,
    slot: demonFangsTemplate.etc.slot,
    pAtk: demonFangsTemplate.stats.pAtk,
    mAtk: demonFangsTemplate.stats.mAtk
});
assert.strictEqual(BotWeaponCompatibility.isCompatibleWeapon(demonFangs.fetchKind(), 'healer', 29), true,
    'Weapon.Etc must be a compatible family for caster support classes');
assert.strictEqual(BotWeaponCompatibility.isCompatibleWeapon(demonFangs.fetchKind(), 'buffer', 17), true,
    'Prophet must retain caster weapon compatibility');
assert.strictEqual(BotWeaponCompatibility.isCompatibleWeapon(demonFangs.fetchKind(), 'buffer', 21), false,
    'Sword Singer must not inherit caster weapon compatibility from the shared buffer role');
assert.strictEqual(BotWeaponCompatibility.isCompatibleWeapon(demonFangs.fetchKind(), 'buffer', 34), false,
    'Bladedancer must not inherit caster weapon compatibility from the shared buffer role');
assert.deepStrictEqual(BotWeaponCompatibility.weaponKindsFor('dps', 113), ['Weapon.GreatSword', 'Weapon.Blunt', 'Weapon.Pole'],
    'Titan must inherit the full Destroyer weapon profile through its normalized parent class');
assert.deepStrictEqual(BotWeaponCompatibility.weaponKindsFor('dps', 114), ['Weapon.Fist', 'Weapon.DualFist'],
    'Grand Khavatari must inherit the Tyrant fist preference through its normalized parent class');
assert.strictEqual(BotWeaponCompatibility.isCompatibleWeapon(demonFangs.fetchKind(), 'buffer', 115), true,
    'Dominator must inherit Overlord caster compatibility through its normalized parent class');
assert.strictEqual(BotWeaponCompatibility.isSuitableWeapon('Weapon.Blunt', 'Mystic Staff', 45, 32, 'buffer', 21), false,
    'Sword Singer must reject caster staves stored under the shared blunt family');
assert.strictEqual(BotWeaponCompatibility.isSuitableWeapon('Weapon.Blunt', 'Bone Staff', 39, 35, 'dps', 47), false,
    'Orc Monk melee damage dealers must reject caster staves stored under the blunt family');
assert.strictEqual(BotWeaponCompatibility.isCasterWeapon('Weapon.Sword', 'Broadsword', 11, 9), false,
    'close starter stats must not turn an ordinary physical sword into caster gear');
assert.strictEqual(BotWeaponCompatibility.isSuitableWeapon('Weapon.Sword', 'Broadsword', 11, 9, 'buffer', 21), true,
    'a newly promoted Sword Singer must retain a starter melee weapon until a real upgrade exists');
assert.strictEqual(BotRoles.hasMeleeWeapon({ backpack: { fetchEquippedWeapon: () => demonFangs } }), false,
    'Demon Fangs must not make a healer eligible for melee assist');
const singerPlan = BotGear.planFor({ classId: 21, level: 33 });
const singerWeapon = itemTemplate(bySlot(singerPlan, 7)?.selfId || bySlot(singerPlan, 14)?.selfId);
assert(singerWeapon && !BotWeaponCompatibility.isCasterWeapon(
    singerWeapon.template.kind,
    singerWeapon.template.name,
    singerWeapon.stats.pAtk,
    singerWeapon.stats.mAtk
), 'Sword Singer generated gear must retain a real melee weapon');
const monkPlan = BotGear.planFor({ classId: 47, level: 24 });
const monkWeapon = itemTemplate(bySlot(monkPlan, 7)?.selfId || bySlot(monkPlan, 14)?.selfId);
assert.strictEqual(monkWeapon.template.kind, 'Weapon.DualFist',
    'Orc Monk generated gear must use combat fists instead of blunt weapons');
for (const [classId, level] of [[34, 61], [107, 76]]) {
    const dancerPlan = BotGear.planFor({ classId, level });
    const dancerWeapon = itemTemplate(bySlot(dancerPlan, 14)?.selfId || bySlot(dancerPlan, 7)?.selfId);
    assert.strictEqual(dancerWeapon?.template?.kind, 'Weapon.Dual',
        `class ${classId} must retain a compatible dual weapon when the catalog has no ${dancerPlan.rank.toUpperCase()}-grade dual`);
}
const promotionSword = DataCache.items.find((item) => item.template?.kind === 'Weapon.Sword'
    && String(item.etc?.rank).toLowerCase() === 'c' && item.template?.name && item.template.name !== '0');
const promotionDual = DataCache.items.find((item) => item.template?.kind === 'Weapon.Dual'
    && String(item.etc?.rank).toLowerCase() === 'c' && item.template?.name && item.template.name !== '0');
assert(promotionSword && promotionDual, 'the datapack must expose C-grade sword and dual fixtures for profession gear progression');
const fakeMarketOffer = (item) => ({ selfId: item.selfId, price: 1, town: 'Giran', sourceType: 'npc' });
const promotionCap = GearAcquisitionPlanner.progressionPriceCap('c', 40);
const affordableDualIds = DataCache.items
    .filter((item) => item.template?.kind === 'Weapon.Dual'
        && String(item.etc?.rank).toLowerCase() === 'c'
        && Number(item.template?.price || 0) <= promotionCap)
    .map((item) => Number(item.selfId));
const overCapDual = DataCache.items.find((item) => item.template?.kind === 'Weapon.Dual'
    && String(item.etc?.rank).toLowerCase() === 'c'
    && Number(item.template?.price || 0) > promotionCap);
assert(overCapDual, 'the datapack must expose an over-cap C-grade dual fixture');
const missingDualPlan = GearAcquisitionPlanner.planFor({
    level: 40,
    adena: 1000000,
    stats: { classId: 34, role: 'buffer' },
    inventory: {
        57: { selfId: 57, amount: 1000000 },
        [promotionSword.selfId]: { selfId: promotionSword.selfId, amount: 1, equipped: true, slot: 7 }
    }
}, { spots: [], findMarketOffer: fakeMarketOffer });
assert.strictEqual(itemTemplate(missingDualPlan.target?.selfId)?.template?.kind, 'Weapon.Dual',
    'a newly promoted Bladedancer without duals must immediately receive a dual-sword acquisition target');
const overCapDualPlan = GearAcquisitionPlanner.planFor({
    level: 40,
    adena: 1000000,
    stats: { classId: 34, role: 'buffer' },
    inventory: {
        57: { selfId: 57, amount: 1000000 },
        [promotionSword.selfId]: { selfId: promotionSword.selfId, amount: 1, equipped: true, slot: 7 }
    }
}, {
    spots: [],
    findMarketOffer: () => null,
    excludedTargetIds: affordableDualIds
});
const overCapTarget = itemTemplate(overCapDualPlan.target?.selfId);
assert.strictEqual(overCapTarget?.template?.kind, 'Weapon.Dual',
    'a same-grade sword must not suppress the required dual-sword target when no NPC offer exists');
assert(Number(overCapTarget?.template?.price || 0) > promotionCap,
    'the required dual-sword target must be retained even when every remaining dual is over the progression cap');
const equippedDualPlan = GearAcquisitionPlanner.planFor({
    level: 40,
    adena: 1000000,
    stats: { classId: 34, role: 'buffer' },
    inventory: {
        57: { selfId: 57, amount: 1000000 },
        [promotionDual.selfId]: { selfId: promotionDual.selfId, amount: 1, equipped: true, slot: 14 }
    }
}, { spots: [], findMarketOffer: fakeMarketOffer });
assert.notStrictEqual(itemTemplate(equippedDualPlan.target?.selfId)?.template?.kind, 'Weapon.Dual',
    'an equipped Bladedancer dual must not trigger a duplicate dual-sword goal');
upgrades = BotEquipmentUpgrade.findBestUpgrades(upgradeSession({
    classId: 29,
    level: 33,
    items: [healerOldBlunt, demonFangs],
    paperdoll: { 7: { id: 1120 } }
}));
assert.strictEqual(upgrades.length, 1, 'a healer must replace an obsolete no-grade weapon with traded Demon Fangs');
assert.strictEqual(upgrades[0].item.fetchSelfId(), 321);

const singerSword = wearable(1122, { kind: 'Weapon.Sword', slot: 7, pAtk: 50, mAtk: 10, equipped: true });
upgrades = BotEquipmentUpgrade.findBestUpgrades(upgradeSession({
    classId: 21,
    level: 33,
    items: [singerSword, demonFangs],
    paperdoll: { 7: { id: 1122 } }
}));
assert.strictEqual(upgrades.length, 0, 'a Sword Singer must keep its melee weapon instead of equipping traded caster gear');

const boneStaffTemplate = itemTemplate(178);
const scallopJamadhrTemplate = itemTemplate(262);
const equippedBoneStaff = wearable(1123, {
    selfId: boneStaffTemplate.selfId,
    name: boneStaffTemplate.template.name,
    kind: boneStaffTemplate.template.kind,
    price: boneStaffTemplate.template.price,
    rank: boneStaffTemplate.etc.rank,
    slot: boneStaffTemplate.etc.slot,
    pAtk: boneStaffTemplate.stats.pAtk,
    mAtk: boneStaffTemplate.stats.mAtk,
    equipped: true
});
const tradedScallopJamadhr = wearable(1124, {
    selfId: scallopJamadhrTemplate.selfId,
    name: scallopJamadhrTemplate.template.name,
    kind: scallopJamadhrTemplate.template.kind,
    price: scallopJamadhrTemplate.template.price,
    rank: scallopJamadhrTemplate.etc.rank,
    slot: scallopJamadhrTemplate.etc.slot,
    pAtk: scallopJamadhrTemplate.stats.pAtk,
    mAtk: scallopJamadhrTemplate.stats.mAtk
});
upgrades = BotEquipmentUpgrade.findBestUpgrades(upgradeSession({
    classId: 47,
    level: 24,
    items: [equippedBoneStaff, tradedScallopJamadhr],
    paperdoll: { 14: { id: 1123 } }
}));
assert.deepStrictEqual(upgrades.map(({ item }) => item.fetchSelfId()), [262],
    'an Orc Monk must recognize traded Scallop Jamadhr as a safe replacement for an equipped Bone Staff');

const singerRobe = wearable(1125, { kind: 'Armor.Fabric', slot: 10, pDef: 80, maxMp: 100, rank: 'c' });
const singerHeavy = wearable(1126, { kind: 'Armor.Chain', slot: 10, pDef: 60, rank: 'c' });
upgrades = BotEquipmentUpgrade.findBestUpgrades(upgradeSession({
    classId: 21,
    level: 44,
    items: [singerRobe, singerHeavy],
    paperdoll: {}
}));
assert.deepStrictEqual(upgrades.map(({ item }) => item.fetchId()), [1126],
    'a Sword Singer must accept heavy armor and reject robes during live upgrades');

const monkHeavy = wearable(1127, { kind: 'Armor.Chain', slot: 10, pDef: 80, rank: 'c' });
const monkLight = wearable(1128, { kind: 'Armor.Leather', slot: 10, pDef: 60, rank: 'c' });
upgrades = BotEquipmentUpgrade.findBestUpgrades(upgradeSession({
    classId: 47,
    level: 44,
    items: [monkHeavy, monkLight],
    paperdoll: {}
}));
assert.deepStrictEqual(upgrades.map(({ item }) => item.fetchId()), [1128],
    'an Orc Monk must accept light armor and reject heavy armor during live upgrades');

const movingTradeSession = upgradeSession({
    classId: 29,
    level: 33,
    items: [healerOldBlunt, demonFangs],
    paperdoll: { 7: { id: 1120 } }
});
movingTradeSession.actor.fetchName = () => 'TradeHealer';
movingTradeSession.actor.state = {
    fetchHits: () => null,
    fetchCasts: () => null,
    fetchTowards: () => ({ locX: 1, locY: 1, locZ: 0 })
};
movingTradeSession.actor.backpack.equipGear = (_session, item) => {
    healerOldBlunt.setEquipped(false);
    item.setEquipped(true);
};
const movingTradeUpgrades = BotEquipmentUpgrade.applyBestUpgrades(movingTradeSession, { force: true });
assert.strictEqual(movingTradeUpgrades.length, 1, 'safe equipment upgrades must not starve while the companion is following');
assert.strictEqual(demonFangs.fetchEquipped(), true);

const mageTunic = wearable(1110, { kind: 'Armor.Fabric', slot: 10, pDef: 21, maxMp: 38, equipped: true });
const mageStockings = wearable(1111, { kind: 'Armor.Fabric', slot: 11, pDef: 13, maxMp: 23, equipped: true });
const cottonRobe = wearable(1112, { kind: 'Armor.Fabric', slot: 15, pDef: 35, maxMp: 61, price: 3550 });
upgrades = BotEquipmentUpgrade.findBestUpgrades(upgradeSession({
    classId: 10,
    level: 11,
    items: [mageTunic, mageStockings, cottonRobe],
    paperdoll: { 10: { id: 1110 }, 11: { id: 1111 } }
}));
assert.strictEqual(upgrades.length, 0, 'mage should not upgrade into no-grade full-body robes');

const fullPlate = wearable(1130, { kind: 'Armor.Chain', slot: 15, pDef: 239, rank: 'c', equipped: true });
const brigandineTunic = wearable(1131, { kind: 'Armor.Chain', slot: 10, pDef: 103, rank: 'd' });
const brigandineGaiters = wearable(1132, { kind: 'Armor.Chain', slot: 11, pDef: 64, rank: 'd' });
upgrades = BotEquipmentUpgrade.findBestUpgrades(upgradeSession({
    classId: 5,
    level: 50,
    items: [fullPlate, brigandineTunic, brigandineGaiters],
    paperdoll: { 10: { id: 1130 }, 15: { id: 1130 } }
}));
assert.strictEqual(upgrades.length, 0,
    'a tank must ignore the Full Plate chest alias and keep it over weaker Brigandine gaiters');

const weakFullBody = wearable(1140, { kind: 'Armor.Chain', slot: 15, pDef: 100, rank: 'd', equipped: true });
const strongerChest = wearable(1141, { kind: 'Armor.Chain', slot: 10, pDef: 80, rank: 'c' });
const strongerPants = wearable(1142, { kind: 'Armor.Chain', slot: 11, pDef: 70, rank: 'c' });
upgrades = BotEquipmentUpgrade.findBestUpgrades(upgradeSession({
    classId: 5,
    level: 50,
    items: [weakFullBody, strongerChest, strongerPants],
    paperdoll: { 10: { id: 1140 }, 15: { id: 1140 } }
}));
assert.deepStrictEqual(upgrades.map(({ item }) => item.fetchId()), [1141, 1142],
    'a complete stronger chest and pants layout should replace weaker full-body armor together');

const pairedPaperdoll = { 10: { id: 1140 }, 15: { id: 1140 } };
const pairedApplySession = upgradeSession({
    classId: 5,
    level: 50,
    items: [weakFullBody, strongerChest, strongerPants],
    paperdoll: pairedPaperdoll
});
pairedApplySession.actor.fetchName = () => 'TorsoUpgradeTank';
pairedApplySession.actor.state = { fetchHits: () => null, fetchCasts: () => null };
pairedApplySession.actor.backpack.equipGear = (_session, item) => {
    weakFullBody.setEquipped(false);
    delete pairedPaperdoll[10];
    delete pairedPaperdoll[15];
    item.setEquipped(true);
    pairedPaperdoll[item.fetchSlot()] = { id: item.fetchId() };
};
const pairedApplyResult = BotEquipmentUpgrade.applyCandidate(pairedApplySession, 1141, { force: true });
assert.deepStrictEqual(pairedApplyResult, { applied: false, reason: 'requires_equipment_optimization' },
    'single-item equip must reject a torso change that is only safe as a complete layout');
assert.strictEqual(strongerChest.fetchEquipped(), false,
    'rejecting a paired torso layout must not equip the requested chest');
assert.strictEqual(strongerPants.fetchEquipped(), false,
    'rejecting a paired torso layout must not silently equip its pants');
assert(!BotEquipmentUpgrade.listSafeLoadouts(pairedApplySession).some(({ itemId }) => [1141, 1142].includes(itemId)),
    'paired torso layouts must not be exposed as independent single-item choices');
const pairedOptimization = BotEquipmentUpgrade.applyBestUpgrades(pairedApplySession, { force: true });
assert.deepStrictEqual(pairedOptimization.map(({ item }) => item.fetchId()), [1141, 1142],
    'full equipment optimization should still apply the complete winning torso layout');
assert.strictEqual(strongerChest.fetchEquipped(), true);
assert.strictEqual(strongerPants.fetchEquipped(), true);

const intermediateSword = wearable(1143, { kind: 'Weapon.Sword', slot: 7, pAtk: 20 });
const bestSword = wearable(1144, { kind: 'Weapon.Sword', slot: 7, pAtk: 30 });
const oldSword = wearable(1145, { kind: 'Weapon.Sword', slot: 7, pAtk: 10, equipped: true });
const intermediatePaperdoll = { 7: { id: 1145 } };
const intermediateSession = upgradeSession({
    classId: 5,
    level: 50,
    items: [oldSword, intermediateSword, bestSword],
    paperdoll: intermediatePaperdoll
});
intermediateSession.actor.fetchName = () => 'CandidateTank';
intermediateSession.actor.state = { fetchHits: () => null, fetchCasts: () => null };
intermediateSession.actor.backpack.equipGear = (_session, item) => {
    oldSword.setEquipped(false);
    item.setEquipped(true);
    intermediatePaperdoll[7] = { id: item.fetchId() };
};
const intermediateResult = BotEquipmentUpgrade.applyCandidate(intermediateSession, 1143, { force: true });
assert.strictEqual(intermediateResult.applied, true,
    'single-item equip should accept a strict upgrade even when a stronger candidate also exists');
assert.strictEqual(intermediateSword.fetchEquipped(), true);
assert.strictEqual(bestSword.fetchEquipped(), false);

const weakChest = wearable(1150, { kind: 'Armor.Chain', slot: 10, pDef: 50, rank: 'd', equipped: true });
const weakPants = wearable(1151, { kind: 'Armor.Chain', slot: 11, pDef: 40, rank: 'd', equipped: true });
const strongerFullBody = wearable(1152, { kind: 'Armor.Chain', slot: 15, pDef: 120, rank: 'c' });
upgrades = BotEquipmentUpgrade.findBestUpgrades(upgradeSession({
    classId: 5,
    level: 50,
    items: [weakChest, weakPants, strongerFullBody],
    paperdoll: { 10: { id: 1150 }, 11: { id: 1151 } }
}));
assert.deepStrictEqual(upgrades.map(({ item }) => item.fetchId()), [1152],
    'stronger full-body armor should replace a weaker chest and pants layout');

const strongChestOnly = wearable(1160, { kind: 'Armor.Chain', slot: 10, pDef: 130, rank: 'c', equipped: true });
const weakerFullBody = wearable(1161, { kind: 'Armor.Chain', slot: 15, pDef: 120, rank: 'c' });
upgrades = BotEquipmentUpgrade.findBestUpgrades(upgradeSession({
    classId: 5,
    level: 50,
    items: [strongChestOnly, weakerFullBody],
    paperdoll: { 10: { id: 1160 } }
}));
assert.strictEqual(upgrades.length, 0,
    'full-body coverage must not justify a lower-scoring torso downgrade');

const lowOldSword = wearable(1201, { kind: 'Weapon.Sword', slot: 7, pAtk: 8, equipped: true });
const tooHighGradeSword = wearable(1202, { kind: 'Weapon.Sword', slot: 7, pAtk: 80, rank: 'd' });
upgrades = BotEquipmentUpgrade.findBestUpgrades(upgradeSession({
    classId: 0,
    level: 10,
    items: [lowOldSword, tooHighGradeSword],
    paperdoll: { 7: { id: 1201 } }
}));
assert.strictEqual(upgrades.length, 0, 'low-level bot should not auto-equip gear above its grade band');

console.log('Bot gear checks passed');
