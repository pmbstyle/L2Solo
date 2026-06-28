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
            fetchDead: () => overrides.dead ?? false,
            setHits() {},
            setCasts() {}
        },
        isDead() { return this.state.fetchDead(); }
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
        hp: data.hp ?? 0,
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

[
    { id: 45, name: 'Divine Heal', levels: 9, target: 'self', lastPower: 219, lastMp: 107, healLevel: 9 },
    { id: 58, name: 'Elemental Heal', levels: 55, target: 'self', lastPower: 546, lastMp: 239, healLevel: 55 },
    { id: 69, name: 'Sacrifice', levels: 25, target: 'friendly', lastPower: 1170, lastMp: 0, lastHp: 1560, healLevel: 25 },
    { id: 262, name: 'Holy Blessing', levels: 37, target: 'friendly', lastPower: 546, lastMp: 191, healLevel: 37 },
    { id: 1027, name: 'Group Heal', levels: 15, target: 'party', lastPower: 241, lastMp: 103, healLevel: 15 },
    { id: 1127, name: 'Servitor Heal', levels: 45, target: 'pet', lastPower: 936, lastMp: 120, healLevel: 45 },
    { id: 4080, name: 'Dark Heal', levels: 1, target: 'friendly', lastPower: 627, lastMp: 98, healLevel: 1 },
    { id: 4115, name: 'Aden Heal', levels: 1, target: 'friendly', lastPower: 689, lastMp: 105, healLevel: 1 }
].forEach(({ id, name, levels, target, lastPower, lastMp, lastHp = 0, healLevel }) => {
    const data = activeSkills.find((entry) => entry.selfId === id);
    assert(data, `${name} should be present in active skills data`);
    assert.strictEqual(data.levels.length, levels, `${name} should preserve sourced base level count`);
    assert.strictEqual(data.levels[levels - 1].power, lastPower, `${name} should preserve sourced final heal power`);
    assert.strictEqual(data.levels[levels - 1].mp, lastMp, `${name} should preserve sourced final MP cost`);
    assert.strictEqual(data.levels[levels - 1].hp, lastHp, `${name} should preserve sourced final HP cost`);
    const healTarget = creature({ id: 2000100 + id, hp: 100, maxHp: 2000 });
    const healSkill = skill({ selfId: id, name, spell: true, power: lastPower, level: healLevel });
    const outcome = SkillEffects.execute(session(), caster, healTarget, healSkill, {
        magicSkill: true,
        attack: { clearLoadedShot() {} }
    });
    assert.strictEqual(healSkill.fetchSkillType(), C4SkillRules.HEAL, `${name} should resolve to HEAL`);
    assert.strictEqual(healSkill.fetchTargetKind(), target, `${name} should preserve sourced target semantics`);
    assert.strictEqual(healSkill.fetchSsBoost(), 0, `${name} should not consume offensive shot boost semantics`);
    assert.strictEqual(outcome.heal, Math.min(lastPower, 1900), `${name} should heal by sourced power`);
    if (id === 69) {
        assert.strictEqual(healSkill.fetchSemantic().castRange, 600, 'Sacrifice should preserve sourced castRange');
        assert.strictEqual(healSkill.fetchSemantic().effectRange, 1100, 'Sacrifice should preserve sourced effectRange');
        assert.strictEqual(healSkill.fetchSemantic().aggroPoints, 780, 'Sacrifice should resolve sourced level 25 aggroPoints');
    }
});

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
assert.strictEqual(greaterGroupHeal.fetchTargetKind(), 'party', 'Greater Group Heal should preserve sourced TARGET_PARTY semantics');
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

[
    { id: 109, name: 'Spirit of Ogre', levels: 1, type: C4SkillRules.HEAL_PERCENT, target: 'self', power: 20, mp: 5, buff: 120000, expectedHeal: 200 },
    { id: 121, name: 'Battle Roar', levels: 6, type: C4SkillRules.HEAL_PERCENT, target: 'self', power: 25.7, dataPower: 26, mp: 33, buff: 600000, expectedHeal: 257 },
    { id: 4091, name: 'NPC Ogre Stun', levels: 1, type: C4SkillRules.HEAL_PERCENT, target: 'self', power: 14, mp: 18, buff: 600000, expectedHeal: 140 },
    { id: 181, name: 'Revival', levels: 1, type: C4SkillRules.HEAL_STATIC, target: 'self', power: 1685, mp: 25, buff: 0, expectedHeal: 900 },
    { id: 2038, name: 'Quick healing potion', levels: 1, type: C4SkillRules.HEAL_STATIC, target: 'self', power: 435, mp: 0, buff: 0, expectedHeal: 435 }
].forEach(({ id, name, levels, type, target, power, dataPower = power, mp, buff, expectedHeal }) => {
    const data = activeSkills.find((entry) => entry.selfId === id);
    assert(data, `${name} should be present in active skills data`);
    assert.strictEqual(data.template.name, name, `${name} should preserve sourced name`);
    assert.strictEqual(data.levels.length, levels, `${name} should preserve sourced base level count`);
    assert.strictEqual(data.levels[levels - 1].power, dataPower, `${name} active data should preserve schema-safe final power`);
    assert.strictEqual(data.levels[levels - 1].mp, mp, `${name} should preserve sourced final MP cost`);
    assert.strictEqual(data.time.buff, buff, `${name} should preserve sourced buff/effect duration`);
    const recoveryTarget = creature({ id: 2000200 + id, hp: 100, maxHp: 1000 });
    const recoverySkill = skill({ selfId: id, name, spell: true, power, level: levels, distance: -1 });
    const outcome = SkillEffects.execute(session(), recoveryTarget, recoveryTarget, recoverySkill, {
        magicSkill: recoverySkill.fetchSpell(),
        attack: { clearLoadedShot() {} }
    });
    assert.strictEqual(recoverySkill.fetchSkillType(), type, `${name} should resolve to sourced recovery skill type`);
    assert.strictEqual(recoverySkill.fetchTargetKind(), target, `${name} should preserve sourced target semantics`);
    assert.strictEqual(recoverySkill.fetchSemantic().healPower, power, `${name} should preserve sourced semantic recovery power`);
    assert.strictEqual(outcome.heal, expectedHeal, `${name} should restore sourced HP amount`);
});

const revival = skill({ selfId: 181, name: 'Revival', spell: false, power: 1685, level: 1, distance: -1 });
const revivalAttack = new Attack();
assert(
    revivalAttack.skillUseConditionFailure(creature({ hp: 101, maxHp: 1000 }), revival),
    'Revival should be blocked above the sourced 10% HP condition'
);
assert.strictEqual(
    revivalAttack.skillUseConditionFailure(creature({ hp: 100, maxHp: 1000 }), revival),
    null,
    'Revival should be allowed at the sourced 10% HP threshold'
);

const confusionData = activeSkills.find((entry) => entry.selfId === 2);
assert(confusionData, 'Confusion should be present in active skills data');
assert.strictEqual(confusionData.template.distance, 600, 'Confusion should preserve sourced castRange 600');
assert.strictEqual(confusionData.time.hitTime, 1500, 'Confusion should preserve sourced hitTime 1500');
assert.strictEqual(confusionData.time.reuse, 20000, 'Confusion should preserve sourced reuseDelay 20000');
assert.strictEqual(confusionData.time.buff, 30000, 'Confusion should preserve sourced Confusion count/time duration');
assert.strictEqual(confusionData.levels.length, 19, 'Confusion should preserve sourced 19 base levels');
assert.strictEqual(confusionData.levels[0].power, 80, 'Confusion level 1 should preserve sourced CONFUSE_MOB_ONLY power 80');
assert.strictEqual(confusionData.levels[18].mp, 69, 'Confusion level 19 MP should use sourced initial + consume total');
const confusionPlayerTarget = creature({ id: 1000002, hp: 100, maxHp: 100, level: 20 });
const confusion = skill({ selfId: 2, name: 'Confusion', spell: true, power: 80, level: 19, distance: 600, buff: 30000 });
const confusionPlayerOutcome = SkillEffects.execute(session(), caster, confusionPlayerTarget, confusion, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(confusionPlayerOutcome.effect, null, 'Confusion should not apply CONFUSE_MOB_ONLY to non-attackable targets');
assert.strictEqual(confusionPlayerOutcome.effectResisted, true, 'Confusion mob-only rejection should report effect resistance');
const confusionMobTarget = creature({ id: 1000003, hp: 100, maxHp: 100, level: 20 });
confusionMobTarget.fetchAttackable = () => true;
const confusionMobOutcome = SkillEffects.execute(session(), caster, confusionMobTarget, confusion, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(confusion.fetchSkillType(), C4SkillRules.EFFECT, 'Confusion should preserve sourced CONFUSE_MOB_ONLY effect semantics');
assert.strictEqual(confusion.fetchTargetKind(), 'enemy', 'Confusion should preserve sourced TARGET_ONE offensive semantics');
assert.strictEqual(confusion.fetchSemantic().baseLandRate, 80, 'Confusion should use sourced power 80 as land rate');
assert.strictEqual(confusion.fetchSemantic().castRange, 600, 'Confusion should preserve sourced castRange metadata');
assert.strictEqual(confusion.fetchSemantic().effectRange, 1100, 'Confusion should preserve sourced effectRange metadata');
assert.strictEqual(confusion.fetchSemantic().mobOnly, true, 'Confusion should preserve sourced mob-only semantics');
assert.strictEqual(confusionMobOutcome.effect.key, 'confusion', 'Confusion should apply a structured confusion debuff to attackable NPCs');
assert.strictEqual(EffectStore.impairments(confusionMobTarget).confused, true, 'Confusion should be visible through impairments');
EffectStore.remove(confusionMobTarget, 'confusion');

[
    { id: 4, name: 'Dash', levels: 2, mp: 41, buff: 15000, reuse: 90000, effect: 'dash', stat: 'runSpdAdd', statValue: 66, statKind: 'add', aggroPoints: 438 },
    { id: 72, name: 'Iron Will', levels: 3, mp: 50, buff: 1200000, reuse: 6000, effect: 'iron_will', stat: 'mDefMul', statValue: 1.3, statKind: 'mul' },
    { id: 75, name: 'Detect Insect Weakness', levels: 1, mp: 14, buff: 600000, reuse: 10000, effect: 'detect_weakness', stat: 'pAtk-insects', statValue: 1.5, statKind: 'mul', effectTargetKind: 'insect', aggroPoints: 303 },
    { id: 76, name: 'Totem Spirit Bear', levels: 1, mp: 2, buff: 120000, reuse: 120000, effect: 'totem_spirit_bear', stat: 'pAtkMul', statValue: 1.2, statKind: 'mul', extraStats: [{ stat: 'runSpdMul', value: 0.7, kind: 'mul' }], aggroPoints: 268 },
    { id: 77, name: 'Attack Aura', levels: 2, mp: 25, buff: 1200000, reuse: 6000, effect: 'attack_aura', stat: 'pAtkMul', statValue: 1.12, statKind: 'mul', aggroPoints: 268 },
    { id: 78, name: 'War Cry', levels: 2, mp: 19, buff: 60000, reuse: 180000, effect: 'war_cry', stat: 'pAtkMul', statValue: 1.25, statKind: 'mul', aggroPoints: 408 },
    { id: 80, name: 'Detect Monster Weakness', levels: 1, mp: 24, buff: 600000, reuse: 10000, effect: 'detect_weakness', stat: 'pAtk-monsters', statValue: 1.5, statKind: 'mul', effectTargetKind: 'monster', aggroPoints: 495 },
    { id: 82, name: 'Majesty', levels: 3, mp: 27, buff: 300000, reuse: 10000, effect: 'majesty', stat: 'pDefMul', statValue: 1.15, statKind: 'mul', extraStats: [{ stat: 'pEvasionRateAdd', value: -6, kind: 'add' }], aggroPoints: 549 },
    { id: 83, name: 'Totem Spirit Wolf', levels: 1, mp: 2, buff: 120000, reuse: 120000, effect: 'totem_spirit_wolf', stat: 'runSpdMul', statValue: 1.15, statKind: 'mul', aggroPoints: 204 },
    { id: 86, name: 'Reflect Damage', levels: 3, mp: 48, buff: 1200000, reuse: 6000, effect: 'reflect_damage', stat: 'reflectDam', statValue: 20, statKind: 'add', aggroPoints: 495 },
    { id: 87, name: 'Detect Animal Weakness', levels: 1, mp: 18, buff: 600000, reuse: 10000, effect: 'detect_weakness', stat: 'pAtk-animals', statValue: 1.5, statKind: 'mul', effectTargetKind: 'animal', aggroPoints: 379 },
    { id: 88, name: 'Detect Dragon Weakness', levels: 1, mp: 27, buff: 600000, reuse: 10000, effect: 'detect_weakness', stat: 'pAtk-dragons', statValue: 1.5, statKind: 'mul', effectTargetKind: 'dragon', aggroPoints: 549 },
    { id: 91, name: 'Defense Aura', levels: 2, mp: 20, buff: 1200000, reuse: 6000, effect: 'defense_aura', stat: 'pDefMul', statValue: 1.12, statKind: 'mul', aggroPoints: 204 },
    { id: 94, name: 'Rage', levels: 2, mp: 25, buff: 90000, reuse: 300000, effect: 'rage', stat: 'pAtkMul', statValue: 1.55, statKind: 'mul', extraStats: [{ stat: 'pDefMul', value: 0.8, kind: 'mul' }, { stat: 'pEvasionRateAdd', value: -3, kind: 'add' }], aggroPoints: 523 },
    { id: 99, name: 'Rapid Shot', levels: 2, mp: 50, buff: 1200000, reuse: 10000, effect: 'rapid_shot', stat: 'pAtkSpdMul', statValue: 1.12, statKind: 'mul', aggroPoints: 549, requires: { weaponsAllowed: 32 } },
    { id: 104, name: 'Detect Plant Weakness', levels: 1, mp: 21, buff: 600000, reuse: 10000, effect: 'detect_weakness', stat: 'pAtk-plants', statValue: 1.5, statKind: 'mul', effectTargetKind: 'plant', aggroPoints: 438 },
    { id: 123, name: 'Spirit Barrier', levels: 3, mp: 54, buff: 1200000, reuse: 6000, effect: 'spirit_barrier', stat: 'mDefMul', statValue: 1.3, statKind: 'mul' },
    { id: 139, name: 'Guts', levels: 3, mp: 24, buff: 90000, reuse: 600000, effect: 'guts', stat: 'pDefMul', statValue: 3.0, statKind: 'mul', hpGate: 30 },
    { id: 176, name: 'Frenzy', levels: 3, mp: 25, buff: 90000, reuse: 600000, effect: 'frenzy', stat: 'pAtkMul', statValue: 3.0, statKind: 'mul', hpGate: 30 },
    { id: 230, name: 'Sprint', levels: 2, mp: 48, buff: 1200000, reuse: 10000, effect: 'sprint', stat: 'runSpdAdd', statValue: 33, statKind: 'add' }
].forEach(({ id, name, levels, mp, buff, reuse, effect, stat, statValue, statKind, hpGate, effectTargetKind, aggroPoints, requires, extraStats = [] }) => {
    const data = activeSkills.find((entry) => entry.selfId === id);
    assert(data, `${name} should be present in active skills data`);
    assert.strictEqual(data.levels.length, levels, `${name} should preserve sourced base level count`);
    assert.strictEqual(data.levels[levels - 1].mp, mp, `${name} should preserve sourced final MP cost`);
    assert.strictEqual(data.time.buff, buff, `${name} should preserve sourced buff duration`);
    assert.strictEqual(data.time.reuse, reuse, `${name} should preserve sourced reuse`);
    const buffTarget = statActor();
    const selfBuff = skill({ selfId: id, name, spell: data.template.spell, power: 1, level: levels, distance: -1, buff });
    assert.strictEqual(selfBuff.fetchSkillType(), C4SkillRules.EFFECT, `${name} should resolve to BUFF effect semantics`);
    assert.strictEqual(selfBuff.fetchTargetKind(), 'self', `${name} should preserve sourced TARGET_SELF semantics`);
    if (id === 72) {
        assert.strictEqual(selfBuff.fetchSemantic().aggroPoints, 523, 'Iron Will should resolve sourced level 3 aggroPoints');
    }
    if (effectTargetKind) {
        assert.strictEqual(selfBuff.fetchSemantic().effectTargetKind, effectTargetKind, `${name} should preserve sourced effect target kind`);
    }
    if (aggroPoints) {
        assert.strictEqual(selfBuff.fetchSemantic().aggroPoints, aggroPoints, `${name} should preserve sourced aggroPoints`);
    }
    if (requires) {
        assert.deepStrictEqual(selfBuff.fetchSemantic().requires, requires, `${name} should preserve sourced requirement metadata`);
    }
    if (hpGate) {
        const attack = new Attack();
        assert(
            attack.skillUseConditionFailure(creature({ hp: hpGate + 1, maxHp: 100 }), selfBuff),
            `${name} should be blocked above the sourced ${hpGate}% HP condition`
        );
        assert.strictEqual(
            attack.skillUseConditionFailure(creature({ hp: hpGate, maxHp: 100 }), selfBuff),
            null,
            `${name} should be allowed at the sourced ${hpGate}% HP threshold`
        );
    }
    const outcome = SkillEffects.execute(session(), buffTarget, buffTarget, selfBuff, {
        magicSkill: selfBuff.fetchSpell(),
        rng: () => 0,
        attack: { clearLoadedShot() {} }
    });
    assert.strictEqual(outcome.effect.key, effect, `${name} should apply sourced effect key`);
    if (statKind === 'add') {
        assert.strictEqual(EffectStats.add(buffTarget, stat), statValue, `${name} should apply sourced ${stat} ${statValue}`);
    } else {
        assert.strictEqual(EffectStats.multiplier(buffTarget, stat), statValue, `${name} should apply sourced ${stat} ${statValue}`);
    }
    extraStats.forEach((entry) => {
        if (entry.kind === 'add') {
            assert.strictEqual(EffectStats.add(buffTarget, entry.stat), entry.value, `${name} should apply sourced ${entry.stat} ${entry.value}`);
        } else {
            assert.strictEqual(EffectStats.multiplier(buffTarget, entry.stat), entry.value, `${name} should apply sourced ${entry.stat} ${entry.value}`);
        }
    });
});

const corpsePlagueData = activeSkills.find((entry) => entry.selfId === 103);
assert(corpsePlagueData, 'Corpse Plague should be present in active skills data');
assert.strictEqual(corpsePlagueData.template.distance, 400, 'Corpse Plague should preserve sourced castRange 400');
assert.strictEqual(corpsePlagueData.time.hitTime, 1500, 'Corpse Plague should preserve sourced hitTime 1500');
assert.strictEqual(corpsePlagueData.time.reuse, 20000, 'Corpse Plague should preserve sourced reuseDelay 20000');
assert.strictEqual(corpsePlagueData.time.buff, 30000, 'Corpse Plague should preserve sourced poison duration');
assert.strictEqual(corpsePlagueData.levels.length, 4, 'Corpse Plague should preserve sourced 4 base levels');
assert.strictEqual(corpsePlagueData.levels[0].power, 5, 'Corpse Plague level 1 should preserve sourced power 5');
assert.strictEqual(corpsePlagueData.levels[3].power, 8, 'Corpse Plague level 4 should preserve sourced power 8');
assert.strictEqual(corpsePlagueData.levels[3].mp, 65, 'Corpse Plague level 4 should preserve sourced mpConsume 65');
const corpsePlagueTarget = creature({ id: 1000103, hp: 0, maxHp: 100, dead: true });
corpsePlagueTarget.fetchAttackable = () => true;
const corpsePlague = skill({ selfId: 103, name: 'Corpse Plague', spell: true, power: 8, level: 4, distance: 400, buff: 30000 });
const corpsePlagueOutcome = SkillEffects.execute(session(), caster, corpsePlagueTarget, corpsePlague, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(corpsePlague.fetchSkillType(), C4SkillRules.EFFECT, 'Corpse Plague should resolve as a sourced poison effect');
assert.strictEqual(corpsePlague.fetchTargetKind(), 'corpse_mob', 'Corpse Plague should preserve sourced TARGET_AREA_CORPSE_MOB target semantics');
assert.strictEqual(corpsePlague.fetchSemantic().sourceTarget, 'area', 'Corpse Plague should preserve sourced area corpse semantics');
assert.strictEqual(corpsePlague.fetchSemantic().radius, 400, 'Corpse Plague should preserve sourced skillRadius 400');
assert.strictEqual(corpsePlague.fetchSemantic().baseLandRate, 8, 'Corpse Plague level 4 should use sourced power 8 as land rate');
assert.strictEqual(corpsePlague.fetchSemantic().levelDepend, 1, 'Corpse Plague should preserve sourced lvlDepend metadata');
assert.strictEqual(corpsePlague.fetchSemantic().castRange, 400, 'Corpse Plague should preserve sourced castRange metadata');
assert.strictEqual(corpsePlague.fetchSemantic().effectRange, 900, 'Corpse Plague should preserve sourced effectRange metadata');
assert.strictEqual(corpsePlagueOutcome.effect.key, 'poison', 'Corpse Plague should apply a structured poison effect');
assert.strictEqual(corpsePlagueOutcome.effect.dot.count, 10, 'Corpse Plague should use sourced 10 damage ticks');
assert.strictEqual(corpsePlagueOutcome.effect.dot.intervalMs, 3000, 'Corpse Plague should tick every sourced 3 seconds');
assert.strictEqual(corpsePlagueOutcome.effect.dot.damage, 52, 'Corpse Plague should use sourced poison damage table');
EffectStore.remove(corpsePlagueTarget, 'poison');

const veilData = activeSkills.find((entry) => entry.selfId === 106);
assert(veilData, 'Veil should be present in active skills data');
assert.strictEqual(veilData.template.distance, 500, 'Veil should preserve sourced castRange 500');
assert.strictEqual(veilData.time.hitTime, 1200, 'Veil should preserve sourced hitTime 1200');
assert.strictEqual(veilData.time.reuse, 20000, 'Veil should preserve sourced reuseDelay 20000');
assert.strictEqual(veilData.time.buff, 0, 'Veil should not use debuff duration for sourced AGGREMOVE');
assert.strictEqual(veilData.levels.length, 14, 'Veil should preserve sourced 14 base levels');
assert.strictEqual(veilData.levels[0].power, 70, 'Veil level 1 should preserve sourced AGGREMOVE power 70');
assert.strictEqual(veilData.levels[13].mp, 83, 'Veil level 14 should preserve sourced mpConsume 83');
const veil = skill({ selfId: 106, name: 'Veil', spell: false, power: 70, level: 14, distance: 500 });
const veilOutcome = SkillEffects.execute(session(), caster, creature({ id: 1000106, hp: 100, maxHp: 100, level: 20 }), veil, {
    magicSkill: false,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(veil.fetchSkillType(), C4SkillRules.AGGRO_REMOVE, 'Veil should resolve as sourced AGGREMOVE');
assert.strictEqual(veil.fetchTargetKind(), 'enemy', 'Veil should preserve sourced TARGET_ONE semantics');
assert.strictEqual(veil.fetchSemantic().baseLandRate, 70, 'Veil should use sourced power 70 as land rate');
assert.strictEqual(veil.fetchSemantic().castRange, 500, 'Veil should preserve sourced castRange metadata');
assert.strictEqual(veil.fetchSemantic().effectRange, 900, 'Veil should preserve sourced effectRange metadata');
assert.strictEqual(veilOutcome.damage, 0, 'Veil should not be routed as damage');
assert.strictEqual(veilOutcome.effect, null, 'Veil should not apply a structured debuff');
assert.strictEqual(veilOutcome.aggroRemoved, true, 'Veil should mark successful sourced AGGREMOVE');

const holyAuraData = activeSkills.find((entry) => entry.selfId === 107);
assert(holyAuraData, 'Holy Aura should be present in active skills data');
assert.strictEqual(holyAuraData.template.distance, -1, 'Holy Aura should preserve sourced self-centered TARGET_AURA_UNDEAD range');
assert.strictEqual(holyAuraData.time.hitTime, 2000, 'Holy Aura should preserve sourced hitTime 2000');
assert.strictEqual(holyAuraData.time.reuse, 40000, 'Holy Aura should preserve sourced reuseDelay 40000');
assert.strictEqual(holyAuraData.time.buff, 30000, 'Holy Aura should preserve sourced 30 second root duration');
assert.strictEqual(holyAuraData.levels.length, 9, 'Holy Aura should preserve sourced 9 base levels');
assert.strictEqual(holyAuraData.levels[0].power, 40, 'Holy Aura level 1 should preserve sourced ROOT power 40');
assert.strictEqual(holyAuraData.levels[8].mp, 102, 'Holy Aura level 9 should preserve sourced mpConsume 102');
const holyAura = skill({ selfId: 107, name: 'Holy Aura', spell: false, power: 40, level: 9, distance: -1, buff: 30000 });
const livingHolyAuraTarget = creature({ id: 1000107, hp: 100, maxHp: 100, level: 20 });
const livingHolyAuraOutcome = SkillEffects.execute(session(), caster, livingHolyAuraTarget, holyAura, {
    magicSkill: false,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(holyAura.fetchSkillType(), C4SkillRules.EFFECT, 'Holy Aura should resolve as sourced ROOT effect');
assert.strictEqual(holyAura.fetchTargetKind(), 'enemy', 'Holy Aura should preserve handled enemy target semantics');
assert.strictEqual(holyAura.fetchSemantic().sourceTarget, 'aura', 'Holy Aura should preserve sourced TARGET_AURA_UNDEAD aura semantics');
assert.strictEqual(holyAura.fetchSemantic().radius, 200, 'Holy Aura should preserve sourced skillRadius 200');
assert.strictEqual(holyAura.fetchSemantic().baseLandRate, 40, 'Holy Aura should use sourced power 40 as land rate');
assert.strictEqual(holyAura.fetchSemantic().levelDepend, 2, 'Holy Aura should preserve sourced lvlDepend metadata');
assert.strictEqual(holyAura.fetchSemantic().undeadOnly, true, 'Holy Aura should preserve sourced TARGET_AURA_UNDEAD restriction');
assert.strictEqual(livingHolyAuraOutcome.effect, null, 'Holy Aura should not affect living targets');
assert.strictEqual(livingHolyAuraOutcome.effectResisted, true, 'Holy Aura should reject living targets through TARGET_AURA_UNDEAD');
const undeadHolyAuraTarget = creature({ id: 1000108, hp: 100, maxHp: 100, level: 20 });
undeadHolyAuraTarget.fetchUndead = () => true;
const undeadHolyAuraOutcome = SkillEffects.execute(session(), caster, undeadHolyAuraTarget, holyAura, {
    magicSkill: false,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(undeadHolyAuraOutcome.effect.key, 'root', 'Holy Aura should apply root to undead targets');
assert.strictEqual(EffectRestrictions.canMove(undeadHolyAuraTarget), false, 'Holy Aura root should block movement through runtime restrictions');
EffectStore.remove(undeadHolyAuraTarget, 'root');

const auraStatsTarget = statActor();
SkillEffects.execute(session(), auraStatsTarget, auraStatsTarget, skill({
    selfId: 77,
    name: 'Attack Aura',
    spell: true,
    power: 1,
    level: 2,
    distance: -1,
    buff: 1200000
}), {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
SkillEffects.execute(session(), auraStatsTarget, auraStatsTarget, skill({
    selfId: 91,
    name: 'Defense Aura',
    spell: true,
    power: 1,
    level: 2,
    distance: -1,
    buff: 1200000
}), {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
SkillEffects.execute(session(), auraStatsTarget, auraStatsTarget, skill({
    selfId: 230,
    name: 'Sprint',
    spell: true,
    power: 1,
    level: 2,
    distance: -1,
    buff: 1200000
}), {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
calculateStats({}, auraStatsTarget);
assert.strictEqual(auraStatsTarget.collectivePAtk, Math.round(Formulas.calcPAtk(20, 30, 100) * 1.12), 'Attack Aura should multiply sourced PAtk');
assert.strictEqual(auraStatsTarget.collectivePDef, Math.round(Formulas.calcPDef(20, 100) * 1.12), 'Defence Aura should multiply sourced PDef');
assert.strictEqual(auraStatsTarget.collectiveRunSpd, Formulas.calcSpeed(30, 120) + 33, 'Sprint should add sourced run speed');

[
    { id: 1003, name: 'Power of Paagrio', levels: 3, mp: 172, buff: 1200000, reuse: 20000, effect: 'power_of_paagrio', target: 'ally', stat: 'pAtkMul', statValue: 1.15, statKind: 'mul' },
    { id: 1004, name: 'Wisdom of Paagrio', levels: 3, mp: 204, buff: 1200000, reuse: 20000, effect: 'wisdom_of_paagrio', target: 'ally', stat: 'castSpdMul', statValue: 1.3, statKind: 'mul' },
    { id: 1005, name: 'Blessing of Paagrio', levels: 3, mp: 188, buff: 1200000, reuse: 20000, effect: 'blessing_of_paagrio', target: 'ally', stat: 'pDefMul', statValue: 1.15, statKind: 'mul' },
    { id: 1008, name: 'Glory of Paagrio', levels: 3, mp: 204, buff: 1200000, reuse: 20000, effect: 'glory_of_paagrio', target: 'ally', stat: 'mDefMul', statValue: 1.3, statKind: 'mul' },
    { id: 264, name: 'Song of Earth', levels: 1, mp: 60, buff: 120000, reuse: 10000, effect: 'song_of_earth', target: 'party', stat: 'pDefMul', statValue: 1.25, statKind: 'mul' },
    { id: 265, name: 'Song of Life', levels: 1, mp: 60, buff: 120000, reuse: 10000, effect: 'song_of_life', target: 'party', stat: 'regHp', statValue: 1.2, statKind: 'mul' },
    { id: 266, name: 'Song of Water', levels: 1, mp: 60, buff: 120000, reuse: 10000, effect: 'song_of_water', target: 'party', stat: 'pEvasionRateAdd', statValue: 3, statKind: 'add' },
    { id: 267, name: 'Song of Warding', levels: 1, mp: 60, buff: 120000, reuse: 10000, effect: 'song_of_warding', target: 'party', stat: 'mDefMul', statValue: 1.3, statKind: 'mul' },
    { id: 268, name: 'Song of Wind', levels: 1, mp: 60, buff: 120000, reuse: 10000, effect: 'song_of_wind', target: 'party', stat: 'runSpdAdd', statValue: 20, statKind: 'add' },
    { id: 269, name: 'Song of Hunter', levels: 1, mp: 60, buff: 120000, reuse: 10000, effect: 'song_of_hunter', target: 'party', stat: 'pCritRateMul', statValue: 2, statKind: 'mul' },
    { id: 270, name: 'Song of Invocation', levels: 1, mp: 60, buff: 120000, reuse: 10000, effect: 'song_of_invocation', target: 'party', stat: 'darkVuln', statValue: 0.8, statKind: 'mul' },
    { id: 271, name: 'Dance of Warrior', levels: 1, mp: 60, buff: 120000, reuse: 10000, effect: 'dance_of_warrior', target: 'party', stat: 'pAtkMul', statValue: 1.12, statKind: 'mul' },
    { id: 272, name: 'Dance of Inspiration', levels: 1, mp: 60, buff: 120000, reuse: 10000, effect: 'dance_of_inspiration', target: 'party', stat: 'pAccuracyCombatAdd', statValue: 4, statKind: 'add' },
    { id: 273, name: 'Dance of Mystic', levels: 1, mp: 60, buff: 120000, reuse: 10000, effect: 'dance_of_mystic', target: 'party', stat: 'mAtkMul', statValue: 1.2, statKind: 'mul' },
    { id: 274, name: 'Dance of Fire', levels: 1, mp: 60, buff: 120000, reuse: 10000, effect: 'dance_of_fire', target: 'party', stat: 'pCritDamageMul', statValue: 1.5, statKind: 'mul' },
    { id: 275, name: 'Dance of Fury', levels: 1, mp: 60, buff: 120000, reuse: 10000, effect: 'dance_of_fury', target: 'party', stat: 'pAtkSpdMul', statValue: 1.15, statKind: 'mul' },
    { id: 276, name: 'Dance of concentration', levels: 1, mp: 60, buff: 120000, reuse: 10000, effect: 'dance_of_concentration', target: 'party', stat: 'castSpdMul', statValue: 1.3, statKind: 'mul', extraStat: 'cancelAdd', extraValue: -40 },
    { id: 277, name: 'Dance of Light', levels: 1, mp: 60, buff: 120000, reuse: 10000, effect: 'dance_of_light', target: 'party', stat: 'pAtkUndeadMul', statValue: 1.3, statKind: 'mul' },
    { id: 1002, name: 'Chant of Flame', levels: 3, mp: 204, buff: 1200000, reuse: 20000, effect: 'chant_of_flame', target: 'party', stat: 'castSpdMul', statValue: 1.3, statKind: 'mul' },
    { id: 1006, name: 'Chant of Fire', levels: 3, mp: 188, buff: 1200000, reuse: 20000, effect: 'chant_of_fire', target: 'party', stat: 'mDefMul', statValue: 1.3, statKind: 'mul' },
    { id: 1007, name: 'Chant of Battle', levels: 3, mp: 154, buff: 1200000, reuse: 20000, effect: 'chant_of_battle', target: 'party', stat: 'pAtkMul', statValue: 1.15, statKind: 'mul' },
    { id: 1009, name: 'Chant of Shielding', levels: 3, mp: 139, buff: 1200000, reuse: 20000, effect: 'chant_of_shielding', target: 'party', stat: 'pDefMul', statValue: 1.15, statKind: 'mul' }
].forEach(({ id, name, levels, mp, buff, reuse, effect, target, stat, statValue, statKind, extraStat, extraValue }) => {
    const data = activeSkills.find((entry) => entry.selfId === id);
    assert(data, `${name} should be present in active skills data`);
    assert.strictEqual(data.template.name, name, `${name} should preserve sourced skill name`);
    assert.strictEqual(data.template.distance, -1, `${name} should preserve party/self-centered targeting distance`);
    assert.strictEqual(data.levels.length, levels, `${name} should preserve sourced base level count`);
    assert.strictEqual(data.levels[levels - 1].mp, mp, `${name} should preserve sourced final MP cost`);
    assert.strictEqual(data.time.buff, buff, `${name} should preserve sourced buff duration`);
    assert.strictEqual(data.time.reuse, reuse, `${name} should preserve sourced reuse`);
    const partyTarget = statActor();
    const partyBuff = skill({ selfId: id, name, spell: data.template.spell, power: 1, level: levels, distance: -1, buff });
    const outcome = SkillEffects.execute(session(), caster, partyTarget, partyBuff, {
        magicSkill: partyBuff.fetchSpell(),
        rng: () => 0,
        attack: { clearLoadedShot() {} }
    });
    assert.strictEqual(partyBuff.fetchSkillType(), C4SkillRules.EFFECT, `${name} should resolve to sourced BUFF effect semantics`);
    assert.strictEqual(partyBuff.fetchTargetKind(), target, `${name} should preserve sourced target semantics`);
    assert.strictEqual(outcome.effect.key, effect, `${name} should apply sourced effect key`);
    if (statKind === 'add') {
        assert.strictEqual(EffectStats.add(partyTarget, stat), statValue, `${name} should apply sourced ${stat} ${statValue}`);
    } else {
        assert.strictEqual(EffectStats.multiplier(partyTarget, stat), statValue, `${name} should apply sourced ${stat} ${statValue}`);
    }
    if (extraStat) {
        assert.strictEqual(EffectStats.add(partyTarget, extraStat), extraValue, `${name} should preserve sourced ${extraStat} ${extraValue}`);
    }
});

const partyBuffStatsTarget = statActor();
[
    { id: 264, name: 'Song of Earth', buff: 120000 },
    { id: 266, name: 'Song of Water', buff: 120000 },
    { id: 268, name: 'Song of Wind', buff: 120000 },
    { id: 269, name: 'Song of Hunter', buff: 120000 },
    { id: 271, name: 'Dance of Warrior', buff: 120000 },
    { id: 272, name: 'Dance of Inspiration', buff: 120000 },
    { id: 273, name: 'Dance of Mystic', buff: 120000 },
    { id: 275, name: 'Dance of Fury', buff: 120000 },
    { id: 276, name: 'Dance of concentration', buff: 120000 }
].forEach(({ id, name, buff }) => {
    SkillEffects.execute(session(), caster, partyBuffStatsTarget, skill({
        selfId: id,
        name,
        spell: false,
        power: 1,
        level: 1,
        distance: -1,
        buff
    }), {
        magicSkill: false,
        rng: () => 0,
        attack: { clearLoadedShot() {} }
    });
});
calculateStats({}, partyBuffStatsTarget);
assert.strictEqual(partyBuffStatsTarget.collectivePDef, Math.round(Math.round(Formulas.calcPDef(20, 100)) * 1.25), 'Song of Earth should multiply sourced PDef');
assert.strictEqual(partyBuffStatsTarget.collectiveEvasion, Formulas.calcEvasion(20, 30, 2) + 3, 'Song of Water should add sourced evasion');
assert.strictEqual(partyBuffStatsTarget.collectiveRunSpd, Formulas.calcSpeed(30, 120) + 20, 'Song of Wind should add sourced run speed');
assert.strictEqual(partyBuffStatsTarget.collectiveCritical, Formulas.calcCritical(30, 40) * 2, 'Song of Hunter should apply sourced rCrit basemul 1 as a 2x multiplier');
assert.strictEqual(partyBuffStatsTarget.collectivePAtk, Math.round(Formulas.calcPAtk(20, 30, 100) * 1.12), 'Dance of Warrior should multiply sourced PAtk');
assert.strictEqual(partyBuffStatsTarget.collectiveAccur, Formulas.calcAccur(20, 30, 5) + 4, 'Dance of Inspiration should add sourced accuracy');
assert.strictEqual(partyBuffStatsTarget.collectiveMAtk, Math.round(Formulas.calcMAtk(20, 30, 50) * 1.2), 'Dance of Mystic should multiply sourced MAtk');
assert.strictEqual(partyBuffStatsTarget.collectiveAtkSpd, Math.round(Math.round(Formulas.calcAtkSpd(30, 300)) * 1.15), 'Dance of Fury should multiply sourced PAtkSpd');
assert.strictEqual(partyBuffStatsTarget.collectiveCastSpd, Math.round(Formulas.calcCastSpd(30) * 1.3), 'Dance of concentration should multiply sourced MAtkSpd');

const paagrioStatsTarget = statActor();
[
    { id: 1003, name: 'Power of Paagrio' },
    { id: 1004, name: 'Wisdom of Paagrio' },
    { id: 1005, name: 'Blessing of Paagrio' },
    { id: 1008, name: 'Glory of Paagrio' }
].forEach(({ id, name }) => {
    SkillEffects.execute(session(), caster, paagrioStatsTarget, skill({
        selfId: id,
        name,
        spell: true,
        power: 1,
        level: 3,
        distance: -1,
        buff: 1200000
    }), {
        magicSkill: true,
        rng: () => 0,
        attack: { clearLoadedShot() {} }
    });
});
calculateStats({}, paagrioStatsTarget);
assert.strictEqual(paagrioStatsTarget.collectivePAtk, Math.round(Formulas.calcPAtk(20, 30, 100) * 1.15), 'Power of Paagrio should multiply sourced PAtk');
assert.strictEqual(paagrioStatsTarget.collectivePDef, Math.round(Math.round(Formulas.calcPDef(20, 100)) * 1.15), 'Blessing of Paagrio should multiply sourced PDef');
assert.strictEqual(paagrioStatsTarget.collectiveMDef, Math.round(Math.round(Formulas.calcMDef(20, 30, 80)) * 1.3), 'Glory of Paagrio should multiply sourced MDef');
assert.strictEqual(paagrioStatsTarget.collectiveCastSpd, Math.round(Formulas.calcCastSpd(30) * 1.3), 'Wisdom of Paagrio should multiply sourced MAtkSpd');

[
    { id: 1010, name: 'Soul Shield', levels: 3, mp: 30, effect: 'soul_shield', stat: 'pDefMul', statValue: 1.15, statKind: 'mul' },
    { id: 1043, name: 'Holy Weapon', levels: 1, mp: 23, effect: 'holy_weapon', stat: 'pAtkUndeadMul', statValue: 1.2, statKind: 'mul' },
    { id: 1073, name: 'Kiss of Eva', levels: 2, mp: 48, effect: 'kiss_of_eva', stat: 'breath', statValue: 7, statKind: 'mul' },
    { id: 1078, name: 'Concentration', levels: 6, mp: 64, effect: 'concentration', stat: 'cancelAdd', statValue: -53, statKind: 'add' },
    { id: 1182, name: 'Resist Aqua', levels: 3, mp: 39, effect: 'resist_aqua', stat: 'waterVuln', statValue: 0.7, statKind: 'mul' },
    { id: 1189, name: 'Resist Wind', levels: 3, mp: 39, effect: 'resist_wind', stat: 'windVuln', statValue: 0.7, statKind: 'mul' },
    { id: 1191, name: 'Resist Fire', levels: 3, mp: 39, effect: 'resist_fire', stat: 'fireVuln', statValue: 0.7, statKind: 'mul' }
].forEach(({ id, name, levels, mp, effect, stat, statValue, statKind }) => {
    const data = activeSkills.find((entry) => entry.selfId === id);
    assert(data, `${name} should be present in active skills data`);
    assert.strictEqual(data.template.name, name, `${name} should preserve sourced skill name`);
    assert.strictEqual(data.template.distance, 400, `${name} should preserve sourced TARGET_ONE cast range`);
    assert.strictEqual(data.levels.length, levels, `${name} should preserve sourced base level count`);
    assert.strictEqual(data.levels[levels - 1].mp, mp, `${name} should preserve sourced final MP cost`);
    assert.strictEqual(data.time.buff, 1200000, `${name} should preserve sourced 1200s buff duration`);
    assert.strictEqual(data.time.reuse, id === 1010 ? 5000 : 6000, `${name} should preserve sourced reuse`);
    const buffTarget = statActor();
    const friendlyBuff = skill({ selfId: id, name, spell: data.template.spell, power: 1, level: levels, distance: 400, buff: 1200000 });
    const outcome = SkillEffects.execute(session(), caster, buffTarget, friendlyBuff, {
        magicSkill: friendlyBuff.fetchSpell(),
        rng: () => 0,
        attack: { clearLoadedShot() {} }
    });
    assert.strictEqual(friendlyBuff.fetchSkillType(), C4SkillRules.EFFECT, `${name} should resolve to sourced BUFF effect semantics`);
    assert.strictEqual(friendlyBuff.fetchTargetKind(), 'friendly', `${name} should preserve sourced friendly TARGET_ONE semantics`);
    assert.strictEqual(outcome.effect.key, effect, `${name} should apply sourced effect key`);
    if (statKind === 'add') {
        assert.strictEqual(EffectStats.add(buffTarget, stat), statValue, `${name} should apply sourced ${stat} ${statValue}`);
    } else {
        assert.strictEqual(EffectStats.multiplier(buffTarget, stat), statValue, `${name} should apply sourced ${stat} ${statValue}`);
    }
});

const soulShieldStatsTarget = statActor();
SkillEffects.execute(session(), caster, soulShieldStatsTarget, skill({
    selfId: 1010,
    name: 'Soul Shield',
    spell: true,
    power: 1,
    level: 3,
    distance: 400,
    buff: 1200000
}), {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
calculateStats({}, soulShieldStatsTarget);
assert.strictEqual(soulShieldStatsTarget.collectivePDef, Math.round(Math.round(Formulas.calcPDef(20, 100)) * 1.15), 'Soul Shield level 3 should multiply sourced PDef');

[
    { id: 1157, name: 'Body To Mind', levels: 5, power: 61, hp: 366, expectedMp: 61 },
    { id: 2005, name: 'Mana potion', levels: 1, power: 400, hp: 0, expectedMp: 190 }
].forEach(({ id, name, levels, power, hp, expectedMp }) => {
    const data = activeSkills.find((entry) => entry.selfId === id);
    assert(data, `${name} should be present in active skills data`);
    assert.strictEqual(data.levels.length, levels, `${name} should preserve sourced base level count`);
    assert.strictEqual(data.levels[levels - 1].power, power, `${name} should preserve sourced final MP restore power`);
    assert.strictEqual(data.levels[levels - 1].hp, hp, `${name} should preserve sourced HP consume`);
    const manaTarget = creature({ id: 2000300 + id, mp: 10, maxMp: 200, level: 80 });
    const manaSkill = skill({ selfId: id, name, spell: true, power, level: levels, distance: -1 });
    const outcome = SkillEffects.execute(session(), manaTarget, manaTarget, manaSkill, {
        magicSkill: true,
        attack: { clearLoadedShot() {} }
    });
    assert.strictEqual(manaSkill.fetchSkillType(), C4SkillRules.MANA_HEAL, `${name} should resolve to MANAHEAL semantics`);
    assert.strictEqual(manaSkill.fetchTargetKind(), 'self', `${name} should preserve sourced TARGET_SELF semantics`);
    assert.strictEqual(outcome.mpRestore, expectedMp, `${name} should restore sourced MP without Recharge scaling`);
});

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

[
    { id: 2011, name: 'Quick step potion', buff: 1200000, effect: 'quick_step_potion', stat: 'runSpdAdd', statValue: 20, statKind: 'add' },
    { id: 2012, name: 'Potion of Alacrity', buff: 1200000, effect: 'potion_of_alacrity', stat: 'pAtkSpdMul', statValue: 1.15, statKind: 'mul' },
    { id: 2033, name: 'Haste potion', buff: 1200000, effect: 'haste_potion', stat: 'runSpdAdd', statValue: 33, statKind: 'add' },
    { id: 2034, name: 'Greater Haste Potion', buff: 1200000, effect: 'greater_haste_potion', stat: 'runSpdAdd', statValue: 33, statKind: 'add' },
    { id: 2035, name: 'Greater Swift Attack Potion', buff: 1200000, effect: 'greater_swift_attack_potion', stat: 'pAtkSpdMul', statValue: 1.33, statKind: 'mul' },
    { id: 2050, name: 'Scroll of Guidance', buff: 3600000, effect: 'scroll_of_guidance', stat: 'pAccuracyCombatAdd', statValue: 4, statKind: 'add' },
    { id: 2051, name: 'Scroll of Death Whisper', buff: 3600000, effect: 'scroll_of_death_whisper', stat: 'pCritDamageMul', statValue: 1.5, statKind: 'mul' },
    { id: 2052, name: 'Scroll of Focus', buff: 3600000, effect: 'scroll_of_focus', stat: 'pCritRateMul', statValue: 1.3, statKind: 'mul' },
    { id: 2053, name: 'Scroll of Greater Acumen', buff: 3600000, effect: 'scroll_of_greater_acumen', stat: 'castSpdMul', statValue: 1.3, statKind: 'mul' },
    { id: 2054, name: 'Scroll of Haste', buff: 3600000, effect: 'scroll_of_haste', stat: 'pAtkSpdMul', statValue: 1.33, statKind: 'mul' },
    { id: 2055, name: 'Scroll of Agility', buff: 3600000, effect: 'scroll_of_agility', stat: 'pEvasionRateAdd', statValue: 4, statKind: 'add' },
    { id: 2056, name: 'Scroll of Mystic Empower', buff: 3600000, effect: 'scroll_of_mystic_empower', stat: 'mAtkMul', statValue: 1.75, statKind: 'mul' },
    { id: 2057, name: 'Scroll of Might', buff: 3600000, effect: 'scroll_of_might', stat: 'pAtkMul', statValue: 1.15, statKind: 'mul' },
    { id: 2058, name: 'Scroll of Wind Walk', buff: 3600000, effect: 'scroll_of_wind_walk', stat: 'runSpdAdd', statValue: 33, statKind: 'add' },
    { id: 2059, name: 'Scroll of Shield', buff: 3600000, effect: 'scroll_of_shield', stat: 'pDefMul', statValue: 1.15, statKind: 'mul' }
].forEach(({ id, name, buff, effect, stat, statValue, statKind }) => {
    const data = activeSkills.find((entry) => entry.selfId === id);
    assert(data, `${name} should be present in active skills data`);
    assert.strictEqual(data.template.name, name, `${name} should preserve sourced skill name`);
    assert.strictEqual(data.template.distance, -1, `${name} should preserve sourced TARGET_SELF semantics`);
    assert.strictEqual(data.time.buff, buff, `${name} should preserve sourced buff duration`);
    const buffTarget = statActor();
    const buffSkill = skill({ selfId: id, name, spell: false, power: 1, level: 1, distance: -1, buff });
    const outcome = SkillEffects.execute(session(), buffTarget, buffTarget, buffSkill, {
        magicSkill: false,
        rng: () => 0,
        attack: { clearLoadedShot() {} }
    });
    assert.strictEqual(buffSkill.fetchSkillType(), C4SkillRules.EFFECT, `${name} should resolve to BUFF effect semantics`);
    assert.strictEqual(buffSkill.fetchTargetKind(), 'self', `${name} should resolve as a self buff`);
    assert.strictEqual(outcome.effect.key, effect, `${name} should apply sourced effect key`);
    if (statKind === 'add') {
        assert.strictEqual(EffectStats.add(buffTarget, stat), statValue, `${name} should apply sourced ${stat} ${statValue}`);
    } else {
        assert.strictEqual(EffectStats.multiplier(buffTarget, stat), statValue, `${name} should apply sourced ${stat} ${statValue}`);
    }
});

const scrollFocusTarget = statActor();
SkillEffects.execute(session(), scrollFocusTarget, scrollFocusTarget, skill({
    selfId: 2052,
    name: 'Scroll of Focus',
    spell: false,
    power: 1,
    level: 1,
    distance: -1,
    buff: 3600000
}), {
    magicSkill: false,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
calculateStats({}, scrollFocusTarget);
assert.strictEqual(
    scrollFocusTarget.collectiveCritical,
    Formulas.calcCritical(30, 40) * 1.3,
    'Scroll of Focus should apply sourced rCrit basemul 0.3 as a 1.3 runtime multiplier'
);

const scrollStatsTarget = statActor();
[
    { id: 2050, name: 'Scroll of Guidance', buff: 3600000 },
    { id: 2053, name: 'Scroll of Greater Acumen', buff: 3600000 },
    { id: 2055, name: 'Scroll of Agility', buff: 3600000 },
    { id: 2056, name: 'Scroll of Mystic Empower', buff: 3600000 },
    { id: 2057, name: 'Scroll of Might', buff: 3600000 },
    { id: 2058, name: 'Scroll of Wind Walk', buff: 3600000 },
    { id: 2059, name: 'Scroll of Shield', buff: 3600000 }
].forEach(({ id, name, buff }) => {
    SkillEffects.execute(session(), scrollStatsTarget, scrollStatsTarget, skill({
        selfId: id,
        name,
        spell: false,
        power: 1,
        level: 1,
        distance: -1,
        buff
    }), {
        magicSkill: false,
        rng: () => 0,
        attack: { clearLoadedShot() {} }
    });
});
calculateStats({}, scrollStatsTarget);
assert.strictEqual(scrollStatsTarget.collectiveAccur, Formulas.calcAccur(20, 30, 5) + 4, 'Scroll of Guidance should add sourced accuracy');
assert.strictEqual(scrollStatsTarget.collectiveCastSpd, Math.round(Formulas.calcCastSpd(30) * 1.3), 'Scroll of Greater Acumen should multiply sourced cast speed');
assert.strictEqual(scrollStatsTarget.collectiveEvasion, Formulas.calcEvasion(20, 30, 2) + 4, 'Scroll of Agility should add sourced evasion');
assert.strictEqual(scrollStatsTarget.collectiveMAtk, Math.round(Formulas.calcMAtk(20, 30, 50) * 1.75), 'Scroll of Mystic Empower should multiply sourced MAtk');
assert.strictEqual(scrollStatsTarget.collectivePAtk, Math.round(Formulas.calcPAtk(20, 30, 100) * 1.15), 'Scroll of Might should multiply sourced PAtk');
assert.strictEqual(scrollStatsTarget.collectiveRunSpd, Formulas.calcSpeed(30, 120) + 33, 'Scroll of Wind Walk should add sourced run speed');
assert.strictEqual(scrollStatsTarget.collectivePDef, Math.round(Formulas.calcPDef(20, 100) * 1.15), 'Scroll of Shield should multiply sourced PDef');

const potionSpeedTarget = statActor();
SkillEffects.execute(session(), potionSpeedTarget, potionSpeedTarget, skill({
    selfId: 2035,
    name: 'Greater Swift Attack Potion',
    spell: false,
    power: 1,
    level: 1,
    distance: -1,
    buff: 1200000
}), {
    magicSkill: false,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
calculateStats({}, potionSpeedTarget);
assert.strictEqual(
    potionSpeedTarget.collectiveAtkSpd,
    Math.round(Formulas.calcAtkSpd(30, 300) * 1.33),
    'Greater Swift Attack Potion should apply sourced pAtkSpd 1.33'
);

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

const shieldStunData = activeSkills.find((entry) => entry.selfId === 92);
assert(shieldStunData, 'Shield Stun should be present in active skills data');
assert.strictEqual(shieldStunData.template.distance, 40, 'Shield Stun should preserve sourced castRange 40');
assert.strictEqual(shieldStunData.time.buff, 9000, 'Shield Stun should preserve sourced 9 second stun duration');
assert.strictEqual(shieldStunData.levels.length, 52, 'Shield Stun should preserve sourced 52 base levels');
assert.strictEqual(shieldStunData.levels[0].power, 80, 'Shield Stun level 1 should use sourced power 80 as land rate');
assert.strictEqual(shieldStunData.levels[2].mp, 22, 'Shield Stun level 3 MP should use sourced mpConsume 22');
assert.strictEqual(shieldStunData.levels[51].mp, 83, 'Shield Stun level 52 MP should use sourced mpConsume 83');
const shieldStunTarget = creature({ id: 1000005, hp: 100, maxHp: 100, level: 20 });
const shieldStun = skill({ selfId: 92, name: 'Shield Stun', spell: false, power: 80, level: 52, buff: 9000, distance: 40 });
const shieldStunOutcome = SkillEffects.execute(session(), caster, shieldStunTarget, shieldStun, {
    magicSkill: false,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(shieldStun.fetchSkillType(), C4SkillRules.EFFECT, 'Shield Stun should resolve as sourced STUN effect semantics');
assert.strictEqual(shieldStun.fetchTargetKind(), 'enemy', 'Shield Stun should preserve sourced TARGET_ONE offensive semantics');
assert.strictEqual(shieldStun.fetchSemantic().baseLandRate, 80, 'Shield Stun should use sourced power 80 as land rate');
assert.strictEqual(shieldStun.fetchSemantic().levelDepend, 2, 'Shield Stun should preserve sourced lvlDepend metadata');
assert.deepStrictEqual(shieldStun.fetchSemantic().requires, { weaponsAllowed: 1048576, itemKind: 'shield' }, 'Shield Stun should preserve sourced shield-use requirement');
assert.strictEqual(shieldStun.fetchSemantic().castRange, 40, 'Shield Stun should preserve sourced castRange metadata');
assert.strictEqual(shieldStun.fetchSemantic().effectRange, 400, 'Shield Stun should preserve sourced effectRange metadata');
assert.strictEqual(shieldStunOutcome.damage, 0, 'Shield Stun should not be routed as physical damage');
assert.strictEqual(shieldStunOutcome.effect.key, 'stun', 'Shield Stun should apply a structured stun debuff');
assert.strictEqual(EffectStore.hasDebuff(shieldStunTarget, 'stun'), true, 'Shield Stun debuff should be visible through EffectStore');
assert.strictEqual(EffectRestrictions.canMove(shieldStunTarget), false, 'Shield Stun should block movement through runtime restrictions');
assert.strictEqual(EffectRestrictions.canAttack(shieldStunTarget), false, 'Shield Stun should block attacks through runtime restrictions');
assert.strictEqual(EffectRestrictions.canCast(shieldStunTarget), false, 'Shield Stun should block casting through runtime restrictions');
EffectStore.remove(shieldStunTarget, 'stun');

const stunningFistData = activeSkills.find((entry) => entry.selfId === 120);
assert(stunningFistData, 'Stunning Fist should be present in active skills data');
assert.strictEqual(stunningFistData.template.distance, 40, 'Stunning Fist should preserve sourced castRange 40');
assert.strictEqual(stunningFistData.time.buff, 9000, 'Stunning Fist should preserve sourced 9 second stun duration');
assert.strictEqual(stunningFistData.levels.length, 15, 'Stunning Fist should preserve sourced 15 base levels');
assert.strictEqual(stunningFistData.levels[0].power, 38, 'Stunning Fist level 1 should preserve sourced PDAM power 38');
assert.strictEqual(stunningFistData.levels[14].power, 136, 'Stunning Fist level 15 should preserve sourced PDAM power 136');
assert.strictEqual(stunningFistData.levels[14].mp, 37, 'Stunning Fist level 15 MP should use sourced mpConsume 37');
const stunningFistTarget = creature({ id: 1000006, hp: 100, maxHp: 100, level: 20 });
const stunningFist = skill({ selfId: 120, name: 'Stunning Fist', spell: false, power: 136, level: 15, buff: 9000, distance: 40 });
const stunningFistOutcome = SkillEffects.execute(session(), caster, stunningFistTarget, stunningFist, {
    magicSkill: false,
    rng: () => 0,
    attack: {
        clearLoadedShot() {},
        prepareSkillDamage: () => 77
    }
});
assert.strictEqual(stunningFist.fetchSkillType(), C4SkillRules.DAMAGE_EFFECT, 'Stunning Fist should resolve as sourced PDAM plus stun');
assert.strictEqual(stunningFist.fetchTargetKind(), 'enemy', 'Stunning Fist should preserve sourced TARGET_ONE offensive semantics');
assert.strictEqual(stunningFist.fetchSsBoost(), 1, 'Stunning Fist should preserve sourced physical shot boost semantics');
assert.strictEqual(stunningFist.fetchSemantic().baseLandRate, 50, 'Stunning Fist should use sourced effectPower 50 as stun land rate');
assert.strictEqual(stunningFist.fetchSemantic().levelDepend, 2, 'Stunning Fist should preserve sourced lvlDepend 2');
assert.deepStrictEqual(stunningFist.fetchSemantic().requires, { weaponsAllowed: 1024 }, 'Stunning Fist should preserve sourced weaponsAllowed requirement');
assert.strictEqual(stunningFistOutcome.damage, 77, 'Stunning Fist should keep its physical damage component');
assert.strictEqual(stunningFistOutcome.effect.key, 'stun', 'Stunning Fist should apply its structured stun effect');
assert.strictEqual(EffectRestrictions.canMove(stunningFistTarget), false, 'Stunning Fist stun should block movement');
EffectStore.remove(stunningFistTarget, 'stun');

const thunderStormData = activeSkills.find((entry) => entry.selfId === 48);
assert(thunderStormData, 'Thunder Storm should be present in active skills data');
assert.strictEqual(thunderStormData.template.distance, -1, 'Thunder Storm should preserve sourced TARGET_AURA self-centered range');
assert.strictEqual(thunderStormData.time.buff, 9000, 'Thunder Storm should preserve sourced 9 second stun duration');
assert.strictEqual(thunderStormData.levels.length, 37, 'Thunder Storm should preserve sourced 37 base levels');
assert.strictEqual(thunderStormData.levels[20].power, 349, 'Thunder Storm level 21 should preserve existing sourced PDAM power 349');
assert.strictEqual(thunderStormData.levels[36].power, 609, 'Thunder Storm level 37 should preserve sourced PDAM power 609');
assert.strictEqual(thunderStormData.levels[36].mp, 83, 'Thunder Storm level 37 MP should use sourced mpConsume 83');
const thunderStormTarget = creature({ id: 1000007, hp: 100, maxHp: 100, level: 20 });
const thunderStorm = skill({ selfId: 48, name: 'Thunder Storm', spell: false, power: 609, level: 37, buff: 9000, distance: -1 });
const thunderStormOutcome = SkillEffects.execute(session(), caster, thunderStormTarget, thunderStorm, {
    magicSkill: false,
    rng: () => 0,
    attack: {
        clearLoadedShot() {},
        prepareSkillDamage: () => 88
    }
});
assert.strictEqual(thunderStorm.fetchSkillType(), C4SkillRules.DAMAGE_EFFECT, 'Thunder Storm should resolve as sourced PDAM plus stun');
assert.strictEqual(thunderStorm.fetchTargetKind(), 'enemy', 'Thunder Storm should remain executable against selected enemies');
assert.strictEqual(thunderStorm.fetchSsBoost(), 1, 'Thunder Storm should preserve sourced physical shot boost semantics');
assert.strictEqual(thunderStorm.fetchSemantic().sourceTarget, 'aura', 'Thunder Storm should preserve sourced TARGET_AURA semantics');
assert.strictEqual(thunderStorm.fetchSemantic().radius, 150, 'Thunder Storm should preserve sourced skillRadius 150');
assert.strictEqual(thunderStorm.fetchSemantic().baseLandRate, 50, 'Thunder Storm should use sourced effectPower 50 as stun land rate');
assert.strictEqual(thunderStorm.fetchSemantic().levelDepend, 1, 'Thunder Storm should preserve sourced lvlDepend 1');
assert.deepStrictEqual(thunderStorm.fetchSemantic().requires, { weaponsAllowed: 64 }, 'Thunder Storm should preserve sourced weaponsAllowed requirement');
assert.strictEqual(thunderStormOutcome.damage, 88, 'Thunder Storm should keep its physical damage component');
assert.strictEqual(thunderStormOutcome.effect.key, 'stun', 'Thunder Storm should apply its structured stun effect');
assert.strictEqual(EffectRestrictions.canMove(thunderStormTarget), false, 'Thunder Storm stun should block movement');
EffectStore.remove(thunderStormTarget, 'stun');

const hammerCrushData = activeSkills.find((entry) => entry.selfId === 260);
assert(hammerCrushData, 'Hammer Crush should be present in active skills data');
assert.strictEqual(hammerCrushData.template.distance, 40, 'Hammer Crush should preserve sourced castRange 40');
assert.strictEqual(hammerCrushData.time.buff, 9000, 'Hammer Crush should preserve sourced 9 second stun duration');
assert.strictEqual(hammerCrushData.levels.length, 37, 'Hammer Crush should preserve sourced 37 base levels');
assert.strictEqual(hammerCrushData.levels[20].power, 349, 'Hammer Crush level 21 should preserve existing sourced PDAM power 349');
assert.strictEqual(hammerCrushData.levels[36].power, 609, 'Hammer Crush level 37 should preserve sourced PDAM power 609');
assert.strictEqual(hammerCrushData.levels[36].mp, 83, 'Hammer Crush level 37 MP should use sourced mpConsume 83');
const hammerCrushTarget = creature({ id: 1000008, hp: 100, maxHp: 100, level: 20 });
const hammerCrush = skill({ selfId: 260, name: 'Hammer Crush', spell: false, power: 609, level: 37, buff: 9000, distance: 40 });
const hammerCrushOutcome = SkillEffects.execute(session(), caster, hammerCrushTarget, hammerCrush, {
    magicSkill: false,
    rng: () => 0,
    attack: {
        clearLoadedShot() {},
        prepareSkillDamage: () => 99
    }
});
assert.strictEqual(hammerCrush.fetchSkillType(), C4SkillRules.DAMAGE_EFFECT, 'Hammer Crush should resolve as sourced PDAM plus stun');
assert.strictEqual(hammerCrush.fetchTargetKind(), 'enemy', 'Hammer Crush should preserve sourced TARGET_ONE offensive semantics');
assert.strictEqual(hammerCrush.fetchSsBoost(), 1, 'Hammer Crush should preserve sourced physical shot boost semantics');
assert.strictEqual(hammerCrush.fetchSemantic().baseLandRate, 50, 'Hammer Crush should use sourced effectPower 50 as stun land rate');
assert.strictEqual(hammerCrush.fetchSemantic().levelDepend, 1, 'Hammer Crush should preserve sourced lvlDepend 1');
assert.deepStrictEqual(hammerCrush.fetchSemantic().requires, { weaponsAllowed: 16392 }, 'Hammer Crush should preserve sourced weaponsAllowed requirement');
assert.strictEqual(hammerCrushOutcome.damage, 99, 'Hammer Crush should keep its physical damage component');
assert.strictEqual(hammerCrushOutcome.effect.key, 'stun', 'Hammer Crush should apply its structured stun effect');
assert.strictEqual(EffectRestrictions.canMove(hammerCrushTarget), false, 'Hammer Crush stun should block movement');
EffectStore.remove(hammerCrushTarget, 'stun');

const tripleSlashData = activeSkills.find((entry) => entry.selfId === 1);
assert(tripleSlashData, 'Triple Slash should be present in active skills data');
assert.strictEqual(tripleSlashData.template.distance, 40, 'Triple Slash should preserve sourced castRange 40');
assert.strictEqual(tripleSlashData.time.hitTime, 1733, 'Triple Slash should preserve sourced hitTime 1733');
assert.strictEqual(tripleSlashData.time.reuse, 13000, 'Triple Slash should preserve sourced reuseDelay 13000');
assert.strictEqual(tripleSlashData.levels.length, 37, 'Triple Slash should preserve sourced 37 base levels');
assert.strictEqual(tripleSlashData.levels[3].power, 516, 'Triple Slash level 4 should preserve sourced PDAM power 516');
assert.strictEqual(tripleSlashData.levels[20].power, 1220, 'Triple Slash level 21 should preserve existing sourced PDAM power 1220');
assert.strictEqual(tripleSlashData.levels[36].power, 2131, 'Triple Slash level 37 should preserve sourced PDAM power 2131');
assert.strictEqual(tripleSlashData.levels[36].mp, 97, 'Triple Slash level 37 MP should use sourced mpConsume 97');
const tripleSlashTarget = creature({ id: 1000013, hp: 100, maxHp: 100, level: 20 });
const tripleSlash = skill({ selfId: 1, name: 'Triple Slash', spell: false, power: 2131, level: 37, distance: 40 });
const tripleSlashOutcome = SkillEffects.execute(session(), caster, tripleSlashTarget, tripleSlash, {
    magicSkill: false,
    rng: () => 0,
    attack: {
        clearLoadedShot() {},
        prepareSkillDamage: () => 145
    }
});
assert.strictEqual(tripleSlash.fetchSkillType(), C4SkillRules.DAMAGE, 'Triple Slash should resolve as sourced PDAM');
assert.strictEqual(tripleSlash.fetchTargetKind(), 'enemy', 'Triple Slash should preserve sourced TARGET_ONE offensive semantics');
assert.strictEqual(tripleSlash.fetchSsBoost(), 1, 'Triple Slash should preserve sourced physical shot boost semantics');
assert.deepStrictEqual(tripleSlash.fetchSemantic().requires, { weaponsAllowed: 512, itemKind: 'Dual Sword' }, 'Triple Slash should preserve sourced dual sword requirement');
assert.strictEqual(tripleSlashOutcome.damage, 145, 'Triple Slash should keep its physical damage component');
assert.strictEqual(tripleSlashOutcome.effect, null, 'Triple Slash should remain a pure damage skill without a debuff');

const doubleSonicSlashData = activeSkills.find((entry) => entry.selfId === 5);
assert(doubleSonicSlashData, 'Double Sonic Slash should be present in active skills data');
assert.strictEqual(doubleSonicSlashData.template.distance, 40, 'Double Sonic Slash should preserve sourced castRange 40');
assert.strictEqual(doubleSonicSlashData.time.hitTime, 1733, 'Double Sonic Slash should preserve sourced hitTime 1733');
assert.strictEqual(doubleSonicSlashData.time.reuse, 17000, 'Double Sonic Slash should preserve sourced reuseDelay 17000');
assert.strictEqual(doubleSonicSlashData.levels.length, 31, 'Double Sonic Slash should preserve sourced 31 base levels');
assert.strictEqual(doubleSonicSlashData.levels[14].power, 1830, 'Double Sonic Slash level 15 should preserve existing sourced CHARGEDAM power 1830');
assert.strictEqual(doubleSonicSlashData.levels[30].power, 3196, 'Double Sonic Slash level 31 should preserve sourced CHARGEDAM power 3196');
assert.strictEqual(doubleSonicSlashData.levels[30].mp, 116, 'Double Sonic Slash level 31 MP should use sourced mpConsume 116');
const doubleSonicSlashTarget = creature({ id: 1000014, hp: 100, maxHp: 100, level: 20 });
const doubleSonicSlash = skill({ selfId: 5, name: 'Double Sonic Slash', spell: false, power: 3196, level: 31, distance: 40 });
const doubleSonicSlashOutcome = SkillEffects.execute(session(), caster, doubleSonicSlashTarget, doubleSonicSlash, {
    magicSkill: false,
    rng: () => 0,
    attack: {
        clearLoadedShot() {},
        prepareSkillDamage: () => 156
    }
});
assert.strictEqual(doubleSonicSlash.fetchSkillType(), C4SkillRules.DAMAGE, 'Double Sonic Slash should execute as damage while preserving sourced CHARGEDAM metadata');
assert.strictEqual(doubleSonicSlash.fetchTargetKind(), 'enemy', 'Double Sonic Slash should preserve sourced TARGET_ONE offensive semantics');
assert.strictEqual(doubleSonicSlash.fetchSsBoost(), 1, 'Double Sonic Slash should preserve sourced physical shot boost semantics');
assert.deepStrictEqual(doubleSonicSlash.fetchSemantic().requires, { weaponsAllowed: 512, itemKind: 'Dual Sword', charges: 2, condition: 128, conditionValue: 2 }, 'Double Sonic Slash should preserve sourced dual sword and charge requirements');
assert.strictEqual(doubleSonicSlashOutcome.damage, 156, 'Double Sonic Slash should keep its physical damage component');
assert.strictEqual(doubleSonicSlashOutcome.effect, null, 'Double Sonic Slash should remain a pure damage skill without a debuff');

const sonicBlasterData = activeSkills.find((entry) => entry.selfId === 6);
assert(sonicBlasterData, 'Sonic Blaster should be present in active skills data');
assert.strictEqual(sonicBlasterData.template.distance, 600, 'Sonic Blaster should preserve sourced castRange 600');
assert.strictEqual(sonicBlasterData.time.hitTime, 1900, 'Sonic Blaster should preserve sourced hitTime 1900');
assert.strictEqual(sonicBlasterData.time.reuse, 15000, 'Sonic Blaster should preserve sourced reuseDelay 15000');
assert.strictEqual(sonicBlasterData.levels.length, 37, 'Sonic Blaster should preserve sourced 37 base levels');
assert.strictEqual(sonicBlasterData.levels[20].power, 1046, 'Sonic Blaster level 21 should preserve existing sourced CHARGEDAM power 1046');
assert.strictEqual(sonicBlasterData.levels[36].power, 1827, 'Sonic Blaster level 37 should preserve sourced CHARGEDAM power 1827');
assert.strictEqual(sonicBlasterData.levels[36].mp, 58, 'Sonic Blaster level 37 MP should use sourced mpConsume 58');
const sonicBlasterTarget = creature({ id: 1000015, hp: 100, maxHp: 100, level: 20 });
const sonicBlaster = skill({ selfId: 6, name: 'Sonic Blaster', spell: false, power: 1827, level: 37, distance: 600 });
const sonicBlasterOutcome = SkillEffects.execute(session(), caster, sonicBlasterTarget, sonicBlaster, {
    magicSkill: false,
    rng: () => 0,
    attack: {
        clearLoadedShot() {},
        prepareSkillDamage: () => 167
    }
});
assert.strictEqual(sonicBlaster.fetchSkillType(), C4SkillRules.DAMAGE, 'Sonic Blaster should execute as damage while preserving sourced CHARGEDAM metadata');
assert.strictEqual(sonicBlaster.fetchTargetKind(), 'enemy', 'Sonic Blaster should preserve sourced TARGET_ONE offensive semantics');
assert.strictEqual(sonicBlaster.fetchSsBoost(), 1, 'Sonic Blaster should preserve sourced physical shot boost semantics');
assert.deepStrictEqual(sonicBlaster.fetchSemantic().requires, { weaponsAllowed: 524, charges: 1, condition: 128, conditionValue: 1 }, 'Sonic Blaster should preserve sourced weapon and charge requirements');
assert.strictEqual(sonicBlasterOutcome.damage, 167, 'Sonic Blaster should keep its physical damage component');
assert.strictEqual(sonicBlasterOutcome.effect, null, 'Sonic Blaster should remain a pure damage skill without a debuff');

const sonicStormData = activeSkills.find((entry) => entry.selfId === 7);
assert(sonicStormData, 'Sonic Storm should be present in active skills data');
assert.strictEqual(sonicStormData.template.distance, 500, 'Sonic Storm should preserve sourced castRange 500');
assert.strictEqual(sonicStormData.time.hitTime, 1900, 'Sonic Storm should preserve sourced hitTime 1900');
assert.strictEqual(sonicStormData.time.reuse, 20000, 'Sonic Storm should preserve sourced reuseDelay 20000');
assert.strictEqual(sonicStormData.levels.length, 28, 'Sonic Storm should preserve sourced 28 base levels');
assert.strictEqual(sonicStormData.levels[11].power, 262, 'Sonic Storm level 12 should preserve existing sourced CHARGEDAM power 262');
assert.strictEqual(sonicStormData.levels[27].power, 457, 'Sonic Storm level 28 should preserve sourced CHARGEDAM power 457');
assert.strictEqual(sonicStormData.levels[27].mp, 100, 'Sonic Storm level 28 MP should use sourced mpConsume 100');
const sonicStormTarget = creature({ id: 1000016, hp: 100, maxHp: 100, level: 20 });
const sonicStorm = skill({ selfId: 7, name: 'Sonic Storm', spell: false, power: 457, level: 28, distance: 500 });
const sonicStormOutcome = SkillEffects.execute(session(), caster, sonicStormTarget, sonicStorm, {
    magicSkill: false,
    rng: () => 0,
    attack: {
        clearLoadedShot() {},
        prepareSkillDamage: () => 178
    }
});
assert.strictEqual(sonicStorm.fetchSkillType(), C4SkillRules.DAMAGE, 'Sonic Storm should execute as damage while preserving sourced CHARGEDAM metadata');
assert.strictEqual(sonicStorm.fetchTargetKind(), 'enemy', 'Sonic Storm should remain executable against selected enemies');
assert.strictEqual(sonicStorm.fetchSsBoost(), 1, 'Sonic Storm should preserve sourced physical shot boost semantics');
assert.strictEqual(sonicStorm.fetchSemantic().sourceTarget, 'area', 'Sonic Storm should preserve sourced TARGET_AREA semantics');
assert.strictEqual(sonicStorm.fetchSemantic().radius, 205, 'Sonic Storm should preserve sourced skillRadius 205');
assert.deepStrictEqual(sonicStorm.fetchSemantic().requires, { weaponsAllowed: 524, charges: 1, condition: 128, conditionValue: 1 }, 'Sonic Storm should preserve sourced weapon and charge requirements');
assert.strictEqual(sonicStormOutcome.damage, 178, 'Sonic Storm should keep its physical damage component');
assert.strictEqual(sonicStormOutcome.effect, null, 'Sonic Storm should remain a pure damage skill without a debuff');

const focusSonicData = activeSkills.find((entry) => entry.selfId === 8);
assert(focusSonicData, 'Focus Sonic should be present in active skills data');
assert.strictEqual(focusSonicData.template.distance, -1, 'Focus Sonic should preserve sourced TARGET_SELF range semantics');
assert.strictEqual(focusSonicData.time.hitTime, 900, 'Focus Sonic should preserve sourced hitTime 900');
assert.strictEqual(focusSonicData.time.reuse, 1000, 'Focus Sonic should preserve sourced reuseDelay 1000');
assert.strictEqual(focusSonicData.levels.length, 7, 'Focus Sonic should preserve sourced 7 base levels');
assert.strictEqual(focusSonicData.levels[0].power, 1, 'Focus Sonic level 1 should preserve sourced maxCharges 1');
assert.strictEqual(focusSonicData.levels[6].power, 7, 'Focus Sonic level 7 should preserve sourced maxCharges 7');
assert.strictEqual(focusSonicData.levels[6].mp, 10, 'Focus Sonic level 7 MP should use sourced mpConsume 10');
const focusSonic = skill({ selfId: 8, name: 'Focus Sonic', spell: false, power: 7, level: 7, distance: -1 });
const focusSonicOutcome = SkillEffects.execute(session(), caster, caster, focusSonic, { magicSkill: false });
assert.strictEqual(focusSonic.fetchSkillType(), C4SkillRules.CHARGE, 'Focus Sonic should preserve sourced CHARGE semantics');
assert.strictEqual(focusSonic.fetchTargetKind(), 'self', 'Focus Sonic should preserve sourced TARGET_SELF semantics');
assert.strictEqual(focusSonic.fetchSsBoost(), 0, 'Focus Sonic should not use shot boost semantics');
assert.strictEqual(focusSonic.fetchSemantic().maxCharges, 7, 'Focus Sonic level 7 should preserve sourced maxCharges 7');
assert.strictEqual(focusSonic.fetchSemantic().aggroPoints, 200, 'Focus Sonic should preserve sourced aggroPoints 200 metadata');
assert.deepStrictEqual(focusSonic.fetchSemantic().requires, { weaponsAllowed: 524 }, 'Focus Sonic should preserve sourced weapon requirement');
assert.strictEqual(focusSonicOutcome.damage, 0, 'Focus Sonic should not be treated as a damage skill without sourced damage semantics');
assert.strictEqual(focusSonicOutcome.effect, null, 'Focus Sonic should not invent an effect while charge runtime is not implemented');

const focusForceData = activeSkills.find((entry) => entry.selfId === 50);
assert(focusForceData, 'Focus Force should be present in active skills data');
assert.strictEqual(focusForceData.template.distance, -1, 'Focus Force should preserve sourced TARGET_SELF range semantics');
assert.strictEqual(focusForceData.time.hitTime, 900, 'Focus Force should preserve sourced hitTime 900');
assert.strictEqual(focusForceData.time.reuse, 1000, 'Focus Force should preserve sourced reuseDelay 1000');
assert.strictEqual(focusForceData.levels.length, 7, 'Focus Force should preserve sourced 7 base levels');
assert.strictEqual(focusForceData.levels[0].power, 1, 'Focus Force level 1 should preserve sourced maxCharges 1');
assert.strictEqual(focusForceData.levels[6].power, 7, 'Focus Force level 7 should preserve sourced maxCharges 7');
assert.strictEqual(focusForceData.levels[6].mp, 7, 'Focus Force level 7 MP should use sourced mpConsume 7');
const focusForce = skill({ selfId: 50, name: 'Focus Force', spell: false, power: 7, level: 7, distance: -1 });
const focusForceOutcome = SkillEffects.execute(session(), caster, caster, focusForce, { magicSkill: false });
assert.strictEqual(focusForce.fetchSkillType(), C4SkillRules.CHARGE, 'Focus Force should preserve sourced CHARGE semantics');
assert.strictEqual(focusForce.fetchTargetKind(), 'self', 'Focus Force should preserve sourced TARGET_SELF semantics');
assert.strictEqual(focusForce.fetchSsBoost(), 0, 'Focus Force should not use shot boost semantics');
assert.strictEqual(focusForce.fetchSemantic().maxCharges, 7, 'Focus Force level 7 should preserve sourced maxCharges 7');
assert.strictEqual(focusForce.fetchSemantic().aggroPoints, 150, 'Focus Force should preserve sourced aggroPoints 150 metadata');
assert.deepStrictEqual(focusForce.fetchSemantic().requires, { weaponsAllowed: 1024 }, 'Focus Force should preserve sourced fist weapon requirement');
assert.strictEqual(focusForceOutcome.damage, 0, 'Focus Force should not be treated as a damage skill without sourced damage semantics');
assert.strictEqual(focusForceOutcome.effect, null, 'Focus Force should not invent an effect while charge runtime is not implemented');

const sonicBusterData = activeSkills.find((entry) => entry.selfId === 9);
assert(sonicBusterData, 'Sonic Buster should be present in active skills data');
assert.strictEqual(sonicBusterData.template.distance, 40, 'Sonic Buster should preserve sourced castRange 40');
assert.strictEqual(sonicBusterData.time.hitTime, 720, 'Sonic Buster should preserve sourced hitTime 720');
assert.strictEqual(sonicBusterData.time.reuse, 10000, 'Sonic Buster should preserve sourced reuseDelay 10000');
assert.strictEqual(sonicBusterData.levels.length, 34, 'Sonic Buster should preserve sourced 34 base levels');
assert.strictEqual(sonicBusterData.levels[17].power, 262, 'Sonic Buster level 18 should preserve existing sourced CHARGEDAM power 262');
assert.strictEqual(sonicBusterData.levels[33].power, 457, 'Sonic Buster level 34 should preserve sourced CHARGEDAM power 457');
assert.strictEqual(sonicBusterData.levels[33].mp, 100, 'Sonic Buster level 34 MP should use sourced mpConsume 100');
const sonicBusterTarget = creature({ id: 1000017, hp: 100, maxHp: 100, level: 20 });
const sonicBuster = skill({ selfId: 9, name: 'Sonic Buster', spell: false, power: 457, level: 34, distance: 40 });
const sonicBusterOutcome = SkillEffects.execute(session(), caster, sonicBusterTarget, sonicBuster, {
    magicSkill: false,
    rng: () => 0,
    attack: {
        clearLoadedShot() {},
        prepareSkillDamage: () => 189
    }
});
assert.strictEqual(sonicBuster.fetchSkillType(), C4SkillRules.DAMAGE, 'Sonic Buster should execute as damage while preserving sourced CHARGEDAM metadata');
assert.strictEqual(sonicBuster.fetchTargetKind(), 'enemy', 'Sonic Buster should remain executable against selected enemies');
assert.strictEqual(sonicBuster.fetchSsBoost(), 1, 'Sonic Buster should preserve sourced physical shot boost semantics');
assert.strictEqual(sonicBuster.fetchSemantic().sourceTarget, 'front_area', 'Sonic Buster should preserve sourced TARGET_FRONT_AREA semantics');
assert.strictEqual(sonicBuster.fetchSemantic().radius, 200, 'Sonic Buster should preserve sourced skillRadius 200');
assert.deepStrictEqual(sonicBuster.fetchSemantic().requires, { weaponsAllowed: 524, charges: 1, condition: 128, conditionValue: 1 }, 'Sonic Buster should preserve sourced weapon and charge requirements');
assert.strictEqual(sonicBusterOutcome.damage, 189, 'Sonic Buster should keep its physical damage component');
assert.strictEqual(sonicBusterOutcome.effect, null, 'Sonic Buster should remain a pure damage skill without a debuff');

const trickData = activeSkills.find((entry) => entry.selfId === 11);
assert(trickData, 'Trick should be present in active skills data');
assert.strictEqual(trickData.template.distance, 400, 'Trick should preserve sourced castRange 400');
assert.strictEqual(trickData.time.hitTime, 1200, 'Trick should preserve sourced hitTime 1200');
assert.strictEqual(trickData.time.reuse, 20000, 'Trick should preserve sourced reuseDelay 20000');
assert.strictEqual(trickData.levels.length, 12, 'Trick should preserve sourced 12 base levels');
assert.strictEqual(trickData.levels[0].power, 50, 'Trick level 1 should preserve sourced AGGREDUCE_CHAR power 50');
assert.strictEqual(trickData.levels[11].power, 50, 'Trick level 12 should preserve sourced AGGREDUCE_CHAR power 50');
assert.strictEqual(trickData.levels[11].mp, 83, 'Trick level 12 MP should use sourced mpConsume 83');
const trickTarget = creature({ id: 1000018, hp: 100, maxHp: 100, level: 20 });
const trick = skill({ selfId: 11, name: 'Trick', spell: false, power: 50, level: 12, distance: 400 });
const trickOutcome = SkillEffects.execute(session(), caster, trickTarget, trick, {
    magicSkill: false,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(trick.fetchSkillType(), C4SkillRules.AGGRO_REDUCE_CHAR, 'Trick should preserve sourced AGGREDUCE_CHAR semantics');
assert.strictEqual(trick.fetchTargetKind(), 'enemy', 'Trick should preserve sourced TARGET_ONE offensive semantics');
assert.strictEqual(trick.fetchSemantic().trait, 'derangement', 'Trick should use sourced AGGREDUCE_CHAR derangement vulnerability semantics');
assert.strictEqual(trick.fetchSemantic().baseLandRate, 50, 'Trick should use sourced power 50 as land rate');
assert.strictEqual(trickOutcome.damage, 0, 'Trick should not be routed as damage');
assert.strictEqual(trickOutcome.aggroReduced, true, 'Trick should mark a successful sourced AGGREDUCE_CHAR outcome');
assert.strictEqual(trickOutcome.aggroRemoved, false, 'Trick should not be conflated with AGGREMOVE');

const switchData = activeSkills.find((entry) => entry.selfId === 12);
assert(switchData, 'Switch should be present in active skills data');
assert.strictEqual(switchData.template.distance, 600, 'Switch should preserve sourced castRange 600');
assert.strictEqual(switchData.time.hitTime, 1200, 'Switch should preserve sourced hitTime 1200');
assert.strictEqual(switchData.time.reuse, 12000, 'Switch should preserve sourced reuseDelay 12000');
assert.strictEqual(switchData.time.buff, 30000, 'Switch should preserve sourced Confusion count/time duration');
assert.strictEqual(switchData.levels.length, 14, 'Switch should preserve sourced 14 base levels');
assert.strictEqual(switchData.levels[0].power, 80, 'Switch level 1 should preserve sourced CONFUSE_MOB_ONLY power 80');
assert.strictEqual(switchData.levels[13].mp, 83, 'Switch level 14 MP should use sourced mpConsume 83');
const switchPlayerTarget = creature({ id: 1000019, hp: 100, maxHp: 100, level: 20 });
const switchSkill = skill({ selfId: 12, name: 'Switch', spell: false, power: 80, level: 14, distance: 600, buff: 30000 });
const switchPlayerOutcome = SkillEffects.execute(session(), caster, switchPlayerTarget, switchSkill, {
    magicSkill: false,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(switchPlayerOutcome.effect, null, 'Switch should not apply CONFUSE_MOB_ONLY to non-attackable targets');
assert.strictEqual(switchPlayerOutcome.effectResisted, true, 'Switch mob-only rejection should report effect resistance');
const switchMobTarget = creature({ id: 1000020, hp: 100, maxHp: 100, level: 20 });
switchMobTarget.fetchAttackable = () => true;
const switchMobOutcome = SkillEffects.execute(session(), caster, switchMobTarget, switchSkill, {
    magicSkill: false,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(switchSkill.fetchSkillType(), C4SkillRules.EFFECT, 'Switch should preserve sourced CONFUSE_MOB_ONLY effect semantics');
assert.strictEqual(switchSkill.fetchTargetKind(), 'enemy', 'Switch should preserve sourced TARGET_ONE offensive semantics');
assert.strictEqual(switchSkill.fetchSemantic().baseLandRate, 80, 'Switch should use sourced power 80 as land rate');
assert.strictEqual(switchSkill.fetchSemantic().mobOnly, true, 'Switch should preserve sourced mob-only semantics');
assert.strictEqual(switchMobOutcome.effect.key, 'confusion', 'Switch should apply a structured confusion debuff to attackable NPCs');
assert.strictEqual(EffectStore.impairments(switchMobTarget).confused, true, 'Switch confusion should be visible through impairments');
EffectStore.remove(switchMobTarget, 'confusion');

const charmData = activeSkills.find((entry) => entry.selfId === 15);
assert(charmData, 'Charm should be present in active skills data');
assert.strictEqual(charmData.template.distance, 600, 'Charm should preserve sourced castRange 600');
assert.strictEqual(charmData.time.hitTime, 1500, 'Charm should preserve sourced hitTime 1500');
assert.strictEqual(charmData.time.reuse, 60000, 'Charm should preserve sourced reuseDelay 60000');
assert.strictEqual(charmData.levels.length, 52, 'Charm should preserve sourced 52 base levels');
assert.strictEqual(charmData.levels[2].power, 143, 'Charm level 3 should preserve sourced AGGREDUCE power 143');
assert.strictEqual(charmData.levels[35].power, 385, 'Charm level 36 should preserve existing sourced AGGREDUCE power 385');
assert.strictEqual(charmData.levels[51].power, 458, 'Charm level 52 should preserve sourced AGGREDUCE power 458');
assert.strictEqual(charmData.levels[51].mp, 137, 'Charm level 52 MP should use sourced initial + consume total');
const charmPlayerTarget = creature({ id: 1000021, hp: 100, maxHp: 100, level: 20 });
const charm = skill({ selfId: 15, name: 'Charm', spell: true, power: 458, level: 52, distance: 600 });
const charmPlayerOutcome = SkillEffects.execute(session(), caster, charmPlayerTarget, charm, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(charmPlayerOutcome.aggroReduced, false, 'Charm should not apply AGGREDUCE to non-attackable targets');
assert.strictEqual(charmPlayerOutcome.effectResisted, true, 'Charm mob-only rejection should report effect resistance');
const charmMobTarget = creature({ id: 1000022, hp: 100, maxHp: 100, level: 20 });
charmMobTarget.fetchAttackable = () => true;
const charmMobOutcome = SkillEffects.execute(session(), caster, charmMobTarget, charm, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(charm.fetchSkillType(), C4SkillRules.AGGRO_REDUCE, 'Charm should preserve sourced AGGREDUCE semantics');
assert.strictEqual(charm.fetchTargetKind(), 'enemy', 'Charm should preserve sourced TARGET_ONE offensive semantics');
assert.strictEqual(charm.fetchSemantic().trait, 'derangement', 'Charm should preserve sourced AGGREDUCE derangement semantics');
assert.strictEqual(charm.fetchSemantic().mobOnly, true, 'Charm should preserve sourced monster-only AGGREDUCE handler semantics');
assert.strictEqual(charmMobOutcome.damage, 0, 'Charm should not be routed as damage');
assert.strictEqual(charmMobOutcome.aggroReduced, true, 'Charm should mark a successful sourced AGGREDUCE outcome');
assert.strictEqual(charmMobOutcome.aggroReduction, 458, 'Charm should preserve sourced AGGREDUCE power as hate reduction amount');

const mortalBlowData = activeSkills.find((entry) => entry.selfId === 16);
assert(mortalBlowData, 'Mortal Blow should be present in active skills data');
assert.strictEqual(mortalBlowData.template.distance, 40, 'Mortal Blow should preserve sourced castRange 40');
assert.strictEqual(mortalBlowData.time.hitTime, 1080, 'Mortal Blow should preserve sourced hitTime 1080');
assert.strictEqual(mortalBlowData.time.reuse, 11000, 'Mortal Blow should preserve sourced reuseDelay 11000');
assert.strictEqual(mortalBlowData.levels.length, 24, 'Mortal Blow should preserve sourced 24 base levels');
assert.strictEqual(mortalBlowData.levels[0].mp, 9, 'Mortal Blow level 1 MP should use sourced mpConsume 9');
assert.strictEqual(mortalBlowData.levels[23].power, 977, 'Mortal Blow level 24 should preserve sourced BLOW power 977');
assert.strictEqual(mortalBlowData.levels[23].mp, 34, 'Mortal Blow level 24 MP should use sourced mpConsume 34');
const mortalBlowTarget = creature({ id: 1000023, hp: 100, maxHp: 100, level: 20 });
const mortalBlow = skill({ selfId: 16, name: 'Mortal Blow', spell: false, power: 977, level: 24, distance: 40 });
const mortalBlowOutcome = SkillEffects.execute(session(), caster, mortalBlowTarget, mortalBlow, {
    magicSkill: false,
    rng: () => 0,
    attack: {
        clearLoadedShot() {},
        prepareSkillDamage: () => 201
    }
});
assert.strictEqual(mortalBlow.fetchSkillType(), C4SkillRules.BLOW, 'Mortal Blow should preserve sourced BLOW semantics');
assert.strictEqual(mortalBlow.fetchTargetKind(), 'enemy', 'Mortal Blow should preserve sourced TARGET_ONE offensive semantics');
assert.strictEqual(mortalBlow.fetchSemantic().blowChance, 50, 'Mortal Blow should preserve sourced/default 50 blow chance semantics');
assert.deepStrictEqual(mortalBlow.fetchSemantic().requires, { weaponsAllowed: 16, condition: 16 }, 'Mortal Blow should preserve sourced dagger and positional requirements');
assert.strictEqual(mortalBlowOutcome.damage, 201, 'Mortal Blow should keep its blow damage component on a successful blow roll');
assert.strictEqual(mortalBlowOutcome.missed, false, 'Mortal Blow should not miss when the sourced blow roll succeeds');

const forceBusterData = activeSkills.find((entry) => entry.selfId === 17);
assert(forceBusterData, 'Force Buster should be present in active skills data');
assert.strictEqual(forceBusterData.template.distance, 40, 'Force Buster should preserve sourced castRange 40');
assert.strictEqual(forceBusterData.time.hitTime, 783, 'Force Buster should preserve sourced hitTime 783');
assert.strictEqual(forceBusterData.time.reuse, 10000, 'Force Buster should preserve sourced reuseDelay 10000');
assert.strictEqual(forceBusterData.levels.length, 34, 'Force Buster should preserve sourced 34 base levels');
assert.strictEqual(forceBusterData.levels[17].power, 305, 'Force Buster level 18 should preserve existing sourced CHARGEDAM power 305');
assert.strictEqual(forceBusterData.levels[33].power, 533, 'Force Buster level 34 should preserve sourced CHARGEDAM power 533');
assert.strictEqual(forceBusterData.levels[33].mp, 116, 'Force Buster level 34 MP should use sourced mpConsume 116');
const forceBusterTarget = creature({ id: 1000024, hp: 100, maxHp: 100, level: 20 });
const forceBuster = skill({ selfId: 17, name: 'Force Buster', spell: false, power: 533, level: 34, distance: 40 });
const forceBusterOutcome = SkillEffects.execute(session(), caster, forceBusterTarget, forceBuster, {
    magicSkill: false,
    rng: () => 0,
    attack: {
        clearLoadedShot() {},
        prepareSkillDamage: () => 212
    }
});
assert.strictEqual(forceBuster.fetchSkillType(), C4SkillRules.DAMAGE, 'Force Buster should execute as damage while preserving sourced CHARGEDAM metadata');
assert.strictEqual(forceBuster.fetchTargetKind(), 'enemy', 'Force Buster should remain executable against selected enemies');
assert.strictEqual(forceBuster.fetchSemantic().sourceTarget, 'front_area', 'Force Buster should preserve sourced TARGET_FRONT_AREA semantics');
assert.strictEqual(forceBuster.fetchSemantic().radius, 200, 'Force Buster should preserve sourced skillRadius 200');
assert.deepStrictEqual(forceBuster.fetchSemantic().requires, { weaponsAllowed: 1024, charges: 1, condition: 128, conditionValue: 1 }, 'Force Buster should preserve sourced fist and charge requirements');
assert.strictEqual(forceBusterOutcome.damage, 212, 'Force Buster should keep its physical damage component');
assert.strictEqual(forceBusterOutcome.effect, null, 'Force Buster should remain a pure damage skill without a debuff');

const forceStormData = activeSkills.find((entry) => entry.selfId === 35);
assert(forceStormData, 'Force Storm should be present in active skills data');
assert.strictEqual(forceStormData.template.distance, 500, 'Force Storm should preserve sourced castRange 500');
assert.strictEqual(forceStormData.time.hitTime, 2000, 'Force Storm should preserve sourced hitTime 2000');
assert.strictEqual(forceStormData.time.reuse, 20000, 'Force Storm should preserve sourced reuseDelay 20000');
assert.strictEqual(forceStormData.levels.length, 28, 'Force Storm should preserve sourced 28 base levels');
assert.strictEqual(forceStormData.levels[11].power, 305, 'Force Storm level 12 should preserve existing sourced CHARGEDAM power 305');
assert.strictEqual(forceStormData.levels[27].power, 533, 'Force Storm level 28 should preserve sourced CHARGEDAM power 533');
assert.strictEqual(forceStormData.levels[27].mp, 116, 'Force Storm level 28 MP should use sourced mpConsume 116');
const forceStormTarget = creature({ id: 1000032, hp: 100, maxHp: 100, level: 20 });
const forceStorm = skill({ selfId: 35, name: 'Force Storm', spell: false, power: 533, level: 28, distance: 500 });
const forceStormOutcome = SkillEffects.execute(session(), caster, forceStormTarget, forceStorm, {
    magicSkill: false,
    rng: () => 0,
    attack: {
        clearLoadedShot() {},
        prepareSkillDamage: () => 232
    }
});
assert.strictEqual(forceStorm.fetchSkillType(), C4SkillRules.DAMAGE, 'Force Storm should execute as damage while preserving sourced CHARGEDAM metadata');
assert.strictEqual(forceStorm.fetchTargetKind(), 'enemy', 'Force Storm should remain executable against selected enemies');
assert.strictEqual(forceStorm.fetchSsBoost(), 1, 'Force Storm should preserve sourced physical shot boost semantics');
assert.strictEqual(forceStorm.fetchSemantic().sourceTarget, 'area', 'Force Storm should preserve sourced TARGET_AREA semantics');
assert.strictEqual(forceStorm.fetchSemantic().radius, 150, 'Force Storm should preserve sourced skillRadius 150');
assert.deepStrictEqual(forceStorm.fetchSemantic().requires, { weaponsAllowed: 1024, charges: 1, condition: 128, conditionValue: 1 }, 'Force Storm should preserve sourced fist and charge requirements');
assert.strictEqual(forceStormOutcome.damage, 232, 'Force Storm should keep its physical damage component');
assert.strictEqual(forceStormOutcome.effect, null, 'Force Storm should remain a pure damage skill without a debuff');

const whirlwindData = activeSkills.find((entry) => entry.selfId === 36);
assert(whirlwindData, 'Whirlwind should be present in active skills data');
assert.strictEqual(whirlwindData.template.distance, -1, 'Whirlwind should preserve sourced TARGET_AURA self-centered range');
assert.strictEqual(whirlwindData.time.hitTime, 1067, 'Whirlwind should preserve sourced hitTime 1067');
assert.strictEqual(whirlwindData.time.reuse, 17000, 'Whirlwind should preserve sourced reuseDelay 17000');
assert.strictEqual(whirlwindData.levels.length, 37, 'Whirlwind should preserve sourced 37 base levels');
assert.strictEqual(whirlwindData.levels[20].power, 1046, 'Whirlwind level 21 should preserve existing sourced PDAM power 1046');
assert.strictEqual(whirlwindData.levels[36].power, 1827, 'Whirlwind level 37 should preserve sourced PDAM power 1827');
assert.strictEqual(whirlwindData.levels[36].mp, 83, 'Whirlwind level 37 MP should use sourced mpConsume 83');
const whirlwindTarget = creature({ id: 1000033, hp: 100, maxHp: 100, level: 20 });
const whirlwind = skill({ selfId: 36, name: 'Whirlwind', spell: false, power: 1827, level: 37, distance: -1 });
const whirlwindOutcome = SkillEffects.execute(session(), caster, whirlwindTarget, whirlwind, {
    magicSkill: false,
    rng: () => 0,
    attack: {
        clearLoadedShot() {},
        prepareSkillDamage: () => 242
    }
});
assert.strictEqual(whirlwind.fetchSkillType(), C4SkillRules.DAMAGE, 'Whirlwind should resolve as sourced PDAM');
assert.strictEqual(whirlwind.fetchTargetKind(), 'enemy', 'Whirlwind should remain executable against enemies in the sourced aura');
assert.strictEqual(whirlwind.fetchSsBoost(), 1, 'Whirlwind should preserve sourced physical shot boost semantics');
assert.strictEqual(whirlwind.fetchSemantic().sourceTarget, 'aura', 'Whirlwind should preserve sourced TARGET_AURA semantics');
assert.strictEqual(whirlwind.fetchSemantic().radius, 150, 'Whirlwind should preserve sourced skillRadius 150');
assert.strictEqual(whirlwind.fetchSemantic().overHit, true, 'Whirlwind should preserve sourced overHit metadata');
assert.deepStrictEqual(whirlwind.fetchSemantic().requires, { weaponsAllowed: 64 }, 'Whirlwind should preserve sourced pole weapon requirement');
assert.strictEqual(whirlwindOutcome.damage, 242, 'Whirlwind should keep its physical damage component');
assert.strictEqual(whirlwindOutcome.effect, null, 'Whirlwind should remain a pure damage skill without a debuff');

const sweeperData = activeSkills.find((entry) => entry.selfId === 42);
assert(sweeperData, 'Sweeper should be present in active skills data');
assert.strictEqual(sweeperData.template.distance, 20, 'Sweeper should preserve sourced castRange 20');
assert.strictEqual(sweeperData.time.hitTime, 500, 'Sweeper should preserve sourced hitTime 500');
assert.strictEqual(sweeperData.time.reuse, 500, 'Sweeper should preserve sourced reuseDelay 500');
assert.strictEqual(sweeperData.levels.length, 1, 'Sweeper should preserve sourced single base level');
assert.strictEqual(sweeperData.levels[0].mp, 3, 'Sweeper level 1 MP should use sourced mpConsume 3');
const sweeper = skill({ selfId: 42, name: 'Sweeper', spell: false, power: 1, level: 1, distance: 20 });
assert.strictEqual(sweeper.fetchSkillType(), C4SkillRules.SWEEP, 'Sweeper should preserve sourced SWEEP semantics');
assert.strictEqual(sweeper.fetchTargetKind(), 'corpse_mob', 'Sweeper should preserve sourced TARGET_CORPSE_MOB semantics');
assert.strictEqual(sweeper.fetchSsBoost(), 0, 'Sweeper should not consume offensive shot boost semantics');
assert.strictEqual(sweeper.fetchSemantic().castRange, 20, 'Sweeper should preserve sourced castRange metadata');
assert.strictEqual(sweeper.fetchSemantic().effectRange, 400, 'Sweeper should preserve sourced effectRange metadata');

const hateAuraData = activeSkills.find((entry) => entry.selfId === 18);
assert(hateAuraData, 'Hate Aura should be present in active skills data');
assert.strictEqual(hateAuraData.template.distance, -1, 'Hate Aura should preserve sourced TARGET_AURA self-centered range');
assert.strictEqual(hateAuraData.time.hitTime, 1200, 'Hate Aura should preserve sourced hitTime 1200');
assert.strictEqual(hateAuraData.time.reuse, 3000, 'Hate Aura should preserve sourced reuseDelay 3000');
assert.strictEqual(hateAuraData.levels.length, 37, 'Hate Aura should preserve sourced 37 base levels');
assert.strictEqual(hateAuraData.levels[20].power, 1647, 'Hate Aura level 21 should preserve existing sourced AGGDAMAGE power 1647');
assert.strictEqual(hateAuraData.levels[36].power, 1963, 'Hate Aura level 37 should preserve sourced AGGDAMAGE power 1963');
assert.strictEqual(hateAuraData.levels[36].mp, 102, 'Hate Aura level 37 MP should use sourced mpConsume 102');
const hateAuraTarget = creature({ id: 1000025, hp: 100, maxHp: 100, level: 20 });
hateAuraTarget.fetchAttackable = () => true;
const hateAura = skill({ selfId: 18, name: 'Hate Aura', spell: false, power: 1963, level: 37, distance: -1 });
const hateAuraOutcome = SkillEffects.execute(session(), caster, hateAuraTarget, hateAura, {
    magicSkill: false,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(hateAura.fetchSkillType(), C4SkillRules.AGGRO_DAMAGE, 'Hate Aura should preserve sourced AGGDAMAGE semantics');
assert.strictEqual(hateAura.fetchTargetKind(), 'enemy', 'Hate Aura should remain executable against enemies in its aura');
assert.strictEqual(hateAura.fetchSemantic().sourceTarget, 'aura', 'Hate Aura should preserve sourced TARGET_AURA semantics');
assert.strictEqual(hateAura.fetchSemantic().radius, 200, 'Hate Aura should preserve sourced skillRadius 200');
assert.strictEqual(hateAuraOutcome.damage, 0, 'Hate Aura should not be routed as HP damage');
assert.strictEqual(hateAuraOutcome.aggroDamage, Math.floor((150 * 1963) / (20 + 7)), 'Hate Aura should use sourced Lisvus AGGDAMAGE hate formula');

const aggressionData = activeSkills.find((entry) => entry.selfId === 28);
assert(aggressionData, 'Aggression should be present in active skills data');
assert.strictEqual(aggressionData.template.name, 'Aggression', 'Aggression should preserve sourced skill name');
assert.strictEqual(aggressionData.template.distance, 400, 'Aggression should preserve sourced level 1 castRange 400 in current active format');
assert.strictEqual(aggressionData.time.hitTime, 1000, 'Aggression should preserve sourced hitTime 1000');
assert.strictEqual(aggressionData.time.reuse, 3000, 'Aggression should preserve sourced reuseDelay 3000');
assert.strictEqual(aggressionData.levels.length, 49, 'Aggression should preserve sourced 49 base levels');
assert.strictEqual(aggressionData.levels[1].power, 679, 'Aggression level 2 should preserve sourced AGGDAMAGE power 679');
assert.strictEqual(aggressionData.levels[32].power, 1647, 'Aggression level 33 should preserve existing sourced AGGDAMAGE power 1647');
assert.strictEqual(aggressionData.levels[48].power, 1963, 'Aggression level 49 should preserve sourced AGGDAMAGE power 1963');
assert.strictEqual(aggressionData.levels[48].mp, 68, 'Aggression level 49 MP should use sourced mpConsume 68');
const aggressionTarget = creature({ id: 1000028, hp: 100, maxHp: 100, level: 20 });
aggressionTarget.fetchAttackable = () => true;
const aggression = skill({ selfId: 28, name: 'Aggression', spell: false, power: 1963, level: 49, distance: 400 });
const aggressionOutcome = SkillEffects.execute(session(), caster, aggressionTarget, aggression, {
    magicSkill: false,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(aggression.fetchSkillType(), C4SkillRules.AGGRO_DAMAGE, 'Aggression should preserve sourced AGGDAMAGE semantics');
assert.strictEqual(aggression.fetchTargetKind(), 'enemy', 'Aggression should preserve sourced TARGET_ONE offensive semantics');
assert.strictEqual(aggression.fetchSsBoost(), 0, 'Aggression should not consume offensive shot boost semantics');
assert.strictEqual(aggression.fetchSemantic().castRange, 800, 'Aggression level 49 should preserve sourced castRange table metadata');
assert.strictEqual(aggression.fetchSemantic().effectRange, 1300, 'Aggression level 49 should preserve sourced effectRange table metadata');
assert.strictEqual(aggressionOutcome.damage, 0, 'Aggression should not be routed as HP damage');
assert.strictEqual(aggressionOutcome.aggroDamage, Math.floor((150 * 1963) / (20 + 7)), 'Aggression should use sourced Lisvus AGGDAMAGE hate formula');

const lureData = activeSkills.find((entry) => entry.selfId === 51);
assert(lureData, 'Lure should be present in active skills data');
assert.strictEqual(lureData.template.distance, 400, 'Lure should preserve sourced castRange 400');
assert.strictEqual(lureData.time.hitTime, 1500, 'Lure should preserve sourced hitTime 1500');
assert.strictEqual(lureData.time.reuse, 10000, 'Lure should preserve sourced reuseDelay 10000');
assert.strictEqual(lureData.levels.length, 1, 'Lure should preserve sourced single base level');
assert.strictEqual(lureData.levels[0].power, 500, 'Lure level 1 should preserve sourced AGGDAMAGE power 500');
assert.strictEqual(lureData.levels[0].mp, 44, 'Lure level 1 MP should use sourced mpConsume 44');
const lureTarget = creature({ id: 1000051, hp: 100, maxHp: 100, level: 20 });
lureTarget.fetchAttackable = () => true;
const lure = skill({ selfId: 51, name: 'Lure', spell: false, power: 500, level: 1, distance: 400 });
const lureOutcome = SkillEffects.execute(session(), caster, lureTarget, lure, {
    magicSkill: false,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(lure.fetchSkillType(), C4SkillRules.AGGRO_DAMAGE, 'Lure should preserve sourced AGGDAMAGE semantics');
assert.strictEqual(lure.fetchTargetKind(), 'enemy', 'Lure should preserve sourced TARGET_ONE offensive semantics');
assert.strictEqual(lure.fetchSsBoost(), 0, 'Lure should not consume offensive shot boost semantics');
assert.strictEqual(lure.fetchSemantic().castRange, 400, 'Lure should preserve sourced castRange metadata');
assert.strictEqual(lure.fetchSemantic().effectRange, 900, 'Lure should preserve sourced effectRange metadata');
assert.strictEqual(lureOutcome.damage, 0, 'Lure should not be routed as HP damage');
assert.strictEqual(lureOutcome.aggroDamage, Math.floor((150 * 500) / (20 + 7)), 'Lure should use sourced Lisvus AGGDAMAGE hate formula');

const forceBlasterData = activeSkills.find((entry) => entry.selfId === 54);
assert(forceBlasterData, 'Force Blaster should be present in active skills data');
assert.strictEqual(forceBlasterData.template.distance, 600, 'Force Blaster should preserve sourced castRange 600');
assert.strictEqual(forceBlasterData.time.hitTime, 1900, 'Force Blaster should preserve sourced hitTime 1900');
assert.strictEqual(forceBlasterData.time.reuse, 15000, 'Force Blaster should preserve sourced reuseDelay 15000');
assert.strictEqual(forceBlasterData.levels.length, 49, 'Force Blaster should preserve sourced 49 base levels');
assert.strictEqual(forceBlasterData.levels[32].power, 1220, 'Force Blaster level 33 should preserve existing sourced CHARGEDAM power 1220');
assert.strictEqual(forceBlasterData.levels[48].power, 2131, 'Force Blaster level 49 should preserve sourced CHARGEDAM power 2131');
assert.strictEqual(forceBlasterData.levels[48].mp, 68, 'Force Blaster level 49 MP should use sourced mpConsume 68');
const forceBlasterTarget = creature({ id: 1000054, hp: 100, maxHp: 100, level: 20 });
const forceBlaster = skill({ selfId: 54, name: 'Force Blaster', spell: false, power: 2131, level: 49, distance: 600 });
const forceBlasterOutcome = SkillEffects.execute(session(), caster, forceBlasterTarget, forceBlaster, {
    magicSkill: false,
    rng: () => 0,
    attack: {
        clearLoadedShot() {},
        prepareSkillDamage: () => 254
    }
});
assert.strictEqual(forceBlaster.fetchSkillType(), C4SkillRules.DAMAGE, 'Force Blaster should execute as damage while preserving sourced CHARGEDAM metadata');
assert.strictEqual(forceBlaster.fetchTargetKind(), 'enemy', 'Force Blaster should preserve sourced TARGET_ONE offensive semantics');
assert.strictEqual(forceBlaster.fetchSsBoost(), 1, 'Force Blaster should preserve sourced physical shot boost semantics');
assert.deepStrictEqual(forceBlaster.fetchSemantic().requires, { weaponsAllowed: 1024, charges: 1, condition: 128, conditionValue: 1 }, 'Force Blaster should preserve sourced fist and charge requirements');
assert.strictEqual(forceBlaster.fetchSemantic().castRange, 600, 'Force Blaster should preserve sourced castRange metadata');
assert.strictEqual(forceBlaster.fetchSemantic().effectRange, 1100, 'Force Blaster should preserve sourced effectRange metadata');
assert.strictEqual(forceBlasterOutcome.damage, 254, 'Force Blaster should keep its physical damage component');
assert.strictEqual(forceBlasterOutcome.effect, null, 'Force Blaster should remain a pure damage skill without a debuff');

const powerShotData = activeSkills.find((entry) => entry.selfId === 56);
assert(powerShotData, 'Power Shot should be present in active skills data');
assert.strictEqual(powerShotData.template.distance, 700, 'Power Shot should preserve sourced castRange 700');
assert.strictEqual(powerShotData.time.hitTime, 3200, 'Power Shot should preserve sourced hitTime 3200');
assert.strictEqual(powerShotData.time.reuse, 25000, 'Power Shot should preserve sourced reuseDelay 25000');
assert.strictEqual(powerShotData.levels.length, 24, 'Power Shot should preserve sourced 24 base levels');
assert.strictEqual(powerShotData.levels[0].power, 65, 'Power Shot level 1 should preserve sourced PDAM power 65');
assert.strictEqual(powerShotData.levels[23].power, 865, 'Power Shot level 24 should preserve sourced PDAM power 865');
assert.strictEqual(powerShotData.levels[23].mp, 74, 'Power Shot level 24 MP should use sourced mpConsume 74');
const powerShotTarget = creature({ id: 1000056, hp: 100, maxHp: 100, level: 20 });
const powerShot = skill({ selfId: 56, name: 'Power Shot', spell: false, power: 865, level: 24, distance: 700 });
const powerShotOutcome = SkillEffects.execute(session(), caster, powerShotTarget, powerShot, {
    magicSkill: false,
    rng: () => 0,
    attack: {
        clearLoadedShot() {},
        prepareSkillDamage: () => 265
    }
});
assert.strictEqual(powerShot.fetchSkillType(), C4SkillRules.DAMAGE, 'Power Shot should resolve as sourced PDAM');
assert.strictEqual(powerShot.fetchTargetKind(), 'enemy', 'Power Shot should preserve sourced TARGET_ONE offensive semantics');
assert.strictEqual(powerShot.fetchSsBoost(), 1, 'Power Shot should preserve sourced physical shot boost semantics');
assert.strictEqual(powerShot.fetchSemantic().trait, 'bow', 'Power Shot should preserve sourced bow damage semantics');
assert.strictEqual(powerShot.fetchSemantic().overHit, true, 'Power Shot should preserve sourced overHit metadata');
assert.deepStrictEqual(powerShot.fetchSemantic().requires, { weaponsAllowed: 32 }, 'Power Shot should preserve sourced bow weapon requirement');
assert.strictEqual(powerShot.fetchSemantic().castRange, 700, 'Power Shot should preserve sourced castRange metadata');
assert.strictEqual(powerShot.fetchSemantic().effectRange, 1200, 'Power Shot should preserve sourced effectRange metadata');
assert.strictEqual(powerShotOutcome.damage, 265, 'Power Shot should keep its physical damage component');
assert.strictEqual(powerShotOutcome.effect, null, 'Power Shot should remain a pure damage skill without a debuff');

const punchOfDoomData = activeSkills.find((entry) => entry.selfId === 81);
assert(punchOfDoomData, 'Punch of Doom should be present in active skills data');
assert.strictEqual(punchOfDoomData.template.name, 'Punch of Doom', 'Punch of Doom should preserve sourced name for skill id 81');
assert.strictEqual(punchOfDoomData.template.distance, 40, 'Punch of Doom should preserve sourced castRange 40');
assert.strictEqual(punchOfDoomData.time.hitTime, 1360, 'Punch of Doom should preserve sourced hitTime 1360');
assert.strictEqual(punchOfDoomData.time.reuse, 120000, 'Punch of Doom should preserve sourced reuseDelay 120000');
assert.strictEqual(punchOfDoomData.time.buff, 9000, 'Punch of Doom should preserve sourced StunSelf duration 9000ms');
assert.strictEqual(punchOfDoomData.levels.length, 3, 'Punch of Doom should preserve sourced 3 base levels');
assert.strictEqual(punchOfDoomData.levels[0].power, 4580, 'Punch of Doom level 1 should preserve sourced PDAM power 4580');
assert.strictEqual(punchOfDoomData.levels[2].power, 9132, 'Punch of Doom level 3 should preserve sourced PDAM power 9132');
assert.strictEqual(punchOfDoomData.levels[2].hp, 499, 'Punch of Doom level 3 should preserve sourced HP consume 499');
const punchCaster = creature({ id: 1000081, hp: 1000, maxHp: 1000 });
const punchTarget = creature({ id: 1000082, hp: 1000, maxHp: 1000 });
const punchOfDoom = skill({ selfId: 81, name: 'Punch of Doom', spell: false, power: 9132, level: 3, distance: 40, buff: 9000, hp: 499 });
const punchOutcome = SkillEffects.execute(session(), punchCaster, punchTarget, punchOfDoom, {
    magicSkill: false,
    rng: () => 0,
    attack: {
        clearLoadedShot() {},
        prepareSkillDamage: () => 913
    }
});
assert.strictEqual(punchOfDoom.fetchSkillType(), C4SkillRules.DAMAGE, 'Punch of Doom should resolve as sourced PDAM');
assert.strictEqual(punchOfDoom.fetchTargetKind(), 'enemy', 'Punch of Doom should preserve sourced TARGET_ONE offensive semantics');
assert.strictEqual(punchOfDoom.fetchSsBoost(), 1, 'Punch of Doom should preserve sourced physical shot boost semantics');
assert.strictEqual(punchOfDoom.fetchConsumedHp(), 499, 'Punch of Doom should preserve sourced HP consume on the skill model');
assert.strictEqual(punchOfDoom.fetchSemantic().levelDepend, 2, 'Punch of Doom should preserve sourced lvlDepend metadata');
assert.strictEqual(punchOfDoom.fetchSemantic().overHit, true, 'Punch of Doom should preserve sourced overHit metadata');
assert.deepStrictEqual(punchOfDoom.fetchSemantic().requires, { weaponsAllowed: 1024 }, 'Punch of Doom should preserve sourced fist weapon requirement');
assert.strictEqual(punchOfDoom.fetchSemantic().castRange, 40, 'Punch of Doom should preserve sourced castRange metadata');
assert.strictEqual(punchOfDoom.fetchSemantic().effectRange, 400, 'Punch of Doom should preserve sourced effectRange metadata');
assert.strictEqual(punchOutcome.damage, 913, 'Punch of Doom should keep its physical damage component');
assert.strictEqual(punchOutcome.effect, null, 'Punch of Doom should not stun the target');
assert.strictEqual(punchOutcome.selfEffect.key, 'stun', 'Punch of Doom should apply sourced StunSelf to caster');
assert(EffectStore.hasDebuff(punchCaster, 'stun'), 'Punch of Doom caster should receive the sourced self stun debuff');
assert.strictEqual(EffectStore.hasDebuff(punchTarget, 'stun'), false, 'Punch of Doom target should not receive StunSelf');

const ironPunchData = activeSkills.find((entry) => entry.selfId === 29);
assert(ironPunchData, 'Iron Punch should be present in active skills data');
assert.strictEqual(ironPunchData.template.distance, 40, 'Iron Punch should preserve sourced castRange 40');
assert.strictEqual(ironPunchData.time.hitTime, 1604, 'Iron Punch should preserve sourced hitTime 1604');
assert.strictEqual(ironPunchData.time.reuse, 15000, 'Iron Punch should preserve sourced reuseDelay 15000');
assert.strictEqual(ironPunchData.levels.length, 24, 'Iron Punch should preserve sourced 24 base levels');
assert.strictEqual(ironPunchData.levels[23].power, 380, 'Iron Punch level 24 should preserve sourced PDAM power 380');
assert.strictEqual(ironPunchData.levels[23].mp, 44, 'Iron Punch level 24 MP should use sourced mpConsume 44');
const ironPunchTarget = creature({ id: 1000029, hp: 100, maxHp: 100, level: 20 });
const ironPunch = skill({ selfId: 29, name: 'Iron Punch', spell: false, power: 380, level: 24, distance: 40 });
const ironPunchOutcome = SkillEffects.execute(session(), caster, ironPunchTarget, ironPunch, {
    magicSkill: false,
    rng: () => 0,
    attack: {
        clearLoadedShot() {},
        prepareSkillDamage: () => 122
    }
});
assert.strictEqual(ironPunch.fetchSkillType(), C4SkillRules.DAMAGE, 'Iron Punch should resolve as sourced PDAM');
assert.strictEqual(ironPunch.fetchTargetKind(), 'enemy', 'Iron Punch should preserve sourced TARGET_ONE offensive semantics');
assert.strictEqual(ironPunch.fetchSsBoost(), 1, 'Iron Punch should preserve sourced physical shot boost semantics');
assert.strictEqual(ironPunch.fetchSemantic().trait, 'physical', 'Iron Punch should preserve physical damage semantics');
assert.strictEqual(ironPunch.fetchSemantic().overHit, true, 'Iron Punch should preserve sourced overHit metadata');
assert.deepStrictEqual(ironPunch.fetchSemantic().requires, { weaponsAllowed: 1024 }, 'Iron Punch should preserve sourced fist weapon requirement');
assert.strictEqual(ironPunchOutcome.damage, 122, 'Iron Punch should keep its physical damage component');
assert.strictEqual(ironPunchOutcome.effect, null, 'Iron Punch should remain a pure damage skill without a debuff');

const backstabData = activeSkills.find((entry) => entry.selfId === 30);
assert(backstabData, 'Backstab should be present in active skills data');
assert.strictEqual(backstabData.template.distance, 40, 'Backstab should preserve sourced castRange 40');
assert.strictEqual(backstabData.time.hitTime, 1080, 'Backstab should preserve sourced hitTime 1080');
assert.strictEqual(backstabData.time.reuse, 11000, 'Backstab should preserve sourced reuseDelay 11000');
assert.strictEqual(backstabData.levels.length, 37, 'Backstab should preserve sourced 37 base levels');
assert.strictEqual(backstabData.levels[20].power, 3136, 'Backstab level 21 should preserve existing sourced BLOW power 3136');
assert.strictEqual(backstabData.levels[36].power, 5479, 'Backstab level 37 should preserve sourced BLOW power 5479');
assert.strictEqual(backstabData.levels[36].mp, 111, 'Backstab level 37 MP should use sourced mpConsume 111');
const backstabTarget = creature({ id: 1000030, hp: 1000, maxHp: 1000, level: 20 });
const backstab = skill({ selfId: 30, name: 'Backstab', spell: false, power: 5479, level: 37, distance: 40 });
const backstabOutcome = SkillEffects.execute(session(), caster, backstabTarget, backstab, {
    magicSkill: false,
    rng: () => 0.99,
    attack: {
        clearLoadedShot() {},
        isBehindTarget: () => true,
        prepareSkillDamage: () => 444
    }
});
assert.strictEqual(backstab.fetchSkillType(), C4SkillRules.BLOW, 'Backstab should preserve sourced BLOW semantics');
assert.strictEqual(backstab.fetchTargetKind(), 'enemy', 'Backstab should preserve sourced TARGET_ONE offensive semantics');
assert.strictEqual(backstab.fetchSsBoost(), 1, 'Backstab should preserve sourced physical shot boost semantics');
assert.strictEqual(backstab.fetchSemantic().blowChance, 70, 'Backstab should preserve sourced Lisvus behind chance metadata');
assert.deepStrictEqual(backstab.fetchSemantic().requires, { weaponsAllowed: 16, condition: 8 }, 'Backstab should preserve sourced dagger and behind-only requirement');
assert.strictEqual(backstabOutcome.damage, 444, 'Backstab should land from behind without an extra COND_CRIT roll');
assert.strictEqual(backstabOutcome.missed, false, 'Backstab should not miss when the sourced behind-only condition is satisfied');
const frontBackstabTarget = creature({ id: 1000031, hp: 1000, maxHp: 1000, level: 20 });
const frontBackstabOutcome = SkillEffects.execute(session(), caster, frontBackstabTarget, backstab, {
    magicSkill: false,
    rng: () => 0,
    attack: {
        clearLoadedShot() {},
        isBehindTarget: () => false,
        prepareSkillDamage: () => 555
    }
});
assert.strictEqual(frontBackstabOutcome.damage, 0, 'Backstab should not deal damage outside sourced behind-only condition');
assert.strictEqual(frontBackstabOutcome.missed, true, 'Backstab should miss when the sourced behind-only condition is not satisfied');

const doubleShotData = activeSkills.find((entry) => entry.selfId === 19);
assert(doubleShotData, 'Double Shot should be present in active skills data');
assert.strictEqual(doubleShotData.template.distance, 900, 'Double Shot should preserve sourced castRange 900');
assert.strictEqual(doubleShotData.time.hitTime, 3000, 'Double Shot should preserve sourced hitTime 3000');
assert.strictEqual(doubleShotData.time.reuse, 25000, 'Double Shot should preserve sourced reuseDelay 25000');
assert.strictEqual(doubleShotData.levels.length, 37, 'Double Shot should preserve sourced 37 base levels');
assert.strictEqual(doubleShotData.levels[20].power, 2788, 'Double Shot level 21 should preserve existing sourced PDAM power 2788');
assert.strictEqual(doubleShotData.levels[36].power, 4870, 'Double Shot level 37 should preserve sourced PDAM power 4870');
assert.strictEqual(doubleShotData.levels[36].mp, 166, 'Double Shot level 37 MP should use sourced mpConsume 166');
const doubleShotTarget = creature({ id: 1000026, hp: 100, maxHp: 100, level: 20 });
const doubleShot = skill({ selfId: 19, name: 'Double Shot', spell: false, power: 4870, level: 37, distance: 900 });
const doubleShotOutcome = SkillEffects.execute(session(), caster, doubleShotTarget, doubleShot, {
    magicSkill: false,
    rng: () => 0,
    attack: {
        clearLoadedShot() {},
        prepareSkillDamage: () => 333
    }
});
assert.strictEqual(doubleShot.fetchSkillType(), C4SkillRules.DAMAGE, 'Double Shot should resolve as sourced PDAM');
assert.strictEqual(doubleShot.fetchTargetKind(), 'enemy', 'Double Shot should preserve sourced TARGET_ONE offensive semantics');
assert.strictEqual(doubleShot.fetchSsBoost(), 1, 'Double Shot should preserve sourced physical shot boost semantics');
assert.strictEqual(doubleShot.fetchSemantic().trait, 'bow', 'Double Shot should preserve sourced bow damage semantics');
assert.strictEqual(doubleShot.fetchSemantic().overHit, true, 'Double Shot should preserve sourced overHit metadata');
assert.deepStrictEqual(doubleShot.fetchSemantic().requires, { weaponsAllowed: 32 }, 'Double Shot should preserve sourced bow weapon requirement');
assert.strictEqual(doubleShotOutcome.damage, 333, 'Double Shot should keep its physical damage component');
assert.strictEqual(doubleShotOutcome.effect, null, 'Double Shot should remain a pure damage skill without a debuff');

const burstShotData = activeSkills.find((entry) => entry.selfId === 24);
assert(burstShotData, 'Burst Shot should be present in active skills data');
assert.strictEqual(burstShotData.template.distance, 500, 'Burst Shot should preserve sourced castRange 500');
assert.strictEqual(burstShotData.time.hitTime, 3200, 'Burst Shot should preserve sourced hitTime 3200');
assert.strictEqual(burstShotData.time.reuse, 25000, 'Burst Shot should preserve sourced reuseDelay 25000');
assert.strictEqual(burstShotData.levels.length, 31, 'Burst Shot should preserve sourced 31 base levels');
assert.strictEqual(burstShotData.levels[14].power, 697, 'Burst Shot level 15 should preserve existing sourced PDAM power 697');
assert.strictEqual(burstShotData.levels[30].power, 1218, 'Burst Shot level 31 should preserve sourced PDAM power 1218');
assert.strictEqual(burstShotData.levels[30].mp, 249, 'Burst Shot level 31 MP should use sourced mpConsume 249');
const burstShotTarget = creature({ id: 1000027, hp: 100, maxHp: 100, level: 20 });
const burstShot = skill({ selfId: 24, name: 'Burst Shot', spell: false, power: 1218, level: 31, distance: 500 });
const burstShotOutcome = SkillEffects.execute(session(), caster, burstShotTarget, burstShot, {
    magicSkill: false,
    rng: () => 0,
    attack: {
        clearLoadedShot() {},
        prepareSkillDamage: () => 144
    }
});
assert.strictEqual(burstShot.fetchSkillType(), C4SkillRules.DAMAGE, 'Burst Shot should resolve as sourced PDAM');
assert.strictEqual(burstShot.fetchTargetKind(), 'enemy', 'Burst Shot should remain executable against selected enemies');
assert.strictEqual(burstShot.fetchSsBoost(), 1, 'Burst Shot should preserve sourced physical shot boost semantics');
assert.strictEqual(burstShot.fetchSemantic().sourceTarget, 'area', 'Burst Shot should preserve sourced TARGET_AREA semantics');
assert.strictEqual(burstShot.fetchSemantic().radius, 150, 'Burst Shot should preserve sourced skillRadius 150');
assert.strictEqual(burstShot.fetchSemantic().overHit, true, 'Burst Shot should preserve sourced overHit metadata');
assert.deepStrictEqual(burstShot.fetchSemantic().requires, { weaponsAllowed: 32 }, 'Burst Shot should preserve sourced bow weapon requirement');
assert.strictEqual(burstShotOutcome.damage, 144, 'Burst Shot should keep its physical damage component');
assert.strictEqual(burstShotOutcome.effect, null, 'Burst Shot should remain a pure damage skill without a debuff');

const lightningStrikeData = activeSkills.find((entry) => entry.selfId === 279);
assert(lightningStrikeData, 'Lightning Strike should be present in active skills data');
assert.strictEqual(lightningStrikeData.template.name, 'Lightning Strike', 'Lightning Strike should preserve sourced skill name');
assert.strictEqual(lightningStrikeData.template.distance, 400, 'Lightning Strike should preserve sourced castRange 400');
assert.strictEqual(lightningStrikeData.time.hitTime, 3000, 'Lightning Strike should preserve sourced hitTime 3000');
assert.strictEqual(lightningStrikeData.time.reuse, 120000, 'Lightning Strike should preserve sourced reuseDelay 120000');
assert.strictEqual(lightningStrikeData.time.buff, 120000, 'Lightning Strike should preserve sourced 120 second paralyze duration');
assert.strictEqual(lightningStrikeData.levels.length, 5, 'Lightning Strike should preserve sourced 5 base levels');
assert.strictEqual(lightningStrikeData.levels[0].power, 82, 'Lightning Strike level 1 should preserve sourced MDAM power 82');
assert.strictEqual(lightningStrikeData.levels[4].power, 108, 'Lightning Strike level 5 should preserve sourced MDAM power 108');
assert.strictEqual(lightningStrikeData.levels[4].mp, 69, 'Lightning Strike level 5 MP should use sourced initial + consume total');
const lightningStrikeTarget = creature({ id: 1000012, hp: 100, maxHp: 100, level: 20 });
const lightningStrike = skill({ selfId: 279, name: 'Lightning Strike', spell: true, power: 108, level: 5, buff: 120000, distance: 400 });
const lightningStrikeOutcome = SkillEffects.execute(session(), caster, lightningStrikeTarget, lightningStrike, {
    magicSkill: true,
    rng: () => 0,
    attack: {
        clearLoadedShot() {},
        prepareSkillDamage: () => 77
    }
});
assert.strictEqual(lightningStrike.fetchSkillType(), C4SkillRules.DAMAGE_EFFECT, 'Lightning Strike should resolve as sourced MDAM plus Paralyze');
assert.strictEqual(lightningStrike.fetchTargetKind(), 'enemy', 'Lightning Strike should preserve sourced TARGET_ONE offensive semantics');
assert.strictEqual(lightningStrike.fetchSsBoost(), 1, 'Lightning Strike should preserve sourced magic shot boost semantics');
assert.strictEqual(lightningStrike.fetchSemantic().baseLandRate, 40, 'Lightning Strike should use sourced effectPower 40 as paralyze land rate');
assert.strictEqual(lightningStrike.fetchSemantic().levelDepend, 1, 'Lightning Strike should preserve sourced lvlDepend 1');
assert.strictEqual(lightningStrikeOutcome.damage, 77, 'Lightning Strike should keep its magic damage component');
assert.strictEqual(lightningStrikeOutcome.effect.key, 'paralyze', 'Lightning Strike should apply sourced Paralyze');
assert.strictEqual(EffectRestrictions.canMove(lightningStrikeTarget), false, 'Lightning Strike paralyze should block movement');
assert.strictEqual(EffectRestrictions.canCast(lightningStrikeTarget), false, 'Lightning Strike paralyze should block casting');
EffectStore.remove(lightningStrikeTarget, 'paralyze');

const burningFistData = activeSkills.find((entry) => entry.selfId === 280);
assert(burningFistData, 'Burning Fist should be present in active skills data');
assert.strictEqual(burningFistData.template.distance, 40, 'Burning Fist should preserve sourced castRange 40');
assert.strictEqual(burningFistData.time.hitTime, 1900, 'Burning Fist should preserve sourced hitTime 1900');
assert.strictEqual(burningFistData.time.reuse, 15000, 'Burning Fist should preserve sourced reuseDelay 15000');
assert.strictEqual(burningFistData.levels.length, 37, 'Burning Fist should preserve sourced 37 base levels');
assert.strictEqual(burningFistData.levels[20].power, 1220, 'Burning Fist level 21 should preserve existing sourced PDAM power 1220');
assert.strictEqual(burningFistData.levels[36].power, 2131, 'Burning Fist level 37 should preserve sourced PDAM power 2131');
assert.strictEqual(burningFistData.levels[36].mp, 97, 'Burning Fist level 37 MP should use sourced mpConsume 97');
const burningFistTarget = creature({ id: 1000010, hp: 100, maxHp: 100, level: 20 });
const burningFist = skill({ selfId: 280, name: 'Burning Fist', spell: false, power: 2131, level: 37, distance: 40 });
const burningFistOutcome = SkillEffects.execute(session(), caster, burningFistTarget, burningFist, {
    magicSkill: false,
    rng: () => 0,
    attack: {
        clearLoadedShot() {},
        prepareSkillDamage: () => 123
    }
});
assert.strictEqual(burningFist.fetchSkillType(), C4SkillRules.DAMAGE, 'Burning Fist should resolve as sourced PDAM');
assert.strictEqual(burningFist.fetchTargetKind(), 'enemy', 'Burning Fist should preserve sourced TARGET_ONE offensive semantics');
assert.strictEqual(burningFist.fetchSsBoost(), 1, 'Burning Fist should preserve sourced physical shot boost semantics');
assert.strictEqual(burningFist.fetchSemantic().trait, 'fire', 'Burning Fist should preserve sourced fire element semantics');
assert.deepStrictEqual(burningFist.fetchSemantic().requires, { weaponsAllowed: 1024 }, 'Burning Fist should preserve sourced weaponsAllowed requirement');
assert.strictEqual(burningFistOutcome.damage, 123, 'Burning Fist should keep its physical damage component');
assert.strictEqual(burningFistOutcome.effect, null, 'Burning Fist should remain a pure damage skill without a debuff');

const hurricaneAssaultData = activeSkills.find((entry) => entry.selfId === 284);
assert(hurricaneAssaultData, 'Hurricane Assault should be present in active skills data');
assert.strictEqual(hurricaneAssaultData.template.distance, 40, 'Hurricane Assault should preserve sourced castRange 40');
assert.strictEqual(hurricaneAssaultData.time.hitTime, 1360, 'Hurricane Assault should preserve sourced hitTime 1360');
assert.strictEqual(hurricaneAssaultData.time.reuse, 17000, 'Hurricane Assault should preserve sourced reuseDelay 17000');
assert.strictEqual(hurricaneAssaultData.levels.length, 40, 'Hurricane Assault should preserve sourced 40 base levels');
assert.strictEqual(hurricaneAssaultData.levels[23].power, 1830, 'Hurricane Assault level 24 should preserve existing sourced CHARGEDAM power 1830');
assert.strictEqual(hurricaneAssaultData.levels[39].power, 3196, 'Hurricane Assault level 40 should preserve sourced CHARGEDAM power 3196');
assert.strictEqual(hurricaneAssaultData.levels[39].mp, 116, 'Hurricane Assault level 40 MP should use sourced mpConsume 116');
const hurricaneAssaultTarget = creature({ id: 1000011, hp: 100, maxHp: 100, level: 20 });
const hurricaneAssault = skill({ selfId: 284, name: 'Hurricane Assault', spell: false, power: 3196, level: 40, distance: 40 });
const hurricaneAssaultOutcome = SkillEffects.execute(session(), caster, hurricaneAssaultTarget, hurricaneAssault, {
    magicSkill: false,
    rng: () => 0,
    attack: {
        clearLoadedShot() {},
        prepareSkillDamage: () => 134
    }
});
assert.strictEqual(hurricaneAssault.fetchSkillType(), C4SkillRules.DAMAGE, 'Hurricane Assault should execute as damage while preserving sourced CHARGEDAM metadata');
assert.strictEqual(hurricaneAssault.fetchTargetKind(), 'enemy', 'Hurricane Assault should preserve sourced TARGET_ONE offensive semantics');
assert.strictEqual(hurricaneAssault.fetchSsBoost(), 1, 'Hurricane Assault should preserve sourced physical shot boost semantics');
assert.strictEqual(hurricaneAssault.fetchSemantic().trait, 'wind', 'Hurricane Assault should preserve sourced wind element semantics');
assert.deepStrictEqual(hurricaneAssault.fetchSemantic().requires, { weaponsAllowed: 1024, charges: 2, condition: 128, conditionValue: 2 }, 'Hurricane Assault should preserve sourced fist and charge requirements');
assert.strictEqual(hurricaneAssaultOutcome.damage, 134, 'Hurricane Assault should keep its physical damage component');
assert.strictEqual(hurricaneAssaultOutcome.effect, null, 'Hurricane Assault should remain a pure damage skill without a debuff');

const soulBreakerData = activeSkills.find((entry) => entry.selfId === 281);
assert(soulBreakerData, 'Soul Breaker should be present in active skills data');
assert.strictEqual(soulBreakerData.template.distance, 40, 'Soul Breaker should preserve sourced castRange 40');
assert.strictEqual(soulBreakerData.time.hitTime, 1360, 'Soul Breaker should preserve the sourced initial hitTime 1360');
assert.strictEqual(soulBreakerData.time.buff, 9000, 'Soul Breaker should preserve sourced 9 second stun duration');
assert.strictEqual(soulBreakerData.levels.length, 37, 'Soul Breaker should preserve sourced 37 base levels');
assert.strictEqual(soulBreakerData.levels[20].power, 407, 'Soul Breaker level 21 should preserve existing sourced PDAM power 407');
assert.strictEqual(soulBreakerData.levels[36].power, 711, 'Soul Breaker level 37 should preserve sourced PDAM power 711');
assert.strictEqual(soulBreakerData.levels[36].mp, 83, 'Soul Breaker level 37 MP should use sourced mpConsume 83');
const soulBreakerTarget = creature({ id: 1000009, hp: 100, maxHp: 100, level: 20 });
const soulBreaker = skill({ selfId: 281, name: 'Soul Breaker', spell: false, power: 711, level: 37, buff: 9000, distance: 40 });
const soulBreakerOutcome = SkillEffects.execute(session(), caster, soulBreakerTarget, soulBreaker, {
    magicSkill: false,
    rng: () => 0,
    attack: {
        clearLoadedShot() {},
        prepareSkillDamage: () => 111
    }
});
assert.strictEqual(soulBreaker.fetchSkillType(), C4SkillRules.DAMAGE_EFFECT, 'Soul Breaker should resolve as sourced PDAM plus stun');
assert.strictEqual(soulBreaker.fetchTargetKind(), 'enemy', 'Soul Breaker should preserve sourced TARGET_ONE offensive semantics');
assert.strictEqual(soulBreaker.fetchSsBoost(), 1, 'Soul Breaker should preserve sourced physical shot boost semantics');
assert.strictEqual(soulBreaker.fetchSemantic().baseLandRate, 50, 'Soul Breaker should use sourced effectPower 50 as stun land rate');
assert.strictEqual(soulBreaker.fetchSemantic().levelDepend, 1, 'Soul Breaker should preserve sourced lvlDepend 1');
assert.deepStrictEqual(soulBreaker.fetchSemantic().requires, { weaponsAllowed: 1024 }, 'Soul Breaker should preserve sourced weaponsAllowed requirement');
assert.strictEqual(soulBreakerOutcome.damage, 111, 'Soul Breaker should keep its physical damage component');
assert.strictEqual(soulBreakerOutcome.effect.key, 'stun', 'Soul Breaker should apply its structured stun effect');
assert.strictEqual(EffectRestrictions.canMove(soulBreakerTarget), false, 'Soul Breaker stun should block movement');
EffectStore.remove(soulBreakerTarget, 'stun');

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

const crippleData = activeSkills.find((entry) => entry.selfId === 95);
assert(crippleData, 'Cripple should be present in active skills data');
assert.strictEqual(crippleData.template.distance, 40, 'Cripple should preserve sourced castRange 40');
assert.strictEqual(crippleData.levels.length, 20, 'Cripple should preserve sourced 20 base levels');
assert.strictEqual(crippleData.levels[0].power, 80, 'Cripple should use sourced power 80 as land rate');
assert.strictEqual(crippleData.levels[0].mp, 19, 'Cripple level 1 MP should use sourced mpConsume 19');
assert.strictEqual(crippleData.levels[19].mp, 68, 'Cripple level 20 MP should use sourced mpConsume 68');
const crippled = statActor();
const cripple = skill({ selfId: 95, name: 'Cripple', spell: false, power: 80, level: 6, buff: 120000, distance: 40 });
const crippleOutcome = SkillEffects.execute(session(), caster, crippled, cripple, {
    magicSkill: false,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(cripple.fetchTargetKind(), 'enemy', 'Cripple should resolve as an enemy debuff');
assert.strictEqual(cripple.fetchSemantic().baseLandRate, 80, 'Cripple should use sourced power 80 as land rate');
assert.strictEqual(cripple.fetchSemantic().levelDepend, 2, 'Cripple should preserve sourced lvlDepend metadata');
assert.strictEqual(cripple.fetchSemantic().castRange, 40, 'Cripple should preserve sourced castRange metadata');
assert.strictEqual(cripple.fetchSemantic().effectRange, 400, 'Cripple should preserve sourced effectRange metadata');
assert.deepStrictEqual(cripple.fetchSemantic().requires, { weaponsAllowed: 1024 }, 'Cripple should preserve sourced weaponsAllowed requirement');
assert.strictEqual(crippleOutcome.effect.key, 'cripple', 'Cripple should apply a structured debuff effect');
assert.strictEqual(EffectStats.multiplier(crippled, 'runSpdMul'), 0.5, 'Cripple level 6 should use sourced runSpd 0.5');
calculateStats({}, crippled);
assert.strictEqual(
    crippled.collectiveRunSpd,
    Math.round(Formulas.calcSpeed(30, 120) * 0.5),
    'Cripple level 6 should apply the sourced run speed multiplier'
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

[
    { id: 1071, name: 'Surrender To Water', levels: 14, firstMp: 35, lastMp: 69, trait: 'water', stat: 'waterVuln', effect: 'surrender_to_water', nukeTrait: 'water' },
    { id: 1074, name: 'Surrender To Wind', levels: 14, firstMp: 35, lastMp: 69, trait: 'wind', stat: 'windVuln', effect: 'surrender_to_wind', nukeTrait: 'wind' },
    { id: 1083, name: 'Surrenders To Fire', levels: 17, firstMp: 12, lastMp: 69, trait: 'fire', stat: 'fireVuln', effect: 'surrender_to_fire', nukeTrait: 'fire' }
].forEach(({ id, name, levels, firstMp, lastMp, trait, stat, effect, nukeTrait }) => {
    const data = activeSkills.find((entry) => entry.selfId === id);
    assert(data, `${name} should be present in active skills data`);
    assert.strictEqual(data.template.distance, 900, `${name} should use sourced 900 cast range for trained levels`);
    assert.strictEqual(data.time.hitTime, 1500, `${name} should preserve sourced 1500ms hit time`);
    assert.strictEqual(data.time.reuse, 8000, `${name} should preserve sourced 8000ms reuse`);
    assert.strictEqual(data.time.buff, 15000, `${name} should preserve sourced 15 second Debuff duration`);
    assert.strictEqual(data.levels.length, levels, `${name} should preserve sourced base level count`);
    assert.strictEqual(data.levels[0].power, 80, `${name} should preserve sourced power 80`);
    assert.strictEqual(data.levels[0].mp, firstMp, `${name} level 1 MP should use sourced initial + consume total`);
    assert.strictEqual(data.levels[levels - 1].mp, lastMp, `${name} final MP should use sourced initial + consume total`);
    const surrendered = creature({ id: 2000040 + id, mDef: 50 });
    const surrender = skill({ selfId: id, name, spell: true, power: 80, level: levels, distance: 900, buff: 15000 });
    const outcome = SkillEffects.execute(session(), caster, surrendered, surrender, {
        magicSkill: true,
        rng: () => 0,
        attack: { clearLoadedShot() {} }
    });
    assert.strictEqual(surrender.fetchTargetKind(), 'enemy', `${name} should resolve as an enemy weakness debuff`);
    assert.strictEqual(surrender.fetchSemantic().trait, trait, `${name} should preserve sourced ${trait} weakness semantics`);
    assert.strictEqual(outcome.effect.key, effect, `${name} should apply a structured ${trait} weakness debuff`);
    assert.strictEqual(EffectStats.multiplier(surrendered, stat), 1.3, `${name} final level should use sourced ${stat} 1.3`);
    const nuke = {
        fetchPower: () => 10,
        fetchSemantic: () => ({ trait: nukeTrait })
    };
    assert.strictEqual(
        new Attack().prepareSkillDamage(caster, surrendered, nuke, true, () => 0.99),
        Math.round(Formulas.calcMagicDamage(100, 10, 50) * 1.3),
        `${name} should amplify ${nukeTrait}-trait magic damage by the sourced vulnerability multiplier`
    );
});

const firstFireSurrenderTarget = creature({ id: 2000120, mDef: 50 });
const firstFireSurrender = skill({ selfId: 1083, name: 'Surrenders To Fire', spell: true, power: 80, level: 1, distance: 900, buff: 15000 });
SkillEffects.execute(session(), caster, firstFireSurrenderTarget, firstFireSurrender, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(EffectStats.multiplier(firstFireSurrenderTarget, 'fireVuln'), 1.25, 'Surrenders To Fire level 1 should use sourced fireVuln 1.25');

[
    { id: 1028, name: 'Might of Heaven', levels: 19, firstPower: 39, lastPower: 87, firstMp: 34, lastMp: 69 },
    { id: 1031, name: 'Disrupt Undead', levels: 8, firstPower: 19, lastPower: 36, firstMp: 18, lastMp: 30 }
].forEach(({ id, name, levels, firstPower, lastPower, firstMp, lastMp }) => {
    const data = activeSkills.find((entry) => entry.selfId === id);
    assert(data, `${name} should be present in active skills data`);
    assert.strictEqual(data.template.distance, 400, `${name} should preserve sourced 400 cast range`);
    assert.strictEqual(data.time.hitTime, 2500, `${name} should preserve sourced 2500ms hit time`);
    assert.strictEqual(data.time.reuse, 4000, `${name} should preserve sourced 4000ms reuse`);
    assert.strictEqual(data.levels.length, levels, `${name} should preserve sourced base level count`);
    assert.strictEqual(data.levels[0].power, firstPower, `${name} level 1 should preserve sourced power`);
    assert.strictEqual(data.levels[levels - 1].power, lastPower, `${name} final level should preserve sourced power`);
    assert.strictEqual(data.levels[0].mp, firstMp, `${name} level 1 MP should use sourced initial + consume total`);
    assert.strictEqual(data.levels[levels - 1].mp, lastMp, `${name} final MP should use sourced initial + consume total`);

    const holyNuke = skill({ selfId: id, name, spell: true, power: lastPower, level: levels, distance: 400 });
    const livingTarget = creature({ id: 2000300 + id, mDef: 50 });
    const livingOutcome = SkillEffects.execute(session(), caster, livingTarget, holyNuke, {
        magicSkill: true,
        rng: () => 0,
        attack: { prepareSkillDamage: () => 999, clearLoadedShot() {} }
    });
    assert.strictEqual(holyNuke.fetchSkillType(), C4SkillRules.DAMAGE, `${name} should resolve as magic damage`);
    assert.strictEqual(holyNuke.fetchTargetKind(), 'enemy', `${name} should resolve as an enemy undead-only nuke`);
    assert.strictEqual(holyNuke.fetchSemantic().trait, 'holy', `${name} should preserve sourced holy element semantics`);
    assert.strictEqual(holyNuke.fetchSemantic().undeadOnly, true, `${name} should preserve sourced TARGET_UNDEAD semantics`);
    assert.strictEqual(holyNuke.fetchSsBoost(), 1, `${name} should keep offensive magic shot boost semantics`);
    assert.strictEqual(livingOutcome.damage, 0, `${name} should not damage living targets`);
    assert.strictEqual(livingOutcome.effectResisted, true, `${name} should reject living targets through TARGET_UNDEAD`);

    const undeadTarget = creature({ id: 2000400 + id, mDef: 50 });
    undeadTarget.fetchUndead = () => true;
    const undeadOutcome = SkillEffects.execute(session(), caster, undeadTarget, holyNuke, {
        magicSkill: true,
        rng: () => 0.99,
        attack: new Attack()
    });
    assert.strictEqual(
        undeadOutcome.damage,
        Math.round(Formulas.calcMagicDamage(100, lastPower, 50)),
        `${name} should damage undead targets with sourced holy MDAM power`
    );
});

const holyStrikeData = activeSkills.find((entry) => entry.selfId === 49);
assert(holyStrikeData, 'Holy Strike should be present in active skills data');
assert.strictEqual(holyStrikeData.template.distance, 400, 'Holy Strike should preserve sourced castRange 400');
assert.strictEqual(holyStrikeData.time.hitTime, 1900, 'Holy Strike should preserve sourced hitTime 1900');
assert.strictEqual(holyStrikeData.time.reuse, 4000, 'Holy Strike should preserve sourced reuseDelay 4000');
assert.strictEqual(holyStrikeData.levels.length, 26, 'Holy Strike should preserve sourced 26 base levels');
assert.strictEqual(holyStrikeData.levels[0].power, 47, 'Holy Strike level 1 should preserve sourced MDAM power 47');
assert.strictEqual(holyStrikeData.levels[25].power, 87, 'Holy Strike level 26 should preserve sourced MDAM power 87');
assert.strictEqual(holyStrikeData.levels[25].mp, 35, 'Holy Strike level 26 MP should use sourced initial + consume total 35');
const holyStrike = skill({ selfId: 49, name: 'Holy Strike', spell: true, power: 87, level: 26, distance: 400 });
const livingHolyStrikeTarget = creature({ id: 2000049, mDef: 50 });
const livingHolyStrikeOutcome = SkillEffects.execute(session(), caster, livingHolyStrikeTarget, holyStrike, {
    magicSkill: true,
    rng: () => 0,
    attack: { prepareSkillDamage: () => 999, clearLoadedShot() {} }
});
assert.strictEqual(holyStrike.fetchSkillType(), C4SkillRules.DAMAGE, 'Holy Strike should resolve as sourced MDAM');
assert.strictEqual(holyStrike.fetchTargetKind(), 'enemy', 'Holy Strike should resolve as an enemy undead-only nuke');
assert.strictEqual(holyStrike.fetchSemantic().trait, 'holy', 'Holy Strike should preserve sourced holy element semantics');
assert.strictEqual(holyStrike.fetchSemantic().undeadOnly, true, 'Holy Strike should preserve sourced TARGET_UNDEAD semantics');
assert.strictEqual(holyStrike.fetchSemantic().castRange, 400, 'Holy Strike should preserve sourced castRange metadata');
assert.strictEqual(holyStrike.fetchSemantic().effectRange, 900, 'Holy Strike should preserve sourced effectRange metadata');
assert.strictEqual(holyStrike.fetchSsBoost(), 1, 'Holy Strike should keep offensive magic shot boost semantics');
assert.strictEqual(livingHolyStrikeOutcome.damage, 0, 'Holy Strike should not damage living targets');
assert.strictEqual(livingHolyStrikeOutcome.effectResisted, true, 'Holy Strike should reject living targets through TARGET_UNDEAD');
const undeadHolyStrikeTarget = creature({ id: 2000149, mDef: 50 });
undeadHolyStrikeTarget.fetchUndead = () => true;
const undeadHolyStrikeOutcome = SkillEffects.execute(session(), caster, undeadHolyStrikeTarget, holyStrike, {
    magicSkill: true,
    rng: () => 0.99,
    attack: new Attack()
});
assert.strictEqual(
    undeadHolyStrikeOutcome.damage,
    Math.round(Formulas.calcMagicDamage(100, 87, 50)),
    'Holy Strike should damage undead targets with sourced holy MDAM power'
);

const reposeData = activeSkills.find((entry) => entry.selfId === 1034);
assert(reposeData, 'Repose should be present in active skills data');
assert.strictEqual(reposeData.template.distance, -1, 'Repose should preserve sourced self-centered TARGET_UNDEAD radius semantics');
assert.strictEqual(reposeData.time.hitTime, 1500, 'Repose should preserve sourced 1500ms hit time');
assert.strictEqual(reposeData.time.reuse, 20000, 'Repose should preserve sourced 20000ms reuse');
assert.strictEqual(reposeData.levels.length, 13, 'Repose should preserve sourced 13 base levels');
assert.strictEqual(reposeData.levels[0].power, 30, 'Repose level 1 power should preserve sourced AGGREMOVE land rate');
assert.strictEqual(reposeData.levels[12].power, 150, 'Repose level 13 power should preserve sourced AGGREMOVE land rate');
assert.strictEqual(reposeData.levels[0].mp, 59, 'Repose level 1 MP should use sourced initial + consume total');
assert.strictEqual(reposeData.levels[12].mp, 103, 'Repose level 13 MP should use sourced initial + consume total');
const repose = skill({ selfId: 1034, name: 'Repose', spell: true, power: 150, level: 13, distance: -1 });
const livingReposeTarget = creature({ id: 2000500, mDef: 50 });
const livingReposeOutcome = SkillEffects.execute(session(), caster, livingReposeTarget, repose, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(repose.fetchSkillType(), C4SkillRules.AGGRO_REMOVE, 'Repose should resolve as sourced AGGREMOVE');
assert.strictEqual(repose.fetchTargetKind(), 'enemy', 'Repose should resolve as an enemy undead-only aggro remove');
assert.strictEqual(repose.fetchSemantic().trait, 'derangement', 'Repose should use sourced AGGREMOVE derangement vulnerability semantics');
assert.strictEqual(repose.fetchSemantic().baseLandRate, 150, 'Repose level 13 should use sourced power as land rate');
assert.strictEqual(repose.fetchSemantic().undeadOnly, true, 'Repose should preserve sourced TARGET_UNDEAD semantics');
assert.strictEqual(repose.fetchSsBoost(), 1, 'Repose should keep offensive magic shot boost semantics');
assert.strictEqual(livingReposeOutcome.aggroRemoved, false, 'Repose should not remove aggro from living targets');
assert.strictEqual(livingReposeOutcome.effectResisted, true, 'Repose should reject living targets through TARGET_UNDEAD');
const undeadReposeTarget = creature({ id: 2000501, mDef: 50 });
undeadReposeTarget.fetchUndead = () => true;
const undeadReposeOutcome = SkillEffects.execute(session(), caster, undeadReposeTarget, repose, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(undeadReposeOutcome.damage, 0, 'Repose should not be routed as magic damage');
assert.strictEqual(undeadReposeOutcome.aggroRemoved, true, 'Repose should mark successful AGGREMOVE on undead targets');
assert.strictEqual(undeadReposeOutcome.effectResisted, false, 'Repose should pass sourced AGGREMOVE success checks on undead targets');

const requiemData = activeSkills.find((entry) => entry.selfId === 1049);
assert(requiemData, 'Requiem should be present in active skills data');
assert.strictEqual(requiemData.template.distance, -1, 'Requiem should preserve sourced self-centered TARGET_AURA_UNDEAD semantics');
assert.strictEqual(requiemData.time.hitTime, 7000, 'Requiem should preserve sourced 7000ms hit time');
assert.strictEqual(requiemData.time.reuse, 20000, 'Requiem should preserve sourced 20000ms reuse');
assert.strictEqual(requiemData.time.buff, 120000, 'Requiem should preserve sourced 120 second aggression debuff duration');
assert.strictEqual(requiemData.levels.length, 14, 'Requiem should preserve sourced 14 base levels');
assert.strictEqual(requiemData.levels[0].power, 35, 'Requiem level 1 should preserve sourced AGGREMOVE power');
assert.strictEqual(requiemData.levels[13].power, 35, 'Requiem level 14 should preserve sourced AGGREMOVE power');
assert.strictEqual(requiemData.levels[0].mp, 53, 'Requiem level 1 MP should use sourced initial + consume total');
assert.strictEqual(requiemData.levels[13].mp, 103, 'Requiem level 14 MP should use sourced initial + consume total');
const requiem = skill({ selfId: 1049, name: 'Requiem', spell: true, power: 35, level: 14, distance: -1, buff: 120000 });
const livingRequiemTarget = creature({ id: 2000510, mDef: 50 });
const livingRequiemOutcome = SkillEffects.execute(session(), caster, livingRequiemTarget, requiem, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(requiem.fetchSkillType(), C4SkillRules.AGGRO_REMOVE, 'Requiem should resolve as sourced AGGREMOVE');
assert.strictEqual(requiem.fetchTargetKind(), 'enemy', 'Requiem should resolve as an enemy undead-only aggro remove');
assert.strictEqual(requiem.fetchSemantic().trait, 'derangement', 'Requiem should use sourced AGGREMOVE derangement vulnerability semantics');
assert.strictEqual(requiem.fetchSemantic().baseLandRate, 35, 'Requiem should use sourced power 35 as land rate');
assert.strictEqual(requiem.fetchSemantic().undeadOnly, true, 'Requiem should preserve sourced TARGET_AURA_UNDEAD semantics');
assert.strictEqual(livingRequiemOutcome.aggroRemoved, false, 'Requiem should not remove aggro from living targets');
assert.strictEqual(livingRequiemOutcome.effectResisted, true, 'Requiem should reject living targets through TARGET_AURA_UNDEAD');
const undeadRequiemTarget = creature({ id: 2000511, mDef: 50 });
undeadRequiemTarget.fetchUndead = () => true;
const undeadRequiemOutcome = SkillEffects.execute(session(), caster, undeadRequiemTarget, requiem, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(undeadRequiemOutcome.damage, 0, 'Requiem should not be routed as magic damage');
assert.strictEqual(undeadRequiemOutcome.aggroRemoved, true, 'Requiem should mark successful AGGREMOVE on undead targets');
assert.strictEqual(undeadRequiemOutcome.effectResisted, false, 'Requiem should pass sourced AGGREMOVE success checks on undead targets');

const cancelData = activeSkills.find((entry) => entry.selfId === 1056);
assert(cancelData, 'Cancel should be present in active skills data');
assert.strictEqual(cancelData.template.distance, 600, 'Cancel should preserve sourced 600 cast range');
assert.strictEqual(cancelData.time.hitTime, 6000, 'Cancel should preserve sourced 6000ms hit time');
assert.strictEqual(cancelData.time.reuse, 120000, 'Cancel should preserve sourced 120000ms reuse');
assert.strictEqual(cancelData.levels.length, 12, 'Cancel should preserve sourced 12 base levels');
assert.strictEqual(cancelData.levels[0].power, 25, 'Cancel level 1 should preserve sourced power 25');
assert.strictEqual(cancelData.levels[11].power, 25, 'Cancel level 12 should preserve sourced power 25');
assert.strictEqual(cancelData.levels[0].mp, 44, 'Cancel level 1 MP should use sourced initial + consume total');
assert.strictEqual(cancelData.levels[11].mp, 69, 'Cancel level 12 MP should use sourced initial + consume total');
const cancelTarget = creature({ id: 2000520, mDef: 50 });
EffectStore.apply(cancelTarget, { key: 'shield', id: 1040, level: 1, type: 'buff', category: 'buff', durationMs: 120000 });
EffectStore.apply(cancelTarget, { key: 'might', id: 1068, level: 9, type: 'buff', category: 'buff', durationMs: 120000 });
EffectStore.apply(cancelTarget, { key: 'protected_buff', id: 9999, level: 1, type: 'buff', category: 'buff', dispellable: false, durationMs: 120000 });
EffectStore.apply(cancelTarget, { key: 'hex', id: 122, level: 1, type: 'debuff', category: 'debuff', durationMs: 30000 });
const cancel = skill({ selfId: 1056, name: 'Cancel', spell: true, power: 25, level: 12, distance: 600 });
const cancelRolls = [0, 0, 0.5, 0.5];
const cancelSession = session();
const cancelOutcome = SkillEffects.execute(cancelSession, caster, cancelTarget, cancel, {
    magicSkill: true,
    rng: () => cancelRolls.shift() ?? 0,
    attack: { clearLoadedShot() {} }
});
const remainingCancelEffects = EffectStore.list(cancelTarget).map((effect) => effect.key);
assert.strictEqual(cancel.fetchSkillType(), C4SkillRules.CANCEL, 'Cancel should resolve as sourced CANCEL');
assert.strictEqual(cancel.fetchTargetKind(), 'enemy', 'Cancel should resolve as an enemy-targeted cancel skill');
assert.strictEqual(cancel.fetchSemantic().trait, 'cancel', 'Cancel should use sourced CANCEL vulnerability semantics');
assert.strictEqual(cancel.fetchSemantic().baseLandRate, 25, 'Cancel should use sourced power 25 as land rate');
assert.strictEqual(cancel.fetchSemantic().maxCancelled, 0, 'Cancel should preserve sourced maxNegated=0 as no removal cap');
assert.strictEqual(cancelOutcome.cancelled.length, 1, 'Cancel should remove buffs whose sourced per-effect cancel roll passes');
assert.strictEqual(cancelOutcome.cancelled[0].key, 'shield', 'Cancel should remove the low-level dispellable buff');
assert.strictEqual(remainingCancelEffects.includes('shield'), false, 'Cancel should remove dispellable buffs from EffectStore');
assert.strictEqual(remainingCancelEffects.includes('might'), true, 'Cancel should leave buffs whose per-effect cancel roll fails');
assert.strictEqual(remainingCancelEffects.includes('protected_buff'), true, 'Cancel should not remove non-dispellable buffs');
assert.strictEqual(remainingCancelEffects.includes('hex'), true, 'Cancel should not cleanse debuffs');
assert.strictEqual(cancelSession.packets[0][0], 0x7f, 'Cancel should refresh abnormal status icons after removing a buff');

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

const unlockData = activeSkills.find((entry) => entry.selfId === 27);
assert(unlockData, 'Unlock should be present in active skills data');
assert.strictEqual(unlockData.template.distance, 40, 'Unlock should preserve sourced castRange 40');
assert.strictEqual(unlockData.time.hitTime, 2500, 'Unlock should preserve sourced hitTime 2500');
assert.strictEqual(unlockData.time.reuse, 120000, 'Unlock should preserve sourced reuseDelay 120000');
assert.strictEqual(unlockData.levels.length, 14, 'Unlock should preserve sourced 14 base levels');
assert.strictEqual(unlockData.levels[0].itemId, 1661, 'Unlock should preserve sourced key item id');
assert.strictEqual(unlockData.levels[0].itemCount, 2, 'Unlock level 1 should preserve sourced key item count');
assert.strictEqual(unlockData.levels[13].mp, 67, 'Unlock level 14 should preserve sourced mpConsume 67');
assert.strictEqual(unlockData.levels[13].itemCount, 17, 'Unlock level 14 should preserve sourced key item count');
const unlock = skill({ selfId: 27, name: 'Unlock', spell: false, power: 1, level: 14, distance: 40 });
assert.strictEqual(unlock.fetchSkillType(), C4SkillRules.UNLOCK, 'Unlock should preserve sourced UNLOCK skill type');
assert.strictEqual(unlock.fetchTargetKind(), 'unlockable', 'Unlock should preserve sourced TARGET_UNLOCKABLE semantics');
assert.strictEqual(unlock.fetchSsBoost(), 0, 'Unlock should not consume offensive shot boost semantics');
assert.strictEqual(unlock.fetchSemantic().unlockDoorChance, 100, 'Unlock level 14 should preserve sourced L2J door unlock chance');

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

const poisonRecoveryData = activeSkills.find((entry) => entry.selfId === 21);
assert(poisonRecoveryData, 'Poison Recovery should be present in active skills data');
assert.strictEqual(poisonRecoveryData.template.distance, -1, 'Poison Recovery should preserve sourced TARGET_SELF range');
assert.strictEqual(poisonRecoveryData.time.hitTime, 4000, 'Poison Recovery should preserve sourced hitTime 4000');
assert.strictEqual(poisonRecoveryData.time.reuse, 6000, 'Poison Recovery should preserve sourced reuseDelay 6000');
assert.strictEqual(poisonRecoveryData.levels.length, 3, 'Poison Recovery should preserve sourced 3 base levels');
assert.strictEqual(poisonRecoveryData.levels[2].power, 9, 'Poison Recovery level 3 should preserve sourced negatePower 9');
assert.strictEqual(poisonRecoveryData.levels[2].mp, 55, 'Poison Recovery level 3 MP should use sourced initial + consume total');
const poisonRecoveryTarget = statActor();
EffectStore.apply(poisonRecoveryTarget, { key: 'major_poison', id: 129, level: 9, type: 'debuff', category: 'poison', durationMs: 30000 });
EffectStore.apply(poisonRecoveryTarget, { key: 'deadly_poison', id: 129, level: 10, type: 'debuff', category: 'poison', durationMs: 30000 });
const poisonRecovery = skill({ selfId: 21, name: 'Poison Recovery', spell: true, power: 9, level: 3, distance: -1 });
const poisonRecoveryOutcome = SkillEffects.execute(session(), caster, poisonRecoveryTarget, poisonRecovery, {
    magicSkill: true,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(poisonRecovery.fetchSkillType(), C4SkillRules.CLEANSE, 'Poison Recovery should resolve to sourced NEGATE/CLEANSE');
assert.strictEqual(poisonRecovery.fetchTargetKind(), 'self', 'Poison Recovery should preserve sourced TARGET_SELF semantics');
assert.strictEqual(poisonRecovery.fetchSemantic().trait, 'poison', 'Poison Recovery should preserve sourced POISON negate semantics');
assert.strictEqual(poisonRecoveryOutcome.cleansed.length, 1, 'Poison Recovery level 3 should cleanse poison up to sourced negatePower 9');
assert.strictEqual(EffectStore.hasDebuff(poisonRecoveryTarget, 'major_poison'), false, 'Poison Recovery should remove level 9 poison');
assert.strictEqual(EffectStore.hasDebuff(poisonRecoveryTarget, 'deadly_poison'), true, 'Poison Recovery should not remove poison above sourced negatePower 9');
EffectStore.remove(poisonRecoveryTarget, 'deadly_poison');

const antidoteData = activeSkills.find((entry) => entry.selfId === 2042);
assert(antidoteData, 'Antidote should be present in active skills data');
assert.strictEqual(antidoteData.levels[0].power, 3, 'Antidote active data should preserve sourced negatePower 3');
const advancedAntidoteData = activeSkills.find((entry) => entry.selfId === 2043);
assert(advancedAntidoteData, 'Advanced antidote should be present in active skills data');
assert.strictEqual(advancedAntidoteData.levels[0].power, 7, 'Advanced antidote active data should preserve sourced negatePower 7');
const antidoteTarget = statActor();
EffectStore.apply(antidoteTarget, { key: 'minor_poison', id: 129, level: 3, type: 'debuff', category: 'poison', durationMs: 30000 });
EffectStore.apply(antidoteTarget, { key: 'strong_poison', id: 129, level: 7, type: 'debuff', category: 'poison', durationMs: 30000 });
const antidote = skill({ selfId: 2042, name: 'Antidote', spell: false, power: 3, level: 1, distance: -1 });
const antidoteOutcome = SkillEffects.execute(session(), caster, antidoteTarget, antidote, {
    magicSkill: false,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(antidote.fetchSkillType(), C4SkillRules.CLEANSE, 'Antidote should resolve to sourced NEGATE/CLEANSE');
assert.strictEqual(antidoteOutcome.cleansed.length, 1, 'Antidote should cleanse poison up to sourced negatePower 3 only');
assert.strictEqual(EffectStore.hasDebuff(antidoteTarget, 'minor_poison'), false, 'Antidote should remove low-level poison');
assert.strictEqual(EffectStore.hasDebuff(antidoteTarget, 'strong_poison'), true, 'Antidote should not remove poison above sourced negatePower 3');
const advancedAntidote = skill({ selfId: 2043, name: 'Advanced antidote', spell: false, power: 7, level: 1, distance: -1 });
const advancedAntidoteOutcome = SkillEffects.execute(session(), caster, antidoteTarget, advancedAntidote, {
    magicSkill: false,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(advancedAntidoteOutcome.cleansed.length, 1, 'Advanced antidote should cleanse poison up to sourced negatePower 7');
assert.strictEqual(EffectStore.hasDebuff(antidoteTarget, 'strong_poison'), false, 'Advanced antidote should remove level 7 poison');

const healingMedicineData = activeSkills.find((entry) => entry.selfId === 2060);
assert(healingMedicineData, 'Healing Medicine should be present in active skills data');
const medicineTarget = statActor();
EffectStore.apply(medicineTarget, { key: 'poison', id: 129, level: 1, type: 'debuff', category: 'poison', durationMs: 30000 });
EffectStore.apply(medicineTarget, { key: 'poison_of_death', id: 4082, level: 1, type: 'debuff', category: 'poison', durationMs: 30000 });
const healingMedicine = skill({ selfId: 2060, name: 'Healing Medicine', spell: false, power: 1, level: 1, distance: -1 });
const medicineOutcome = SkillEffects.execute(session(), caster, medicineTarget, healingMedicine, {
    magicSkill: false,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(healingMedicine.fetchSkillType(), C4SkillRules.CLEANSE, 'Healing Medicine should resolve to sourced NEGATE/CLEANSE');
assert.strictEqual(medicineOutcome.cleansed.length, 1, 'Healing Medicine should cleanse only sourced negateId 4082');
assert.strictEqual(EffectStore.hasDebuff(medicineTarget, 'poison_of_death'), false, 'Healing Medicine should remove Poison of Death');
assert.strictEqual(EffectStore.hasDebuff(medicineTarget, 'poison'), true, 'Healing Medicine should not remove unrelated poison effects');
EffectStore.remove(medicineTarget, 'poison');

const poisonBladeDanceData = activeSkills.find((entry) => entry.selfId === 84);
assert(poisonBladeDanceData, 'Poison Blade Dance should be present in active skills data');
assert.strictEqual(poisonBladeDanceData.levels.length, 3, 'Poison Blade Dance should preserve sourced 3 base levels');
assert.strictEqual(poisonBladeDanceData.levels[2].power, 8, 'Poison Blade Dance level 3 should preserve sourced poison power 8');
assert.strictEqual(poisonBladeDanceData.levels[2].mp, 133, 'Poison Blade Dance level 3 MP should use sourced mpConsume 133');
assert.strictEqual(poisonBladeDanceData.time.hitTime, 1833, 'Poison Blade Dance should preserve sourced hitTime 1833');
assert.strictEqual(poisonBladeDanceData.time.reuse, 60000, 'Poison Blade Dance should preserve sourced reuseDelay 60000');
const poisonBladeDance = skill({ selfId: 84, name: 'Poison Blade Dance', spell: false, power: 8, level: 3, distance: -1, buff: 30000 });
const poisonBladeTarget = statActor();
const poisonBladeOutcome = SkillEffects.execute(session(), caster, poisonBladeTarget, poisonBladeDance, {
    magicSkill: false,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(poisonBladeDance.fetchTargetKind(), 'enemy', 'Poison Blade Dance should resolve as an enemy aura poison');
assert.strictEqual(poisonBladeDance.fetchSemantic().sourceTarget, 'aura', 'Poison Blade Dance should preserve sourced TARGET_AURA semantics');
assert.strictEqual(poisonBladeDance.fetchSemantic().radius, 150, 'Poison Blade Dance should preserve sourced skillRadius 150');
assert.deepStrictEqual(poisonBladeDance.fetchSemantic().requires, { weaponsAllowed: 512 }, 'Poison Blade Dance should preserve sourced dual weapon requirement');
assert.strictEqual(poisonBladeDance.fetchSemantic().baseLandRate, 8, 'Poison Blade Dance should use sourced level 3 power as land rate');
assert.strictEqual(poisonBladeOutcome.effect.key, 'poison', 'Poison Blade Dance should apply the structured poison effect');
assert.strictEqual(poisonBladeOutcome.effect.dot.damage, 48, 'Poison Blade Dance level 3 should use sourced DamOverTime value 48');
assert.strictEqual(poisonBladeOutcome.effect.dot.count, 10, 'Poison Blade Dance should use sourced 10 damage ticks');
assert.strictEqual(poisonBladeOutcome.effect.dot.intervalMs, 3000, 'Poison Blade Dance should tick every sourced 3 seconds');
EffectStore.remove(poisonBladeTarget, 'poison');

const poisonCloudData = activeSkills.find((entry) => entry.selfId === 1167);
assert(poisonCloudData, 'Poisonous Cloud should be present in active skills data');
assert.strictEqual(poisonCloudData.levels.length, 6, 'Poisonous Cloud should preserve sourced 6 base levels');
assert.strictEqual(poisonCloudData.levels[5].power, 8, 'Poisonous Cloud level 6 should preserve sourced power 8');
assert.strictEqual(poisonCloudData.levels[5].mp, 103, 'Poisonous Cloud level 6 MP should use sourced initial + consume total');
const poisonCloud = skill({ selfId: 1167, name: 'Poisonous Cloud', spell: true, power: 8, level: 6, distance: 500, buff: 30000 });
const poisonCloudTarget = statActor();
const poisonCloudOutcome = SkillEffects.execute(session(), caster, poisonCloudTarget, poisonCloud, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(poisonCloud.fetchTargetKind(), 'enemy', 'Poisonous Cloud should resolve as an enemy poison effect');
assert.strictEqual(poisonCloud.fetchSemantic().baseLandRate, 8, 'Poisonous Cloud should use sourced level 6 power as land rate');
assert.strictEqual(poisonCloudOutcome.effect.key, 'poison', 'Poisonous Cloud should apply the structured poison effect');
assert.strictEqual(poisonCloudOutcome.effect.dot.damage, 48, 'Poisonous Cloud level 6 should use sourced DamOverTime value 48');
assert.strictEqual(poisonCloudOutcome.effect.dot.count, 10, 'Poisonous Cloud should use sourced 10 damage ticks');
assert.strictEqual(poisonCloudOutcome.effect.dot.intervalMs, 3000, 'Poisonous Cloud should tick every sourced 3 seconds');
EffectStore.remove(poisonCloudTarget, 'poison');

const cursePoisonData = activeSkills.find((entry) => entry.selfId === 1168);
assert(cursePoisonData, 'Curse: Poison should be present in active skills data');
assert.strictEqual(cursePoisonData.levels.length, 7, 'Curse: Poison should preserve sourced 7 base levels');
assert.strictEqual(cursePoisonData.levels[6].power, 8, 'Curse: Poison level 7 should preserve sourced power 8');
assert.strictEqual(cursePoisonData.levels[6].mp, 67, 'Curse: Poison level 7 MP should use sourced initial + consume total');
const cursePoison = skill({ selfId: 1168, name: 'Curse:Poison', spell: true, power: 5, level: 4, buff: 30000 });
const curseTarget = statActor();
const curseOutcome = SkillEffects.execute(session(), caster, curseTarget, cursePoison, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(cursePoison.fetchTargetKind(), 'enemy', 'Curse: Poison should resolve as an enemy poison effect');
assert.strictEqual(cursePoison.fetchSemantic().baseLandRate, 5, 'Curse: Poison level 4 should use sourced power as land rate');
assert.strictEqual(curseOutcome.effect.dot.damage, 31, 'Curse: Poison level 4 should use the sourced L2J damage table');
EffectStore.remove(curseTarget, 'poison');

const curseDiscordData = activeSkills.find((entry) => entry.selfId === 1163);
assert(curseDiscordData, 'Curse Discord should be present in active skills data');
assert.strictEqual(curseDiscordData.time.buff, 30000, 'Curse Discord should preserve sourced 5x6s ConfuseMob duration');
assert.strictEqual(curseDiscordData.levels.length, 14, 'Curse Discord should preserve sourced 14 base levels');
assert.strictEqual(curseDiscordData.levels[13].mp, 69, 'Curse Discord level 14 MP should use sourced initial + consume total');
const curseDiscord = skill({ selfId: 1163, name: 'Curse Discord', spell: true, power: 1, level: 14, distance: 600, buff: 30000 });
const playerDiscordTarget = statActor();
const playerDiscordOutcome = SkillEffects.execute(session(), caster, playerDiscordTarget, curseDiscord, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(playerDiscordOutcome.effect, null, 'Curse Discord should not apply CONFUSE_MOB_ONLY to living players');
assert.strictEqual(playerDiscordOutcome.effectResisted, true, 'Curse Discord mob-only rejection should report effect resistance');
const mobDiscordTarget = statActor();
mobDiscordTarget.fetchAttackable = () => true;
const mobDiscordOutcome = SkillEffects.execute(session(), caster, mobDiscordTarget, curseDiscord, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(curseDiscord.fetchSemantic().baseLandRate, 80, 'Curse Discord should use sourced core fallback land rate 80');
assert.strictEqual(mobDiscordOutcome.effect.key, 'confusion', 'Curse Discord should apply sourced ConfuseMob to attackable NPCs');
assert.strictEqual(EffectStore.impairments(mobDiscordTarget).confused, true, 'Curse Discord confusion should be visible through impairments');
EffectStore.remove(mobDiscordTarget, 'confusion');

const curseFearData = activeSkills.find((entry) => entry.selfId === 1169);
assert(curseFearData, 'Curse Fear should be present in active skills data');
assert.strictEqual(curseFearData.time.reuse, 12000, 'Curse Fear should preserve sourced 12 second reuse');
assert.strictEqual(curseFearData.time.buff, 30000, 'Curse Fear should preserve sourced 5x6s Fear duration');
assert.strictEqual(curseFearData.levels.length, 14, 'Curse Fear should preserve sourced 14 base levels');
assert.strictEqual(curseFearData.levels[13].power, 20, 'Curse Fear level 14 should preserve sourced power 20');
assert.strictEqual(curseFearData.levels[13].mp, 69, 'Curse Fear level 14 MP should use sourced initial + consume total');
const curseFear = skill({ selfId: 1169, name: 'Curse Fear', spell: true, power: 20, level: 14, distance: 600, buff: 30000 });
const fearTarget = statActor();
const fearOutcome = SkillEffects.execute(session(), caster, fearTarget, curseFear, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(curseFear.fetchTargetKind(), 'enemy', 'Curse Fear should resolve as an enemy fear debuff');
assert.strictEqual(curseFear.fetchSemantic().baseLandRate, 20, 'Curse Fear should use sourced power 20 as land rate');
assert.strictEqual(fearOutcome.effect.key, 'fear', 'Curse Fear should apply a structured fear debuff');
assert.strictEqual(EffectStore.hasDebuff(fearTarget, 'fear'), true, 'Curse Fear should leave a fear debuff');
EffectStore.remove(fearTarget, 'fear');

const horrorData = activeSkills.find((entry) => entry.selfId === 65);
assert(horrorData, 'Horror should be present in active skills data');
assert.strictEqual(horrorData.template.distance, 600, 'Horror should preserve sourced castRange 600');
assert.strictEqual(horrorData.time.hitTime, 3000, 'Horror should preserve sourced hitTime 3000');
assert.strictEqual(horrorData.time.reuse, 120000, 'Horror should preserve sourced 120 second reuse');
assert.strictEqual(horrorData.time.buff, 30000, 'Horror should preserve sourced 5x6s Fear duration');
assert.strictEqual(horrorData.levels.length, 13, 'Horror should preserve sourced 13 base levels');
assert.strictEqual(horrorData.levels[0].power, 20, 'Horror level 1 should preserve sourced power 20');
assert.strictEqual(horrorData.levels[12].power, 20, 'Horror level 13 should preserve sourced power 20');
assert.strictEqual(horrorData.levels[12].mp, 35, 'Horror level 13 MP should use sourced initial + consume total');
const horror = skill({ selfId: 65, name: 'Horror', spell: true, power: 20, level: 13, distance: 600, buff: 30000 });
const horrorTarget = statActor();
const horrorOutcome = SkillEffects.execute(session(), caster, horrorTarget, horror, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(horror.fetchSkillType(), C4SkillRules.EFFECT, 'Horror should preserve sourced FEAR effect semantics');
assert.strictEqual(horror.fetchTargetKind(), 'enemy', 'Horror should preserve sourced TARGET_ONE offensive semantics');
assert.strictEqual(horror.fetchSemantic().baseLandRate, 20, 'Horror should use sourced power 20 as land rate');
assert.strictEqual(horror.fetchSemantic().castRange, 600, 'Horror should preserve sourced castRange metadata');
assert.strictEqual(horror.fetchSemantic().effectRange, 1100, 'Horror should preserve sourced effectRange metadata');
assert.strictEqual(horrorOutcome.effect.key, 'fear', 'Horror should apply a structured fear debuff');
assert.strictEqual(EffectStore.hasDebuff(horrorTarget, 'fear'), true, 'Horror should leave a fear debuff');
EffectStore.remove(horrorTarget, 'fear');

const anchorData = activeSkills.find((entry) => entry.selfId === 1170);
assert(anchorData, 'Anchor should be present in active skills data');
assert.strictEqual(anchorData.time.reuse, 150000, 'Anchor should preserve sourced 150 second reuse');
assert.strictEqual(anchorData.levels.length, 13, 'Anchor should preserve sourced 13 base levels');
assert.strictEqual(anchorData.levels[12].power, 20, 'Anchor level 13 should preserve sourced power 20');
assert.strictEqual(anchorData.levels[12].mp, 69, 'Anchor level 13 MP should use sourced initial + consume total');
const anchor = skill({ selfId: 1170, name: 'Anchor', spell: true, power: 20, level: 13, distance: 400, buff: 120000 });
const anchorTarget = statActor();
const anchorOutcome = SkillEffects.execute(session(), caster, anchorTarget, anchor, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(anchor.fetchTargetKind(), 'enemy', 'Anchor should resolve as an enemy paralyze effect');
assert.strictEqual(anchor.fetchSemantic().baseLandRate, 20, 'Anchor should use sourced power 20 as land rate');
assert.strictEqual(anchorOutcome.effect.key, 'paralyze', 'Anchor should apply sourced Paralyze');
assert.strictEqual(EffectRestrictions.canMove(anchorTarget), false, 'Anchor paralyze should block movement through runtime restrictions');
EffectStore.remove(anchorTarget, 'paralyze');

const deathSpikeData = activeSkills.find((entry) => entry.selfId === 1148);
assert(deathSpikeData, 'Death Spike should be present in active skills data');
assert.strictEqual(deathSpikeData.levels.length, 13, 'Death Spike should preserve sourced 13 base levels');
assert.strictEqual(deathSpikeData.levels[0].mp, 23, 'Death Spike level 1 MP should use sourced initial + consume total');
assert.strictEqual(deathSpikeData.levels[12].power, 108, 'Death Spike level 13 should preserve sourced power 108');
assert.strictEqual(deathSpikeData.levels[12].mp, 50, 'Death Spike level 13 MP should use sourced initial + consume total');
assert.strictEqual(deathSpikeData.levels[12].itemId, 2508, 'Death Spike should preserve sourced cursed bone item consume');
assert.strictEqual(deathSpikeData.levels[12].itemCount, 1, 'Death Spike should preserve sourced cursed bone count');
const deathSpike = skill({ selfId: 1148, name: 'Death Spike', spell: true, power: 108, level: 13, distance: 900 });
assert.strictEqual(deathSpike.fetchSkillType(), C4SkillRules.DAMAGE, 'Death Spike should resolve as sourced MDAM damage');
assert.strictEqual(deathSpike.fetchSemantic().trait, 'dark', 'Death Spike should preserve sourced dark element');
assert.strictEqual(deathSpike.fetchTargetKind(), 'enemy', 'Death Spike should resolve as an enemy nuke');

const deathLinkData = activeSkills.find((entry) => entry.selfId === 1159);
assert(deathLinkData, 'Curse Death Link should be present in active skills data');
assert.strictEqual(deathLinkData.levels.length, 22, 'Curse Death Link should preserve sourced 22 base levels');
assert.strictEqual(deathLinkData.levels[0].power, 68, 'Curse Death Link level 1 should preserve sourced power 68');
assert.strictEqual(deathLinkData.levels[21].power, 108, 'Curse Death Link level 22 should preserve sourced power 108');
assert.strictEqual(deathLinkData.levels[21].mp, 69, 'Curse Death Link level 22 MP should use sourced initial + consume total');
const deathLink = skill({ selfId: 1159, name: 'Curse Death Link', spell: true, power: 108, level: 22, distance: 900 });
const deathLinkOutcome = SkillEffects.execute(session(), caster, creature({ id: 2000319 }), deathLink, {
    magicSkill: true,
    rng: () => 0,
    attack: {
        prepareSkillDamage(actor, target, castSkill) {
            assert.strictEqual(castSkill.fetchSkillType(), C4SkillRules.DEATH_LINK, 'Curse Death Link should route as sourced DEATHLINK damage');
            return 319;
        }
    }
});
assert.strictEqual(deathLink.fetchSkillType(), C4SkillRules.DEATH_LINK, 'Curse Death Link should resolve as sourced DEATHLINK damage');
assert.strictEqual(deathLink.fetchSemantic().trait, 'dark', 'Curse Death Link should preserve sourced dark element');
assert.strictEqual(deathLink.fetchTargetKind(), 'enemy', 'Curse Death Link should resolve as an enemy nuke');
assert.strictEqual(deathLinkOutcome.damage, 319, 'Curse Death Link should execute through damage routing');

[
    { id: 46, name: 'Life Scavenge', levels: 15, target: 'corpse_mob', trait: 'magic', lastPower: 243, lastMp: 69, absorbAbs: 243 },
    { id: 70, name: 'Drain Health', levels: 53, target: 'enemy', trait: 'dark', lastPower: 108, lastMp: 52, absorbPart: 0.2 },
    { id: 1090, name: 'Life Drain', levels: 6, target: 'enemy', trait: 'dark', lastPower: 44, lastMp: 60, absorbPart: 0.8 },
    { id: 1147, name: 'Vampiric Touch', levels: 6, target: 'enemy', trait: 'dark', lastPower: 32, lastMp: 34, absorbPart: 0.4 },
    { id: 1151, name: 'Corpse Life Drain', levels: 16, target: 'corpse_mob', trait: 'dark', lastPower: 758, lastMp: 35, absorbAbs: 758 },
    { id: 1234, name: 'Vampiric Claw', levels: 28, target: 'enemy', trait: 'dark', lastPower: 108, lastMp: 103, absorbPart: 0.4 },
    { id: 1245, name: 'Steal Essence', levels: 14, target: 'enemy', trait: 'magic', lastPower: 108, lastMp: 137, absorbPart: 0.8 }
].forEach(({ id, name, levels, target, trait, lastPower, lastMp, absorbPart = 0, absorbAbs = 0 }) => {
    const data = activeSkills.find((entry) => entry.selfId === id);
    assert(data, `${name} should be present in active skills data`);
    assert.strictEqual(data.template.name, name, `${name} should preserve sourced name`);
    assert.strictEqual(data.levels.length, levels, `${name} should preserve sourced base level count`);
    assert.strictEqual(data.levels[levels - 1].power, lastPower, `${name} should preserve sourced final power`);
    assert.strictEqual(data.levels[levels - 1].mp, lastMp, `${name} should preserve sourced final MP cost`);
    const drainSkill = skill({ selfId: id, name, spell: true, power: lastPower, level: levels, distance: target === 'corpse_mob' ? 400 : 900 });
    assert.strictEqual(drainSkill.fetchSkillType(), C4SkillRules.DRAIN, `${name} should resolve as sourced DRAIN`);
    assert.strictEqual(drainSkill.fetchTargetKind(), target, `${name} should preserve sourced target semantics`);
    assert.strictEqual(drainSkill.fetchSemantic().trait, trait, `${name} should preserve sourced trait semantics`);
    assert.strictEqual(drainSkill.fetchSemantic().absorbPart, absorbPart, `${name} should preserve sourced absorbPart`);
    assert.strictEqual(drainSkill.fetchSemantic().absorbAbs, absorbAbs, `${name} should preserve sourced absorbAbs`);
    if (id === 70) {
        assert.strictEqual(data.template.distance, 600, 'Drain Health should preserve sourced castRange as skill distance');
        assert.strictEqual(data.time.hitTime, 3000, 'Drain Health should preserve sourced hitTime');
        assert.strictEqual(data.time.reuse, 15000, 'Drain Health should preserve sourced reuseDelay');
        assert.strictEqual(drainSkill.fetchSemantic().castRange, 600, 'Drain Health should preserve sourced castRange metadata');
        assert.strictEqual(drainSkill.fetchSemantic().effectRange, 1100, 'Drain Health should preserve sourced effectRange metadata');
    }
});

const drainCaster = creature({ hp: 100, maxHp: 500, mAtk: 100 });
const drainTarget = creature({ id: 2000320, hp: 1000, maxHp: 1000, mDef: 100 });
const vampiricTouch = skill({ selfId: 1147, name: 'Vampiric Touch', spell: true, power: 32, level: 6, distance: 600 });
const drainOutcome = SkillEffects.execute(session(), drainCaster, drainTarget, vampiricTouch, {
    magicSkill: true,
    rng: () => 0,
    attack: new Attack()
});
const expectedDrainDamage = Math.round(Formulas.calcMagicDamage(100, 32, 100));
const expectedDrainHeal = Formulas.calcDrainHeal({ damage: expectedDrainDamage, targetHp: 1000, absorbPart: 0.4 });
assert.strictEqual(drainOutcome.damage, expectedDrainDamage, 'Vampiric Touch should deal sourced magic drain damage');
assert.strictEqual(drainOutcome.heal, expectedDrainHeal, 'Vampiric Touch should restore sourced absorbPart of dealt HP damage');
assert.strictEqual(drainCaster.fetchHp(), 100 + expectedDrainHeal, 'Vampiric Touch should restore caster HP immediately');

const corpseCaster = creature({ hp: 100, maxHp: 500 });
corpseCaster.spiritshotLoaded = true;
let corpseDrainClearedShot = false;
const corpseLifeDrain = skill({ selfId: 1151, name: 'Corpse Life Drain', spell: true, power: 758, level: 16, distance: 400 });
const corpseDrainOutcome = SkillEffects.execute(session(), corpseCaster, creature({ id: 2000321, hp: 0, maxHp: 1000, dead: true }), corpseLifeDrain, {
    magicSkill: true,
    rng: () => 0,
    attack: {
        clearLoadedShot(actor, magic) {
            corpseDrainClearedShot = magic;
            actor.spiritshotLoaded = false;
        }
    }
});
assert.strictEqual(corpseDrainOutcome.damage, 0, 'Corpse Life Drain should not damage corpse targets');
assert.strictEqual(corpseDrainOutcome.heal, 400, 'Corpse Life Drain should restore sourced absolute HP clamped at max HP');
assert.strictEqual(corpseCaster.fetchHp(), 500, 'Corpse Life Drain should clamp caster HP at max HP');
assert.strictEqual(corpseDrainClearedShot, true, 'Corpse Life Drain should clear magic shot state after cast');

const corpseTargetGuard = new Attack();
assert.strictEqual(
    corpseTargetGuard.checkParticipants(creature({ hp: 100, maxHp: 100 }), creature({ dead: true })),
    true,
    'normal skills should still reject dead targets'
);
assert.strictEqual(
    corpseTargetGuard.checkParticipants(creature({ hp: 100, maxHp: 100 }), creature({ dead: true }), { allowDeadTarget: true }),
    false,
    'corpse-target skills should be allowed to run against dead targets'
);

const chillFlameData = activeSkills.find((entry) => entry.selfId === 1100);
assert(chillFlameData, 'Chill Flame should be present in active skills data');
assert.strictEqual(chillFlameData.levels.length, 2, 'Chill Flame should preserve sourced 2 base levels');
assert.strictEqual(chillFlameData.levels[1].power, 70, 'Chill Flame level 2 should preserve sourced land rate power 70');
assert.strictEqual(chillFlameData.levels[1].mp, 23, 'Chill Flame level 2 MP should use sourced initial + consume total');
const chillFlame = skill({ selfId: 1100, name: 'Chill Flame', spell: true, power: 70, level: 2, distance: 600, buff: 15000 });
const chillTarget = statActor();
const chillOutcome = SkillEffects.execute(session(), caster, chillTarget, chillFlame, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(chillFlame.fetchTargetKind(), 'enemy', 'Chill Flame should resolve as an enemy fire DOT');
assert.strictEqual(chillOutcome.effect.key, 'chill_flame', 'Chill Flame should apply a structured debuff effect');
assert.strictEqual(chillOutcome.effect.dot.damage, 30, 'Chill Flame level 2 should use sourced DamOverTime value 30');
assert.strictEqual(chillOutcome.effect.dot.count, 15, 'Chill Flame should use sourced 15 damage ticks');
assert.strictEqual(chillOutcome.effect.dot.intervalMs, 1000, 'Chill Flame should tick every sourced second');
EffectStore.remove(chillTarget, 'chill_flame');

const blazeQuakeData = activeSkills.find((entry) => entry.selfId === 1101);
assert(blazeQuakeData, 'Blaze Quake should be present in active skills data');
assert.strictEqual(blazeQuakeData.levels[0].power, 35, 'Blaze Quake should preserve sourced land rate power 35');
assert.strictEqual(blazeQuakeData.levels[1].mp, 68, 'Blaze Quake level 2 MP should use sourced initial + consume total');
const blazeQuake = skill({ selfId: 1101, name: 'Blaze Quake', spell: true, power: 35, level: 2, distance: -1, buff: 15000 });
const blazeTarget = statActor();
const blazeOutcome = SkillEffects.execute(session(), caster, blazeTarget, blazeQuake, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(blazeQuake.fetchTargetKind(), 'enemy', 'Blaze Quake should resolve as an enemy fire DOT');
assert.strictEqual(blazeOutcome.effect.key, 'blaze_quake', 'Blaze Quake should apply a structured debuff effect');
assert.strictEqual(blazeOutcome.effect.dot.damage, 60, 'Blaze Quake level 2 should use sourced DamOverTime value 60');
assert.strictEqual(blazeOutcome.effect.dot.count, 15, 'Blaze Quake should use sourced 15 damage ticks');
assert.strictEqual(blazeOutcome.effect.dot.intervalMs, 1000, 'Blaze Quake should tick every sourced second');
EffectStore.remove(blazeTarget, 'blaze_quake');

const auraSinkData = activeSkills.find((entry) => entry.selfId === 1102);
assert(auraSinkData, 'Aura Sink should be present in active skills data');
assert.strictEqual(auraSinkData.time.buff, 30000, 'Aura Sink should preserve sourced 30 second MDOT duration');
assert.strictEqual(auraSinkData.levels.length, 6, 'Aura Sink should preserve sourced 6 base levels');
assert.strictEqual(auraSinkData.levels[5].power, 51, 'Aura Sink level 6 should preserve sourced power 51');
assert.strictEqual(auraSinkData.levels[5].mp, 65, 'Aura Sink level 6 MP should use sourced initial + consume total');
const auraSink = skill({ selfId: 1102, name: 'Aura Sink', spell: true, power: 51, level: 6, distance: 600, buff: 30000 });
const auraSinkTarget = statActor();
const auraSinkOutcome = SkillEffects.execute(session(), caster, auraSinkTarget, auraSink, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(auraSink.fetchTargetKind(), 'enemy', 'Aura Sink should resolve as an enemy mana damage-over-time effect');
assert.strictEqual(auraSink.fetchSemantic().baseLandRate, 51, 'Aura Sink should use sourced level 6 power as land rate');
assert.strictEqual(auraSinkOutcome.effect.key, 'aura_sink', 'Aura Sink should apply a structured debuff effect');
assert.strictEqual(auraSinkOutcome.effect.manaDot.damage, 11, 'Aura Sink level 6 should use sourced ManaDamOverTime value 11');
assert.strictEqual(auraSinkOutcome.effect.manaDot.count, 10, 'Aura Sink should use sourced 10 mana damage ticks');
assert.strictEqual(auraSinkOutcome.effect.manaDot.intervalMs, 3000, 'Aura Sink should tick every sourced 3 seconds');
EffectStore.remove(auraSinkTarget, 'aura_sink');

const frostFlameData = activeSkills.find((entry) => entry.selfId === 1107);
assert(frostFlameData, 'Frost Flame should be present in active skills data');
assert.strictEqual(frostFlameData.levels[1].power, 70, 'Frost Flame level 2 should preserve sourced land rate power 70');
assert.strictEqual(frostFlameData.levels[1].mp, 40, 'Frost Flame level 2 MP should use sourced initial + consume total');
const frostFlame = skill({ selfId: 1107, name: 'Frost Flame', spell: true, power: 70, level: 2, distance: 750, buff: 15000 });
const frostTarget = statActor();
const frostOutcome = SkillEffects.execute(session(), caster, frostTarget, frostFlame, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(frostOutcome.effect.key, 'frost_flame', 'Frost Flame should apply a structured debuff effect');
assert.strictEqual(frostOutcome.effect.dot.damage, 60, 'Frost Flame level 2 should use sourced DamOverTime value 60');
assert.strictEqual(frostOutcome.effect.dot.count, 15, 'Frost Flame should use sourced 15 damage ticks');
assert.strictEqual(frostOutcome.effect.dot.intervalMs, 1000, 'Frost Flame should tick every sourced second');
EffectStore.remove(frostTarget, 'frost_flame');

const sealFlameData = activeSkills.find((entry) => entry.selfId === 1108);
assert(sealFlameData, 'Seal of Flame should be present in active skills data');
assert.strictEqual(sealFlameData.levels.length, 4, 'Seal of Flame should preserve sourced 4 base levels');
assert.strictEqual(sealFlameData.levels[3].power, 35, 'Seal of Flame level 4 should preserve sourced land rate power 35');
assert.strictEqual(sealFlameData.levels[3].mp, 153, 'Seal of Flame level 4 MP should use sourced initial + consume total');
const sealFlame = skill({ selfId: 1108, name: 'Seal of Flame', spell: true, power: 35, level: 4, distance: -1, buff: 15000 });
const sealFlameTarget = statActor();
const sealFlameOutcome = SkillEffects.execute(session(), caster, sealFlameTarget, sealFlame, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(sealFlame.fetchTargetKind(), 'enemy', 'Seal of Flame should resolve as an enemy fire DOT');
assert.strictEqual(sealFlameOutcome.effect.key, 'seal_of_flame', 'Seal of Flame should apply a structured debuff effect');
assert.strictEqual(sealFlameOutcome.effect.dot.damage, 118, 'Seal of Flame level 4 should use sourced DamOverTime value 118');
assert.strictEqual(sealFlameOutcome.effect.dot.count, 15, 'Seal of Flame should use sourced 15 damage ticks');
assert.strictEqual(sealFlameOutcome.effect.dot.intervalMs, 1000, 'Seal of Flame should tick every sourced second');
EffectStore.remove(sealFlameTarget, 'seal_of_flame');

const blazingCircleData = activeSkills.find((entry) => entry.selfId === 1171);
assert(blazingCircleData, 'Blazing Circle should be present in active skills data');
assert.strictEqual(blazingCircleData.levels.length, 19, 'Blazing Circle should preserve sourced 19 base levels');
assert.strictEqual(blazingCircleData.levels[18].power, 64, 'Blazing Circle level 19 should preserve sourced power 64');
assert.strictEqual(blazingCircleData.levels[18].mp, 103, 'Blazing Circle level 19 MP should use sourced initial + consume total');
const blazingCircle = skill({ selfId: 1171, name: 'Blazing Circle', spell: true, power: 64, level: 19, distance: -1 });
assert.strictEqual(blazingCircle.fetchSkillType(), C4SkillRules.DAMAGE, 'Blazing Circle should resolve as sourced MDAM damage');
assert.strictEqual(blazingCircle.fetchSemantic().trait, 'fire', 'Blazing Circle should preserve sourced fire element');
assert.strictEqual(blazingCircle.fetchTargetKind(), 'enemy', 'Blazing Circle should resolve as an enemy nuke');

const frostWallData = activeSkills.find((entry) => entry.selfId === 1174);
assert(frostWallData, 'Frost Wall should be present in active skills data');
assert.strictEqual(frostWallData.levels.length, 22, 'Frost Wall should preserve sourced 22 base levels');
assert.strictEqual(frostWallData.levels[21].power, 76, 'Frost Wall level 22 should preserve sourced power 76');
assert.strictEqual(frostWallData.levels[21].mp, 103, 'Frost Wall level 22 MP should use sourced initial + consume total');
const frostWall = skill({ selfId: 1174, name: 'Frost Wall', spell: true, power: 76, level: 22, distance: 50 });
assert.strictEqual(frostWall.fetchSkillType(), C4SkillRules.DAMAGE, 'Frost Wall should resolve as sourced MDAM damage');
assert.strictEqual(frostWall.fetchSemantic().trait, 'water', 'Frost Wall should preserve sourced water element');
assert.strictEqual(frostWall.fetchTargetKind(), 'enemy', 'Frost Wall should resolve as an enemy nuke');

const aquaSwirlData = activeSkills.find((entry) => entry.selfId === 1175);
assert(aquaSwirlData, 'Aqua Swirl should be present in active skills data');
assert.strictEqual(aquaSwirlData.levels.length, 8, 'Aqua Swirl should preserve sourced 8 base levels');
assert.strictEqual(aquaSwirlData.levels[7].power, 44, 'Aqua Swirl level 8 should preserve sourced power 44');
assert.strictEqual(aquaSwirlData.levels[7].mp, 30, 'Aqua Swirl level 8 MP should use sourced initial + consume total');
const aquaSwirl = skill({ selfId: 1175, name: 'Aqua Swirl', spell: true, power: 44, level: 8, distance: 750 });
assert.strictEqual(aquaSwirl.fetchSkillType(), C4SkillRules.DAMAGE, 'Aqua Swirl should resolve as sourced MDAM damage');
assert.strictEqual(aquaSwirl.fetchSemantic().trait, 'water', 'Aqua Swirl should preserve sourced water element');
assert.strictEqual(aquaSwirl.fetchTargetKind(), 'enemy', 'Aqua Swirl should resolve as an enemy nuke');

const tempestData = activeSkills.find((entry) => entry.selfId === 1176);
assert(tempestData, 'Tempest should be present in active skills data');
assert.strictEqual(tempestData.levels.length, 15, 'Tempest should preserve sourced 15 base levels');
assert.strictEqual(tempestData.levels[14].power, 54, 'Tempest level 15 should preserve sourced power 54');
assert.strictEqual(tempestData.levels[14].mp, 103, 'Tempest level 15 MP should use sourced initial + consume total');
const tempest = skill({ selfId: 1176, name: 'Tempest', spell: true, power: 54, level: 15, distance: 500 });
assert.strictEqual(tempest.fetchSkillType(), C4SkillRules.DAMAGE, 'Tempest should resolve as sourced MDAM damage');
assert.strictEqual(tempest.fetchSemantic().trait, 'wind', 'Tempest should preserve sourced wind element');
assert.strictEqual(tempest.fetchTargetKind(), 'enemy', 'Tempest should resolve as an enemy nuke');
const twisterData = activeSkills.find((entry) => entry.selfId === 1178);
assert(twisterData, 'Twister should be present in active skills data');
assert.strictEqual(twisterData.levels.length, 8, 'Twister should preserve sourced 8 base levels');
assert.strictEqual(twisterData.levels[7].power, 44, 'Twister level 8 should preserve sourced power 44');
assert.strictEqual(twisterData.levels[7].mp, 30, 'Twister level 8 MP should use sourced initial + consume total');
const twister = skill({ selfId: 1178, name: 'Twister', spell: true, power: 44, level: 8, distance: 750 });
assert.strictEqual(twister.fetchSkillType(), C4SkillRules.DAMAGE, 'Twister should resolve as sourced MDAM damage');
assert.strictEqual(twister.fetchSemantic().trait, 'wind', 'Twister should preserve sourced wind element');
assert.strictEqual(twister.fetchTargetKind(), 'enemy', 'Twister should resolve as an enemy nuke');

const flameStrikeData = activeSkills.find((entry) => entry.selfId === 1181);
assert(flameStrikeData, 'Flame Strike should be present in active skills data');
assert.strictEqual(flameStrikeData.levels.length, 3, 'Flame Strike should preserve sourced 3 base levels');
assert.strictEqual(flameStrikeData.levels[2].power, 19, 'Flame Strike level 3 should preserve sourced power 19');
assert.strictEqual(flameStrikeData.levels[2].mp, 40, 'Flame Strike level 3 MP should use sourced initial + consume total');
const flameStrike = skill({ selfId: 1181, name: 'Flame Strike', spell: true, power: 19, level: 3, distance: 500 });
assert.strictEqual(flameStrike.fetchSkillType(), C4SkillRules.DAMAGE, 'Flame Strike should resolve as sourced MDAM damage');
assert.strictEqual(flameStrike.fetchSemantic().trait, 'fire', 'Flame Strike should preserve sourced fire element');
assert.strictEqual(flameStrike.fetchTargetKind(), 'enemy', 'Flame Strike should resolve as an enemy nuke');

const freezingShackleData = activeSkills.find((entry) => entry.selfId === 1183);
assert(freezingShackleData, 'Freezing Shackle should be present in active skills data');
assert.strictEqual(freezingShackleData.levels.length, 4, 'Freezing Shackle should preserve sourced 4 base levels');
assert.strictEqual(freezingShackleData.levels[3].power, 70, 'Freezing Shackle level 4 should preserve sourced land rate power 70');
assert.strictEqual(freezingShackleData.levels[3].mp, 103, 'Freezing Shackle level 4 MP should use sourced initial + consume total');
const freezingShackle = skill({ selfId: 1183, name: 'Freezing Shackle', spell: true, power: 70, level: 4, distance: 600, buff: 15000 });
const freezingShackleTarget = statActor();
const freezingShackleOutcome = SkillEffects.execute(session(), caster, freezingShackleTarget, freezingShackle, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(freezingShackle.fetchTargetKind(), 'enemy', 'Freezing Shackle should resolve as an enemy water DOT');
assert.strictEqual(freezingShackleOutcome.effect.key, 'freezing_shackle', 'Freezing Shackle should apply a structured debuff effect');
assert.strictEqual(freezingShackleOutcome.effect.dot.damage, 118, 'Freezing Shackle level 4 should use sourced DamOverTime value 118');
assert.strictEqual(freezingShackleOutcome.effect.dot.count, 15, 'Freezing Shackle should use sourced 15 damage ticks');
assert.strictEqual(freezingShackleOutcome.effect.dot.intervalMs, 1000, 'Freezing Shackle should tick every sourced second');
EffectStore.remove(freezingShackleTarget, 'freezing_shackle');

const iceBoltData = activeSkills.find((entry) => entry.selfId === 1184);
assert(iceBoltData, 'Ice Bolt should be present in active skills data');
assert.strictEqual(iceBoltData.time.hitTime, 3100, 'Ice Bolt should preserve sourced hit time');
assert.strictEqual(iceBoltData.time.reuse, 8000, 'Ice Bolt should preserve sourced reuse');
assert.strictEqual(iceBoltData.time.buff, 120000, 'Ice Bolt should preserve sourced 120 second RunSpeedDown duration');
assert.strictEqual(iceBoltData.levels.length, 6, 'Ice Bolt should preserve sourced 6 base levels');
assert.strictEqual(iceBoltData.levels[5].power, 16, 'Ice Bolt level 6 should preserve sourced MDAM power 16');
assert.strictEqual(iceBoltData.levels[5].mp, 20, 'Ice Bolt level 6 MP should use sourced initial + consume total');
const iceBoltTarget = statActor();
const iceBolt = skill({ selfId: 1184, name: 'Ice Bolt', spell: true, power: 16, level: 6, distance: 600, buff: 120000 });
const iceBoltOutcome = SkillEffects.execute(session(), caster, iceBoltTarget, iceBolt, {
    magicSkill: true,
    rng: () => 0,
    attack: {
        clearLoadedShot() {},
        prepareSkillDamage: () => 37
    }
});
assert.strictEqual(iceBolt.fetchSkillType(), C4SkillRules.DAMAGE_EFFECT, 'Ice Bolt should resolve as sourced MDAM with additional debuff');
assert.strictEqual(iceBolt.fetchSemantic().trait, 'water', 'Ice Bolt should preserve sourced water element');
assert.strictEqual(iceBolt.fetchSemantic().baseLandRate, 60, 'Ice Bolt should use sourced effectPower 60 as debuff land rate');
assert.strictEqual(iceBoltOutcome.damage, 37, 'Ice Bolt should still deal direct MDAM damage');
assert.strictEqual(iceBoltOutcome.effect.key, 'ice_bolt', 'Ice Bolt should apply a structured slow debuff');
assert.strictEqual(EffectStats.multiplier(iceBoltTarget, 'runSpdMul'), 0.7, 'Ice Bolt should apply sourced RunSpeedDown 0.7 multiplier');
EffectStore.remove(iceBoltTarget, 'ice_bolt');

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

[
    { id: 2001, name: 'Red potion', power: 1, reuse: 0, buff: 15000, count: 3, intervalMs: 5000, heal: 2 },
    { id: 2002, name: 'Healing drug', power: 1, reuse: 0, buff: 20000, count: 4, intervalMs: 5000, heal: 1.5 },
    { id: 2031, name: 'Lesser healing potion', power: 1, reuse: 9000, buff: 14000, count: 7, intervalMs: 2000, heal: 16 },
    { id: 2032, name: 'Healing potion', power: 2, reuse: 9000, buff: 14000, count: 7, intervalMs: 2000, heal: 48 },
    { id: 2037, name: 'Greater healing potion', power: 3, reuse: 9000, buff: 14000, count: 7, intervalMs: 2000, heal: 100 }
].forEach(({ id, name, power, reuse, buff, count, intervalMs, heal: hotHeal }) => {
    const data = activeSkills.find((entry) => entry.selfId === id);
    assert(data, `${name} should be present in active skills data`);
    assert.strictEqual(data.time.reuse, reuse, `${name} active data should preserve sourced reuse`);
    assert.strictEqual(data.time.buff, buff, `${name} active data should preserve sourced HOT duration`);
    assert.strictEqual(data.levels[0].power, power, `${name} active data should preserve sourced power`);
    const target = statActor();
    const potion = skill({ selfId: id, name, spell: false, power, level: 1, distance: -1, buff });
    const outcome = SkillEffects.execute(session(), caster, target, potion, {
        magicSkill: false,
        rng: () => 0,
        attack: { clearLoadedShot() {} }
    });
    assert.strictEqual(potion.fetchSkillType(), C4SkillRules.HOT, `${name} should resolve to HOT`);
    assert.strictEqual(potion.fetchTargetKind(), 'self', `${name} should preserve sourced self target semantics`);
    assert.strictEqual(outcome.effect.hot.count, count, `${name} should use sourced heal tick count`);
    assert.strictEqual(outcome.effect.hot.intervalMs, intervalMs, `${name} should use sourced heal tick interval`);
    assert.strictEqual(outcome.effect.hot.heal, hotHeal, `${name} should use sourced HealOverTime value`);
    assert(target.effectTimers[outcome.effect.key], `${name} should start a runtime heal-over-time ticker`);
    EffectStore.remove(target, outcome.effect.key);
});

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

const npcChantLifeData = activeSkills.find((entry) => entry.selfId === 4097);
assert(npcChantLifeData, 'NPC Chant of Life should be present in active skills data');
assert.strictEqual(npcChantLifeData.template.name, 'NPC Chant of Life', 'NPC Chant of Life active data should preserve sourced name');
assert.strictEqual(npcChantLifeData.levels.length, 12, 'NPC Chant of Life active data should preserve sourced 12 levels');
assert.strictEqual(npcChantLifeData.levels[11].power, 12, 'NPC Chant of Life level 12 should preserve sourced power');
assert.strictEqual(npcChantLifeData.levels[11].mp, 262, 'NPC Chant of Life level 12 should preserve sourced MP cost');
const npcChantLifeTarget = statActor();
const npcChantLife = skill({ selfId: 4097, name: 'NPC Chant of Life', spell: true, power: 12, level: 12, buff: 15000 });
const npcChantLifeOutcome = SkillEffects.execute(session(), caster, npcChantLifeTarget, npcChantLife, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(npcChantLife.fetchSkillType(), C4SkillRules.HOT, 'NPC Chant of Life should resolve to HOT');
assert.strictEqual(npcChantLife.fetchTargetKind(), 'self', 'NPC Chant of Life should preserve sourced self target semantics');
assert.strictEqual(npcChantLifeOutcome.effect.hot.heal, 58, 'NPC Chant of Life level 12 should use sourced HealOverTime value 58');
assert.strictEqual(npcChantLifeOutcome.effect.hot.count, 5, 'NPC Chant of Life should use sourced 5 heal ticks');
assert.strictEqual(npcChantLifeOutcome.effect.hot.intervalMs, 3000, 'NPC Chant of Life should tick every sourced 3 seconds');
assert(npcChantLifeTarget.effectTimers.npc_chant_of_life, 'NPC Chant of Life should start a runtime heal-over-time ticker');
EffectStore.remove(npcChantLifeTarget, 'npc_chant_of_life');

const bleedData = activeSkills.find((entry) => entry.selfId === 96);
assert(bleedData, 'Bleed should be present in active skills data');
assert.strictEqual(bleedData.template.distance, 40, 'Bleed should preserve sourced castRange 40');
assert.strictEqual(bleedData.levels.length, 6, 'Bleed should preserve sourced 6 base levels');
assert.strictEqual(bleedData.levels[0].power, 3, 'Bleed level 1 should preserve sourced power 3');
assert.strictEqual(bleedData.levels[5].power, 8, 'Bleed level 6 should preserve sourced power 8');
assert.strictEqual(bleedData.levels[5].mp, 99, 'Bleed level 6 should preserve sourced mpConsume 99');
const bleed = skill({ selfId: 96, name: 'Bleed', spell: false, power: 6, level: 4, buff: 20000, distance: 40 });
const bleedTarget = statActor();
const bleedOutcome = SkillEffects.execute(session(), caster, bleedTarget, bleed, {
    magicSkill: false,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(bleed.fetchTargetKind(), 'enemy', 'Bleed should resolve as an enemy debuff');
assert.strictEqual(bleed.fetchSemantic().baseLandRate, 6, 'Bleed level 4 should use sourced power 6 as land rate');
assert.strictEqual(bleed.fetchSemantic().levelDepend, 2, 'Bleed should preserve sourced lvlDepend metadata');
assert.strictEqual(bleed.fetchSemantic().castRange, 40, 'Bleed should preserve sourced castRange metadata');
assert.strictEqual(bleed.fetchSemantic().effectRange, 400, 'Bleed should preserve sourced effectRange metadata');
assert.deepStrictEqual(bleed.fetchSemantic().requires, { weaponsAllowed: 16 }, 'Bleed should preserve sourced weaponsAllowed requirement');
assert.strictEqual(bleedOutcome.effect.dot.count, 4, 'Bleed should use the sourced 4 tick duration');
assert.strictEqual(bleedOutcome.effect.dot.intervalMs, 5000, 'Bleed should tick every sourced 5 seconds');
assert.strictEqual(bleedOutcome.effect.dot.damage, 27, 'Bleed should use the sourced damage table instead of local flat power');

const sanctuaryData = activeSkills.find((entry) => entry.selfId === 97);
assert(sanctuaryData, 'Sanctuary should be present in active skills data');
assert.strictEqual(sanctuaryData.time.hitTime, 1500, 'Sanctuary should preserve sourced 1500ms hit time');
assert.strictEqual(sanctuaryData.time.reuse, 8000, 'Sanctuary should preserve sourced 8000ms reuse');
assert.strictEqual(sanctuaryData.time.buff, 60000, 'Sanctuary should preserve sourced 60 second debuff duration');
assert.strictEqual(sanctuaryData.levels.length, 11, 'Sanctuary should preserve sourced 11 base levels');
assert.strictEqual(sanctuaryData.levels[0].power, 40, 'Sanctuary should use sourced power 40 as land rate');
assert.strictEqual(sanctuaryData.levels[10].mp, 102, 'Sanctuary level 11 should preserve sourced mpConsume 102');
const sanctuary = skill({ selfId: 97, name: 'Sanctuary', spell: false, power: 40, level: 11, buff: 60000, distance: -1 });
const livingSanctuaryTarget = statActor();
const livingSanctuaryOutcome = SkillEffects.execute(session(), caster, livingSanctuaryTarget, sanctuary, {
    magicSkill: false,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(sanctuary.fetchTargetKind(), 'enemy', 'Sanctuary should resolve as an enemy debuff');
assert.strictEqual(sanctuary.fetchSemantic().sourceTarget, 'aura', 'Sanctuary should preserve sourced TARGET_AURA_UNDEAD aura semantics');
assert.strictEqual(sanctuary.fetchSemantic().radius, 200, 'Sanctuary should preserve sourced skillRadius 200');
assert.strictEqual(sanctuary.fetchSemantic().baseLandRate, 40, 'Sanctuary should use sourced power 40 as land rate');
assert.strictEqual(sanctuary.fetchSemantic().levelDepend, 2, 'Sanctuary should preserve sourced lvlDepend metadata');
assert.strictEqual(sanctuary.fetchSemantic().undeadOnly, true, 'Sanctuary should preserve sourced TARGET_AURA_UNDEAD restriction');
assert.strictEqual(livingSanctuaryOutcome.effect, null, 'Sanctuary should not affect living targets');
assert.strictEqual(livingSanctuaryOutcome.effectResisted, true, 'Sanctuary should reject living targets through TARGET_AURA_UNDEAD');
const undeadSanctuaryTarget = statActor();
undeadSanctuaryTarget.fetchUndead = () => true;
const undeadSanctuaryOutcome = SkillEffects.execute(session(), caster, undeadSanctuaryTarget, sanctuary, {
    magicSkill: false,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(undeadSanctuaryOutcome.effect.key, 'sanctuary', 'Sanctuary should apply a structured debuff to undead targets');
assert.strictEqual(EffectStats.multiplier(undeadSanctuaryTarget, 'pAtkMul'), 0.77, 'Sanctuary should use sourced pAtkDown 0.77');

const swordSymphonyData = activeSkills.find((entry) => entry.selfId === 98);
assert(swordSymphonyData, 'Sword Symphony should be present in active skills data');
assert.strictEqual(swordSymphonyData.template.distance, -1, 'Sword Symphony should preserve sourced TARGET_AURA self-centered range');
assert.strictEqual(swordSymphonyData.time.buff, 30000, 'Sword Symphony should preserve sourced 30 second fear duration');
assert.strictEqual(swordSymphonyData.levels.length, 5, 'Sword Symphony should preserve sourced 5 base levels');
assert.strictEqual(swordSymphonyData.levels[0].power, 229, 'Sword Symphony level 1 should preserve sourced PDAM power 229');
assert.strictEqual(swordSymphonyData.levels[4].power, 432, 'Sword Symphony level 5 should preserve sourced PDAM power 432');
assert.strictEqual(swordSymphonyData.levels[4].mp, 160, 'Sword Symphony level 5 should preserve sourced mpConsume 160');
const swordSymphonyTarget = statActor();
const swordSymphony = skill({ selfId: 98, name: 'Sword Symphony', spell: false, power: 432, level: 5, buff: 30000, distance: -1 });
const swordSymphonyOutcome = SkillEffects.execute(session(), caster, swordSymphonyTarget, swordSymphony, {
    magicSkill: false,
    rng: () => 0,
    attack: {
        clearLoadedShot() {},
        prepareSkillDamage: () => 123
    }
});
assert.strictEqual(swordSymphony.fetchSkillType(), C4SkillRules.DAMAGE_EFFECT, 'Sword Symphony should resolve as sourced PDAM plus fear');
assert.strictEqual(swordSymphony.fetchTargetKind(), 'enemy', 'Sword Symphony should resolve as an enemy aura damage-effect');
assert.strictEqual(swordSymphony.fetchSsBoost(), 1, 'Sword Symphony should preserve sourced physical shot boost semantics');
assert.strictEqual(swordSymphony.fetchSemantic().sourceTarget, 'aura', 'Sword Symphony should preserve sourced TARGET_AURA semantics');
assert.strictEqual(swordSymphony.fetchSemantic().radius, 150, 'Sword Symphony should preserve sourced skillRadius 150');
assert.strictEqual(swordSymphony.fetchSemantic().baseLandRate, 15, 'Sword Symphony should use sourced effectPower 15 as fear land rate');
assert.strictEqual(swordSymphonyOutcome.damage, 123, 'Sword Symphony should keep its physical damage component');
assert.strictEqual(swordSymphonyOutcome.effect.key, 'fear', 'Sword Symphony should apply its structured fear effect');
EffectStore.remove(swordSymphonyTarget, 'fear');
const cureBleeding = skill({ selfId: 61, name: 'Cure Bleeding', spell: true, power: 7, level: 2 });
const cureBleedOutcome = SkillEffects.execute(session(), caster, bleedTarget, cureBleeding, {
    magicSkill: true,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(cureBleedOutcome.cleansed.length, 1, 'Cure Bleeding should remove matching bleed effects');
assert.strictEqual(EffectStore.hasDebuff(bleedTarget, 'bleed'), false, 'Cure Bleeding should clear bleed debuff state');
const cureBleedingData = activeSkills.find((entry) => entry.selfId === 61);
assert(cureBleedingData, 'Cure Bleeding should be present in active skills data');
assert.strictEqual(cureBleedingData.levels.length, 3, 'Cure Bleeding active data should preserve sourced 3 levels');
assert.strictEqual(cureBleedingData.levels[2].power, 9, 'Cure Bleeding level 3 active data should preserve sourced negatePower 9');
assert.strictEqual(cureBleedingData.levels[2].mp, 55, 'Cure Bleeding level 3 active data should combine sourced initial and consume MP');
const severeBleedTarget = statActor();
EffectStore.apply(severeBleedTarget, { key: 'severe_bleed', id: 96, level: 9, type: 'debuff', category: 'bleed', durationMs: 30000 });
const maxCureBleeding = skill({ selfId: 61, name: 'Cure Bleeding', spell: true, power: 9, level: 3 });
const maxCureBleedOutcome = SkillEffects.execute(session(), caster, severeBleedTarget, maxCureBleeding, {
    magicSkill: true,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(maxCureBleedOutcome.cleansed.length, 1, 'Cure Bleeding level 3 should cleanse bleed up to sourced negatePower 9');
assert.strictEqual(EffectStore.hasDebuff(severeBleedTarget, 'severe_bleed'), false, 'Cure Bleeding level 3 should clear high-level bleed within sourced negatePower 9');

const remedyData = activeSkills.find((entry) => entry.selfId === 44);
assert(remedyData, 'Remedy should be present in active skills data');
assert.strictEqual(remedyData.levels.length, 3, 'Remedy active data should preserve sourced 3 levels');
assert.strictEqual(remedyData.levels[2].power, 9, 'Remedy level 3 active data should preserve sourced negatePower 9');
assert.strictEqual(remedyData.levels[2].mp, 55, 'Remedy level 3 active data should combine sourced initial and consume MP');
const classBandageData = activeSkills.find((entry) => entry.selfId === 34);
assert(classBandageData, 'Class Bandage should be present in active skills data');
assert.strictEqual(classBandageData.levels.length, 3, 'Class Bandage active data should preserve sourced 3 levels');
assert.strictEqual(classBandageData.levels[0].power, 3, 'Class Bandage level 1 should preserve sourced negatePower 3');
assert.strictEqual(classBandageData.levels[2].power, 9, 'Class Bandage level 3 should preserve sourced negatePower 9');
assert.strictEqual(classBandageData.levels[2].mp, 55, 'Class Bandage level 3 MP should use sourced mpConsume 55');
const bandageData = activeSkills.find((entry) => entry.selfId === 2044);
assert(bandageData, 'Bandage should be present in active skills data');
assert.strictEqual(bandageData.levels[0].power, 3, 'Bandage active data should preserve sourced negatePower 3');
const emergencyDressingData = activeSkills.find((entry) => entry.selfId === 2045);
assert(emergencyDressingData, 'Emergency dressing should be present in active skills data');
assert.strictEqual(emergencyDressingData.levels[0].power, 7, 'Emergency dressing active data should preserve sourced negatePower 7');
const bleedCleanseTarget = statActor();
EffectStore.apply(bleedCleanseTarget, { key: 'minor_bleed', id: 96, level: 3, type: 'debuff', category: 'bleed', durationMs: 30000 });
EffectStore.apply(bleedCleanseTarget, { key: 'major_bleed', id: 96, level: 9, type: 'debuff', category: 'bleed', durationMs: 30000 });
const bandage = skill({ selfId: 2044, name: 'Bandage', spell: false, power: 3, level: 1, distance: -1 });
const bandageOutcome = SkillEffects.execute(session(), caster, bleedCleanseTarget, bandage, {
    magicSkill: false,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(bandage.fetchSkillType(), C4SkillRules.CLEANSE, 'Bandage should resolve to sourced NEGATE/CLEANSE');
assert.strictEqual(bandageOutcome.cleansed.length, 1, 'Bandage should cleanse bleed up to sourced negatePower 3 only');
assert.strictEqual(EffectStore.hasDebuff(bleedCleanseTarget, 'minor_bleed'), false, 'Bandage should remove low-level bleed');
assert.strictEqual(EffectStore.hasDebuff(bleedCleanseTarget, 'major_bleed'), true, 'Bandage should not remove bleed above sourced negatePower 3');
const classBandageTarget = statActor();
EffectStore.apply(classBandageTarget, { key: 'strong_bleed', id: 96, level: 9, type: 'debuff', category: 'bleed', durationMs: 30000 });
const classBandage = skill({ selfId: 34, name: 'Bandage', spell: false, power: 9, level: 3, distance: -1 });
const classBandageOutcome = SkillEffects.execute(session(), caster, classBandageTarget, classBandage, {
    magicSkill: false,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(classBandage.fetchSkillType(), C4SkillRules.CLEANSE, 'Class Bandage should resolve to sourced NEGATE/CLEANSE');
assert.strictEqual(classBandageOutcome.cleansed.length, 1, 'Class Bandage level 3 should cleanse bleed up to sourced negatePower 9');
assert.strictEqual(EffectStore.hasDebuff(classBandageTarget, 'strong_bleed'), false, 'Class Bandage level 3 should remove high-level bleed within sourced negatePower 9');
const remedy = skill({ selfId: 44, name: 'Remedy', spell: true, power: 9, level: 3, distance: -1 });
const remedyOutcome = SkillEffects.execute(session(), caster, bleedCleanseTarget, remedy, {
    magicSkill: true,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(remedy.fetchSkillType(), C4SkillRules.CLEANSE, 'Remedy should resolve to sourced NEGATE/CLEANSE');
assert.strictEqual(remedyOutcome.cleansed.length, 1, 'Remedy level 3 should cleanse bleed up to sourced negatePower 9');
assert.strictEqual(EffectStore.hasDebuff(bleedCleanseTarget, 'major_bleed'), false, 'Remedy level 3 should remove level 9 bleed');

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

const sealDespairData = activeSkills.find((entry) => entry.selfId === 1366);
assert(sealDespairData, 'Seal of Despair should be present in active skills data');
assert.strictEqual(sealDespairData.levels.length, 1, 'Seal of Despair active data should preserve sourced single base level');
assert.strictEqual(sealDespairData.levels[0].power, 40, 'Seal of Despair active data should preserve sourced power 40');
assert.strictEqual(sealDespairData.levels[0].mp, 107, 'Seal of Despair active data should combine sourced initial and consume MP');
assert.strictEqual(sealDespairData.time.reuse, 300000, 'Seal of Despair active data should preserve sourced reuse');
const sealDespairTarget = statActor();
const sealDespair = skill({ selfId: 1366, name: 'Seal of Despair', spell: true, power: 40, level: 1, distance: -1, buff: 120000 });
const sealDespairOutcome = SkillEffects.execute(session(), caster, sealDespairTarget, sealDespair, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(sealDespair.fetchTargetKind(), 'enemy', 'Seal of Despair should resolve as an enemy debuff');
assert.strictEqual(sealDespairOutcome.effect.key, 'seal_of_despair', 'Seal of Despair should apply a structured debuff');
assert.strictEqual(EffectStats.multiplier(sealDespairTarget, 'pAtkMul'), 0.9, 'Seal of Despair should use sourced pAtk 0.9');
assert.strictEqual(EffectStats.multiplier(sealDespairTarget, 'runSpdMul'), 0.8, 'Seal of Despair should use sourced runSpd 0.8');
assert.strictEqual(EffectStats.multiplier(sealDespairTarget, 'mDefMul'), 0.7, 'Seal of Despair should use sourced mDef 0.7');
assert.strictEqual(EffectStats.multiplier(sealDespairTarget, 'pAtkSpdMul'), 0.7, 'Seal of Despair should use sourced pAtkSpd 0.7');
assert.strictEqual(EffectStats.multiplier(sealDespairTarget, 'pCritRateMul'), 0.7, 'Seal of Despair should use sourced rCrit base multiplier 0.7');
assert.strictEqual(EffectStats.multiplier(sealDespairTarget, 'pCritDamageMul'), 0.7, 'Seal of Despair should use sourced cAtk 0.7');
assert.strictEqual(EffectStats.add(sealDespairTarget, 'pAccuracyCombatAdd'), -6, 'Seal of Despair should use sourced accCombat -6');
calculateStats({}, sealDespairTarget);
assert.strictEqual(sealDespairTarget.collectivePAtk, Math.round(Formulas.calcPAtk(20, 30, 100) * 0.9), 'Seal of Despair should reduce physical attack');
assert.strictEqual(sealDespairTarget.collectiveMDef, Math.round(Formulas.calcMDef(20, 30, 80) * 0.7), 'Seal of Despair should reduce magic defense');
assert.strictEqual(sealDespairTarget.collectiveAtkSpd, Math.round(Formulas.calcAtkSpd(30, 300) * 0.7), 'Seal of Despair should reduce attack speed');
assert.strictEqual(sealDespairTarget.collectiveRunSpd, Math.round(Formulas.calcSpeed(30, 120) * 0.8), 'Seal of Despair should reduce run speed');
assert.strictEqual(sealDespairTarget.collectiveCritical, Formulas.calcCritical(30, 40) * 0.7, 'Seal of Despair should reduce physical critical rate');

const sealDiseaseData = activeSkills.find((entry) => entry.selfId === 1367);
assert(sealDiseaseData, 'Seal of Disease should be present in active skills data');
assert.strictEqual(sealDiseaseData.levels.length, 1, 'Seal of Disease active data should preserve sourced single base level');
assert.strictEqual(sealDiseaseData.levels[0].power, 40, 'Seal of Disease active data should preserve sourced power 40');
assert.strictEqual(sealDiseaseData.levels[0].mp, 105, 'Seal of Disease active data should combine sourced initial and consume MP');
assert.strictEqual(sealDiseaseData.time.reuse, 60000, 'Seal of Disease active data should preserve sourced reuse');
const sealDiseaseTarget = statActor();
const sealDisease = skill({ selfId: 1367, name: 'Seal of Disease', spell: true, power: 40, level: 1, distance: 600, buff: 120000 });
const sealDiseaseOutcome = SkillEffects.execute(session(), caster, sealDiseaseTarget, sealDisease, {
    magicSkill: true,
    rng: () => 0,
    attack: { clearLoadedShot() {} }
});
assert.strictEqual(sealDisease.fetchTargetKind(), 'enemy', 'Seal of Disease should resolve as an enemy debuff');
assert.strictEqual(sealDiseaseOutcome.effect.key, 'seal_of_disease', 'Seal of Disease should apply a structured regen debuff');
assert.strictEqual(EffectStats.multiplier(sealDiseaseTarget, 'regHp'), 0.5, 'Seal of Disease should use sourced gainHp 0.5');
assert.strictEqual(EffectStats.multiplier(sealDiseaseTarget, 'cancelVuln'), 1.3, 'Seal of Disease should use sourced cancelVuln 1.3');
assert.strictEqual(regenAutomation.fetchRevHpAmount(sealDiseaseTarget), 5, 'Seal of Disease should halve runtime HP regeneration');

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
