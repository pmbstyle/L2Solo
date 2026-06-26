const assert = require('assert');

require('../src/Global');

const SkillModel = invoke('GameServer/Model/Skill');
const SkillEffects = invoke('GameServer/Skills/C4SkillEffects');
const EffectStore = invoke('GameServer/Effects/EffectStore');
const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');
const calculateStats = invoke('GameServer/Actor/Generics/CalculateStats');
const Formulas = invoke('GameServer/Formulas');

function creature(overrides = {}) {
    return {
        hp: overrides.hp ?? 100,
        maxHp: overrides.maxHp ?? 100,
        level: overrides.level ?? 20,
        effects: {},
        soulshotLoaded: false,
        spiritshotLoaded: false,
        fetchId: () => overrides.id ?? 2000001,
        fetchName: () => overrides.name || 'Actor',
        fetchLevel() { return this.level; },
        fetchHp() { return this.hp; },
        fetchMaxHp() { return this.maxHp; },
        fetchMp: () => 100,
        fetchMaxMp: () => 100,
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
