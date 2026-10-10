'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const isolated = require('./helpers/isolatedSocialDatabase')('clan-pure-helpers');
require('../src/Global');
isolated.assertConfigured(options.default);
try {
    const Data = invoke('GameServer/DataCache');
    Data.init();
    const Tree = require('../src/GameServer/Bot/Population/ColdSkillTree');
    const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
    const Craft = require('../src/GameServer/Bot/Economy/CraftEligibility');
    const Shops = invoke('GameServer/Bot/Economy/CraftShopService');
    const Rest = require('../src/GameServer/Bot/Population/ColdRest');
    const Resolver = invoke('GameServer/Bot/Population/BackgroundResolver');
    assert.equal(Profile.treeSkillLevel, Tree.treeSkillLevel);
    for (const method of ['isServiceCrafter', 'craftLevelFor', 'canCraft']) assert.equal(Shops[method], Craft[method]);
    assert.equal(Resolver.estimateRestMs, Rest.estimateRestMs);
    assert.equal(Resolver.coldRestRegenPerTick, Rest.coldRestRegenPerTick);
    const ids = Data.classTemplates.map(row => Number(row.classId));
    let learnedRows = 0;
    for (const classId of ids) {
        const line = Tree.classProgressionIds(classId);
        assert.equal(line.at(-1), classId);
        assert.equal(new Set(line).size, line.length);
        const entries = Tree.skillTreeEntries(classId);
        for (const level of [1, 20, 40, 61, 76, 78, 80]) {
            for (const skill of entries) {
                const row = Tree.learnedTreeRow(skill, level);
                assert.equal(Tree.treeSkillLevel(classId, level, skill.selfId), Number(row?.level) || 0);
                if (row) { assert(skill.levels.includes(row)); learnedRows++; }
            }
            const state = { classId, level, stats: { classId } };
            assert.equal(Craft.craftLevelFor(state), Tree.treeSkillLevel(classId, level, 172));
            for (const recipe of [{ level: 1 }, { level: 5 }, { level: 9 }]) {
                assert.equal(Craft.canCraft(state, recipe), Craft.isServiceCrafter(state)
                    && Tree.treeSkillLevel(classId, level, 172) >= recipe.level);
            }
            const vitals = { hp: 450, maxHp: 1000, mp: 0, maxMp: 10000 };
            for (const restOptions of [{ requireMana: true }, { requireMana: false }, { party: true },
                { requireMana: true, hpMultiplier: 2, mpMultiplier: 0.5 }]) {
                const elapsed = Rest.estimateRestMs(state, vitals, restOptions);
                assert(Number.isInteger(elapsed) && elapsed >= 8000);
                assert.equal(elapsed, Resolver.estimateRestMs(state, vitals, restOptions));
            }
        }
    }
    // Create Item is shared by every class that has learned it (a9b995ba): the spoiler line
    // keeps the level 1 it learned as a Dwarven Fighter and crafts nothing above it.
    for (const classId of [53, 54, 55, 117]) {
        assert.equal(Craft.canCraft({ classId, level: 78 }, { level: 1 }), true);
        assert.equal(Craft.canCraft({ classId, level: 78 }, { level: 2 }), false);
    }
    for (const classId of [56, 57, 118]) assert.equal(Craft.canCraft({ classId, level: 78 }, { level: 1 }), true);
    const tree = Data.skillTree;
    Data.skillTree = tree.filter(row => Number(row.classId) !== 56);
    assert.equal(Craft.craftLevelFor({ classId: 57, level: 41 }), 1);
    Data.skillTree = tree;
    assert.equal(Craft.craftLevelFor({ classId: 57, level: 41 }), 4);
    assert.equal(Craft.craftLevelFor({ classId: 57, level: 41, craftLevel: 7 }), 7);
    console.log('PASS native shared class-line, learned-row identity, crafter classification and regeneration', ids.length, learnedRows);
} finally {
    fs.rmSync(isolated.directory, { recursive: true, force: true });
}
