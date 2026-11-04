// Writes the Lisvus drops (droplist.sql drop categories and spoil rows) of every
// data/Npcs/Rewards/rewards.json monster Lisvus has drops for, in place of the
// NodeL2 groups the file came with (c4_legacy_monsters took the Lisvus templates of
// these monsters, this takes their drops). A table Lisvus has no drop row for keeps
// the NodeL2 groups. Groups are built as the monster slices build them
// (rewardGroups), at x1: the server rates apply at the roll. A Lisvus row whose item
// this server has no template for is left out and named here. The file is edited
// line by line to keep its hand-made layout; a second run gives the same file.
const fs = require('fs');
const path = require('path');
const generateC4MonsterLocation = require('./lib/generate-c4-monster-location');

const root = path.resolve(__dirname, '..');
const rewardsPath = path.join(root, 'data', 'Npcs', 'Rewards', 'rewards.json');

// Lisvus rows of these monsters whose item has no template here, `monster:item`:
// compressed C soulshot recipes 5154/5269, a Zweihander 5284, spellbooks and amulets
// 5014/5015/6395-6398, the grand boss jewels 6656/6660-6662.
const expectedSkippedRows = [
    '214:5269', '216:5269', '352:5284', '357:5284', '556:5154', '557:5154', '559:5154', '587:6397',
    '591:6395', '592:6396', '593:6398', '601:5269', '602:5154', '651:5014', '651:5015', '769:5269',
    '770:5269', '12001:6660', '12052:6662', '12169:6661', '12211:6656'
];
const expectedReplacedTables = 560;
const expectedRows = 7445;
// Monster tables that keep their NodeL2 groups: Lisvus has no drop row for them.
const expectedKeptMonstersWithDrops = 67;

generateC4MonsterLocation.assertLisvusRevision();
const itemNames = new Map(generateC4MonsterLocation.loadedItems()
    .filter((item) => item.template?.name)
    .map((item) => [Number(item.selfId), item.template.name]));
const npcTypes = new Map(generateC4MonsterLocation.tuples('sql/npc.sql').map((row) => [Number(row[0]), row[11]]));

const rowsByMob = new Map();
generateC4MonsterLocation.tuples('sql/droplist.sql').forEach((row) => {
    const mobId = Number(row[0]);
    if (!rowsByMob.has(mobId)) rowsByMob.set(mobId, []);
    rowsByMob.get(mobId).push(row);
});

const tables = JSON.parse(fs.readFileSync(rewardsPath, 'utf8'));
const replaced = tables.filter((table) => rowsByMob.has(Number(table.selfId)));
const kept = tables.filter((table) => !rowsByMob.has(Number(table.selfId)) && (table.rewards.length || table.spoils.length));
const keptMonsters = kept.filter((table) => !npcTypes.has(Number(table.selfId))
    || ['L2Monster', 'L2Minion'].includes(npcTypes.get(Number(table.selfId))));

const skippedRows = [];
const sourceRows = new Map(replaced.map((table) => {
    const rows = rowsByMob.get(Number(table.selfId)).filter((row) => {
        if (itemNames.has(Number(row[1]))) return true;
        skippedRows.push(`${row[0]}:${row[1]}`);
        return false;
    });
    return [Number(table.selfId), rows];
}));
const rowCount = [...sourceRows.values()].reduce((sum, rows) => sum + rows.length, 0);
generateC4MonsterLocation.assertExact(skippedRows, expectedSkippedRows, 'skipped rows');
if (replaced.length !== expectedReplacedTables || rowCount !== expectedRows
    || keptMonsters.length !== expectedKeptMonstersWithDrops) {
    throw new Error(`Expected ${expectedReplacedTables} tables, ${expectedRows} rows, ${expectedKeptMonstersWithDrops} kept monsters with drops; found ${replaced.length}, ${rowCount}, ${keptMonsters.length}`);
}

function formatGroup(group) {
    const items = group.items.map((item) => `{ "selfId": ${item.selfId}, "name": ${JSON.stringify(item.name)}, "min": ${item.min}, "max": ${item.max}, "chance": ${item.chance} }`);
    return `{ "items": [${items.join(', ')}], "overall": ${group.overall} }`;
}

function groupsLine(line, key, groups) {
    const prefix = `    "${key}": [`;
    if (!line.startsWith(prefix)) throw new Error(`Unexpected rewards.json line for ${key}: ${line.slice(0, 40)}`);
    return `${prefix}${groups.map(formatGroup).join(', ')}]${line.endsWith(',') ? ',' : ''}`;
}

const lines = fs.readFileSync(rewardsPath, 'utf8').split('\n');
sourceRows.forEach((rows, mobId) => {
    const groups = generateC4MonsterLocation.rewardGroups(rows, (itemId) => itemNames.get(itemId));
    const start = lines.indexOf(`    "selfId": ${mobId},`);
    if (start < 0 || lines.indexOf(`    "selfId": ${mobId},`, start + 1) >= 0) {
        throw new Error(`Expected one rewards.json table for monster ${mobId}`);
    }
    lines[start + 2] = groupsLine(lines[start + 2], 'rewards', groups.rewards);
    lines[start + 3] = groupsLine(lines[start + 3], 'spoils', groups.spoils);
});
const text = lines.join('\n');
JSON.parse(text);
fs.writeFileSync(rewardsPath, text);

console.info(`Wrote ${rowCount} Lisvus drop rows to ${replaced.length} rewards.json monsters (${skippedRows.length} rows without an item template left out); ${keptMonsters.length} monsters Lisvus has no drops for keep their groups: ${keptMonsters.map((table) => table.selfId).join(', ')}`);
