const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const vendorRepo = path.join(root, 'tmp', 'vendor', 'l2j-lisvus');
const vendorRoot = path.join(vendorRepo, 'datapack');
const expectedLisvusRevision = 'fdc7e33af5d69067b41a6ee7cc7c07fe7aa35975';

if (execFileSync('git', ['-C', vendorRepo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== expectedLisvusRevision) {
    throw new Error(`Expected Lisvus ${expectedLisvusRevision}`);
}

function read(relativePath) {
    return fs.readFileSync(path.join(vendorRoot, relativePath), 'utf8');
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
                id: Number(match[1]), levels: Number(match[2]), name: match[3], tables, sets,
                buff: effectTimes.length ? Math.max(...effectTimes) * 1000 : 0
            });
        }
    });
    return skills;
}

function valuesFor(source, tableName, setName) {
    const table = source.tables.get(tableName);
    if (table?.length) return table;
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
    const levels = Array.from({ length: count }, (_, index) => ({
        level: index + 1,
        power: Number(power[index] ?? source.sets.get('power') ?? 0),
        mp: Number(mp[index] ?? source.sets.get('mpConsume') ?? 0),
        hp: Number(hp[index] ?? source.sets.get('hpConsume') ?? 0),
        itemId: 0,
        itemCount: 0
    }));
    return {
        selfId: source.id,
        template: { name: source.name, passive, spell, distance: selfTarget ? -1 : (castRange || 40) },
        time: {
            hitTime: Number(source.sets.get('hitTime')) || 0,
            reuse: Number(source.sets.get('reuseDelay')) || Number(source.sets.get('coolTime')) || 0,
            buff: source.buff
        },
        levels
    };
}

const bossIds = new Set(require(path.join(root, 'data/Npcs/c4_raid_bosses.json')).map((npc) => Number(npc.selfId)));
const minionRows = tuples('sql/minions.sql')
    .filter((row) => bossIds.has(Number(row[0])))
    .map((row) => ({ bossId: Number(row[0]), minionId: Number(row[1]), min: Number(row[2]), max: Number(row[3]) }));
if (minionRows.length !== 284 || new Set(minionRows.map((row) => row.minionId)).size !== 284) {
    throw new Error('Expected 284 unique C4 raid-boss minion rows');
}

const npcRowsById = new Map(tuples('sql/npc.sql').map((row) => [Number(row[0]), row]));
const minionIds = [...new Set(minionRows.map((row) => row.minionId))];
const weaponItems = ['Armors', 'Weapons', 'Others'].flatMap((directory) => {
    const itemDirectory = path.join(root, 'data', 'Items', directory);
    return fs.readdirSync(itemDirectory).filter((name) => name.endsWith('.json'))
        .flatMap((name) => require(path.join(itemDirectory, name)));
});
const itemsById = new Map(weaponItems.map((item) => [Number(item.selfId), item]));
const raceBySkill = new Map([
    [4290, 'undead'], [4291, 'construct'], [4292, 'beast'], [4293, 'animal'], [4294, 'plant'],
    [4295, 'humanoid'], [4296, 'spirit'], [4297, 'divine'], [4298, 'demonic'], [4299, 'dragon'],
    [4301, 'insect'], [4302, 'fairy']
]);
const sourceSkillRows = tuples('sql/npcskills.sql')
    .filter((row) => minionIds.includes(Number(row[0])))
    .map((row) => ({ npcId: Number(row[0]), skillId: Number(row[1]), level: Number(row[2]) }));
const raceByNpc = new Map();
sourceSkillRows.forEach((row) => {
    if (raceBySkill.has(row.skillId)) raceByNpc.set(row.npcId, raceBySkill.get(row.skillId));
});

const npcs = minionIds.map((id) => {
    const row = npcRowsById.get(id);
    if (!row || row[11] !== 'L2Minion') throw new Error(`Invalid minion source row ${id}`);
    const [selfId, , name, , title, , , collisionRadius, collisionHeight, level, , type,
        attackRange, hp, mp, hpRegen, mpRegen, str, con, dex, int, wit, men,
        exp, sp, pAtk, pDef, mAtk, mDef, atkSpd, aggro, castSpd, rightHand, leftHand,
        , walk, run, faction, helpRadius, undead] = row;
    const weapon = itemsById.get(Number(rightHand));
    return {
        selfId,
        template: { kind: 'Monster', name, title, level, hostile: Number(aggro) > 0 },
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

const existingSkillIds = new Set([
    ...require(path.join(root, 'data/Skills/Active/active.json')),
    ...require(path.join(root, 'data/Skills/Passive/passive.json')),
    ...require(path.join(root, 'data/Npcs/Skills/active.json')),
    ...fs.readdirSync(path.join(root, 'data/Npcs/Skills'))
        .filter((name) => name.endsWith('_templates.json'))
        .flatMap((name) => require(path.join(root, 'data/Npcs/Skills', name)))
].map((skill) => Number(skill.selfId)));
const sourceSkills = parseSkillSource();
const missingSkillTemplates = [...new Set(sourceSkillRows.map((row) => row.skillId))]
    .filter((id) => !existingSkillIds.has(id))
    .map((id) => {
        const source = sourceSkills.get(id);
        if (!source) throw new Error(`Missing source skill XML for minion skill ${id}`);
        return makeSkillTemplate(source);
    });

const dropRows = tuples('sql/droplist.sql').filter((row) => minionIds.includes(Number(row[0])));
const itemName = (id) => itemsById.get(id)?.template?.name || `Item ${id}`;
const rewards = minionIds.map((id) => {
    const rows = dropRows.filter((row) => Number(row[0]) === id);
    const normal = rows.length === 0 ? [] : [{
        items: rows.map((row) => ({
            selfId: Number(row[1]), name: itemName(Number(row[1])), min: Number(row[2]), max: Number(row[3]), chance: 100
        })),
        overall: round(rows.reduce((sum, row) => sum + Number(row[5]), 0) / 10000)
    }];
    return { selfId: id, template: { name: npcs.find((npc) => npc.selfId === id).template.name }, rewards: normal, spoils: [] };
});

writeJson('data/Npcs/c4_raid_boss_minions.json', npcs);
writeJson('data/Npcs/Rewards/c4_raid_boss_minions.json', rewards);
writeJson('data/Npcs/Skills/c4_raid_boss_minions.json', sourceSkillRows);
writeJson('data/Npcs/Skills/c4_raid_boss_minions_templates.json', missingSkillTemplates);
console.info(`Generated ${npcs.length} minion templates, ${sourceSkillRows.length} skill rows, ${missingSkillTemplates.length} skill templates, ${dropRows.length} drop rows.`);
