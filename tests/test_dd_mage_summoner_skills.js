const assert = require('assert');

require('../src/Global');

const Attack = invoke('GameServer/Actor/Attack');
const C4SkillEffects = invoke('GameServer/Skills/C4SkillEffects');
const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');
const DataCache = invoke('GameServer/DataCache');
const EffectStats = invoke('GameServer/Effects/EffectStats');
const EffectStore = invoke('GameServer/Effects/EffectStore');
const SkillExec = invoke('GameServer/Actor/Generics/SkillExec');
const SkillRequest = invoke('GameServer/Actor/Generics/SkillRequest');
const SkillModel = invoke('GameServer/Model/Skill');
const skillTree = require('../data/Skills/Tree/tree.json');

DataCache.init();

function cachedSkill(selfId, level = 1) {
    const data = DataCache.skills.find((entry) => entry.selfId === selfId);
    const levelData = data.levels.find((entry) => entry.level === level);
    return new SkillModel({ ...utils.crushOb(data), ...levelData });
}

function passive(selfId, level = 1) {
    return new SkillModel({ selfId, name: `passive_${selfId}`, level, passive: true, spell: false, distance: -1, mp: 0, hp: 0, power: 1 });
}

function statActor(skills = [], armorKinds = [], stateOverrides = {}) {
    const armors = armorKinds.map((entry) => {
        const { kind, slot } = typeof entry === 'string'
            ? { kind: entry, slot: 15 }
            : entry;
        return { fetchKind: () => kind, fetchSlot: () => slot };
    });
    return {
        effects: {},
        skillset: { fetchSkills: () => skills },
        fetchPassiveSkills: () => [],
        backpack: {
            fetchEquippedArmors: () => armors,
            fetchEquippedArmor: (slot) => armors.find((item) => item.fetchSlot() === slot),
            fetchTotalWeaponKind: () => 'Weapon.Staff'
        },
        state: {
            inMotion: () => stateOverrides.moving === true,
            fetchWalkin: () => stateOverrides.walking === true,
            fetchSeated: () => stateOverrides.seated === true
        }
    };
}

const mageClassSignatures = new Map([
    [11, [1111, 1126, 1127, 1147, 1172]],
    [12, [1056, 1230, 1231, 1232]],
    [13, [1148, 1159, 1234, 1262]],
    [14, [1111, 1225, 1276, 1331]],
    [27, [1235, 1236, 1237, 1295]],
    [28, [1226, 1227, 1277, 1332]],
    [40, [1239, 1267, 1291, 1294]],
    [41, [1128, 1228, 1278, 1281]],
    [94, [1338, 1339, 337]],
    [95, [1336, 1343, 1344]],
    [96, [1346, 1349, 1350]],
    [103, [1338, 1340, 1342]],
    [104, [1347, 1349, 1350]],
    [110, [1338, 1341, 1343]],
    [111, [1348, 1349, 1351]]
]);

for (const [classId, expectedIds] of mageClassSignatures) {
    const tree = skillTree.find((entry) => entry.classId === classId);
    assert(tree, `mage class ${classId} should have a C4 skill tree`);
    const ids = new Set(tree.skills.map((entry) => entry.selfId));
    expectedIds.forEach((id) => assert(ids.has(id), `mage class ${classId} should retain sourced skill ${id}`));
}

for (const [id, maxLevel] of [[118, 1], [163, 1], [214, 1], [244, 3], [258, 33], [1297, 6]]) {
    const data = DataCache.skills.find((entry) => entry.selfId === id);
    assert.strictEqual(data.template.passive, true, `mage passive ${id} must remain passive`);
    assert.strictEqual(data.levels.length, maxLevel, `mage passive ${id} should materialize all C4 levels`);
    assert.strictEqual(cachedSkill(id, maxLevel).fetchSkillType(), C4SkillRules.PASSIVE, `mage passive ${id} must not execute as an active skill`);
}

assert.strictEqual(EffectStats.multiplier(statActor([passive(118)]), 'pAtkSpdMul'), 0.8, 'Magician\'s Movement should penalize attack speed without robes');
assert.strictEqual(EffectStats.multiplier(statActor([passive(118)], ['Armor.Fabric']), 'pAtkSpdMul'), 1, 'Magician\'s Movement should not penalize robe users');
assert.strictEqual(EffectStats.multiplier(statActor([passive(163)]), 'castSpdMul'), 0.5, 'Spellcraft should penalize cast speed without robes');
assert.strictEqual(EffectStats.multiplier(statActor([passive(214)], ['Armor.Fabric']), 'regMp'), 1.2, 'Mana Recovery should increase robe MP regeneration');
assert.strictEqual(EffectStats.multiplier(statActor([passive(214)], ['Armor.Leather']), 'regMp'), 1, 'Mana Recovery should not apply in light armor');

const lightMastery = statActor([passive(258, 33)], ['Armor.Leather']);
assert.strictEqual(EffectStats.add(lightMastery, 'pDefAdd'), 46, 'Light Armor Mastery level 33 should add sourced P.Def');
assert.strictEqual(EffectStats.multiplier(lightMastery, 'castSpdMul'), 1.88, 'Light Armor Mastery should increase casting speed');
assert.strictEqual(EffectStats.multiplier(lightMastery, 'pAtkSpdMul'), 1.25, 'Light Armor Mastery should increase attack speed');
assert.strictEqual(EffectStats.multiplier(lightMastery, 'regMp'), 1.2, 'Light Armor Mastery should increase MP regeneration');
const mixedArmorMastery = statActor([passive(258, 33)], [
    { kind: 'Armor.Leather', slot: 10 },
    { kind: 'Armor.Chain', slot: 11 }
]);
assert.strictEqual(EffectStats.add(mixedArmorMastery, 'pDefAdd'), 0, 'Light Armor Mastery should reject mixed chest and leg armor');

assert.strictEqual(EffectStats.add(statActor([passive(1297, 6)], [], { moving: true, walking: true }), 'regMpAdd'), 6.2, 'Clear Mind should use the sourced walking MP regeneration');
assert.strictEqual(EffectStats.add(statActor([passive(1297, 6)]), 'regMpAdd'), 4.9, 'Clear Mind should use the sourced standing MP regeneration');
assert.strictEqual(EffectStats.add(statActor([passive(1297, 6)], [], { moving: true, walking: false }), 'regMpAdd'), 0, 'Clear Mind should not apply its walking bonus while running');

function combatant(id, effects = {}) {
    return {
        effects,
        hp: 1000,
        mp: 1000,
        skillset: { fetchSkills: () => [] },
        fetchPassiveSkills: () => [],
        fetchId: () => id,
        fetchName: () => `combatant_${id}`,
        fetchLevel: () => 78,
        fetchCollectiveMAtk: () => 100,
        fetchCollectiveMDef: () => 100,
        fetchHp() { return this.hp; },
        fetchMaxHp: () => 1000,
        setHp(value) { this.hp = value; },
        fetchMp() { return this.mp; },
        setMp(value) { this.mp = value; },
        statusUpdateVitals() {},
        state: { fetchDead: () => false },
        backpack: { fetchTotalWeaponPAtkRnd: () => 0 }
    };
}

const magicAttack = new Attack();
const magicCaster = combatant(2000101);
const magicTarget = combatant(2000102);
const prominence = cachedSkill(1230, 1);
const ordinaryMagicDamage = magicAttack.prepareSkillDamage(magicCaster, magicTarget, prominence, true, () => 0.5);
const baselineMagicCritical = magicAttack.prepareSkillDamage(magicCaster, magicTarget, prominence, true, () => 0.007);
assert.strictEqual(baselineMagicCritical, ordinaryMagicDamage * 4, 'C4 baseline magic critical rate should be 8 per 1000');
EffectStore.apply(magicCaster, { key: 'wild_magic', id: 1303, level: 2, type: 'buff', stats: { mCritRateMul: 4 }, durationMs: 60000 });
assert.strictEqual(magicAttack.prepareSkillDamage(magicCaster, magicTarget, prominence, true, () => 0.02), ordinaryMagicDamage * 4, 'Wild Magic should multiply the baseline magic critical rate');

const baneCaster = combatant(2000201);
const baneTarget = combatant(2000202);
EffectStore.apply(baneTarget, { key: 'wind_walk', id: 1204, level: 2, type: 'buff', stackFamily: cachedSkill(1204, 2).fetchSemantic().stackFamily, stats: { runSpdAdd: 33 }, durationMs: 60000 });
EffectStore.apply(baneTarget, { key: 'haste', id: 1086, level: 2, type: 'buff', stackFamily: cachedSkill(1086, 2).fetchSemantic().stackFamily, stats: { pAtkSpdMul: 1.33 }, durationMs: 60000 });
EffectStore.apply(baneTarget, { key: 'might', id: 1068, level: 3, type: 'buff', stats: { pAtkMul: 1.15 }, durationMs: 60000 });
EffectStore.apply(baneTarget, { key: 'prophecy_of_fire', id: 1356, level: 1, type: 'buff', stats: { pAtkSpdMul: 1.2, runSpdMul: 0.9 }, durationMs: 60000 });
const testSession = { actor: baneCaster, dataSendToMe() {}, dataSendToMeAndOthers() {} };
const warriorBaneOutcome = C4SkillEffects.execute(testSession, baneCaster, baneTarget, cachedSkill(1350), {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.deepStrictEqual(warriorBaneOutcome.cancelled.map((effect) => effect.key), ['haste', 'wind_walk'], 'Warrior Bane should remove speed buffs only');
assert(EffectStore.list(baneTarget).some((effect) => effect.key === 'might'), 'Warrior Bane should preserve unrelated P.Atk buffs');
assert(EffectStore.list(baneTarget).some((effect) => effect.key === 'prophecy_of_fire'), 'Warrior Bane should preserve CoV-family multi-stat buffs');

EffectStore.apply(baneTarget, { key: 'empower', id: 1059, level: 3, type: 'buff', stackFamily: cachedSkill(1059, 3).fetchSemantic().stackFamily, stats: { mAtkMul: 1.75 }, durationMs: 60000 });
EffectStore.apply(baneTarget, { key: 'acumen', id: 1085, level: 3, type: 'buff', stackFamily: cachedSkill(1085, 3).fetchSemantic().stackFamily, stats: { castSpdMul: 1.3 }, durationMs: 60000 });
EffectStore.apply(baneTarget, { key: 'protected_acumen', id: 40001, level: 1, type: 'buff', dispellable: false, stats: { castSpdMul: 1.1 }, durationMs: 60000 });
EffectStore.apply(baneTarget, { key: 'prophecy_of_water', id: 1355, level: 1, type: 'buff', stats: { mAtkMul: 1.2, castSpdMul: 1.2 }, durationMs: 60000 });
const mageBaneOutcome = C4SkillEffects.execute(testSession, baneCaster, baneTarget, cachedSkill(1351), {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.deepStrictEqual(mageBaneOutcome.cancelled.map((effect) => effect.key), ['empower', 'acumen'], 'Mage Bane should remove M.Atk and casting-speed buffs only');
assert(EffectStore.list(baneTarget).some((effect) => effect.key === 'protected_acumen'), 'Bane should preserve non-dispellable effects');
assert(EffectStore.list(baneTarget).some((effect) => effect.key === 'prophecy_of_water'), 'Mage Bane should preserve CoV-family multi-stat buffs');

const protectedBaneTarget = combatant(2000203);
EffectStore.apply(protectedBaneTarget, { key: 'haste', id: 1086, level: 2, type: 'buff', stackFamily: 'pAtkSpeedUp', stats: { pAtkSpdMul: 1.33 }, durationMs: 60000 });
EffectStore.apply(protectedBaneTarget, { key: 'arcane_protection', id: 1354, level: 1, type: 'buff', stats: { cancelVuln: 0.7 }, durationMs: 60000 });
const protectedBaneOutcome = C4SkillEffects.execute(testSession, baneCaster, protectedBaneTarget, cachedSkill(1350), {
    magicSkill: true,
    rng: () => 0.55,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(protectedBaneOutcome.effectResisted, true, 'Arcane Protection cancelVuln should reduce Bane success');
assert(EffectStore.list(protectedBaneTarget).some((effect) => effect.key === 'haste'), 'a resisted Bane should preserve matching buffs');

const assassinServitor = C4SkillRules.resolve({ selfId: 1348, name: 'Assassin Servitor', level: 1 });
const finalServitor = C4SkillRules.resolve({ selfId: 1349, name: 'Final Servitor', level: 1 });
assert.deepStrictEqual(assassinServitor.situationalStats[0].stats, { pCritDamageMul: 1.2, pCritRateMul: 1.2 }, 'Assassin Servitor should grant sourced behind-only critical bonuses');
assert.strictEqual(finalServitor.stats.pCritRateMul, 1.2, 'Final Servitor should increase servitor critical rate');
assert.strictEqual(finalServitor.stats.pCritDamageMul, 1.2, 'Final Servitor should increase servitor critical damage');

const spiritOre = { fetchId: () => 7001, fetchAmount: () => 20 };
let consumedOre = 0;
const reagentActor = {
    backpack: {
        fetchItemFromSelfId: (id) => id === 3031 ? spiritOre : null,
        deleteItem(_session, _id, count, callback) { consumedOre += count; callback(); }
    }
};
const attack = new Attack();
assert.strictEqual(attack.skillUseConditionFailure(reagentActor, cachedSkill(1346)), null, 'Servitor buffs should accept the sourced Spirit Ore reagent');
assert.strictEqual(attack.consumeSkillItems({}, reagentActor, cachedSkill(1346)), true, 'Servitor buff completion should consume its reagent');
assert.strictEqual(consumedOre, 10, 'Warrior Servitor should consume exactly 10 Spirit Ore');
reagentActor.backpack.fetchItemFromSelfId = () => null;
assert.strictEqual(attack.skillUseConditionFailure(reagentActor, cachedSkill(1349)), 'Not enough required items.', 'Final Servitor should reject casts without 20 Spirit Ore');
assert.strictEqual(attack.shouldConsumeSkillItems(cachedSkill(247)), false, 'unimplemented Build Headquarters must not consume 300 Crystals without creating a headquarters');

const petSkill = cachedSkill(1127, 1);
const ownSummon = { fetchId: () => 1005001, state: { fetchDead: () => false }, isDead: () => false };
let executedPetTarget = null;
const petActor = {
    effects: {},
    summon: ownSummon,
    skillset: { fetchSkill: () => petSkill },
    fetchId: () => 2005001,
    fetchDestId: () => undefined,
    fetchLocX: () => 0,
    fetchLocY: () => 0,
    fetchLocZ: () => 0,
    fetchHead: () => 0,
    isDead: () => false,
    canUseSkill: () => true,
    isBlocked: () => false,
    state: { inMotion: () => false, fetchTowards: () => 'none' },
    automation: {
        fetchDestId: () => undefined,
        abortAll() {},
        scheduleAction(_session, _actor, target, _distance, callback) { executedPetTarget = target; callback(); }
    },
    attack: { remoteHit(_session, target) { executedPetTarget = target; } }
};
const petSession = { actor: petActor, dataSendToMe() {}, dataSendToMeAndOthers() {} };
const request = { selfId: 1127 };
SkillRequest(petSession, petActor, request);
assert.strictEqual(request.id, ownSummon.fetchId(), 'TARGET_PET requests should resolve the active owned summon without a selected target');
assert.strictEqual(petActor.storedSpell.id, ownSummon.fetchId(), 'the queued pet cast should retain the owned summon id');
SkillExec(petSession, petActor, request);
assert.strictEqual(executedPetTarget, ownSummon, 'TARGET_PET execution should reach the active owned summon');

console.log('DD mage and summoner skill checks passed');
