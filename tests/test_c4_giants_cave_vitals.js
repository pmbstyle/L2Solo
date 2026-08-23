const assert = require('assert');

require('../src/Global');

const Npc = invoke('GameServer/Npc/Npc');
const templates = require('../data/Npcs/npcs.json');

// Exact Chronicle 4 values from the pinned L2J Lisvus npc.sql revision.
const expectedVitals = new Map([
    [646, { maxHp: 2643, maxMp: 987, revHp: 20.54, revMp: 2.45, corpseTime: 7000 }],
    [647, { maxHp: 2724, maxMp: 1019, revHp: 20.54, revMp: 2.45, corpseTime: 7000 }],
    [648, { maxHp: 2806, maxMp: 1052, revHp: 20.54, revMp: 2.45, corpseTime: 7000 }],
    [649, { maxHp: 2889, maxMp: 1084, revHp: 20.54, revMp: 2.45, corpseTime: 7000 }],
    [650, { maxHp: 2971, maxMp: 1117, revHp: 20.54, revMp: 2.45, corpseTime: 7000 }],
    [651, { maxHp: 3054, maxMp: 1150, revHp: 20.54, revMp: 2.45, corpseTime: 7000 }],
    [652, { maxHp: 3137, maxMp: 1184, revHp: 23.7, revMp: 2.78, corpseTime: 7000 }],
    [653, { maxHp: 3137, maxMp: 1184, revHp: 35.55, revMp: 2.78, corpseTime: 7000 }],
    [654, { maxHp: 3219, maxMp: 1217, revHp: 35.55, revMp: 2.78, corpseTime: 7000 }],
    [655, { maxHp: 3302, maxMp: 1251, revHp: 35.55, revMp: 2.78, corpseTime: 7000 }],
    [656, { maxHp: 3302, maxMp: 1251, revHp: 35.55, revMp: 2.78, corpseTime: 7000 }],
    [657, { maxHp: 3384, maxMp: 1285, revHp: 23.7, revMp: 2.78, corpseTime: 7000 }],
    [658, { maxHp: 3465, maxMp: 1319, revHp: 23.7, revMp: 2.78, corpseTime: 7000 }],
    [771, { maxHp: 3384, maxMp: 1285, revHp: 23.7, revMp: 2.78, corpseTime: 7000 }]
]);

for (const [selfId, vitals] of expectedVitals) {
    const matches = templates.filter((template) => template.selfId === selfId);
    assert.strictEqual(matches.length, 1, `Giant's Cave NPC ${selfId} must have one template`);
    assert.deepStrictEqual(matches[0].vitals, vitals, `Giant's Cave NPC ${selfId} must retain C4 vitals`);

    const npc = new Npc(9000000 + selfId, {
        ...utils.crushOb(matches[0]),
        locX: 174528,
        locY: 52683,
        locZ: -4371,
        head: 0
    });
    assert.strictEqual(npc.fetchMaxHp(), vitals.maxHp, `NPC ${selfId} must expose sourced max HP at runtime`);
    assert.strictEqual(npc.fetchHp(), vitals.maxHp, `NPC ${selfId} must spawn at full sourced HP`);
    assert.strictEqual(npc.fetchMaxMp(), vitals.maxMp, `NPC ${selfId} must expose sourced max MP at runtime`);
    assert.strictEqual(npc.fetchMp(), vitals.maxMp, `NPC ${selfId} must spawn at full sourced MP`);
    assert.strictEqual(npc.fetchRevHp(), vitals.revHp, `NPC ${selfId} must expose sourced HP regeneration`);
    assert.strictEqual(npc.fetchRevMp(), vitals.revMp, `NPC ${selfId} must expose sourced MP regeneration`);
}

console.log("C4 Giant's Cave vitals checks passed");
