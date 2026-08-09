const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const vendorRepo = path.join(root, 'tmp', 'vendor', 'l2j-lisvus');
const vendorRoot = path.join(vendorRepo, 'datapack');
const expectedLisvusRevision = 'fdc7e33af5d69067b41a6ee7cc7c07fe7aa35975';

const lisvusRevision = execFileSync('git', ['-C', vendorRepo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (lisvusRevision !== expectedLisvusRevision) {
    throw new Error(`Expected Lisvus ${expectedLisvusRevision}, found ${lisvusRevision}`);
}

function read(relativePath) {
    const filepath = path.join(vendorRoot, relativePath);
    if (!fs.existsSync(filepath)) throw new Error(`Missing Lisvus source: ${filepath}`);
    return fs.readFileSync(filepath, 'utf8');
}

function parseTuple(line) {
    const start = line.indexOf('(');
    if (start < 0) return null;
    const values = [];
    let value = '';
    let quoted = false;
    let escaped = false;
    for (let index = start + 1; index < line.length; index++) {
        const char = line[index];
        if (escaped) { value += char; escaped = false; continue; }
        if (char === '\\' && quoted) { escaped = true; continue; }
        if (char === "'") {
            if (quoted && line[index + 1] === "'") { value += "'"; index++; }
            else quoted = !quoted;
            continue;
        }
        if (!quoted && (char === ',' || char === ')')) {
            const trimmed = value.trim();
            values.push(/^[-+]?\d+(?:\.\d+)?$/.test(trimmed) ? Number(trimmed) : trimmed);
            value = '';
            if (char === ')') return values;
            continue;
        }
        value += char;
    }
    return null;
}

function tuples(relativePath) {
    return read(relativePath).split(/\r?\n/).map(parseTuple).filter(Boolean);
}

function writeJson(relativePath, value) {
    const filepath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filepath), { recursive: true });
    fs.writeFileSync(filepath, `${JSON.stringify(value, null, 2)}\n`);
}

function round(value, digits = 6) {
    return Number(Number(value).toFixed(digits));
}

function loadedItems() {
    return [
        'data/Items/Armors/armors.json', 'data/Items/Armors/c4_a_grade.json',
        'data/Items/Armors/c4_sealed_a_grade.json', 'data/Items/Armors/c4_s_grade.json',
        'data/Items/Weapons/weapons.json', 'data/Items/Weapons/c4_s_grade.json',
        'data/Items/Weapons/c4_necropolis_of_sacrifice.json',
        'data/Items/Others/others.json', 'data/Items/Others/c4_a_grade.json',
        'data/Items/Others/c4_sealed_a_grade.json', 'data/Items/Others/c4_s_grade.json',
        'data/Items/Others/c4_swamp_of_screams.json', 'data/Items/Others/c4_garden_of_beasts.json',
        'data/Items/Others/c4_valley_of_saints.json', 'data/Items/Others/c4_forest_of_the_dead.json',
        'data/Items/Others/c4_devils_isle.json', 'data/Items/Others/c4_elmore_northeast_coast.json',
        'data/Items/Others/c4_necropolis_of_sacrifice.json'
    ].flatMap((relativePath) => require(path.join(root, relativePath)));
}

function vendorItems() {
    const directory = path.join(vendorRoot, 'data', 'stats', 'items');
    const items = new Map();
    fs.readdirSync(directory).filter((name) => name.endsWith('.xml')).forEach((name) => {
        const xml = fs.readFileSync(path.join(directory, name), 'utf8');
        const matcher = /<item\s+id="(\d+)"\s+name="([^"]*)"\s+type="([^"]+)"[^>]*>([\s\S]*?)<\/item>/g;
        for (const match of xml.matchAll(matcher)) {
            const sets = new Map();
            for (const setMatch of match[4].matchAll(/<set\s+name="([^"]+)"\s+val="([^"]*)"\s*\/>/g)) {
                sets.set(setMatch[1], setMatch[2]);
            }
            items.set(Number(match[1]), { id: Number(match[1]), name: match[2], type: match[3], body: match[4], sets });
        }
    });
    return items;
}

function itemKind(item) {
    const type = String(item.sets.get('etcitem_type') || '').toUpperCase();
    if (type === 'RECIPE') return 'Other.Recipe';
    if (type === 'MATERIAL') return 'Other.Material';
    return 'Other';
}

const mobIds = [1147, 1149, 1150, 1151, 1173, 1174, 1175, 1176, 1194, 1195, 1196, 1197, 1240, 1241, 1242, 1243];
const mobIdSet = new Set(mobIds);
const newMobIds = mobIds;
const newMobIdSet = mobIdSet;
const npcRowsById = new Map(tuples('sql/npc.sql').map((row) => [Number(row[0]), row]));
const spawnRows = tuples('sql/spawnlist.sql').filter((row) => row[1] === 'CatacombBranded');
if (spawnRows.length !== 252) throw new Error(`Expected 252 Catacomb of the Branded spawns, found ${spawnRows.length}`);
if (spawnRows.some((row) => !mobIdSet.has(Number(row[3])) || npcRowsById.get(Number(row[3]))?.[11] !== 'L2Monster')) {
    throw new Error('Catacomb of the Branded contains an unexpected source NPC');
}
if (spawnRows.some((row) => Number(row[2]) !== 1 || Number(row[10]) !== 60 || Number(row[12]) !== 0)) {
    throw new Error('Unexpected Catacomb of the Branded count, respawn, or period semantics');
}
const sourceIds = [...new Set(spawnRows.map((row) => Number(row[3])))].sort((a, b) => a - b);
if (JSON.stringify(sourceIds) !== JSON.stringify(mobIds)) {
    throw new Error(`Expected monster ids ${mobIds.join(', ')}, found ${sourceIds.join(', ')}`);
}

const skillRows = tuples('sql/npcskills.sql')
    .filter((row) => newMobIdSet.has(Number(row[0])))
    .map((row) => ({ npcId: Number(row[0]), skillId: Number(row[1]), level: Number(row[2]) }));
if (skillRows.length !== 109) throw new Error(`Expected 109 NPC skill rows, found ${skillRows.length}`);
const raceBySkill = new Map([
    [4290, 'undead'], [4291, 'construct'], [4292, 'beast'], [4297, 'divine'], [4298, 'demonic']
]);
const raceByNpc = new Map();
skillRows.forEach((row) => {
    const race = raceBySkill.get(row.skillId);
    if (race) raceByNpc.set(row.npcId, race);
});

const existingItems = loadedItems();
const existingItemsById = new Map(existingItems.map((item) => [Number(item.selfId), item]));
const sourceItemsById = vendorItems();
const npcs = newMobIds.map((id) => npcRowsById.get(id)).map((row) => {
    const [
        id, , name, , title, , , collisionRadius, collisionHeight, level, , type,
        attackRange, hp, mp, hpRegen, mpRegen, str, con, dex, int, wit, men,
        exp, sp, pAtk, pDef, mAtk, mDef, atkSpd, aggro, castSpd, rightHand, leftHand,
        , walk, run, faction, helpRadius, undead
    ] = row;
    const race = raceByNpc.get(id);
    if (type !== 'L2Monster' || !race) throw new Error(`Invalid source NPC ${id}: type=${type} race=${race}`);
    const weapon = existingItemsById.get(Number(rightHand));
    return {
        selfId: id,
        template: { kind: 'Monster', name, title, level, hostile: Number(aggro) > 0 },
        base: { str, dex, con, int, wit, men },
        stats: {
            pAtk, pAtkRnd: Number(weapon?.stats?.pAtkRnd ?? 30), pDef, mAtk, mDef,
            accur: Number(weapon?.stats?.accur ?? 4.75), atkSpd, castSpd, atkRadius: attackRange
        },
        speed: { walk, run },
        vitals: { maxHp: hp, maxMp: mp, revHp: hpRegen, revMp: mpRegen, corpseTime: 7000 },
        collision: { radius: collisionRadius, size: collisionHeight },
        equipment: { weapon: rightHand, shield: leftHand, reuseTime: 0 },
        clan: { clanName: faction === 'NULL' ? '' : faction, helpRadius },
        rewards: { exp: level > 0 ? round(exp / (level * level), 12) : 0, sp },
        traits: { race, undead: Number(undead) !== 0 }
    };
});

const npcNameById = new Map(mobIds.map((id) => [id, npcRowsById.get(id)[2]]));
const spawnDefinitions = mobIds.map((npcId) => ({
    selfId: npcId,
    name: npcNameById.get(npcId),
    coords: spawnRows.filter((row) => Number(row[3]) === npcId)
        .map((row) => ({ locX: row[4], locY: row[5], locZ: row[6], head: row[9] })),
    total: 1,
    respawn: 60,
    bias: 0
}));
const spawns = [{ selfId: 'c4-catacomb-of-the-branded', bounds: [], spawns: spawnDefinitions }];

const dropRows = tuples('sql/droplist.sql').filter((row) => newMobIdSet.has(Number(row[0])));
if (dropRows.length !== 236) throw new Error(`Expected 236 monster drops, found ${dropRows.length}`);
function sourceItemName(itemId) {
    const existing = existingItemsById.get(itemId);
    if (existing) return existing.template.name;
    const source = sourceItemsById.get(itemId);
    if (!source) throw new Error(`Missing item template ${itemId}`);
    return source.name;
}

const rewards = newMobIds.map((mobId) => {
    const rows = dropRows.filter((row) => Number(row[0]) === mobId);
    const categories = new Map();
    rows.filter((row) => Number(row[4]) >= 0).forEach((row) => {
        const category = Number(row[4]);
        if (!categories.has(category)) categories.set(category, []);
        categories.get(category).push(row);
    });
    const normal = [...categories.values()].map((categoryRows) => {
        const totalChance = categoryRows.reduce((sum, row) => sum + Number(row[5]), 0);
        return {
            items: categoryRows.map((row) => ({
                selfId: Number(row[1]), name: sourceItemName(Number(row[1])), min: Number(row[2]),
                max: Number(row[3]), chance: round(Number(row[5]) / totalChance * 100)
            })),
            overall: round(totalChance / 10000)
        };
    });
    const spoils = rows.filter((row) => Number(row[4]) === -1).map((row) => ({
        items: [{
            selfId: Number(row[1]), name: sourceItemName(Number(row[1])), min: Number(row[2]),
            max: Number(row[3]), chance: round(Number(row[5]) / 10000)
        }],
        overall: 100
    }));
    return { selfId: mobId, template: { name: npcNameById.get(mobId) }, rewards: normal, spoils };
});

const requiredItemIds = new Set(dropRows.map((row) => Number(row[1])));
const missingSourceItems = [...requiredItemIds].filter((id) => !existingItemsById.has(id)).sort((a, b) => a - b).map((id) => {
    const source = sourceItemsById.get(id);
    if (!source) throw new Error(`Missing source item ${id}`);
    return source;
});
const missingWeapons = missingSourceItems.filter((source) => source.type === 'Weapon').map((source) => {
    const stat = (name) => Number(source.body.match(new RegExp(`stat="${name}" val="([^"]+)"`))?.[1] || 0);
    const weaponType = String(source.sets.get('weapon_type') || '').toUpperCase();
    if (weaponType !== 'BIGSWORD') throw new Error(`Unsupported weapon dependency ${source.id}: ${weaponType}`);
    return {
        selfId: source.id,
        template: {
            kind: 'Weapon.GreatSword', name: source.name, class1: 0, class2: 0,
            mass: Number(source.sets.get('weight') || 0), price: Number(source.sets.get('price') || 0)
        },
        stats: {
            pAtk: stat('pAtk'), pAtkRnd: Number(source.sets.get('random_damage') || 0),
            mAtk: stat('mAtk'), atkSpd: stat('pAtkSpd'), crit: stat('rCrit'), accur: stat('accCombat')
        },
        etc: {
            slot: 14, mp: 0, soulshot: Number(source.sets.get('soulshots') || 0),
            spiritshot: Number(source.sets.get('spiritshots') || 0),
            rank: String(source.sets.get('crystal_type') || 'none').toLowerCase(),
            cristals: Number(source.sets.get('crystal_count') || 0)
        }
    };
});
const missingItems = missingSourceItems.filter((source) => source.type !== 'Weapon').map((source) => {
    return {
        selfId: source.id,
        template: {
            kind: itemKind(source), name: source.name, class1: 4, class2: 0,
            mass: Number(source.sets.get('weight') || 0), price: Number(source.sets.get('price') || 0)
        },
        etc: { stackable: source.sets.get('is_stackable') === 'true', consumable: false }
    };
});
if (missingWeapons.length !== 0) {
    throw new Error(`Expected no weapon dependencies, found ${missingWeapons.map((item) => item.selfId).join(', ')}`);
}
const expectedMissingItemIds = [5164, 6036, 6361];
if (JSON.stringify(missingItems.map((item) => item.selfId)) !== JSON.stringify(expectedMissingItemIds)) {
    throw new Error(`Expected item dependencies ${expectedMissingItemIds.join(', ')}, found ${missingItems.map((item) => item.selfId).join(', ')}`);
}

writeJson('data/Npcs/c4_catacomb_of_the_branded.json', npcs);
writeJson('data/Npcs/Spawns/c4_catacomb_of_the_branded.json', spawns);
writeJson('data/Npcs/Rewards/c4_catacomb_of_the_branded.json', rewards);
writeJson('data/Items/Others/c4_catacomb_of_the_branded.json', missingItems);
writeJson('data/Npcs/Skills/c4_catacomb_of_the_branded.json', skillRows);

console.info(`Generated ${npcs.length} NPCs, ${spawnRows.length} spawns, ${dropRows.length} drops, ${skillRows.length} skills, ${missingWeapons.length} weapons, ${missingItems.length} items.`);
