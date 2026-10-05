// The A and S recipe scroll turn-ins of the Lisvus C4 quests, as data for the
// quests that do not run yet: what each quest NPC takes, what it hands out with
// which chance, and where the script drops the quest items. Read from L2J Lisvus
// fdc7e33a data/scripts/quests/<script>/__init__.py with its default settings
// (ALT_RP_100 off, quest drop rate 1); item names come from the Lisvus item XML.
// Quests 335, 378 and 635 were checked and hand out no A or S recipe scroll.
// An exchange's outcomes have a chance in percent that sums to 100; its items are
// all given, or `pick` distinct random ones, or `choose` ones the player picks;
// adena, exp and sp are amounts. `requires` are items the quest checks at start,
// `option` names one of several turn-ins the same NPC offers for the same items.
const path = require('path');
const root = path.resolve(__dirname, '..');
process.chdir(root);
const fs = require('fs');
const lib = require('./lib/generate-c4-monster-location');

lib.assertLisvusRevision();
const src = lib.vendorItems();
const name = (id) => { const n = src.get(id)?.name; if (!n) throw new Error('no name ' + id); return n.replace(/&amp;/g, '&'); };
const item = (selfId, count = 1) => ({ selfId, name: name(selfId), count });
const items = (ids, count = 1) => ids.map((id) => item(id, count));
const range = (a, b, s = 1) => { const r = []; for (let i = a; i < b; i += s) r.push(i); return r; };
const drops = (selfId, monsters) => ({ selfId, name: name(selfId), chanceByMonster: Object.fromEntries(monsters) });

const S_RECIPES = [6881, 6883, 6885, 6887, 6891, 6893, 6895, 6897, 6899, 7580];
const wald = (label, recipes, parts, give) => ({
    npc: 7844, option: label, give,
    outcomes: [
        { chance: 1, items: items([...recipes, ...parts]) },
        { chance: 2, adena: 4000 },
        { chance: 2, items: items([...recipes, ...parts]), pick: 2 },
        { chance: 95, items: items([...recipes, ...parts]), pick: 1 }
    ]
});
const toiBlueprints = items(range(5989, 6002));
const q619Monsters = [...range(1396, 1435), 1798, 1799, 1800, ...range(12955, 13092)];

const quests = [
    {
        quest: 358, script: '358_IllegitimateChildOfAGoddess', name: 'Illegitimate Child Of A Goddess', startNpc: 7862, minLevel: 63,
        drops: [drops(5868, [[672, 12], [673, 12]])],
        exchanges: [{ npc: 7862, give: [item(5868, 108)], outcomes: [
            { chance: 100, items: items([...range(6329, 6340, 2), 5364, 5366]), pick: 1 }
        ] }]
    },
    {
        quest: 372, script: '372_LegacyOfInsolence', name: 'Legacy of Insolence', startNpc: 7844, minLevel: 59,
        drops: [drops(5966, [[817, 35], [821, 40], [825, 45]]), drops(5967, [[829, 40]]), drops(5968, [[1069, 25]]), drops(5969, [[1062, 25], [1063, 25]])],
        exchanges: [
            wald('Dark Crystal', [5368, 5392, 5426], [5525, 5508, 5496], toiBlueprints),
            wald('Tallum', [5370, 5394, 5428], [5526, 5509, 5497], toiBlueprints),
            wald('Nightmare', [5380, 5404, 5430], [5527, 5514, 5502], toiBlueprints),
            wald('Majestic', [5382, 5406, 5432], [5528, 5515, 5503], toiBlueprints)
        ]
    },
    {
        quest: 375, script: '375_WhisperOfDreams2', name: 'Whisper of Dreams, part 2', startNpc: 7515, minLevel: 60, requires: [item(5887)],
        drops: [drops(5889, [[624, 100]]), drops(5888, [[629, 100]])],
        exchanges: [{ npc: 7515, give: [item(5889, 100), item(5888, 100)], outcomes: [
            { chance: 100, items: items([5348, 5350, 5352]), pick: 1 }
        ] }]
    },
    {
        quest: 376, script: '376_GiantsExploration1', name: 'Giants Exploration Part1', startNpc: 8147, minLevel: 51,
        drops: [drops(5944, [[647, 15], [648, 15], [649, 15], [650, 15]]), drops(5890, [[647, 5], [648, 5], [649, 5], [650, 5]])],
        exchanges: [
            [range(5937, 5942), 5346, 5354],
            [range(5932, 5937), 5332, 5334],
            [range(5922, 5927), 5416, 5418],
            [range(5927, 5932), 5424, 5340]
        ].map(([set, first, second]) => ({ npc: 8147, give: items(set), outcomes: [
            { chance: 50, items: [item(first)] }, { chance: 50, items: [item(second)] }
        ] }))
    },
    {
        quest: 377, script: '377_GiantsExploration2', name: 'Exploration of Giants Cave, part 2', startNpc: 8147, minLevel: 57, requires: [item(5892)],
        drops: [drops(5955, [[654, 15], [656, 15], [657, 15], [658, 15]])],
        exchanges: [
            { npc: 8147, give: items(range(5945, 5950)), outcomes: [{ chance: 49, items: [item(5336)] }, { chance: 51, items: [item(5338)] }] },
            { npc: 8147, give: items(range(5950, 5955)), outcomes: [{ chance: 49, items: [item(5422)] }, { chance: 51, items: [item(5420)] }] }
        ]
    },
    {
        quest: 617, script: '617_GatherTheFlames', name: 'Gather The Flames', startNpc: 8539, minLevel: 74,
        drops: [drops(7264, [[1376, 48], [1377, 48], [1378, 49], [1379, 59], [1380, 49], [1381, 51], [1382, 60], [1383, 51], [1384, 64], [1385, 52], [1386, 52], [1387, 53], [1388, 53], [1389, 55], [1390, 56], [1391, 55], [1392, 56], [1393, 58], [1394, 51], [1395, 56], [1652, 49], [1653, 51], [1654, 52], [1655, 53], [1656, 69], [1657, 57]])],
        exchanges: [{ npc: 8539, give: [item(7264, 1000)], outcomes: [{ chance: 100, items: items(S_RECIPES), pick: 1 }] }]
    },
    {
        quest: 619, script: '619_RelicsOfTheOldEmpire', name: 'Relics of the Old Empire', startNpc: 8538, minLevel: 74,
        drops: [drops(7254, q619Monsters.map((id) => [id, 100])), drops(7075, q619Monsters.map((id) => [id, 5]))],
        exchanges: [{ npc: 8538, give: [item(7254, 1000)], outcomes: [{ chance: 100, items: items(S_RECIPES), pick: 1 }] }]
    },
    {
        quest: 620, script: '620_FourGoblets', name: 'Four Goblets', startNpc: 8453, minLevel: 74,
        drops: [drops(7255, range(12955, 13091).map((id) => [id, 30]))],
        exchanges: [{ npc: 8454, give: [item(7254, 1000)], outcomes: [{ chance: 100, items: items(S_RECIPES), choose: 1 }] }]
    },
    {
        quest: 621, script: '621_EggDelivery', name: 'Egg Delivery', startNpc: 8521, minLevel: 68, maxLevel: 73,
        exchanges: [{ npc: 8521, give: [item(7196, 5)], outcomes: [
            { chance: 10, items: items([6847, 6849, 6851]), pick: 1 },
            { chance: 90, adena: 18800, items: [item(734)] }
        ] }]
    },
    {
        quest: 622, script: '622_DeliveryOfSpecialLiquor', name: 'Delivery of special liquor', startNpc: 8521, minLevel: 68,
        exchanges: [{ npc: 8521, give: [item(7198, 5)], outcomes: [
            { chance: 10, items: items([6847, 6849, 6851]), pick: 1 },
            { chance: 90, adena: 18800, items: [item(734)] }
        ] }]
    },
    {
        quest: 623, script: '623_TheFinestFood', name: 'The Finest Food', startNpc: 8521, minLevel: 71,
        drops: [drops(7200, [[1315, 99]]), drops(7199, [[1316, 99]]), drops(7201, [[1318, 99]])],
        exchanges: [{ npc: 8521, give: [item(7199, 100), item(7200, 100), item(7201, 100)], outcomes: [
            { chance: 12, adena: 25000, items: [item(6849)] },
            { chance: 12, adena: 65000, items: [item(6847)] },
            { chance: 10, adena: 25000, items: [item(6851)] },
            { chance: 66, adena: 73000, exp: 230000, sp: 18250 }
        ] }]
    }
];
for (const q of quests) for (const e of q.exchanges) {
    const sum = e.outcomes.reduce((s, o) => s + o.chance, 0);
    if (sum !== 100) throw new Error(`quest ${q.quest} outcomes sum ${sum}`);
}
// Pretty JSON with every object or array of plain values on one line.
function format(value, indent = '') {
    const plain = (v) => v === null || typeof v !== 'object';
    if (plain(value)) return JSON.stringify(value);
    const inner = indent + '  ';
    if (Array.isArray(value)) {
        if (value.every(plain)) return `[${value.map((v) => JSON.stringify(v)).join(', ')}]`;
        return `[\n${value.map((v) => inner + format(v, inner)).join(',\n')}\n${indent}]`;
    }
    const entries = Object.entries(value);
    if (entries.every(([, v]) => plain(v))) return `{ ${entries.map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(', ')} }`;
    return `{\n${entries.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${format(v, inner)}`).join(',\n')}\n${indent}}`;
}
fs.writeFileSync('data/Recipes/c4_high_grade_recipe_quests.json', format(quests) + '\n');
if (JSON.stringify(JSON.parse(fs.readFileSync('data/Recipes/c4_high_grade_recipe_quests.json', 'utf8'))) !== JSON.stringify(quests)) throw new Error('format');
console.log('quests', quests.length, 'exchanges', quests.reduce((n, q) => n + q.exchanges.length, 0));
