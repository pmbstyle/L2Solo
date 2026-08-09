const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const vendorRepo = path.join(root, 'tmp', 'vendor', 'l2j-lisvus');
const vendorRoot = path.join(vendorRepo, 'datapack');
const mobIds = new Set(Array.from({ length: 20 }, (_, index) => 1274 + index));
const spawnPrefix = 'godard04_2416_';
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
        if (escaped) {
            value += char;
            escaped = false;
            continue;
        }
        if (char === '\\' && quoted) {
            escaped = true;
            continue;
        }
        if (char === "'") {
            if (quoted && line[index + 1] === "'") {
                value += "'";
                index++;
            }
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
        'data/Items/Others/c4_swamp_of_screams.json'
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
if (npcRows.length !== mobIds.size) throw new Error(`Expected 20 NPCs, found ${npcRows.length}`);

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
            pAtk,
            pAtkRnd: Number(weapon?.stats?.pAtkRnd ?? 30),
            pDef,
            mAtk,
            mDef,
            accur: Number(weapon?.stats?.accur ?? 4.75),
            atkSpd,
            castSpd,
            atkRadius: attackRange
        },
        speed: { walk, run },
        vitals: { maxHp: hp, maxMp: mp, revHp: hpRegen, revMp: mpRegen, corpseTime: 7000 },
        collision: { radius: collisionRadius, size: collisionHeight },
        equipment: { weapon: rightHand, shield: leftHand, reuseTime: 0 },
        clan: { clanName: faction === 'NULL' ? '' : faction, helpRadius },
        rewards: { exp: level > 0 ? round(exp / (level * level), 12) : 0, sp },
        traits: { race: 'animal', undead: Number(undead) !== 0 }
    };
});

const npcNameById = new Map(npcs.map((npc) => [npc.selfId, npc.template.name]));
const spawnRows = tuples('sql/spawnlist.sql').filter((row) =>
    mobIds.has(Number(row[3])) && String(row[1]).startsWith(spawnPrefix)
);
if (spawnRows.length !== 265) throw new Error(`Expected 265 spawns, found ${spawnRows.length}`);
if (spawnRows.some((row) => Number(row[2]) !== 1 || Number(row[10]) !== 40)) {
    throw new Error('Unexpected Garden of Beasts spawn count/respawn semantics');
}

const spawnDefinitions = [...mobIds].map((npcId) => {
    const rows = spawnRows.filter((row) => Number(row[3]) === npcId);
    if (!rows.length) throw new Error(`Missing Garden of Beasts spawns for NPC ${npcId}`);
    return {
        selfId: npcId,
        name: npcNameById.get(npcId),
        coords: rows.map((row) => ({ locX: row[4], locY: row[5], locZ: row[6], head: row[9] })),
        total: 1,
        respawn: 40,
        bias: 0
    };
});
const spawns = [{ selfId: 'c4-garden-of-beasts', bounds: [], spawns: spawnDefinitions }];

const dropRows = tuples('sql/droplist.sql').filter((row) => mobIds.has(Number(row[0])));
if (dropRows.length !== 308) throw new Error(`Expected 308 drops, found ${dropRows.length}`);

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
                selfId: Number(row[1]),
                name: sourceItemName(Number(row[1])),
                min: Number(row[2]),
                max: Number(row[3]),
                chance: round(Number(row[5]) / totalChance * 100)
            })),
            overall: round(totalChance / 10000)
        };
    });
    const spoils = rows.filter((row) => Number(row[4]) === -1).map((row) => ({
        items: [{
            selfId: Number(row[1]),
            name: sourceItemName(Number(row[1])),
            min: Number(row[2]),
            max: Number(row[3]),
            chance: round(Number(row[5]) / 10000)
        }],
        overall: 100
    }));
    return { selfId: mobId, template: { name: npcNameById.get(mobId) }, rewards: normal, spoils };
});

const requiredItemIds = new Set(dropRows.map((row) => Number(row[1])));
const missingItems = [...requiredItemIds]
    .filter((id) => !existingItemsById.has(id))
    .sort((a, b) => a - b)
    .map((id) => {
        const source = sourceItemsById.get(id);
        if (!source) throw new Error(`Missing source item ${id}`);
        return {
            selfId: id,
            template: {
                kind: itemKind(source),
                name: source.name,
                class1: 4,
                class2: 0,
                mass: Number(source.sets.get('weight') || 0),
                price: Number(source.sets.get('price') || 0)
            },
            etc: { stackable: source.sets.get('is_stackable') === 'true', consumable: false }
        };
    });
if (missingItems.length !== 2 || missingItems.some((item, index) => item.selfId !== 5547 + index)) {
    throw new Error(`Expected item dependencies 5547 and 5548, found ${missingItems.map((item) => item.selfId).join(', ')}`);
}

const skillRows = tuples('sql/npcskills.sql')
    .filter((row) => mobIds.has(Number(row[0])))
    .map((row) => ({ npcId: Number(row[0]), skillId: Number(row[1]), level: Number(row[2]) }));
if (skillRows.length !== 69) throw new Error(`Expected 69 NPC skill rows, found ${skillRows.length}`);

const levelRows = (count, { power = [], mp = [] } = {}) => Array.from({ length: count }, (_, index) => ({
    level: index + 1,
    power: Number(power[index] || 0),
    mp: Number(mp[index] || 0),
    hp: 0,
    itemId: 0,
    itemCount: 0
}));
const skillTemplates = [
    {
        selfId: 4232,
        template: { name: 'NPC AE Strike', passive: false, spell: false, distance: 40 },
        time: { hitTime: 1000, reuse: 6000, buff: 0 },
        levels: levelRows(12, {
            power: [46, 105, 219, 417, 722, 1136, 1626, 1876, 2112, 2320, 2487, 2617],
            mp: [14, 22, 31, 43, 55, 68, 79, 84, 89, 92, 94, 95]
        })
    },
    {
        selfId: 4257,
        template: { name: 'NPC Hydroblast - Magic', passive: false, spell: true, distance: 500 },
        time: { hitTime: 4000, reuse: 0, buff: 0 },
        levels: levelRows(12, {
            power: [9, 13, 19, 26, 34, 43, 51, 55, 58, 61, 63, 65],
            mp: [18, 29, 40, 53, 68, 83, 98, 104, 109, 113, 115, 117]
        })
    },
    {
        selfId: 4293,
        template: { name: 'Race', passive: true, spell: false, distance: -1 },
        time: { hitTime: 0, reuse: 0, buff: 0 },
        levels: levelRows(1)
    },
    {
        selfId: 4311,
        template: { name: 'Feeble Type', passive: true, spell: false, distance: -1 },
        time: { hitTime: 0, reuse: 0, buff: 0 },
        levels: levelRows(1)
    }
];

writeJson('data/Npcs/c4_garden_of_beasts.json', npcs);
writeJson('data/Npcs/Spawns/c4_garden_of_beasts.json', spawns);
writeJson('data/Npcs/Rewards/c4_garden_of_beasts.json', rewards);
writeJson('data/Items/Others/c4_garden_of_beasts.json', missingItems);
writeJson('data/Npcs/Skills/c4_garden_of_beasts.json', skillRows);
writeJson('data/Npcs/Skills/c4_garden_of_beasts_templates.json', skillTemplates);

console.info(`Generated ${npcs.length} NPCs, ${spawnRows.length} spawns, ${dropRows.length} drops, ${skillRows.length} skills, ${missingItems.length} items.`);
