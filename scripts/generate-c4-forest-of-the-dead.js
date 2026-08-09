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
        'data/Items/Others/c4_valley_of_saints.json'
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
const allForestSpawns = tuples('sql/spawnlist.sql').filter((row) => row[1] === 'forest_of_the_dead');
if (allForestSpawns.length !== 584) throw new Error(`Expected 584 Forest rows, found ${allForestSpawns.length}`);
const spawnRows = allForestSpawns.filter((row) => npcRowsById.get(Number(row[3]))?.[11] === 'L2Monster');
if (spawnRows.length !== 572) throw new Error(`Expected 572 Forest monster spawns, found ${spawnRows.length}`);
if (spawnRows.some((row) => Number(row[2]) !== 1 || Number(row[10]) !== 240)) {
    throw new Error('Unexpected Forest spawn count or respawn semantics');
}
const mobIds = [...new Set(spawnRows.map((row) => Number(row[3])))].sort((a, b) => a - b);
if (mobIds.length !== 41) throw new Error(`Expected 41 Forest monster variants, found ${mobIds.length}`);
const mobIdSet = new Set(mobIds);

const skillRows = tuples('sql/npcskills.sql')
    .filter((row) => mobIdSet.has(Number(row[0])))
    .map((row) => ({ npcId: Number(row[0]), skillId: Number(row[1]), level: Number(row[2]) }));
if (skillRows.length !== 309) throw new Error(`Expected 309 NPC skill rows, found ${skillRows.length}`);

const raceBySkill = new Map([
    [4290, 'undead'], [4291, 'construct'], [4292, 'beast'], [4295, 'humanoid'],
    [4298, 'demonic'], [4301, 'insect']
]);
const raceByNpc = new Map();
skillRows.forEach((row) => {
    const race = raceBySkill.get(row.skillId);
    if (race) raceByNpc.set(row.npcId, race);
});

const existingItems = loadedItems();
const existingItemsById = new Map(existingItems.map((item) => [Number(item.selfId), item]));
const sourceItemsById = vendorItems();
const npcRows = mobIds.map((id) => npcRowsById.get(id));
const npcs = npcRows.map((row) => {
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
const periodName = new Map([[0, 'always'], [1, 'day'], [2, 'night']]);
const spawnDefinitions = [];
mobIds.forEach((npcId) => {
    [0, 1, 2].forEach((period) => {
        const rows = spawnRows.filter((row) => Number(row[3]) === npcId && Number(row[12]) === period);
        if (!rows.length) return;
        spawnDefinitions.push({
            selfId: npcId,
            name: npcNameById.get(npcId),
            coords: rows.map((row) => ({ locX: row[4], locY: row[5], locZ: row[6], head: row[9] })),
            total: 1,
            respawn: 240,
            bias: 0,
            period: periodName.get(period)
        });
    });
});
const spawns = [{ selfId: 'c4-forest-of-the-dead', bounds: [], spawns: spawnDefinitions }];

const dropRows = tuples('sql/droplist.sql').filter((row) => mobIdSet.has(Number(row[0])));
if (dropRows.length !== 564) throw new Error(`Expected 564 drops, found ${dropRows.length}`);

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
const expectedMissingItemIds = [5156, 5157, 5276, 5281, 5434, 5460, 5542, 6329, 6331, 6671, 6901];
if (JSON.stringify(missingItems.map((item) => item.selfId)) !== JSON.stringify(expectedMissingItemIds)) {
    throw new Error(`Expected item dependencies ${expectedMissingItemIds.join(', ')}, found ${missingItems.map((item) => item.selfId).join(', ')}`);
}

const levelRows = (count, { power = [], mp = [] } = {}) => Array.from({ length: count }, (_, index) => ({
    level: index + 1, power: Number(power[index] || 0), mp: Number(mp[index] || 0), hp: 0, itemId: 0, itemCount: 0
}));
const magicPower = [18, 26, 38, 52, 68, 85, 102, 110, 116, 122, 126, 129];
const weakMagicPower = [9, 13, 19, 26, 34, 43, 51, 55, 58, 61, 63, 65];
const magicMp = [13, 20, 27, 35, 45, 55, 65, 69, 73, 75, 77, 78];
const wideMp = [18, 29, 40, 53, 68, 83, 98, 104, 109, 113, 115, 117];
const physicalMp = [14, 22, 31, 43, 55, 68, 79, 84, 89, 92, 94, 95];
const closeDebuffMp = [25, 41, 57, 77, 100, 123, 143, 153, 161, 166, 170, 172];
const drainDebuffMp = [24, 39, 53, 70, 90, 110, 130, 138, 145, 150, 153, 155];
const bleedMp = [25, 42, 58, 78, 100, 123, 144, 153, 162, 167, 170, 173];
const active = (selfId, name, count, { power = [], mp = [], hitTime = 0, reuse = 0, buff = 0, distance = -1, spell = true } = {}) => ({
    selfId, template: { name, passive: false, spell, distance },
    time: { hitTime, reuse, buff }, levels: levelRows(count, { power, mp })
});
const passive = (selfId, name, count) => ({
    selfId, template: { name, passive: true, spell: false, distance: -1 },
    time: { hitTime: 0, reuse: 0, buff: 0 }, levels: levelRows(count)
});

const skillTemplates = [
    active(4138, 'NPC AE - Corpse Burst', 12, { power: weakMagicPower, mp: wideMp, hitTime: 4000, reuse: 8000, distance: 900 }),
    passive(4275, 'Sacred Attack Weak Point', 5),
    passive(4276, 'Archery Attack Weak Point', 5),
    passive(4278, 'Dark Attack', 1),
    passive(4279, 'Fire Attack Weak Point', 5),
    passive(4281, 'Wind Attack Weak Point', 5),
    passive(4290, 'Race', 1), passive(4291, 'Race', 1), passive(4292, 'Race', 1),
    passive(4295, 'Race', 1), passive(4298, 'Race', 1),
    passive(4333, 'Resist Dark Attack', 6),
    active(4573, 'NPC Sonic Blaster', 12, { mp: physicalMp, hitTime: 1900, distance: 600, spell: false }),
    active(4581, 'Hold', 12, { mp: closeDebuffMp, hitTime: 1800, distance: 40, spell: false }),
    active(4582, 'Poison', 12, { mp: closeDebuffMp, hitTime: 1800, distance: 40, spell: false }),
    active(4585, 'NPC Clan Buff - Berserk Might', 3, { mp: [29, 53, 98], hitTime: 2000 }),
    active(4590, 'Decrease Speed', 12, { mp: [35, 58, 79, 105, 135, 165, 194, 207, 217, 224, 229, 233], hitTime: 4000, distance: 500 }),
    active(4592, 'Decrease P.Def', 12, { mp: drainDebuffMp, hitTime: 4000, distance: 600 }),
    active(4593, 'Decrease P.Def', 12, { mp: drainDebuffMp, hitTime: 4000, distance: 600 }),
    active(4596, 'Bleed', 12, { mp: bleedMp, hitTime: 4000, distance: 600 }),
    active(4597, 'Bleed', 12, { mp: bleedMp, hitTime: 4000, distance: 600 }),
    active(4622, 'NPC AE - 80% HP Drain - Magic', 12, { power: magicPower, mp: wideMp, hitTime: 4000, distance: 500 }),
    active(4649, 'Poison', 12, { mp: wideMp, buff: 30000 }),
    active(4650, 'NPC AE - Dispel Hold', 1, { mp: [53] }),
    active(4651, 'NPC AE - Dispel Slow', 3, { mp: [29, 53, 83] }),
    active(4652, 'NPC AE Dispel Silence', 1, { mp: [53] }),
    active(4654, 'NPC Death Link', 12, { power: magicPower, mp: magicMp, hitTime: 4000, distance: 900 }),
    active(4658, 'Hold', 12, { power: magicPower, mp: drainDebuffMp, hitTime: 4000, buff: 30000, distance: 600 }),
    active(4663, 'NPC Hate', 1, { power: [2000], distance: 900, spell: false }),
    active(4664, 'NPC 100% HP Drain', 12, { power: [12, 18, 25, 35, 46, 57, 68, 73, 78, 81, 84, 86], mp: [17, 29, 40, 53, 68, 83, 100, 104, 109, 113, 115, 117], hitTime: 2000, distance: 600 }),
    active(4672, 'NPC Corpse Remove', 1, { distance: 900, spell: false })
];
if (skillTemplates.length !== 31) throw new Error(`Expected 31 skill templates, found ${skillTemplates.length}`);

writeJson('data/Npcs/c4_forest_of_the_dead.json', npcs);
writeJson('data/Npcs/Spawns/c4_forest_of_the_dead.json', spawns);
writeJson('data/Npcs/Rewards/c4_forest_of_the_dead.json', rewards);
writeJson('data/Items/Others/c4_forest_of_the_dead.json', missingItems);
writeJson('data/Npcs/Skills/c4_forest_of_the_dead.json', skillRows);
writeJson('data/Npcs/Skills/c4_forest_of_the_dead_templates.json', skillTemplates);

const periodCounts = Object.fromEntries(['always', 'day', 'night'].map((period) => [
    period, spawnDefinitions.filter((spawn) => spawn.period === period).reduce((sum, spawn) => sum + spawn.coords.length, 0)
]));
console.info(`Generated ${npcs.length} NPCs, ${spawnRows.length} spawns ${JSON.stringify(periodCounts)}, ${dropRows.length} drops, ${skillRows.length} skills, ${missingItems.length} items.`);
