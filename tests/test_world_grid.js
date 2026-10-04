const assert = require('assert');

require('../src/Global');

// Two 6000-unit grids. Spot ids: hot hunting (HuntingState) and the spot
// catalogue (SpotService) must put a point in the same cell, since hot target
// scoring compares a monster's cell with the bot's spot. NPC lookup: a radius
// search over 3x3 cells must find every NPC the client can see.

const Data = invoke('GameServer/DataCache');
const Npc = invoke('GameServer/Npc/Npc');
const Scorer = invoke('GameServer/Bot/AI/BotTargetScorer');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const Hunting = invoke('GameServer/Bot/AI/States/HuntingState');
const World = invoke('GameServer/World/World');
const Geo = invoke('GameServer/Geodata/GeodataEngine');
Data.init();

const savedScan = World.fetchNpcsInRadius;
const savedSight = Geo.hasLineOfSight;
const savedScore = Scorer.score;
const savedNpc = World.npc;

function spotIdChecks() {
    const template = Data.npcs.find((npc) => npc.template?.kind === 'Monster' && Number(npc.template?.level) === 20);
    assert(template, 'fixture: a level 20 monster template');
    const monster = (id, locX, locY) => {
        const npc = new Npc(id, { ...utils.crushOb(template), locX, locY, locZ: 0, head: 0 });
        npc.fetchPassiveSkills = () => [];
        return npc;
    };
    const hunterAt = (locX, locY) => ({
        fetchClassId: () => 0, fetchLevel: () => 20, fetchLocX: () => locX, fetchLocY: () => locY, fetchLocZ: () => 0,
        fetchHp: () => 1000, fetchMaxHp: () => 1000, fetchMp: () => 300, fetchMaxMp: () => 300,
        fetchCollectivePAtk: () => 500, fetchCollectiveMAtk: () => 100, fetchCollectivePDef: () => 500,
        backpack: { fetchTotalWeaponKind: () => 'Weapon.Sword' }, skillset: { skills: [] }
    });
    const contexts = [];
    Scorer.score = (context) => {
        contexts.push(context);
        return savedScore(context);
    };
    Geo.hasLineOfSight = () => true;
    // Cell borders on both axes, on both sides of zero.
    const cases = [
        { bot: [5999, 100], npcs: [[5990, 100], [6001, 100], [6000, 100]] },
        { bot: [-1, -1], npcs: [[0, 0], [-6000, -1], [-6001, -6001]] },
        { bot: [12001, -5999], npcs: [[11999, -5999], [12001, -6001]] }
    ];
    let id = 930000;
    for (const { bot, npcs } of cases) {
        const hunter = hunterAt(...bot);
        const monsters = npcs.map(([locX, locY]) => monster(id++, locX, locY));
        World.fetchNpcsInRadius = () => monsters;
        contexts.length = 0;
        Hunting.findPreferredMonster({ actor: hunter, plan: 'hunting' }, hunter, 2500);
        assert.strictEqual(contexts.length, monsters.length, 'fixture: every monster is scored');
        for (const context of contexts) {
            assert(SpotService.containsLocation({ id: context.currentSpotId },
                { locX: bot[0], locY: bot[1], locZ: 0 }), `bot cell ${context.currentSpotId} at ${bot}`);
        }
        monsters.forEach((npc, index) => {
            const loc = { locX: npc.fetchLocX(), locY: npc.fetchLocY(), locZ: 0 };
            assert(SpotService.containsLocation({ id: contexts[index].npcSpotId }, loc),
                `monster cell ${contexts[index].npcSpotId} at ${loc.locX},${loc.locY}`);
        });
    }
}

function npcGridChecks() {
    World.fetchNpcsInRadius = savedScan;
    const at = (locX, locY) => ({ fetchLocX: () => locX, fetchLocY: () => locY });
    const center = [5999, 5999];
    const visible = [at(11998, 5999), at(5999 + 4241, 5999 + 4241), at(-1, 5999), at(5999, 1), at(5999, 11999)];
    const hidden = [at(12000, 5999), at(5999 + 4243, 5999 + 4243)];
    World.npc = { grid: {} };
    for (const npc of [...visible, ...hidden]) {
        const key = World.npcGridKey(npc);
        (World.npc.grid[key] ||= []).push(npc);
    }
    const found = World.fetchNpcsInRadius(center[0], center[1], 6000);
    assert.deepStrictEqual(new Set(found), new Set(visible),
        'a radius search finds every NPC within the visibility radius, across cell borders');
}

try {
    spotIdChecks();
    npcGridChecks();
    console.log('World grid checks passed');
} finally {
    World.fetchNpcsInRadius = savedScan;
    Geo.hasLineOfSight = savedSight;
    Scorer.score = savedScore;
    World.npc = savedNpc;
}
