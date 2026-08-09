const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const vendorRepo = path.join(root, 'tmp', 'vendor', 'l2j-lisvus');
const vendorRoot = path.join(vendorRepo, 'datapack');
const expectedLisvusRevision = 'fdc7e33af5d69067b41a6ee7cc7c07fe7aa35975';
const mobIds = new Set([
    1520, 1521, 1523, 1524, 1526, 1527, 1529, 1530, 1531, 1532, 1533,
    1535, 1536, 1537, 1539, 1541, 1544, 5214, 5215, 5216, 5317
]);
const spawnPrefixes = ['rune08_2215_', 'rune08_qm2215_'];

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
        'data/Items/Others/c4_garden_of_beasts.json'
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

const existingItems = loadedItems();
const existingItemsById = new Map(existingItems.map((item) => [Number(item.selfId), item]));
const sourceItemsById = vendorItems();
const npcRows = tuples('sql/npc.sql').filter((row) => mobIds.has(Number(row[0])));
if (npcRows.length !== 21) throw new Error(`Expected 21 NPCs, found ${npcRows.length}`);

const npcs = npcRows.map((row) => {
    const [
        id, , name, , title, , , collisionRadius, collisionHeight, level, , type,
        attackRange, hp, mp, hpRegen, mpRegen, str, con, dex, int, wit, men,
        exp, sp, pAtk, pDef, mAtk, mDef, atkSpd, aggro, castSpd, rightHand, leftHand,
        , walk, run, faction, helpRadius, undead
    ] = row;
    if (type !== 'L2Monster') throw new Error(`NPC ${id} is not a monster: ${type}`);
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
        traits: { race: 'divine', undead: Number(undead) !== 0 }
    };
});

const npcNameById = new Map(npcs.map((npc) => [npc.selfId, npc.template.name]));
const spawnRows = tuples('sql/spawnlist.sql').filter((row) =>
    mobIds.has(Number(row[3])) && spawnPrefixes.some((prefix) => String(row[1]).startsWith(prefix))
);
if (spawnRows.length !== 381) throw new Error(`Expected 381 spawns, found ${spawnRows.length}`);
if (spawnRows.some((row) => Number(row[2]) !== 1)) throw new Error('Unexpected Valley spawn count semantics');

const spawnDefinitions = [...mobIds].map((npcId) => {
    const rows = spawnRows.filter((row) => Number(row[3]) === npcId);
    if (!rows.length) throw new Error(`Missing Valley spawns for NPC ${npcId}`);
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
const spawns = [{ selfId: 'c4-valley-of-saints', bounds: [], spawns: spawnDefinitions }];

const dropRows = tuples('sql/droplist.sql').filter((row) => mobIds.has(Number(row[0])));
if (dropRows.length !== 262) throw new Error(`Expected 262 drops, found ${dropRows.length}`);

function sourceItemName(itemId) {
    const existing = existingItemsById.get(itemId);
    if (existing) return existing.template.name;
    const source = sourceItemsById.get(itemId);
    if (!source) throw new Error(`Missing item template ${itemId}`);
    return source.name;
}

const rewards = [...mobIds].map((mobId) => {
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
const expectedMissingItemIds = [5161, 5166, 5230, 5271, 5446, 5448, 5450, 5452, 5470, 6335];
if (JSON.stringify(missingItems.map((item) => item.selfId)) !== JSON.stringify(expectedMissingItemIds)) {
    throw new Error(`Expected item dependencies ${expectedMissingItemIds.join(', ')}, found ${missingItems.map((item) => item.selfId).join(', ')}`);
}

const skillRows = tuples('sql/npcskills.sql')
    .filter((row) => mobIds.has(Number(row[0])))
    .map((row) => ({ npcId: Number(row[0]), skillId: Number(row[1]), level: Number(row[2]) }));
if (skillRows.length !== 105) throw new Error(`Expected 105 NPC skill rows, found ${skillRows.length}`);

const levelRows = (count, { power = [], mp = [] } = {}) => Array.from({ length: count }, (_, index) => ({
    level: index + 1, power: Number(power[index] || 0), mp: Number(mp[index] || 0), hp: 0, itemId: 0, itemCount: 0
}));
const magicMp = [13, 20, 27, 35, 45, 55, 65, 69, 73, 75, 77, 78];
const wideMp = [18, 29, 40, 53, 68, 83, 98, 104, 109, 113, 115, 117];
const buff = (selfId, name, mp) => ({
    selfId, template: { name, passive: false, spell: true, distance: -1 },
    time: { hitTime: 2000, reuse: 0, buff: 120000 }, levels: levelRows(3, { mp })
});
const skillTemplates = [
    // The base datapack only defines level one, while Valley binds level three.
    // Override it with the complete Lisvus level table so instantiation cannot clamp silently.
    { selfId: 4084, template: { name: 'NPC High P. Def.', passive: true, spell: false, distance: -1 }, time: { hitTime: 0, reuse: 0, buff: 0 }, levels: levelRows(10) },
    { selfId: 4297, template: { name: 'Race', passive: true, spell: false, distance: -1 }, time: { hitTime: 0, reuse: 0, buff: 0 }, levels: levelRows(1) },
    { selfId: 4561, template: { name: 'NPC Fire Burn - Magic', passive: false, spell: true, distance: 150 }, time: { hitTime: 1500, reuse: 6000, buff: 0 }, levels: levelRows(12, { power: [13, 15, 18, 20, 23, 26, 29, 32, 35, 38, 42, 44], mp: [4, 5, 8, 9, 12, 14, 17, 18, 19, 19, 20, 20] }) },
    { selfId: 4563, template: { name: 'NPC Solar Flare - Magic', passive: false, spell: true, distance: 900 }, time: { hitTime: 5000, reuse: 0, buff: 0 }, levels: levelRows(12, { mp: [15, 24, 33, 44, 57, 69, 82, 87, 90, 94, 97, 98] }) },
    { selfId: 4566, template: { name: 'NPC Eruption - Magic', passive: false, spell: true, distance: 500 }, time: { hitTime: 5000, reuse: 6000, buff: 0 }, levels: levelRows(12, { power: [37, 39, 41, 43, 45, 46, 48, 50, 51, 53, 54, 56], mp: magicMp }) },
    { selfId: 4569, template: { name: 'NPC AE Solar Flare - Magic', passive: false, spell: true, distance: 900 }, time: { hitTime: 5000, reuse: 0, buff: 0 }, levels: levelRows(12, { mp: [22, 37, 49, 67, 84, 104, 122, 129, 135, 140, 144, 145] }) },
    { selfId: 4571, template: { name: 'NPC Blazing Circle', passive: false, spell: true, distance: -1 }, time: { hitTime: 5000, reuse: 15000, buff: 0 }, levels: levelRows(12, { power: [42, 44, 46, 48, 50, 52, 55, 57, 58, 60, 62, 64], mp: wideMp }) },
    { selfId: 4630, template: { name: 'NPC MR - Twister', passive: false, spell: true, distance: 400 }, time: { hitTime: 4000, reuse: 0, buff: 0 }, levels: levelRows(12, { power: [18, 26, 38, 52, 68, 85, 102, 110, 116, 122, 126, 129], mp: magicMp }) },
    buff(4631, 'NPC Buff - Acumen Shield WildMagic', [29, 53, 83]),
    buff(4632, 'NPC Buff - Acumen Empower WildMagic', [29, 53, 83]),
    buff(4633, 'NPC Buff - Acumen Empower Berserk', [29, 53, 83]),
    buff(4634, 'NPC Buff - Acumen Empower DamageShield', [29, 53, 83]),
    buff(4635, 'NPC Buff - Acumen Berserk WildMagic', [29, 53, 83]),
    buff(4636, 'NPC Buff - Acumen Berserk DamageShield', [29, 53, 83]),
    buff(4637, 'NPC Buff - Acumen WildMagic DamageShield', [29, 53, 83]),
    buff(4638, 'NPC Clan Buff - Acumen Empower WildMagic', [43, 79, 124]),
    buff(4639, 'NPC Clan Buff - Acumen Empower Berserk', [43, 79, 124]),
    { selfId: 4640, template: { name: 'Sleep', passive: false, spell: true, distance: 500 }, time: { hitTime: 2500, reuse: 0, buff: 30000 }, levels: levelRows(12, { mp: wideMp }) },
    { selfId: 4641, template: { name: 'NPC Super Strike', passive: false, spell: false, distance: 40 }, time: { hitTime: 1800, reuse: 0, buff: 0 }, levels: levelRows(12, { power: [137, 314, 656, 1249, 2164, 3408, 4878, 5627, 6335, 6960, 7461, 7850], mp: [41, 66, 93, 127, 164, 202, 236, 252, 265, 274, 280, 283] }) },
    { selfId: 4642, template: { name: 'NPC Fast Spell Casting', passive: true, spell: false, distance: -1 }, time: { hitTime: 0, reuse: 0, buff: 0 }, levels: levelRows(3) },
    { selfId: 4671, template: { name: 'AV - Teleport', passive: true, spell: false, distance: -1 }, time: { hitTime: 0, reuse: 0, buff: 0 }, levels: levelRows(1) }
];
if (skillTemplates.length !== 21) throw new Error(`Expected 21 skill templates, found ${skillTemplates.length}`);

writeJson('data/Npcs/c4_valley_of_saints.json', npcs);
writeJson('data/Npcs/Spawns/c4_valley_of_saints.json', spawns);
writeJson('data/Npcs/Rewards/c4_valley_of_saints.json', rewards);
writeJson('data/Items/Others/c4_valley_of_saints.json', missingItems);
writeJson('data/Npcs/Skills/c4_valley_of_saints.json', skillRows);
writeJson('data/Npcs/Skills/c4_valley_of_saints_templates.json', skillTemplates);

console.info(`Generated ${npcs.length} NPCs, ${spawnRows.length} spawns, ${dropRows.length} drops, ${skillRows.length} skills, ${missingItems.length} items.`);
