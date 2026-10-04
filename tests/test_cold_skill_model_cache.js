const assert = require('assert');
require('../src/Global');
const Data = invoke('GameServer/DataCache');
const Profiles = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Cold = invoke('GameServer/Bot/Population/ColdClassPolicy');
Data.init();

// Every cold fight builds a new profile object; the skill models behind the
// choice are built once per skill record, not once per fight.
const records = Profiles.skillSnapshotsFromRecords(Profiles.skillRecordsFromTree(12, 40));
const profile = () => ({ classId: 12, level: 40, maxHp: 1000, maxMp: 1000, skills: records,
    equipment: { weaponKind: 'Weapon.Blunt', shieldPDef: 0 } });
const context = { hp: 1000, mp: 1000, cooldowns: {}, time: 0, mob: { maxHp: 900, undead: false } };
const first = Cold.select(profile(), context);
assert(first?.skill, 'a sorcerer at 40 picks a skill');

const find = Data.skills.find;
let lookups = 0;
Data.skills.find = function(...args) { lookups++; return find.apply(this, args); };
try {
    for (let fight = 0; fight < 5; fight++) {
        assert.deepStrictEqual(Cold.select(profile(), context), first, 'the same records give the same choice');
    }
    assert.strictEqual(lookups, 0, 'no skill data lookups for records already seen');
    // Another bot with the same skills shares them; the copied records are equal content.
    Cold.select({ ...profile(), skills: records.map(record => ({ ...record })) }, context);
    assert.strictEqual(lookups, 0, 'records with equal content share one model');
} finally {
    Data.skills.find = find;
}
console.log('test_cold_skill_model_cache: ok');
