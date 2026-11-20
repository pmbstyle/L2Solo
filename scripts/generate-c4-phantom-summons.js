// Import the missing Phantom Summoner templates from the pinned C4 reference.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const vendor = path.resolve(process.argv[2] || path.join(root, 'tmp/vendor/l2j-lisvus'));
const revision = 'fdc7e33af5d69067b41a6ee7cc7c07fe7aa35975';
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: vendor, encoding: 'utf8' }).trim() !== revision) {
    throw new Error('Unexpected Lisvus reference revision');
}
const range = (first, last) => Array.from({ length: last - first + 1 }, (_, i) => first + i);
const ids = new Set([...range(12447, 12464), ...range(12503, 12515), 12538, ...range(13165, 13174)]);
const sql = fs.readFileSync(path.join(vendor, 'datapack/sql/npc.sql'), 'utf8');
const npcs = [];
for (const line of sql.split(/\r?\n/)) {
    if (!line.startsWith('(')) continue;
    const values = line.match(/'(?:[^']*)'|[^,()]+/g)
        .map(value => value.trim().replace(/^'|'$/g, ''))
        .map(value => /^[-+]?\d+(\.\d+)?$/.test(value) ? Number(value) : value);
    if (!ids.has(values[0])) continue;
    const [selfId,,name,,title,,,radius,size,level,,type,atkRadius,maxHp,maxMp,revHp,revMp,
        str,con,dex,int,wit,men,exp,sp,pAtk,pDef,mAtk,mDef,atkSpd,aggro,castSpd,
        weapon,shield,,walk,run,clanName,helpRadius] = values;
    if (type !== 'L2Pet' || !['Shadow', 'Silhouette', 'Soulless', 'Nightshade'].includes(name)) {
        throw new Error(`Unexpected summon reference ${selfId}`);
    }
    npcs.push({
        selfId,
        // Lisvus uses L2Pet for servitors; this runtime distinguishes Summon from Pet.
        template: { kind: 'Summon', name, title, level, hostile: aggro > 0 },
        base: { str, dex, con, int, wit, men },
        stats: { pAtk, pAtkRnd: 7, pDef, mAtk, mDef, accur: 3.75, atkSpd, castSpd, atkRadius },
        speed: { walk, run },
        vitals: { maxHp, maxMp, revHp, revMp, corpseTime: 7000 },
        collision: { radius, size },
        equipment: { weapon, shield, reuseTime: 0 },
        clan: { clanName: clanName === 'NULL' ? '' : clanName, helpRadius },
        rewards: { exp, sp }
    });
}
if (npcs.length !== ids.size || new Set(npcs.map(npc => npc.selfId)).size !== ids.size) {
    throw new Error('Incomplete Phantom Summoner reference');
}
const output = path.join(root, 'data/Npcs/summons.json');
const existing = JSON.parse(fs.readFileSync(output, 'utf8')).filter(npc => !ids.has(npc.selfId));
const merged = [...existing, ...npcs.sort((a, b) => a.selfId - b.selfId)];
const result = require('jsonschema').validate(merged, require('../data/Npcs/.schema.json'));
if (!result.valid) throw new Error(result.errors.map(error => error.stack).join('\n'));
// Keep the existing one-line-per-stat-group layout.
const compact = value => value && typeof value === 'object'
    ? `{ ${Object.entries(value).map(([key, entry]) => `${JSON.stringify(key)}: ${JSON.stringify(entry)}`).join(', ')} }`
    : JSON.stringify(value);
fs.writeFileSync(output, '[\n' + merged.map(npc => '    {\n'
    + Object.entries(npc).map(([key, value]) => `        ${JSON.stringify(key)}: ${compact(value)}`).join(',\n')
    + '\n    }').join(',\n') + '\n]\n');
console.log(`Imported ${npcs.length} Phantom Summoner templates from Lisvus ${revision}`);

const summonIds = new Set(require('../data/Skills/Active/active.json')
    .filter(skill => [1128, 1228, 1278, 1333].includes(skill.selfId))
    .flatMap(skill => skill.levels.map(level => level.npcId)));
const skillIds = new Set([4121, 4138, 4233, 4259, 4260, 4705, 4706, 4707]);
const skillSql = fs.readFileSync(path.join(vendor, 'datapack/sql/npcskills.sql'), 'utf8');
const rows = [...skillSql.matchAll(/^\((\d+),\s*(\d+),\s*(\d+)\)/gm)]
    .map(match => ({ npcId: Number(match[1]), skillId: Number(match[2]), level: Number(match[3]) }))
    .filter(row => summonIds.has(row.npcId) && skillIds.has(row.skillId));
if (summonIds.size !== 60 || rows.length !== 154) throw new Error('Incomplete Phantom Summoner skill reference');
const templates = [];
for (const selfId of skillIds) {
    const bucket = Math.floor(selfId / 100) * 100;
    const xml = fs.readFileSync(path.join(vendor, `datapack/data/stats/skills/${bucket}-${bucket + 99}.xml`), 'utf8');
    const match = xml.match(new RegExp(`<skill id="${selfId}" levels="(\\d+)" name="([^"]+)">([\\s\\S]*?)<\\/skill>`));
    if (!match) throw new Error(`Missing skill ${selfId}`);
    const tables = Object.fromEntries([...match[3].matchAll(/<table name="([^"]+)">([^<]+)<\/table>/g)]
        .map(entry => [entry[1], entry[2].trim().split(/\s+/).map(Number)]));
    const settings = Object.fromEntries([...match[3].matchAll(/<set name="([^"]+)" val="([^"]+)"\s*\/>/g)]
        .map(entry => [entry[1], entry[2]]));
    const value = (key, index = 0, fallback = 0) => settings[key]?.startsWith('#')
        ? tables[settings[key]][index] : Number(settings[key] ?? fallback);
    const distance = (index = 0) => value('castRange', index, selfId === 4706 ? -1 : 0);
    const effect = [4259, 4705, 4706].includes(selfId)
        ? match[3].match(/<effect\b[^>]*\bcount="(\d+)"[^>]*\btime="(\d+)"/) : null;
    const effectDuration = effect ? Number(effect[1]) * Number(effect[2]) * 1000 : 0;
    templates.push({
        selfId,
        template: { name: match[2], passive: settings.operateType === 'OP_PASSIVE', spell: settings.isMagic === 'true', distance: distance() },
        time: { hitTime: value('hitTime'), reuse: value('reuseDelay'), buff: effectDuration },
        levels: Array.from({ length: Number(match[1]) }, (_, i) => ({
            level: i + 1, power: value('power', i), mp: value('mpConsume', i), hp: value('hpConsume', i),
            itemId: 0, itemCount: 0, distance: distance(i)
        }))
    });
}
const skillsOutput = path.join(root, 'data/Npcs/Skills/c4_phantom_summons.json');
fs.writeFileSync(skillsOutput, JSON.stringify({ revision, rows, templates }, null, 2) + '\n');
console.log(`Imported ${rows.length} NPC skill bindings and ${templates.length} skill templates`);
