const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
DataCache.init();

const GearSkillHints = invoke('GameServer/Bot/AI/GearSkillHints');
const BotGear = invoke('GameServer/Bot/AI/BotGear');

let hint = GearSkillHints.forCharacter({ classId: 12, level: 44 });
assert.strictEqual(hint.role, 'mage');
assert.strictEqual(hint.grade, 'c');
assert.strictEqual(hint.tier, 'c_grade_damage_cast');
assert.strictEqual(hint.classFamily, 'elemental_nuker');
assert.strictEqual(hint.armor, 'robe');
assert.ok(hint.specialAbilities.includes('empower'), 'C-grade mage PvE hints should value Empower');
assert.ok(hint.specialAbilities.includes('acumen'), 'C-grade mage hints should keep Acumen as a cast-speed option');
assert.ok(hint.consumables.includes('spiritshots'), 'mages should carry spiritshots');
assert.ok(hint.exampleGear.some((item) => item.includes('Sword of Whispering Death')), 'C-grade mage hints should include a guide-derived damage weapon example');
assert.ok(hint.warnings.some((warning) => warning.includes('Demon Set')), 'C-grade mage hints should warn about fragile damage gear');

hint = GearSkillHints.forCharacter({ classId: 13, level: 62 });
assert.strictEqual(hint.classFamily, 'necromancer');
assert.strictEqual(hint.tier, 'a_grade_magic_power');
assert.ok(hint.skills.some((skill) => skill.name.includes('Death Spike')), 'Necromancer hints should expose bone/Death Spike behavior');

hint = GearSkillHints.forCharacter({ classId: 9, level: 44 });
assert.strictEqual(hint.role, 'archer');
assert.strictEqual(hint.tier, 'c_grade_cheap_shot');
assert.strictEqual(hint.weapon, 'bow');
assert.strictEqual(hint.armor, 'light');
assert.ok(hint.specialAbilities.includes('cheap_shot'), 'archer farming bows should prefer Cheap Shot');
assert.ok(hint.consumables.includes('arrows'), 'archers should track arrows');
assert.ok(hint.warnings.some((warning) => warning.includes('Cheap Shot')), 'archer hints should warn about adena burn without Cheap Shot');

hint = GearSkillHints.forCharacter({ classId: 55, level: 45 });
assert.strictEqual(hint.role, 'spoiler');
assert.strictEqual(hint.tier, 'c_grade_spoil');
assert.strictEqual(hint.classFamily, 'bounty_hunter');
assert.strictEqual(hint.weapon, 'one_handed_blunt');
assert.ok(hint.skills.some((skill) => skill.name === 'Spoil'), 'Bounty Hunters should expose Spoil as a build skill');
assert.ok(hint.skills.some((skill) => skill.name === 'Sweeper'), 'Bounty Hunters should expose Sweeper as a build skill');
assert.ok(hint.exampleGear.some((item) => item.includes('Yaksa')), 'C-grade spoiler hints should include blunt-heavy farm examples');
assert.strictEqual(hint.partyNeed, 'fast_kill_party_for_spoil_volume');
assert.ok(hint.warnings.some((warning) => warning.includes('worth spoiling')), 'spoiler hints should prefer valuable spoil targets');

hint = GearSkillHints.forCharacter({ classId: 17, level: 48 });
assert.strictEqual(hint.role, 'buffer');
assert.strictEqual(hint.classFamily, 'prophet');
assert.strictEqual(hint.armor, 'robe');
assert.ok(hint.statPriority.includes('buff_uptime'), 'buffers should value buff uptime');
assert.ok(hint.consumables.includes('spiritshots_for_backup_heals'), 'buffers should reserve shots for backup heals');
assert.ok(hint.warnings.some((warning) => warning.includes('not a Bishop')), 'Prophet hints should not claim main-healer behavior');

hint = GearSkillHints.forCharacter({ classId: 5, level: 40 });
assert.strictEqual(hint.role, 'tank');
assert.strictEqual(hint.tier, 'c_grade_tank');
assert.strictEqual(hint.armor, 'heavy');
assert.strictEqual(hint.weapon, 'one_handed_sword_or_blunt');
assert.ok(hint.skills.some((skill) => skill.name === 'Aggression'), 'tanks should expose aggro control hints');

hint = GearSkillHints.forCharacter({ classId: 12, level: 78 });
assert.strictEqual(hint.grade, 's');
assert.strictEqual(hint.tier, 's_grade_nuker');
assert.ok(hint.exampleGear.some((item) => item.includes('Arcana Mace')), 'S-grade mage hints should include endgame caster weapon examples');

hint = GearSkillHints.forCharacter({ classId: 0, level: 18 });
assert.strictEqual(hint.grade, 'none');
assert.strictEqual(hint.tier, 'starter_fighter');
assert.deepStrictEqual(hint.specialAbilities, [], 'no-grade fighters should not advertise special abilities');

const plan = BotGear.planFor({ classId: 9, level: 44 });
assert.strictEqual(plan.hint.role, 'archer');
assert.strictEqual(plan.hint.weapon, 'bow');
assert.strictEqual(plan.hint.grade, plan.rank);
assert.strictEqual(plan.hint.tier, 'c_grade_cheap_shot');

console.log('Bot gear/skill hint checks passed');
