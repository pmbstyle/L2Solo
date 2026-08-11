const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const vendorRepo = path.join(root, 'tmp', 'vendor', 'l2j-lisvus');
const vendorRoot = path.join(vendorRepo, 'datapack');
const expectedLisvusRevision = 'fdc7e33af5d69067b41a6ee7cc7c07fe7aa35975';
const filename = 'c4_raid_bosses.json';
const lowLevelBossIds = new Set(require(path.join(root, 'data', 'Npcs', 'c4_low_level_raid_bosses.json')).map((npc) => Number(npc.selfId)));

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

function loadedNpcIds() {
    return new Set(fs.readdirSync(path.join(root, 'data', 'Npcs'))
        .filter((name) => name.endsWith('.json') && name !== filename)
        .flatMap((name) => require(path.join(root, 'data', 'Npcs', name)))
        .map((npc) => Number(npc.selfId)));
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
            const stats = new Map();
            for (const statMatch of match[4].matchAll(/<(?:set|add)\s+[^>]*stat="([^"]+)"\s+val="([^"]*)"\s*\/>/g)) {
                stats.set(statMatch[1], statMatch[2]);
            }
            items.set(Number(match[1]), { id: Number(match[1]), name: match[2], type: match[3], sets, stats });
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

function numberSet(item, name, fallback = 0) {
    const value = item.sets.get(name);
    return value === undefined ? fallback : Number(value);
}

function weaponKind(type) {
    const map = {
        SWORD: 'Weapon.Sword', BIGSWORD: 'Weapon.GreatSword', BLUNT: 'Weapon.Blunt', BIGBLUNT: 'Weapon.Blunt',
        DAGGER: 'Weapon.Knife', BOW: 'Weapon.Bow', POLE: 'Weapon.Pole', FIST: 'Weapon.Fist',
        DUAL: 'Weapon.Dual', DUALFIST: 'Weapon.DualFist', STAFF: 'Weapon.Blunt', ETC: 'Weapon.Etc'
    };
    return map[String(type || '').toUpperCase()] || 'Weapon.Etc';
}

function parseSkillSource() {
    const directory = path.join(vendorRoot, 'data', 'stats', 'skills');
    const skills = new Map();
    fs.readdirSync(directory).filter((name) => name.endsWith('.xml')).forEach((name) => {
        const xml = fs.readFileSync(path.join(directory, name), 'utf8');
        const matcher = /<skill\s+id="(\d+)"\s+levels="(\d+)"\s+name="([^"]*)"[^>]*>([\s\S]*?)<\/skill>/g;
        for (const match of xml.matchAll(matcher)) {
            const body = match[4];
            const tables = new Map();
            for (const tableMatch of body.matchAll(/<table\s+name="#([^\"]+)"\s*>([\s\S]*?)<\/table>/g)) {
                tables.set(tableMatch[1], tableMatch[2].trim().split(/\s+/).filter(Boolean).map(Number));
            }
            const sets = new Map();
            for (const setMatch of body.matchAll(/<set\s+name="([^"]+)"\s+val="([^"]*)"\s*\/>/g)) {
                sets.set(setMatch[1], setMatch[2]);
            }
            const effectTimes = [...body.matchAll(/<effect\b[^>]*\btime="([\d.]+)"/g)].map((effect) => Number(effect[1]));
            skills.set(Number(match[1]), {
                id: Number(match[1]),
                levels: Number(match[2]),
                name: match[3],
                body,
                tables,
                sets,
                buff: effectTimes.length ? Math.max(...effectTimes) * 1000 : 0
            });
        }
    });
    return skills;
}

function valuesFor(source, tableName, setName) {
    const table = source.tables.get(tableName);
    if (table && table.length) return table;
    const value = source.sets.get(setName);
    return value && /^[-+]?\d+(?:\.\d+)?$/.test(value) ? [Number(value)] : [];
}

function makeSkillTemplate(source) {
    const count = Math.max(1, source.levels);
    const power = valuesFor(source, 'power', 'power');
    const mp = valuesFor(source, 'mpConsume', 'mpConsume');
    const hp = valuesFor(source, 'hpConsume', 'hpConsume');
    const target = String(source.sets.get('target') || '');
    const skillType = String(source.sets.get('skillType') || '').toUpperCase();
    const operateType = String(source.sets.get('operateType') || '').toUpperCase();
    const passive = operateType === 'OP_PASSIVE' || skillType === 'PASSIVE' || skillType === 'WEAKNESS';
    const spell = String(source.sets.get('isMagic') || '').toLowerCase() === 'true'
        || ['MDAM', 'MATTACK', 'HEAL', 'DRAIN', 'MAGIC'].includes(skillType);
    const castRange = Number(source.sets.get('castRange')) || Number(source.sets.get('effectRange')) || 0;
    const selfTarget = passive || target === 'TARGET_SELF' || target === 'TARGET_NONE' || target === 'TARGET_CORPSE';
    const distance = selfTarget ? -1 : (castRange || 40);
    const hitTime = Number(source.sets.get('hitTime')) || 0;
    const reuse = Number(source.sets.get('reuseDelay')) || Number(source.sets.get('coolTime')) || 0;
    const staticPower = Number(source.sets.get('power')) || 0;
    const staticMp = Number(source.sets.get('mpConsume')) || 0;
    const staticHp = Number(source.sets.get('hpConsume')) || 0;
    const levels = Array.from({ length: count }, (_, index) => ({
        level: index + 1,
        power: Number(power[index] ?? staticPower ?? 0),
        mp: Number(mp[index] ?? staticMp ?? 0),
        hp: Number(hp[index] ?? staticHp ?? 0),
        itemId: 0,
        itemCount: 0
    }));
    return {
        selfId: source.id,
        template: { name: source.name, passive, spell, distance },
        time: { hitTime, reuse, buff: source.buff },
        levels
    };
}

const npcRowsById = new Map(tuples('sql/npc.sql').map((row) => [Number(row[0]), row]));
const sourceSpawns = tuples('sql/raidboss_spawnlist.sql').filter((row) => {
    const id = Number(row[0]);
    return npcRowsById.get(id)?.[11] === 'L2RaidBoss';
});
const bossIds = [...new Set(sourceSpawns.map((row) => Number(row[0])))]
    .filter((id) => !lowLevelBossIds.has(id))
    .sort((a, b) => a - b);
if (bossIds.length !== 174) throw new Error(`Expected 174 remaining C4 raid bosses, found ${bossIds.length}`);
const bossIdSet = new Set(bossIds);

const existingNpcIds = loadedNpcIds();
const duplicateNpcIds = bossIds.filter((id) => existingNpcIds.has(id));
if (duplicateNpcIds.length > 0) throw new Error(`Raid-boss templates are already loaded: ${duplicateNpcIds.join(', ')}`);
const npcRows = bossIds.map((id) => npcRowsById.get(id));
if (npcRows.some((row) => !row || row[11] !== 'L2RaidBoss')) throw new Error('Selected source rows are not L2RaidBoss templates');

const sourceSkillRows = tuples('sql/npcskills.sql')
    .filter((row) => bossIdSet.has(Number(row[0])))
    .map((row) => ({ npcId: Number(row[0]), skillId: Number(row[1]), level: Number(row[2]) }));
const sourceSkillIds = [...new Set(sourceSkillRows.map((row) => row.skillId))];
const raceBySkill = new Map([
    [4290, 'undead'], [4291, 'construct'], [4292, 'beast'], [4293, 'animal'], [4294, 'plant'],
    [4295, 'humanoid'], [4296, 'spirit'], [4297, 'divine'], [4298, 'demonic'], [4299, 'dragon'],
    [4301, 'insect'], [4302, 'fairy']
]);
const raceByNpc = new Map();
sourceSkillRows.forEach((row) => {
    const race = raceBySkill.get(row.skillId);
    if (race) raceByNpc.set(row.npcId, race);
});
const sourceSkills = parseSkillSource();
const existingSkillIds = new Set([
    ...require(path.join(root, 'data', 'Skills', 'Active', 'active.json')),
    ...require(path.join(root, 'data', 'Skills', 'Passive', 'passive.json')),
    ...require(path.join(root, 'data', 'Npcs', 'Skills', 'active.json')),
    ...fs.readdirSync(path.join(root, 'data', 'Npcs', 'Skills'))
        .filter((name) => name.endsWith('_templates.json') && name !== 'c4_raid_bosses_templates.json')
        .flatMap((name) => require(path.join(root, 'data', 'Npcs', 'Skills', name)))
].map((skill) => Number(skill.selfId)));
const missingSkillIds = sourceSkillIds.filter((id) => !existingSkillIds.has(id));
const missingSkillTemplates = missingSkillIds.map((id) => {
    const source = sourceSkills.get(id);
    if (!source) throw new Error(`Missing source skill XML for ${id}`);
    return makeSkillTemplate(source);
});
if (missingSkillTemplates.length !== 225) throw new Error(`Expected 225 generated skill templates, found ${missingSkillTemplates.length}`);
if (sourceSkillRows.some((row) => !sourceSkills.has(row.skillId) && !existingSkillIds.has(row.skillId))) {
    throw new Error('Some source NPC skill rows have no XML or loaded template');
}

const existingItems = loadedItems();
const existingItemsById = new Map(existingItems.map((item) => [Number(item.selfId), item]));
const sourceItemsById = vendorItems();
const npcs = npcRows.map((row) => {
    const [id, , name, , title, , , collisionRadius, collisionHeight, level, , type,
        attackRange, hp, mp, hpRegen, mpRegen, str, con, dex, int, wit, men,
        exp, sp, pAtk, pDef, mAtk, mDef, atkSpd, aggro, castSpd, rightHand, leftHand,
        , walk, run, faction, helpRadius, undead] = row;
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
        equipment: { weapon: Number(rightHand) || 0, shield: Number(leftHand) || 0, reuseTime: 0 },
        clan: { clanName: faction === 'NULL' ? '' : faction, helpRadius },
        rewards: { exp: level > 0 ? round(exp / (level * level), 12) : 0, sp },
        traits: { race: raceByNpc.get(id) || 'humanoid', undead: Number(undead) !== 0 }
    };
});

const spawnRows = sourceSpawns.filter((row) => bossIdSet.has(Number(row[0])));
if (spawnRows.length !== bossIds.length) throw new Error(`Expected ${bossIds.length} raid-boss spawns, found ${spawnRows.length}`);
if (spawnRows.some((row) => Number(row[1]) !== 1 || Number(row[6]) <= 0 || Number(row[7]) <= Number(row[6]))) {
    throw new Error('Unexpected raid-boss amount or respawn-window semantics');
}
const npcNameById = new Map(npcs.map((npc) => [npc.selfId, npc.template.name]));
const spawns = [{
    selfId: 'c4-raid-bosses',
    bounds: [],
    spawns: spawnRows.map((row) => ({
        selfId: Number(row[0]), name: npcNameById.get(Number(row[0])),
        coords: [{ locX: Number(row[2]), locY: Number(row[3]), locZ: Number(row[4]), head: Number(row[5]) }],
        total: 1,
        respawn: (Number(row[6]) + Number(row[7])) / 2,
        bias: (Number(row[7]) - Number(row[6])) / 2
    }))
}];

const dropRows = tuples('sql/droplist.sql').filter((row) => bossIdSet.has(Number(row[0])));
if (dropRows.length !== 2076) throw new Error(`Expected 2076 raid-boss drops, found ${dropRows.length}`);
function sourceItemName(itemId) {
    const existing = existingItemsById.get(itemId);
    const source = sourceItemsById.get(itemId);
    if (!existing && !source) throw new Error(`Missing item template ${itemId}`);
    return existing?.template?.name || source.name;
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
            items: categoryRows.map((row) => ({ selfId: Number(row[1]), name: sourceItemName(Number(row[1])), min: Number(row[2]), max: Number(row[3]), chance: round(Number(row[5]) / totalChance * 100) })),
            overall: round(totalChance / 10000)
        };
    });
    const spoils = rows.filter((row) => Number(row[4]) === -1).map((row) => ({
        items: [{ selfId: Number(row[1]), name: sourceItemName(Number(row[1])), min: Number(row[2]), max: Number(row[3]), chance: round(Number(row[5]) / 10000) }],
        overall: 100
    }));
    return { selfId: bossId, template: { name: npcNameById.get(bossId) }, rewards: normal, spoils };
});

const missingDropItems = [...new Set(dropRows.map((row) => Number(row[1])))]
    .filter((id) => !existingItemsById.has(id))
    .sort((a, b) => a - b);
const missingEtcItems = missingDropItems.filter((id) => sourceItemsById.get(id)?.type === 'EtcItem').map((id) => {
    const source = sourceItemsById.get(id);
    return {
        selfId: id,
        template: { kind: itemKind(source), name: source.name, class1: 4, class2: 0, mass: numberSet(source, 'weight'), price: numberSet(source, 'price') },
        etc: { stackable: source.sets.get('is_stackable') === 'true', consumable: false }
    };
});
const missingWeapons = missingDropItems.filter((id) => sourceItemsById.get(id)?.type === 'Weapon').map((id) => {
    const source = sourceItemsById.get(id);
    const bodypart = String(source.sets.get('bodypart') || '').toLowerCase();
    return {
        selfId: id,
        template: { name: source.name, class1: 0, class2: 0, mass: numberSet(source, 'weight'), price: numberSet(source, 'price'), kind: weaponKind(source.sets.get('weapon_type')) },
        stats: {
            pAtk: Number(source.stats.get('pAtk') || 0), pAtkRnd: numberSet(source, 'random_damage'), mAtk: Number(source.stats.get('mAtk') || 0),
            atkSpd: Number(source.stats.get('pAtkSpd') || 0), crit: Number(source.stats.get('rCrit') || 0), accur: Number(source.stats.get('accCombat') || 0)
        },
        etc: {
            slot: bodypart === 'lrhand' ? 14 : 7, mp: 0, soulshot: numberSet(source, 'soulshots'), spiritshot: numberSet(source, 'spiritshots'),
            rank: String(source.sets.get('crystal_type') || '').toLowerCase(), cristals: numberSet(source, 'crystal_count')
        }
    };
});
if (missingEtcItems.length + missingWeapons.length !== missingDropItems.length) {
    throw new Error(`Unsupported item dependency types: ${missingDropItems.filter((id) => !missingEtcItems.some((item) => item.selfId === id) && !missingWeapons.some((item) => item.selfId === id)).join(', ')}`);
}

const minionRows = tuples('sql/minions.sql').filter((row) => bossIdSet.has(Number(row[0]))).map((row) => ({
    bossId: Number(row[0]), minionId: Number(row[1]), min: Number(row[2]), max: Number(row[3])
}));
if (minionRows.length !== 284) throw new Error(`Expected 284 sourced minion rows, found ${minionRows.length}`);

writeJson(`data/Npcs/${filename}`, npcs);
writeJson(`data/Npcs/Spawns/${filename}`, spawns);
writeJson(`data/Npcs/Rewards/${filename}`, rewards);
writeJson(`data/Npcs/Skills/${filename}`, sourceSkillRows);
writeJson('data/Npcs/Skills/c4_raid_bosses_templates.json', missingSkillTemplates);
writeJson(`data/Items/Others/${filename}`, missingEtcItems);
writeJson(`data/Items/Weapons/${filename}`, missingWeapons);
writeJson(`data/Npcs/Minions/${filename}`, minionRows);

console.info(`Generated ${npcs.length} raid bosses, ${spawnRows.length} spawns, ${dropRows.length} drops, ${sourceSkillRows.length} skills, ${missingSkillTemplates.length} skill templates, ${missingEtcItems.length} etc items, ${missingWeapons.length} weapons, ${minionRows.length} minion rows.`);
