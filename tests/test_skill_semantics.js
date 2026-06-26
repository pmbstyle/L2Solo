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
const sealBinding = skill({ selfId: 1208, name: 'Seal of Binding', spell: true, power: 1, level: 1, distance: -1, buff: 30000 });
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
