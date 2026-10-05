// Adds the C4 high-grade drop rows that data/Npcs/Rewards/rewards.json lacks on
// its spawned monsters: B grade recipe scrolls and Scroll: Enchant Armor (Grade A). rewards.json is not a Lisvus list, so its own groups stay
// untouched; the missing Lisvus rows are appended as new groups, grouped the
// way the monster slices group a Lisvus drop category (spoil rows one by one).
// The file is edited line by line to keep its hand-made layout.
const fs = require('fs');
const path = require('path');
const generateC4MonsterLocation = require('./lib/generate-c4-monster-location');

const root = path.resolve(__dirname, '..');
process.chdir(root);
const C4RecipeItems = require(path.join(root, 'src', 'GameServer', 'Items', 'C4RecipeItems'));

const rewardsPath = path.join(root, 'data', 'Npcs', 'Rewards', 'rewards.json');
const enchantArmorA = 730;
// Every Lisvus row of those items on these monsters, present before or added here.
const expectedRecipeRows = 109;
const expectedEnchantRows = 2;
const expectedMonsters = 53;

generateC4MonsterLocation.assertLisvusRevision();
const sourceItems = generateC4MonsterLocation.vendorItems();
const itemNames = new Map(generateC4MonsterLocation.loadedItems()
    .filter((item) => item.template?.name)
    .map((item) => [Number(item.selfId), item.template.name]));

const bRecipeScrolls = new Set(Object.values(C4RecipeItems.loadRecipeItems())
    .filter((recipe) => String(sourceItems.get(recipe.productId)?.sets.get('crystal_type') || '').toUpperCase() === 'B')
    .map((recipe) => recipe.recipeItemId));

const lisvusSpawned = new Set(generateC4MonsterLocation.tuples('sql/spawnlist.sql').map((row) => Number(row[3])));
const spawnDirectory = path.join(root, 'data', 'Npcs', 'Spawns');
const spawnedHere = new Set(fs.readdirSync(spawnDirectory)
    .filter((name) => name.endsWith('.json'))
    .flatMap((name) => require(path.join(spawnDirectory, name)))
    .flatMap((area) => area.spawns || [])
    .map((spawn) => Number(spawn.selfId)));

const rewardTables = JSON.parse(fs.readFileSync(rewardsPath, 'utf8'));
const ownItemsByMob = new Map(rewardTables.map((table) => [Number(table.selfId), new Set(
    [...table.rewards, ...table.spoils].flatMap((group) => group.items.map((item) => Number(item.selfId)))
)]));

const candidateRows = generateC4MonsterLocation.tuples('sql/droplist.sql').filter((row) => {
    const mobId = Number(row[0]);
    const itemId = Number(row[1]);
    return (bRecipeScrolls.has(itemId) || itemId === enchantArmorA)
        && ownItemsByMob.has(mobId) && lisvusSpawned.has(mobId) && spawnedHere.has(mobId);
});
const recipeRows = candidateRows.filter((row) => Number(row[1]) !== enchantArmorA).length;
const enchantRows = candidateRows.length - recipeRows;
const candidateMonsters = new Set(candidateRows.map((row) => Number(row[0]))).size;
if (recipeRows !== expectedRecipeRows || enchantRows !== expectedEnchantRows || candidateMonsters !== expectedMonsters) {
    throw new Error(`Expected ${expectedRecipeRows} recipe and ${expectedEnchantRows} enchant rows on ${expectedMonsters} monsters, found ${recipeRows}, ${enchantRows} on ${candidateMonsters}`);
}
const missingRows = candidateRows.filter((row) => !ownItemsByMob.get(Number(row[0])).has(Number(row[1])));
const monsterIds = [...new Set(missingRows.map((row) => Number(row[0])))];

function itemName(itemId) {
    const name = itemNames.get(itemId);
    if (!name) throw new Error(`Missing item template ${itemId}`);
    return name;
}

function formatGroup(group) {
    const items = group.items.map((item) => `{ "selfId": ${item.selfId}, "name": ${JSON.stringify(item.name)}, "min": ${item.min}, "max": ${item.max}, "chance": ${item.chance} }`);
    return `{ "items": [${items.join(', ')}], "overall": ${group.overall} }`;
}

function appendGroups(line, key, groups) {
    if (groups.length === 0) return line;
    const prefix = `    "${key}": [`;
    if (!line.startsWith(prefix)) throw new Error(`Unexpected rewards.json line for ${key}: ${line.slice(0, 40)}`);
    const added = groups.map(formatGroup).join(', ');
    const close = line.endsWith(',') ? '],' : ']';
    const body = line.slice(prefix.length, line.length - close.length);
    if (!line.endsWith(close)) throw new Error(`Unexpected rewards.json line end for ${key}`);
    return `${prefix}${body ? `${body}, ` : ''}${added}${close}`;
}

const lines = fs.readFileSync(rewardsPath, 'utf8').split('\n');
monsterIds.forEach((mobId) => {
    const groups = generateC4MonsterLocation.rewardGroups(
        missingRows.filter((row) => Number(row[0]) === mobId), itemName
    );
    const start = lines.indexOf(`    "selfId": ${mobId},`);
    if (start < 0 || lines.indexOf(`    "selfId": ${mobId},`, start + 1) >= 0) {
        throw new Error(`Expected one rewards.json table for monster ${mobId}`);
    }
    lines[start + 2] = appendGroups(lines[start + 2], 'rewards', groups.rewards);
    lines[start + 3] = appendGroups(lines[start + 3], 'spoils', groups.spoils);
});
const text = lines.join('\n');
JSON.parse(text);
fs.writeFileSync(rewardsPath, text);

console.info(`Added ${missingRows.length} drop rows to ${monsterIds.length} rewards.json monsters; all ${candidateRows.length} high-grade rows are present.`);
