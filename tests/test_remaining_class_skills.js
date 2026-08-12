const assert = require('assert');

require('../src/Global');

const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');
const DataCache = invoke('GameServer/DataCache');
const SkillModel = invoke('GameServer/Model/Skill');
const skillTree = require('../data/Skills/Tree/tree.json');

DataCache.init();

function cachedSkill(selfId, level = 1) {
    const data = DataCache.skills.find((entry) => entry.selfId === selfId);
    assert(data, `skill ${selfId} should have a runtime definition`);
    const levelData = data.levels.find((entry) => entry.level === level);
    assert(levelData, `skill ${selfId} should materialize sourced level ${level}`);
    return new SkillModel({ ...utils.crushOb(data), ...levelData });
}

const classSkills = new Map([
    [10, [118, 146, 163, 194, 214, 244, 249, 1011, 1012, 1015, 1027, 1040, 1068, 1147, 1164, 1168, 1177, 1184, 1216, 1320, 1322]],
    [18, [3, 16, 56, 58, 77, 91, 141, 142, 194, 1320, 1322]],
    [25, [118, 146, 163, 194, 214, 244, 249, 1011, 1012, 1015, 1027, 1040, 1068, 1164, 1177, 1184, 1206, 1216, 1320, 1322]],
    [26, [146, 164, 212, 213, 228, 229, 234, 239, 249, 285, 1069, 1078, 1126, 1127, 1145, 1164, 1172, 1175, 1181, 1182, 1184, 1223, 1226, 1227, 1264, 1274, 1320]],
    [31, [3, 16, 56, 70, 77, 91, 141, 142, 194, 294, 1320, 1322]],
    [38, [118, 146, 163, 194, 214, 244, 249, 1011, 1012, 1015, 1027, 1040, 1068, 1147, 1168, 1177, 1184, 1206, 1216, 1320, 1322]],
    [39, [146, 164, 212, 213, 228, 229, 234, 239, 249, 285, 1069, 1078, 1126, 1127, 1128, 1146, 1147, 1151, 1157, 1160, 1167, 1168, 1172, 1178, 1181, 1184, 1222, 1224, 1228, 1266, 1320]]
]);

for (const [classId, expectedIds] of classSkills) {
    const tree = skillTree.find((entry) => entry.classId === classId);
    assert(tree, `remaining class ${classId} should have a C4 skill tree`);
    assert.deepStrictEqual(
        tree.skills.map((entry) => entry.selfId),
        expectedIds,
        `remaining class ${classId} should match the complete Lisvus skill list`
    );

    for (const treeSkill of tree.skills) {
        const data = DataCache.skills.find((entry) => entry.selfId === treeSkill.selfId);
        assert(data, `class ${classId} skill ${treeSkill.selfId} should have a runtime definition`);
        for (const sourcedLevel of treeSkill.levels) {
            assert(
                data.levels.some((entry) => entry.level === sourcedLevel.level),
                `class ${classId} skill ${treeSkill.selfId} should materialize sourced level ${sourcedLevel.level}`
            );
        }
    }
}

const baseCommonCraft = skillTree.find((entry) => entry.classId === 10);
assert.deepStrictEqual(
    baseCommonCraft.skills.find((entry) => entry.selfId === 1320).levels,
    [{ level: 1, pLevel: 5, sp: 0 }],
    'base classes should learn Create Common Item level 1 at character level 5 for zero SP'
);
assert.deepStrictEqual(
    baseCommonCraft.skills.find((entry) => entry.selfId === 1322).levels,
    [{ level: 1, pLevel: 1, sp: 0 }],
    'base classes should learn Common Craft at character level 1 for zero SP'
);
assert.deepStrictEqual(
    skillTree.find((entry) => entry.classId === 26).skills.find((entry) => entry.selfId === 1320).levels,
    [
        { level: 2, pLevel: 20, sp: 0 },
        { level: 3, pLevel: 28, sp: 0 },
        { level: 4, pLevel: 36, sp: 0 }
    ],
    'first professions should continue the sourced common-craft progression'
);

assert.strictEqual(cachedSkill(1320, 9).fetchSkillType(), C4SkillRules.PASSIVE, 'Create Common Item should remain a nine-level passive');
assert.strictEqual(cachedSkill(1322).fetchSkillType(), C4SkillRules.DUMMY, 'Common Craft should execute as a recipe-book action');
assert.strictEqual(cachedSkill(294).fetchSkillType(), C4SkillRules.PASSIVE, 'Shadow Sense should remain a night-only passive');
assert.strictEqual(cachedSkill(1264, 3).fetchSemantic().trait, 'holy', 'Solar Spark should use holy vulnerability');
assert.strictEqual(cachedSkill(1265, 14).fetchSemantic().trait, 'holy', 'Solar Flare should use holy vulnerability');
assert.strictEqual(cachedSkill(1266, 3).fetchSemantic().trait, 'dark', 'Shadow Spark should use dark vulnerability');
assert.strictEqual(cachedSkill(1175, 8).fetchSemantic().trait, 'water', 'Aqua Swirl should preserve water damage');
assert.strictEqual(cachedSkill(1177, 5).fetchSemantic().trait, 'wind', 'Wind Strike should preserve wind damage');
assert.strictEqual(cachedSkill(1178, 8).fetchSemantic().trait, 'wind', 'Twister should preserve wind damage');
assert.strictEqual(cachedSkill(1216).fetchSkillType(), C4SkillRules.HEAL, 'Self Heal should execute as healing');

console.log('Remaining class skill checks passed');
