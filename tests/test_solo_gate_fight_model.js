const assert = require('assert');

require('../src/Global');
invoke('GameServer/DataCache').init();

// The solo gate judges the fight the bot meets (T106): its hits are the
// fight's rules in expectation, the monster's actions its rolled ones, a
// servitor strikes after its cast, a pull worn down by area skills keeps
// its mobs standing, and a bot that pulls a melee monster strikes first.
const DataCache = invoke('GameServer/DataCache');
const Formulas = invoke('GameServer/Formulas');
const HitRules = invoke('GameServer/Combat/HitRules');
const CombatantView = invoke('GameServer/Combat/CombatantView');
const Cold = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Mob = invoke('GameServer/Bot/Population/ColdMobAction');
const Matchup = invoke('GameServer/Bot/AI/BotTargetMatchup');
const Pull = invoke('GameServer/Bot/AI/BotPullEstimate');

function mulberry(seed) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const mean = (n, roll) => { let sum = 0; for (let i = 0; i < n; i++) sum += roll(); return sum / n; };
const near = (actual, expected, share, message) => assert(Math.abs(actual - expected) <= share * expected,
    `${message}: ${actual} vs ${expected}`);

// 1. The expected hit is the mean of the rolled one: shield, critical, shot, spread.
{
    const rng = mulberry(7);
    const attacker = CombatantView.view({ pAtk: 900, pAtkRnd: 10, critRate: 150, critDamageMul: 1.2, mAtk: 400, mCritRate: 60 });
    const defender = CombatantView.view({ pDef: 500, mDef: 300, dex: 30, shieldPDef: 200, shieldRate: 40 });
    near(mean(40000, () => HitRules.melee(attacker, defender, { soulshot: true, spreadRng: rng }, rng).damage),
        HitRules.expectedMelee(attacker, defender, { soulshot: true }), 0.02, 'melee');
    near(mean(40000, () => HitRules.physicalSkill(attacker, defender, { power: 600, soulshot: true, skillCritRate: 200 }, rng).damage),
        HitRules.expectedPhysicalSkill(attacker, defender, { power: 600, soulshot: true, skillCritRate: 200 }), 0.02, 'physical skill');
    near(mean(40000, () => HitRules.magicSkill(attacker, defender, { power: 50, spiritshot: true }, rng).damage),
        HitRules.expectedMagicSkill(attacker, defender, { power: 50, spiritshot: true }), 0.02, 'magic skill');
    const shield = { shieldRate: 40, dex: 30, perfectBlockRate: 5 };
    const rolls = Array.from({ length: 40000 }, () => Formulas.rollShieldUse(shield, rng));
    const chances = Formulas.shieldChances(shield);
    near(rolls.filter(r => r === Formulas.SHIELD_DEFENSE_SUCCEED).length / rolls.length, chances.succeed, 0.03, 'shield blocks');
    near(rolls.filter(r => r === Formulas.SHIELD_DEFENSE_PERFECT_BLOCK).length / rolls.length, chances.perfect, 0.1, 'perfect blocks');
}

// A gladiator-like fighter against a level 40 melee monster of the data.
const npc = DataCache.npcs.find(n => n.template?.kind === 'Monster' && n.template.level === 40
    && Number(n.stats?.atkRadius) < 200 && Number(n.speed?.run) > 0 && Mob.meleeOnly(Cold.npcCombatStats(n)));
const mob = Cold.npcCombatStats(npc);
const fighter = { classId: 2, level: 40, role: 'dps', pAtk: 300, atkSpd: 330, accur: 70, evasion: 40, critical: 80, dex: 30, str: 40,
    maxHp: 3000, maxMp: 500, pDef: 400, mDef: 300, castSpd: 333, skills: [], equipment: { weaponKind: 'Weapon.Dual', pAtkRnd: 10 } };
const ratio = (profiles, target = mob) => Matchup.soloSurvival(profiles, target).survivalRatio;

// 2. A loaded soulshot doubles the fighter's hits; the target's evasion and the bot's own cut the hits that land.
assert(ratio([{ ...fighter, shot: { soulshot: true } }]) > 1.8 * ratio([fighter]), 'a soulshot counts');
// (Hit chances off their caps: 80% + 2% per point of accuracy over evasion.)
const even = { ...fighter, accur: mob.evasion, evasion: mob.accur };
assert(ratio([even], { ...mob, evasion: mob.evasion + 10 }) < ratio([even]), 'the target evades');
assert(ratio([{ ...even, evasion: even.evasion + 10 }]) > ratio([even]), 'the bot evades');

// 3. A monster's damage skills count as the fight rolls them (more than its weapon alone).
{
    const caster = DataCache.npcs.map(n => Cold.npcCombatStats(n)).find(m => m.level >= 30 && m.level <= 60
        && Mob.coldMobFight(m).skills.some(s => s.fetchTargetKind?.() === 'enemy' && s.fetchSpell?.() === true
            && invoke('GameServer/Npc/NpcCombatChoice').category(s) === 'damage'));
    const target = { profile: { ...fighter } };
    assert(Mob.actionMix(caster, target).perSecond > Mob.actionMix({ ...caster, selfId: 0 }, target).perSecond,
        'the spells add to the weapon');
}

// 4. A servitor still to be raised strikes after its cast; a raised one at once.
{
    const owner = { ...fighter, classId: 14, role: 'mage', pAtk: 50, skills: [] };
    const pet = { pAtk: 400, atkSpd: 280, accur: 60, critical: 40, maxHp: 2000, pDef: 300, role: 'dps', skills: [],
        soloDamageReceiver: false, servitor: true };
    assert(ratio([owner, { ...pet, summonCastMs: 8000 }]) < ratio([owner, pet]), 'the cast comes first');
    assert(ratio([owner, pet]) > ratio([owner]), 'a raised servitor strikes');
}

// 5. A pull worn down by area skills hits as all its mobs: the pack grows to k.
assert.strictEqual(Pull.packFactor(3, 0), 2);
assert.strictEqual(Pull.packFactor(3, 1), 3);
{
    const view = Pull.pullView(mob, 3);
    assert.strictEqual(view.pAtk, mob.pAtk * 2);
    assert.strictEqual(Pull.repack(view, 1).pAtk, mob.pAtk * 3);
    const sweep = { selfId: 1, level: 40, power: 80, mp: 10, hitTime: 1000, reuse: 1000, spell: false,
        semantic: { skillType: 'damage', target: 'enemy', power: 80, sourceTarget: 'aura' } };
    const sweeper = { ...fighter, skills: [sweep] };
    const result = Matchup.soloSurvival([sweeper], view);
    assert(result.areaShare > 0, 'the area skill carries the fight');
    // Judged with the one-by-one pack (a view that cannot be repacked), the same fight looks safer.
    assert(result.survivalRatio < Matchup.soloSurvival([sweeper], { ...view, unitPAtk: undefined }).survivalRatio,
        'its mobs stand together longer');
}

// 6. A bow strikes while a melee monster closes in; a melee weapon does not.
{
    const archer = { ...fighter, equipment: { weaponKind: 'Weapon.Bow', pAtkRnd: 5 } };
    const opening = Cold.openingMs(archer, mob);
    near(opening, (700 - mob.atkRadius) / mob.runSpd * 1000, 0.001, 'bow opening');
    assert.strictEqual(Cold.openingMs(fighter, mob), Math.max(0, 40 - mob.atkRadius) / mob.runSpd * 1000);
    assert.strictEqual(Cold.openingMs(archer, { ...mob, atkRadius: 600 }), 0, 'a ranged monster gives no opening');
    const swing = Matchup.soloSurvival([archer], mob);
    const noOpening = Matchup.soloSurvival([archer], { ...mob, runSpd: 0 });
    assert(swing.survivalRatio > noOpening.survivalRatio, 'the opening shots count');
}

console.log('Solo gate fight model passed');
