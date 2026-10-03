const assert = require('assert');
require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
DataCache.init();
const BotRoles = invoke('GameServer/Bot/AI/BotRoles');
const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');

// One planner call judges the same bot against every candidate source; its
// combat readiness depends only on the bot, so it is built once per call.
const itemByName = (name) => DataCache.items.find((item) => (item.template?.name || item.name) === name);
const sword = itemByName("Squire's Sword");
const state = {
    characterId: 4, level: 20, adena: 1000, stats: { classId: 1, role: 'dps' },
    inventory: { 57: { selfId: 57, amount: 1000 } }
};
const sources = Array.from({ length: 40 }, (_, index) => ({
    spotId: `s${index}`, npcId: 1000 + index, npcLevel: 18, expectedYield: 0.01
}));

const isSpoiler = BotRoles.isSpoiler;
let builds = 0;
BotRoles.isSpoiler = (...args) => { builds += 1; return isSpoiler(...args); };
try {
    Planner.bestSourceForState(sources, state);
    assert.strictEqual(builds, 1, `readiness built ${builds} times for one call over ${sources.length} sources`);

    // Nothing outlives the call: an equipment change between calls counts.
    assert.strictEqual(Planner.combatReadiness(state).hasWeapon, false);
    state.inventory[sword.selfId] = { selfId: sword.selfId, amount: 1, equipped: true, equippedCount: 1,
        equippedSlots: [7], slot: 7 };
    assert.strictEqual(Planner.combatReadiness(state).hasWeapon, true, 'the next call sees the equipped weapon');

    // A caller mutating the returned object does not change a later answer in the same call.
    const first = Planner.combatReadiness(state);
    first.hasWeapon = false;
    assert.strictEqual(Planner.combatReadiness(state).hasWeapon, true);
} finally {
    BotRoles.isSpoiler = isSpoiler;
}

console.log('gear readiness scope ok');
