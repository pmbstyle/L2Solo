// Source: L2J Lisvus pets_stats.sql. XP ownership policy is intentionally not imported.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const vendor = path.resolve(process.argv[2] || path.join(root, 'tmp/vendor/l2j-lisvus'));
const revision = 'fdc7e33af5d69067b41a6ee7cc7c07fe7aa35975';
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: vendor, encoding: 'utf8' }).trim() !== revision) throw new Error('Unexpected pet reference revision');
const fields = ['npcId', 'level', 'exp', 'maxHp', 'maxMp', 'pAtk', 'pDef', 'mAtk', 'mDef', 'accur', 'evasion', 'critical', 'run', 'atkSpd', 'castSpd', 'maxFeed', 'feedBattle', 'feedNormal', 'revHp', 'revMp'];
const sql = fs.readFileSync(path.join(vendor, 'datapack/sql/pets_stats.sql'), 'utf8');
const rows = [...sql.matchAll(/\('([^']+)',\s*([^;()]+)\)/g)].map((match) => {
    const values = match[2].split(',').map(Number);
    return Object.fromEntries(fields.map((field, i) => [field, values[i]]));
});
if (rows.length !== 972 || rows.some(row => Object.values(row).some(value => !Number.isFinite(value)))) throw new Error('Incomplete pet stat reference');
fs.writeFileSync(path.join(root, 'data/Pets/c4-stats.json'), JSON.stringify({ source: 'https://gitlab.com/TheDnR/l2j-lisvus', revision }).slice(0, -1) + ',\n"rows": [\n' + rows.map(row => JSON.stringify(row)).join(',\n') + '\n]}\n');
console.log(`Generated ${rows.length} pet stat rows`);
const npcSql = fs.readFileSync(path.join(vendor, 'datapack/sql/npc.sql'), 'utf8');
const petIds = [12077,12311,12312,12313,12526,12527,12528,12564,12780,12781,12782];
const collision = {};
for (const line of npcSql.split('\n')) {
    const values = line.match(/'(?:[^']*)'|[^,()]+/g);
    if (!values) continue;
    const clean = values.map(value => value.trim().replace(/^'|'$/g, ''));
    const id = Number(clean[0]);
    if (petIds.includes(id)) collision[id] = { radius: Number(clean[7]), size: Number(clean[8]) };
}
if (Object.keys(collision).length !== petIds.length || Object.values(collision).some(v => !(v.radius > 0 && v.size > 0))) throw new Error('Incomplete pet collision reference');
fs.writeFileSync(path.join(root, 'data/Pets/c4-collision.json'), JSON.stringify({ revision, collision }, null, 2) + '\n');
const gear = {};
const directory = path.join(vendor, 'datapack/data/stats/items');
for (const filename of fs.readdirSync(directory).filter(name => name.endsWith('.xml')).sort()) {
    const xml = fs.readFileSync(path.join(directory, filename), 'utf8');
    for (const match of xml.matchAll(/<item id="(\d+)" name="([^"]+)" type="(Weapon|Armor)">([\s\S]*?)<\/item>/g)) {
        const category = match[4].match(/name="bodypart" val="(wolf|hatchling|strider)"/);
        if (!category) continue;
        const stats = {};
        for (const value of match[4].matchAll(/<(add|set) order="[^"]+" stat="([^"]+)" val="([\d.]+)"/g)) stats[value[2]] = Number(value[3]);
        gear[match[1]] = { name: match[2], category: category[1], slot: match[3] === 'Weapon' ? 'weapon' : 'armor', stats };
    }
}
fs.writeFileSync(path.join(root, 'data/Pets/c4-gear.json'), JSON.stringify({ revision, gear }, null, 2) + '\n');
const quizDir = path.join(vendor, 'datapack/data/scripts/quests/419_GetaPet');
const questions = [];
for (let id = 1; id <= 14; id++) {
    const html = fs.readFileSync(path.join(quizDir, `419_q${id}.htm`), 'utf8');
    const text = html.slice(html.indexOf('Question:') + 9, html.indexOf('<a action='));
    const answers = [...html.matchAll(/<a action="bypass -h Quest 419_GetAPet (right|wrong)">([\s\S]*?)<\/a>/g)]
        .map(match => ({ text: match[2], correct: match[1] === 'right' }));
    if (answers.filter(answer => answer.correct).length !== 1) throw new Error(`Invalid quiz ${id}`);
    questions.push({ id, text, answers });
}
const tutorials = {};
for (const [id, name, pages] of [[7256, 'bella', [2, 3]], [7091, 'ellie', [2]], [7072, 'metty', [2]]]) {
    tutorials[id] = pages.map(page => fs.readFileSync(path.join(quizDir, `419_${name}_${page}.htm`), 'utf8')
        .replace(/^[\s\S]*?<body>[^<]*<br>/, '')
        .replace(/<a action=[\s\S]*?<\/a>/g, '')
        .replace(/<\/body>[\s\S]*$/, '').trim()).join('<br>');
}
fs.writeFileSync(path.join(root, 'data/Pets/c4-wolf-quiz.json'), JSON.stringify({ revision, questions, tutorials }, null, 2) + '\n');
const skillXml = fs.readFileSync(path.join(vendor, 'datapack/data/stats/skills/4700-4799.xml'), 'utf8');
const skills = [];
const rules = {};
for (const match of skillXml.matchAll(/<skill id="(471[0-378])" levels="12" name="([^"]+)">([\s\S]*?)<\/skill>/g)) {
    const tables = Object.fromEntries([...match[3].matchAll(/<table name="([^"]+)">([^<]+)<\/table>/g)].map(m => [m[1], m[2].trim().split(/\s+/).map(Number)]));
    const settings = Object.fromEntries([...match[3].matchAll(/<set name="([^"]+)" val="([^"]+)"\s*\/>/g)].map(m => [m[1], m[2]]));
    const id = Number(match[1]);
    rules[id] = { magicLevelByLevel: tables['#magicLvl'], aggroPointsByLevel: tables['#aggro'],
        castRange: id === 4713 ? -1 : Number(settings.castRange ?? -1),
        effectRange: settings.effectRange === undefined ? undefined : Number(settings.effectRange),
        nextActionAttack: settings.nextActionAttack === 'true' };
    skills.push({ selfId: id, template: { name: match[2], passive: false, spell: settings.isMagic === 'true', distance: id === 4713 ? -1 : Number(settings.castRange ?? -1) },
        time: { hitTime: Number(settings.hitTime), reuse: Number(settings.reuseDelay), buff: id === 4710 ? 9000 : id === 4711 ? 30000 : 0 },
        levels: Array.from({ length: 12 }, (_, index) => ({ level: index + 1, power: tables['#power']?.[index] || 0, mp: tables['#mpConsume'][index], hp: 0, itemId: 0, itemCount: 0 })) });
}
if (skills.length !== 6) throw new Error('Incomplete pet skills');
fs.writeFileSync(path.join(root, 'data/Pets/c4-skills.json'), JSON.stringify({ revision, skills, rules }, null, 2) + '\n');
