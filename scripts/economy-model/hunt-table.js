'use strict';
// The model's own hunting table: what a bot of each kit key, at its own level, in
// a kit (its stat point; for now the creation kit only) gets from each species of
// each spot near its level, the species alone, bare and with its weapon's shots.
// Measured by the spot table generator's hunt() (the game's cold combat) with the
// game's solo readiness lifted (hunt-lift.js); physics at rate x1. The model
// applies the rates, its per-species admission and the combination of species on
// time (combine) when it reads the file. Offline only, one file per combat
// revision (stamp) and level range:
//   node scripts/economy-model/hunt-table.js --levels 1-19 [--children 7] [--hours 2]
//        [--spots id,id] [--keys k,k] [--out file]   (a pick: --out required)
//        [--catalogue file]   (a saved { spots, profiles } catalogue, --out required; default: built now, geodata required)
// The hunts' results go to <out>.parts/ as they come, by stamp: a build run
// again on the same tree skips the hunts already there.
// Split over machines (the fork's tables workflow):
//        [--shard i/N]   runs the i-th of N shares (every N-th hunt of the round's
//                        list) of the first round not complete, then stops: no table
//        [--join]        runs no hunt: the table from the parts, a hunt without a result is an error
require('../../src/Global');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Boot = require('./boot');
const Cohort = require('./cohort');
const LIMITS = require('./design/limits');
const HuntRows = require('./rules/hunt-rows');
const Generator = require('../generate-spot-table');
const Lift = require('./hunt-lift');
const Weights = require('./weights');

const ROOT = path.resolve(__dirname, '../..');
// A cell, per form [bare, shots]: kills an hour, then per kill: deaths, the
// fight without the walk (s), the rest it calls for (s), the other time of the
// hunt (death recovery, waits; s), the walk to the mobs (s), exp (x1 and before
// the C4 level-gap penalty: the generator's simulation takes it out of the cold
// kill, the reader applies it per species), shots, potions, and the mobs per
// engagement (pull).
// fight + rest + other + walk = the hunt's time per kill, so species combine
// on time. A cell without a kill has kills 0 and every per-kill field null.
const FIELDS = Object.freeze(['kills', 'deaths', 'fight', 'rest', 'other', 'walk', 'exp', 'shots', 'potions', 'pull']);
const FORMS = Object.freeze(['bare', 'shots']);
// Species level minus bot level, our edges: from a gap of 9 below the mob is
// deep blue (ProgressionRates: its drops fall, the reader's world rule), so -9
// is the last gap kept; above +7 every swept cell was a death per kill or worse.
const WINDOW = Object.freeze([-9, 7]);
const POINT_FIELDS = Object.freeze(['attack', 'defence']);
const REST_RULE = `fight when HP above the potion line and MP cover ${LIMITS.FIGHT_COVER.value} expected fight with the mob, or at a whole bar`;
const START = 1_750_000_000_000;
// The combination check: per body and form this many spots the reader cuts no
// species of (all in the window, each with a kill and within the limit),
// hunted whole.
const CHECK_SPOTS = 3;
// The files the stamp adds to the spot table generator's inputs. Of the design
// limits only the rest rule's value enters a cell (stamp's fightCover); the
// kill-death limit is applied at read time, so moving it keeps the table.
const STAMP_FILES = Object.freeze(['src/GameServer/Knowledge/StarterItemCatalog.js', 'scripts/economy-model/hunt-lift.js',
    'scripts/economy-model/hunt-table.js', 'scripts/geodata-release.json', 'scripts/hunt-tables/common.js']);

const round = value => value === 0 ? 0 : Number(value.toPrecision(4));

// A hunt's sums as one cell form (FIELDS). Kills an hour and the other time
// count over the hunt's measured span (Generator.hunt's spanMs: to where its
// last round or rest ended), the span its fight and rest were counted in, so
// the parts tile the hour per kill.
function cellOf(sum) {
    const per = Generator.perKill(sum);
    if (!per) return [0, ...FIELDS.slice(1).map(() => null)];
    const k = sum.mobs, walk = sum.walkMs / 1000 / k;
    return [round(per.kph), round(per.deaths), round(per.fight - walk), round(per.rest), round(sum.spanMs / 1000 / k - per.fight - per.rest),
        round(walk), round(per.exp), round(per.shots), round(per.potions), round(sum.pullMobs / sum.pulls)];
}

// The spot's species: selfId -> { level, count, production (mobs an hour, null without a production table) }.
function speciesOf(spot) {
    const by = new Map();
    for (const entry of spot.npcEntries || []) {
        const selfId = Number(entry.selfId), held = by.get(selfId) || { level: Number(entry.level), count: 0, production: null };
        held.count += Math.max(1, Number(entry.count) || 1);
        if (Number.isFinite(entry.production)) held.production = round((held.production || 0) + entry.production);
        by.set(selfId, held);
    }
    return by;
}

// The species alone on its spot: its own spawns, its share of the spot's
// density (the walk between its mobs), its level counts.
function speciesSpot(spot, selfId) {
    const entries = spot.npcEntries.filter(entry => Number(entry.selfId) === selfId);
    const total = spot.npcEntries.reduce((sum, entry) => sum + Math.max(1, Number(entry.count) || 1), 0);
    const count = entries.reduce((sum, entry) => sum + Math.max(1, Number(entry.count) || 1), 0);
    const levelCounts = {};
    for (const entry of entries) levelCounts[entry.level] = (levelCounts[entry.level] || 0) + Math.max(1, Number(entry.count) || 1);
    return { ...spot, npcEntries: entries, npcSelfIds: [selfId], npcNames: [entries[0].name],
        density: (Number(spot.density) || 1) * count / total, levelCounts,
        dominantLevels: Object.entries(levelCounts).map(([level, held]) => ({ level: Number(level), count: held })).sort((a, b) => b.count - a.count) };
}

// The class's creation kit (StarterItemCatalog, the game's rule for players and
// bots), worn: hunt()'s kit(bot) over the reference body.
function creationKit(classId) {
    const Data = invoke('GameServer/DataCache'), Starter = invoke('GameServer/Knowledge/StarterItemCatalog');
    const rows = Starter.starterRows(Data.newbieItems, classId, Data.items);
    return bot => {
        const inventory = {};
        for (const row of rows) inventory[String(row.selfId)] = row.equipped
            ? { selfId: Number(row.selfId), amount: 1, equipped: true, equippedCount: 1, equippedSlots: [row.slot], slot: row.slot }
            : { selfId: Number(row.selfId), amount: Number(row.amount) || 1 };
        bot.inventory = inventory;
    };
}

// The body a line hunts with at a level: its class, in its creation kit, and
// the kit's profile (unbuffed, day).
function creationBody(line, level) {
    const CCP = invoke('GameServer/Bot/Population/ColdCombatProfile');
    const classId = Generator.classFor(line, level);
    const bot = invoke('GameServer/Bot/AI/HuntCycle').referenceState(classId, level,
        { gear: invoke('GameServer/Bot/AI/BotGear'), profile: CCP, line: Generator.lineClassFor(line) });
    creationKit(classId)(bot);
    return { classId, profile: CCP.profileFor(bot, START, { store: false }) };
}

// The kit's stat point: the weapon's item attack (magical for a caster-weapon
// class, else physical) and the armour's item defence with its set bonus, the
// kit's raw sums before the level multiplier (ColdCombatProfile's kit part).
function pointOf(profile, classId) {
    const CCP = invoke('GameServer/Bot/Population/ColdCombatProfile');
    const Sets = invoke('GameServer/Items/C4ArmorSets');
    const sets = (profile.effects || []).filter(effect => effect.category === Sets.CATEGORY).map(effect => effect.stats);
    const gear = profile.equipment;
    return { attack: invoke('GameServer/Bot/AI/BotRoles').usesCasterWeaponCombat(classId) ? gear.mAtk : gear.pAtk,
        defence: Math.round(gear.pDef * CCP.statMultiplier(null, 'pDefMul', START, sets) + CCP.statAdd(null, 'pDefAdd', START, sets)) };
}

// The lines of the fresh world (cohort's rule).
function freshLines() {
    return Cohort.freshLines(Object.keys(Weights.CLASS_WEIGHTS), line => Generator.classFor(line, 1)).sort((a, b) => Number(a) - Number(b));
}

// The kit keys of a level: key -> { line, classId, point, lines }. Lines that
// share a key share its class and creation kit, so its point (thrown otherwise)
// and its weapon's speed and critical (one weapon type per key).
function keysAt(level, lines, onlyKeys) {
    const keys = new Map();
    for (const line of lines) {
        const key = Generator.botFor(line, level);
        if (onlyKeys && !onlyKeys.includes(key)) continue;
        const { classId, profile } = creationBody(line, level);
        const point = pointOf(profile, classId), speed = [profile.equipment.atkSpd, profile.equipment.critical].join('/');
        const held = keys.get(key);
        if (!held) { keys.set(key, { line, classId, point, speed, lines: [line] }); continue; }
        if (held.classId !== classId || held.point.attack !== point.attack || held.point.defence !== point.defence || held.speed !== speed) {
            throw new Error(`key ${key} L${level}: line ${line} (class ${classId}, point ${point.attack}/${point.defence}, speed/critical ${speed}) `
                + `differs from line ${held.line} (class ${held.classId}, point ${held.point.attack}/${held.point.defence}, ${held.speed})`);
        }
        held.lines.push(line);
    }
    return keys;
}

// Where a line's creation kit wields another weapon type than the best rung of
// its gear ladder (the snapshot's reading of the hunt tables' gear table,
// inputs.ladderRungs): the stat grid built later starts from the ladder's type there.
// [{ line, from, to, creation, ladder, types }] by line and level band.
function weaponTypes(lines, from, to) {
    const Mask = invoke('GameServer/Skills/WeaponMask'), Grades = require('../../src/GameServer/Bot/AI/GearGradeRule'), Inputs = require('./inputs');
    const Table = invoke('GameServer/Bot/AI/SpotValueTable');
    const gear = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/Bots/hunt/gear.json'), 'utf8'));
    const items = new Map(gear.items.map(row => [Number(row[0]), row]));
    const out = [];
    for (const line of lines) {
        let band = null;
        for (let level = from; level <= to; level++) {
            const creation = creationBody(line, level).profile.equipment.weaponKind || 'none';
            const ladder = Inputs.ladderRungs(gear, Table.roleClass(line, level), Grades.gradeForLevel(level), Grades);
            const rungs = (ladder?.weapon || []).map(selfId => items.get(selfId));
            const kinds = [...new Set(rungs.map(item => Mask.weaponType(item[2], item[3])))];
            const best = kinds[0] || 'none', types = kinds.join(',');
            if (band && band.creation === creation && band.ladder === best && band.types === types) band.to = level;
            else out.push(band = { line, from: level, to: level, creation, ladder: best, types });
        }
    }
    return out.filter(band => band.creation !== band.ladder);
}

// The table's combat inputs as they are now: the spot table generator's own
// (TableFingerprint 'spot': the hunt's code and data) and what this table adds
// (the creation kit, the lift and its limits row, this builder, the geodata
// release and the hunt tables' common code).
function stamp({ fightCover = LIMITS.FIGHT_COVER.value } = {}) {
    const TableFingerprint = invoke('GameServer/Bot/AI/TableFingerprint');
    return crypto.createHash('sha256').update(`${TableFingerprint.compute('spot').hash}\n${Boot.sourcesHash(STAMP_FILES)}\nfightCover ${fightCover}`).digest('hex').slice(0, 12);
}

// The server's spot catalogue, saved for the children; built on the geodata
// (the spot ids and floors of the server), refused without it.
function saveCatalogue(file) {
    process.env.L2_TABLES_GEODATA = 'required';
    const built = Generator.buildCatalogue();
    fs.writeFileSync(file, JSON.stringify({ spots: built.spots, profiles: built.profiles }));
    return file;
}

const taskKey = task => `${task.body}|${task.spotId}|${task.selfId}|${task.form}`;

function plan({ profiles, from, to, lines, onlyKeys, onlySpots }) {
    const tasks = [], bodies = {}, hunters = {}, spots = {}, pick = onlySpots ? profiles.filter(spot => onlySpots.includes(String(spot.id))) : profiles;
    for (let level = from; level <= to; level++) {
        for (const [key, held] of keysAt(level, lines, onlyKeys)) {
            const body = `${key}|${level}|${held.point.attack}/${held.point.defence}`;
            bodies[body] = { classId: held.classId, runSpd: null, reach: null, point: held.point };
            hunters[body] = { line: held.line, classId: held.classId, level };
            for (const spot of pick) {
                const species = speciesOf(spot), spotId = String(spot.id);
                const near = [...species].filter(([, one]) => one.level - level >= WINDOW[0] && one.level - level <= WINDOW[1]);
                if (!near.length) continue;
                spots[spotId] ||= { area: spot.spawnArea, density: spot.density, species: Object.fromEntries([...species].map(([selfId, one]) => [selfId, one])) };
                for (const [selfId] of near) for (const form of [0, 1]) tasks.push({ body, line: held.line, classId: held.classId, level, spotId, selfId, form });
            }
        }
    }
    for (const task of tasks) task.k = taskKey(task);
    return { tasks, bodies, hunters, spots };
}

// The combination check's whole-spot hunts (CHECK_SPOTS).
function checkTasks({ cells, spots, hunters, limit }) {
    const tasks = [];
    for (const [body, bySpot] of Object.entries(cells)) for (const form of [0, 1]) {
        let taken = 0;
        for (const [spotId, bySpecies] of Object.entries(bySpot)) {
            if (taken >= CHECK_SPOTS) break;
            const species = Object.keys(spots[spotId].species);
            if (species.length < 2 || HuntRows.admitted({ cells: bySpecies, form, fields: FIELDS, limit }).length !== species.length) continue;
            taken += 1;
            tasks.push({ body, ...hunters[body], spotId, selfId: 0, form });
        }
    }
    for (const task of tasks) task.k = taskKey(task);
    return tasks;
}

// A child: its share of the tasks (every n-th), one result line each, appended
// to its parts file as it comes.
function runChild([tasksFile, shard, n, partsFile, catalogueFile, hours]) {
    Generator.loadSimulation(catalogueFile);
    const profiles = new Map(JSON.parse(fs.readFileSync(catalogueFile, 'utf8')).profiles.map(spot => [String(spot.id), spot]));
    const tasks = JSON.parse(fs.readFileSync(tasksFile, 'utf8')).filter((task, index) => index % Number(n) === Number(shard));
    const out = fs.openSync(partsFile, 'a');
    Lift.lift(true);
    for (const task of tasks) {
        const spot = profiles.get(task.spotId), started = Date.now();
        const sum = Generator.hunt(task.selfId ? speciesSpot(spot, task.selfId) : spot, task.line, task.level, task.form, Number(hours),
            undefined, creationKit(task.classId), task.classId);
        fs.writeSync(out, `${JSON.stringify({ k: task.k, cell: cellOf(sum), runSpd: sum.runSpd, reach: sum.reach, ms: Date.now() - started })}\n`);
    }
    fs.closeSync(out);
    Lift.lift(false);
}

function runChildren({ dir, tasks, children, catalogueFile, hours, parts, prefix }) {
    const tasksFile = path.join(dir, 'tasks.json');
    fs.writeFileSync(tasksFile, JSON.stringify(tasks));
    const n = Math.max(1, Math.min(children, tasks.length));
    return Promise.all(Array.from({ length: n }, (_, shard) => new Promise((resolve, reject) => {
        const child = childProcess.fork(__filename, ['child', tasksFile, String(shard), String(n), path.join(parts, `${prefix}-${shard}.jsonl`), catalogueFile, String(hours)],
            { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
        child.on('error', reject);
        child.on('exit', code => code === 0 ? resolve() : reject(new Error(`hunt table child ${shard} exited ${code}`)));
    })));
}

// The results in the parts directory under this stamp: key -> result; cut:
// lines a stopped child left unfinished (counted, their hunts run again).
function doneResults(parts, stamp) {
    const done = new Map();
    let cut = 0;
    if (!fs.existsSync(parts)) return { done, cut };
    for (const file of fs.readdirSync(parts).filter(name => name.startsWith(`${stamp}-`)).sort()) {
        for (const line of fs.readFileSync(path.join(parts, file), 'utf8').split('\n')) {
            if (!line) continue;
            try {
                const result = JSON.parse(line);
                done.set(result.k, result);
            } catch {
                cut += 1;
            }
        }
    }
    return { done, cut };
}

// The parts directory serves a build only when it was made under the same
// stamp, hours and catalogue (the hunts' inputs not in the stamp): its meta file
// says so; any other parts are removed and the build starts clean.
function prepareParts(parts, meta, log) {
    const metaFile = path.join(parts, 'meta.json'), want = JSON.stringify(meta);
    let held = null;
    try { held = fs.readFileSync(metaFile, 'utf8'); } catch (error) { held = null; }
    if (held !== want) {
        if (fs.existsSync(parts) && fs.readdirSync(parts).length) log(`parts ${path.relative(ROOT, parts)} were made under other inputs: cleared`);
        fs.rmSync(parts, { recursive: true, force: true });
    }
    fs.mkdirSync(parts, { recursive: true });
    fs.writeFileSync(metaFile, want);
}

const quantile = (values, q) => values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(q * values.length))] : null;

async function build({ from, to, hours = 2, children = 7, spots: onlySpots = null, keys: onlyKeys = null, catalogue = null, out = null,
    shard = null, join = false, log = console.log }) {
    if ((onlySpots || onlyKeys || catalogue) && !out) throw new Error('a pick of spots or keys, or a given catalogue, is not the table: name its --out');
    const limit = LIMITS.KILL_DEATH_LIMIT.value;
    const started = Date.now(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hunt-table-'));
    try {
        const catalogueFile = catalogue || saveCatalogue(path.join(dir, 'catalogue.json'));
        Generator.loadSimulation(catalogueFile);
        const profiles = JSON.parse(fs.readFileSync(catalogueFile, 'utf8')).profiles;
        const canary = Lift.checkLift(Generator, profiles.find(spot => String(spot.id) === Lift.CANARY.spotId));
        log(`lift canary ${Lift.CANARY.spotId}: kills ${canary.gated} gated, ${canary.lifted} lifted`);
        const lines = freshLines();
        for (const band of weaponTypes(lines, from, to)) {
            log(`weapon type: line ${band.line} L${band.from}-${band.to} creation kit ${band.creation}, gear ladder ${band.ladder} (rungs ${band.types || 'none'})`);
        }
        const { tasks, bodies, hunters, spots } = plan({ profiles, from, to, lines, onlyKeys, onlySpots });
        const before = stamp(), file = out || path.join(ROOT, 'tmp/economy-model/hunt', `hunt-${from}-${to}-${before}.json`), parts = `${file}.parts`;
        prepareParts(parts, { stamp: before, hours, catalogue: catalogue ? crypto.createHash('sha256').update(fs.readFileSync(catalogue)).digest('hex') : 'geodata' }, log);
        log(`levels ${from}-${to}: bodies ${Object.keys(bodies).length}, spots ${Object.keys(spots).length}, hunts ${tasks.length} on ${children} children, stamp ${before}`);
        // A shard's parts are named by its number: two machines can share a pid.
        const hunted = async (list, round) => {
            const first = doneResults(parts, before), missing = list.filter(task => !first.done.has(task.k)).length;
            const todo = list.filter((task, index) => !first.done.has(task.k) && (!shard || index % shard.n === shard.i - 1));
            log(`round ${round}: ${list.length - missing} hunts already in ${path.relative(ROOT, parts)} (${first.cut} cut lines), ${todo.length} to run`
                + (shard ? ` (share ${shard.i}/${shard.n})` : ''));
            if (shard && missing) {
                if (todo.length) await runChildren({ dir, tasks: todo, children, catalogueFile, hours, parts, prefix: `${before}-${round}-s${shard.i}` });
                return null;
            }
            if (join && missing) throw new Error(`hunt table round ${round}: ${missing} hunts without a result (--join runs none)`);
            if (todo.length) await runChildren({ dir, tasks: todo, children, catalogueFile, hours, parts, prefix: `${before}-${round}-${process.pid}` });
            const { done } = doneResults(parts, before), results = list.map(task => done.get(task.k));
            if (results.some(result => !result)) throw new Error(`hunt table round ${round}: ${results.filter(result => !result).length} hunts without a result`);
            results.forEach((result, index) => {
                const body = bodies[list[index].body];
                if (body.runSpd === null) Object.assign(body, { runSpd: result.runSpd, reach: result.reach });
                else if (body.runSpd !== result.runSpd || body.reach !== result.reach) throw new Error(`body ${list[index].body}: run speed or reach differs between its hunts`);
            });
            return results;
        };
        const results = await hunted(tasks, 'species'), cells = {};
        if (!results) return { file: null };
        results.forEach((result, index) => {
            const task = tasks[index];
            const held = ((cells[task.body] ||= {})[task.spotId] ||= {})[task.selfId] ||= [null, null];
            held[task.form] = result.cell;
        });
        const wholeTasks = checkTasks({ cells, spots, hunters, limit });
        const wholeResults = await hunted(wholeTasks, 'check');
        if (shard) return { file: null };
        const whole = wholeResults.map((result, index) => ({ task: wholeTasks[index], cell: result.cell }));
        const after = stamp();
        if (after !== before) throw new Error(`the combat inputs changed during the build (stamp ${before} -> ${after}): not written`);
        const table = { stamp: before, range: [from, to], window: WINDOW, hours, restRule: REST_RULE, point: { fields: POINT_FIELDS },
            fields: FIELDS, forms: FORMS, bodies, spots, cells };
        fs.writeFileSync(file, JSON.stringify(table));
        fs.rmSync(parts, { recursive: true, force: true });
        const check = summary({ table, whole, results: [...results, ...wholeResults], limit, log });
        log(`wrote ${path.relative(ROOT, file)} (${(fs.statSync(file).size / 1e6).toFixed(1)} MB) in ${Math.round((Date.now() - started) / 1000)} s`);
        return { file, table, check };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

// The build's prints: hunts and their time, the cells over the kill-death
// limit, without a kill and bound by their species' production, the rest
// share per key and level, and the combination check (the whole spot hunted
// against the reader's combination over its species).
function summary({ table, whole, results, limit, log }) {
    const BR = invoke('GameServer/Bot/Population/BackgroundResolver');
    const ms = results.reduce((sum, result) => sum + result.ms, 0);
    log(`hunts ${results.length}, ${(ms / Math.max(1, results.length)).toFixed(0)} ms a hunt (child time)`);
    let over = 0, none = 0, all = 0;
    const bound = [];
    for (const [body, bySpot] of Object.entries(table.cells)) {
        const rest = [];
        for (const [spotId, bySpecies] of Object.entries(bySpot)) for (const [selfId, forms] of Object.entries(bySpecies)) for (const [form, cell] of forms.entries()) {
            all += 1;
            if (!(cell[0] > 0)) { none += 1; continue; }
            if (cell[1] > limit) over += 1;
            const production = table.spots[spotId].species[selfId].production;
            if (production !== null && cell[0] >= 0.95 * production) bound.push(`${body} ${spotId} ${selfId} ${FORMS[form]} ${cell[0]}/${production}`);
            rest.push(cell[3] * cell[0] / 3600);
        }
        log(`rest share ${body}: p50 ${quantile(rest, 0.5)?.toFixed(3)} p90 ${quantile(rest, 0.9)?.toFixed(3)} (${rest.length} cells with kills)`);
    }
    log(`cells ${all}: deaths a kill over ${limit} ${over}, without a kill ${none}, at >= 95 % of their species' production ${bound.length}${bound.length ? ` (${bound.slice(0, 5).join('; ')})` : ''}`);
    const check = [];
    for (const { task, cell } of whole) {
        const spot = table.spots[task.spotId], cells = table.cells[task.body]?.[task.spotId] || {};
        const admitted = Object.keys(spot.species);
        const read = HuntRows.combine({ spot, cells, body: table.bodies[task.body], form: task.form, fields: table.fields, admitted, walkMs: BR.soloWalkMs });
        const row = { body: task.body, spotId: task.spotId, form: FORMS[task.form], species: admitted.length,
            measured: { kills: cell[0], deaths: cell[1] }, combined: read && { kills: round(read.kills), deaths: round(read.deaths) } };
        check.push(row);
        log(`check ${row.body} ${row.spotId} ${row.form}: species ${row.species}, whole kills/h ${row.measured.kills} deaths/kill ${row.measured.deaths}`
            + ` | combined ${read ? `${row.combined.kills} ${row.combined.deaths}` : 'none'}`);
    }
    const ratios = check.filter(row => row.combined && row.measured.kills > 0).map(row => row.combined.kills / row.measured.kills);
    log(`combination check: ${check.length} spot forms, combined/whole kills p10 ${quantile(ratios, 0.1)?.toFixed(2)} p50 ${quantile(ratios, 0.5)?.toFixed(2)} p90 ${quantile(ratios, 0.9)?.toFixed(2)}`);
    return check;
}

if (require.main === module) {
    const argv = process.argv.slice(2);
    if (argv[0] === 'child') {
        runChild(argv.slice(1));
        process.exit(0);
    }
    const [from, to] = String(Boot.option(argv, 'levels', '1-19')).split('-').map(Number);
    const list = name => Boot.option(argv, name, null)?.split(',') || null;
    const shardArg = Boot.option(argv, 'shard', null);
    const [i, n] = String(shardArg ?? '').split('/').map(Number);
    if (shardArg !== null && !(i >= 1 && n >= 1 && i <= n)) {
        console.error(`--shard needs i/N with 1 <= i <= N, got "${shardArg}"`);
        process.exit(1);
    }
    build({ from, to: to || from, hours: Number(Boot.option(argv, 'hours', 2)), children: Number(Boot.option(argv, 'children', 7)),
        spots: list('spots'), keys: list('keys'), catalogue: Boot.option(argv, 'catalogue', null), out: Boot.option(argv, 'out', null),
        shard: n ? { i, n } : null, join: argv.includes('--join') })
        .catch(error => { console.error(error.stack || error); process.exit(1); });
}

module.exports = { build, stamp, cellOf, FIELDS, FORMS, WINDOW, POINT_FIELDS };
