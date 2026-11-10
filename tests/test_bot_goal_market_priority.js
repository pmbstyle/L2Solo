const assert = require('assert');

require('../src/Global');
// Load native data before the first economic route or combat profile check.
invoke('GameServer/DataCache').init();

const NeedsEvaluator = invoke('GameServer/Bot/Goals/NeedsEvaluator');

// A far bot's goal is read from its held card: a bot with no card holds no
// market goal, so a failed material purchase sends it on no new trip by itself.
const now = 1000;
const waitingForMarket = NeedsEvaluator.evaluate({
    characterId: 10,
    level: 30,
    activity: 'hunting',
    adena: 100000,
    inventory: {},
    vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
    stats: {
        equipmentPlan: {
            next: { itemId: 1880 },
            materials: [{ selfId: 1880, missing: 20 }]
        }
    }
}, { now });
assert(!waitingForMarket.some((goal) => goal.type === 'buy_craft_material'), 'a failed material purchase must not immediately schedule another market trip');
console.log('Bot market goal priority checks passed');
