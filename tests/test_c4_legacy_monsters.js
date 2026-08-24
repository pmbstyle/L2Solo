const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const Npc = invoke('GameServer/Npc/Npc');
const NpcSkills = invoke('GameServer/Npc/NpcSkills');
const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');
const C4SkillEffects = invoke('GameServer/Skills/C4SkillEffects');
const templates = require('../data/Npcs/c4_legacy_monsters.json');
const skillRows = require('../data/Npcs/Skills/c4_legacy_monsters.json');

const STRONG_TYPE_MULTIPLIERS = new Map([
    [4303, 2], [4304, 3], [4305, 4], [4306, 5], [4307, 6],
    [4308, 7], [4309, 8], [4310, 9], [4311, 0.5]
]);
const expectedSamples = new Map([
    [646, { name: 'Halingka', baseHp: 2643, runtimeHp: 5286, strongType: 4303 }],
    [653, { name: 'Lesser Giant', baseHp: 3137, runtimeHp: 9411, strongType: 4304 }],
    [620, { name: 'Cave Beast', baseHp: 3137, runtimeHp: 9411, strongType: 4304 }],
    [623, { name: 'Plando', baseHp: 3384, runtimeHp: 13536, strongType: 4305 }],
    [629, { name: 'Karik', baseHp: 3862, runtimeHp: 19310, strongType: 4306 }],
    [5165, { name: 'Abyssal Jewel 1', baseHp: 3054, runtimeHp: 27486, strongType: 4310 }],
    [377, { name: "Varika's Bandit", baseHp: 171, runtimeHp: 86, strongType: 4311 }]
]);

assert.strictEqual(templates.length, 851, 'legacy C4 overlay must contain every existing ordinary source monster');
assert.strictEqual(skillRows.length, 2281, 'legacy C4 overlay must contain every source skill row for those monsters');
assert.strictEqual(new Set(templates.map((template) => template.selfId)).size, templates.length,
    'legacy C4 overlay must not contain duplicate NPC templates');

const rowsByNpc = new Map();
skillRows.forEach((row) => {
    if (!rowsByNpc.has(row.npcId)) rowsByNpc.set(row.npcId, []);
    rowsByNpc.get(row.npcId).push(row);
});
const sortSkills = (rows) => [...rows].sort((first, second) =>
    first.skillId - second.skillId || first.level - second.level);

DataCache.init();

for (const template of templates) {
    const matches = DataCache.npcs.filter((candidate) => Number(candidate.selfId) === Number(template.selfId));
    assert.strictEqual(matches.length, 1, `legacy C4 NPC ${template.selfId} must have one active template`);

    const npc = new Npc(9000000 + template.selfId, {
        ...utils.crushOb(matches[0]),
        locX: 150000,
        locY: 115000,
        locZ: -5000,
        head: 0
    });
    const expectedSkills = sortSkills(rowsByNpc.get(template.selfId) || []);
    const resolvedSkills = sortSkills(NpcSkills.forNpc(npc).map((skill) => ({
        npcId: template.selfId,
        skillId: skill.fetchSelfId(),
        level: skill.fetchLevel()
    })));
    assert.deepStrictEqual(resolvedSkills, expectedSkills,
        `legacy C4 NPC ${template.selfId} must resolve every sourced skill row`);

    const hpMultiplier = expectedSkills.reduce((result, row) =>
        result * (STRONG_TYPE_MULTIPLIERS.get(row.skillId) || 1), 1);
    const expectedMaxHp = Math.round(template.vitals.maxHp * hpMultiplier);
    assert.strictEqual(npc.fetchMaxHp(), expectedMaxHp,
        `legacy C4 NPC ${template.selfId} must apply sourced Strong/Feeble Type HP`);
    assert.strictEqual(npc.fetchHp(), expectedMaxHp,
        `legacy C4 NPC ${template.selfId} must spawn at full effective HP`);
    assert.strictEqual(npc.fetchMaxMp(), template.vitals.maxMp,
        `legacy C4 NPC ${template.selfId} must expose sourced max MP`);
    assert.strictEqual(npc.fetchMp(), template.vitals.maxMp,
        `legacy C4 NPC ${template.selfId} must spawn at full sourced MP`);
    assert.strictEqual(npc.fetchRevHp(), template.vitals.revHp,
        `legacy C4 NPC ${template.selfId} must expose sourced HP regeneration`);
    assert.strictEqual(npc.fetchRevMp(), template.vitals.revMp,
        `legacy C4 NPC ${template.selfId} must expose sourced MP regeneration`);
}

for (const [selfId, expected] of expectedSamples) {
    const template = templates.find((candidate) => candidate.selfId === selfId);
    assert.ok(template, `sample NPC ${selfId} must remain in the legacy C4 overlay`);
    assert.strictEqual(template.template.name, expected.name, `sample NPC ${selfId} must retain its source name`);
    assert.strictEqual(template.vitals.maxHp, expected.baseHp, `sample NPC ${selfId} must retain source base HP`);
    assert.ok((rowsByNpc.get(selfId) || []).some((row) => row.skillId === expected.strongType),
        `sample NPC ${selfId} must retain Strong/Feeble Type ${expected.strongType}`);

    const npc = new Npc(9100000 + selfId, {
        ...utils.crushOb(DataCache.npcs.find((candidate) => candidate.selfId === selfId)),
        locX: 0,
        locY: 0,
        locZ: 0,
        head: 0
    });
    assert.strictEqual(npc.fetchMaxHp(), expected.runtimeHp, `sample NPC ${selfId} must expose exact C4 runtime HP`);
}

const porta = new Npc(9200213, {
    ...utils.crushOb(DataCache.npcs.find((candidate) => candidate.selfId === 213)),
    locX: 100,
    locY: 200,
    locZ: -300,
    head: 0
});
const summonPc = porta.fetchCombatSkills().find((skill) => skill.fetchSelfId() === 4161);
assert.ok(summonPc, 'Porta must resolve sourced Summon PC as a combat skill');
assert.strictEqual(summonPc.fetchSemantic().skillType, C4SkillRules.GET_PLAYER,
    'Summon PC must use the source GET_PLAYER mechanic');

const pullEvents = [];
const target = {
    session: {
        currentTargetId: 123,
        dataSendToMeAndOthers(packet) { pullEvents.push({ packet }); }
    },
    state: {
        fetchDead() { return false; },
        setCasts(value) { pullEvents.push({ casts: value }); }
    },
    automation: { abortAll() { pullEvents.push({ aborted: true }); } },
    fetchId() { return 777; },
    isDead() { return false; },
    clearDestId() { pullEvents.push({ destinationCleared: true }); },
    unselect() { pullEvents.push({ unselected: true }); }
};
const rolls = [0, 0.999999];
let placement = null;
assert.strictEqual(C4SkillEffects.applyGetPlayer(porta, target, () => rolls.shift(),
    (session, actor, coords, options) => { placement = { session, actor, coords, options }; }), true,
'Summon PC must pull a live player target');
assert.deepStrictEqual(placement.coords, { locX: 90, locY: 210, locZ: -300 },
    'Summon PC must place its target within the sourced ten-unit caster offset');
assert.strictEqual(placement.session, target.session, 'Summon PC must update the target session');
assert.strictEqual(placement.actor, target, 'Summon PC must update the target actor');
assert.strictEqual(target.session.currentTargetId, undefined, 'Summon PC must clear the former target');
assert.ok(pullEvents.some((event) => event.aborted), 'Summon PC must abort the target movement/actions');
assert.ok(pullEvents.some((event) => event.packet), 'Summon PC must broadcast the teleport packet');

console.log('Global legacy C4 monster template, skill, and runtime HP checks passed');
