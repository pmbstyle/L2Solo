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
        'data/Items/Armors/armors.json',
        'data/Items/Armors/c4_a_grade.json',
        'data/Items/Armors/c4_sealed_a_grade.json',
        'data/Items/Armors/c4_s_grade.json',
        'data/Items/Weapons/weapons.json',
        'data/Items/Weapons/c4_s_grade.json',
        'data/Items/Others/others.json',
        'data/Items/Others/c4_a_grade.json',
        'data/Items/Others/c4_sealed_a_grade.json',
        'data/Items/Others/c4_s_grade.json',
        'data/Items/Others/c4_swamp_of_screams.json',
        'data/Items/Others/c4_garden_of_beasts.json',
        'data/Items/Others/c4_valley_of_saints.json',
        'data/Items/Others/c4_forest_of_the_dead.json'
    ].flatMap((relativePath) => require(path.join(root, relativePath)));
}

function vendorItems() {
    const directory = path.join(vendorRoot, 'data', 'stats', 'items');
    const items = new Map();
    fs.readdirSync(directory).filter((name) => name.endsWith('.xml')).forEach((name) => {
        const xml = fs.readFileSync(path.join(directory, name), 'utf8');
        const matcher = /<item\s+id="(\d+)"\s+name="([^"]*)"[^>]*>([\s\S]*?)<\/item>/g;
        for (const match of xml.matchAll(matcher)) {
            const sets = new Map();
            for (const setMatch of match[3].matchAll(/<set\s+name="([^"]+)"\s+val="([^"]*)"\s*\/>/g)) {
                sets.set(setMatch[1], setMatch[2]);
            }
            items.set(Number(match[1]), { id: Number(match[1]), name: match[2], sets });
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

const allNpcRows = tuples('sql/npc.sql');
const npcRowsById = new Map(allNpcRows.map((row) => [Number(row[0]), row]));
const spawnRows = tuples('sql/spawnlist.sql').filter((row) => row[1] === 'devilsisle');
if (spawnRows.length !== 452) throw new Error(`Expected 452 Devil's Isle spawns, found ${spawnRows.length}`);
if (spawnRows.some((row) => npcRowsById.get(Number(row[3]))?.[11] !== 'L2Monster')) {
    throw new Error("Devil's Isle source label contains a non-monster row");
}
if (spawnRows.some((row) => Number(row[2]) !== 1 || Number(row[12]) !== 0)) {
    throw new Error("Unexpected Devil's Isle spawn count or period semantics");
}
const mobIds = [...new Set(spawnRows.map((row) => Number(row[3])))].sort((a, b) => a - b);
if (mobIds.length !== 15) throw new Error(`Expected 15 monster variants, found ${mobIds.length}`);
const mobIdSet = new Set(mobIds);

const skillRows = tuples('sql/npcskills.sql')
    .filter((row) => mobIdSet.has(Number(row[0])))
    .map((row) => ({ npcId: Number(row[0]), skillId: Number(row[1]), level: Number(row[2]) }));
if (skillRows.length !== 88) throw new Error(`Expected 88 NPC skill rows, found ${skillRows.length}`);

const raceBySkill = new Map([
    [4290, 'undead'], [4291, 'construct'], [4298, 'demonic'], [4301, 'insect']
]);
const raceByNpc = new Map();
skillRows.forEach((row) => {
    const race = raceBySkill.get(row.skillId);
    if (race) raceByNpc.set(row.npcId, race);
});

const existingItems = loadedItems();
const existingItemsById = new Map(existingItems.map((item) => [Number(item.selfId), item]));
const sourceItemsById = vendorItems();
const npcs = mobIds.map((id) => npcRowsById.get(id)).map((row) => {
    const [
        id, , name, , title, , , collisionRadius, collisionHeight, level, , type,
        attackRange, hp, mp, hpRegen, mpRegen, str, con, dex, int, wit, men,
        exp, sp, pAtk, pDef, mAtk, mDef, atkSpd, aggro, castSpd, rightHand, leftHand,
        , walk, run, faction, helpRadius, undead
    ] = row;
    if (type !== 'L2Monster') throw new Error(`NPC ${id} is not a monster: ${type}`);
    const weapon = existingItemsById.get(Number(rightHand));
    const race = raceByNpc.get(id);
    if (!race) throw new Error(`NPC ${id} has no sourced race binding`);
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

const npcNameById = new Map(npcs.map((npc) => [npc.selfId, npc.template.name]));
const spawnDefinitions = mobIds.map((npcId) => {
    const rows = spawnRows.filter((row) => Number(row[3]) === npcId);
    const respawns = [...new Set(rows.map((row) => Number(row[10])))];
    if (respawns.length !== 1) throw new Error(`NPC ${npcId} has mixed respawns: ${respawns.join(', ')}`);
    return {
        selfId: npcId,
        name: npcNameById.get(npcId),
        coords: rows.map((row) => ({ locX: row[4], locY: row[5], locZ: row[6], head: row[9] })),
        total: 1,
        respawn: respawns[0],
        bias: 0
    };
});
const spawns = [{ selfId: 'c4-devils-isle', bounds: [], spawns: spawnDefinitions }];

const dropRows = tuples('sql/droplist.sql').filter((row) => mobIdSet.has(Number(row[0])));
if (dropRows.length !== 266) throw new Error(`Expected 266 drops, found ${dropRows.length}`);

function sourceItemName(itemId) {
    const existing = existingItemsById.get(itemId);
    if (existing) return existing.template.name;
    const source = sourceItemsById.get(itemId);
    if (!source) throw new Error(`Missing item template ${itemId}`);
    return source.name;
}

const rewards = mobIds.map((mobId) => {
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
                selfId: Number(row[1]), name: sourceItemName(Number(row[1])),
                min: Number(row[2]), max: Number(row[3]), chance: round(Number(row[5]) / totalChance * 100)
            })),
            overall: round(totalChance / 10000)
        };
    });
    const spoils = rows.filter((row) => Number(row[4]) === -1).map((row) => ({
        items: [{
            selfId: Number(row[1]), name: sourceItemName(Number(row[1])),
            min: Number(row[2]), max: Number(row[3]), chance: round(Number(row[5]) / 10000)
        }],
        overall: 100
    }));
    return { selfId: mobId, template: { name: npcNameById.get(mobId) }, rewards: normal, spoils };
});

const requiredItemIds = new Set(dropRows.map((row) => Number(row[1])));
const missingItems = [...requiredItemIds].filter((id) => !existingItemsById.has(id)).sort((a, b) => a - b).map((id) => {
    const source = sourceItemsById.get(id);
    if (!source) throw new Error(`Missing source item ${id}`);
    return {
        selfId: id,
        template: {
            kind: itemKind(source), name: source.name, class1: 4, class2: 0,
            mass: Number(source.sets.get('weight') || 0), price: Number(source.sets.get('price') || 0)
        },
        etc: { stackable: source.sets.get('is_stackable') === 'true', consumable: false }
    };
});
const expectedMissingItemIds = [4937, 4941, 4959, 5155, 5159, 5160, 5274, 5436, 6668, 6669];
if (JSON.stringify(missingItems.map((item) => item.selfId)) !== JSON.stringify(expectedMissingItemIds)) {
    throw new Error(`Expected item dependencies ${expectedMissingItemIds.join(', ')}, found ${missingItems.map((item) => item.selfId).join(', ')}`);
}

const levelRows = (count) => Array.from({ length: count }, (_, index) => ({
    level: index + 1, power: 0, mp: 0, hp: 0, itemId: 0, itemCount: 0
}));
const skillTemplates = [
    {
        selfId: 4141,
        template: { name: 'NPC Wind Fist', passive: false, spell: false, distance: 500 },
        time: { hitTime: 1500, reuse: 0, buff: 0 },
        levels: levelRows(12)
    },
    {
        selfId: 4273,
        template: { name: 'Resist Dagger', passive: true, spell: false, distance: -1 },
        time: { hitTime: 0, reuse: 0, buff: 0 },
        levels: levelRows(6)
    },
    {
        selfId: 4303,
        template: { name: 'Strong Type', passive: true, spell: false, distance: -1 },
        time: { hitTime: 0, reuse: 0, buff: 0 },
        levels: levelRows(1)
    }
];

writeJson('data/Npcs/c4_devils_isle.json', npcs);
writeJson('data/Npcs/Spawns/c4_devils_isle.json', spawns);
writeJson('data/Npcs/Rewards/c4_devils_isle.json', rewards);
writeJson('data/Items/Others/c4_devils_isle.json', missingItems);
writeJson('data/Npcs/Skills/c4_devils_isle.json', skillRows);
writeJson('data/Npcs/Skills/c4_devils_isle_templates.json', skillTemplates);

console.info(`Generated ${npcs.length} NPCs, ${spawnRows.length} spawns, ${dropRows.length} drops, ${skillRows.length} skills, ${missingItems.length} items.`);
