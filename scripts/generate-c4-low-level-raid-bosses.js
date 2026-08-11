const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const vendorRepo = path.join(root, 'tmp', 'vendor', 'l2j-lisvus');
const vendorRoot = path.join(vendorRepo, 'datapack');
const expectedLisvusRevision = 'fdc7e33af5d69067b41a6ee7cc7c07fe7aa35975';
const filename = 'c4_low_level_raid_bosses.json';
const bossIds = [10019, 10127, 10272, 10365, 10372];
const bossIdSet = new Set(bossIds);

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
    return ['Armors', 'Weapons', 'Others'].flatMap((directory) => {
        const itemDirectory = path.join(root, 'data', 'Items', directory);
        return fs.readdirSync(itemDirectory)
            .filter((name) => name.endsWith('.json') && name !== filename)
            .flatMap((name) => require(path.join(itemDirectory, name)));
    });
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
            items.set(Number(match[1]), { id: Number(match[1]), name: match[2], type: match[3], sets });
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

function assertExact(actual, expected, label) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`Expected ${label} ${expected.join(', ')}, found ${actual.join(', ')}`);
    }
}

const npcRowsById = new Map(tuples('sql/npc.sql').map((row) => [Number(row[0]), row]));
const npcRows = bossIds.map((id) => npcRowsById.get(id));
if (npcRows.some((row) => row?.[11] !== 'L2RaidBoss')) {
    throw new Error('The low-level raid-boss slice must contain only Lisvus L2RaidBoss templates');
}
const minionRows = tuples('sql/minions.sql').filter((row) => bossIdSet.has(Number(row[0])));
if (minionRows.length !== 0) {
    throw new Error('The first raid-boss slice must not silently omit sourced minions');
}

const existingNpcIds = new Set(fs.readdirSync(path.join(root, 'data', 'Npcs'))
    .filter((name) => name.endsWith('.json') && name !== filename)
    .flatMap((name) => require(path.join(root, 'data', 'Npcs', name)))
    .map((npc) => Number(npc.selfId)));
const duplicateNpcIds = bossIds.filter((id) => existingNpcIds.has(id));
if (duplicateNpcIds.length > 0) {
    throw new Error(`Raid-boss templates are already loaded: ${duplicateNpcIds.join(', ')}`);
}

const skillRows = tuples('sql/npcskills.sql')
    .filter((row) => bossIdSet.has(Number(row[0])))
    .map((row) => ({ npcId: Number(row[0]), skillId: Number(row[1]), level: Number(row[2]) }));
if (skillRows.length !== 38) throw new Error(`Expected 38 raid-boss skill rows, found ${skillRows.length}`);

const raceBySkill = new Map([
    [4290, 'undead'], [4291, 'construct'], [4292, 'beast'], [4295, 'humanoid'], [4302, 'fairy']
]);
const raceByNpc = new Map();
skillRows.forEach((row) => {
    const race = raceBySkill.get(row.skillId);
    if (race) raceByNpc.set(row.npcId, race);
});

const existingItems = loadedItems();
const existingItemsById = new Map(existingItems.map((item) => [Number(item.selfId), item]));
const sourceItemsById = vendorItems();
const npcs = npcRows.map((row) => {
    const [
        id, , name, , title, , , collisionRadius, collisionHeight, level, , type,
        attackRange, hp, mp, hpRegen, mpRegen, str, con, dex, int, wit, men,
        exp, sp, pAtk, pDef, mAtk, mDef, atkSpd, aggro, castSpd, rightHand, leftHand,
        , walk, run, faction, helpRadius, undead
    ] = row;
    const race = raceByNpc.get(id);
    if (type !== 'L2RaidBoss' || !race) throw new Error(`Invalid source raid boss ${id}: type=${type} race=${race}`);
    const weapon = existingItemsById.get(Number(rightHand));
    return {
        selfId: id,
        template: { kind: 'Boss', name, title, level, hostile: Number(aggro) > 0, raidBoss: true },
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

const sourceSpawns = tuples('sql/raidboss_spawnlist.sql').filter((row) => bossIdSet.has(Number(row[0])));
if (sourceSpawns.length !== bossIds.length) {
    throw new Error(`Expected ${bossIds.length} raid-boss spawns, found ${sourceSpawns.length}`);
}
if (sourceSpawns.some((row) => Number(row[1]) !== 1 || Number(row[6]) !== 43200 || Number(row[7]) !== 129600)) {
    throw new Error('Unexpected raid-boss amount or respawn-window semantics');
}
const npcNameById = new Map(npcs.map((npc) => [npc.selfId, npc.template.name]));
const spawns = [{
    selfId: 'c4-low-level-raid-bosses',
    bounds: [],
    spawns: sourceSpawns.map((row) => ({
        selfId: Number(row[0]),
        name: npcNameById.get(Number(row[0])),
        coords: [{ locX: Number(row[2]), locY: Number(row[3]), locZ: Number(row[4]), head: Number(row[5]) }],
        total: 1,
        // SpawnNpcs samples uniformly from respawn +/- bias: 12h..36h.
        respawn: 86400,
        bias: 43200
    }))
}];

const dropRows = tuples('sql/droplist.sql').filter((row) => bossIdSet.has(Number(row[0])));
if (dropRows.length !== 41) throw new Error(`Expected 41 raid-boss drops, found ${dropRows.length}`);

function sourceItemName(itemId) {
    const existing = existingItemsById.get(itemId);
    if (existing) return existing.template.name;
    const source = sourceItemsById.get(itemId);
    if (!source) throw new Error(`Missing item template ${itemId}`);
    return source.name;
}

const rewards = bossIds.map((bossId) => {
    const rows = dropRows.filter((row) => Number(row[0]) === bossId);
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
    return { selfId: bossId, template: { name: npcNameById.get(bossId) }, rewards: normal, spoils };
});

const missingItems = [...new Set(dropRows.map((row) => Number(row[1])))]
    .filter((id) => !existingItemsById.has(id))
    .sort((a, b) => a - b)
    .map((id) => {
        const source = sourceItemsById.get(id);
        if (!source || source.type !== 'EtcItem') throw new Error(`Unsupported source item dependency ${id}`);
        return {
            selfId: id,
            template: {
                kind: itemKind(source), name: source.name, class1: 4, class2: 0,
                mass: Number(source.sets.get('weight') || 0), price: Number(source.sets.get('price') || 0)
            },
            etc: { stackable: source.sets.get('is_stackable') === 'true', consumable: false }
        };
    });
assertExact(missingItems.map((item) => item.selfId), [6387, 6575, 6576], 'item dependencies');

const levelRows = (count, { power = [], mp = [] } = {}) => Array.from({ length: count }, (_, index) => ({
    level: index + 1,
    power: Number(power[index] || 0),
    mp: Number(mp[index] || 0),
    hp: 0,
    itemId: 0,
    itemCount: 0
}));
const active = (selfId, name, { power = [], mp = [], hitTime = 0, reuse = 0, buff = 0, distance = 40, spell = false } = {}) => ({
    selfId,
    template: { name, passive: false, spell, distance },
    time: { hitTime, reuse, buff },
    levels: levelRows(12, { power, mp })
});
const passive = (selfId, name) => ({
    selfId,
    template: { name, passive: true, spell: false, distance: -1 },
    time: { hitTime: 0, reuse: 0, buff: 0 },
    levels: levelRows(1)
});
const bossMp = [18, 25, 35, 47, 59, 72, 83, 88, 91, 93, 95, 96];
const bossBuffMp = [8, 11, 15, 20, 25, 30, 34, 36, 38, 38, 39, 40];
const skillTemplates = [
    passive(4045, 'Resist Full Magic Attack'),
    active(4172, 'Shock', { mp: bossMp, hitTime: 830, buff: 9000, distance: -1 }),
    active(4173, 'BOSS Might', { mp: bossBuffMp, hitTime: 1500, buff: 60000, distance: -1 }),
    active(4174, 'BOSS Shield', { mp: bossBuffMp, hitTime: 1500, buff: 60000, distance: -1 }),
    active(4175, 'BOSS Haste', { mp: bossBuffMp, hitTime: 1500, buff: 60000, distance: -1 }),
    passive(4494, 'Raid Boss'),
    active(4721, 'BOSS Strike', { power: [51, 136, 375, 982, 2536, 4958, 7667, 9037, 10483, 12074, 13778, 15349], mp: bossMp, hitTime: 830 }),
    active(4723, 'BOSS Strike', { power: [45, 120, 330, 858, 2218, 4344, 6724, 7942, 9228, 10625, 12093, 13512], mp: bossMp, hitTime: 830 }),
    active(4732, 'BOSS Mortal Blow', { power: [71, 191, 528, 1382, 3566, 6977, 10793, 12734, 14783, 17044, 19381, 21645], mp: bossMp, hitTime: 830 }),
    active(4733, 'BOSS Mortal Blow', { power: [67, 179, 494, 1287, 3327, 6516, 10085, 11913, 13841, 15937, 18140, 20268], mp: bossMp, hitTime: 830 }),
    active(4738, 'BOSS Spinning Slasher', { power: [23, 60, 165, 429, 1109, 2172, 3362, 3971, 4614, 5313, 6047, 6756], mp: bossMp, hitTime: 830 }),
    passive(4796, 'Raid Boss - Level 25'),
    passive(4838, 'Raid Boss - Level'),
    passive(4890, 'Raid Boss - Level'),
    passive(4930, 'Raid Boss - Level'),
    passive(4933, 'Raid Boss - Level')
];

writeJson(`data/Npcs/${filename}`, npcs);
writeJson(`data/Npcs/Spawns/${filename}`, spawns);
writeJson(`data/Npcs/Rewards/${filename}`, rewards);
writeJson(`data/Npcs/Skills/${filename}`, skillRows);
writeJson('data/Npcs/Skills/c4_low_level_raid_bosses_templates.json', skillTemplates);
writeJson(`data/Items/Others/${filename}`, missingItems);

console.info(`Generated ${npcs.length} raid bosses, ${sourceSpawns.length} spawns, ${dropRows.length} drops, ${skillRows.length} skills, ${skillTemplates.length} skill templates, ${missingItems.length} items.`);
