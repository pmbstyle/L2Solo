const assert = require('assert');

require('../src/Global');
const DataCache = invoke('GameServer/DataCache');
DataCache.init();
const Rules = invoke('GameServer/Skills/C4SkillRules');
const Cold = invoke('GameServer/Bot/Population/ColdCombatProfile');
const TargetMatchup = invoke('GameServer/Bot/AI/BotTargetMatchup');

// Every skill at every level, in the shapes callers pass: the cold snapshot
// (no name), the passive lookup (selfId + level only) and the datapack row
// with name, buff time and distance.
let checked = 0;
for (const skill of DataCache.skills) {
    for (const row of skill.levels || []) {
        const shapes = [
            { selfId: skill.selfId, level: row.level },
            { selfId: skill.selfId, level: row.level, passive: skill.template?.passive === true,
                spell: skill.template?.spell === true, power: row.power, mp: row.mp, buffTime: skill.time?.buff },
            { selfId: skill.selfId, level: row.level, name: skill.template?.name, spell: skill.template?.spell,
                power: row.power, buff: skill.time?.buff, distance: skill.template?.distance }
        ];
        for (const shape of shapes) {
            assert.deepStrictEqual(Rules.resolveCached(shape), Rules.resolve(shape), `${skill.selfId}:${row.level}`);
            checked += 1;
        }
    }
}
assert(checked > 5000, `checked ${checked} skill shapes`);

// The same inputs share one result; any field resolve() reads keeps them apart.
{
    const base = { selfId: 6, level: 3, name: 'Sonic Blaster', power: 417, buff: 0, spell: false, distance: 600 };
    assert.strictEqual(Rules.resolveCached({ ...base }), Rules.resolveCached({ ...base }));
    for (const change of [{ selfId: 7 }, { level: 4 }, { name: 'Self Heal' }, { power: 0 }, { buff: 30000 },
        { spell: true }, { distance: -1 }]) {
        assert.notStrictEqual(Rules.resolveCached({ ...base, ...change }), Rules.resolveCached(base), JSON.stringify(change));
    }
    // resolve() treats only boolean true as a spell.
    assert.deepStrictEqual(Rules.resolveCached({ ...base, spell: 'true' }), Rules.resolve({ ...base, spell: 'true' }));
}

// A cold combat profile and the matchup profiles built from it are unchanged
// for every class at several levels (passives through statSources, skills
// through coldProfiles).
{
    const classIds = [...new Set((DataCache.classTemplates || []).map((entry) => Number(entry.classId)))];
    assert(classIds.length > 50);
    const uncached = (fn) => {
        const original = Rules.resolveCached;
        Rules.resolveCached = (skill) => Rules.resolve(skill);
        try { return fn(); } finally { Rules.resolveCached = original; }
    };
    for (const classId of classIds) {
        for (const level of [1, 20, 40, 52, 76]) {
            const state = { characterId: 1, classId, level, stats: { classId }, vitals: { hp: 100, mp: 100 } };
            const timestamp = 1_000_000;
            assert.deepStrictEqual(Cold.profileFor(state, timestamp), uncached(() => Cold.profileFor(state, timestamp)),
                `profile ${classId}:${level}`);
            assert.deepStrictEqual(TargetMatchup.stateProfiles(state, { timestamp, mode: 'solo' }),
                uncached(() => TargetMatchup.stateProfiles(state, { timestamp, mode: 'solo' })), `matchup ${classId}:${level}`);
        }
    }
}

console.log(`skill rules resolveCached ok (${checked} shapes)`);
