const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const vendorRepo = path.join(root, 'tmp', 'vendor', 'l2j-lisvus');
const vendorRoot = path.join(vendorRepo, 'datapack');
const expectedLisvusRevision = 'fdc7e33af5d69067b41a6ee7cc7c07fe7aa35975';

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

function round(value, digits = 12) {
    return Number(Number(value).toFixed(digits));
}

function skillLevel(level, power = 0, mp = 0) {
    return { level, power, mp, hp: 0, itemId: 0, itemCount: 0 };
}

const legacySkillTemplates = [
    {
        selfId: 4011,
        template: { name: 'Resist Wind', passive: true, spell: true, distance: 0 },
        time: { hitTime: 4000, reuse: 6000, buff: 0 },
        levels: [1, 2, 3, 4, 5, 6].map((level) => skillLevel(level))
    },
    {
        selfId: 4161,
        template: { name: 'Summon PC', passive: false, spell: true, distance: 600 },
        time: { hitTime: 2000, reuse: 0, buff: 0 },
        levels: [skillLevel(1)]
    },
    {
        selfId: 4282,
        template: { name: 'Earth Attack Weak Point', passive: true, spell: false, distance: 0 },
        time: { hitTime: 0, reuse: 0, buff: 0 },
        levels: [1, 2, 3, 4, 5].map((level) => skillLevel(level))
    },
    {
        selfId: 4310,
        template: { name: 'Strong Type', passive: true, spell: false, distance: 0 },
        time: { hitTime: 0, reuse: 0, buff: 0 },
        levels: [skillLevel(1)]
    },
    {
        selfId: 4320,
        template: { name: 'Poison', passive: false, spell: true, distance: 1500 },
        time: { hitTime: 0, reuse: 0, buff: 30000 },
        levels: [
            [4, 13], [5, 20], [6, 27], [7, 35], [8, 45], [9, 55],
            [10, 65], [11, 69], [12, 73], [13, 77], [15, 78], [16, 83]
        ].map(([power, mp], index) => skillLevel(index + 1, power, mp))
    }
];

function generate() {
    const lisvusRevision = execFileSync('git', ['-C', vendorRepo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    if (lisvusRevision !== expectedLisvusRevision) {
        throw new Error(`Expected Lisvus ${expectedLisvusRevision}, found ${lisvusRevision}`);
    }

    const baseNpcs = require(path.join(root, 'data', 'Npcs', 'npcs.json'));
    const npcRowsById = new Map(tuples('sql/npc.sql').map((row) => [Number(row[0]), row]));
    const skillRows = tuples('sql/npcskills.sql');
    const raceBySkill = new Map([
        [4290, 'undead'], [4291, 'construct'], [4292, 'beast'], [4293, 'animal'],
        [4294, 'plant'], [4295, 'humanoid'], [4296, 'spirit'], [4297, 'divine'],
        [4298, 'demonic'], [4299, 'dragon'], [4300, 'giant'], [4301, 'insect'], [4302, 'fairy']
    ]);
    const ordinaryTypes = new Set(['L2Monster', 'L2Minion']);
    const legacyIds = baseNpcs
        .filter((npc) => npc.template?.kind === 'Monster'
            && Number(npc.selfId) !== 135
            && ordinaryTypes.has(String(npcRowsById.get(Number(npc.selfId))?.[11])))
        .map((npc) => Number(npc.selfId))
        .sort((a, b) => a - b);
    const legacyIdSet = new Set(legacyIds);

    const sourceSkillRows = skillRows
        .filter((row) => legacyIdSet.has(Number(row[0])))
        .map((row) => ({ npcId: Number(row[0]), skillId: Number(row[1]), level: Number(row[2]) }));
    const raceByNpc = new Map();
    sourceSkillRows.forEach((row) => {
        const race = raceBySkill.get(row.skillId);
        if (race) raceByNpc.set(row.npcId, race);
    });

    const existingById = new Map(baseNpcs.map((npc) => [Number(npc.selfId), npc]));
    const npcs = legacyIds.map((id) => {
        const row = npcRowsById.get(id);
        const existing = existingById.get(id);
        const [
            selfId, , name, , title, , , collisionRadius, collisionHeight, level, , type,
            attackRange, hp, mp, hpRegen, mpRegen, str, con, dex, int, wit, men,
            exp, sp, pAtk, pDef, mAtk, mDef, atkSpd, aggro, castSpd, rightHand, leftHand,
            , walk, run, faction, helpRadius, undead
        ] = row;
        const race = raceByNpc.get(selfId);
        if (!ordinaryTypes.has(type) || !race) {
            throw new Error(`Invalid legacy source NPC ${selfId}: type=${type} race=${race}`);
        }
        return {
            selfId,
            template: { kind: 'Monster', name, title, level, hostile: Number(aggro) > 0 },
            traits: { race, undead: Number(undead) !== 0 },
            base: { str, dex, con, int, wit, men },
            stats: {
                pAtk,
                pAtkRnd: Number(existing.stats?.pAtkRnd ?? 30),
                pDef,
                mAtk,
                mDef,
                accur: Number(existing.stats?.accur ?? 4.75),
                atkSpd,
                castSpd,
                atkRadius: attackRange
            },
            speed: { walk, run },
            vitals: { maxHp: hp, maxMp: mp, revHp: hpRegen, revMp: mpRegen, corpseTime: 7000 },
            collision: { radius: collisionRadius, size: collisionHeight },
            equipment: {
                weapon: rightHand,
                shield: leftHand,
                reuseTime: Number(existing.equipment?.reuseTime || 0)
            },
            clan: { clanName: faction === 'NULL' ? '' : faction, helpRadius },
            rewards: { exp: level > 0 ? round(exp / (level * level)) : 0, sp }
        };
    });

    if (npcs.length !== 851) throw new Error(`Expected 851 legacy ordinary monsters, found ${npcs.length}`);
    if (sourceSkillRows.length !== 2281) throw new Error(`Expected 2281 legacy NPC skill rows, found ${sourceSkillRows.length}`);

    writeJson('data/Npcs/c4_legacy_monsters.json', npcs);
    writeJson('data/Npcs/Skills/c4_legacy_monsters.json', sourceSkillRows);
    writeJson('data/Npcs/Skills/c4_legacy_monster_templates.json', legacySkillTemplates);
    return { npcs: npcs.length, skills: sourceSkillRows.length, skillTemplates: legacySkillTemplates.length };
}

if (require.main === module) {
    const result = generate();
    console.info(`Generated ${result.npcs} legacy C4 NPCs, ${result.skills} skill rows, and ${result.skillTemplates} skill templates.`);
}

module.exports = { generate, legacySkillTemplates };
