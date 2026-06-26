const assert = require('assert');

require('../src/Global');

const SkillModel = invoke('GameServer/Model/Skill');
const SkillEffects = invoke('GameServer/Skills/C4SkillEffects');
const EffectStore = invoke('GameServer/Effects/EffectStore');
const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');

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

console.log('Skill semantic checks passed');
