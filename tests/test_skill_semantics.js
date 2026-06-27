const assert = require('assert');

require('../src/Global');

const SkillModel = invoke('GameServer/Model/Skill');
const SkillEffects = invoke('GameServer/Skills/C4SkillEffects');
const EffectStore = invoke('GameServer/Effects/EffectStore');
const EffectStats = invoke('GameServer/Effects/EffectStats');
const EffectRestrictions = invoke('GameServer/Effects/EffectRestrictions');
const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');
const calculateStats = invoke('GameServer/Actor/Generics/CalculateStats');
const Formulas = invoke('GameServer/Formulas');
const Attack = invoke('GameServer/Actor/Attack');
const Automation = invoke('GameServer/Automation');
const ServerResponse = invoke('GameServer/Network/Response');
const activeSkills = require('../data/Skills/Active/active.json');

function creature(overrides = {}) {
    return {
        hp: overrides.hp ?? 100,
        maxHp: overrides.maxHp ?? 100,
        mp: overrides.mp ?? 100,
        maxMp: overrides.maxMp ?? 100,
        level: overrides.level ?? 20,
        effects: {},
        soulshotLoaded: false,
        spiritshotLoaded: false,
        fetchId: () => overrides.id ?? 2000001,
        fetchName: () => overrides.name || 'Actor',
        fetchLevel() { return this.level; },
        fetchHp() { return this.hp; },
        fetchMaxHp() { return this.maxHp; },
        fetchMp() { return this.mp; },
        fetchMaxMp() { return this.maxMp; },
        fetchCollectiveMAtk: () => overrides.mAtk ?? 100,
        fetchCollectivePAtk: () => overrides.pAtk ?? 100,
        fetchCollectivePDef: () => overrides.pDef ?? 100,
        fetchCollectiveMDef: () => overrides.mDef ?? 100,
        fetchDex: () => 30,
        fetchLocX: () => overrides.x ?? 0,
        fetchLocY: () => overrides.y ?? 0,
        fetchLocZ: () => 0,
        fetchHead: () => overrides.head ?? 0,
        setHp(value) { this.hp = value; },
        setMp(value) { this.mp = value; },
        statusUpdateVitals() {},
        backpack: {
            fetchTotalWeaponPAtkRnd: () => 0
        },
        state: {
            fetchDead: () => false
        }
    };
}

function skill(data) {
    return new SkillModel({
        selfId: data.selfId,
        name: data.name,
        passive: false,
        spell: data.spell,
        distance: data.distance ?? 600,
        hitTime: 1000,
        reuse: 1000,
        buff: data.buff ?? 0,
        level: data.level ?? 1,
        power: data.power ?? 1,
        mp: 0,
        hp: 0,
        itemId: 0,
        itemCount: 0
    });
}

function session() {
    return {
        packets: [],
        dataSendToMe(packet) {
            this.packets.push(packet);
        }
    };
}

const caster = creature({ hp: 100, maxHp: 100 });
const wounded = creature({ id: 2000002, hp: 40, maxHp: 100 });
const heal = skill({ selfId: 1011, name: 'Heal', spell: true, power: 49 });
const healOutcome = SkillEffects.execute(session(), caster, wounded, heal, {
    magicSkill: true,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(heal.fetchSkillType(), C4SkillRules.HEAL, 'Heal should resolve to HEAL instead of magic damage');
assert.strictEqual(wounded.fetchHp(), 89, 'Heal should restore datapack power without invented MAtk scaling');
assert.strictEqual(healOutcome.damage, 0, 'Heal should not be routed as damage');

const greaterHealData = activeSkills.find((entry) => entry.selfId === 1217);
assert(greaterHealData, 'Greater Heal should be present in active skills data');
assert.strictEqual(greaterHealData.levels.length, 33, 'Greater Heal should preserve sourced 33 base levels');
assert.strictEqual(greaterHealData.levels[0].power, 371, 'Greater Heal level 1 should use sourced power instead of aggro');
assert.strictEqual(greaterHealData.levels[32].power, 858, 'Greater Heal level 33 should preserve sourced power 858');
assert.strictEqual(greaterHealData.levels[32].mp, 120, 'Greater Heal level 33 MP should use sourced initial + consume total');
const greaterHealTarget = creature({ id: 2000010, hp: 100, maxHp: 1000 });
const greaterHeal = skill({ selfId: 1217, name: 'Greater Heal', spell: true, power: 858, level: 33 });
const greaterHealOutcome = SkillEffects.execute(session(), caster, greaterHealTarget, greaterHeal, {
    magicSkill: true,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(greaterHeal.fetchSkillType(), C4SkillRules.HEAL, 'Greater Heal should resolve to HEAL');
assert.strictEqual(greaterHealOutcome.heal, 858, 'Greater Heal level 33 should heal by sourced power 858');
assert.strictEqual(greaterHealTarget.fetchHp(), 958, 'Greater Heal should apply sourced power to target HP');

const greaterBattleHealData = activeSkills.find((entry) => entry.selfId === 1218);
assert(greaterBattleHealData, 'Greater Battle Heal should be present in active skills data');
assert.strictEqual(greaterBattleHealData.template.name, 'Greater Battle Heal', 'Greater Battle Heal should preserve sourced skill name');
assert.strictEqual(greaterBattleHealData.levels.length, 33, 'Greater Battle Heal should preserve sourced 33 base levels');
assert.strictEqual(greaterBattleHealData.levels[0].power, 371, 'Greater Battle Heal level 1 should use sourced power');
assert.strictEqual(greaterBattleHealData.levels[32].power, 858, 'Greater Battle Heal level 33 should preserve sourced power 858');
assert.strictEqual(greaterBattleHealData.levels[32].mp, 179, 'Greater Battle Heal level 33 MP should use sourced initial + consume total');
const greaterBattleHealTarget = creature({ id: 2000011, hp: 50, maxHp: 1200 });
const greaterBattleHeal = skill({ selfId: 1218, name: 'Greater Battle Heal', spell: true, power: 858, level: 33 });
const greaterBattleHealOutcome = SkillEffects.execute(session(), caster, greaterBattleHealTarget, greaterBattleHeal, {
    magicSkill: true,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(greaterBattleHeal.fetchSkillType(), C4SkillRules.HEAL, 'Greater Battle Heal should resolve to HEAL');
assert.strictEqual(greaterBattleHealOutcome.heal, 858, 'Greater Battle Heal level 33 should heal by sourced power 858');
assert.strictEqual(greaterBattleHealTarget.fetchHp(), 908, 'Greater Battle Heal should apply sourced power to target HP');

const greaterGroupHealData = activeSkills.find((entry) => entry.selfId === 1219);
assert(greaterGroupHealData, 'Greater Group Heal should be present in active skills data');
assert.strictEqual(greaterGroupHealData.levels.length, 33, 'Greater Group Heal should preserve sourced 33 base levels');
assert.strictEqual(greaterGroupHealData.levels[0].power, 297, 'Greater Group Heal level 1 should use sourced power instead of aggro');
assert.strictEqual(greaterGroupHealData.levels[32].power, 687, 'Greater Group Heal level 33 should preserve sourced power 687');
assert.strictEqual(greaterGroupHealData.levels[32].mp, 239, 'Greater Group Heal level 33 MP should use sourced initial + consume total');
const greaterGroupHealTarget = creature({ id: 2000012, hp: 100, maxHp: 1000 });
const greaterGroupHeal = skill({ selfId: 1219, name: 'Greater Group Heal', spell: true, power: 687, level: 33, distance: 600 });
const greaterGroupHealOutcome = SkillEffects.execute(session(), caster, greaterGroupHealTarget, greaterGroupHeal, {
    magicSkill: true,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(greaterGroupHeal.fetchSkillType(), C4SkillRules.HEAL, 'Greater Group Heal should resolve to HEAL');
assert.strictEqual(greaterGroupHeal.fetchTargetKind(), 'friendly', 'Greater Group Heal should remain castable on selected friendly targets until party-radius execution exists');
assert.strictEqual(greaterGroupHealOutcome.heal, 687, 'Greater Group Heal level 33 should heal by sourced power 687');
assert.strictEqual(greaterGroupHealTarget.fetchHp(), 787, 'Greater Group Heal should apply sourced power to target HP');

const blazeData = activeSkills.find((entry) => entry.selfId === 1220);
assert(blazeData, 'Blaze should be present in active skills data');
assert.strictEqual(blazeData.levels.length, 8, 'Blaze should preserve sourced 8 base levels');
assert.strictEqual(blazeData.levels[7].power, 44, 'Blaze level 8 should preserve sourced power 44');
assert.strictEqual(blazeData.levels[7].mp, 30, 'Blaze level 8 MP should use sourced initial + consume total');
const blaze = skill({ selfId: 1220, name: 'Blaze', spell: true, power: 44, level: 8, distance: 750 });
assert.strictEqual(blaze.fetchSkillType(), C4SkillRules.DAMAGE, 'Blaze should resolve to direct magic damage');
assert.strictEqual(blaze.fetchTargetKind(), 'enemy', 'Blaze should resolve as an enemy MDAM skill');
assert.strictEqual(blaze.fetchSemantic().trait, 'fire', 'Blaze should preserve sourced fire element semantics');
assert.strictEqual(blaze.fetchSsBoost(), 1, 'Blaze should preserve sourced offensive shot boost behavior');

const restoreTarget = creature({ id: 2000009, hp: 400, maxHp: 1000 });
caster.spiritshotLoaded = true;
const restoreLife = skill({ selfId: 1258, name: 'Restore Life', spell: true, power: 1, level: 4 });
const restoreOutcome = SkillEffects.execute(session(), caster, restoreTarget, restoreLife, {
    magicSkill: true,
    attack: { clearLoadedShot(actor, magic) { actor.clearedRestore = magic; actor.spiritshotLoaded = false; } }
});
assert.strictEqual(restoreLife.fetchSkillType(), C4SkillRules.HEAL_PERCENT, 'Restore Life should resolve to HEAL_PERCENT');
assert.strictEqual(restoreOutcome.heal, 300, 'Restore Life level 4 should restore sourced 30% of max HP');
assert.strictEqual(restoreTarget.fetchHp(), 700, 'Restore Life should apply the sourced percent heal instead of active.json power 1');
assert.strictEqual(caster.spiritshotLoaded, false, 'Restore Life should clear but not boost with spiritshot');

const benedictionData = activeSkills.find((entry) => entry.selfId === 1271);
assert(benedictionData, 'Benediction should be present in active skills data');
assert.strictEqual(benedictionData.levels[0].power, 100, 'Benediction active data should preserve sourced 100% heal power');
assert.strictEqual(benedictionData.time.reuse, 3600000, 'Benediction active data should preserve sourced one hour reuse');
const benediction = skill({ selfId: 1271, name: 'Benediction', spell: true, power: 1, level: 1 });
const highHpCleric = creature({ hp: 500, maxHp: 1000 });
const benedictionAttack = new Attack();
assert(
    benedictionAttack.skillUseConditionFailure(highHpCleric, benediction),
    'Benediction should be blocked above the sourced HP condition'
);
const lowHpCleric = creature({ hp: 250, maxHp: 1000 });
assert.strictEqual(
    benedictionAttack.skillUseConditionFailure(lowHpCleric, benediction),
    null,
    'Benediction should be allowed at the sourced 25% HP threshold'
);
const benedictionTarget = creature({ hp: 100, maxHp: 1000 });
const benedictionOutcome = SkillEffects.execute(session(), lowHpCleric, benedictionTarget, benediction, {
    magicSkill: true,
    attack: { clearLoadedShot(actor, magic) { actor.clearedBenediction = magic; } }
});
assert.strictEqual(benediction.fetchSkillType(), C4SkillRules.HEAL_PERCENT, 'Benediction should resolve to HEAL_PERCENT');
assert.strictEqual(benedictionOutcome.heal, 900, 'Benediction should restore up to 100% of max HP');
assert.strictEqual(benedictionTarget.fetchHp(), 1000, 'Benediction should clamp the 100% heal at max HP');

const rechargeData = activeSkills.find((entry) => entry.selfId === 1013);
assert(rechargeData, 'Recharge should be present in active skills data');
assert.strictEqual(rechargeData.levels.length, 32, 'Recharge should preserve sourced 32 base levels');
assert.strictEqual(rechargeData.levels[0].power, 49, 'Recharge level 1 should use sourced power instead of legacy half power');
assert.strictEqual(rechargeData.levels[31].power, 136, 'Recharge level 32 should preserve sourced power');
assert.strictEqual(rechargeData.levels[31].mp, 137, 'Recharge level 32 MP should use sourced initial + consume total');
const rechargeCaster = creature({ level: 20 });
const rechargeTarget = creature({ id: 2000010, mp: 10, maxMp: 200, level: 20 });
EffectStore.apply(rechargeTarget, {
    key: 'higher_mana_gain',
    id: 285,
    level: 1,
    type: 'passive',
    category: 'gainMp',
    stats: { gainMp: 22 },
    durationMs: 1200000
});
const recharge = skill({ selfId: 1013, name: 'Recharge', spell: true, power: 49, level: 1 });
const rechargeOutcome = SkillEffects.execute(session(), rechargeCaster, rechargeTarget, recharge, {
    magicSkill: true,
    attack: { clearLoadedShot(actor, magic) { actor.clearedRecharge = magic; } }
});
assert.strictEqual(recharge.fetchSkillType(), C4SkillRules.MANA_RECHARGE, 'Recharge should resolve to MANARECHARGE semantics');
assert.strictEqual(rechargeOutcome.mpRestore, 71, 'Recharge should add sourced gainMp to skill power');
assert.strictEqual(rechargeTarget.fetchMp(), 81, 'Recharge should restore MP on the target');
EffectStore.remove(rechargeTarget, 'higher_mana_gain');
const highLevelRechargeTarget = creature({ id: 2000011, mp: 10, maxMp: 200, level: 30 });
const penalizedRecharge = skill({ selfId: 1013, name: 'Recharge', spell: true, power: 100, level: 1 });
const penalizedRechargeOutcome = SkillEffects.execute(session(), rechargeCaster, highLevelRechargeTarget, penalizedRecharge, {
    magicSkill: true,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(penalizedRechargeOutcome.mpRestore, 50, 'Recharge should apply sourced target-caster level difference penalty');

const servitorRechargeData = activeSkills.find((entry) => entry.selfId === 1126);
assert(servitorRechargeData, 'Servitor Recharge should be present in active skills data');
assert.strictEqual(servitorRechargeData.levels.length, 34, 'Servitor Recharge should preserve sourced 34 base levels');
assert.strictEqual(servitorRechargeData.levels[0].power, 41, 'Servitor Recharge level 1 should use sourced power');
assert.strictEqual(servitorRechargeData.levels[33].mp, 137, 'Servitor Recharge level 34 MP should use sourced initial + consume total');
const servitorRecharge = skill({ selfId: 1126, name: 'Servitor Recharge', spell: true, power: 41, level: 1 });
assert.strictEqual(servitorRecharge.fetchSkillType(), C4SkillRules.MANA_RECHARGE, 'Servitor Recharge should resolve to MANARECHARGE semantics');
assert.strictEqual(servitorRecharge.fetchTargetKind(), 'pet', 'Servitor Recharge should preserve sourced TARGET_PET semantics');

const servitorMagicShieldData = activeSkills.find((entry) => entry.selfId === 1139);
assert(servitorMagicShieldData, 'Servitor Magic Shield should be present in active skills data');
assert.strictEqual(servitorMagicShieldData.levels[0].mp, 39, 'Servitor Magic Shield level 1 MP should use sourced initial + consume total');
const servitorMagicShieldTarget = statActor();
const servitorMagicShield = skill({ selfId: 1139, name: 'Servitor Magic Shield', spell: true, power: 1, level: 2, buff: 1200000 });
const servitorMagicShieldOutcome = SkillEffects.execute(session(), caster, servitorMagicShieldTarget, servitorMagicShield, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(servitorMagicShield.fetchTargetKind(), 'pet', 'Servitor Magic Shield should preserve sourced TARGET_PET semantics');
assert.strictEqual(servitorMagicShieldOutcome.effect.key, 'servitor_magic_shield', 'Servitor Magic Shield should apply a structured pet buff');
assert.strictEqual(EffectStats.multiplier(servitorMagicShieldTarget, 'mDefMul'), 1.3, 'Servitor Magic Shield level 2 should use sourced mDef 1.3');

const servitorPhysicalShieldData = activeSkills.find((entry) => entry.selfId === 1140);
assert(servitorPhysicalShieldData, 'Servitor Physical Shield should be present in active skills data');
assert.strictEqual(servitorPhysicalShieldData.levels[2].mp, 52, 'Servitor Physical Shield level 3 MP should use sourced initial + consume total');
const servitorPhysicalShieldTarget = statActor();
const servitorPhysicalShield = skill({ selfId: 1140, name: 'Servitor Physical Shield', spell: true, power: 1, level: 3, buff: 1200000 });
const servitorPhysicalShieldOutcome = SkillEffects.execute(session(), caster, servitorPhysicalShieldTarget, servitorPhysicalShield, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(servitorPhysicalShield.fetchTargetKind(), 'pet', 'Servitor Physical Shield should preserve sourced TARGET_PET semantics');
assert.strictEqual(servitorPhysicalShieldOutcome.effect.key, 'servitor_physical_shield', 'Servitor Physical Shield should apply a structured pet buff');
assert.strictEqual(EffectStats.multiplier(servitorPhysicalShieldTarget, 'pDefMul'), 1.15, 'Servitor Physical Shield level 3 should use sourced pDef 1.15');

const servitorHasteData = activeSkills.find((entry) => entry.selfId === 1141);
assert(servitorHasteData, 'Servitor Haste should be present in active skills data');
assert.strictEqual(servitorHasteData.levels[0].mp, 39, 'Servitor Haste level 1 MP should use sourced initial + consume total');
const servitorHasteTarget = statActor();
const servitorHaste = skill({ selfId: 1141, name: 'Servitor Haste', spell: true, power: 1, level: 1, buff: 1200000 });
const servitorHasteOutcome = SkillEffects.execute(session(), caster, servitorHasteTarget, servitorHaste, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(servitorHaste.fetchTargetKind(), 'pet', 'Servitor Haste should preserve sourced TARGET_PET semantics');
assert.strictEqual(servitorHasteOutcome.effect.key, 'servitor_haste', 'Servitor Haste should apply a structured pet buff');
assert.strictEqual(EffectStats.multiplier(servitorHasteTarget, 'pAtkSpdMul'), 1.15, 'Servitor Haste level 1 should use sourced pAtkSpd 1.15');

const servitorWindWalkData = activeSkills.find((entry) => entry.selfId === 1144);
assert(servitorWindWalkData, 'Servitor Wind Walk should be present in active skills data');
assert.strictEqual(servitorWindWalkData.levels[1].mp, 46, 'Servitor Wind Walk level 2 MP should use sourced initial + consume total');
const servitorWindWalkTarget = statActor();
const servitorWindWalk = skill({ selfId: 1144, name: 'Servitor Wind Walk', spell: true, power: 1, level: 2, buff: 1200000 });
const servitorWindWalkOutcome = SkillEffects.execute(session(), caster, servitorWindWalkTarget, servitorWindWalk, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(servitorWindWalk.fetchTargetKind(), 'pet', 'Servitor Wind Walk should preserve sourced TARGET_PET semantics');
assert.strictEqual(servitorWindWalkOutcome.effect.key, 'servitor_wind_walk', 'Servitor Wind Walk should apply a structured pet buff');
assert.strictEqual(EffectStats.add(servitorWindWalkTarget, 'runSpdAdd'), 33, 'Servitor Wind Walk level 2 should use sourced runSpd +33');

const brightServitorData = activeSkills.find((entry) => entry.selfId === 1145);
assert(brightServitorData, 'Bright Servitor should be present in active skills data');
assert.strictEqual(brightServitorData.levels[2].mp, 54, 'Bright Servitor level 3 MP should use sourced initial + consume total');
const brightServitorTarget = statActor();
const brightServitor = skill({ selfId: 1145, name: 'Bright Servitor', spell: true, power: 1, level: 3, buff: 1200000 });
const brightServitorOutcome = SkillEffects.execute(session(), caster, brightServitorTarget, brightServitor, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(brightServitor.fetchTargetKind(), 'pet', 'Bright Servitor should preserve sourced TARGET_PET semantics');
assert.strictEqual(brightServitorOutcome.effect.key, 'bright_servitor', 'Bright Servitor should apply a structured pet buff');
assert.strictEqual(EffectStats.multiplier(brightServitorTarget, 'mAtkMul'), 1.75, 'Bright Servitor level 3 should use sourced mAtk 1.75');

const mightyServitorData = activeSkills.find((entry) => entry.selfId === 1146);
assert(mightyServitorData, 'Mighty Servitor should be present in active skills data');
assert.strictEqual(mightyServitorData.levels[1].mp, 46, 'Mighty Servitor level 2 MP should use sourced initial + consume total');
const mightyServitorTarget = statActor();
const mightyServitor = skill({ selfId: 1146, name: 'Mighty Servitor', spell: true, power: 1, level: 2, buff: 1200000 });
const mightyServitorOutcome = SkillEffects.execute(session(), caster, mightyServitorTarget, mightyServitor, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(mightyServitor.fetchTargetKind(), 'pet', 'Mighty Servitor should preserve sourced TARGET_PET semantics');
assert.strictEqual(mightyServitorOutcome.effect.key, 'mighty_servitor', 'Mighty Servitor should apply a structured pet buff');
assert.strictEqual(EffectStats.multiplier(mightyServitorTarget, 'pAtkMul'), 1.12, 'Mighty Servitor level 2 should use sourced pAtk 1.12');

const sleepyTarget = creature({ id: 1000001, hp: 100, maxHp: 100, level: 20 });
const sleep = skill({ selfId: 1069, name: 'Sleep', spell: true, power: 1, buff: 30000 });
const sleepSession = session();
const sleepOutcome = SkillEffects.execute(sleepSession, caster, sleepyTarget, sleep, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(sleepOutcome.effect.key, 'sleep', 'Sleep should apply a structured sleep debuff');
assert(EffectStore.hasDebuff(sleepyTarget, 'sleep'), 'Sleep debuff should be visible through EffectStore');
assert.strictEqual(sleepSession.packets[0][0], 0x7f, 'Debuff application should refresh abnormal status icons');

const sleepingCloudData = activeSkills.find((entry) => entry.selfId === 1072);
assert(sleepingCloudData, 'Sleeping Cloud should be present in active skills data');
assert.strictEqual(sleepingCloudData.levels.length, 5, 'Sleeping Cloud should preserve sourced 5 base levels');
assert.strictEqual(sleepingCloudData.levels[0].power, 40, 'Sleeping Cloud should preserve sourced power 40');
assert.strictEqual(sleepingCloudData.levels[4].mp, 98, 'Sleeping Cloud level 5 MP should use sourced initial + consume total');
const sleepingCloudTarget = creature({ id: 1000010, hp: 100, maxHp: 100, level: 20 });
const sleepingCloud = skill({ selfId: 1072, name: 'Sleeping Cloud', spell: true, power: 40, level: 5, buff: 30000, distance: 500 });
const sleepingCloudOutcome = SkillEffects.execute(session(), caster, sleepingCloudTarget, sleepingCloud, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(sleepingCloud.fetchTargetKind(), 'enemy', 'Sleeping Cloud should resolve as an enemy sleep debuff');
assert.strictEqual(sleepingCloudOutcome.effect.key, 'sleep', 'Sleeping Cloud should apply a structured sleep debuff');

const dreamingSpiritData = activeSkills.find((entry) => entry.selfId === 1097);
assert(dreamingSpiritData, 'Dreaming Spirit should be present in active skills data');
assert.strictEqual(dreamingSpiritData.levels.length, 20, 'Dreaming Spirit should preserve sourced 20 base levels');
assert.strictEqual(dreamingSpiritData.levels[0].power, 80, 'Dreaming Spirit should preserve sourced power 80');
assert.strictEqual(dreamingSpiritData.levels[1].mp, 15, 'Dreaming Spirit level 2 MP should use sourced initial + consume total');
assert.strictEqual(dreamingSpiritData.levels[19].mp, 69, 'Dreaming Spirit level 20 MP should use sourced initial + consume total');
const dreamingTarget = creature({ id: 1000006, hp: 100, maxHp: 100, level: 20 });
const dreamingSpirit = skill({ selfId: 1097, name: 'Dreaming Spirit', spell: true, power: 80, level: 20, buff: 30000 });
const dreamingOutcome = SkillEffects.execute(session(), caster, dreamingTarget, dreamingSpirit, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(dreamingSpirit.fetchTargetKind(), 'enemy', 'Dreaming Spirit should resolve as an enemy sleep debuff');
assert.strictEqual(dreamingOutcome.effect.key, 'sleep', 'Dreaming Spirit should apply a structured sleep debuff');
assert(EffectStore.hasDebuff(dreamingTarget, 'sleep'), 'Dreaming Spirit sleep should be visible through EffectStore');

const madnessData = activeSkills.find((entry) => entry.selfId === 1105);
assert(madnessData, 'Madness should be present in active skills data');
assert.strictEqual(madnessData.levels.length, 18, 'Madness should preserve sourced 18 base levels');
assert.strictEqual(madnessData.time.reuse, 40000, 'Madness should preserve sourced 40000ms reuse');
assert.strictEqual(madnessData.time.buff, 30000, 'Madness should preserve sourced Confusion count/time duration');
assert.strictEqual(madnessData.levels[1].mp, 23, 'Madness level 2 MP should use sourced initial + consume total');
assert.strictEqual(madnessData.levels[17].mp, 69, 'Madness level 18 MP should use sourced initial + consume total');
const playerMadnessTarget = creature({ id: 1000008, hp: 100, maxHp: 100, level: 20 });
const madness = skill({ selfId: 1105, name: 'Madness', spell: true, level: 18, buff: 30000 });
const playerMadnessOutcome = SkillEffects.execute(session(), caster, playerMadnessTarget, madness, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(playerMadnessOutcome.effect, null, 'Madness should not apply CONFUSE_MOB_ONLY to non-attackable targets');
assert.strictEqual(playerMadnessOutcome.effectResisted, true, 'Madness mob-only rejection should report effect resistance');
const mobMadnessTarget = creature({ id: 1000009, hp: 100, maxHp: 100, level: 20 });
mobMadnessTarget.fetchAttackable = () => true;
const mobMadnessOutcome = SkillEffects.execute(session(), caster, mobMadnessTarget, madness, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(madness.fetchTargetKind(), 'enemy', 'Madness should resolve as an enemy mob-only debuff');
assert.strictEqual(mobMadnessOutcome.effect.key, 'confusion', 'Madness should apply a structured confusion debuff to attackable NPCs');
assert.strictEqual(EffectStore.impairments(mobMadnessTarget).confused, true, 'Madness confusion should be visible through impairments');

const silenceData = activeSkills.find((entry) => entry.selfId === 1064);
assert(silenceData, 'Silence should be present in active skills data');
assert.strictEqual(silenceData.levels.length, 14, 'Silence should preserve sourced 14 base levels');
assert.strictEqual(silenceData.time.reuse, 60000, 'Silence should preserve sourced 60 second reuse');
assert.strictEqual(silenceData.levels[13].mp, 69, 'Silence level 14 MP should use sourced initial + consume total');
const mutedTarget = creature({ id: 1000007, hp: 100, maxHp: 100, level: 20 });
const silence = skill({ selfId: 1064, name: 'Silence', spell: true, power: 80, level: 1, buff: 120000 });
const silenceOutcome = SkillEffects.execute(session(), caster, mutedTarget, silence, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(silence.fetchTargetKind(), 'enemy', 'Silence should resolve as an enemy mute debuff');
assert.strictEqual(silenceOutcome.effect.key, 'silence', 'Silence should apply a structured mute debuff');
assert(EffectStore.hasDebuff(mutedTarget, 'silence'), 'Silence debuff should be visible through EffectStore');

const shieldTarget = creature({ id: 2000003 });
const shield = skill({ selfId: 1040, name: 'Shield', spell: true, power: 1, buff: 1200000 });
const shieldOutcome = SkillEffects.execute(session(), caster, shieldTarget, shield, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(shield.fetchTargetKind(), 'friendly', 'Shield should resolve as a friendly buff, not a self-only effect');
assert.strictEqual(shieldOutcome.effect.key, 'shield', 'Shield should apply the existing BuffCatalog key');
assert(shieldTarget.activeBuffs.shield > Date.now(), 'Skill-cast Shield should feed activeBuffs for stat modifiers');

const shieldStatsTarget = statActor();
const shieldLevelOne = skill({ selfId: 1040, name: 'Shield', spell: true, power: 1, level: 1, buff: 1200000 });
SkillEffects.execute(session(), caster, shieldStatsTarget, shieldLevelOne, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(EffectStats.multiplier(shieldStatsTarget, 'pDefMul'), 1.08, 'Shield level 1 should use sourced pDef 1.08');
assert(shieldStatsTarget.activeBuffs.shield > Date.now(), 'Structured Shield should still feed legacy activeBuffs for UI and bot state');
calculateStats({}, shieldStatsTarget);
assert.strictEqual(
    shieldStatsTarget.collectivePDef,
    Math.round(Formulas.calcPDef(20, 100) * 1.08),
    'Shield level 1 should not receive the legacy BuffCatalog level 2 multiplier on top'
);

const mightStatsTarget = statActor();
const mightLevelOne = skill({ selfId: 1068, name: 'Might', spell: true, power: 1, level: 1, buff: 1200000 });
SkillEffects.execute(session(), caster, mightStatsTarget, mightLevelOne, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(EffectStats.multiplier(mightStatsTarget, 'pAtkMul'), 1.08, 'Might level 1 should use sourced pAtk 1.08');
calculateStats({}, mightStatsTarget);
assert.strictEqual(
    mightStatsTarget.collectivePAtk,
    Math.round(Formulas.calcPAtk(20, 30, 100) * 1.08),
    'Might level 1 should not receive the legacy BuffCatalog level 2 multiplier on top'
);

const hasteStatsTarget = statActor();
const hasteLevelOne = skill({ selfId: 1086, name: 'Haste', spell: true, power: 1, level: 1, buff: 1200000 });
SkillEffects.execute(session(), caster, hasteStatsTarget, hasteLevelOne, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(EffectStats.multiplier(hasteStatsTarget, 'pAtkSpdMul'), 1.15, 'Haste level 1 should use sourced pAtkSpd 1.15');
calculateStats({}, hasteStatsTarget);
assert.strictEqual(
    hasteStatsTarget.collectiveAtkSpd,
    Math.round(Math.round(Formulas.calcAtkSpd(30, 300)) * 1.15),
    'Haste level 1 should not receive the legacy BuffCatalog level 2 multiplier on top'
);

const windWalkStatsTarget = statActor();
const windWalkLevelOne = skill({ selfId: 1204, name: 'Wind Walk', spell: true, power: 1, level: 1, buff: 1200000 });
SkillEffects.execute(session(), caster, windWalkStatsTarget, windWalkLevelOne, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(EffectStats.add(windWalkStatsTarget, 'runSpdAdd'), 20, 'Wind Walk level 1 should use sourced runSpd +20');
calculateStats({}, windWalkStatsTarget);
assert.strictEqual(
    windWalkStatsTarget.collectiveRunSpd,
    Formulas.calcSpeed(30, 120) + 20,
    'Wind Walk level 1 should not receive the legacy BuffCatalog level 2 addition on top'
);

const resistTarget = creature({ id: 1000002, level: 80 });
const windStrike = skill({ selfId: 1177, name: 'Wind Strike', spell: true, power: 12 });
const resisted = SkillEffects.execute(session(), creature({ level: 1 }), resistTarget, windStrike, {
    magicSkill: true,
    rng: () => 0.99,
    attack: { clearLoadedShot(actor, magic) { actor.clearedMagic = magic; } }
});
assert.strictEqual(resisted.resisted, true, 'Offensive magic should be able to fail against high-resist targets');
assert.strictEqual(resisted.damage, 0, 'Resisted magic should not deal damage');

const blowCaster = creature({ pAtk: 100, x: 100, y: 0 });
blowCaster.soulshotLoaded = true;
const blowTarget = creature({ id: 1000003, hp: 1000, maxHp: 1000, pDef: 100, head: 32768 });
const deadly = skill({ selfId: 263, name: 'Deadly Blow', spell: false, power: 1107, distance: 40 });
const blowOutcome = SkillEffects.execute(session(), blowCaster, blowTarget, deadly, {
    magicSkill: false,
    rng: () => 0,
    attack: {
        clearLoadedShot(actor) { actor.soulshotLoaded = false; },
        isBehindTarget: () => true,
        prepareSkillDamage: () => 200
    }
});
assert.strictEqual(deadly.fetchSkillType(), C4SkillRules.BLOW, 'Deadly Blow should resolve to BLOW');
assert.strictEqual(blowOutcome.lethal, true, 'Deadly Blow should be able to trigger lethal half-kill');
assert.strictEqual(blowOutcome.damage, 500, 'Lethal half-kill should raise damage to half of target max HP when larger');

const debuffed = statActor();
const hex = skill({ selfId: 122, name: 'Hex', spell: true, power: 1, level: 1, buff: 30000 });
SkillEffects.execute(session(), caster, debuffed, hex, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
calculateStats({}, debuffed);
assert.strictEqual(
    debuffed.collectivePDef,
    Math.round(Formulas.calcPDef(20, 100) * 0.77),
    'Hex should apply the L2J pDefDown 0.77 stat multiplier'
);

const powerBroken = statActor();
const powerBreak = skill({ selfId: 115, name: 'Power Break', spell: true, power: 1, level: 3, buff: 30000 });
SkillEffects.execute(session(), caster, powerBroken, powerBreak, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
calculateStats({}, powerBroken);
assert.strictEqual(
    powerBroken.collectivePAtk,
    Math.round(Formulas.calcPAtk(20, 30, 100) * 0.77),
    'Power Break level 3 should apply the L2J pAtkDown 0.77 stat multiplier'
);

const slowData = activeSkills.find((entry) => entry.selfId === 1160);
assert(slowData, 'Slow should be present in active skills data');
assert.strictEqual(slowData.levels.length, 15, 'Slow should preserve sourced 15 base levels');
assert.strictEqual(slowData.levels[0].power, 80, 'Slow active data should preserve sourced power 80');
assert.strictEqual(slowData.levels[14].mp, 69, 'Slow level 15 MP should use sourced initial + consume total');
const slowed = statActor();
const slow = skill({ selfId: 1160, name: 'Slow', spell: true, power: 80, level: 2, buff: 120000 });
const slowOutcome = SkillEffects.execute(session(), caster, slowed, slow, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(slow.fetchTargetKind(), 'enemy', 'Slow should resolve as an enemy debuff');
assert.strictEqual(slowOutcome.effect.key, 'slow', 'Slow should apply a structured debuff effect');
assert.strictEqual(EffectStats.multiplier(slowed, 'runSpdMul'), 0.5, 'Slow level 2 should use sourced C4 runSpd 0.5');
calculateStats({}, slowed);
assert.strictEqual(
    slowed.collectiveRunSpd,
    Math.round(Formulas.calcSpeed(30, 120) * 0.5),
    'Slow level 2 should apply the sourced C4 run speed multiplier'
);

const curseWeaknessData = activeSkills.find((entry) => entry.selfId === 1164);
assert(curseWeaknessData, 'Curse:Weakness should be present in active skills data');
assert.strictEqual(curseWeaknessData.levels.length, 19, 'Curse:Weakness should preserve sourced 19 base levels');
assert.strictEqual(curseWeaknessData.time.hitTime, 1500, 'Curse:Weakness should preserve sourced 1500ms hit time');
assert.strictEqual(curseWeaknessData.time.buff, 15000, 'Curse:Weakness should preserve sourced 15 second duration');
assert.strictEqual(curseWeaknessData.levels[0].mp, 3, 'Curse:Weakness level 1 MP should use sourced initial + consume total');
assert.strictEqual(curseWeaknessData.levels[18].mp, 69, 'Curse:Weakness level 19 MP should use sourced initial + consume total');
const weakened = statActor();
const curseWeakness = skill({ selfId: 1164, name: 'Curse:Weakness', spell: true, power: 80, level: 6, buff: 15000 });
const curseWeaknessOutcome = SkillEffects.execute(session(), caster, weakened, curseWeakness, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(curseWeakness.fetchTargetKind(), 'enemy', 'Curse:Weakness should resolve as an enemy debuff');
assert.strictEqual(curseWeaknessOutcome.effect.key, 'curse_weakness', 'Curse:Weakness should apply a structured debuff effect');
assert.strictEqual(EffectStats.multiplier(weakened, 'pAtkMul'), 0.77, 'Curse:Weakness level 6 should use sourced pAtk 0.77');
calculateStats({}, weakened);
assert.strictEqual(
    weakened.collectivePAtk,
    Math.round(Formulas.calcPAtk(20, 30, 100) * 0.77),
    'Curse:Weakness level 6 should apply the sourced pAtk multiplier'
);

const sealSlowData = activeSkills.find((entry) => entry.selfId === 1099);
assert(sealSlowData, 'Seal of Slow should be present in active skills data');
assert.strictEqual(sealSlowData.levels.length, 15, 'Seal of Slow should preserve sourced 15 base levels');
assert.strictEqual(sealSlowData.levels[0].power, 40, 'Seal of Slow active data should preserve sourced power 40');
assert.strictEqual(sealSlowData.levels[14].mp, 103, 'Seal of Slow level 15 MP should use sourced initial + consume total');
const sealSlowed = statActor();
const sealSlow = skill({ selfId: 1099, name: 'Seal of Slow', spell: true, power: 40, level: 2, buff: 120000 });
const sealSlowOutcome = SkillEffects.execute(session(), caster, sealSlowed, sealSlow, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(sealSlow.fetchTargetKind(), 'enemy', 'Seal of Slow should resolve as an enemy debuff');
assert.strictEqual(sealSlowOutcome.effect.key, 'seal_of_slow', 'Seal of Slow should apply a structured debuff effect');
assert.strictEqual(EffectStats.multiplier(sealSlowed, 'runSpdMul'), 0.5, 'Seal of Slow level 2 should use sourced C4 runSpd 0.5');
calculateStats({}, sealSlowed);
assert.strictEqual(
    sealSlowed.collectiveRunSpd,
    Math.round(Formulas.calcSpeed(30, 120) * 0.5),
    'Seal of Slow level 2 should apply the sourced C4 run speed multiplier'
);

const sealChaosData = activeSkills.find((entry) => entry.selfId === 1096);
assert(sealChaosData, 'Seal of Chaos should be present in active skills data');
assert.strictEqual(sealChaosData.levels.length, 16, 'Seal of Chaos should preserve sourced 16 base levels');
assert.strictEqual(sealChaosData.time.hitTime, 1500, 'Seal of Chaos should preserve sourced 1500ms hit time');
assert.strictEqual(sealChaosData.time.reuse, 8000, 'Seal of Chaos should preserve sourced 8000ms reuse');
assert.strictEqual(sealChaosData.time.buff, 15000, 'Seal of Chaos should preserve sourced 15 second duration');
assert.strictEqual(sealChaosData.levels[0].mp, 20, 'Seal of Chaos level 1 MP should use sourced initial + consume total');
assert.strictEqual(sealChaosData.levels[15].mp, 103, 'Seal of Chaos level 16 MP should use sourced initial + consume total');
const chaosed = statActor();
const sealChaos = skill({ selfId: 1096, name: 'Seal of Chaos', spell: true, power: 40, level: 16, buff: 15000 });
const sealChaosOutcome = SkillEffects.execute(session(), caster, chaosed, sealChaos, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(sealChaos.fetchTargetKind(), 'enemy', 'Seal of Chaos should resolve as an enemy debuff');
assert.strictEqual(sealChaosOutcome.effect.key, 'seal_of_chaos', 'Seal of Chaos should apply a structured debuff effect');
assert.strictEqual(EffectStats.add(chaosed, 'pAccuracyCombatAdd'), -13, 'Seal of Chaos level 16 should use sourced C4 accCombat -13');
calculateStats({}, chaosed);
assert.strictEqual(
    chaosed.collectiveAccur,
    Formulas.calcAccur(20, 30, 5) - 13,
    'Seal of Chaos level 16 should apply the sourced C4 accuracy subtraction'
);

const curseChaosData = activeSkills.find((entry) => entry.selfId === 1222);
assert(curseChaosData, 'Curse Chaos should be present in active skills data');
assert.strictEqual(curseChaosData.time.hitTime, 1500, 'Curse Chaos should preserve sourced 1500ms hit time');
assert.strictEqual(curseChaosData.time.reuse, 8000, 'Curse Chaos should preserve sourced 8000ms reuse');
assert.strictEqual(curseChaosData.time.buff, 15000, 'Curse Chaos should preserve sourced 15 second Debuff duration');
assert.strictEqual(curseChaosData.levels.length, 15, 'Curse Chaos should preserve sourced 15 base levels');
assert.strictEqual(curseChaosData.levels[0].power, 80, 'Curse Chaos should preserve sourced power 80');
assert.strictEqual(curseChaosData.levels[14].mp, 69, 'Curse Chaos level 15 MP should use sourced initial + consume total');
const curseChaosed = statActor();
const curseChaos = skill({ selfId: 1222, name: 'Curse Chaos', spell: true, power: 80, level: 15, distance: 600, buff: 15000 });
const curseChaosOutcome = SkillEffects.execute(session(), caster, curseChaosed, curseChaos, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(curseChaos.fetchTargetKind(), 'enemy', 'Curse Chaos should resolve as an enemy accuracy debuff');
assert.strictEqual(curseChaosOutcome.effect.key, 'curse_chaos', 'Curse Chaos should apply a structured accuracy debuff');
assert.strictEqual(EffectStats.add(curseChaosed, 'pAccuracyCombatAdd'), -13, 'Curse Chaos level 15 should use sourced accCombat -13');
calculateStats({}, curseChaosed);
assert.strictEqual(
    curseChaosed.collectiveAccur,
    Formulas.calcAccur(20, 30, 5) - 13,
    'Curse Chaos level 15 should apply the sourced C4 accuracy subtraction'
);

const surrenderEarthData = activeSkills.find((entry) => entry.selfId === 1223);
assert(surrenderEarthData, 'Surrender To Earth should be present in active skills data');
assert.strictEqual(surrenderEarthData.template.distance, 900, 'Surrender To Earth should use sourced 900 cast range for trained levels');
assert.strictEqual(surrenderEarthData.time.hitTime, 1500, 'Surrender To Earth should preserve sourced 1500ms hit time');
assert.strictEqual(surrenderEarthData.time.reuse, 8000, 'Surrender To Earth should preserve sourced 8000ms reuse');
assert.strictEqual(surrenderEarthData.time.buff, 15000, 'Surrender To Earth should preserve sourced 15 second Debuff duration');
assert.strictEqual(surrenderEarthData.levels.length, 15, 'Surrender To Earth should preserve sourced 15 base levels');
assert.strictEqual(surrenderEarthData.levels[0].power, 80, 'Surrender To Earth should preserve sourced power 80');
assert.strictEqual(surrenderEarthData.levels[14].mp, 69, 'Surrender To Earth level 15 MP should use sourced initial + consume total');
const surrenderedToEarth = creature({ id: 2000017, mDef: 50 });
const surrenderEarth = skill({ selfId: 1223, name: 'Surrender To Earth', spell: true, power: 80, level: 15, distance: 900, buff: 15000 });
const surrenderEarthOutcome = SkillEffects.execute(session(), caster, surrenderedToEarth, surrenderEarth, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(surrenderEarth.fetchTargetKind(), 'enemy', 'Surrender To Earth should resolve as an enemy weakness debuff');
assert.strictEqual(surrenderEarth.fetchSemantic().trait, 'earth', 'Surrender To Earth should preserve sourced earth weakness semantics');
assert.strictEqual(surrenderEarthOutcome.effect.key, 'surrender_to_earth', 'Surrender To Earth should apply a structured earth weakness debuff');
assert.strictEqual(EffectStats.multiplier(surrenderedToEarth, 'earthVuln'), 1.3, 'Surrender To Earth level 15 should use sourced earthVuln 1.3');
const earthNuke = {
    fetchPower: () => 10,
    fetchSemantic: () => ({ trait: 'earth' })
};
assert.strictEqual(
    new Attack().prepareSkillDamage(caster, surrenderedToEarth, earthNuke, true, () => 0.99),
    Math.round(Formulas.calcMagicDamage(100, 10, 50) * 1.3),
    'Surrender To Earth should amplify earth-trait magic damage by the sourced earthVuln multiplier'
);

const surrenderPoisonData = activeSkills.find((entry) => entry.selfId === 1224);
assert(surrenderPoisonData, 'Surrender To Poison should be present in active skills data');
assert.strictEqual(surrenderPoisonData.template.distance, 900, 'Surrender To Poison should use sourced 900 cast range for trained levels');
assert.strictEqual(surrenderPoisonData.time.hitTime, 1500, 'Surrender To Poison should preserve sourced 1500ms hit time');
assert.strictEqual(surrenderPoisonData.time.reuse, 8000, 'Surrender To Poison should preserve sourced 8000ms reuse');
assert.strictEqual(surrenderPoisonData.time.buff, 15000, 'Surrender To Poison should preserve sourced 15 second Debuff duration');
assert.strictEqual(surrenderPoisonData.levels.length, 17, 'Surrender To Poison should preserve sourced 17 base levels');
assert.strictEqual(surrenderPoisonData.levels[0].mp, 12, 'Surrender To Poison level 1 MP should use sourced initial + consume total');
assert.strictEqual(surrenderPoisonData.levels[16].mp, 69, 'Surrender To Poison level 17 MP should use sourced initial + consume total');
const surrenderedToPoison = creature({ id: 2000018, mDef: 100 });
const surrenderPoison = skill({ selfId: 1224, name: 'Surrender To Poison', spell: true, power: 80, level: 17, distance: 900, buff: 15000 });
const surrenderPoisonOutcome = SkillEffects.execute(session(), caster, surrenderedToPoison, surrenderPoison, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(surrenderPoison.fetchTargetKind(), 'enemy', 'Surrender To Poison should resolve as an enemy weakness debuff');
assert.strictEqual(surrenderPoison.fetchSemantic().trait, 'poison', 'Surrender To Poison should preserve sourced poison weakness semantics');
assert.strictEqual(surrenderPoisonOutcome.effect.key, 'surrender_to_poison', 'Surrender To Poison should apply a structured poison weakness debuff');
assert.strictEqual(EffectStats.multiplier(surrenderedToPoison, 'poisonVuln'), 1.3, 'Surrender To Poison level 17 should use sourced poisonVuln 1.3');
const poisonAfterSurrender = skill({ selfId: 129, name: 'Poison', spell: true, power: 3, level: 1, buff: 30000 });
const poisonAfterSurrenderOutcome = SkillEffects.execute(session(), caster, surrenderedToPoison, poisonAfterSurrender, {
    magicSkill: true,
    rng: () => 0.8,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(poisonAfterSurrenderOutcome.effect.key, 'poison', 'Surrender To Poison should raise poison effect land chance through sourced poisonVuln');
EffectStore.remove(surrenderedToPoison, 'poison');

const summonStormCubicData = activeSkills.find((entry) => entry.selfId === 10);
assert(summonStormCubicData, 'Summon Storm Cubic should be present in active skills data');
assert.strictEqual(summonStormCubicData.time.hitTime, 6000, 'Summon Storm Cubic should preserve sourced 6000ms hit time');
assert.strictEqual(summonStormCubicData.summon.totalLifeTime, 900000, 'Summon Storm Cubic should preserve sourced cubic lifetime');
assert.strictEqual(summonStormCubicData.summon.expPenalty, 0, 'Summon Storm Cubic should preserve sourced zero exp penalty');
assert.strictEqual(summonStormCubicData.summon.isCubic, true, 'Summon Storm Cubic should preserve sourced cubic flag');
assert.strictEqual(summonStormCubicData.summon.npcId, 1, 'Summon Storm Cubic should preserve sourced cubic npcId');
assert.strictEqual(summonStormCubicData.summon.activationChance, 12, 'Summon Storm Cubic should preserve sourced activation chance');
assert.strictEqual(summonStormCubicData.summon.activationTime, 10, 'Summon Storm Cubic should preserve sourced activation time');
assert.strictEqual(summonStormCubicData.levels.length, 8, 'Summon Storm Cubic should preserve sourced 8 base levels');
assert.strictEqual(summonStormCubicData.levels[0].power, 282, 'Summon Storm Cubic level 1 should preserve sourced cubic power');
assert.strictEqual(summonStormCubicData.levels[0].mp, 35, 'Summon Storm Cubic level 1 MP should use sourced initial + consume total');
assert.strictEqual(summonStormCubicData.levels[0].itemCount, 5, 'Summon Storm Cubic level 1 should preserve sourced crystal count');
assert.strictEqual(summonStormCubicData.levels[7].power, 1975, 'Summon Storm Cubic level 8 should preserve sourced cubic power');
assert.strictEqual(summonStormCubicData.levels[7].mp, 69, 'Summon Storm Cubic level 8 MP should use sourced initial + consume total');
assert.strictEqual(summonStormCubicData.levels[7].itemCount, 14, 'Summon Storm Cubic level 8 should preserve sourced crystal count');
const summonStormCubic = skill({ selfId: 10, name: 'Summon Storm Cubic', spell: true, power: 1975, level: 8, distance: -1 });
assert.strictEqual(summonStormCubic.fetchSkillType(), C4SkillRules.SUMMON, 'Summon Storm Cubic should resolve to SUMMON instead of magic damage');
assert.strictEqual(summonStormCubic.fetchTargetKind(), 'self', 'Summon Storm Cubic should preserve sourced TARGET_SELF semantics');
assert.strictEqual(summonStormCubic.fetchSsBoost(), 0, 'Summon Storm Cubic should not consume offensive shot boost semantics');

const summonSiegeGolemData = activeSkills.find((entry) => entry.selfId === 13);
assert(summonSiegeGolemData, 'Summon Siege Golem should be present in active skills data');
assert.strictEqual(summonSiegeGolemData.time.hitTime, 300000, 'Summon Siege Golem should preserve sourced 300000ms hit time');
assert.strictEqual(summonSiegeGolemData.summon.totalLifeTime, 1200000, 'Summon Siege Golem should preserve sourced summon lifetime');
assert.strictEqual(summonSiegeGolemData.summon.timeLostIdle, 1000, 'Summon Siege Golem should preserve sourced idle time loss');
assert.strictEqual(summonSiegeGolemData.summon.timeLostActive, 1000, 'Summon Siege Golem should preserve sourced active time loss');
assert.strictEqual(summonSiegeGolemData.summon.expPenalty, 0, 'Summon Siege Golem should preserve sourced zero exp penalty');
assert.strictEqual(summonSiegeGolemData.summon.itemConsumeSteps, 20, 'Summon Siege Golem should preserve sourced summon crystal consume step mode');
assert.strictEqual(summonSiegeGolemData.summon.itemIdOT, 2131, 'Summon Siege Golem should preserve sourced ongoing fuel item id');
assert.strictEqual(summonSiegeGolemData.summon.requiresSiegeAttacker, true, 'Summon Siege Golem should preserve sourced siege attacker condition');
assert.strictEqual(summonSiegeGolemData.levels.length, 1, 'Summon Siege Golem should preserve sourced single base level');
assert.strictEqual(summonSiegeGolemData.levels[0].mp, 530, 'Summon Siege Golem MP should preserve sourced initial consume');
assert.strictEqual(summonSiegeGolemData.levels[0].itemId, 1459, 'Summon Siege Golem should preserve sourced crystal item id');
assert.strictEqual(summonSiegeGolemData.levels[0].itemCount, 300, 'Summon Siege Golem should preserve sourced crystal count');
assert.strictEqual(summonSiegeGolemData.levels[0].itemCountOT, 70, 'Summon Siege Golem should preserve sourced ongoing fuel count');
assert.strictEqual(summonSiegeGolemData.levels[0].npcId, 12251, 'Summon Siege Golem should preserve sourced npcId');
const summonSiegeGolem = skill({ selfId: 13, name: 'Summon Siege Golem', spell: false, power: 1, level: 1, distance: -1 });
assert.strictEqual(summonSiegeGolem.fetchSkillType(), C4SkillRules.SUMMON, 'Summon Siege Golem should resolve to SUMMON instead of magic damage');
assert.strictEqual(summonSiegeGolem.fetchTargetKind(), 'self', 'Summon Siege Golem should preserve sourced TARGET_SELF semantics');
assert.strictEqual(summonSiegeGolem.fetchSsBoost(), 0, 'Summon Siege Golem should not consume offensive shot boost semantics');

const summonVampiricCubicData = activeSkills.find((entry) => entry.selfId === 22);
assert(summonVampiricCubicData, 'Summon Vampiric Cubic should be present in active skills data');
assert.strictEqual(summonVampiricCubicData.template.name, 'Summon Vampiric Cubic', 'Summon Vampiric Cubic should preserve sourced skill name');
assert.strictEqual(summonVampiricCubicData.time.hitTime, 6000, 'Summon Vampiric Cubic should preserve sourced 6000ms hit time');
assert.strictEqual(summonVampiricCubicData.summon.totalLifeTime, 900000, 'Summon Vampiric Cubic should preserve sourced cubic lifetime');
assert.strictEqual(summonVampiricCubicData.summon.expPenalty, 0, 'Summon Vampiric Cubic should preserve sourced zero exp penalty');
assert.strictEqual(summonVampiricCubicData.summon.isCubic, true, 'Summon Vampiric Cubic should preserve sourced cubic flag');
assert.strictEqual(summonVampiricCubicData.summon.npcId, 2, 'Summon Vampiric Cubic should preserve sourced cubic npcId');
assert.strictEqual(summonVampiricCubicData.summon.activationChance, 8, 'Summon Vampiric Cubic should preserve sourced activation chance');
assert.strictEqual(summonVampiricCubicData.summon.activationTime, 15, 'Summon Vampiric Cubic should preserve sourced activation time');
assert.strictEqual(summonVampiricCubicData.levels.length, 7, 'Summon Vampiric Cubic should preserve sourced 7 base levels');
assert.strictEqual(summonVampiricCubicData.levels[0].power, 351, 'Summon Vampiric Cubic level 1 should preserve sourced cubic power');
assert.strictEqual(summonVampiricCubicData.levels[0].mp, 38, 'Summon Vampiric Cubic level 1 MP should use sourced initial + consume total');
assert.strictEqual(summonVampiricCubicData.levels[0].itemCount, 6, 'Summon Vampiric Cubic level 1 should preserve sourced crystal count');
assert.strictEqual(summonVampiricCubicData.levels[6].power, 1822, 'Summon Vampiric Cubic level 7 should preserve sourced cubic power');
assert.strictEqual(summonVampiricCubicData.levels[6].mp, 67, 'Summon Vampiric Cubic level 7 MP should use sourced initial + consume total');
assert.strictEqual(summonVampiricCubicData.levels[6].itemCount, 13, 'Summon Vampiric Cubic level 7 should preserve sourced crystal count');
const summonVampiricCubic = skill({ selfId: 22, name: 'Summon Vampiric Cubic', spell: true, power: 1822, level: 7, distance: -1 });
assert.strictEqual(summonVampiricCubic.fetchSkillType(), C4SkillRules.SUMMON, 'Summon Vampiric Cubic should resolve to SUMMON instead of magic damage');
assert.strictEqual(summonVampiricCubic.fetchTargetKind(), 'self', 'Summon Vampiric Cubic should preserve sourced TARGET_SELF semantics');
assert.strictEqual(summonVampiricCubic.fetchSsBoost(), 0, 'Summon Vampiric Cubic should not consume offensive shot boost semantics');

const summonMechanicGolemData = activeSkills.find((entry) => entry.selfId === 25);
assert(summonMechanicGolemData, 'Summon Mechanic Golem should be present in active skills data');
assert.strictEqual(summonMechanicGolemData.time.hitTime, 15000, 'Summon Mechanic Golem should preserve sourced 15000ms hit time');
assert.strictEqual(summonMechanicGolemData.summon.totalLifeTime, 1200000, 'Summon Mechanic Golem should preserve sourced summon lifetime');
assert.strictEqual(summonMechanicGolemData.summon.expPenalty, 0.15, 'Summon Mechanic Golem should preserve sourced exp penalty');
assert.strictEqual(summonMechanicGolemData.summon.itemConsumeSteps, 4, 'Summon Mechanic Golem should preserve sourced summon crystal consume step mode');
assert.strictEqual(summonMechanicGolemData.levels.length, 9, 'Summon Mechanic Golem should preserve sourced 9 base levels');
assert.strictEqual(summonMechanicGolemData.levels[0].mp, 49, 'Summon Mechanic Golem level 1 MP should preserve sourced consume value');
assert.strictEqual(summonMechanicGolemData.levels[0].itemId, 1459, 'Summon Mechanic Golem should preserve sourced crystal item id');
assert.strictEqual(summonMechanicGolemData.levels[0].itemCountOT, 1, 'Summon Mechanic Golem level 1 should preserve sourced ongoing crystal count');
assert.strictEqual(summonMechanicGolemData.levels[0].npcId, 12187, 'Summon Mechanic Golem level 1 should preserve sourced npcId');
assert.strictEqual(summonMechanicGolemData.levels[8].mp, 133, 'Summon Mechanic Golem level 9 MP should preserve sourced consume value');
assert.strictEqual(summonMechanicGolemData.levels[8].itemCount, 5, 'Summon Mechanic Golem level 9 should preserve sourced crystal count');
assert.strictEqual(summonMechanicGolemData.levels[8].itemCountOT, 4, 'Summon Mechanic Golem level 9 should preserve sourced ongoing crystal count');
assert.strictEqual(summonMechanicGolemData.levels[8].npcId, 12525, 'Summon Mechanic Golem level 9 should preserve sourced npcId');
const summonMechanicGolem = skill({ selfId: 25, name: 'Summon Mechanic Golem', spell: true, power: 1, level: 9, distance: -1 });
assert.strictEqual(summonMechanicGolem.fetchSkillType(), C4SkillRules.SUMMON, 'Summon Mechanic Golem should resolve to SUMMON instead of magic damage');
assert.strictEqual(summonMechanicGolem.fetchTargetKind(), 'self', 'Summon Mechanic Golem should preserve sourced TARGET_SELF semantics');
assert.strictEqual(summonMechanicGolem.fetchSsBoost(), 0, 'Summon Mechanic Golem should not consume offensive shot boost semantics');

const summonPhantomCubicData = activeSkills.find((entry) => entry.selfId === 33);
assert(summonPhantomCubicData, 'Summon Phantom Cubic should be present in active skills data');
assert.strictEqual(summonPhantomCubicData.template.name, 'Summon Phantom Cubic', 'Summon Phantom Cubic should preserve sourced skill name');
assert.strictEqual(summonPhantomCubicData.time.hitTime, 6000, 'Summon Phantom Cubic should preserve sourced 6000ms hit time');
assert.strictEqual(summonPhantomCubicData.summon.totalLifeTime, 900000, 'Summon Phantom Cubic should preserve sourced cubic lifetime');
assert.strictEqual(summonPhantomCubicData.summon.expPenalty, 0, 'Summon Phantom Cubic should preserve sourced zero exp penalty');
assert.strictEqual(summonPhantomCubicData.summon.isCubic, true, 'Summon Phantom Cubic should preserve sourced cubic flag');
assert.strictEqual(summonPhantomCubicData.summon.npcId, 5, 'Summon Phantom Cubic should preserve sourced cubic npcId');
assert.strictEqual(summonPhantomCubicData.summon.activationChance, 30, 'Summon Phantom Cubic should preserve sourced activation chance');
assert.strictEqual(summonPhantomCubicData.summon.activationTime, 8, 'Summon Phantom Cubic should preserve sourced activation time');
assert.strictEqual(summonPhantomCubicData.levels.length, 8, 'Summon Phantom Cubic should preserve sourced 8 base levels');
assert.strictEqual(summonPhantomCubicData.levels[0].power, 282, 'Summon Phantom Cubic level 1 should preserve sourced cubic power');
assert.strictEqual(summonPhantomCubicData.levels[0].mp, 35, 'Summon Phantom Cubic level 1 MP should use sourced initial + consume total');
assert.strictEqual(summonPhantomCubicData.levels[0].itemCount, 2, 'Summon Phantom Cubic level 1 should preserve sourced crystal count');
assert.strictEqual(summonPhantomCubicData.levels[7].power, 1975, 'Summon Phantom Cubic level 8 should preserve sourced cubic power');
assert.strictEqual(summonPhantomCubicData.levels[7].mp, 69, 'Summon Phantom Cubic level 8 MP should use sourced initial + consume total');
assert.strictEqual(summonPhantomCubicData.levels[7].itemCount, 7, 'Summon Phantom Cubic level 8 should preserve sourced crystal count');
const summonPhantomCubic = skill({ selfId: 33, name: 'Summon Phantom Cubic', spell: true, power: 1975, level: 8, distance: -1 });
assert.strictEqual(summonPhantomCubic.fetchSkillType(), C4SkillRules.SUMMON, 'Summon Phantom Cubic should resolve to SUMMON instead of magic damage');
assert.strictEqual(summonPhantomCubic.fetchTargetKind(), 'self', 'Summon Phantom Cubic should preserve sourced TARGET_SELF semantics');
assert.strictEqual(summonPhantomCubic.fetchSsBoost(), 0, 'Summon Phantom Cubic should not consume offensive shot boost semantics');

const summonLifeCubicData = activeSkills.find((entry) => entry.selfId === 67);
assert(summonLifeCubicData, 'Summon Life Cubic should be present in active skills data');
assert.strictEqual(summonLifeCubicData.time.hitTime, 6000, 'Summon Life Cubic should preserve sourced 6000ms hit time');
assert.strictEqual(summonLifeCubicData.summon.totalLifeTime, 900000, 'Summon Life Cubic should preserve sourced cubic lifetime');
assert.strictEqual(summonLifeCubicData.summon.expPenalty, 0, 'Summon Life Cubic should preserve sourced zero exp penalty');
assert.strictEqual(summonLifeCubicData.summon.isCubic, true, 'Summon Life Cubic should preserve sourced cubic flag');
assert.strictEqual(summonLifeCubicData.summon.npcId, 3, 'Summon Life Cubic should preserve sourced cubic npcId');
assert.strictEqual(summonLifeCubicData.summon.activationChance, 0, 'Summon Life Cubic should preserve sourced activation chance');
assert.strictEqual(summonLifeCubicData.summon.activationTime, 13, 'Summon Life Cubic should preserve sourced activation time');
assert.strictEqual(summonLifeCubicData.levels.length, 7, 'Summon Life Cubic should preserve sourced 7 base levels');
assert.strictEqual(summonLifeCubicData.levels[0].mp, 38, 'Summon Life Cubic level 1 MP should use sourced initial + consume total');
assert.strictEqual(summonLifeCubicData.levels[0].itemCount, 6, 'Summon Life Cubic level 1 should preserve sourced crystal count');
assert.strictEqual(summonLifeCubicData.levels[6].mp, 67, 'Summon Life Cubic level 7 MP should use sourced initial + consume total');
assert.strictEqual(summonLifeCubicData.levels[6].itemCount, 13, 'Summon Life Cubic level 7 should preserve sourced crystal count');
const summonLifeCubic = skill({ selfId: 67, name: 'Summon Life Cubic', spell: true, power: 1, level: 7, distance: -1 });
assert.strictEqual(summonLifeCubic.fetchSkillType(), C4SkillRules.SUMMON, 'Summon Life Cubic should resolve to SUMMON instead of magic damage');
assert.strictEqual(summonLifeCubic.fetchTargetKind(), 'self', 'Summon Life Cubic should preserve sourced TARGET_SELF semantics');
assert.strictEqual(summonLifeCubic.fetchSsBoost(), 0, 'Summon Life Cubic should not consume offensive shot boost semantics');

const summonViperCubicData = activeSkills.find((entry) => entry.selfId === 278);
assert(summonViperCubicData, 'Summon Viper Cubic should be present in active skills data');
assert.strictEqual(summonViperCubicData.time.hitTime, 6000, 'Summon Viper Cubic should preserve sourced 6000ms hit time');
assert.strictEqual(summonViperCubicData.summon.totalLifeTime, 900000, 'Summon Viper Cubic should preserve sourced cubic lifetime');
assert.strictEqual(summonViperCubicData.summon.expPenalty, 0, 'Summon Viper Cubic should preserve sourced zero exp penalty');
assert.strictEqual(summonViperCubicData.summon.isCubic, true, 'Summon Viper Cubic should preserve sourced cubic flag');
assert.strictEqual(summonViperCubicData.summon.npcId, 4, 'Summon Viper Cubic should preserve sourced cubic npcId');
assert.strictEqual(summonViperCubicData.summon.activationChance, 20, 'Summon Viper Cubic should preserve sourced activation chance');
assert.strictEqual(summonViperCubicData.summon.activationTime, 20, 'Summon Viper Cubic should preserve sourced activation time');
assert.strictEqual(summonViperCubicData.levels.length, 6, 'Summon Viper Cubic should preserve sourced 6 base levels');
assert.strictEqual(summonViperCubicData.levels[0].power, 531, 'Summon Viper Cubic level 1 should preserve sourced cubic power');
assert.strictEqual(summonViperCubicData.levels[0].mp, 44, 'Summon Viper Cubic level 1 MP should use sourced initial + consume total');
assert.strictEqual(summonViperCubicData.levels[0].itemCount, 3, 'Summon Viper Cubic level 1 should preserve sourced crystal count');
assert.strictEqual(summonViperCubicData.levels[5].power, 1822, 'Summon Viper Cubic level 6 should preserve sourced cubic power');
assert.strictEqual(summonViperCubicData.levels[5].mp, 67, 'Summon Viper Cubic level 6 MP should use sourced initial + consume total');
assert.strictEqual(summonViperCubicData.levels[5].itemCount, 6, 'Summon Viper Cubic level 6 should preserve sourced crystal count');
const summonViperCubic = skill({ selfId: 278, name: 'Summon Viper Cubic', spell: true, power: 1822, level: 6, distance: -1 });
assert.strictEqual(summonViperCubic.fetchSkillType(), C4SkillRules.SUMMON, 'Summon Viper Cubic should resolve to SUMMON instead of magic damage');
assert.strictEqual(summonViperCubic.fetchTargetKind(), 'self', 'Summon Viper Cubic should preserve sourced TARGET_SELF semantics');
assert.strictEqual(summonViperCubic.fetchSsBoost(), 0, 'Summon Viper Cubic should not consume offensive shot boost semantics');

const summonDarkPantherData = activeSkills.find((entry) => entry.selfId === 283);
assert(summonDarkPantherData, 'Summon Dark Panther should be present in active skills data');
assert.strictEqual(summonDarkPantherData.time.hitTime, 15000, 'Summon Dark Panther should preserve sourced 15000ms hit time');
assert.strictEqual(summonDarkPantherData.summon.totalLifeTime, 1200000, 'Summon Dark Panther should preserve sourced summon lifetime');
assert.strictEqual(summonDarkPantherData.summon.timeLostIdle, 500, 'Summon Dark Panther should preserve sourced idle lifetime loss');
assert.strictEqual(summonDarkPantherData.summon.timeLostActive, 1000, 'Summon Dark Panther should preserve sourced active lifetime loss');
assert.strictEqual(summonDarkPantherData.summon.expPenalty, 0.15, 'Summon Dark Panther should preserve sourced exp penalty');
assert.strictEqual(summonDarkPantherData.summon.itemConsumeSteps, 4, 'Summon Dark Panther should preserve sourced summon crystal consume step mode');
assert.strictEqual(summonDarkPantherData.levels.length, 7, 'Summon Dark Panther should preserve sourced 7 base levels');
assert.strictEqual(summonDarkPantherData.levels[0].mp, 70, 'Summon Dark Panther level 1 MP should use sourced initial + consume total');
assert.strictEqual(summonDarkPantherData.levels[0].itemCount, 1, 'Summon Dark Panther level 1 should preserve sourced crystal count');
assert.strictEqual(summonDarkPantherData.levels[0].itemCountOT, 1, 'Summon Dark Panther level 1 should preserve sourced ongoing crystal count');
assert.strictEqual(summonDarkPantherData.levels[0].npcId, 12184, 'Summon Dark Panther level 1 should preserve sourced npcId');
assert.strictEqual(summonDarkPantherData.levels[6].mp, 137, 'Summon Dark Panther level 7 MP should use sourced initial + consume total');
assert.strictEqual(summonDarkPantherData.levels[6].itemCount, 4, 'Summon Dark Panther level 7 should preserve sourced crystal count');
assert.strictEqual(summonDarkPantherData.levels[6].itemCountOT, 4, 'Summon Dark Panther level 7 should preserve sourced ongoing crystal count');
assert.strictEqual(summonDarkPantherData.levels[6].npcId, 12476, 'Summon Dark Panther level 7 should preserve sourced npcId');
const summonDarkPanther = skill({ selfId: 283, name: 'Summon Dark Panther', spell: true, power: 1, level: 7, distance: -1 });
assert.strictEqual(summonDarkPanther.fetchSkillType(), C4SkillRules.SUMMON, 'Summon Dark Panther should resolve to SUMMON instead of magic damage');
assert.strictEqual(summonDarkPanther.fetchTargetKind(), 'self', 'Summon Dark Panther should preserve sourced TARGET_SELF semantics');
assert.strictEqual(summonDarkPanther.fetchSsBoost(), 0, 'Summon Dark Panther should not consume offensive shot boost semantics');

const summonWildHogCannonData = activeSkills.find((entry) => entry.selfId === 299);
assert(summonWildHogCannonData, 'Summon Wild Hog Cannon should be present in active skills data');
assert.strictEqual(summonWildHogCannonData.template.spell, false, 'Summon Wild Hog Cannon should preserve sourced non-magic cast semantics');
assert.strictEqual(summonWildHogCannonData.time.hitTime, 300000, 'Summon Wild Hog Cannon should preserve sourced 300000ms hit time');
assert.strictEqual(summonWildHogCannonData.summon.totalLifeTime, 1200000, 'Summon Wild Hog Cannon should preserve sourced summon lifetime');
assert.strictEqual(summonWildHogCannonData.summon.timeLostIdle, 1000, 'Summon Wild Hog Cannon should preserve sourced idle time loss');
assert.strictEqual(summonWildHogCannonData.summon.timeLostActive, 1000, 'Summon Wild Hog Cannon should preserve sourced active time loss');
assert.strictEqual(summonWildHogCannonData.summon.expPenalty, 0, 'Summon Wild Hog Cannon should preserve sourced zero exp penalty');
assert.strictEqual(summonWildHogCannonData.summon.itemConsumeSteps, 20, 'Summon Wild Hog Cannon should preserve sourced summon crystal consume step mode');
assert.strictEqual(summonWildHogCannonData.summon.itemIdOT, 2132, 'Summon Wild Hog Cannon should preserve sourced ongoing fuel item id');
assert.strictEqual(summonWildHogCannonData.summon.requiresSiegeAttacker, true, 'Summon Wild Hog Cannon should preserve sourced siege attacker condition');
assert.strictEqual(summonWildHogCannonData.levels.length, 1, 'Summon Wild Hog Cannon should preserve sourced single base level');
assert.strictEqual(summonWildHogCannonData.levels[0].mp, 530, 'Summon Wild Hog Cannon MP should preserve sourced initial consume');
assert.strictEqual(summonWildHogCannonData.levels[0].itemId, 1460, 'Summon Wild Hog Cannon should preserve sourced crystal item id');
assert.strictEqual(summonWildHogCannonData.levels[0].itemCount, 120, 'Summon Wild Hog Cannon should preserve sourced crystal count');
assert.strictEqual(summonWildHogCannonData.levels[0].itemCountOT, 30, 'Summon Wild Hog Cannon should preserve sourced ongoing fuel count');
assert.strictEqual(summonWildHogCannonData.levels[0].npcId, 12375, 'Summon Wild Hog Cannon should preserve sourced npcId');
const summonWildHogCannon = skill({ selfId: 299, name: 'Summon Wild Hog Cannon', spell: false, power: 1, level: 1, distance: -1 });
assert.strictEqual(summonWildHogCannon.fetchSkillType(), C4SkillRules.SUMMON, 'Summon Wild Hog Cannon should resolve to SUMMON instead of a physical fallback');
assert.strictEqual(summonWildHogCannon.fetchTargetKind(), 'self', 'Summon Wild Hog Cannon should preserve sourced TARGET_SELF semantics');
assert.strictEqual(summonWildHogCannon.fetchSsBoost(), 0, 'Summon Wild Hog Cannon should not consume offensive shot boost semantics');

const summonBigBoomData = activeSkills.find((entry) => entry.selfId === 301);
assert(summonBigBoomData, 'Summon Big Boom should be present in active skills data');
assert.strictEqual(summonBigBoomData.time.hitTime, 6000, 'Summon Big Boom should preserve sourced 6000ms hit time');
assert.strictEqual(summonBigBoomData.summon.totalLifeTime, 1200000, 'Summon Big Boom should preserve sourced summon lifetime');
assert.strictEqual(summonBigBoomData.summon.timeLostIdle, 500, 'Summon Big Boom should preserve sourced idle time loss');
assert.strictEqual(summonBigBoomData.summon.timeLostActive, 1000, 'Summon Big Boom should preserve sourced active time loss');
assert.strictEqual(summonBigBoomData.summon.expPenalty, 0.3, 'Summon Big Boom should preserve sourced exp penalty');
assert.strictEqual(summonBigBoomData.summon.itemConsumeSteps, 4, 'Summon Big Boom should preserve sourced summon crystal consume step mode');
assert.strictEqual(summonBigBoomData.summon.itemIdOT, 1458, 'Summon Big Boom should preserve sourced ongoing crystal item id');
assert.strictEqual(summonBigBoomData.levels.length, 5, 'Summon Big Boom should preserve sourced 5 base levels');
assert.strictEqual(summonBigBoomData.levels[0].mp, 74, 'Summon Big Boom level 1 MP should preserve sourced consume value');
assert.strictEqual(summonBigBoomData.levels[0].itemCount, 3, 'Summon Big Boom level 1 should preserve sourced crystal count');
assert.strictEqual(summonBigBoomData.levels[0].itemCountOT, 5, 'Summon Big Boom level 1 should preserve sourced ongoing crystal count');
assert.strictEqual(summonBigBoomData.levels[0].npcId, 12517, 'Summon Big Boom level 1 should preserve sourced npcId');
assert.strictEqual(summonBigBoomData.levels[4].mp, 100, 'Summon Big Boom level 5 MP should preserve sourced consume value');
assert.strictEqual(summonBigBoomData.levels[4].itemCount, 5, 'Summon Big Boom level 5 should preserve sourced crystal count');
assert.strictEqual(summonBigBoomData.levels[4].itemCountOT, 5, 'Summon Big Boom level 5 should preserve sourced ongoing crystal count');
assert.strictEqual(summonBigBoomData.levels[4].npcId, 12521, 'Summon Big Boom level 5 should preserve sourced npcId');
const summonBigBoom = skill({ selfId: 301, name: 'Summon Big Boom', spell: true, power: 1, level: 5, distance: -1 });
assert.strictEqual(summonBigBoom.fetchSkillType(), C4SkillRules.SUMMON, 'Summon Big Boom should resolve to SUMMON instead of magic damage');
assert.strictEqual(summonBigBoom.fetchTargetKind(), 'self', 'Summon Big Boom should preserve sourced TARGET_SELF semantics');
assert.strictEqual(summonBigBoom.fetchSsBoost(), 0, 'Summon Big Boom should not consume offensive shot boost semantics');

const summonKatCatData = activeSkills.find((entry) => entry.selfId === 1111);
assert(summonKatCatData, 'Summon Kat the Cat should be present in active skills data');
assert.strictEqual(summonKatCatData.time.hitTime, 15000, 'Summon Kat the Cat should preserve sourced 15000ms hit time');
assert.strictEqual(summonKatCatData.summon.totalLifeTime, 1200000, 'Summon Kat the Cat should preserve sourced summon lifetime');
assert.strictEqual(summonKatCatData.summon.timeLostIdle, 500, 'Summon Kat the Cat should preserve sourced idle time loss');
assert.strictEqual(summonKatCatData.summon.timeLostActive, 1000, 'Summon Kat the Cat should preserve sourced active time loss');
assert.strictEqual(summonKatCatData.summon.expPenalty, 0.3, 'Summon Kat the Cat should preserve sourced exp penalty');
assert.strictEqual(summonKatCatData.summon.itemConsumeSteps, 1, 'Summon Kat the Cat should preserve sourced summon crystal consume step mode');
assert.strictEqual(summonKatCatData.summon.itemIdOT, 1458, 'Summon Kat the Cat should preserve sourced ongoing crystal item id');
assert.strictEqual(summonKatCatData.levels.length, 18, 'Summon Kat the Cat should preserve sourced 18 base levels');
assert.strictEqual(summonKatCatData.levels[0].mp, 39, 'Summon Kat the Cat level 1 MP should use sourced initial + consume total');
assert.strictEqual(summonKatCatData.levels[0].itemCount, 3, 'Summon Kat the Cat level 1 should preserve sourced crystal count');
assert.strictEqual(summonKatCatData.levels[0].itemCountOT, 0, 'Summon Kat the Cat level 1 should preserve sourced ongoing crystal count');
assert.strictEqual(summonKatCatData.levels[0].npcId, 12006, 'Summon Kat the Cat level 1 should preserve sourced npcId');
assert.strictEqual(summonKatCatData.levels[3].reuse, 21600000, 'Summon Kat the Cat level 4 should preserve sourced 6-hour reuse');
assert.strictEqual(summonKatCatData.levels[17].mp, 137, 'Summon Kat the Cat level 18 MP should use sourced initial + consume total');
assert.strictEqual(summonKatCatData.levels[17].itemCount, 8, 'Summon Kat the Cat level 18 should preserve sourced crystal count');
assert.strictEqual(summonKatCatData.levels[17].itemCountOT, 6, 'Summon Kat the Cat level 18 should preserve sourced ongoing crystal count');
assert.strictEqual(summonKatCatData.levels[17].npcId, 12419, 'Summon Kat the Cat level 18 should preserve sourced npcId');
assert.strictEqual(summonKatCatData.levels[17].reuse, 20000, 'Summon Kat the Cat trained levels should preserve sourced 20000ms reuse');
const summonKatCat = skill({ selfId: 1111, name: 'Summon Kat the Cat', spell: true, power: 1, level: 18, distance: -1 });
assert.strictEqual(summonKatCat.fetchSkillType(), C4SkillRules.SUMMON, 'Summon Kat the Cat should resolve to SUMMON instead of magic damage');
assert.strictEqual(summonKatCat.fetchTargetKind(), 'self', 'Summon Kat the Cat should preserve sourced TARGET_SELF semantics');
assert.strictEqual(summonKatCat.fetchSsBoost(), 0, 'Summon Kat the Cat should not consume offensive shot boost semantics');

const summonShadowData = activeSkills.find((entry) => entry.selfId === 1128);
assert(summonShadowData, 'Summon Shadow should be present in active skills data');
assert.strictEqual(summonShadowData.time.hitTime, 15000, 'Summon Shadow should preserve sourced 15000ms hit time');
assert.strictEqual(summonShadowData.summon.totalLifeTime, 1200000, 'Summon Shadow should preserve sourced summon lifetime');
assert.strictEqual(summonShadowData.summon.timeLostIdle, 500, 'Summon Shadow should preserve sourced idle time loss');
assert.strictEqual(summonShadowData.summon.timeLostActive, 1000, 'Summon Shadow should preserve sourced active time loss');
assert.strictEqual(summonShadowData.summon.expPenalty, 0.3, 'Summon Shadow should preserve sourced exp penalty');
assert.strictEqual(summonShadowData.summon.itemConsumeSteps, 1, 'Summon Shadow should preserve sourced summon crystal consume step mode');
assert.strictEqual(summonShadowData.summon.itemIdOT, 1458, 'Summon Shadow should preserve sourced ongoing crystal item id');
assert.strictEqual(summonShadowData.levels.length, 18, 'Summon Shadow should preserve sourced 18 base levels');
assert.strictEqual(summonShadowData.levels[0].mp, 39, 'Summon Shadow level 1 MP should use sourced initial + consume total');
assert.strictEqual(summonShadowData.levels[0].itemCount, 3, 'Summon Shadow level 1 should preserve sourced crystal count');
assert.strictEqual(summonShadowData.levels[0].itemCountOT, 0, 'Summon Shadow level 1 should preserve sourced ongoing crystal count');
assert.strictEqual(summonShadowData.levels[0].npcId, 12070, 'Summon Shadow level 1 should preserve sourced npcId');
assert.strictEqual(summonShadowData.levels[3].reuse, 21600000, 'Summon Shadow level 4 should preserve sourced 6-hour reuse');
assert.strictEqual(summonShadowData.levels[17].mp, 137, 'Summon Shadow level 18 MP should use sourced initial + consume total');
assert.strictEqual(summonShadowData.levels[17].itemCount, 8, 'Summon Shadow level 18 should preserve sourced crystal count');
assert.strictEqual(summonShadowData.levels[17].itemCountOT, 6, 'Summon Shadow level 18 should preserve sourced ongoing crystal count');
assert.strictEqual(summonShadowData.levels[17].npcId, 12455, 'Summon Shadow level 18 should preserve sourced npcId');
assert.strictEqual(summonShadowData.levels[17].reuse, 20000, 'Summon Shadow trained levels should preserve sourced 20000ms reuse');
const summonShadow = skill({ selfId: 1128, name: 'Summon Shadow', spell: true, power: 1, level: 18, distance: -1 });
assert.strictEqual(summonShadow.fetchSkillType(), C4SkillRules.SUMMON, 'Summon Shadow should resolve to SUMMON instead of magic damage');
assert.strictEqual(summonShadow.fetchTargetKind(), 'self', 'Summon Shadow should preserve sourced TARGET_SELF semantics');
assert.strictEqual(summonShadow.fetchSsBoost(), 0, 'Summon Shadow should not consume offensive shot boost semantics');

const summonReanimatedManData = activeSkills.find((entry) => entry.selfId === 1129);
assert(summonReanimatedManData, 'Summon Reanimated Man should be present in active skills data');
assert.strictEqual(summonReanimatedManData.template.distance, 40, 'Summon Reanimated Man should preserve sourced cast range');
assert.strictEqual(summonReanimatedManData.time.hitTime, 1500, 'Summon Reanimated Man should preserve sourced 1500ms hit time');
assert.strictEqual(summonReanimatedManData.summon.totalLifeTime, 1200000, 'Summon Reanimated Man should preserve sourced summon lifetime');
assert.strictEqual(summonReanimatedManData.summon.timeLostIdle, 500, 'Summon Reanimated Man should preserve sourced idle time loss');
assert.strictEqual(summonReanimatedManData.summon.timeLostActive, 1000, 'Summon Reanimated Man should preserve sourced active time loss');
assert.strictEqual(summonReanimatedManData.summon.expPenalty, 0.15, 'Summon Reanimated Man should preserve sourced exp penalty');
assert.strictEqual(summonReanimatedManData.summon.itemConsumeSteps, 4, 'Summon Reanimated Man should preserve sourced summon crystal consume step mode');
assert.strictEqual(summonReanimatedManData.summon.itemIdOT, 1459, 'Summon Reanimated Man should preserve sourced ongoing crystal item id');
assert.strictEqual(summonReanimatedManData.summon.effectRange, 400, 'Summon Reanimated Man should preserve sourced effect range');
assert.strictEqual(summonReanimatedManData.levels.length, 7, 'Summon Reanimated Man should preserve sourced 7 base levels');
assert.strictEqual(summonReanimatedManData.levels[0].mp, 78, 'Summon Reanimated Man level 1 MP should use sourced initial + consume total');
assert.strictEqual(summonReanimatedManData.levels[0].itemCount, 2, 'Summon Reanimated Man level 1 should preserve sourced crystal count');
assert.strictEqual(summonReanimatedManData.levels[0].itemCountOT, 1, 'Summon Reanimated Man level 1 should preserve sourced ongoing crystal count');
assert.strictEqual(summonReanimatedManData.levels[0].npcId, 12192, 'Summon Reanimated Man level 1 should preserve sourced npcId');
assert.strictEqual(summonReanimatedManData.levels[6].mp, 137, 'Summon Reanimated Man level 7 MP should use sourced initial + consume total');
assert.strictEqual(summonReanimatedManData.levels[6].itemCount, 4, 'Summon Reanimated Man level 7 should preserve sourced crystal count');
assert.strictEqual(summonReanimatedManData.levels[6].itemCountOT, 4, 'Summon Reanimated Man level 7 should preserve sourced ongoing crystal count');
assert.strictEqual(summonReanimatedManData.levels[6].npcId, 12469, 'Summon Reanimated Man level 7 should preserve sourced npcId');
const summonReanimatedMan = skill({ selfId: 1129, name: 'Summon Reanimated Man', spell: true, power: 1, level: 7, distance: 40 });
assert.strictEqual(summonReanimatedMan.fetchSkillType(), C4SkillRules.SUMMON, 'Summon Reanimated Man should resolve to SUMMON instead of magic damage');
assert.strictEqual(summonReanimatedMan.fetchTargetKind(), 'corpse_mob', 'Summon Reanimated Man should preserve sourced TARGET_CORPSE_MOB semantics');
assert.strictEqual(summonReanimatedMan.fetchSsBoost(), 0, 'Summon Reanimated Man should not consume offensive shot boost semantics');

const summonCorruptedManData = activeSkills.find((entry) => entry.selfId === 1154);
assert(summonCorruptedManData, 'Summon Corrupted Man should be present in active skills data');
assert.strictEqual(summonCorruptedManData.template.distance, 40, 'Summon Corrupted Man should preserve sourced cast range');
assert.strictEqual(summonCorruptedManData.time.hitTime, 1500, 'Summon Corrupted Man should preserve sourced 1500ms hit time');
assert.strictEqual(summonCorruptedManData.summon.totalLifeTime, 1200000, 'Summon Corrupted Man should preserve sourced summon lifetime');
assert.strictEqual(summonCorruptedManData.summon.timeLostIdle, 500, 'Summon Corrupted Man should preserve sourced idle time loss');
assert.strictEqual(summonCorruptedManData.summon.timeLostActive, 1000, 'Summon Corrupted Man should preserve sourced active time loss');
assert.strictEqual(summonCorruptedManData.summon.expPenalty, 0.9, 'Summon Corrupted Man should preserve sourced exp penalty');
assert.strictEqual(summonCorruptedManData.summon.itemConsumeSteps, 0, 'Summon Corrupted Man should preserve sourced summon crystal consume step mode');
assert.strictEqual(summonCorruptedManData.summon.effectRange, 400, 'Summon Corrupted Man should preserve sourced effect range');
assert.strictEqual(summonCorruptedManData.levels.length, 6, 'Summon Corrupted Man should preserve sourced 6 base levels');
assert.strictEqual(summonCorruptedManData.levels[0].mp, 70, 'Summon Corrupted Man level 1 MP should use sourced initial + consume total');
assert.strictEqual(summonCorruptedManData.levels[0].itemId, 1458, 'Summon Corrupted Man should preserve sourced crystal item id');
assert.strictEqual(summonCorruptedManData.levels[0].itemCount, 3, 'Summon Corrupted Man level 1 should preserve sourced crystal count');
assert.strictEqual(summonCorruptedManData.levels[0].npcId, 12194, 'Summon Corrupted Man level 1 should preserve sourced npcId');
assert.strictEqual(summonCorruptedManData.levels[5].mp, 130, 'Summon Corrupted Man level 6 MP should use sourced initial + consume total');
assert.strictEqual(summonCorruptedManData.levels[5].itemCount, 3, 'Summon Corrupted Man level 6 should preserve sourced crystal count');
assert.strictEqual(summonCorruptedManData.levels[5].npcId, 12472, 'Summon Corrupted Man level 6 should preserve sourced npcId');
const summonCorruptedMan = skill({ selfId: 1154, name: 'Summon Corrupted Man', spell: true, power: 1, level: 6, distance: 40 });
assert.strictEqual(summonCorruptedMan.fetchSkillType(), C4SkillRules.SUMMON, 'Summon Corrupted Man should resolve to SUMMON instead of magic damage');
assert.strictEqual(summonCorruptedMan.fetchTargetKind(), 'corpse_mob', 'Summon Corrupted Man should preserve sourced TARGET_CORPSE_MOB semantics');
assert.strictEqual(summonCorruptedMan.fetchSsBoost(), 0, 'Summon Corrupted Man should not consume offensive shot boost semantics');

const noviceLifeCubicData = activeSkills.find((entry) => entry.selfId === 4338);
assert(noviceLifeCubicData, 'Life Cubic For Novice should be present in active skills data');
assert.strictEqual(noviceLifeCubicData.summon.totalLifeTime, 3600000, 'Life Cubic For Novice should preserve sourced cubic lifetime');
assert.strictEqual(noviceLifeCubicData.summon.expPenalty, 0, 'Life Cubic For Novice should preserve sourced zero exp penalty');
assert.strictEqual(noviceLifeCubicData.summon.isCubic, true, 'Life Cubic For Novice should preserve sourced cubic flag');
assert.strictEqual(noviceLifeCubicData.summon.npcId, 3, 'Life Cubic For Novice should preserve sourced cubic npcId');
assert.strictEqual(noviceLifeCubicData.summon.saveCubicOnExit, true, 'Life Cubic For Novice should preserve sourced save-on-exit flag');
assert.strictEqual(noviceLifeCubicData.summon.activationChance, 0, 'Life Cubic For Novice should preserve sourced activation chance');
assert.strictEqual(noviceLifeCubicData.summon.activationTime, 13, 'Life Cubic For Novice should preserve sourced activation time');
const noviceLifeCubic = skill({ selfId: 4338, name: 'Life Cubic For Novice', spell: true, power: 1, level: 1, distance: -1 });
assert.strictEqual(noviceLifeCubic.fetchSkillType(), C4SkillRules.SUMMON, 'Life Cubic For Novice should resolve to SUMMON instead of magic damage');
assert.strictEqual(noviceLifeCubic.fetchTargetKind(), 'self', 'Life Cubic For Novice should preserve sourced TARGET_SELF semantics');
assert.strictEqual(noviceLifeCubic.fetchSsBoost(), 0, 'Life Cubic For Novice should not consume offensive shot boost semantics');

[
    { id: 7030, name: 'Summon King Bugbear', npcId: 150 },
    { id: 7031, name: 'Summon Skeleton Royal Guard', npcId: 622 },
    { id: 7032, name: 'Summon Hunter Gargoyle', npcId: 241 }
].forEach(({ id, name, npcId }) => {
    const summonData = activeSkills.find((entry) => entry.selfId === id);
    assert(summonData, `${name} should be present in active skills data`);
    assert.strictEqual(summonData.time.hitTime, 4000, `${name} should preserve sourced 4000ms hit time`);
    assert.strictEqual(summonData.time.reuse, 18600000, `${name} should preserve sourced reuse`);
    assert.strictEqual(summonData.summon.totalLifeTime, 1200000, `${name} should preserve sourced summon lifetime`);
    assert.strictEqual(summonData.summon.timeLostIdle, 500, `${name} should preserve sourced idle time loss`);
    assert.strictEqual(summonData.summon.timeLostActive, 1000, `${name} should preserve sourced active time loss`);
    assert.strictEqual(summonData.summon.expPenalty, 0.3, `${name} should preserve sourced exp penalty`);
    assert.strictEqual(summonData.summon.itemConsumeSteps, 0, `${name} should preserve sourced summon crystal consume step mode`);
    assert.strictEqual(summonData.levels.length, 1, `${name} should preserve sourced single base level`);
    assert.strictEqual(summonData.levels[0].mp, 3, `${name} should preserve sourced MP consume`);
    assert.strictEqual(summonData.levels[0].itemId, 1458, `${name} should preserve sourced crystal item id`);
    assert.strictEqual(summonData.levels[0].itemCount, 8, `${name} should preserve sourced crystal count`);
    assert.strictEqual(summonData.levels[0].npcId, npcId, `${name} should preserve sourced npcId`);
    const summonSkill = skill({ selfId: id, name, spell: true, power: 1, level: 1, distance: -1 });
    assert.strictEqual(summonSkill.fetchSkillType(), C4SkillRules.SUMMON, `${name} should resolve to SUMMON instead of magic damage`);
    assert.strictEqual(summonSkill.fetchTargetKind(), 'self', `${name} should preserve sourced TARGET_SELF semantics`);
    assert.strictEqual(summonSkill.fetchSsBoost(), 0, `${name} should not consume offensive shot boost semantics`);
});

const summonMewData = activeSkills.find((entry) => entry.selfId === 1225);
assert(summonMewData, 'Summon Mew the Cat should be present in active skills data');
assert.strictEqual(summonMewData.time.hitTime, 15000, 'Summon Mew the Cat should preserve sourced 15000ms hit time');
assert.strictEqual(summonMewData.summon.totalLifeTime, 1200000, 'Summon Mew the Cat should preserve sourced summon lifetime');
assert.strictEqual(summonMewData.summon.expPenalty, 0.9, 'Summon Mew the Cat should preserve sourced exp penalty');
assert.strictEqual(summonMewData.levels.length, 18, 'Summon Mew the Cat should preserve sourced 18 base levels');
assert.strictEqual(summonMewData.levels[0].mp, 39, 'Summon Mew the Cat level 1 MP should use sourced initial + consume total');
assert.strictEqual(summonMewData.levels[0].itemCount, 1, 'Summon Mew the Cat should preserve sourced crystal count');
assert.strictEqual(summonMewData.levels[0].npcId, 12348, 'Summon Mew the Cat level 1 should preserve sourced npcId');
assert.strictEqual(summonMewData.levels[17].mp, 137, 'Summon Mew the Cat level 18 MP should use sourced initial + consume total');
assert.strictEqual(summonMewData.levels[17].npcId, 12428, 'Summon Mew the Cat level 18 should preserve sourced npcId');
assert.strictEqual(summonMewData.levels[17].reuse, 20000, 'Summon Mew the Cat trained levels should preserve sourced 20000ms reuse');
const summonMew = skill({ selfId: 1225, name: 'Summon Mew the Cat', spell: true, power: 1, level: 18, distance: -1 });
assert.strictEqual(summonMew.fetchSkillType(), C4SkillRules.SUMMON, 'Summon Mew the Cat should resolve to SUMMON instead of magic damage');
assert.strictEqual(summonMew.fetchTargetKind(), 'self', 'Summon Mew the Cat should preserve sourced TARGET_SELF semantics');
assert.strictEqual(summonMew.fetchSsBoost(), 0, 'Summon Mew the Cat should not consume offensive shot boost semantics');

const summonBoxerData = activeSkills.find((entry) => entry.selfId === 1226);
assert(summonBoxerData, 'Summon Unicorn Boxer should be present in active skills data');
assert.strictEqual(summonBoxerData.time.hitTime, 15000, 'Summon Unicorn Boxer should preserve sourced 15000ms hit time');
assert.strictEqual(summonBoxerData.summon.totalLifeTime, 1200000, 'Summon Unicorn Boxer should preserve sourced summon lifetime');
assert.strictEqual(summonBoxerData.summon.expPenalty, 0.3, 'Summon Unicorn Boxer should preserve sourced exp penalty');
assert.strictEqual(summonBoxerData.summon.itemConsumeSteps, 1, 'Summon Unicorn Boxer should preserve sourced summon crystal consume step mode');
assert.strictEqual(summonBoxerData.levels.length, 18, 'Summon Unicorn Boxer should preserve sourced 18 base levels');
assert.strictEqual(summonBoxerData.levels[0].itemCount, 3, 'Summon Unicorn Boxer level 1 should preserve sourced crystal count');
assert.strictEqual(summonBoxerData.levels[2].itemCountOT, 1, 'Summon Unicorn Boxer level 3 should preserve sourced ongoing crystal count');
assert.strictEqual(summonBoxerData.levels[0].npcId, 12064, 'Summon Unicorn Boxer level 1 should preserve sourced npcId');
assert.strictEqual(summonBoxerData.levels[17].mp, 137, 'Summon Unicorn Boxer level 18 MP should use sourced initial + consume total');
assert.strictEqual(summonBoxerData.levels[17].itemCount, 8, 'Summon Unicorn Boxer level 18 should preserve sourced crystal count');
assert.strictEqual(summonBoxerData.levels[17].itemCountOT, 6, 'Summon Unicorn Boxer level 18 should preserve sourced ongoing crystal count');
assert.strictEqual(summonBoxerData.levels[17].npcId, 12446, 'Summon Unicorn Boxer level 18 should preserve sourced npcId');
assert.strictEqual(summonBoxerData.levels[17].reuse, 20000, 'Summon Unicorn Boxer trained levels should preserve sourced 20000ms reuse');
const summonBoxer = skill({ selfId: 1226, name: 'Summon Unicorn Boxer', spell: true, power: 1, level: 18, distance: -1 });
assert.strictEqual(summonBoxer.fetchSkillType(), C4SkillRules.SUMMON, 'Summon Unicorn Boxer should resolve to SUMMON instead of magic damage');
assert.strictEqual(summonBoxer.fetchTargetKind(), 'self', 'Summon Unicorn Boxer should preserve sourced TARGET_SELF semantics');
assert.strictEqual(summonBoxer.fetchSsBoost(), 0, 'Summon Unicorn Boxer should not consume offensive shot boost semantics');

const summonMirageData = activeSkills.find((entry) => entry.selfId === 1227);
assert(summonMirageData, 'Summon Unicorn Mirage should be present in active skills data');
assert.strictEqual(summonMirageData.time.hitTime, 15000, 'Summon Unicorn Mirage should preserve sourced 15000ms hit time');
assert.strictEqual(summonMirageData.summon.totalLifeTime, 1200000, 'Summon Unicorn Mirage should preserve sourced summon lifetime');
assert.strictEqual(summonMirageData.summon.expPenalty, 0.9, 'Summon Unicorn Mirage should preserve sourced exp penalty');
assert.strictEqual(summonMirageData.levels.length, 18, 'Summon Unicorn Mirage should preserve sourced 18 base levels');
assert.strictEqual(summonMirageData.levels[0].itemCount, 1, 'Summon Unicorn Mirage should preserve sourced crystal count');
assert.strictEqual(summonMirageData.levels[0].npcId, 12357, 'Summon Unicorn Mirage level 1 should preserve sourced npcId');
assert.strictEqual(summonMirageData.levels[17].mp, 137, 'Summon Unicorn Mirage level 18 MP should use sourced initial + consume total');
assert.strictEqual(summonMirageData.levels[17].npcId, 12437, 'Summon Unicorn Mirage level 18 should preserve sourced npcId');
assert.strictEqual(summonMirageData.levels[17].reuse, 20000, 'Summon Unicorn Mirage trained levels should preserve sourced 20000ms reuse');
const summonMirage = skill({ selfId: 1227, name: 'Summon Unicorn Mirage', spell: true, power: 1, level: 18, distance: -1 });
assert.strictEqual(summonMirage.fetchSkillType(), C4SkillRules.SUMMON, 'Summon Unicorn Mirage should resolve to SUMMON instead of magic damage');
assert.strictEqual(summonMirage.fetchTargetKind(), 'self', 'Summon Unicorn Mirage should preserve sourced TARGET_SELF semantics');
assert.strictEqual(summonMirage.fetchSsBoost(), 0, 'Summon Unicorn Mirage should not consume offensive shot boost semantics');

const summonSilhouetteData = activeSkills.find((entry) => entry.selfId === 1228);
assert(summonSilhouetteData, 'Summon Silhouette should be present in active skills data');
assert.strictEqual(summonSilhouetteData.time.hitTime, 15000, 'Summon Silhouette should preserve sourced 15000ms hit time');
assert.strictEqual(summonSilhouetteData.summon.totalLifeTime, 1200000, 'Summon Silhouette should preserve sourced summon lifetime');
assert.strictEqual(summonSilhouetteData.summon.expPenalty, 0.9, 'Summon Silhouette should preserve sourced exp penalty');
assert.strictEqual(summonSilhouetteData.levels.length, 18, 'Summon Silhouette should preserve sourced 18 base levels');
assert.strictEqual(summonSilhouetteData.levels[0].itemCount, 1, 'Summon Silhouette should preserve sourced crystal count');
assert.strictEqual(summonSilhouetteData.levels[0].npcId, 12366, 'Summon Silhouette level 1 should preserve sourced npcId');
assert.strictEqual(summonSilhouetteData.levels[17].mp, 137, 'Summon Silhouette level 18 MP should use sourced initial + consume total');
assert.strictEqual(summonSilhouetteData.levels[17].npcId, 12464, 'Summon Silhouette level 18 should preserve sourced npcId');
assert.strictEqual(summonSilhouetteData.levels[17].reuse, 20000, 'Summon Silhouette trained levels should preserve sourced 20000ms reuse');
const summonSilhouette = skill({ selfId: 1228, name: 'Summon Silhouette', spell: true, power: 1, level: 18, distance: -1 });
assert.strictEqual(summonSilhouette.fetchSkillType(), C4SkillRules.SUMMON, 'Summon Silhouette should resolve to SUMMON instead of magic damage');
assert.strictEqual(summonSilhouette.fetchTargetKind(), 'self', 'Summon Silhouette should preserve sourced TARGET_SELF semantics');
assert.strictEqual(summonSilhouette.fetchSsBoost(), 0, 'Summon Silhouette should not consume offensive shot boost semantics');

const summonKaiData = activeSkills.find((entry) => entry.selfId === 1276);
assert(summonKaiData, 'Summon Kai the Cat should be present in active skills data');
assert.strictEqual(summonKaiData.time.hitTime, 15000, 'Summon Kai the Cat should preserve sourced 15000ms hit time');
assert.strictEqual(summonKaiData.summon.totalLifeTime, 1200000, 'Summon Kai the Cat should preserve sourced summon lifetime');
assert.strictEqual(summonKaiData.summon.expPenalty, 0.1, 'Summon Kai the Cat should preserve sourced exp penalty');
assert.strictEqual(summonKaiData.summon.itemConsumeSteps, 4, 'Summon Kai the Cat should preserve sourced summon crystal consume step mode');
assert.strictEqual(summonKaiData.levels.length, 14, 'Summon Kai the Cat should preserve sourced 14 base levels');
assert.strictEqual(summonKaiData.levels[0].mp, 70, 'Summon Kai the Cat level 1 MP should use sourced initial + consume total');
assert.strictEqual(summonKaiData.levels[0].itemId, 1459, 'Summon Kai the Cat should preserve sourced crystal item id');
assert.strictEqual(summonKaiData.levels[0].itemCountOT, 1, 'Summon Kai the Cat level 1 should preserve sourced ongoing crystal count');
assert.strictEqual(summonKaiData.levels[0].npcId, 12477, 'Summon Kai the Cat level 1 should preserve sourced npcId');
assert.strictEqual(summonKaiData.levels[13].mp, 137, 'Summon Kai the Cat level 14 MP should use sourced initial + consume total');
assert.strictEqual(summonKaiData.levels[13].itemCount, 4, 'Summon Kai the Cat level 14 should preserve sourced crystal count');
assert.strictEqual(summonKaiData.levels[13].itemCountOT, 3, 'Summon Kai the Cat level 14 should preserve sourced ongoing crystal count');
assert.strictEqual(summonKaiData.levels[13].npcId, 12536, 'Summon Kai the Cat level 14 should preserve sourced npcId');
const summonKai = skill({ selfId: 1276, name: 'Summon Kai the Cat', spell: true, power: 1, level: 14, distance: -1 });
assert.strictEqual(summonKai.fetchSkillType(), C4SkillRules.SUMMON, 'Summon Kai the Cat should resolve to SUMMON instead of magic damage');
assert.strictEqual(summonKai.fetchTargetKind(), 'self', 'Summon Kai the Cat should preserve sourced TARGET_SELF semantics');
assert.strictEqual(summonKai.fetchSsBoost(), 0, 'Summon Kai the Cat should not consume offensive shot boost semantics');

const summonMerrowData = activeSkills.find((entry) => entry.selfId === 1277);
assert(summonMerrowData, 'Summon Unicorn Merrow should be present in active skills data');
assert.strictEqual(summonMerrowData.time.hitTime, 15000, 'Summon Unicorn Merrow should preserve sourced 15000ms hit time');
assert.strictEqual(summonMerrowData.summon.totalLifeTime, 1200000, 'Summon Unicorn Merrow should preserve sourced summon lifetime');
assert.strictEqual(summonMerrowData.summon.expPenalty, 0.1, 'Summon Unicorn Merrow should preserve sourced exp penalty');
assert.strictEqual(summonMerrowData.summon.itemConsumeSteps, 4, 'Summon Unicorn Merrow should preserve sourced summon crystal consume step mode');
assert.strictEqual(summonMerrowData.levels.length, 14, 'Summon Unicorn Merrow should preserve sourced 14 base levels');
assert.strictEqual(summonMerrowData.levels[0].mp, 70, 'Summon Unicorn Merrow level 1 MP should use sourced initial + consume total');
assert.strictEqual(summonMerrowData.levels[0].itemId, 1459, 'Summon Unicorn Merrow should preserve sourced crystal item id');
assert.strictEqual(summonMerrowData.levels[0].itemCountOT, 1, 'Summon Unicorn Merrow level 1 should preserve sourced ongoing crystal count');
assert.strictEqual(summonMerrowData.levels[0].npcId, 12490, 'Summon Unicorn Merrow level 1 should preserve sourced npcId');
assert.strictEqual(summonMerrowData.levels[13].mp, 137, 'Summon Unicorn Merrow level 14 MP should use sourced initial + consume total');
assert.strictEqual(summonMerrowData.levels[13].itemCount, 4, 'Summon Unicorn Merrow level 14 should preserve sourced crystal count');
assert.strictEqual(summonMerrowData.levels[13].itemCountOT, 3, 'Summon Unicorn Merrow level 14 should preserve sourced ongoing crystal count');
assert.strictEqual(summonMerrowData.levels[13].npcId, 12537, 'Summon Unicorn Merrow level 14 should preserve sourced npcId');
const summonMerrow = skill({ selfId: 1277, name: 'Summon Unicorn Merrow', spell: true, power: 1, level: 14, distance: -1 });
assert.strictEqual(summonMerrow.fetchSkillType(), C4SkillRules.SUMMON, 'Summon Unicorn Merrow should resolve to SUMMON instead of magic damage');
assert.strictEqual(summonMerrow.fetchTargetKind(), 'self', 'Summon Unicorn Merrow should preserve sourced TARGET_SELF semantics');
assert.strictEqual(summonMerrow.fetchSsBoost(), 0, 'Summon Unicorn Merrow should not consume offensive shot boost semantics');

const summonSoullessData = activeSkills.find((entry) => entry.selfId === 1278);
assert(summonSoullessData, 'Summon Soulless should be present in active skills data');
assert.strictEqual(summonSoullessData.time.hitTime, 15000, 'Summon Soulless should preserve sourced 15000ms hit time');
assert.strictEqual(summonSoullessData.summon.totalLifeTime, 1200000, 'Summon Soulless should preserve sourced summon lifetime');
assert.strictEqual(summonSoullessData.summon.expPenalty, 0.1, 'Summon Soulless should preserve sourced exp penalty');
assert.strictEqual(summonSoullessData.summon.itemConsumeSteps, 4, 'Summon Soulless should preserve sourced summon crystal consume step mode');
assert.strictEqual(summonSoullessData.levels.length, 14, 'Summon Soulless should preserve sourced 14 base levels');
assert.strictEqual(summonSoullessData.levels[0].mp, 70, 'Summon Soulless level 1 MP should use sourced initial + consume total');
assert.strictEqual(summonSoullessData.levels[0].itemId, 1459, 'Summon Soulless should preserve sourced crystal item id');
assert.strictEqual(summonSoullessData.levels[0].itemCountOT, 1, 'Summon Soulless level 1 should preserve sourced ongoing crystal count');
assert.strictEqual(summonSoullessData.levels[0].npcId, 12503, 'Summon Soulless level 1 should preserve sourced npcId');
assert.strictEqual(summonSoullessData.levels[13].mp, 137, 'Summon Soulless level 14 MP should use sourced initial + consume total');
assert.strictEqual(summonSoullessData.levels[13].itemCount, 4, 'Summon Soulless level 14 should preserve sourced crystal count');
assert.strictEqual(summonSoullessData.levels[13].itemCountOT, 3, 'Summon Soulless level 14 should preserve sourced ongoing crystal count');
assert.strictEqual(summonSoullessData.levels[13].npcId, 12538, 'Summon Soulless level 14 should preserve sourced npcId');
const summonSoulless = skill({ selfId: 1278, name: 'Summon Soulless', spell: true, power: 1, level: 14, distance: -1 });
assert.strictEqual(summonSoulless.fetchSkillType(), C4SkillRules.SUMMON, 'Summon Soulless should resolve to SUMMON instead of magic damage');
assert.strictEqual(summonSoulless.fetchTargetKind(), 'self', 'Summon Soulless should preserve sourced TARGET_SELF semantics');
assert.strictEqual(summonSoulless.fetchSsBoost(), 0, 'Summon Soulless should not consume offensive shot boost semantics');

const summonBindingCubicData = activeSkills.find((entry) => entry.selfId === 1279);
assert(summonBindingCubicData, 'Summon Binding Cubic should be present in active skills data');
assert.strictEqual(summonBindingCubicData.time.hitTime, 6000, 'Summon Binding Cubic should preserve sourced 6000ms hit time');
assert.strictEqual(summonBindingCubicData.summon.totalLifeTime, 900000, 'Summon Binding Cubic should preserve sourced cubic lifetime');
assert.strictEqual(summonBindingCubicData.summon.expPenalty, 0, 'Summon Binding Cubic should preserve sourced zero exp penalty');
assert.strictEqual(summonBindingCubicData.summon.isCubic, true, 'Summon Binding Cubic should preserve sourced cubic flag');
assert.strictEqual(summonBindingCubicData.summon.npcId, 6, 'Summon Binding Cubic should preserve sourced cubic npcId');
assert.strictEqual(summonBindingCubicData.summon.activationChance, 12, 'Summon Binding Cubic should preserve sourced activation chance');
assert.strictEqual(summonBindingCubicData.summon.activationTime, 30, 'Summon Binding Cubic should preserve sourced activation time');
assert.strictEqual(summonBindingCubicData.levels.length, 9, 'Summon Binding Cubic should preserve sourced 9 base levels');
assert.strictEqual(summonBindingCubicData.levels[0].power, 282, 'Summon Binding Cubic level 1 should preserve sourced cubic power');
assert.strictEqual(summonBindingCubicData.levels[0].mp, 35, 'Summon Binding Cubic level 1 MP should use sourced initial + consume total');
assert.strictEqual(summonBindingCubicData.levels[0].itemCount, 5, 'Summon Binding Cubic level 1 should preserve sourced crystal count');
assert.strictEqual(summonBindingCubicData.levels[8].power, 1822, 'Summon Binding Cubic level 9 should preserve sourced cubic power');
assert.strictEqual(summonBindingCubicData.levels[8].mp, 67, 'Summon Binding Cubic level 9 MP should use sourced initial + consume total');
assert.strictEqual(summonBindingCubicData.levels[8].itemCount, 13, 'Summon Binding Cubic level 9 should preserve sourced crystal count');
const summonBindingCubic = skill({ selfId: 1279, name: 'Summon Binding Cubic', spell: true, power: 1822, level: 9, distance: -1 });
assert.strictEqual(summonBindingCubic.fetchSkillType(), C4SkillRules.SUMMON, 'Summon Binding Cubic should resolve to SUMMON instead of magic damage');
assert.strictEqual(summonBindingCubic.fetchTargetKind(), 'self', 'Summon Binding Cubic should preserve sourced TARGET_SELF semantics');
assert.strictEqual(summonBindingCubic.fetchSsBoost(), 0, 'Summon Binding Cubic should not consume offensive shot boost semantics');

const summonAquaCubicData = activeSkills.find((entry) => entry.selfId === 1280);
assert(summonAquaCubicData, 'Summon Aqua Cubic should be present in active skills data');
assert.strictEqual(summonAquaCubicData.time.hitTime, 6000, 'Summon Aqua Cubic should preserve sourced 6000ms hit time');
assert.strictEqual(summonAquaCubicData.summon.totalLifeTime, 900000, 'Summon Aqua Cubic should preserve sourced cubic lifetime');
assert.strictEqual(summonAquaCubicData.summon.expPenalty, 0, 'Summon Aqua Cubic should preserve sourced zero exp penalty');
assert.strictEqual(summonAquaCubicData.summon.isCubic, true, 'Summon Aqua Cubic should preserve sourced cubic flag');
assert.strictEqual(summonAquaCubicData.summon.npcId, 7, 'Summon Aqua Cubic should preserve sourced cubic npcId');
assert.strictEqual(summonAquaCubicData.summon.activationChance, 30, 'Summon Aqua Cubic should preserve sourced activation chance');
assert.strictEqual(summonAquaCubicData.summon.activationTime, 30, 'Summon Aqua Cubic should preserve sourced activation time');
assert.strictEqual(summonAquaCubicData.levels.length, 9, 'Summon Aqua Cubic should preserve sourced 9 base levels');
assert.strictEqual(summonAquaCubicData.levels[0].power, 282, 'Summon Aqua Cubic level 1 should preserve sourced cubic power');
assert.strictEqual(summonAquaCubicData.levels[0].mp, 35, 'Summon Aqua Cubic level 1 MP should use sourced initial + consume total');
assert.strictEqual(summonAquaCubicData.levels[0].itemCount, 2, 'Summon Aqua Cubic level 1 should preserve sourced crystal count');
assert.strictEqual(summonAquaCubicData.levels[8].power, 1975, 'Summon Aqua Cubic level 9 should preserve sourced cubic power');
assert.strictEqual(summonAquaCubicData.levels[8].mp, 69, 'Summon Aqua Cubic level 9 MP should use sourced initial + consume total');
assert.strictEqual(summonAquaCubicData.levels[8].itemCount, 7, 'Summon Aqua Cubic level 9 should preserve sourced crystal count');
const summonAquaCubic = skill({ selfId: 1280, name: 'Summon Aqua Cubic', spell: true, power: 1975, level: 9, distance: -1 });
assert.strictEqual(summonAquaCubic.fetchSkillType(), C4SkillRules.SUMMON, 'Summon Aqua Cubic should resolve to SUMMON instead of magic damage');
assert.strictEqual(summonAquaCubic.fetchTargetKind(), 'self', 'Summon Aqua Cubic should preserve sourced TARGET_SELF semantics');
assert.strictEqual(summonAquaCubic.fetchSsBoost(), 0, 'Summon Aqua Cubic should not consume offensive shot boost semantics');

const summonSparkCubicData = activeSkills.find((entry) => entry.selfId === 1281);
assert(summonSparkCubicData, 'Summon Spark Cubic should be present in active skills data');
assert.strictEqual(summonSparkCubicData.time.hitTime, 6000, 'Summon Spark Cubic should preserve sourced 6000ms hit time');
assert.strictEqual(summonSparkCubicData.summon.totalLifeTime, 900000, 'Summon Spark Cubic should preserve sourced cubic lifetime');
assert.strictEqual(summonSparkCubicData.summon.expPenalty, 0, 'Summon Spark Cubic should preserve sourced zero exp penalty');
assert.strictEqual(summonSparkCubicData.summon.isCubic, true, 'Summon Spark Cubic should preserve sourced cubic flag');
assert.strictEqual(summonSparkCubicData.summon.npcId, 8, 'Summon Spark Cubic should preserve sourced cubic npcId');
assert.strictEqual(summonSparkCubicData.summon.activationChance, 12, 'Summon Spark Cubic should preserve sourced activation chance');
assert.strictEqual(summonSparkCubicData.summon.activationTime, 30, 'Summon Spark Cubic should preserve sourced activation time');
assert.strictEqual(summonSparkCubicData.levels.length, 9, 'Summon Spark Cubic should preserve sourced 9 base levels');
assert.strictEqual(summonSparkCubicData.levels[0].power, 282, 'Summon Spark Cubic level 1 should preserve sourced cubic power');
assert.strictEqual(summonSparkCubicData.levels[0].mp, 35, 'Summon Spark Cubic level 1 MP should use sourced initial + consume total');
assert.strictEqual(summonSparkCubicData.levels[0].itemCount, 5, 'Summon Spark Cubic level 1 should preserve sourced crystal count');
assert.strictEqual(summonSparkCubicData.levels[8].power, 1822, 'Summon Spark Cubic level 9 should preserve sourced cubic power');
assert.strictEqual(summonSparkCubicData.levels[8].mp, 67, 'Summon Spark Cubic level 9 MP should use sourced initial + consume total');
assert.strictEqual(summonSparkCubicData.levels[8].itemCount, 13, 'Summon Spark Cubic level 9 should preserve sourced crystal count');
const summonSparkCubic = skill({ selfId: 1281, name: 'Summon Spark Cubic', spell: true, power: 1822, level: 9, distance: -1 });
assert.strictEqual(summonSparkCubic.fetchSkillType(), C4SkillRules.SUMMON, 'Summon Spark Cubic should resolve to SUMMON instead of magic damage');
assert.strictEqual(summonSparkCubic.fetchTargetKind(), 'self', 'Summon Spark Cubic should preserve sourced TARGET_SELF semantics');
assert.strictEqual(summonSparkCubic.fetchSsBoost(), 0, 'Summon Spark Cubic should not consume offensive shot boost semantics');

const massSummonStormCubicData = activeSkills.find((entry) => entry.selfId === 1328);
assert(massSummonStormCubicData, 'Mass Summon Storm Cubic should be present in active skills data');
assert.strictEqual(massSummonStormCubicData.time.hitTime, 6000, 'Mass Summon Storm Cubic should preserve sourced 6000ms hit time');
assert.strictEqual(massSummonStormCubicData.summon.totalLifeTime, 900000, 'Mass Summon Storm Cubic should preserve sourced cubic lifetime');
assert.strictEqual(massSummonStormCubicData.summon.expPenalty, 0, 'Mass Summon Storm Cubic should preserve sourced zero exp penalty');
assert.strictEqual(massSummonStormCubicData.summon.isCubic, true, 'Mass Summon Storm Cubic should preserve sourced cubic flag');
assert.strictEqual(massSummonStormCubicData.summon.npcId, 1, 'Mass Summon Storm Cubic should preserve sourced cubic npcId');
assert.strictEqual(massSummonStormCubicData.summon.activationChance, 12, 'Mass Summon Storm Cubic should preserve sourced activation chance');
assert.strictEqual(massSummonStormCubicData.summon.activationTime, 10, 'Mass Summon Storm Cubic should preserve sourced activation time');
assert.strictEqual(massSummonStormCubicData.levels.length, 8, 'Mass Summon Storm Cubic should preserve sourced 8 base levels');
assert.strictEqual(massSummonStormCubicData.levels[0].power, 282, 'Mass Summon Storm Cubic level 1 should preserve sourced cubic power');
assert.strictEqual(massSummonStormCubicData.levels[0].mp, 139, 'Mass Summon Storm Cubic level 1 MP should use sourced initial + consume total');
assert.strictEqual(massSummonStormCubicData.levels[0].itemCount, 20, 'Mass Summon Storm Cubic level 1 should preserve sourced crystal count');
assert.strictEqual(massSummonStormCubicData.levels[7].power, 1975, 'Mass Summon Storm Cubic level 8 should preserve sourced cubic power');
assert.strictEqual(massSummonStormCubicData.levels[7].mp, 272, 'Mass Summon Storm Cubic level 8 MP should use sourced initial + consume total');
assert.strictEqual(massSummonStormCubicData.levels[7].itemCount, 52, 'Mass Summon Storm Cubic level 8 should preserve sourced crystal count');
const massSummonStormCubic = skill({ selfId: 1328, name: 'Mass Summon Storm Cubic', spell: true, power: 1975, level: 8, distance: -1 });
assert.strictEqual(massSummonStormCubic.fetchSkillType(), C4SkillRules.SUMMON, 'Mass Summon Storm Cubic should resolve to SUMMON instead of magic damage');
assert.strictEqual(massSummonStormCubic.fetchTargetKind(), 'party', 'Mass Summon Storm Cubic should preserve sourced TARGET_PARTY semantics');
assert.strictEqual(massSummonStormCubic.fetchSsBoost(), 0, 'Mass Summon Storm Cubic should not consume offensive shot boost semantics');

const massSummonAquaCubicData = activeSkills.find((entry) => entry.selfId === 1329);
assert(massSummonAquaCubicData, 'Mass Summon Aqua Cubic should be present in active skills data');
assert.strictEqual(massSummonAquaCubicData.time.hitTime, 6000, 'Mass Summon Aqua Cubic should preserve sourced 6000ms hit time');
assert.strictEqual(massSummonAquaCubicData.summon.totalLifeTime, 900000, 'Mass Summon Aqua Cubic should preserve sourced cubic lifetime');
assert.strictEqual(massSummonAquaCubicData.summon.expPenalty, 0, 'Mass Summon Aqua Cubic should preserve sourced zero exp penalty');
assert.strictEqual(massSummonAquaCubicData.summon.isCubic, true, 'Mass Summon Aqua Cubic should preserve sourced cubic flag');
assert.strictEqual(massSummonAquaCubicData.summon.npcId, 7, 'Mass Summon Aqua Cubic should preserve sourced cubic npcId');
assert.strictEqual(massSummonAquaCubicData.summon.activationChance, 30, 'Mass Summon Aqua Cubic should preserve sourced activation chance');
assert.strictEqual(massSummonAquaCubicData.summon.activationTime, 30, 'Mass Summon Aqua Cubic should preserve sourced activation time');
assert.strictEqual(massSummonAquaCubicData.levels.length, 9, 'Mass Summon Aqua Cubic should preserve sourced 9 base levels');
assert.strictEqual(massSummonAquaCubicData.levels[0].power, 282, 'Mass Summon Aqua Cubic level 1 should preserve sourced cubic power');
assert.strictEqual(massSummonAquaCubicData.levels[0].mp, 139, 'Mass Summon Aqua Cubic level 1 MP should use sourced initial + consume total');
assert.strictEqual(massSummonAquaCubicData.levels[0].itemCount, 8, 'Mass Summon Aqua Cubic level 1 should preserve sourced crystal count');
assert.strictEqual(massSummonAquaCubicData.levels[8].power, 1975, 'Mass Summon Aqua Cubic level 9 should preserve sourced cubic power');
assert.strictEqual(massSummonAquaCubicData.levels[8].mp, 272, 'Mass Summon Aqua Cubic level 9 MP should use sourced initial + consume total');
assert.strictEqual(massSummonAquaCubicData.levels[8].itemCount, 28, 'Mass Summon Aqua Cubic level 9 should preserve sourced crystal count');
const massSummonAquaCubic = skill({ selfId: 1329, name: 'Mass Summon Aqua Cubic', spell: true, power: 1975, level: 9, distance: -1 });
assert.strictEqual(massSummonAquaCubic.fetchSkillType(), C4SkillRules.SUMMON, 'Mass Summon Aqua Cubic should resolve to SUMMON instead of magic damage');
assert.strictEqual(massSummonAquaCubic.fetchTargetKind(), 'party', 'Mass Summon Aqua Cubic should preserve sourced TARGET_PARTY semantics');
assert.strictEqual(massSummonAquaCubic.fetchSsBoost(), 0, 'Mass Summon Aqua Cubic should not consume offensive shot boost semantics');

const massSummonPhantomCubicData = activeSkills.find((entry) => entry.selfId === 1330);
assert(massSummonPhantomCubicData, 'Mass Summon Phantom Cubic should be present in active skills data');
assert.strictEqual(massSummonPhantomCubicData.time.hitTime, 6000, 'Mass Summon Phantom Cubic should preserve sourced 6000ms hit time');
assert.strictEqual(massSummonPhantomCubicData.summon.totalLifeTime, 900000, 'Mass Summon Phantom Cubic should preserve sourced cubic lifetime');
assert.strictEqual(massSummonPhantomCubicData.summon.expPenalty, 0, 'Mass Summon Phantom Cubic should preserve sourced zero exp penalty');
assert.strictEqual(massSummonPhantomCubicData.summon.isCubic, true, 'Mass Summon Phantom Cubic should preserve sourced cubic flag');
assert.strictEqual(massSummonPhantomCubicData.summon.npcId, 5, 'Mass Summon Phantom Cubic should preserve sourced cubic npcId');
assert.strictEqual(massSummonPhantomCubicData.summon.activationChance, 30, 'Mass Summon Phantom Cubic should preserve sourced activation chance');
assert.strictEqual(massSummonPhantomCubicData.summon.activationTime, 8, 'Mass Summon Phantom Cubic should preserve sourced activation time');
assert.strictEqual(massSummonPhantomCubicData.levels.length, 8, 'Mass Summon Phantom Cubic should preserve sourced 8 base levels');
assert.strictEqual(massSummonPhantomCubicData.levels[0].power, 282, 'Mass Summon Phantom Cubic level 1 should preserve sourced cubic power');
assert.strictEqual(massSummonPhantomCubicData.levels[0].mp, 139, 'Mass Summon Phantom Cubic level 1 MP should use sourced initial + consume total');
assert.strictEqual(massSummonPhantomCubicData.levels[0].itemCount, 8, 'Mass Summon Phantom Cubic level 1 should preserve sourced crystal count');
assert.strictEqual(massSummonPhantomCubicData.levels[7].power, 1975, 'Mass Summon Phantom Cubic level 8 should preserve sourced cubic power');
assert.strictEqual(massSummonPhantomCubicData.levels[7].mp, 272, 'Mass Summon Phantom Cubic level 8 MP should use sourced initial + consume total');
assert.strictEqual(massSummonPhantomCubicData.levels[7].itemCount, 28, 'Mass Summon Phantom Cubic level 8 should preserve sourced crystal count');
const massSummonPhantomCubic = skill({ selfId: 1330, name: 'Mass Summon Phantom Cubic', spell: true, power: 1975, level: 8, distance: -1 });
assert.strictEqual(massSummonPhantomCubic.fetchSkillType(), C4SkillRules.SUMMON, 'Mass Summon Phantom Cubic should resolve to SUMMON instead of magic damage');
assert.strictEqual(massSummonPhantomCubic.fetchTargetKind(), 'party', 'Mass Summon Phantom Cubic should preserve sourced TARGET_PARTY semantics');
assert.strictEqual(massSummonPhantomCubic.fetchSsBoost(), 0, 'Mass Summon Phantom Cubic should not consume offensive shot boost semantics');

const summonQueenCatData = activeSkills.find((entry) => entry.selfId === 1331);
assert(summonQueenCatData, 'Summon Queen of Cat should be present in active skills data');
assert.strictEqual(summonQueenCatData.time.hitTime, 15000, 'Summon Queen of Cat should preserve sourced 15000ms hit time');
assert.strictEqual(summonQueenCatData.summon.totalLifeTime, 1200000, 'Summon Queen of Cat should preserve sourced summon lifetime');
assert.strictEqual(summonQueenCatData.summon.expPenalty, 0.05, 'Summon Queen of Cat should preserve sourced exp penalty');
assert.strictEqual(summonQueenCatData.summon.itemConsumeSteps, 4, 'Summon Queen of Cat should preserve sourced summon crystal consume step mode');
assert.strictEqual(summonQueenCatData.levels.length, 10, 'Summon Queen of Cat should preserve sourced 10 base levels');
assert.strictEqual(summonQueenCatData.levels[0].mp, 70, 'Summon Queen of Cat level 1 MP should use sourced initial + consume total');
assert.strictEqual(summonQueenCatData.levels[1].mp, 108, 'Summon Queen of Cat level 2 MP should preserve sourced initial + consume total');
assert.strictEqual(summonQueenCatData.levels[0].itemId, 1459, 'Summon Queen of Cat should preserve sourced crystal item id');
assert.strictEqual(summonQueenCatData.levels[0].itemCountOT, 1, 'Summon Queen of Cat level 1 should preserve sourced ongoing crystal count');
assert.strictEqual(summonQueenCatData.levels[0].npcId, 13137, 'Summon Queen of Cat level 1 should preserve sourced npcId');
assert.strictEqual(summonQueenCatData.levels[9].mp, 123, 'Summon Queen of Cat level 10 MP should use sourced initial + consume total');
assert.strictEqual(summonQueenCatData.levels[9].itemCount, 4, 'Summon Queen of Cat level 10 should preserve sourced crystal count');
assert.strictEqual(summonQueenCatData.levels[9].itemCountOT, 3, 'Summon Queen of Cat level 10 should preserve sourced ongoing crystal count');
assert.strictEqual(summonQueenCatData.levels[9].npcId, 13146, 'Summon Queen of Cat level 10 should preserve sourced npcId');
const summonQueenCat = skill({ selfId: 1331, name: 'Summon Queen of Cat', spell: true, power: 1, level: 10, distance: -1 });
assert.strictEqual(summonQueenCat.fetchSkillType(), C4SkillRules.SUMMON, 'Summon Queen of Cat should resolve to SUMMON instead of magic damage');
assert.strictEqual(summonQueenCat.fetchTargetKind(), 'self', 'Summon Queen of Cat should preserve sourced TARGET_SELF semantics');
assert.strictEqual(summonQueenCat.fetchSsBoost(), 0, 'Summon Queen of Cat should not consume offensive shot boost semantics');

const summonSeraphimData = activeSkills.find((entry) => entry.selfId === 1332);
assert(summonSeraphimData, 'Summon Unicorn Seraphim should be present in active skills data');
assert.strictEqual(summonSeraphimData.time.hitTime, 15000, 'Summon Unicorn Seraphim should preserve sourced 15000ms hit time');
assert.strictEqual(summonSeraphimData.summon.totalLifeTime, 1200000, 'Summon Unicorn Seraphim should preserve sourced summon lifetime');
assert.strictEqual(summonSeraphimData.summon.expPenalty, 0.05, 'Summon Unicorn Seraphim should preserve sourced exp penalty');
assert.strictEqual(summonSeraphimData.summon.itemConsumeSteps, 4, 'Summon Unicorn Seraphim should preserve sourced summon crystal consume step mode');
assert.strictEqual(summonSeraphimData.levels.length, 10, 'Summon Unicorn Seraphim should preserve sourced 10 base levels');
assert.strictEqual(summonSeraphimData.levels[0].mp, 70, 'Summon Unicorn Seraphim level 1 MP should use sourced initial + consume total');
assert.strictEqual(summonSeraphimData.levels[1].mp, 108, 'Summon Unicorn Seraphim level 2 MP should preserve sourced initial + consume total');
assert.strictEqual(summonSeraphimData.levels[0].itemId, 1459, 'Summon Unicorn Seraphim should preserve sourced crystal item id');
assert.strictEqual(summonSeraphimData.levels[0].itemCountOT, 1, 'Summon Unicorn Seraphim level 1 should preserve sourced ongoing crystal count');
assert.strictEqual(summonSeraphimData.levels[0].npcId, 13151, 'Summon Unicorn Seraphim level 1 should preserve sourced npcId');
assert.strictEqual(summonSeraphimData.levels[9].mp, 123, 'Summon Unicorn Seraphim level 10 MP should use sourced initial + consume total');
assert.strictEqual(summonSeraphimData.levels[9].itemCount, 4, 'Summon Unicorn Seraphim level 10 should preserve sourced crystal count');
assert.strictEqual(summonSeraphimData.levels[9].itemCountOT, 3, 'Summon Unicorn Seraphim level 10 should preserve sourced ongoing crystal count');
assert.strictEqual(summonSeraphimData.levels[9].npcId, 13160, 'Summon Unicorn Seraphim level 10 should preserve sourced npcId');
const summonSeraphim = skill({ selfId: 1332, name: 'Summon Unicorn Seraphim', spell: true, power: 1, level: 10, distance: -1 });
assert.strictEqual(summonSeraphim.fetchSkillType(), C4SkillRules.SUMMON, 'Summon Unicorn Seraphim should resolve to SUMMON instead of magic damage');
assert.strictEqual(summonSeraphim.fetchTargetKind(), 'self', 'Summon Unicorn Seraphim should preserve sourced TARGET_SELF semantics');
assert.strictEqual(summonSeraphim.fetchSsBoost(), 0, 'Summon Unicorn Seraphim should not consume offensive shot boost semantics');

const summonNightshadeData = activeSkills.find((entry) => entry.selfId === 1333);
assert(summonNightshadeData, 'Summon Nightshade should be present in active skills data');
assert.strictEqual(summonNightshadeData.time.hitTime, 15000, 'Summon Nightshade should preserve sourced 15000ms hit time');
assert.strictEqual(summonNightshadeData.summon.totalLifeTime, 1200000, 'Summon Nightshade should preserve sourced summon lifetime');
assert.strictEqual(summonNightshadeData.summon.expPenalty, 0.05, 'Summon Nightshade should preserve sourced exp penalty');
assert.strictEqual(summonNightshadeData.summon.itemConsumeSteps, 4, 'Summon Nightshade should preserve sourced summon crystal consume step mode');
assert.strictEqual(summonNightshadeData.levels.length, 10, 'Summon Nightshade should preserve sourced 10 base levels');
assert.strictEqual(summonNightshadeData.levels[0].mp, 70, 'Summon Nightshade level 1 MP should use sourced initial + consume total');
assert.strictEqual(summonNightshadeData.levels[1].mp, 108, 'Summon Nightshade level 2 MP should preserve sourced initial + consume total');
assert.strictEqual(summonNightshadeData.levels[0].itemId, 1459, 'Summon Nightshade should preserve sourced crystal item id');
assert.strictEqual(summonNightshadeData.levels[0].itemCountOT, 1, 'Summon Nightshade level 1 should preserve sourced ongoing crystal count');
assert.strictEqual(summonNightshadeData.levels[0].npcId, 13165, 'Summon Nightshade level 1 should preserve sourced npcId');
assert.strictEqual(summonNightshadeData.levels[9].mp, 123, 'Summon Nightshade level 10 MP should use sourced initial + consume total');
assert.strictEqual(summonNightshadeData.levels[9].itemCount, 4, 'Summon Nightshade level 10 should preserve sourced crystal count');
assert.strictEqual(summonNightshadeData.levels[9].itemCountOT, 3, 'Summon Nightshade level 10 should preserve sourced ongoing crystal count');
assert.strictEqual(summonNightshadeData.levels[9].npcId, 13174, 'Summon Nightshade level 10 should preserve sourced npcId');
const summonNightshade = skill({ selfId: 1333, name: 'Summon Nightshade', spell: true, power: 1, level: 10, distance: -1 });
assert.strictEqual(summonNightshade.fetchSkillType(), C4SkillRules.SUMMON, 'Summon Nightshade should resolve to SUMMON instead of magic damage');
assert.strictEqual(summonNightshade.fetchTargetKind(), 'self', 'Summon Nightshade should preserve sourced TARGET_SELF semantics');
assert.strictEqual(summonNightshade.fetchSsBoost(), 0, 'Summon Nightshade should not consume offensive shot boost semantics');

const summonCursedManData = activeSkills.find((entry) => entry.selfId === 1334);
assert(summonCursedManData, 'Summon Cursed Man should be present in active skills data');
assert.strictEqual(summonCursedManData.template.distance, 40, 'Summon Cursed Man should preserve sourced corpse cast range');
assert.strictEqual(summonCursedManData.time.hitTime, 1500, 'Summon Cursed Man should preserve sourced 1500ms hit time');
assert.strictEqual(summonCursedManData.summon.totalLifeTime, 1200000, 'Summon Cursed Man should preserve sourced summon lifetime');
assert.strictEqual(summonCursedManData.summon.expPenalty, 0.15, 'Summon Cursed Man should preserve sourced exp penalty');
assert.strictEqual(summonCursedManData.summon.itemConsumeSteps, 4, 'Summon Cursed Man should preserve sourced summon crystal consume step mode');
assert.strictEqual(summonCursedManData.summon.effectRange, 400, 'Summon Cursed Man should preserve sourced effect range');
assert.strictEqual(summonCursedManData.levels.length, 7, 'Summon Cursed Man should preserve sourced 7 base levels');
assert.strictEqual(summonCursedManData.levels[0].mp, 103, 'Summon Cursed Man level 1 MP should use sourced initial + consume total');
assert.strictEqual(summonCursedManData.levels[0].itemId, 1459, 'Summon Cursed Man should preserve sourced crystal item id');
assert.strictEqual(summonCursedManData.levels[0].itemCountOT, 2, 'Summon Cursed Man level 1 should preserve sourced ongoing crystal count');
assert.strictEqual(summonCursedManData.levels[0].npcId, 13179, 'Summon Cursed Man level 1 should preserve sourced npcId');
assert.strictEqual(summonCursedManData.levels[6].mp, 137, 'Summon Cursed Man level 7 MP should use sourced initial + consume total');
assert.strictEqual(summonCursedManData.levels[6].itemCount, 3, 'Summon Cursed Man level 7 should preserve sourced crystal count');
assert.strictEqual(summonCursedManData.levels[6].itemCountOT, 4, 'Summon Cursed Man level 7 should preserve sourced ongoing crystal count');
assert.strictEqual(summonCursedManData.levels[6].npcId, 13185, 'Summon Cursed Man level 7 should preserve sourced npcId');
const summonCursedMan = skill({ selfId: 1334, name: 'Summon Cursed Man', spell: true, power: 1, level: 7, distance: 40 });
assert.strictEqual(summonCursedMan.fetchSkillType(), C4SkillRules.SUMMON, 'Summon Cursed Man should resolve to SUMMON instead of magic damage');
assert.strictEqual(summonCursedMan.fetchTargetKind(), 'corpse_mob', 'Summon Cursed Man should preserve sourced TARGET_CORPSE_MOB semantics');
assert.strictEqual(summonCursedMan.fetchSsBoost(), 0, 'Summon Cursed Man should not consume offensive shot boost semantics');

const sealWinterData = activeSkills.find((entry) => entry.selfId === 1104);
assert(sealWinterData, 'Seal of Winter should be present in active skills data');
assert.strictEqual(sealWinterData.levels.length, 14, 'Seal of Winter should preserve sourced 14 base levels');
assert.strictEqual(sealWinterData.time.hitTime, 1500, 'Seal of Winter should preserve sourced 1500ms hit time');
assert.strictEqual(sealWinterData.time.reuse, 8000, 'Seal of Winter should preserve sourced 8000ms reuse');
assert.strictEqual(sealWinterData.time.buff, 15000, 'Seal of Winter should preserve sourced 15 second duration');
assert.strictEqual(sealWinterData.levels[0].power, 40, 'Seal of Winter active data should preserve sourced power 40');
assert.strictEqual(sealWinterData.levels[13].mp, 103, 'Seal of Winter level 14 MP should use sourced initial + consume total');
const wintered = statActor();
const sealWinter = skill({ selfId: 1104, name: 'Seal of Winter', spell: true, power: 40, level: 14, buff: 15000 });
const sealWinterOutcome = SkillEffects.execute(session(), caster, wintered, sealWinter, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(sealWinter.fetchTargetKind(), 'enemy', 'Seal of Winter should resolve as an enemy debuff');
assert.strictEqual(sealWinterOutcome.effect.key, 'seal_of_winter', 'Seal of Winter should apply a structured debuff effect');
assert.strictEqual(EffectStats.multiplier(wintered, 'pAtkSpdMul'), 0.77, 'Seal of Winter should use sourced C4 pAtkSpd 0.77');
calculateStats({}, wintered);
assert.strictEqual(
    wintered.collectiveAtkSpd,
    Math.round(Formulas.calcAtkSpd(30, 300) * 0.77),
    'Seal of Winter should apply the sourced C4 attack speed multiplier'
);

const sealSuspensionData = activeSkills.find((entry) => entry.selfId === 1248);
assert(sealSuspensionData, 'Seal of Suspension should be present in active skills data');
assert.strictEqual(sealSuspensionData.levels.length, 12, 'Seal of Suspension should preserve sourced 12 base levels');
assert.strictEqual(sealSuspensionData.levels[0].power, 60, 'Seal of Suspension active data should preserve sourced power 60');
assert.strictEqual(sealSuspensionData.levels[11].mp, 103, 'Seal of Suspension level 12 MP should use sourced initial + consume total');
const suspended = statActor();
const sealSuspension = skill({ selfId: 1248, name: 'Seal of Suspension', spell: true, power: 60, level: 12, buff: 120000 });
const sealSuspensionOutcome = SkillEffects.execute(session(), caster, suspended, sealSuspension, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(sealSuspension.fetchTargetKind(), 'enemy', 'Seal of Suspension should resolve as an enemy debuff');
assert.strictEqual(sealSuspensionOutcome.effect.key, 'seal_of_suspension', 'Seal of Suspension should apply a structured debuff effect');
assert.strictEqual(EffectStats.multiplier(suspended, 'mReuseMul'), 3, 'Seal of Suspension should use sourced C4 mReuse multiplier 3');
assert.strictEqual(EffectStats.multiplier(suspended, 'pReuseMul'), 3, 'Seal of Suspension should use sourced C4 pReuse multiplier 3');

const frozen = statActor();
const freezingStrike = skill({ selfId: 105, name: 'Freezing Strike', spell: true, power: 26, buff: 30000 });
SkillEffects.execute(session(), caster, frozen, freezingStrike, {
    magicSkill: true,
    rng: () => 0,
    attack: {
        clearLoadedShot() {},
        prepareSkillDamage: () => 1
    }
});
calculateStats({}, frozen);
assert.strictEqual(
    frozen.collectiveRunSpd,
    Math.round(Formulas.calcSpeed(30, 120) * 0.7),
    'Freezing Strike should apply the L2J RunSpeedDown 0.7 multiplier'
);

const windShackled = statActor();
const windShackle = skill({ selfId: 1206, name: 'Wind Shackle', spell: true, power: 1, level: 5, buff: 120000 });
const windShackleOutcome = SkillEffects.execute(session(), caster, windShackled, windShackle, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(windShackle.fetchTargetKind(), 'enemy', 'Wind Shackle should resolve as an enemy debuff instead of a self buff');
assert.strictEqual(windShackleOutcome.effect.key, 'wind_shackle', 'Wind Shackle should apply a structured debuff effect');
assert.strictEqual(EffectStats.multiplier(windShackled, 'pAtkSpdMul'), 0.80, 'Wind Shackle level 5 should use sourced pAtkSpd 0.80');
calculateStats({}, windShackled);
assert.strictEqual(
    windShackled.collectiveAtkSpd,
    Math.round(Formulas.calcAtkSpd(30, 300) * 0.80),
    'Wind Shackle level 5 should apply the sourced L2J pAtkSpd multiplier'
);

const poisoned = statActor();
const poisonEffect = EffectStore.apply(poisoned, {
    key: 'poison',
    id: 129,
    level: 3,
    type: 'debuff',
    category: 'poison',
    dot: { damage: 3, count: 10, intervalMs: 3000 },
    durationMs: 30000
});
invoke('GameServer/Effects/EffectTicker').applyDot(session(), caster, poisoned, poisonEffect);
assert(poisoned.effectTimers.poison, 'Poison test setup should start a DoT ticker');
const curePoison = skill({ selfId: 1012, name: 'Cure Poison', spell: true, power: 1, level: 1 });
const cleanseOutcome = SkillEffects.execute(session(), caster, poisoned, curePoison, {
    magicSkill: true,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(cleanseOutcome.cleansed.length, 1, 'Cure Poison level 1 should negate Poison effects up to sourced power 3');
assert.strictEqual(EffectStore.hasDebuff(poisoned, 'poison'), false, 'Cure Poison should remove the poison debuff');
assert.strictEqual(poisoned.effectTimers.poison, undefined, 'Cure Poison should stop the poison DoT ticker');

const cursePoison = skill({ selfId: 1168, name: 'Curse:Poison', spell: true, power: 1, level: 4, buff: 30000 });
const curseTarget = statActor();
const curseOutcome = SkillEffects.execute(session(), caster, curseTarget, cursePoison, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(curseOutcome.effect.dot.damage, 5, 'Curse: Poison should use the sourced L2J damage table when local active.json has flat power');
EffectStore.remove(curseTarget, 'poison');

const sealPoisonData = activeSkills.find((entry) => entry.selfId === 1209);
assert(sealPoisonData, 'Seal of Poison should be present in active skills data');
assert.strictEqual(sealPoisonData.levels.length, 6, 'Seal of Poison should preserve sourced 6 base levels');
assert.strictEqual(sealPoisonData.levels[5].power, 8, 'Seal of Poison level 6 should preserve sourced power 8');
assert.strictEqual(sealPoisonData.levels[5].mp, 98, 'Seal of Poison level 6 MP should use sourced initial + consume total');
const sealPoison = skill({ selfId: 1209, name: 'Seal of Poison', spell: true, power: 8, level: 6, distance: -1, buff: 30000 });
const sealPoisonTarget = statActor();
const sealPoisonOutcome = SkillEffects.execute(session(), caster, sealPoisonTarget, sealPoison, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(sealPoison.fetchTargetKind(), 'enemy', 'Seal of Poison should resolve as an enemy poison effect');
assert.strictEqual(sealPoison.fetchSemantic().baseLandRate, 8, 'Seal of Poison should use sourced level 6 power as land rate');
assert.strictEqual(sealPoisonOutcome.effect.key, 'poison', 'Seal of Poison should apply the structured poison effect');
assert.strictEqual(sealPoisonOutcome.effect.dot.damage, 48, 'Seal of Poison level 6 should use sourced DamOverTime value 48');
assert.strictEqual(sealPoisonOutcome.effect.dot.count, 10, 'Seal of Poison should use sourced 10 damage ticks');
assert.strictEqual(sealPoisonOutcome.effect.dot.intervalMs, 3000, 'Seal of Poison should tick every sourced 3 seconds');
assert.strictEqual(EffectStore.hasDebuff(sealPoisonTarget, 'poison'), true, 'Seal of Poison should leave a poison debuff');
EffectStore.remove(sealPoisonTarget, 'poison');

const sealGloomData = activeSkills.find((entry) => entry.selfId === 1210);
assert(sealGloomData, 'Seal of Gloom should be present in active skills data');
assert.strictEqual(sealGloomData.time.buff, 15000, 'Seal of Gloom should preserve sourced 15 second MDOT duration');
assert.strictEqual(sealGloomData.levels.length, 4, 'Seal of Gloom should preserve sourced 4 base levels');
assert.strictEqual(sealGloomData.levels[3].power, 53, 'Seal of Gloom level 4 should preserve sourced power 53');
assert.strictEqual(sealGloomData.levels[3].mp, 100, 'Seal of Gloom level 4 MP should use sourced initial + consume total');
const sealGloom = skill({ selfId: 1210, name: 'Seal of Gloom', spell: true, power: 53, level: 4, distance: -1, buff: 15000 });
const sealGloomTarget = statActor();
const sealGloomOutcome = SkillEffects.execute(session(), caster, sealGloomTarget, sealGloom, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(sealGloom.fetchTargetKind(), 'enemy', 'Seal of Gloom should resolve as an enemy mana damage-over-time effect');
assert.strictEqual(sealGloom.fetchSemantic().baseLandRate, 53, 'Seal of Gloom should use sourced level 4 power as land rate');
assert.strictEqual(sealGloomOutcome.effect.key, 'seal_of_gloom', 'Seal of Gloom should apply a structured debuff effect');
assert.strictEqual(sealGloomOutcome.effect.manaDot.damage, 12, 'Seal of Gloom level 4 should use sourced ManaDamOverTime value 12');
assert.strictEqual(sealGloomOutcome.effect.manaDot.count, 15, 'Seal of Gloom should use sourced 15 mana damage ticks');
assert.strictEqual(sealGloomOutcome.effect.manaDot.intervalMs, 1000, 'Seal of Gloom should tick every sourced second');
assert.strictEqual(EffectStore.hasDebuff(sealGloomTarget, 'seal_of_gloom'), true, 'Seal of Gloom should leave a debuff entry');
EffectStore.remove(sealGloomTarget, 'seal_of_gloom');

const sealMirageData = activeSkills.find((entry) => entry.selfId === 1213);
assert(sealMirageData, 'Seal of Mirage should be present in active skills data');
assert.strictEqual(sealMirageData.time.buff, 30000, 'Seal of Mirage should preserve sourced Confusion duration');
assert.strictEqual(sealMirageData.levels.length, 13, 'Seal of Mirage should preserve sourced 13 base levels');
assert.strictEqual(sealMirageData.levels[1].mp, 65, 'Seal of Mirage level 2 MP should use sourced initial + consume total');
assert.strictEqual(sealMirageData.levels[12].mp, 103, 'Seal of Mirage level 13 MP should use sourced initial + consume total');
const sealMirage = skill({ selfId: 1213, name: 'Seal of Mirage', spell: true, power: 1, level: 13, distance: -1, buff: 30000 });
const livingMirageTarget = statActor();
const livingMirageOutcome = SkillEffects.execute(session(), caster, livingMirageTarget, sealMirage, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(sealMirage.fetchTargetKind(), 'enemy', 'Seal of Mirage should resolve as an enemy mob-only debuff');
assert.strictEqual(livingMirageOutcome.effect, null, 'Seal of Mirage should not apply CONFUSE_MOB_ONLY to living players');
assert.strictEqual(livingMirageOutcome.effectResisted, true, 'Seal of Mirage mob-only rejection should report effect resistance');
const mobMirageTarget = statActor();
mobMirageTarget.fetchAttackable = () => true;
const mobMirageOutcome = SkillEffects.execute(session(), caster, mobMirageTarget, sealMirage, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(mobMirageOutcome.effect.key, 'confusion', 'Seal of Mirage should apply sourced Confusion to attackable NPCs');
assert.strictEqual(EffectStore.impairments(mobMirageTarget).confused, true, 'Seal of Mirage confusion should be visible through impairments');

const chantLifeTarget = statActor();
chantLifeTarget.hp = 40;
chantLifeTarget.maxHp = 100;
const chantLife = skill({ selfId: 1229, name: 'Chant of Life', spell: true, power: 1, level: 9, buff: 15000 });
const chantLifeOutcome = SkillEffects.execute(session(), caster, chantLifeTarget, chantLife, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(chantLife.fetchSkillType(), C4SkillRules.HOT, 'Chant of Life should resolve to HOT');
assert.strictEqual(chantLifeOutcome.effect.key, 'chant_of_life', 'Chant of Life should apply a structured heal-over-time buff');
assert.strictEqual(chantLifeOutcome.effect.hot.heal, 43, 'Chant of Life level 9 should use sourced HealOverTime value 43');
assert.strictEqual(chantLifeOutcome.effect.hot.count, 15, 'Chant of Life should use sourced 15 heal ticks');
assert.strictEqual(chantLifeOutcome.effect.hot.intervalMs, 1000, 'Chant of Life should tick every sourced second');
assert(chantLifeTarget.effectTimers.chant_of_life, 'Chant of Life should start a runtime heal-over-time ticker');
EffectStore.remove(chantLifeTarget, 'chant_of_life');

const heartTarget = statActor();
heartTarget.hp = 400;
heartTarget.maxHp = 1000;
const heartPaagrio = skill({ selfId: 1256, name: 'Heart of Paagrio', spell: true, power: 1, level: 4, buff: 15000 });
const heartOutcome = SkillEffects.execute(session(), caster, heartTarget, heartPaagrio, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(heartPaagrio.fetchSkillType(), C4SkillRules.HEAL_HOT, "Heart of Pa'agrio should resolve to instant heal plus HOT");
assert.strictEqual(heartOutcome.heal, 127, "Heart of Pa'agrio level 4 should restore sourced instant heal 127");
assert.strictEqual(heartTarget.fetchHp(), 527, "Heart of Pa'agrio should apply sourced instant heal instead of active.json power 1");
assert.strictEqual(heartOutcome.effect.key, 'heart_of_paagrio', "Heart of Pa'agrio should apply a structured heal-over-time buff");
assert.strictEqual(heartOutcome.effect.hot.heal, 43, "Heart of Pa'agrio level 4 should use sourced HealOverTime value 43");
assert(heartTarget.effectTimers.heart_of_paagrio, "Heart of Pa'agrio should start a runtime heal-over-time ticker");
EffectStore.remove(heartTarget, 'heart_of_paagrio');

const bleed = skill({ selfId: 96, name: 'Bleed', spell: false, power: 1, level: 4, buff: 20000 });
const bleedTarget = statActor();
const bleedOutcome = SkillEffects.execute(session(), caster, bleedTarget, bleed, {
    magicSkill: false,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(bleedOutcome.effect.dot.count, 7, 'Bleed should use the sourced 7 tick duration');
assert.strictEqual(bleedOutcome.effect.dot.intervalMs, 3000, 'Bleed should tick every 3 seconds');
assert.strictEqual(bleedOutcome.effect.dot.damage, 81, 'Bleed should use the sourced damage table instead of local flat power');
const cureBleeding = skill({ selfId: 61, name: 'Cure Bleeding', spell: true, power: 7, level: 2 });
const cureBleedOutcome = SkillEffects.execute(session(), caster, bleedTarget, cureBleeding, {
    magicSkill: true,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(cureBleedOutcome.cleansed.length, 1, 'Cure Bleeding should remove matching bleed effects');
assert.strictEqual(EffectStore.hasDebuff(bleedTarget, 'bleed'), false, 'Cure Bleeding should clear bleed debuff state');

const purified = statActor();
EffectStore.apply(purified, { key: 'poison', id: 129, level: 3, type: 'debuff', category: 'poison', durationMs: 30000 });
EffectStore.apply(purified, { key: 'bleed', id: 96, level: 4, type: 'debuff', category: 'bleed', durationMs: 30000 });
EffectStore.apply(purified, { key: 'paralyze', id: 99901, level: 7, type: 'debuff', category: 'paralyze', durationMs: 30000 });
const purify = skill({ selfId: 1018, name: 'Purify', spell: true, power: 1, level: 2 });
const purifyOutcome = SkillEffects.execute(session(), caster, purified, purify, {
    magicSkill: true,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(purifyOutcome.cleansed.length, 3, 'Purify level 2 should cleanse poison, bleed, and paralyze up to sourced power 7');
assert.strictEqual(EffectStore.hasDebuff(purified, ['poison', 'bleed', 'paralyze']), false, 'Purify should clear supported abnormal states');

const vitalized = statActor();
vitalized.hp = 100;
vitalized.maxHp = 1000;
EffectStore.apply(vitalized, { key: 'poison', id: 129, level: 7, type: 'debuff', category: 'poison', durationMs: 30000 });
EffectStore.apply(vitalized, { key: 'bleed', id: 96, level: 7, type: 'debuff', category: 'bleed', durationMs: 30000 });
const vitalize = skill({ selfId: 1020, name: 'Vitalize', spell: true, power: 1, level: 6 });
const vitalizeOutcome = SkillEffects.execute(session(), caster, vitalized, vitalize, {
    magicSkill: true,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(vitalizeOutcome.heal, 521, 'Vitalize should use sourced L2J heal power table');
assert.strictEqual(vitalized.fetchHp(), 621, 'Vitalize should restore HP and not only cleanse');
assert.strictEqual(vitalizeOutcome.cleansed.length, 2, 'Vitalize level 6 should cleanse poison and bleed up to sourced negate power 7');
assert.strictEqual(EffectStore.hasDebuff(vitalized, ['poison', 'bleed']), false, 'Vitalize should clear supported DoT debuffs');

const poisonProtected = statActor();
const resistPoison = skill({ selfId: 1033, name: 'Resist Poison', spell: true, power: 1, level: 3, buff: 1200000 });
const resistPoisonOutcome = SkillEffects.execute(session(), caster, poisonProtected, resistPoison, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(resistPoisonOutcome.effect.key, 'resist_poison', 'Resist Poison should apply a structured buff effect');
assert.strictEqual(EffectStats.add(poisonProtected, 'poisonResist'), 50, 'Resist Poison level 3 should add sourced poisonResist 50');
const basicPoison = skill({ selfId: 129, name: 'Poison', spell: true, power: 3, level: 1, buff: 30000 });
const resistedPoisonOutcome = SkillEffects.execute(session(), caster, poisonProtected, basicPoison, {
    magicSkill: true,
    rng: () => 0.5,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(resistedPoisonOutcome.effect, null, 'Poison should not apply when sourced poisonResist lowers the land chance below the roll');
assert.strictEqual(resistedPoisonOutcome.effectResisted, true, 'Poison resist should be reported separately from magic failure');
assert.strictEqual(EffectStore.hasDebuff(poisonProtected, 'poison'), false, 'Resisted Poison should not leave a debuff');

const bleedProtected = statActor();
const invigor = skill({ selfId: 1032, name: 'Invigor', spell: true, power: 1, level: 2, buff: 1200000 });
const invigorOutcome = SkillEffects.execute(session(), caster, bleedProtected, invigor, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(invigorOutcome.effect.key, 'invigor', 'Invigor should apply a structured buff effect');
assert.strictEqual(EffectStats.add(bleedProtected, 'bleedResist'), 40, 'Invigor level 2 should add sourced bleedResist 40');
const resistedBleedOutcome = SkillEffects.execute(session(), caster, bleedProtected, bleed, {
    magicSkill: false,
    rng: () => 0.75,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(resistedBleedOutcome.effect, null, 'Bleed should not apply when sourced bleedResist lowers the land chance below the roll');
assert.strictEqual(resistedBleedOutcome.effectResisted, true, 'Bleed resist should be reported separately from physical skill miss');
assert.strictEqual(EffectStore.hasDebuff(bleedProtected, 'bleed'), false, 'Resisted Bleed should not leave a debuff');

const mentallyProtected = statActor();
const mentalShield = skill({ selfId: 1035, name: 'Mental Shield', spell: true, power: 1, level: 4, buff: 1200000 });
const mentalShieldOutcome = SkillEffects.execute(session(), caster, mentallyProtected, mentalShield, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(mentalShieldOutcome.effect.key, 'mental_shield', 'Mental Shield should apply a structured buff effect');
assert.strictEqual(EffectStats.add(mentallyProtected, 'rootResist'), 50, 'Mental Shield level 4 should add sourced rootResist 50');
assert.strictEqual(EffectStats.add(mentallyProtected, 'sleepResist'), 50, 'Mental Shield level 4 should add sourced sleepResist 50');
assert.strictEqual(EffectStats.add(mentallyProtected, 'mentalResist'), 50, 'Mental Shield level 4 should add sourced mentalResist 50');

const sleepAgainstShield = SkillEffects.execute(session(), caster, mentallyProtected, sleep, {
    magicSkill: true,
    rng: () => 0.5,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(sleepAgainstShield.effect, null, 'Mental Shield sleepResist should lower Sleep land chance below the roll');
assert.strictEqual(sleepAgainstShield.effectResisted, true, 'Sleep blocked by Mental Shield should report effect resistance');

const entangle = skill({ selfId: 102, name: 'Entangle', spell: true, power: 1, level: 1, buff: 120000 });
const entangleAgainstShield = SkillEffects.execute(session(), caster, mentallyProtected, entangle, {
    magicSkill: true,
    rng: () => 0.5,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(entangleAgainstShield.effect, null, 'Mental Shield rootResist should lower Entangle land chance below the roll');
assert.strictEqual(entangleAgainstShield.effectResisted, true, 'Entangle blocked by Mental Shield should report effect resistance');

const holdUndeadData = activeSkills.find((entry) => entry.selfId === 1042);
assert(holdUndeadData, 'Hold Undead should be present in active skills data');
assert.strictEqual(holdUndeadData.levels.length, 12, 'Hold Undead should preserve sourced 12 base levels');
assert.strictEqual(holdUndeadData.time.reuse, 60000, 'Hold Undead should preserve sourced 60000ms reuse');
assert.strictEqual(holdUndeadData.levels[0].power, 20, 'Hold Undead should preserve sourced power 20');
assert.strictEqual(holdUndeadData.levels[11].mp, 204, 'Hold Undead level 12 MP should use sourced initial + consume total');
const livingHoldTarget = statActor();
const holdUndead = skill({ selfId: 1042, name: 'Hold Undead', spell: true, power: 20, level: 12, distance: 400, buff: 120000 });
const livingHoldOutcome = SkillEffects.execute(session(), caster, livingHoldTarget, holdUndead, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(livingHoldOutcome.effect, null, 'Hold Undead should not apply TARGET_UNDEAD to living targets');
assert.strictEqual(livingHoldOutcome.effectResisted, true, 'Hold Undead undead-only rejection should report effect resistance');
const undeadHoldTarget = statActor();
undeadHoldTarget.fetchUndead = () => true;
const undeadHoldOutcome = SkillEffects.execute(session(), caster, undeadHoldTarget, holdUndead, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(holdUndead.fetchTargetKind(), 'enemy', 'Hold Undead should resolve as an enemy undead-only debuff');
assert.strictEqual(undeadHoldOutcome.effect.key, 'paralyze', 'Hold Undead should apply sourced Paralyze to undead targets');
assert.strictEqual(EffectStore.hasDebuff(undeadHoldTarget, 'paralyze'), true, 'Hold Undead should leave a paralyze debuff');
assert.strictEqual(EffectRestrictions.canMove(undeadHoldTarget), false, 'Hold Undead paralyze should block movement through runtime restrictions');

const dryadRootTarget = statActor();
const dryadRoot = skill({ selfId: 1201, name: 'Dryad Root', spell: true, power: 1, level: 5, buff: 30000 });
const dryadRootOutcome = SkillEffects.execute(session(), caster, dryadRootTarget, dryadRoot, {
    magicSkill: true,
    rng: () => 0.8,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(dryadRoot.fetchTargetKind(), 'enemy', 'Dryad Root should resolve as an enemy root effect');
assert.strictEqual(dryadRootOutcome.effect.key, 'root', 'Dryad Root should apply the structured root effect at sourced base land rate 80');
assert.strictEqual(EffectStore.hasDebuff(dryadRootTarget, 'root'), true, 'Dryad Root should leave a root debuff when the sourced land rate passes');

const sealBindingTarget = statActor();
const sealBindingData = activeSkills.find((entry) => entry.selfId === 1208);
assert(sealBindingData, 'Seal of Binding should be present in active skills data');
assert.strictEqual(sealBindingData.levels.length, 17, 'Seal of Binding should preserve sourced 17 base levels');
assert.strictEqual(sealBindingData.levels[0].power, 40, 'Seal of Binding should preserve sourced power 40');
assert.strictEqual(sealBindingData.levels[16].mp, 103, 'Seal of Binding level 17 MP should use sourced initial + consume total');
const sealBinding = skill({ selfId: 1208, name: 'Seal of Binding', spell: true, power: 40, level: 17, distance: -1, buff: 30000 });
const sealBindingOutcome = SkillEffects.execute(session(), caster, sealBindingTarget, sealBinding, {
    magicSkill: true,
    rng: () => 0.43,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(sealBinding.fetchTargetKind(), 'enemy', 'Seal of Binding should resolve as an enemy root effect for the handled target');
assert.strictEqual(sealBindingOutcome.effect.key, 'root', 'Seal of Binding should apply root at sourced base land rate 40');
assert.strictEqual(EffectStore.hasDebuff(sealBindingTarget, 'root'), true, 'Seal of Binding should leave a root debuff when the sourced land rate passes');

const sealSilenceTarget = statActor();
const sealSilence = skill({ selfId: 1246, name: 'Seal of Silence', spell: true, power: 1, level: 1, distance: -1, buff: 60000 });
const sealSilenceOutcome = SkillEffects.execute(session(), caster, sealSilenceTarget, sealSilence, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(sealSilence.fetchTargetKind(), 'enemy', 'Seal of Silence should resolve as an enemy mute effect');
assert.strictEqual(sealSilenceOutcome.effect.key, 'silence', 'Seal of Silence should apply silence at sourced base land rate 40');
assert.strictEqual(EffectStore.hasDebuff(sealSilenceTarget, 'silence'), true, 'Seal of Silence should leave a silence debuff when the sourced land rate passes');
assert.strictEqual(EffectRestrictions.canCast(sealSilenceTarget), false, 'Seal of Silence should block casting through runtime restrictions');
const sealSilenceData = activeSkills.find((entry) => entry.selfId === 1246);
assert(sealSilenceData, 'Seal of Silence should be present in active skills data');
assert.strictEqual(sealSilenceData.levels.length, 12, 'Seal of Silence should preserve sourced 12 base levels');
assert.strictEqual(sealSilenceData.levels[0].power, 40, 'Seal of Silence should preserve sourced power 40');
assert.strictEqual(sealSilenceData.levels[11].mp, 103, 'Seal of Silence level 12 MP should use sourced initial + consume total');

const regenAutomation = new Automation();
regenAutomation.setRevHp(10);
const sealScourgeTarget = statActor();
const sealScourge = skill({ selfId: 1247, name: 'Seal of Scourge', spell: true, power: 1, level: 1, distance: -1, buff: 120000 });
const sealScourgeOutcome = SkillEffects.execute(session(), caster, sealScourgeTarget, sealScourge, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(sealScourgeOutcome.effect.key, 'seal_of_scourge', 'Seal of Scourge should apply a structured regen debuff');
assert.strictEqual(EffectStats.multiplier(sealScourgeTarget, 'regHp'), 0, 'Seal of Scourge should use sourced regHp 0');
assert.strictEqual(regenAutomation.fetchRevHpAmount(sealScourgeTarget), 0, 'Seal of Scourge should stop runtime HP regeneration');

const curseDiseaseData = activeSkills.find((entry) => entry.selfId === 1269);
assert(curseDiseaseData, 'Curse Disease should be present in active skills data');
assert.strictEqual(curseDiseaseData.levels.length, 9, 'Curse Disease active data should preserve sourced 9 levels');
assert.strictEqual(curseDiseaseData.levels[8].mp, 55, 'Curse Disease active data should preserve sourced level 9 MP cost');
const diseaseTarget = statActor();
const curseDisease = skill({ selfId: 1269, name: 'Curse Disease', spell: true, power: 80, level: 9, buff: 120000 });
const curseDiseaseOutcome = SkillEffects.execute(session(), caster, diseaseTarget, curseDisease, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(curseDiseaseOutcome.effect.key, 'curse_disease', 'Curse Disease should apply a structured regen debuff');
assert.strictEqual(EffectStats.multiplier(diseaseTarget, 'regHp'), 0.5, 'Curse Disease should use sourced regHp 0.5');
assert.strictEqual(regenAutomation.fetchRevHpAmount(diseaseTarget), 5, 'Curse Disease should halve runtime HP regeneration');

const vampiricRageData = activeSkills.find((entry) => entry.selfId === 1268);
assert(vampiricRageData, 'Vampiric Rage should be present in active skills data');
assert.strictEqual(vampiricRageData.levels.length, 4, 'Vampiric Rage active data should preserve sourced 4 levels');
assert.strictEqual(vampiricRageData.levels[3].mp, 53, 'Vampiric Rage active data should preserve sourced level 4 MP cost');
const vampiricTarget = statActor();
vampiricTarget.hp = 900;
vampiricTarget.maxHp = 1000;
const vampiricRage = skill({ selfId: 1268, name: 'Vampiric Rage', spell: true, power: 0, level: 4, buff: 1200000 });
const vampiricOutcome = SkillEffects.execute(session(), caster, vampiricTarget, vampiricRage, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(vampiricOutcome.effect.key, 'vampiric_rage', 'Vampiric Rage should apply a structured buff effect');
assert.strictEqual(EffectStats.add(vampiricTarget, 'absorbDam'), 9, 'Vampiric Rage level 4 should use sourced absorbDam 9');
const vampiricAttack = new Attack();
assert.strictEqual(vampiricAttack.applyDamageAbsorb(session(), vampiricTarget, 333), 29, 'Vampiric Rage should floor sourced percent drain from melee damage');
assert.strictEqual(vampiricTarget.fetchHp(), 929, 'Vampiric Rage should restore drained HP to the attacker');
vampiricTarget.hp = 995;
assert.strictEqual(vampiricAttack.applyDamageAbsorb(session(), vampiricTarget, 333), 5, 'Vampiric Rage should clamp drain to missing HP');
const bowVampiricTarget = statActor();
bowVampiricTarget.backpack.fetchTotalWeaponKind = () => 'Weapon.Bow';
EffectStore.apply(bowVampiricTarget, {
    key: 'vampiric_rage',
    type: 'buff',
    category: 'buff',
    stats: { absorbDam: 9 },
    durationMs: 1200000
});
assert.strictEqual(vampiricAttack.applyDamageAbsorb(session(), bowVampiricTarget, 333), 0, 'Vampiric Rage should not drain for bow attacks');

const decreaseWeightData = activeSkills.find((entry) => entry.selfId === 1257);
assert.strictEqual(decreaseWeightData.time.buff, 1200000, 'Decrease Weight active data should preserve sourced 1200s duration');
assert.strictEqual(decreaseWeightData.levels[2].mp, 24, 'Decrease Weight active data should preserve sourced level 3 total MP cost');
const lighterTarget = statActor();
const decreaseWeight = skill({ selfId: 1257, name: 'Decrease Weight', spell: true, power: 1, level: 3, buff: 1200000 });
const decreaseWeightOutcome = SkillEffects.execute(session(), caster, lighterTarget, decreaseWeight, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(decreaseWeightOutcome.effect.key, 'decrease_weight', 'Decrease Weight should apply a structured maxLoad buff');
assert.strictEqual(EffectStats.add(lighterTarget, 'maxLoad'), 9000, 'Decrease Weight level 3 should use sourced maxLoad +9000');
calculateStats({}, lighterTarget);
assert.strictEqual(
    lighterTarget.maxLoad,
    Formulas.calcMaxLoad(30) + 9000,
    'Decrease Weight level 3 should increase runtime max load by the sourced amount'
);

const regenerationData = activeSkills.find((entry) => entry.selfId === 1044);
assert.strictEqual(regenerationData.levels[1].mp, 44, 'Regeneration active data should preserve sourced level 2 total MP cost');
const regenerationTarget = statActor();
const regeneration = skill({ selfId: 1044, name: 'Regeneration', spell: true, power: 1, level: 3, buff: 1200000 });
const regenerationOutcome = SkillEffects.execute(session(), caster, regenerationTarget, regeneration, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(regenerationOutcome.effect.key, 'regeneration', 'Regeneration should apply a structured HP regen buff');
assert.strictEqual(EffectStats.multiplier(regenerationTarget, 'regHp'), 1.2, 'Regeneration level 3 should use sourced regHp 1.2');
const regenBuffAutomation = new Automation();
regenBuffAutomation.setRevHp(10);
regenBuffAutomation.setRevMp(10);
assert.strictEqual(regenBuffAutomation.fetchRevHpAmount(regenerationTarget), 12, 'Regeneration should increase runtime HP regeneration by sourced multiplier');

const manaRegenTarget = statActor();
const manaRegeneration = skill({ selfId: 1047, name: 'Mana Regeneration', spell: true, power: 1, level: 4, distance: -1, buff: 1200000 });
const manaRegenOutcome = SkillEffects.execute(session(), caster, manaRegenTarget, manaRegeneration, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(manaRegenOutcome.effect.key, 'mana_regeneration', 'Mana Regeneration should apply a structured MP regen buff');
assert.strictEqual(EffectStats.add(manaRegenTarget, 'regMp'), 3.09, 'Mana Regeneration level 4 should use sourced regMp +3.09');
assert.strictEqual(regenBuffAutomation.fetchRevMpAmount(manaRegenTarget), 13, 'Mana Regeneration should increase runtime MP regeneration by sourced addition');

const magicBarrierTarget = statActor();
const magicBarrier = skill({ selfId: 1036, name: 'Magic Barrier', spell: true, power: 1, level: 2, buff: 1200000 });
const magicBarrierOutcome = SkillEffects.execute(session(), caster, magicBarrierTarget, magicBarrier, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(magicBarrierOutcome.effect.key, 'magic_barrier', 'Magic Barrier should apply a structured buff effect');
assert.strictEqual(EffectStats.multiplier(magicBarrierTarget, 'mDefMul'), 1.3, 'Magic Barrier level 2 should use sourced mDef 1.3');
calculateStats({}, magicBarrierTarget);
assert.strictEqual(
    magicBarrierTarget.collectiveMDef,
    Math.round(Formulas.calcMDef(20, 30, 80) * 1.3),
    'Magic Barrier level 2 should apply the sourced L2J MDef multiplier'
);

const empowerTarget = statActor();
const empower = skill({ selfId: 1059, name: 'Empower', spell: true, power: 1, level: 3, buff: 1200000 });
const empowerOutcome = SkillEffects.execute(session(), caster, empowerTarget, empower, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(empowerOutcome.effect.key, 'empower', 'Empower should apply a structured buff effect');
assert.strictEqual(EffectStats.multiplier(empowerTarget, 'mAtkMul'), 1.75, 'Empower level 3 should use sourced mAtk 1.75');
calculateStats({}, empowerTarget);
assert.strictEqual(
    empowerTarget.collectiveMAtk,
    Math.round(Formulas.calcMAtk(20, 30, 50) * 1.75),
    'Empower level 3 should apply the sourced L2J MAtk multiplier'
);

const acumenTarget = statActor();
const acumen = skill({ selfId: 1085, name: 'Acumen', spell: true, power: 1, level: 3, buff: 1200000 });
const acumenOutcome = SkillEffects.execute(session(), caster, acumenTarget, acumen, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(acumenOutcome.effect.key, 'acumen', 'Acumen should apply a structured buff effect');
assert.strictEqual(EffectStats.multiplier(acumenTarget, 'castSpdMul'), 1.3, 'Acumen level 3 should use sourced mAtkSpd 1.3');
calculateStats({}, acumenTarget);
assert.strictEqual(
    acumenTarget.collectiveCastSpd,
    Math.round(Formulas.calcCastSpd(30) * 1.3),
    'Acumen level 3 should apply the sourced L2J mAtkSpd multiplier'
);

const focusTarget = statActor();
const focus = skill({ selfId: 1077, name: 'Focus', spell: true, power: 1, level: 3, buff: 1200000 });
const focusOutcome = SkillEffects.execute(session(), caster, focusTarget, focus, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(focusOutcome.effect.key, 'focus', 'Focus should apply a structured buff effect');
assert.strictEqual(EffectStats.add(focusTarget, 'pCritRateAdd'), 30, 'Focus level 3 should use sourced pCritRate +30');
calculateStats({}, focusTarget);
assert.strictEqual(
    focusTarget.collectiveCritical,
    Formulas.calcCritical(30, 40) + 30,
    'Focus level 3 should apply the sourced L2J pCritRate addition'
);

const deathWhisperTarget = statActor();
const deathWhisper = skill({ selfId: 1242, name: 'Death Whisper', spell: true, power: 1, level: 3, buff: 1200000 });
const deathWhisperOutcome = SkillEffects.execute(session(), caster, deathWhisperTarget, deathWhisper, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(deathWhisperOutcome.effect.key, 'death_whisper', 'Death Whisper should apply a structured buff effect');
assert.strictEqual(EffectStats.multiplier(deathWhisperTarget, 'pCritDamageMul'), 1.35, 'Death Whisper level 3 should use sourced pCritDamage 1.35');
calculateStats({}, deathWhisperTarget);
deathWhisperTarget.fetchCollectiveCritical = () => 1000;
const deathWhisperCrit = new Attack().prepareMeleeHit(deathWhisperTarget, statActor(), true, false, () => 0);
assert.strictEqual(
    deathWhisperCrit.damage,
    Math.round(2 * 1.35 * (70 * deathWhisperTarget.fetchCollectivePAtk() / 100)),
    'Death Whisper level 3 should multiply physical critical damage by sourced pCritDamage'
);

const chantRageTarget = statActor();
const chantRage = skill({ selfId: 1253, name: 'Chant of Rage', spell: true, power: 1, level: 2, buff: 1200000 });
const chantRageOutcome = SkillEffects.execute(session(), caster, chantRageTarget, chantRage, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(chantRageOutcome.effect.key, 'chant_of_rage', 'Chant of Rage should apply a structured buff effect');
assert.strictEqual(EffectStats.multiplier(chantRageTarget, 'pCritDamageMul'), 1.3, 'Chant of Rage level 2 should use sourced pCritDamage 1.3');
calculateStats({}, chantRageTarget);
chantRageTarget.fetchCollectiveCritical = () => 1000;
const chantRageCrit = new Attack().prepareMeleeHit(chantRageTarget, statActor(), true, false, () => 0);
assert.strictEqual(
    chantRageCrit.damage,
    Math.round(2 * 1.3 * (70 * chantRageTarget.fetchCollectivePAtk() / 100)),
    'Chant of Rage level 2 should multiply physical critical damage by sourced pCritDamage'
);

const blessShieldTarget = statActor();
blessShieldTarget.backpack.fetchTotalShieldPDef = () => 100;
blessShieldTarget.backpack.fetchTotalShieldRate = () => 20;
const blessShield = skill({ selfId: 1243, name: 'Bless Shield', spell: true, power: 1, level: 6, buff: 1200000 });
const blessShieldOutcome = SkillEffects.execute(session(), caster, blessShieldTarget, blessShield, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(blessShieldOutcome.effect.key, 'bless_shield', 'Bless Shield should apply a structured buff effect');
assert.strictEqual(EffectStats.multiplier(blessShieldTarget, 'rShldMul'), 1.3, 'Bless Shield level 6 should use sourced rShld 1.3');
const shieldAttack = new Attack();
assert.strictEqual(shieldAttack.fetchShieldRate(blessShieldTarget), 26, 'Bless Shield level 6 should multiply base shield rate');
let blessShieldRolls = [0, 0.27, 0.99];
const blessShieldBlock = shieldAttack.prepareMeleeHit(statActor(), blessShieldTarget, true, false, () => blessShieldRolls.shift());
assert.ok(
    blessShieldBlock.flags & ServerResponse.attack.HITFLAG_SHLD,
    'Bless Shield should feed the runtime shield block chance'
);

const paagrioShieldTarget = statActor();
paagrioShieldTarget.backpack.fetchTotalShieldRate = () => 20;
const paagrioShield = skill({ selfId: 1250, name: "Under the Protection of Pa'agrio", spell: true, power: 1, level: 3, buff: 1200000 });
const paagrioShieldOutcome = SkillEffects.execute(session(), caster, paagrioShieldTarget, paagrioShield, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(paagrioShieldOutcome.effect.key, 'protection_of_paagrio', "Under the Protection of Pa'agrio should apply a structured buff effect");
assert.strictEqual(EffectStats.multiplier(paagrioShieldTarget, 'rShldMul'), 1.5, "Under the Protection of Pa'agrio level 3 should use sourced rShld 1.5");
assert.strictEqual(new Attack().fetchShieldRate(paagrioShieldTarget), 30, "Under the Protection of Pa'agrio level 3 should multiply base shield rate");

const blessedBodyTarget = statActor();
blessedBodyTarget.hp = 1000;
const blessedBody = skill({ selfId: 1045, name: 'Blessed Body', spell: true, power: 1, level: 4, buff: 1200000 });
const blessedBodyOutcome = SkillEffects.execute(session(), caster, blessedBodyTarget, blessedBody, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(blessedBodyOutcome.effect.key, 'blessed_body', 'Blessed Body should apply a structured buff effect');
assert.strictEqual(EffectStats.multiplier(blessedBodyTarget, 'maxHpMul'), 1.25, 'Blessed Body level 4 should use sourced maxHp 1.25');
calculateStats({}, blessedBodyTarget);
assert.strictEqual(
    blessedBodyTarget.fetchMaxHp(),
    Formulas.calcHp(20, 0, 30) * 1.25,
    'Blessed Body level 4 should apply the sourced L2J maxHp multiplier'
);

const blessedSoulTarget = statActor();
blessedSoulTarget.mp = 1000;
const blessedSoul = skill({ selfId: 1048, name: 'Blessed Soul', spell: true, power: 1, level: 4, buff: 1200000 });
const blessedSoulOutcome = SkillEffects.execute(session(), caster, blessedSoulTarget, blessedSoul, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(blessedSoulOutcome.effect.key, 'blessed_soul', 'Blessed Soul should apply a structured buff effect');
assert.strictEqual(EffectStats.multiplier(blessedSoulTarget, 'maxMpMul'), 1.25, 'Blessed Soul level 4 should use sourced maxMp 1.25');
calculateStats({}, blessedSoulTarget);
assert.strictEqual(
    blessedSoulTarget.fetchMaxMp(),
    Formulas.calcMp(20, 0, 0, 30) * 1.25,
    'Blessed Soul level 4 should apply the sourced L2J maxMp multiplier'
);

const berserkerTarget = statActor();
const berserker = skill({ selfId: 1062, name: 'Berserker Spirit', spell: true, power: 1, level: 2, buff: 1200000 });
const berserkerOutcome = SkillEffects.execute(session(), caster, berserkerTarget, berserker, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(berserkerOutcome.effect.key, 'berserker_spirit', 'Berserker Spirit should apply a structured buff effect');
assert.strictEqual(EffectStats.multiplier(berserkerTarget, 'mAtkMul'), 1.16, 'Berserker Spirit level 2 should use sourced mAtk 1.16');
assert.strictEqual(EffectStats.multiplier(berserkerTarget, 'pAtkMul'), 1.08, 'Berserker Spirit level 2 should use sourced pAtk 1.08');
assert.strictEqual(EffectStats.multiplier(berserkerTarget, 'pDefMul'), 0.92, 'Berserker Spirit level 2 should use sourced pDef 0.92');
assert.strictEqual(EffectStats.multiplier(berserkerTarget, 'mDefMul'), 0.84, 'Berserker Spirit level 2 should use sourced mDef 0.84');
assert.strictEqual(EffectStats.multiplier(berserkerTarget, 'castSpdMul'), 1.08, 'Berserker Spirit level 2 should use sourced mAtkSpd 1.08');
assert.strictEqual(EffectStats.multiplier(berserkerTarget, 'pAtkSpdMul'), 1.08, 'Berserker Spirit level 2 should use sourced pAtkSpd 1.08');
assert.strictEqual(EffectStats.add(berserkerTarget, 'runSpdAdd'), 8, 'Berserker Spirit level 2 should use sourced runSpd +8');
assert.strictEqual(EffectStats.add(berserkerTarget, 'pEvasionRateAdd'), -4, 'Berserker Spirit level 2 should use sourced pEvasionRate -4');
calculateStats({}, berserkerTarget);
assert.strictEqual(berserkerTarget.collectivePAtk, Math.round(Formulas.calcPAtk(20, 30, 100) * 1.08), 'Berserker Spirit should boost PAtk');
assert.strictEqual(berserkerTarget.collectiveMAtk, Math.round(Formulas.calcMAtk(20, 30, 50) * 1.16), 'Berserker Spirit should boost MAtk');
assert.strictEqual(berserkerTarget.collectivePDef, Math.round(Formulas.calcPDef(20, 100) * 0.92), 'Berserker Spirit should reduce PDef');
assert.strictEqual(berserkerTarget.collectiveMDef, Math.round(Formulas.calcMDef(20, 30, 80) * 0.84), 'Berserker Spirit should reduce MDef');
assert.strictEqual(berserkerTarget.collectiveAtkSpd, Math.round(Formulas.calcAtkSpd(30, 300) * 1.08), 'Berserker Spirit should boost PAtkSpd');
assert.strictEqual(berserkerTarget.collectiveCastSpd, Math.round(Formulas.calcCastSpd(30) * 1.08), 'Berserker Spirit should boost MAtkSpd');
assert.strictEqual(berserkerTarget.collectiveRunSpd, Formulas.calcSpeed(30, 120) + 8, 'Berserker Spirit should add run speed');
assert.strictEqual(berserkerTarget.collectiveEvasion, Formulas.calcEvasion(20, 30, 2) - 4, 'Berserker Spirit should reduce evasion');

const agilityTarget = statActor();
const agility = skill({ selfId: 1087, name: 'Agility', spell: true, power: 1, level: 3, buff: 1200000 });
const agilityOutcome = SkillEffects.execute(session(), caster, agilityTarget, agility, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(agilityOutcome.effect.key, 'agility', 'Agility should apply a structured buff effect');
assert.strictEqual(EffectStats.add(agilityTarget, 'pEvasionRateAdd'), 4, 'Agility level 3 should use sourced pEvasionRate +4');
calculateStats({}, agilityTarget);
assert.strictEqual(
    agilityTarget.collectiveEvasion,
    Formulas.calcEvasion(20, 30, 2) + 4,
    'Agility level 3 should apply the sourced L2J evasion addition'
);

const guidanceTarget = statActor();
const guidance = skill({ selfId: 1240, name: 'Guidance', spell: true, power: 1, level: 3, buff: 1200000 });
const guidanceOutcome = SkillEffects.execute(session(), caster, guidanceTarget, guidance, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(guidanceOutcome.effect.key, 'guidance', 'Guidance should apply a structured buff effect');
assert.strictEqual(EffectStats.add(guidanceTarget, 'pAccuracyCombatAdd'), 4, 'Guidance level 3 should use sourced pAccuracyCombat +4');
calculateStats({}, guidanceTarget);
assert.strictEqual(
    guidanceTarget.collectiveAccur,
    Formulas.calcAccur(20, 30, 5) + 4,
    'Guidance level 3 should apply the sourced L2J pAccuracyCombat addition'
);

const visionTarget = statActor();
const vision = skill({ selfId: 1249, name: "The Vision of Pa'agrio", spell: true, power: 1, level: 2, buff: 1200000 });
const visionOutcome = SkillEffects.execute(session(), caster, visionTarget, vision, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(visionOutcome.effect.key, 'vision_of_paagrio', "The Vision of Pa'agrio should apply a structured buff effect");
assert.strictEqual(EffectStats.add(visionTarget, 'pAccuracyCombatAdd'), 3, "The Vision of Pa'agrio level 2 should use sourced pAccuracyCombat +3");
calculateStats({}, visionTarget);
assert.strictEqual(
    visionTarget.collectiveAccur,
    Formulas.calcAccur(20, 30, 5) + 3,
    "The Vision of Pa'agrio level 2 should apply the sourced L2J pAccuracyCombat addition"
);

const furyTarget = statActor();
const fury = skill({ selfId: 1251, name: 'Chant of Fury', spell: true, power: 1, level: 2, buff: 1200000 });
const furyOutcome = SkillEffects.execute(session(), caster, furyTarget, fury, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(furyOutcome.effect.key, 'chant_of_fury', 'Chant of Fury should apply a structured buff effect');
assert.strictEqual(EffectStats.multiplier(furyTarget, 'pAtkSpdMul'), 1.33, 'Chant of Fury level 2 should use sourced pAtkSpd 1.33');
calculateStats({}, furyTarget);
assert.strictEqual(
    furyTarget.collectiveAtkSpd,
    Math.round(Formulas.calcAtkSpd(30, 300) * 1.33),
    'Chant of Fury level 2 should apply the sourced L2J pAtkSpd multiplier'
);

const chantEvasionTarget = statActor();
const chantEvasion = skill({ selfId: 1252, name: 'Chant of Evasion', spell: true, power: 1, level: 3, buff: 1200000 });
const chantEvasionOutcome = SkillEffects.execute(session(), caster, chantEvasionTarget, chantEvasion, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(chantEvasionOutcome.effect.key, 'chant_of_evasion', 'Chant of Evasion should apply a structured buff effect');
assert.strictEqual(EffectStats.add(chantEvasionTarget, 'pEvasionRateAdd'), 4, 'Chant of Evasion level 3 should use sourced pEvasionRate +4');
calculateStats({}, chantEvasionTarget);
assert.strictEqual(
    chantEvasionTarget.collectiveEvasion,
    Formulas.calcEvasion(20, 30, 2) + 4,
    'Chant of Evasion level 3 should apply the sourced L2J evasion addition'
);

const tactTarget = statActor();
const tact = skill({ selfId: 1260, name: "The Tact of Pa'agrio", spell: true, power: 1, level: 2, buff: 1200000 });
const tactOutcome = SkillEffects.execute(session(), caster, tactTarget, tact, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(tactOutcome.effect.key, 'tact_of_paagrio', "The Tact of Pa'agrio should apply a structured buff effect");
assert.strictEqual(EffectStats.add(tactTarget, 'pEvasionRateAdd'), 3, "The Tact of Pa'agrio level 2 should use sourced pEvasionRate +3");
calculateStats({}, tactTarget);
assert.strictEqual(
    tactTarget.collectiveEvasion,
    Formulas.calcEvasion(20, 30, 2) + 3,
    "The Tact of Pa'agrio level 2 should apply the sourced L2J evasion addition"
);

const ragePaagrioTarget = statActor();
const ragePaagrio = skill({ selfId: 1261, name: "The Rage of Pa'agrio", spell: true, power: 1, level: 2, buff: 1200000 });
const ragePaagrioOutcome = SkillEffects.execute(session(), caster, ragePaagrioTarget, ragePaagrio, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(ragePaagrioOutcome.effect.key, 'rage_of_paagrio', "The Rage of Pa'agrio should apply a structured buff effect");
assert.strictEqual(EffectStats.multiplier(ragePaagrioTarget, 'mAtkMul'), 1.16, "The Rage of Pa'agrio level 2 should use sourced mAtk 1.16");
assert.strictEqual(EffectStats.multiplier(ragePaagrioTarget, 'pAtkMul'), 1.08, "The Rage of Pa'agrio level 2 should use sourced pAtk 1.08");
assert.strictEqual(EffectStats.multiplier(ragePaagrioTarget, 'pDefMul'), 0.92, "The Rage of Pa'agrio level 2 should use sourced pDef 0.92");
assert.strictEqual(EffectStats.multiplier(ragePaagrioTarget, 'mDefMul'), 0.84, "The Rage of Pa'agrio level 2 should use sourced mDef 0.84");
assert.strictEqual(EffectStats.multiplier(ragePaagrioTarget, 'castSpdMul'), 1.08, "The Rage of Pa'agrio level 2 should use sourced mAtkSpd 1.08");
assert.strictEqual(EffectStats.multiplier(ragePaagrioTarget, 'pAtkSpdMul'), 1.08, "The Rage of Pa'agrio level 2 should use sourced pAtkSpd 1.08");
assert.strictEqual(EffectStats.add(ragePaagrioTarget, 'runSpdAdd'), 8, "The Rage of Pa'agrio level 2 should use sourced runSpd +8");
assert.strictEqual(EffectStats.add(ragePaagrioTarget, 'pEvasionRateAdd'), -4, "The Rage of Pa'agrio level 2 should use sourced pEvasionRate -4");
calculateStats({}, ragePaagrioTarget);
assert.strictEqual(ragePaagrioTarget.collectivePAtk, Math.round(Formulas.calcPAtk(20, 30, 100) * 1.08), "The Rage of Pa'agrio should boost PAtk");
assert.strictEqual(ragePaagrioTarget.collectiveMAtk, Math.round(Formulas.calcMAtk(20, 30, 50) * 1.16), "The Rage of Pa'agrio should boost MAtk");
assert.strictEqual(ragePaagrioTarget.collectivePDef, Math.round(Formulas.calcPDef(20, 100) * 0.92), "The Rage of Pa'agrio should reduce PDef");
assert.strictEqual(ragePaagrioTarget.collectiveMDef, Math.round(Formulas.calcMDef(20, 30, 80) * 0.84), "The Rage of Pa'agrio should reduce MDef");
assert.strictEqual(ragePaagrioTarget.collectiveAtkSpd, Math.round(Formulas.calcAtkSpd(30, 300) * 1.08), "The Rage of Pa'agrio should boost PAtkSpd");
assert.strictEqual(ragePaagrioTarget.collectiveCastSpd, Math.round(Formulas.calcCastSpd(30) * 1.08), "The Rage of Pa'agrio should boost MAtkSpd");
assert.strictEqual(ragePaagrioTarget.collectiveRunSpd, Formulas.calcSpeed(30, 120) + 8, "The Rage of Pa'agrio should add run speed");
assert.strictEqual(ragePaagrioTarget.collectiveEvasion, Formulas.calcEvasion(20, 30, 2) - 4, "The Rage of Pa'agrio should reduce evasion");

const gloomTarget = statActor();
const curseGloom = skill({ selfId: 1263, name: 'Curse Gloom', spell: true, power: 87, level: 13, buff: 30000 });
const gloomOutcome = SkillEffects.execute(session(), caster, gloomTarget, curseGloom, {
    magicSkill: true,
    rng: () => 0,
    attack: {
        clearLoadedShot() {},
        prepareSkillDamage: () => 123
    }
});
assert.strictEqual(curseGloom.fetchSkillType(), C4SkillRules.DAMAGE_EFFECT, 'Curse Gloom should resolve as magic damage plus debuff');
assert.strictEqual(gloomOutcome.damage, 123, 'Curse Gloom should keep its damage component');
assert.strictEqual(gloomOutcome.effect.key, 'curse_gloom', 'Curse Gloom should apply a structured debuff effect');
assert.strictEqual(EffectStats.multiplier(gloomTarget, 'mDefMul'), 0.85, 'Curse Gloom should use sourced mDef 0.85');
calculateStats({}, gloomTarget);
assert.strictEqual(
    gloomTarget.collectiveMDef,
    Math.round(Formulas.calcMDef(20, 30, 80) * 0.85),
    'Curse Gloom should lower MDef through the sourced L2J multiplier'
);

const shockProtected = statActor();
const resistShock = skill({ selfId: 1259, name: 'Resist Shock', spell: true, power: 1, level: 2, buff: 1200000 });
const resistShockOutcome = SkillEffects.execute(session(), caster, shockProtected, resistShock, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(resistShockOutcome.effect.key, 'resist_shock', 'Resist Shock should apply a structured buff effect');
assert.strictEqual(EffectStats.add(shockProtected, 'stunResist'), 20, 'Resist Shock level 2 should use sourced stunResist +20');
const stunAttack = skill({ selfId: 100, name: 'Stun Attack', spell: false, power: 10, level: 1, buff: 9000 });
const resistedStunOutcome = SkillEffects.execute(session(), caster, shockProtected, stunAttack, {
    magicSkill: false,
    rng: () => 0.42,
    attack: {
        clearLoadedShot() {},
        prepareSkillDamage: () => 1
    }
});
assert.strictEqual(resistedStunOutcome.damage, 1, 'Resisted Stun Attack should still deal its damage component');
assert.strictEqual(resistedStunOutcome.effect, null, 'Resist Shock stunResist should lower Stun Attack land chance below the roll');
assert.strictEqual(resistedStunOutcome.effectResisted, true, 'Stun blocked by Resist Shock should report effect resistance');
assert.strictEqual(EffectStore.hasDebuff(shockProtected, 'stun'), false, 'Resisted Stun Attack should not leave a stun debuff');

console.log('Skill semantic checks passed');

function statActor() {
    const actor = creature({ id: 2000100, hp: 100, maxHp: 100 });
    actor.classId = 0;
    actor.fetchClassId = function() { return this.classId; };
    actor.fetchCon = () => 30;
    actor.fetchMen = () => 30;
    actor.fetchStr = () => 30;
    actor.fetchDex = () => 30;
    actor.fetchInt = () => 30;
    actor.fetchWit = () => 30;
    actor.fetchPAtk = () => 10;
    actor.fetchMAtk = () => 10;
    actor.fetchPDef = () => 10;
    actor.fetchMDef = () => 10;
    actor.fetchAccur = () => 0;
    actor.fetchEvasion = () => 0;
    actor.fetchCritical = () => 40;
    actor.fetchAtkSpd = () => 300;
    actor.fetchWalkSpd = () => 80;
    actor.fetchRunSpd = () => 120;
    actor.isSpellcaster = () => 0;
    actor.setMaxHp = (value) => { actor.maxHp = value; };
    actor.setMaxMp = (value) => { actor.maxMp = value; };
    actor.setMp = (value) => { actor.mp = value; };
    actor.setMaxLoad = (value) => { actor.maxLoad = value; };
    actor.setLoad = (value) => { actor.load = value; };
    actor.setCollectivePAtk = (value) => { actor.collectivePAtk = value; };
    actor.setCollectiveMAtk = (value) => { actor.collectiveMAtk = value; };
    actor.setCollectivePDef = (value) => { actor.collectivePDef = value; };
    actor.setCollectiveMDef = (value) => { actor.collectiveMDef = value; };
    actor.setCollectiveAccur = (value) => { actor.collectiveAccur = value; };
    actor.setCollectiveEvasion = (value) => { actor.collectiveEvasion = value; };
    actor.setCollectiveCritical = (value) => { actor.collectiveCritical = value; };
    actor.setCollectiveAtkSpd = (value) => { actor.collectiveAtkSpd = value; };
    actor.setCollectiveCastSpd = (value) => { actor.collectiveCastSpd = value; };
    actor.setCollectiveWalkSpd = (value) => { actor.collectiveWalkSpd = value; };
    actor.setCollectiveRunSpd = (value) => { actor.collectiveRunSpd = value; };
    actor.backpack = {
        fetchTotalArmorBonusMp: () => 0,
        fetchTotalLoad: () => 0,
        fetchTotalWeaponPAtk: () => 100,
        fetchTotalWeaponPAtkRnd: () => 0,
        fetchTotalWeaponMAtk: () => 50,
        fetchTotalArmorPDef: () => 100,
        fetchTotalArmorMDef: () => 80,
        fetchTotalWeaponAccur: () => 5,
        fetchTotalArmorEvasion: () => 2,
        fetchTotalWeaponCritical: () => 40,
        fetchTotalWeaponAtkSpd: () => 300
    };
    return actor;
}
