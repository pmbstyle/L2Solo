const assert = require('assert');
require('../src/Global');
// Load native data before the first economic route or combat profile check.
invoke('GameServer/DataCache').init();
const Policy = invoke('GameServer/Bot/AI/BotClassPolicy');
const Progression = invoke('GameServer/ClassProgression');
const Routes = invoke('GameServer/Bot/AI/LevelingRoutes');
const Support = invoke('GameServer/Bot/AI/BotSupportPlanner');
const Utility = invoke('GameServer/Bot/AI/BotCombatUtility');
const Rules = invoke('GameServer/Skills/C4SkillRules');

const templates = structuredClone(require('../data/Templates/templates.json'));
Progression.expandTemplates(templates);
assert.strictEqual(templates.length, 89);
for (const template of templates) {
    for (const mode of ['solo_pve', 'party_pve', 'solo_pvp', 'party_pvp']) {
        const profile = Policy.profileFor(template, { mode });
        assert.strictEqual(profile.supported, true, `class ${template.classId}`);
        assert.strictEqual(profile.mode, mode);
        assert.ok(profile.equipment.weaponKinds.length);
    }
}
assert.strictEqual(Policy.classIdOf({ classId: 0, stats: { classId: 43 } }), 0);
assert.strictEqual(Policy.profileFor(58).supported, false);
assert.strictEqual(Policy.hasSkill(16, 1028, 40), true);
assert.strictEqual(Policy.hasSkill({ template: { classId: 16 }, level: 40 }, 1028), true);
assert.strictEqual(Policy.hasSkill(43, 1028, 74), false);
assert.strictEqual(Policy.hasSkill(112, 1028, 78), false);
assert.strictEqual(Policy.hasSkill(105, 1028, 78), true);
assert.strictEqual(Policy.hasSkill(21, 269, 48), false);
assert.strictEqual(Policy.hasSkill(21, 269, 49), true);
assert.strictEqual(Policy.hasSkill(104, 1351, 78), false);
assert.strictEqual(Policy.hasSkill(96, 1351, 78), true);
assert.strictEqual(Policy.hasSkill({ classId: 16, level: 60, skillset: { skills: [] } }, 1028), false);

const undead = { id: 'cemetery', name: 'Cemetery', avgLevel: 61, minLevel: 58, maxLevel: 64,
    density: 8, center: { locX: 1000, locY: 1000 }, npcNames: ['Skeleton'] };
assert.strictEqual(Routes.scoreSpot(undead, { classId: 16, level: 61 }).route.id, 'cleric_undead_40_74');
assert.notStrictEqual(Routes.scoreSpot(undead, { classId: 43, level: 61 }).route?.id, 'cleric_undead_40_74');
assert.notStrictEqual(Routes.scoreSpot(undead, { classId: 16, level: 61, skillset: { skills: [] } }).route?.id, 'cleric_undead_40_74');

const buff = (effect, target = 'friendly') => ({ fetchSemantic: () => ({ effect, target }) });
assert.strictEqual(Support.isUsefulForTarget({ classId: 21 }, buff('haste')), true);
assert.strictEqual(Support.isUsefulForTarget({ classId: 107 }, buff('might')), true);
assert.strictEqual(Support.isUsefulForTarget({ classId: 21 }, buff('empower')), false);
assert.strictEqual(Support.isUsefulForTarget({ classId: 9 }, buff('vampiric_rage')), false);
assert.strictEqual(Support.isUsefulForTarget({ classId: 48 }, buff('vampiric_rage')), true);
assert.strictEqual(Support.isUsefulForTarget({ classId: 43 }, buff('empower')), true);

const attackSkill = { selfId: 1000, fetchSelfId: () => 1000, fetchPassive: () => false,
    fetchSkillType: () => Rules.DAMAGE, fetchTargetKind: () => 'enemy', fetchDistance: () => 600,
    fetchPower: () => 50, fetchConsumedMp: () => 20, fetchSpell: () => true, fetchSemantic: () => ({}) };
const healer = { classId: 16, fetchMp: () => 50, fetchMaxMp: () => 100,
    skillset: { skills: [attackSkill] } };
assert.ok(Utility.select(healer, {}, 'healer', { mode: 'solo_pve' }));
assert.strictEqual(Utility.select(healer, {}, 'healer', { mode: 'party_pve' }), null);
assert.strictEqual(Utility.select(healer, {}, 'healer', { mode: 'party_pvp' }).classMode, 'party_pvp');
assert.strictEqual(Policy.modeFor(healer, { pvp: true, session: { hotBackgroundPartyId: 'pvp-party' } }), 'party_pvp');
healer.canUseSkill = () => false;
assert.strictEqual(Utility.select(healer, {}, 'healer', { pvp: true, skillPriorities: { 1000: 999 } }), null);
const hpGated = { ...attackSkill, fetchSemantic: () => ({ condition: { actorHpPercentAtMost: 30 } }) };
assert.strictEqual(Utility.evaluate({ ...healer, canUseSkill: () => true, fetchHp: () => 100, fetchMaxHp: () => 100 }, {}, hpGated,
    'healer', { pvp: true, skillPriorities: { 1000: 999 } }), null);
assert.strictEqual(Utility.evaluate({ ...healer, canUseSkill: () => true, fetchHp: () => 10 }, {},
    { ...attackSkill, fetchConsumedHp: () => 10 }, 'healer', { pvp: true }), null, 'offense cannot spend the actor last HP');

const charge = { ...attackSkill, selfId: 8, fetchSelfId: () => 8,
    fetchSkillType: () => Rules.CHARGE, fetchSemantic: () => ({ skillType: Rules.CHARGE }) };
const burst = { ...attackSkill, fetchSemantic: () => ({ requires: { charges: 3 } }) };
const fighter = { classId: 2, fetchMp: () => 100, fetchMaxMp: () => 100,
    skillset: { skills: [charge, burst] }, canUseSkill: skill => skill === charge };
assert.strictEqual(Utility.selectChargeSkill(fighter, 'dps'), null, 'do not charge for an unavailable burst');
fighter.canUseSkill = () => true;
assert.strictEqual(Utility.selectChargeSkill(fighter, 'dps'), charge);

const drain = { ...attackSkill, selfId: 1001, fetchSelfId: () => 1001, fetchSkillType: () => Rules.DRAIN };
const mage = { classId: 12, fetchMp: () => 100, fetchMaxMp: () => 100, fetchHp: () => 50,
    fetchMaxHp: () => 100, skillset: { skills: [attackSkill, drain] } };
assert.strictEqual(Utility.select(mage, {}, 'mage').skill, drain, 'prefer an equal-cost drain when HP is missing');
mage.fetchHp = () => 100;
assert.strictEqual(Utility.select(mage, {}, 'mage').skill, attackSkill, 'drain healing has no value at full HP');

const expanded = Rules.expandSourcedLevels([{ selfId: 263, levels: [{ level: 21, power: 3136, mp: 58 }] }])[0];
assert.strictEqual(expanded.levels.at(-1).level, 37);
assert.strictEqual(expanded.levels.at(-1).power, 5479);
assert.strictEqual(expanded.levels.at(-1).mp, 75);
console.log('Class policy: 89 classes, four modes, runtime route/support/combat checks passed');
