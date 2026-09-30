// Generates the missing data the level 20-30 quest imports need, straight from
// the pinned Lisvus vendor tree (tmp/vendor/l2j-lisvus, revision fdc7e33a):
//  - the nine quest items of Q298/Q369/Q370/Q380, parsed from the chunked
//    item XMLs (data/Items/Others/c4_quest_298_380_items.json);
//  - the twenty-one C3/C4 spellbooks Q334 hands out as wish rewards
//    (data/Items/Others/c4_quest_334_items.json);
//  - the Maille Lizardmen 922-926 templates Q298 makes players kill, from
//    sql/npc.sql, and their 228 official spawn rows, from sql/spawnlist.sql.
// Run: node scripts/generate-c4-middle-quests.js
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const vendor = path.join(root, 'tmp', 'vendor', 'l2j-lisvus', 'datapack');
const expectedRevision = 'fdc7e33af5d69067b41a6ee7cc7c07fe7aa35975';

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
    const sql = fs.readFileSync(path.join(vendor, relativePath), 'utf8');
    return sql.split(/\r?\n/).filter(l => l.startsWith('(')).map(parseTuple).filter(Boolean);
}

function questItems() {
    const wanted = { 5882: '5800-5899.xml', 5883: '5800-5899.xml',
        5895: '5800-5899.xml', 5896: '5800-5899.xml', 5897: '5800-5899.xml',
        5960: '5900-5999.xml',
        5917: '5900-5999.xml', 5918: '5900-5999.xml', 5919: '5900-5999.xml', 5920: '5900-5999.xml',
        7182: '7100-7199.xml', 7183: '7100-7199.xml', 7184: '7100-7199.xml' };
    const items = [];
    for (const [idString, chunk] of Object.entries(wanted)) {
        const id = Number(idString);
        const xml = fs.readFileSync(path.join(vendor, 'data', 'stats', 'items', chunk), 'utf8');
        const match = xml.match(new RegExp(`<item id="${id}" name="([^"]+)"[\\s\\S]*?</item>`));
        if (!match) throw new Error(`Vendor item ${id} not found in ${chunk}`);
        const [, name] = match;
        const body = match[0];
        const set = (key) => {
            const hit = body.match(new RegExp(`name="${key}" val="([^"]*)"`));
            return hit ? hit[1] : undefined;
        };
        const type = set('etcitem_type');
        if (!['QUEST', 'OTHER'].includes(type)) throw new Error(`Vendor item ${id} is a ${type}`);
        items.push({
            selfId: id,
            template: {
                kind: 'Other.Quest', name, class1: 4, class2: 3,
                mass: Number(set('weight') || 0), price: Number(set('price') || 0)
            },
            etc: { stackable: set('is_stackable') === 'true', consumable: false }
        });
    }
    return items.sort((a, b) => a.selfId - b.selfId);
}

// Q334's four wisdom wishes hand out random spellbooks off three long tables;
// twenty-one of those books (C3/C4 recipes) had never been imported. Q334's
// other 81 books and every quest item already ship in others.json.
function wishingBooks() {
    const wanted = {
        4907: '4900-4999.xml', 4909: '4900-4999.xml', 4912: '4900-4999.xml', 4913: '4900-4999.xml',
        4914: '4900-4999.xml', 4917: '4900-4999.xml', 4918: '4900-4999.xml', 4919: '4900-4999.xml',
        4920: '4900-4999.xml', 4922: '4900-4999.xml', 4923: '4900-4999.xml', 4924: '4900-4999.xml',
        4926: '4900-4999.xml', 4928: '4900-4999.xml', 4929: '4900-4999.xml', 4930: '4900-4999.xml',
        4931: '4900-4999.xml', 4932: '4900-4999.xml', 4933: '4900-4999.xml', 4934: '4900-4999.xml',
        5013: '5000-5099.xml',
    };
    const items = [];
    for (const [idString, chunk] of Object.entries(wanted)) {
        const id = Number(idString);
        const xml = fs.readFileSync(path.join(vendor, 'data', 'stats', 'items', chunk), 'utf8');
        const match = xml.match(new RegExp(`<item id="${id}" name="([^"]+)"[\\s\\S]*?</item>`));
        if (!match) throw new Error(`Vendor item ${id} not found in ${chunk}`);
        const [, name] = match;
        const body = match[0];
        const set = (key) => {
            const hit = body.match(new RegExp(`name="${key}" val="([^"]*)"`));
            return hit ? hit[1] : undefined;
        };
        const type = set('etcitem_type');
        if (type !== 'SPELLBOOK') throw new Error(`Vendor item ${id} is a ${type}`);
        items.push({
            selfId: id,
            template: {
                kind: 'Other.Spellbook', name, class1: 4, class2: 5,
                mass: Number(set('weight') || 0), price: Number(set('price') || 0)
            },
            etc: { stackable: false, consumable: false }
        });
    }
    return items.sort((a, b) => a.selfId - b.selfId);
}

// npc.sql column order, 0-based (43 columns).
const NPC_COLUMNS = {
    selfId: 0, name: 2, title: 4, collisionRadius: 7, collisionHeight: 8, level: 9,
    type: 11, attackRange: 12, hp: 13, mp: 14, hpRegen: 15, mpRegen: 16,
    str: 17, con: 18, dex: 19, int: 20, wit: 21, men: 22,
    exp: 23, sp: 24, pAtk: 25, pDef: 26, mAtk: 27, mDef: 28, atkSpd: 29,
    aggro: 30, castSpd: 31, rightHand: 32, leftHand: 33,
    walk: 35, run: 36, faction: 37, helpRadius: 38, undead: 39
};

function round(value, digits = 12) {
    return Number(Number(value).toFixed(digits));
}

function mailleTemplates() {
    // 922-926 are the Maille faction monsters of the Gludio/Folon wilds
    // (Q298's kill targets). Their race comes from the 4290-4302 race skill
    // in npcskills.sql, exactly like scripts/generate-c4-legacy-monsters.js.
    const raceBySkill = new Map([
        [4290, 'undead'], [4291, 'construct'], [4292, 'beast'], [4293, 'animal'],
        [4294, 'plant'], [4295, 'humanoid'], [4296, 'spirit'], [4297, 'divine'],
        [4298, 'demonic'], [4299, 'dragon'], [4300, 'giant'], [4301, 'insect'], [4302, 'fairy']
    ]);
    const rows = new Map(tuples('sql/npc.sql')
        .filter(row => row[NPC_COLUMNS.selfId] >= 922 && row[NPC_COLUMNS.selfId] <= 926)
        .map(row => [Number(row[NPC_COLUMNS.selfId]), row]));
    if (rows.size !== 5) throw new Error(`Expected 5 Maille npc.sql rows, found ${rows.size}`);
    const races = new Map();
    for (const row of tuples('sql/npcskills.sql')) {
        const race = raceBySkill.get(Number(row[1]));
        if (race) races.set(Number(row[0]), race);
    }
    return [922, 923, 924, 925, 926].map((id) => {
        const r = NPC_COLUMNS;
        const row = rows.get(id);
        const get = key => row[r[key]];
        const type = get('type');
        if (!['L2Monster', 'L2Minion'].includes(String(type))) {
            throw new Error(`Maille ${id} has unexpected type ${type}`);
        }
        const level = get('level');
        return {
            selfId: id,
            template: {
                kind: 'Monster', name: get('name'), title: String(get('title') || ''),
                level, hostile: Number(get('aggro')) > 0
            },
            traits: { race: races.get(id) || 'humanoid', undead: Number(get('undead')) !== 0 },
            base: { str: get('str'), dex: get('dex'), con: get('con'), int: get('int'),
                wit: get('wit'), men: get('men') },
            stats: {
                pAtk: get('pAtk'), pAtkRnd: 30, pDef: get('pDef'), mAtk: get('mAtk'),
                mDef: get('mDef'), accur: 4.75, atkSpd: get('atkSpd'),
                castSpd: get('castSpd'), atkRadius: get('attackRange')
            },
            speed: { walk: get('walk'), run: get('run') },
            vitals: { maxHp: get('hp'), maxMp: get('mp'), revHp: get('hpRegen'),
                revMp: get('mpRegen'), corpseTime: 7000 },
            collision: { radius: get('collisionRadius'), size: get('collisionHeight') },
            equipment: { weapon: get('rightHand'), shield: get('leftHand'), reuseTime: 0 },
            clan: { clanName: String(get('faction') || '') === 'NULL' ? '' : String(get('faction') || ''),
                helpRadius: get('helpRadius') },
            rewards: { exp: level > 0 ? round(get('exp') / (level * level)) : 0, sp: get('sp') }
        };
    });
}

function mailleRewards() {
    // 65 official droplist rows spread over the five Maille kills. Every drop
    // is an ordinary material that already ships in data/Items, so names come
    // from the repo copy rather than the vendor XMLs.
    const rows = tuples('sql/droplist.sql').filter(r => r[0] >= 922 && r[0] <= 926);
    if (rows.length !== 65) throw new Error(`Expected 65 Maille droplist rows, found ${rows.length}`);
    const names = new Map();
    for (const directory of ['Armors', 'Weapons', 'Others']) {
        const dir = path.join(root, 'data', 'Items', directory);
        for (const file of fs.readdirSync(dir).filter(n => n.endsWith('.json'))) {
            const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
            for (const item of Array.isArray(parsed) ? parsed : []) {
                if (!names.has(item.selfId)) names.set(item.selfId, item.template.name);
            }
        }
    }
    const nameOf = id => {
        if (!names.has(id)) throw new Error(`Maille drop item ${id} is missing from data/Items`);
        return names.get(id);
    };
    const templates = new Map(mailleTemplates().map(t => [t.selfId, t.template.name]));
    return [922, 923, 924, 925, 926].map((mobId) => {
        const mobRows = rows.filter(r => Number(r[0]) === mobId);
        const categories = new Map();
        for (const row of mobRows.filter(r => Number(r[4]) >= 0)) {
            if (!categories.has(row[4])) categories.set(row[4], []);
            categories.get(row[4]).push(row);
        }
        const rewards = [...categories.values()].map(categoryRows => ({
            items: categoryRows.map(row => ({
                selfId: Number(row[1]), name: nameOf(Number(row[1])), min: Number(row[2]),
                max: Number(row[3]), chance: round(Number(row[5]) / categoryRows.reduce((s, r2) => s + Number(r2[5]), 0) * 100)
            })),
            overall: round(categoryRows.reduce((s, r2) => s + Number(r2[5]), 0) / 10000)
        }));
        const spoils = mobRows.filter(r => Number(r[4]) === -1).map(row => ({
            items: [{ selfId: Number(row[1]), name: nameOf(Number(row[1])), min: Number(row[2]),
                max: Number(row[3]), chance: round(Number(row[5]) / 10000) }],
            overall: 100
        }));
        return { selfId: mobId, template: { name: templates.get(mobId) }, rewards, spoils };
    });
}

function mailleSpawns() {
    const names = new Map();
    for (const t of mailleTemplates()) names.set(t.selfId, t.template.name);
    // respawn_delay 32 is the stored Lisvus default; the repo spawn files use
    // 60 for ordinary monsters, matching data/Npcs/Spawns/c4_*.json.
    const byNpc = new Map([...names.keys()].map(id => [id, []]));
    for (const row of tuples('sql/spawnlist.sql')) {
        if (!byNpc.has(Number(row[3]))) continue;
        byNpc.get(Number(row[3])).push({ locX: row[4], locY: row[5], locZ: row[6], head: row[9] });
    }
    const total = [...byNpc.values()].reduce((n, rows) => n + rows.length, 0);
    // 228 grep hits include 2 rows whose location string contains '922'/'926';
    // only these 226 have npc_templateid 922-926.
    if (total !== 226) throw new Error(`Expected 226 Maille spawn rows, found ${total}`);
    return [{
        selfId: 'c4-maille-lizardmen', bounds: [],
        spawns: [...byNpc.entries()].map(([selfId, coords]) => ({
            selfId, name: names.get(selfId), coords, total: 1, respawn: 60, bias: 0
        }))
    }];
}

function main() {
    const revision = execFileSync('git', ['-C', path.dirname(vendor), 'rev-parse', 'HEAD'],
        { encoding: 'utf8' }).trim();
    if (revision !== expectedRevision) {
        throw new Error(`Expected Lisvus ${expectedRevision}, found ${revision}`);
    }
    for (const [relative, value] of [
        ['data/Items/Others/c4_quest_298_380_items.json', questItems()],
        ['data/Items/Others/c4_quest_334_items.json', wishingBooks()],
        ['data/Npcs/c4_maille_lizardmen.json', mailleTemplates()],
        ['data/Npcs/Spawns/c4_maille_lizardmen.json', mailleSpawns()],
        ['data/Npcs/Rewards/c4_maille_lizardmen.json', mailleRewards()]
    ]) {
        fs.writeFileSync(path.join(root, relative), `${JSON.stringify(value, null, 2)}\n`);
        const rows = Array.isArray(value) ? (value[0]?.spawns?.length ? value[0].spawns.reduce((n, s) => n + s.coords.length, 0) : value.length) : 0;
        console.log(relative, Array.isArray(value) ? value.length : 0, 'entries', rows !== (Array.isArray(value) ? value.length : 0) ? `(${rows} rows)` : '');
    }
}

if (require.main === module) main();
module.exports = { questItems, wishingBooks, mailleTemplates, mailleSpawns, mailleRewards };
