const assert = require('assert');

require('../src/Global');
invoke('GameServer/DataCache').init();

const DataCache = invoke('GameServer/DataCache');
const Formulas = invoke('GameServer/Formulas');
const HitRules = invoke('GameServer/Combat/HitRules');
const CombatantView = invoke('GameServer/Combat/CombatantView');
const NpcSkills = invoke('GameServer/Npc/NpcSkills');
const NpcCombatChoice = invoke('GameServer/Npc/NpcCombatChoice');
const ColdCombatProfile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const BackgroundResolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const HuntCycle = invoke('GameServer/Bot/AI/HuntCycle');

const constant = value => () => value;

// A shield that blocks adds its defence (one rule, hot and cold).
const attacker = CombatantView.view({ pAtk: 1000, critRate: 0 });
const bare = CombatantView.view({ pDef: 400, dex: 30 });
const shielded = CombatantView.view({ pDef: 400, dex: 30, shieldPDef: 300, shieldRate: 90 });
const open = HitRules.melee(attacker, bare, {}, constant(0.5)).damage;
const blocked = HitRules.melee(attacker, shielded, {}, constant(0.5));
assert.strictEqual(blocked.shield, Formulas.SHIELD_DEFENSE_SUCCEED);
assert(blocked.damage < open, `a blocked hit lands less (${blocked.damage} vs ${open})`);
assert.strictEqual(HitRules.melee(attacker, shielded, { facing: false }, constant(0.5)).shield, Formulas.SHIELD_DEFENSE_FAILED,
    'a shield behind the defender blocks nothing');

// A physical skill crits by its own base rate and STR, a skill without one never.
assert.strictEqual(HitRules.physicalSkillCritRate({}, 40), 0);
assert(HitRules.physicalSkillCritRate({ baseCritRate: 15 }, 40) > HitRules.physicalSkillCritRate({ baseCritRate: 15 }, 20));

// The monster's choice: a self buff it lacks first, no control on a held target, a debuff only after its gap.
function fakeSkill(id, semantic, extra = {}) {
    return { fetchSelfId: () => id, fetchSemantic: () => semantic, fetchConsumedMp: () => 0, fetchDistance: () => 40,
        fetchTargetKind: () => extra.target || 'enemy', fetchSpell: () => false, fetchSkillType: () => extra.type || 'pdam' };
}
const stun = fakeSkill(1, { effect: 'stun' });
const buff = fakeSkill(2, { effect: 'might', effectType: 'buff' }, { target: 'self', type: 'buff' });
const debuff = fakeSkill(3, { effect: 'poison', effectType: 'debuff' });
const choose = (skills, options = {}) => NpcCombatChoice.select({ skills, usable: () => true, buffNeeded: () => true,
    hasTarget: true, impairments: {}, aiType: 'fighter', targetAiType: 'fighter', debuffReady: true, rng: constant(0), ...options });
assert.strictEqual(choose([stun, buff]).category, 'buff', 'a missing self buff comes first');
assert.strictEqual(choose([stun]).category, 'hard_control');
assert.strictEqual(choose([stun], { impairments: { disabled: true } }), null, 'a held target is not stunned again');
assert.strictEqual(choose([debuff], { debuffReady: false }), null, 'a debuff waits out its gap');

// The cold monster casts its own skills, as the hot one: a stun that lands holds the bot.
function mobWith(category) {
    for (const npc of DataCache.npcs) {
        if (npc.template?.type !== 'L2Monster' && npc.template?.type !== undefined) continue;
        const skills = NpcSkills.combatSkillsFor({ fetchSelfId: () => npc.selfId });
        if (skills.some(skill => NpcCombatChoice.category(skill) === category && Number(skill.fetchSemantic?.()?.durationMs) > 0
            && skill.fetchConsumedMp() <= 100)) {
            return ColdCombatProfile.npcForSpot({ id: 'stun_test', avgLevel: npc.template?.level || 1,
                npcEntries: [{ selfId: npc.selfId, count: 1 }] }, constant(0));
        }
    }
    return null;
}
const stunner = mobWith('hard_control');
assert(stunner, 'the datapack has a monster with a stun');
const bot = HuntCycle.referenceState(1, Math.max(1, stunner.level));
const fighter = { state: bot, profile: ColdCombatProfile.profileFor(bot, 0, { store: false }), readyAt: 0 };
const { coldMobFight, coldMobAction, coldMobFightSave } = BackgroundResolver.combat;
const fight = coldMobFight(stunner);
const before = { pDef: stunner.pDef, pAtk: stunner.pAtk, mDef: stunner.mDef };
let time = 0;
for (let step = 0; step < 4 && !(fighter.readyAt > time); step++) {
    const action = coldMobAction(stunner, fight, fighter, { time, at: 0, rng: constant(0) });
    assert.strictEqual(action.damage, 0, 'a self buff or a stun deals no damage');
    time += action.delayMs;
}
assert(['pDef', 'pAtk', 'mDef'].some(stat => stunner[stat] !== before[stat]), 'the monster\'s self buff changes its numbers');
assert(fighter.readyAt > time, 'a landed stun holds the bot');
// A held bot is not stunned again: the monster hits it.
assert(coldMobAction(stunner, fight, fighter, { time, at: 0, rng: constant(0) }).damage > 0, 'the monster strikes a held bot');
// The next slice of the fight keeps the monster's buff, reuse and hold: it strikes again.
const resumed = coldMobFight(stunner, coldMobFightSave(fight, time));
assert(coldMobAction(stunner, resumed, fighter, { time: 0, at: 0, rng: constant(0) }).damage > 0,
    'a resumed fight neither re-buffs nor re-stuns at once');
// A damage spell is marked as one (the hunt tables split spell damage, over M.Def,
// from hits, over P.Def: HuntCycle); a hit is not.
const caster = (() => {
    for (const npc of DataCache.npcs) {
        if (npc.template?.type !== 'L2Monster' && npc.template?.type !== undefined) continue;
        const skills = NpcSkills.combatSkillsFor({ fetchSelfId: () => npc.selfId });
        if (skills.length && skills.every(skill => NpcCombatChoice.category(skill) === 'damage' && skill.fetchSpell?.() === true
            && skill.fetchConsumedMp() <= 100)) {
            return ColdCombatProfile.npcForSpot({ id: 'nuke_test', avgLevel: npc.template?.level || 1,
                npcEntries: [{ selfId: npc.selfId, count: 1 }] }, constant(0));
        }
    }
    return null;
})();
assert(caster, 'the datapack has a monster whose only skills are damage spells');
const casterBot = HuntCycle.referenceState(1, Math.max(1, caster.level));
const casterTarget = { state: casterBot, profile: ColdCombatProfile.profileFor(casterBot, 0, { store: false }), readyAt: 0 };
const casterFight = coldMobFight(caster);
const nuke = coldMobAction(caster, casterFight, casterTarget, { time: 0, at: 0, rng: constant(0) });
assert(nuke.damage > 0 && nuke.spell === true, 'a damage spell is marked as one');
casterFight.mp = 0;
assert(!coldMobAction(caster, casterFight, casterTarget, { time: 5000, at: 0, rng: constant(0) }).spell, 'a hit is not a spell');

// A blow that needs a critical lands by position and DEX; one that needs the rear never lands in front.
const deadly = { requires: { condition: 0x10 } }, backstab = { requires: { condition: 0x08 } };
assert.strictEqual(HitRules.blowLandChance(deadly, { dex: 20, front: true }), 50);
assert.strictEqual(HitRules.blowLandChance(deadly, { dex: 20, behind: true }), 70);
assert.strictEqual(HitRules.blowLands(deadly, { dex: 20, front: true }, constant(0.6)), false);
assert.strictEqual(HitRules.blowLands(backstab, { dex: 40, front: true }, constant(0)), false);
assert.strictEqual(HitRules.blowLands({}, {}, () => assert.fail('a plain blow does not roll')), true);
// The cold fight strikes the mob's face: a Deadly Blow misses there when the roll is above its chance.
const Rules = invoke('GameServer/Skills/C4SkillRules');
assert.strictEqual(Rules.resolve({ selfId: 263, level: 1 }).skillType, Rules.BLOW);
const dagger = { profile: { pAtk: 1000, mAtk: 100, accur: 100, critical: 0, mCritRate: 0, dex: 20, str: 20,
    equipment: { pAtkRnd: 0 } }, charges: 0 };
const strike = rng => BackgroundResolver.combat.attackDamage(dagger, { skill: { selfId: 263, level: 1 }, magic: false, power: 1000 },
    { pDef: 500, mDef: 300, evasion: 0 }, constant(rng));
assert.strictEqual(strike(0.6), 0, 'a frontal Deadly Blow above 50% misses');
assert(strike(0.4) > 0, 'a frontal Deadly Blow below 50% lands');

console.log('Combat core checks passed');
