const assert = require('assert');

require('../src/Global');
const DataCache = invoke('GameServer/DataCache');
DataCache.init();
const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');
const HuntCycle = invoke('GameServer/Bot/AI/HuntCycle');
const BotCombatUtility = invoke('GameServer/Bot/AI/BotCombatUtility');
const ColdCombatProfile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const ColdClassPolicy = invoke('GameServer/Bot/Population/ColdClassPolicy');
const BotTargetMatchup = invoke('GameServer/Bot/AI/BotTargetMatchup');

// T100 (docs/game-decisions.md, Bot behaviour): MP priced in rest time.
const TS = 1_791_060_000_000;
const mob = { maxHp: 5000, pDef: 400, mDef: 300, undead: false, vulnerabilities: {} };
const profileOf = (classId, level) => ColdCombatProfile.fightProfile(HuntCycle.referenceState(classId, level), TS);
const pick = (profile, mpShare, extra = {}) => ColdClassPolicy.select(profile, { hp: profile.maxHp, mp: profile.maxMp * mpShare,
    cooldowns: {}, time: 0, mob, mobHp: mob.maxHp, ...extra })?.skill.selfId ?? null;

const hawkeye = profileOf(9, 55), sorcerer = profileOf(12, 55), gladiator = profileOf(2, 55), bishop = profileOf(16, 55);

// A bot that sits for MP (an archer) fires a costly shot only while its MP
// would overflow anyway; with the bar part spent the normal attack wins.
assert.strictEqual(pick(hawkeye, 1), 19, 'a full-MP Hawkeye fires Double Shot');
assert.strictEqual(pick(hawkeye, 0.3), null, 'a Hawkeye at 30% MP keeps shooting normal arrows');

// Among the paying skills the best damage per ms of cast plus rest is cast:
// the fast Aura Flare at full MP, the cheap Aura Bolt once rest is dear
// (T117: Prominence pays its C4 initial MP too).
assert.strictEqual(pick(sorcerer, 1), 1231, 'a full-MP Sorcerer casts the fastest paying nuke');
assert.strictEqual(pick(sorcerer, 0.3), 1275, 'a Sorcerer low on MP casts the nuke with the best damage per rest');
// A staff caster's weapon only finishes (BotRoles.usesCasterWeaponCombat):
// its alternative to a nuke is nothing, so it keeps casting as MP falls.
assert.strictEqual(pick(bishop, 0.3), 1177, 'a Bishop at 30% MP still casts Wind Strike');

// A bot that never sits for MP (it rests for HP, its MP refills meanwhile)
// pays no rest: a skill that out-damages the normal attack is cast.
assert.strictEqual(pick(gladiator, 0.5), 1, 'a Gladiator at half MP still uses Triple Slash');
// Damage beyond the mob's HP is not counted: one normal hit kills sooner.
assert.strictEqual(pick(gladiator, 1, { mobHp: 1 }), null, 'a skill that only overkills a nearly dead mob is not cast');

// PvP and raid fights keep the old picks: no rest pays their MP back.
assert.notStrictEqual(pick(hawkeye, 0.3, { pvp: true }), null, 'a PvP pick is not priced');
assert.notStrictEqual(pick(hawkeye, 0.3, { mob: { ...mob, raidBossMaxHp: 5000 } }), null, 'a raid pick is not priced');

// A cold bow draws and reloads (the hot Attack.js cycle): over twice a
// sword's swing at the same attack speed.
const swordHawkeye = { ...hawkeye, equipment: { ...hawkeye.equipment, weaponKind: 'Weapon.Sword' } };
assert(ColdCombatProfile.normalAttackMs(hawkeye) > 2 * ColdCombatProfile.normalAttackMs(swordHawkeye),
    'a cold bow shot takes its draw and reload');

// The solo gate counts the fight the price leaves: an archer's survival is
// its normal attack even beside a far stronger skill; a Gladiator's is not.
const npc = DataCache.npcs.find((row) => Number(row.template?.level) === 55 && ColdCombatProfile.npcCombatStats(row)?.pAtk > 0);
const mobStats = ColdCombatProfile.npcCombatStats(npc);
const strongSkill = (profile, view) => {
    const normal = { weight: BotTargetMatchup.attackRate(profile, view), modifier: 1, magic: false, normal: true };
    return [normal, { weight: 10 * normal.weight, modifier: 1, magic: false, damageBudget: Infinity }];
};
const ratio = (profile, attacksOf) => BotTargetMatchup.soloSurvival([profile], mobStats, 1.5, attacksOf).survivalRatio;
const normalOnly = (profile, view) => strongSkill(profile, view).slice(0, 1);
assert.strictEqual(ratio(hawkeye, strongSkill), ratio(hawkeye, normalOnly), 'an archer is admitted on its normal attack');
assert(ratio(gladiator, strongSkill) > ratio(gladiator, normalOnly), 'a Gladiator is admitted on its skills too');
// A mage's gate channel is the skill it keeps casting: a long reuse bounds a
// nuke's rate, so a Sorcerer is judged on Aura Flare, not on a one-off opener.
const sorcerer74 = ColdCombatProfile.profileFor(HuntCycle.referenceState(12, 74), TS);
const scores = BotTargetMatchup.coldProfiles({ ...sorcerer74, role: 'mage' }, {}, TS)[0].soloAttackScores;
const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];
assert.strictEqual(Number(best), 1231, `a Sorcerer's solo channel is Aura Flare (scores ${JSON.stringify(scores)})`);

// The hot pick reads the same price from a live actor: the hot attack timing
// and the seated regeneration of its Automation.
function hotArcher(mp) {
    const shot = { selfId: 19, fetchSelfId: () => 19, fetchName: () => 'shot', fetchConsumedMp: () => 120, fetchPassive: () => false,
        fetchSemantic: () => ({}), fetchSkillType: () => C4SkillRules.DAMAGE, fetchTargetKind: () => 'enemy',
        fetchDistance: () => 900, fetchPower: () => 2400, fetchSpell: () => false, fetchHitTime: () => 3000 };
    const bow = { fetchKind: () => 'Weapon.Bow', fetchAttackReuseDelay: () => 1500, fetchSelfId: () => 0 };
    return {
        fetchClassId: () => 9, fetchLevel: () => 55, fetchHp: () => 2000, fetchMaxHp: () => 2000,
        fetchMp: () => mp, fetchMaxMp: () => 736, fetchCollectivePAtk: () => 900, fetchCollectiveMAtk: () => 300,
        fetchCollectiveAtkSpd: () => 290, fetchCollectiveCastSpd: () => 333, fetchLocX: () => 0, fetchLocY: () => 0,
        automation: { fetchRevMpAmount: () => 5, fetchRegenStateMultiplier: () => 1.1 },
        skillset: { skills: [shot], fetchSkill: () => shot },
        backpack: { fetchEquippedWeapon: () => bow, fetchTotalWeaponKind: () => 'Weapon.Bow', fetchEquippedArmors: () => [] }
    };
}
const target = { fetchId: () => 1, fetchHp: () => 5000, fetchCollectivePDef: () => 400, fetchCollectiveMDef: () => 300,
    fetchLocX: () => 500, fetchLocY: () => 0 };
assert.strictEqual(BotCombatUtility.select(hotArcher(736), target, 'archer')?.skill.fetchSelfId(), 19,
    'a full-MP hot archer fires its shot');
assert.strictEqual(BotCombatUtility.select(hotArcher(200), target, 'archer'), null,
    'a hot archer low on MP shoots normal arrows');
// A raid boss (BotRaidSafety) and a companion's player-set priorities keep
// the old pick.
assert.notStrictEqual(BotCombatUtility.select(hotArcher(200), { ...target, fetchIsRaidBoss: () => true }, 'archer'), null,
    'a hot raid pick is not priced');
assert.notStrictEqual(BotCombatUtility.select(hotArcher(200), target, 'archer', { skillPriorities: { 19: 10 } }), null,
    'a player-set skill priority is not overruled by the price');

console.log('test_bot_mana_price passed');
