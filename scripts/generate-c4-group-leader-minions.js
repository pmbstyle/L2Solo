// Minion groups of ordinary (non-raid) group leaders from L2J_Mobius C4 (the reference
// for C4 data, user 2026-10-26; its npc stats <minions>), in the raid-boss minion format
// (data/Npcs/Minions), for the leaders our world spawns. The pinned Lisvus minions table
// is the second witness: every difference is named below. Minion templates the world
// does not define yet are added from Lisvus npc.sql in the shape the monster slices use.
// Vendor: tmp/vendor/l2j-mobius and tmp/vendor/l2j-lisvus (scripts/generate-c4-mobius-spawns.js).
const fs = require('fs');
const path = require('path');
const lib = require('./lib/generate-c4-monster-location');
const Mobius = require('./generate-c4-mobius-spawns');

const root = path.resolve(__dirname, '..');
const slug = 'c4_group_leader_minions';
const filename = `${slug}.json`;

// Mobius leaders our world does not spawn: 376, 398, 520, 522, 738 and 5259-5290 (no
// Mobius spawn either), 12045 and four Four Sepulchers Shadows of Halisha.
const absentLeaderIds = [376, 398, 520, 522, 738, 5259, 5260, 5266, 5267, 5290, 10339, 10342, 10346, 10349, 12045];
// The Fairy Trees of Q421 (5185-5188): Mobius gives each three standing Souls of Tree
// Guardian (5189); here the tree's death calls twenty of them (Pets/FairyTrees.js, the
// author's design), and standing ones would attack the hatchling the quest sends at the tree.
const questLeaderIds = new Set([5185, 5186, 5187, 5188]);
// Lisvus second witness, as `leader:minion`.
// Rows only Mobius has (22 leaders, among them 1512 > 1518, which spawned nowhere before).
const mobiusOnlyRows = [
    '751:1039', '753:754', '755:756', '755:757', '939:936', '939:937', '939:938', '977:1073',
    '1432:1433', '1434:1435', '1434:1436', '1434:1823', '1512:1518', '1517:1519', '1652:1378',
    '1653:1381', '1654:1384', '1655:1387', '1656:1390', '1657:1393', '5041:5042', '5062:5063',
    '5068:5069', '5093:253', '5108:5109', '5112:5111', '5114:5115'
];
// Rows only Lisvus has: Mobius places 930 and 933 alone (its 928/929 and 931/932 beside them).
const lisvusOnlyRows = ['930:928', '930:929', '933:931', '933:932'];
// Rows whose minion count differs (Mobius count, Lisvus min-max): Mobius is kept.
const countDiffRows = [
    '745:746', '749:750', '751:752', '753:1040', '947:945', '947:946', '950:948', '950:949',
    '953:951', '953:952', '986:987', '986:988', '5036:5037', '5110:5111', '5113:5111'
];
const expectedNewMinionIds = [
    936, 937, 938, 940, 942, 943, 945, 946, 948, 949, 951, 952, 954, 955, 957, 958, 960, 961, 962,
    964, 965, 967, 968, 970, 971, 972, 975, 976, 978, 979, 981, 982, 984, 985, 987, 988, 990,
    992, 993, 995, 1039, 1040, 1059, 1060, 1073, 1074, 1076, 1077, 1079, 1080, 1082, 1083, 1091,
    1092, 1313, 1344, 1346, 1348, 1349, 1370, 1372, 1374, 1375, 1433, 1435, 1436, 1519, 1542,
    1543, 1545, 1546, 1597, 1598, 1600, 1601, 1823
];

lib.assertLisvusRevision();
Mobius.assertMobiusRevision();

function jsonArrays(directory) {
    return fs.readdirSync(path.join(root, directory))
        .filter((name) => name.endsWith('.json'))
        .map((name) => require(path.join(root, directory, name)))
        .filter(Array.isArray)
        .flat();
}

const rowKey = (row) => `${row.bossId}:${row.minionId}`;

// Mobius <minions> rows, ids mapped to C4 client ids: `count` mobs, or `count`-`max` when
// the row has a max. Only leaders of a monster type: raid bosses keep their own file, and
// Mobius's Folk 7424 Allana (three guards) and festival monsters are not world monsters here.
// Mobius's per-row respawnTime is not kept: an ordinary minion here stays dead while its
// leader lives, as in Lisvus (RaidBossMinionManager).
function mobiusMinionRows() {
    const idMap = Mobius.c4Ids();
    const rows = [];
    let listed = 0;
    for (const file of Mobius.xmlFiles(path.join(Mobius.mobiusData, 'stats', 'npcs'))) {
        const xml = fs.readFileSync(file, 'utf8');
        listed += [...xml.matchAll(/<minions\b[^>]*>([\s\S]*?)<\/minions>/g)]
            .reduce((sum, block) => sum + [...block[1].matchAll(/<npc\b/g)].length, 0);
        for (const npc of xml.matchAll(/^\t<npc\b([^>]*)>([\s\S]*?)^\t<\/npc>/gm)) {
            const leader = Mobius.attributes(npc[1]);
            for (const block of npc[2].matchAll(/<minions\b[^>]*>([\s\S]*?)<\/minions>/g)) {
                for (const minion of block[1].matchAll(/<npc\b[^>]*>/g)) {
                    const attrs = Mobius.attributes(minion[0]);
                    rows.push({
                        bossId: Mobius.c4Id(idMap, Number(leader.id), `${file} leader`),
                        minionId: Mobius.c4Id(idMap, Number(attrs.id), `${file} minion of ${leader.id}`),
                        min: Number(attrs.count),
                        max: Number(attrs.max || attrs.count),
                        type: leader.type
                    });
                }
            }
        }
    }
    if (rows.length !== listed) throw new Error(`Parsed ${rows.length} of ${listed} Mobius minion rows`);
    return rows.filter((row) => Mobius.MONSTER_TYPES.has(row.type))
        .map(({ bossId, minionId, min, max }) => ({ bossId, minionId, min, max }));
}

const raidMinionRows = require(path.join(root, 'data/Npcs/Minions/c4_raid_bosses.json'));
const raidBossIds = new Set(raidMinionRows.map((row) => Number(row.bossId)));
const mobiusRows = mobiusMinionRows().filter((row) => !raidBossIds.has(row.bossId));
if (mobiusRows.length !== 146) throw new Error(`Expected 146 Mobius ordinary group leader rows, found ${mobiusRows.length}`);
const lisvusRows = lib.tuples('sql/minions.sql')
    .filter((row) => row.length === 4 && row.every(Number.isInteger)) // not the PRIMARY KEY line
    .map((row) => ({ bossId: Number(row[0]), minionId: Number(row[1]), min: Number(row[2]), max: Number(row[3]) }));
if (lisvusRows.length !== 405) throw new Error(`Expected 405 Lisvus minion rows, found ${lisvusRows.length}`);

const knownNpcs = Mobius.ownTemplates(filename);
if (mobiusRows.some((row) => knownNpcs.get(row.bossId)?.template?.raidBoss === true)) {
    throw new Error('A raid boss leads an ordinary minion row');
}
const spawnedIds = new Set(jsonArrays('data/Npcs/Spawns')
    .flatMap((area) => area.spawns || [])
    .filter((spawn) => Number(spawn.total) > 0)
    .map((spawn) => Number(spawn.selfId)));

const absentIds = [...new Set(mobiusRows.filter((row) => !spawnedIds.has(row.bossId)).map((row) => row.bossId))]
    .sort((a, b) => a - b);
lib.assertExact(absentIds, absentLeaderIds, 'absent group leaders');
const rows = mobiusRows.filter((row) => spawnedIds.has(row.bossId) && !questLeaderIds.has(row.bossId));
if (rows.length !== 117) throw new Error(`Expected 117 rows of spawned group leaders, found ${rows.length}`);

const witness = new Map(lisvusRows.filter((row) => !raidBossIds.has(row.bossId) && spawnedIds.has(row.bossId))
    .map((row) => [rowKey(row), row]));
const kept = new Map(rows.map((row) => [rowKey(row), row]));
lib.assertExact(rows.filter((row) => !witness.has(rowKey(row))).map(rowKey), mobiusOnlyRows, 'rows only Mobius has');
lib.assertExact([...witness.keys()].filter((key) => !kept.has(key)), lisvusOnlyRows, 'rows only Lisvus has');
lib.assertExact(rows.filter((row) => witness.has(rowKey(row))
    && (witness.get(rowKey(row)).min !== row.min || witness.get(rowKey(row)).max !== row.max)).map(rowKey),
countDiffRows, 'rows whose count differs from Lisvus');

const newMinionIds = [...new Set(rows.map((row) => row.minionId))]
    .filter((id) => !knownNpcs.has(id))
    .sort((a, b) => a - b);
lib.assertExact(newMinionIds, expectedNewMinionIds, 'new minion templates');

// Lisvus spawns most of them as L2Minion; the rest are plain monsters
// that only ever appear as someone's minion.
const { npcs, rewards, skillRows, dropRows, items: missingItems, unknownSkillIds } =
    lib.lisvusMonsters(newMinionIds, { slug, types: ['L2Minion', 'L2Monster'] });
if (skillRows.length !== 434) throw new Error(`Expected 434 minion skill rows, found ${skillRows.length}`);

// NPC Self Damage Shield (Lisvus skills 4100-4199.xml): a self buff, 600 s.
const skillTemplates = [{
    selfId: 4163,
    template: { name: 'NPC Self Damage Shield', passive: false, spell: false, distance: -1 },
    time: { hitTime: 1800, reuse: 8000, buff: 600000 },
    levels: [12, 19, 26, 35, 45, 55, 65, 69, 72, 75, 77, 78].map((mp, index) => ({
        level: index + 1, power: 0, mp, hp: 0, itemId: 0, itemCount: 0
    }))
}, {
    // Ultimate Buff, 2nd (Lisvus skills 4300-4399.xml), in the shape of the Imperial Tomb's 4341.
    selfId: 4340,
    template: { name: 'Ultimate Buff, 2nd', passive: false, spell: false, distance: -1 },
    time: { hitTime: 0, reuse: 0, buff: 15000 },
    levels: [{ level: 1, power: 0, mp: 50, hp: 0, itemId: 0, itemCount: 0 }]
}];
lib.assertExact(unknownSkillIds, skillTemplates.map((skill) => skill.selfId), 'missing minion skill templates');

if (dropRows.length !== 1194) throw new Error(`Expected 1194 minion drop rows, found ${dropRows.length}`);
// Recipe: Greater Spiritshot (B) Compressed Package (100%), recipe 505 of recipes.csv.
lib.assertExact(missingItems.map((item) => item.selfId), [5275], 'item dependencies');

lib.writeJson('data/Npcs/Minions/c4_group_leaders.json', rows);
lib.writeJson(`data/Npcs/${filename}`, npcs);
lib.writeJson(`data/Npcs/Rewards/${filename}`, rewards);
lib.writeJson(`data/Npcs/Skills/${filename}`, skillRows);
lib.writeJson(`data/Npcs/Skills/${slug}_templates.json`, skillTemplates);
lib.writeJson(`data/Items/Others/${filename}`, missingItems);

const leaderCount = new Set(rows.map((row) => row.bossId)).size;
console.info(`Generated ${rows.length} minion rows for ${leaderCount} group leaders, ${npcs.length} minion templates, ${skillRows.length} skill rows, ${skillTemplates.length} skill templates, ${dropRows.length} drop rows, ${missingItems.length} items.`);
