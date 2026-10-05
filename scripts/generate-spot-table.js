#!/usr/bin/env node
'use strict';

// The world spot table (market-sim step 3.3(c), N44): what an hour of solo
// hunting on each spot gives each bot role, measured offline with the
// author's cold combat (BackgroundResolver.resolveSolo) on the world's own
// spot catalogue. Read at run time by GameServer/Bot/AI/SpotValueTable.
//
// Usage: node scripts/generate-spot-table.js [--jobs=4] [--hours=2] [--curve-hours=1]
//        [--out=data/Bots/spot-table.json] [--spots=N]   (N: first N spots only, for tests)
//
// Layout (factored, so the file stays small):
// - one row per spot x role x shots (on/off): the bot of the role, in the
//   author's kit for its level (BotGear), hunting the spot alone at a
//   reference level (spot level + REF_GAP, or higher when the role finds no
//   safe target there). The row keeps the kills per hour the fights allow and,
//   per kill, the busy time (combat and recovery, as the bots' own records
//   count it), deaths, exp, SP, adena, loot at the NPC buy-back, shots and
//   potions used;
// - per spot the kills per hour its monster count allows (the author's
//   fights per hunt cycle), so the table returns min(fights allow, spot allows);
// - per role and spot level band a level-gap curve: how each of those values
//   changes with the bot's level over the spot's level, measured on a few
//   spots of the band. The curve carries the kit grade steps of the band and
//   the author's deep-blue drop rule; the C4 exp penalty (E11) is not in the
//   author's combat and is not in the curve.
// Everything is at rate x1: the reader applies the server's rates (for loot
// with the spot's measured response to drop rates 10 and 50).
//
// Deterministic: every run is seeded from its spot, role, shots and level;
// the spot catalogue is spawned with a seeded Math.random. The output does
// not depend on --jobs.

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
process.chdir(root);
process.env.L2NODE_CONFIG_FILE = path.join(root, 'config', 'default.ini');
delete process.env.L2NODE_SHARED_CONFIG_FILE;
process.env.L2NODE_PROGRESSION_RATE = 'x1';

const SCHEMA_VERSION = 1;
const CATALOGUE_SEED = 20261005;
const PERIOD_MODE = 'day';
const MAX_LEVEL = 78;
const REF_GAP = 6;
const GAPS = [-4, -2, 0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20];
const BAND_LEVELS = 2;
const CURVE_SPOTS = 3;
// A density no spot reaches: the fights of a cycle are then limited only by
// the cycle's time, so a row measures what the bot's own speed allows.
const UNLIMITED_DENSITY = 300;
// Kit and skills of a role at a level: the class of the role's profession
// stage (below 20, 20-39, 40+). Roles with no class below 20 use their first
// profession there; such rows only serve higher bots on low spots.
const ROLE_CLASSES = {
    dps: [0, 1, 2],
    mage: [10, 11, 12],
    tank: [4, 4, 5],
    dagger: [7, 7, 8],
    archer: [22, 22, 9],
    healer: [15, 15, 16],
    buffer: [49, 50, 17],
    spoiler: [53, 54, 55]
};
const ROLES = Object.keys(ROLE_CLASSES);
const SHOTS = [1, 0];
const ROW_FIELDS = ['minGap', 'refGap', 'kph', 'busy', 'deaths', 'exp', 'sp', 'adena', 'loot', 'shots', 'potions'];
// Loot has no curve of its own: one rare drop in an hour of a curve spot
// would swing it; it follows the adena curve (same drop groups, same
// deep-blue rule, same monsters).
const CURVE_FIELDS = ['kph', 'busy', 'deaths', 'exp', 'adena'];
const START = 1_750_000_000_000;

function args() {
    const out = { jobs: Math.max(1, Math.min(6, os.cpus().length - 2)), hours: 2, curveHours: 1,
        out: path.join(root, 'data', 'Bots', 'spot-table.json'), spots: 0, child: null };
    for (const arg of process.argv.slice(2)) {
        const [key, value] = arg.replace(/^--/, '').split('=');
        if (key === 'jobs') out.jobs = Math.max(1, Number(value));
        else if (key === 'hours') out.hours = Number(value);
        else if (key === 'curve-hours') out.curveHours = Number(value);
        else if (key === 'out') out.out = path.resolve(value);
        else if (key === 'spots') out.spots = Number(value);
        else if (key === 'child') out.child = value;
        else throw new Error(`unknown argument ${arg}`);
    }
    return out;
}

function hash(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    return h >>> 0;
}

function mulberry(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function round(value) {
    if (!Number.isFinite(value)) throw new Error(`non-finite value ${value}`);
    return value === 0 ? 0 : Number(value.toPrecision(4));
}

function classFor(role, level) {
    const classes = ROLE_CLASSES[role];
    return classes[level < 20 ? 0 : level < 40 ? 1 : 2];
}

function bandOf(level) {
    return Math.floor(level / BAND_LEVELS);
}

// ---------------------------------------------------------------- catalogue

// The spots the server builds at start (SpotService over the spawned world),
// from a world spawned here with a seeded Math.random.
function buildCatalogue() {
    require('../src/Global');
    invoke('GameServer/DataCache').init();
    const random = Math.random;
    Math.random = mulberry(CATALOGUE_SEED);
    const World = invoke('GameServer/World/World');
    const world = {
        user: { sessions: [] },
        npc: { spawns: [], grid: {}, nextId: 1000000, periodMode: PERIOD_MODE, periodRevision: 0, periodDefinitions: [],
            raidBossRespawnTimers: new Map(), raidBossState: new Map(), gridKeys: new WeakMap() },
        items: { spawns: [], nextId: 5000000 },
        addNpcToGrid() {},
        indexSpawnsInGrid() {}
    };
    invoke('GameServer/World/Generics/SpawnNpcs').call(world);
    World.npc = world.npc;
    World.user = world.user;
    const SpotService = invoke('GameServer/Bot/AI/SpotService');
    const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
    SpotService.reset();
    SpotProfiles.reset();
    const profiles = SpotProfiles.ensure();
    Math.random = random;
    return { spots: SpotService.spots, profiles, spawned: world.npc.spawns.length };
}

// ---------------------------------------------------------------- simulation (child)

let sim = null;
function loadSimulation(catalogueFile) {
    require('../src/Global');
    invoke('GameServer/DataCache').init();
    const saved = JSON.parse(fs.readFileSync(catalogueFile, 'utf8'));
    invoke('GameServer/Bot/AI/SpotService').spots = saved.spots;
    invoke('GameServer/Bot/Population/SpotProfiles').cache = saved.profiles;
    sim = {
        profiles: new Map(saved.profiles.map((spot) => [spot.id, spot])),
        BR: invoke('GameServer/Bot/Population/BackgroundResolver'),
        CCP: invoke('GameServer/Bot/Population/ColdCombatProfile'),
        BotGear: invoke('GameServer/Bot/AI/BotGear'),
        ShotStock: invoke('GameServer/Inventory/ShotStock'),
        Potions: invoke('GameServer/Bot/AI/HealingPotionStock'),
        HuntEfficiency: invoke('GameServer/Bot/AI/BotHuntEfficiency')
    };
}

// A bot of the class and level in the author's kit for that level (BotGear),
// with the shots of its weapon (or none) and the healing potions the author's
// restock buys at that level, both never running out.
function newBot(classId, level, shots) {
    const inventory = {};
    for (const entry of sim.BotGear.planFor({ classId, level }).items) {
        const key = `kit-${entry.selfId}`;
        const prior = inventory[key];
        const amount = (prior?.amount || 0) + 1;
        inventory[key] = { selfId: Number(entry.selfId), amount, equipped: true, equippedCount: amount,
            equippedSlots: [...(prior?.equippedSlots || []), Number(entry.slot)], slot: Number(entry.slot) };
    }
    const bot = { characterId: 990001, name: 'SpotTable', classId, level, activity: 'hunting', phase: 'cold',
        vitals: {}, stats: { classId }, inventory };
    let shotId = 0;
    if (shots) {
        const plan = sim.ShotStock.planForState(bot);
        if (plan.selfId && plan.perAction > 0) {
            shotId = Number(plan.selfId);
            inventory[String(shotId)] = { selfId: shotId, amount: 1e9 };
        }
    }
    const potion = sim.Potions.purchasePotionFor({ level });
    if (potion?.selfId) inventory[String(potion.selfId)] = { selfId: Number(potion.selfId), amount: 1e9 };
    const profile = sim.CCP.profileFor(bot, START);
    bot.vitals = { hp: profile.maxHp, maxHp: profile.maxHp, mp: profile.maxMp, maxMp: profile.maxMp };
    return { bot, shotId, full: { ...bot.vitals } };
}

function atSpot(spot) {
    return { ...spot, density: UNLIMITED_DENSITY };
}

// One resolve at full health: does the bot find a target it may fight alone?
function canHunt(spot, role, level, shots) {
    const { bot } = newBot(classFor(role, level), level, shots);
    bot.spotId = spot.id;
    bot.loc = { ...spot.center };
    const random = Math.random;
    Math.random = mulberry(hash(`${spot.id}|${role}|${shots}|${level}|probe`));
    try {
        const result = sim.BR.resolveSolo({ state: bot, spot: atSpot(spot), elapsedMs: 60000, timestamp: START,
            rng: mulberry(hash(`${spot.id}|${role}|${level}|probe`)) });
        return Number(result.debug?.attemptedFights || 0) > 0 || Number(result.debug?.wins || 0) > 0;
    } finally {
        Math.random = random;
    }
}

// The author's cold combat for `hours` of game time. A death is counted and
// the bot stands up at full health at once: the time a death costs belongs to
// the price of death (step 3.5), not to the spot.
function hunt(spot, role, level, shots, hours) {
    const classId = classFor(role, level);
    const seed = hash(`${spot.id}|${role}|${shots}|${level}`);
    const rng = mulberry(seed);
    const random = Math.random;
    Math.random = mulberry(seed ^ 0x9e3779b9);
    const sum = { kills: 0, busyMs: 0, deaths: 0, exp: 0, sp: 0, adena: 0, loot: 0, shots: 0, potions: 0 };
    try {
        const made = newBot(classId, level, shots);
        let state = { ...made.bot, spotId: spot.id, loc: { ...spot.center } };
        const target = atSpot(spot);
        let t = START;
        const end = START + hours * 3600000;
        let elapsed = 60000;
        while (t < end) {
            const result = sim.BR.resolveSolo({ state, spot: target, elapsedMs: elapsed, timestamp: t, rng });
            const gained = result.materialize || {};
            const debug = result.debug || {};
            const patch = result.patch || {};
            sum.kills += Number(debug.wins || 0);
            sum.exp += Number(gained.exp || 0);
            sum.sp += Number(gained.sp || 0);
            sum.adena += Number(gained.adena || 0);
            sum.loot += sim.HuntEfficiency.lootValue(gained.items || []);
            sum.potions += Number(debug.potionsUsed || 0);
            // The bots' records count a cycle's combat and the rest it calls for.
            if (Number.isFinite(debug.combatMs)) {
                sum.busyMs += Number(debug.combatMs) + Math.max(0, Number(patch.stats?.restUntil || t) - t);
            }
            const inventory = patch.inventory || state.inventory;
            state = { ...state, ...patch, vitals: { ...state.vitals, ...(patch.vitals || {}) },
                stats: { ...(patch.stats || state.stats), classId }, inventory };
            if (debug.died || state.activity === 'dead') {
                sum.deaths += 1;
                state = { ...state, activity: 'hunting', vitals: { ...made.full },
                    stats: { ...state.stats, pveEncounter: null, restUntil: null } };
            }
            if (state.activity !== 'hunting' && state.activity !== 'resting') {
                throw new Error(`spot ${spot.id} ${role} L${level}: unexpected activity ${state.activity}`);
            }
            const next = Math.max(t + 1000, Number(result.nextResolveAt) || t + 30000);
            elapsed = next - t;
            t = next;
        }
        if (made.shotId) sum.shots = 1e9 - Number(state.inventory[String(made.shotId)]?.amount || 0);
    } finally {
        Math.random = random;
    }
    return sum;
}

function perKill(sum, hours) {
    if (sum.kills <= 0) return null;
    const k = sum.kills;
    return { kph: k / hours, busy: sum.busyMs / 1000 / k, deaths: sum.deaths / k, exp: sum.exp / k, sp: sum.sp / k,
        adena: sum.adena / k, loot: sum.loot / k, shots: sum.shots / k, potions: sum.potions / k };
}

// A row: the lowest level gap at which the role finds a safe target, then the
// hunt at the reference gap (or that lowest gap when it is higher).
function rowTask({ spotId, hours }) {
    const spot = sim.profiles.get(spotId);
    const level = Number(spot.avgLevel);
    const rows = [];
    for (const role of ROLES) {
        for (const shots of SHOTS) {
            let minGap = null;
            for (let gap = GAPS[0]; gap <= GAPS[GAPS.length - 1]; gap++) {
                const botLevel = level + gap;
                if (botLevel < 1) continue;
                if (botLevel > MAX_LEVEL) break;
                if (canHunt(spot, role, botLevel, shots)) { minGap = gap; break; }
            }
            if (minGap === null) { rows.push(null); continue; }
            const refLevel = Math.min(MAX_LEVEL, level + Math.max(REF_GAP, minGap));
            const measured = perKill(hunt(spot, role, refLevel, shots, hours), hours);
            rows.push(measured ? { minGap, refGap: refLevel - level, ...measured } : null);
        }
    }
    return rows;
}

// A curve point: the role on one spot at one gap, shots on.
function curveTask({ spotId, role, gap, hours }) {
    const spot = sim.profiles.get(spotId);
    const level = Number(spot.avgLevel) + gap;
    if (level < 1 || level > MAX_LEVEL) return null;
    if (!canHunt(spot, role, level, 1)) return null;
    return perKill(hunt(spot, role, level, 1, hours), hours);
}

function runChild(catalogueFile) {
    loadSimulation(catalogueFile);
    process.on('message', (message) => {
        if (message.type === 'stop') process.exit(0);
        const result = message.kind === 'row' ? rowTask(message) : curveTask(message);
        process.send({ id: message.id, result });
    });
    process.send({ ready: true });
}

// ---------------------------------------------------------------- parent

function runPool(catalogueFile, tasks, jobs) {
    return new Promise((resolve, reject) => {
        const results = new Array(tasks.length);
        let next = 0;
        let done = 0;
        let alive = 0;
        const workers = [];
        const startAt = Date.now();
        const feed = (worker) => {
            if (next >= tasks.length) { worker.send({ type: 'stop' }); return; }
            worker.send({ ...tasks[next], id: next });
            next += 1;
        };
        for (let i = 0; i < Math.min(jobs, tasks.length); i++) {
            const worker = childProcess.fork(__filename, [`--child=${catalogueFile}`], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
            alive += 1;
            workers.push(worker);
            worker.on('message', (message) => {
                if (message.ready) { feed(worker); return; }
                results[message.id] = message.result;
                done += 1;
                if (done % 200 === 0 || done === tasks.length) {
                    process.stderr.write(`  ${done}/${tasks.length} tasks, ${Math.round((Date.now() - startAt) / 1000)} s\n`);
                }
                feed(worker);
            });
            worker.on('exit', (code) => {
                alive -= 1;
                if (code !== 0) reject(new Error(`worker exited with ${code}`));
                else if (alive === 0) {
                    if (done !== tasks.length) reject(new Error(`only ${done} of ${tasks.length} tasks done`));
                    else resolve(results);
                }
            });
        }
    });
}

// Loot is the noisiest value: a rare drop worth thousands lands a few times
// in hours. The roles' kills of one spot at one level come from the same
// monsters, so the rows of the roles that do not spoil share their loot per
// kill (weighted by kills); the spoiler keeps its own (its spoil).
function poolRowLoot(rows) {
    const groups = new Map();
    rows.forEach((row, index) => {
        if (!row || ROLES[Math.floor(index / SHOTS.length)] === 'spoiler') return;
        if (!groups.has(row.refGap)) groups.set(row.refGap, []);
        groups.get(row.refGap).push(row);
    });
    for (const group of groups.values()) {
        const kills = group.reduce((sum, row) => sum + row.kph, 0);
        const loot = group.reduce((sum, row) => sum + row.loot * row.kph, 0) / kills;
        for (const row of group) row.loot = loot;
    }
    return rows;
}

function packRow(row) {
    return row ? ROW_FIELDS.map((field) => round(row[field])) : null;
}

// Per role and band: for each gap the sum over the band's curve spots of the
// value at that gap over their sum at REF_GAP, on the spots that hunt at both
// (deaths per kill as the mean difference instead: a spot without deaths at
// the reference still shows the deaths of a lower level).
function curveFor(points) {
    const refIndex = GAPS.indexOf(REF_GAP);
    const out = {};
    for (const field of CURVE_FIELDS) {
        out[field] = GAPS.map((gap, index) => {
            let at = 0;
            let ref = 0;
            let count = 0;
            for (const spot of points) {
                if (!spot[refIndex] || !spot[index]) continue;
                at += spot[index][field];
                ref += spot[refIndex][field];
                count += 1;
            }
            if (!count) return null;
            if (field === 'deaths') return round((at - ref) / count);
            return ref > 0 ? round(at / ref) : null;
        });
    }
    return out;
}

// Drops do not grow in proportion to the rate: a group's chance stops at
// 100% and then only one of its items drops (the author's rewardGroupRoll and
// selectDropItem). Per spot, the expected loot per kill at drop rate 10 and 50
// over rate x the loot at rate 1, from the author's itemDropYield over the
// spot's monsters (spawn weights, killer at the reference gap).
function lootRateResponse(spot) {
    const ItemTemplateIndex = require('../src/GameServer/Item/ItemTemplateIndex');
    const DataCache = invoke('GameServer/DataCache');
    const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
    const NpcSellRules = invoke('GameServer/Items/NpcSellRules');
    const lootAt = (preset) => {
        process.env.L2NODE_PROGRESSION_RATE = preset;
        let value = 0;
        for (const entry of spot.npcEntries || []) {
            const reward = ItemTemplateIndex.find(DataCache.npcRewards, entry.selfId);
            if (!reward) continue;
            const npcLevel = Number(ItemTemplateIndex.find(DataCache.npcs, entry.selfId)?.template?.level || spot.avgLevel);
            const context = { npcLevel, killerLevel: Math.min(MAX_LEVEL, Number(spot.avgLevel) + REF_GAP) };
            const ids = new Set((reward.rewards || []).flatMap((group) => (group.items || []).map((item) => Number(item.selfId))));
            for (const id of ids) {
                if (id === 57) continue;
                const price = Number(ItemTemplateIndex.find(DataCache.items, id)?.template?.price || 0);
                value += Number(entry.count || 1) * Planner.itemDropYield(reward, id, 'drop', context).expectedYield
                    * NpcSellRules.npcBuyPrice(price);
            }
        }
        return value;
    };
    const x1 = lootAt('x1');
    const out = x1 > 0 ? [round(lootAt('x10') / (10 * x1)), round(lootAt('x50') / (50 * x1))] : [1, 1];
    process.env.L2NODE_PROGRESSION_RATE = 'x1';
    return out;
}

function gitRevision() {
    try {
        const head = childProcess.execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim();
        const dirty = childProcess.execSync('git status --porcelain -- src data/Npcs data/Items data/Skills data/Templates', { cwd: root })
            .toString().trim() !== '';
        return dirty ? `${head}+local` : head;
    } catch (_) {
        return 'unknown';
    }
}

async function main() {
    const options = args();
    if (options.child) return runChild(options.child);
    const started = Date.now();
    const revision = gitRevision();
    const catalogue = buildCatalogue();
    let spots = catalogue.profiles.filter((spot) => spot.raidBoss !== true)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const catalogueSpots = spots.length;
    if (options.spots > 0) spots = spots.slice(0, options.spots);
    const catalogueFile = path.join(os.tmpdir(), `spot-table-catalogue-${process.pid}.json`);
    fs.writeFileSync(catalogueFile, JSON.stringify({ spots: catalogue.spots, profiles: catalogue.profiles }));
    process.stderr.write(`catalogue: ${catalogue.spawned} spawns, ${catalogueSpots} hunting spots, ${Math.round((Date.now() - started) / 1000)} s\n`);

    try {
        // Rows.
        const rowTasks = spots.map((spot) => ({ kind: 'row', spotId: spot.id, hours: options.hours }));
        const rowResults = await runPool(catalogueFile, rowTasks, options.jobs);
        if (rowResults.length !== spots.length || rowResults.some((rows) => rows.length !== ROLES.length * SHOTS.length)) {
            throw new Error('row results do not match the spots');
        }

        // Curve spots: per role and band, up to CURVE_SPOTS spots of the band
        // where the role hunts at the reference gap, in a fixed hashed order.
        const curveSpots = new Map();
        spots.forEach((spot, index) => {
            ROLES.forEach((role, roleIndex) => {
                const row = rowResults[index][roleIndex * SHOTS.length];
                if (!row || row.refGap !== REF_GAP) return;
                const key = `${role}|${bandOf(Number(spot.avgLevel))}`;
                if (!curveSpots.has(key)) curveSpots.set(key, []);
                curveSpots.get(key).push(spot.id);
            });
        });
        const curveTasks = [];
        for (const [key, ids] of curveSpots) {
            const [role] = key.split('|');
            const chosen = ids.sort((a, b) => hash(`${a}|${role}`) - hash(`${b}|${role}`)).slice(0, CURVE_SPOTS);
            curveSpots.set(key, chosen);
            for (const spotId of chosen) for (const gap of GAPS) curveTasks.push({ kind: 'curve', key, spotId, role, gap, hours: options.curveHours });
        }
        const curveResults = await runPool(catalogueFile, curveTasks, options.jobs);

        const curveResult = new Map(curveTasks.map((task, index) => [`${task.key}|${task.spotId}|${task.gap}`, curveResults[index]]));
        const curves = {};
        let curveCount = 0;
        for (const [key, ids] of [...curveSpots].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
            const [role, band] = key.split('|');
            const points = ids.map((spotId) => GAPS.map((gap) => curveResult.get(`${key}|${spotId}|${gap}`)));
            curves[role] = curves[role] || {};
            curves[role][band] = curveFor(points);
            curveCount += 1;
        }

        const BR = invoke('GameServer/Bot/Population/BackgroundResolver');
        // Kills per hour a spot's monster count allows: the author's fights per
        // hunt cycle over the author's cycle lengths.
        const spotCap = (spot) => {
            let fights = 0;
            let ms = 0;
            for (let i = 0; i < 1000; i++) {
                const delay = BR.huntCycleDelayMs((i + 0.5) / 1000);
                fights += BR.soloFightCount(spot, delay);
                ms += delay;
            }
            return fights / ms * 3600000;
        };
        const table = {
            header: {
                schema: SCHEMA_VERSION,
                generator: 'scripts/generate-spot-table.js',
                revision,
                inputs: { hours: options.hours, curveHours: options.curveHours, catalogueSeed: CATALOGUE_SEED,
                    periodMode: PERIOD_MODE, rate: 'x1', maxLevel: MAX_LEVEL, refGap: REF_GAP, bandLevels: BAND_LEVELS,
                    curveSpots: CURVE_SPOTS, unlimitedDensity: UNLIMITED_DENSITY, roleClasses: ROLE_CLASSES,
                    spotLimit: options.spots || null },
                counts: { catalogueSpots, spots: spots.length, rows: spots.length * ROLES.length * SHOTS.length,
                    huntableRows: rowResults.flat().filter(Boolean).length, curves: curveCount,
                    simulatedHours: rowResults.flat().filter(Boolean).length * options.hours
                        + curveResults.filter(Boolean).length * options.curveHours }
            },
            roles: ROLES,
            shots: SHOTS,
            gaps: GAPS,
            rowFields: ROW_FIELDS,
            curveFields: CURVE_FIELDS,
            // [id, level, density, kills per hour the spot allows, monsters per pull,
            //  loot at drop rate 10 and 50 over rate x loot at rate 1]
            spots: spots.map((spot) => [spot.id, Number(spot.avgLevel), Number(spot.density), round(spotCap(spot)), 1,
                ...lootRateResponse(spot)]),
            rows: rowResults.map((rows) => poolRowLoot(rows).map(packRow)),
            curves
        };
        if (table.rows.length !== table.spots.length) throw new Error('rows and spots differ');
        fs.mkdirSync(path.dirname(options.out), { recursive: true });
        const text = `${JSON.stringify(table)}\n`;
        fs.writeFileSync(options.out, text);
        process.stderr.write(`wrote ${path.relative(root, options.out)}: ${spots.length} spots, ${table.header.counts.huntableRows} huntable rows, `
            + `${curveCount} curves, ${(text.length / 1024).toFixed(0)} KB, ${Math.round((Date.now() - started) / 1000)} s\n`);
    } finally {
        fs.rmSync(catalogueFile, { force: true });
    }
    process.exit(0);
}

main().catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exit(1);
});
