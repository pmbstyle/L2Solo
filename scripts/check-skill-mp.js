#!/usr/bin/env node
'use strict';

// Checks the MP a cast pays for every active skill level against C4.
// Source: L2J Lisvus (C4 Scions of Destiny) datapack/data/stats/skills/*.xml.
// C4 pays mpInitialConsume when the cast starts and mpConsume when it lands,
// so the C4 cost of a level is their sum. The server pays one number per cast
// (Skill.fetchConsumedMp: the C4SkillRules mpConsume override, else the
// level's `mp` in active.json), and that number must equal the C4 sum.
// Why Lisvus and not Mobius C4: Mobius C4 skill MP differs from Lisvus on
// ~770 levels in 90 skills, and l2hub.info/c4 sides with Lisvus on every
// sample (Charm 1: 37, Thunder Storm 1: 40, Lightning Strike 1: 54). A full
// check of the 821 differing levels against l2hub: Lisvus 778; the other 43
// are Bless the Soul (a duplicate table, see loadSkills) and L2HUB_MP.
//
//   node scripts/check-skill-mp.js [--source <skills dir>] [--fix]
//
// --fix rewrites the `mp` of active.json levels that have no rule override.
// A mismatch inside a C4SkillRules override is reported, never rewritten.
// The XML is parsed as data (regexes over text); nothing in it is executed.

const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const activePath = path.join(root, 'data/Skills/Active/active.json');
const defaultSource = path.join(os.homedir(), 'Games/vendor/l2j-lisvus/datapack/data/stats/skills');

function argValue(name) {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : null;
}

function parseValue(raw, tables, level, where) {
    const text = String(raw).trim();
    if (text.startsWith('#')) {
        const table = tables[text];
        if (!table) throw new Error(`${where}: missing table ${text}`);
        if (level > table.length) throw new Error(`${where}: table ${text} has ${table.length} values, level ${level}`);
        return table[level - 1];
    }
    const value = Number(text);
    if (!Number.isFinite(value)) throw new Error(`${where}: unreadable value "${text}"`);
    return value;
}

// Map selfId -> { name, levels, mp(level) } from the skill xml files.
function loadSkills(dir) {
    const skills = new Map();
    const files = fs.readdirSync(dir).filter((file) => /^\d+-\d+\.xml$/.test(file)).sort();
    if (files.length === 0) throw new Error(`no skill xml files in ${dir}`);
    for (const file of files) {
        const text = fs.readFileSync(path.join(dir, file), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
        const skillPattern = /<skill\s+([^>]*?)>([\s\S]*?)<\/skill>/g;
        let match;
        while ((match = skillPattern.exec(text))) {
            const attrs = Object.fromEntries([...match[1].matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
            const body = match[2];
            const id = Number(attrs.id);
            const tables = {};
            // A table defined twice in one skill: the first one is C4 (Bless the
            // Soul 1048 #mpConsume: first 31.. + 8.. initial = l2hub 39, the
            // second gives 47; Spoil Festival 302 repeats an equal table).
            for (const t of body.matchAll(/<table\s+name="(#[^"]+)">([^<]*)<\/table>/g)) {
                if (!(t[1] in tables)) tables[t[1]] = t[2].trim().split(/\s+/).map(Number);
            }
            // Mobius writes <mpConsume>v</mpConsume>; Lisvus <set name="mpConsume" val="v"/>.
            const single = (tag) => {
                const found = [...body.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'g')),
                    ...body.matchAll(new RegExp(`<set\\s+name="${tag}"\\s+val="([^"]*)"`, 'g'))];
                if (found.length > 1) throw new Error(`${file} skill ${id}: ${found.length} ${tag}`);
                return found[0]?.[1] ?? null;
            };
            const consume = single('mpConsume');
            // Lisvus defines #mpConsume_Init but forgets to set it on 4 skills
            // (262, 1032, 1075, 1108); l2hub's C4 totals include it (Invigor 1: 35).
            const initial = single('mpInitialConsume') ?? (tables['#mpConsume_Init'] ? '#mpConsume_Init' : null);
            const where = `${file} skill ${id}`;
            skills.set(id, {
                name: attrs.name,
                levels: Number(attrs.levels) || 1,
                mp: (level) => (consume === null ? 0 : parseValue(consume, tables, level, where))
                    + (initial === null ? 0 : parseValue(initial, tables, level, where)),
                consumeOnly: (level) => (consume === null ? 0 : parseValue(consume, tables, level, where))
            });
        }
    }
    return skills;
}

// Levels where Lisvus is not C4: the MP column of l2hub.info/c4 (the C4
// client) wins. [skill, level, mp, l2hub.info/c4 page]
const L2HUB_MP = [
    [27, 1, 19, 'classes/assasin'], // Unlock: Lisvus 20, Mobius 19
    [27, 5, 31, 'classes/assasin'], // Unlock: Lisvus 32, Mobius 31
    [27, 8, 43, 'classes/abyss_walker'], // Unlock: Lisvus 44, Mobius 43
    [27, 9, 47, 'classes/abyss_walker'], // Unlock: Lisvus 48, Mobius 47
    [27, 10, 51, 'classes/abyss_walker'], // Unlock: Lisvus 52, Mobius 51
    [27, 12, 59, 'classes/abyss_walker'], // Unlock: Lisvus 60, Mobius 59
    [27, 13, 63, 'classes/abyss_walker'], // Unlock: Lisvus 64, Mobius 63
    [34, 1, 19, 'classes/artisan'], // Bandage: Lisvus 20, Mobius 19
    [34, 2, 41, 'classes/bounty_hunter'], // Bandage: Lisvus 35, Mobius 41
    [97, 5, 86, 'classes/paladin'], // Sanctuary: Lisvus 87, Mobius 43
    [97, 7, 92, 'classes/paladin'], // Sanctuary: Lisvus 93, Mobius 46
    [97, 9, 97, 'classes/paladin'], // Sanctuary: Lisvus 98, Mobius 49
    [121, 3, 22, 'classes/destroyer'], // Battle Roar: Lisvus 23, Mobius 22
    [121, 4, 27, 'classes/destroyer'], // Battle Roar: Lisvus 28, Mobius 27
    [313, 3, 59, 'classes/hawkeye'], // Snipe: Lisvus 60, Mobius 30
    [313, 4, 61, 'classes/hawkeye'], // Snipe: Lisvus 62, Mobius 31
    [313, 5, 63, 'classes/hawkeye'], // Snipe: Lisvus 64, Mobius 32
    [1011, 1, 10, 'classes/dark_mage'], // Heal: Lisvus 11, Mobius 10
    [1308, 2, 220, 'classes/warcryer'], // Chant of Predator: Lisvus 200, Mobius 220
    [1331, 2, 78, 'classes/warlock'], // Summon Queen of Cat: Lisvus 108, Mobius 78
    [1332, 2, 78, 'classes/elemental_summoner'], // Summon Unicorn Seraphim: Lisvus 108, Mobius 78
    [1333, 2, 78, 'classes/phantom_summoner'], // Summon Nightshade: Lisvus 108, Mobius 78
    [4075, 2, 22, 'skills/4075 levels'], // Shock: Lisvus 23, Mobius 20
    [4075, 3, 31, 'skills/4075 levels'], // Shock: Lisvus 32, Mobius 28
    [4079, 1, 0, 'skills/4079 levels'], // Siege Hammer: Lisvus 150, Mobius 0
    [4088, 1, 14, 'skills/4088 levels'], // Bleed: Lisvus 9, Mobius 16
    [4088, 2, 22, 'skills/4088 levels'], // Bleed: Lisvus 13, Mobius 24
    [4088, 3, 31, 'skills/4088 levels'], // Bleed: Lisvus 17, Mobius 34
    [4088, 4, 43, 'skills/4088 levels'], // Bleed: Lisvus 22, Mobius 47
    [4088, 5, 55, 'skills/4088 levels'], // Bleed: Lisvus 27, Mobius 61
    [4088, 6, 68, 'skills/4088 levels'], // Bleed: Lisvus 31, Mobius 75
    [4088, 7, 79, 'skills/4088 levels'], // Bleed: Lisvus 34, Mobius 87
    [4088, 8, 84, 'skills/4088 levels'], // Bleed: Lisvus 34, Mobius 93
    [4088, 9, 89, 'skills/4088 levels'], // Bleed: Lisvus 35, Mobius 98
    [4088, 10, 92, 'skills/4088 levels'], // Bleed: Lisvus 35, Mobius 101
    [4088, 11, 94, 'skills/4088 levels'], // Bleed: Lisvus 36, Mobius 103
    [4088, 12, 95, 'skills/4088 levels'], // Bleed: Lisvus 36, Mobius 104
];
const l2hubMp = new Map(L2HUB_MP.map(([id, level, mp]) => [`${id}:${level}`, mp]));

function main() {
    const dir = argValue('--source') || defaultSource;
    if (!fs.existsSync(dir)) {
        console.error(`C4 skill xml not found at ${dir}; pass --source <dir> (gitlab.com/TheDnR/l2j-lisvus).`);
        process.exit(2);
    }
    const fix = process.argv.includes('--fix');
    const c4 = loadSkills(dir);

    require('../src/Global');
    const SkillModel = invoke('GameServer/Model/Skill');
    const active = JSON.parse(fs.readFileSync(activePath, 'utf8'));

    const data = [];     // active.json mp differs, no override: fixable
    const added = [];    // a level C4SkillRules materializes, with the copied mp
    const rules = [];    // the C4SkillRules override differs
    const missing = [];  // no C4 definition for the skill or level
    const touched = new Set(); // skills that got their materialized levels written
    let checked = 0;
    // The levels DataCache serves: active.json plus the levels C4SkillRules
    // materializes past the file's last level (rule maxLevel).
    const served = invoke('GameServer/Skills/C4SkillRules').expandSourcedLevels(active);
    for (const skill of served) {
        const source = c4.get(Number(skill.selfId));
        const own = active.find((row) => row.selfId === skill.selfId);
        const materialized = [];
        let wrongMaterialized = false;
        for (const entry of skill.levels || []) {
            const level = Number(entry.level);
            const inFile = own.levels.includes(entry);
            if (!inFile) materialized.push(entry);
            if (!source || level > source.levels) {
                missing.push(`${skill.selfId} ${skill.template?.name} ${level}`);
                continue;
            }
            checked++;
            const want = l2hubMp.get(`${skill.selfId}:${level}`) ?? source.mp(level);
            // Built as Skillset.populate builds an owned skill.
            const model = new SkillModel({ ...utils.crushOb({ ...skill, levels: undefined }), ...entry });
            const paid = Number(model.fetchConsumedMp());
            const row = { id: skill.selfId, name: skill.template?.name, level, have: paid, want,
                consumeOnly: source.consumeOnly(level), l2hub: l2hubMp.has(`${skill.selfId}:${level}`) };
            if (model.semantic.mpConsume !== null && model.semantic.mpConsume !== undefined) {
                if (paid !== want) rules.push(row);
                continue;
            }
            if (!inFile) entry.c4Mp = want;
            if (paid === want) continue;
            if (inFile) {
                data.push(row);
                if (fix) entry.mp = want;
            } else {
                added.push(row);
                wrongMaterialized = true;
            }
        }
        // A materialized level copies the previous level's mp. Writing all of the
        // skill's materialized levels into active.json gives each its C4 mp
        // (expandSourcedLevels then has nothing left to copy).
        if (fix && wrongMaterialized) {
            for (const { c4Mp, ...entry } of materialized) own.levels.push({ ...entry, mp: c4Mp ?? entry.mp });
            touched.add(own);
        }
    }

    const show = (title, rows) => {
        if (rows.length === 0) return;
        const skills = new Set(rows.map((row) => row.id)).size;
        console.log(`${title}: ${rows.length} levels in ${skills} skills`);
        for (const row of rows) {
            const note = row.l2hub ? ' (l2hub)' : row.have === row.consumeOnly ? ' (initial missing)' : '';
            console.log(`  ${row.id} ${row.name} lv${row.level}: ${row.have} -> ${row.want}${note}`);
        }
    };
    console.log(`Source: ${dir}`);
    console.log(`Checked ${checked} active skill levels`);
    show(fix ? 'Fixed in active.json' : 'active.json mp differs from C4 (fix with --fix)', data);
    show(fix ? 'Written into active.json (were materialized)' : 'Materialized level mp differs from C4 (--fix writes the level)', added);
    show('C4SkillRules mpConsume override differs from C4 (edit the rule)', rules);
    if (missing.length) console.log(`No C4 level in the source (not checked): ${missing.join(', ')}`);

    if (fix && data.length + added.length) {
        for (const skill of touched) skill.levels.sort((a, b) => Number(a.level) - Number(b.level));
        fs.writeFileSync(activePath, JSON.stringify(active, null, 4) + '\n');
    }
    process.exit((fix ? 0 : data.length + added.length) + rules.length > 0 ? 1 : 0);
}

main();
