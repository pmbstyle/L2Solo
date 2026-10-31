#!/usr/bin/env node
'use strict';

// The world spot table (market-sim step 3.3(c), N44): what an hour of solo
// hunting on each spot gives each bot role, measured offline with the
// author's cold combat (BackgroundResolver.resolveSolo) on the world's own
// spot catalogue. Read at run time by GameServer/Bot/AI/SpotValueTable.
//
// Usage: node scripts/generate-spot-table.js [--jobs=4] [--hours=2] [--curve-hours=1]
//        [--out=data/Bots/spot-table.json] [--spots=N]   (N: first N spots only, for tests)
//        --merge-stacks-from=old.json --stacks-table=measured.json [--out=...]
//        [--phase=rows|curves|merge --shard=i/n --parts=dir]   (split runs, .github/workflows/tables.yml)
//
// Split runs: phase rows measures the i-th of n shares of the spots' rows into
// --out; phase curves reads every rows part of --parts and measures its share
// of the curves; phase merge reads all parts and writes the table. Each share
// takes every n-th task, so the parts give the very table one run gives.
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
//   curve: the reader applies it, so the measurement takes it out of combat.
// Everything is at rate x1: the reader applies the server's rates (for loot
// with the spot's measured response to drop rates 10 and 50).
//
// Deterministic: every run is seeded from its spot, role, shots and level;
// the spot catalogue is the server's own (SpawnNpcs.catalogueSpawns: each
// spawn definition at its seeded point, a territory's on the geodata ground,
// so run with the server's geodata: npm run geodata; header inputs.geodata
// names its profile). The output does not depend on --jobs.

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ProgressionRates = require('../src/GameServer/ProgressionRates');
const HuntKeys = require('./hunt-tables/common');

const root = path.resolve(__dirname, '..');
process.chdir(root);
process.env.L2NODE_CONFIG_FILE = path.join(root, 'config', 'default.ini');
delete process.env.L2NODE_SHARED_CONFIG_FILE;
process.env.L2NODE_PROGRESSION_RATE = 'x1';

const SCHEMA_VERSION = 1;
const CATALOGUE_SEED = 20261005;
// The world spawns by day; the catalogue takes every spawn definition of
// the game day (SpotService.ensureIndexed, SpawnNpcs.catalogueSpawns, T123):
// the table measures each at its share of the day.
const PERIOD_MODE = 'day';
const CATALOGUE_PERIODS = 'day+night';
const MAX_LEVEL = 78;
const REF_GAP = 6;
// Bot level minus spot level, every 2 levels from 4 below the mobs up to the
// first deep-blue level (user 10-29: past it the C4 drop falls to 30% and
// less, ProgressionRates.deepBlueRule), the last point at or above it.
const GAPS = [];
for (let gap = -4; GAPS[GAPS.length - 1] === undefined || GAPS[GAPS.length - 1] < ProgressionRates.DEEP_BLUE_LEVEL_GAP; gap += 2) GAPS.push(gap);
const BAND_LEVELS = 2;
const CURVE_SPOTS = 3;
// The table's keys (user 10-29): one per C4 class line, its second
// profession's id; the bot of a line at a level is that line's class of the
// level's profession stage (below 20, 20-39, 40+), its kit and skills (one
// row of identical classes over a spot's levels is measured once). The
// author's role names stay as aliases of one line each (ROLE_LINES), read
// by SpotValueTable for callers that ask by role.
const ROLE_LINES = { dps: '2', mage: '12', tank: '5', dagger: '8', archer: '24', healer: '16', buffer: '17',
    spoiler: '55', summoner: '14', chanter: '52' };
let lineClasses = null;
// { line: [base, first, second] } from ClassProgression (after Global loads).
function roleClasses() {
    if (lineClasses) return lineClasses;
    require('../src/Global');
    const ClassProgression = invoke('GameServer/ClassProgression');
    lineClasses = {};
    for (const seconds of Object.values(ClassProgression.secondProfMap)) {
        for (const second of seconds) lineClasses[String(second)] = ClassProgression.lineage(second);
    }
    for (const classes of Object.values(lineClasses)) if (classes.length !== 3) throw new Error(`class line ${classes}`);
    return lineClasses;
}
function roles() {
    return Object.keys(roleClasses()).sort((a, b) => Number(a) - Number(b));
}
// 1: the weapon's shots, 0: none, 2: Blessed Spiritshot (a spiritshot class
// only; null rows for the others): ShotStock chooses it by these rows.
const SHOTS = [1, 0, 2];
// A row's fields are per mob killed (a fight of a pull kills several), kph
// mobs per hour. The hunt cycle of a kill (HuntCycle): fight and rest
// seconds, the mob's damage before heals (taken; spellTaken its part from
// spells, over M.Def) and the HP and MP the bot ends short (hpLost, mpLost:
// what its rest refills). pull: mobs per fight; cap: the mobs per hour the
// spawns the bot may fight allow (BackgroundResolver.admittedDensity); mix:
// the kills by species, [selfId, share, ...] by share, at most MIX_SPECIES
// (the reader prices the kill and its level gap by it, user 10-29); gate:
// per GAPS, cap x 256 + the bits of the mix species the bot of that level
// may fight alone (0: none), so a row read below its reference keeps only
// what that bot fights (gapGate); gateShare: per GAPS, the part of those
// species' production the bot may fight (BackgroundResolver.soloShareMobs:
// each spawn group's production times its admitted share).
const ROW_FIELDS = ['minGap', 'refGap', 'kph', 'busy', 'deaths', 'exp', 'sp', 'adena', 'loot', 'shots', 'potions', 'stacks',
    'fight', 'rest', 'taken', 'spellTaken', 'hpLost', 'mpLost', 'pull', 'cap', 'mix', 'gate', 'gateShare'];
const MIX_SPECIES = 8;
// Loot has no curve of its own: one rare drop in an hour of a curve spot
// would swing it; it follows the adena curve (same drop groups, same
// deep-blue rule, same monsters). HP and MP lost follow taken and fight.
const CURVE_FIELDS = ['kph', 'busy', 'deaths', 'exp', 'adena', 'fight', 'rest', 'taken'];
const START = 1_750_000_000_000;

function args() {
    const out = { jobs: Math.max(1, Math.min(6, os.cpus().length - 2)), hours: 2, curveHours: 1,
        out: path.join(root, 'data', 'Bots', 'spot-table.json'), spots: 0, child: null, revision: null,
        mergeStacksFrom: null, stacksTable: null, phase: 'all', shard: null, parts: null };
    for (const arg of process.argv.slice(2)) {
        const [key, value] = arg.replace(/^--/, '').split('=');
        if (key === 'jobs') out.jobs = Math.max(1, Number(value));
        else if (key === 'hours') out.hours = Number(value);
        else if (key === 'curve-hours') out.curveHours = Number(value);
        else if (key === 'out') out.out = path.resolve(value);
        else if (key === 'spots') out.spots = Number(value);
        else if (key === 'child') out.child = value;
        else if (key === 'revision') out.revision = value;
        else if (key === 'merge-stacks-from') out.mergeStacksFrom = path.resolve(value);
        else if (key === 'stacks-table') out.stacksTable = path.resolve(value);
        else if (key === 'phase') out.phase = value;
        else if (key === 'shard') out.shard = value.split('/').map(Number);
        else if (key === 'parts') out.parts = path.resolve(value);
        else throw new Error(`unknown argument ${arg}`);
    }
    if (!['all', 'rows', 'curves', 'merge'].includes(out.phase)) throw new Error(`unknown phase ${out.phase}`);
    if (out.shard && !(out.shard[1] >= 1 && out.shard[0] >= 1 && out.shard[0] <= out.shard[1])) throw new Error('bad --shard');
    if (out.phase !== 'all' && out.phase !== 'rows' && !out.parts) throw new Error(`phase ${out.phase} needs --parts`);
    return out;
}

// ---------------------------------------------------------------- split runs

// The share of a phase's tasks: every n-th task from the i-th, with its index.
function shareOf(tasks, shard) {
    const indexed = tasks.map((task, index) => ({ task, index }));
    return shard ? indexed.filter(({ index }) => index % shard[1] === shard[0] - 1) : indexed;
}

// A phase's results in task order: measured here (its share written to --out
// for a split run, null returned), or read from the parts of --parts. A part
// keeps the hash of its run's task list (tasksHash): a part of another run
// (another catalogue, other rows behind the curve picks) is refused, not
// paired by index.
async function phaseResults(phase, tasks, options, catalogueFile) {
    const signature = tasksHash(tasks);
    if (options.phase === phase || options.phase === 'all') {
        const share = shareOf(tasks, options.shard);
        const results = await runPool(catalogueFile, share.map(({ task }) => task), options.jobs);
        if (options.phase === 'all') return results;
        fs.mkdirSync(path.dirname(options.out), { recursive: true });
        fs.writeFileSync(options.out, `${JSON.stringify({ phase, total: tasks.length, tasksHash: signature, indices: share.map(({ index }) => index), results })}\n`);
        process.stderr.write(`wrote ${phase} part ${options.shard?.join('/') || '1/1'}: ${share.length} of ${tasks.length} tasks\n`);
        return null;
    }
    const results = new Array(tasks.length);
    let found = 0;
    for (const name of fs.readdirSync(options.parts).filter((file) => file.endsWith('.json')).sort()) {
        const part = JSON.parse(fs.readFileSync(path.join(options.parts, name), 'utf8'));
        if (part.phase !== phase) continue;
        if (part.total !== tasks.length) throw new Error(`${name}: ${part.total} ${phase} tasks, this run has ${tasks.length}`);
        if (part.tasksHash !== signature) throw new Error(`${name}: ${phase} tasks of another run (hash ${part.tasksHash}, this run ${signature})`);
        part.indices.forEach((index, at) => {
            if (results[index] === undefined) found += 1;
            results[index] = part.results[at];
        });
    }
    if (found !== tasks.length) throw new Error(`${phase} parts hold ${found} of ${tasks.length} tasks`);
    return results;
}

// The hash of a phase's task list: each task's kind, spot, point key (a
// curve or kit point) and hours, in order.
function tasksHash(tasks) {
    return hash(tasks.map((task) => `${task.kind}|${task.spotId}|${task.point || ''}|${task.hours}`).join('\n'));
}

// ARCH-NOTE: full regeneration exceeded the FX-E9 tolerance for XP/SP,
// loot and potions. This prescribed fallback keeps every authored column,
// curve and input; only the measured stacks column comes from the new run.
function mergeStacks(old, measured) {
    if (JSON.stringify(old.gaps) !== JSON.stringify(measured.gaps)) throw new Error('spot-table merge gaps differ');
    const stackIndex = measured.rowFields.indexOf('stacks');
    if (stackIndex < 0) throw new Error('spot-table merge missing stacks');
    const spots = new Map(measured.spots.map((spot, index) => [String(spot[0]), index]));
    const oldStackIndex = old.rowFields.indexOf('stacks');
    const rowFields = oldStackIndex < 0 ? [...old.rowFields, 'stacks'] : [...old.rowFields];
    const outputIndex = rowFields.indexOf('stacks');
    const rows = old.rows.map((set, spot) => set.map((row, index) => {
        if (!row) return null;
        const role = measured.roles.indexOf(old.roles[Math.floor(index / old.shots.length)]);
        const shot = measured.shots.indexOf(old.shots[index % old.shots.length]);
        if (role < 0 || shot < 0) throw new Error('spot-table merge role or shots differ');
        const source = measured.rows[spots.get(String(old.spots[spot][0]))]?.[role * measured.shots.length + shot];
        const value = source?.[stackIndex];
        const result = [...row];
        // A removed/unhuntable measurement remains unknown, so the runtime
        // uses its old two-hour fallback instead of inventing zero growth.
        result[outputIndex] = Number.isFinite(value) && value >= 0 ? value : null;
        return result;
    }));
    return { ...old, header: { ...old.header, revision: measured.header.revision,
        stacksSource: { revision: measured.header.revision, counts: measured.header.counts,
            mode: 'stacks_only', oldColumnsRevision: old.header.revision } }, rowFields, rows };
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
    const classes = roleClasses()[ROLE_LINES[role] || role];
    return classes[level < 20 ? 0 : level < 40 ? 1 : 2];
}

// The second class a line is named by: its first class fights for it (a
// Rogue on line 9 with a bow, on line 8 with a dagger: HuntCycle.referenceId).
function lineClassFor(role) {
    return roleClasses()[ROLE_LINES[role] || role][2];
}

// The bot a line fights with at a level: its class there, and a split-kit
// first class's future whose weapon it wields (BotRoles.kitClassId of the
// reference's id), or null.
function lineBot(role, level) {
    const classId = classFor(role, level);
    const characterId = invoke('GameServer/Bot/AI/HuntCycle').referenceId(classId, lineClassFor(role));
    return { classId, future: invoke('GameServer/Bot/AI/BotRoles').kitClassId({ classId, characterId }) };
}

// The key of the steps lines share (7>9: a Rogue with the Hawkeye's bow),
// the very key of the class's hunt data (scripts/hunt-tables kitKey).
function botFor(role, level) {
    const { classId, future } = lineBot(role, level);
    return HuntKeys.kitKey(classId, future);
}

function bandOf(level) {
    return Math.floor(level / BAND_LEVELS);
}

// ---------------------------------------------------------------- catalogue

// The spots the server builds at start (SpotService over the spawned
// world's definitions, at their seeded catalogue points), and the profile of
// the geodata their territory points stand on (null: none, every territory
// spawn at its maxZ hint: other floors than the server's).
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
    const geodata = invoke('GameServer/Bot/AI/SpotValueTable').geodataProfile();
    // Without geodata territory spawns stand at their maxZ hint: other floors
    // and spot ids than the server's. The tables workflow sets
    // L2_TABLES_GEODATA=required: a table built so is wrong; elsewhere (tests,
    // a local probe) a warning.
    if (!geodata) {
        const why = 'no geodata: territory spawns stand at their maxZ hint, the floors differ from the server\'s (npm run geodata)';
        if (process.env.L2_TABLES_GEODATA === 'required') throw new Error(why);
        process.stderr.write(`${why}\n`);
    }
    return { spots: SpotService.spots, profiles, spawned: world.npc.spawns.length, geodata };
}

// ---------------------------------------------------------------- simulation (child)

let sim = null;
function loadSimulation(catalogueFile) {
    require('../src/Global');
    invoke('GameServer/DataCache').init();
    const Floor = invoke('GameServer/Bot/Population/SurvivalFloor');
    const nativeFloor = Floor.forState;
    // ARCH-NOTE: the measured combat has unlimited supplies (1e9 each), so
    // the new native bag gate rejects every run as overweight. This offline
    // table excludes town unloading; keep death/mana gates and skip unload.
    Floor.forState = (...args) => {
        const result = nativeFloor(...args);
        return result?.action === 'unload' ? null : result;
    };
    // ARCH-NOTE: cold combat spends shots only when ShotStock.usePolicy, read from
    // this very table, says they pay (0175fd237). Measuring through it would read the
    // previous table: a cell without shot use stays without forever. The table
    // measures the shots row with the shots loaded, so the bag's shots are used.
    const ShotStock = invoke('GameServer/Inventory/ShotStock');
    ShotStock.usePolicy = () => ({ usePerHour: 1 });
    // ARCH-NOTE: cold kills apply the C4 exp level-gap penalty (MobExperience,
    // d4322a214) and SpotValueTable applies it again on read for the bot's own
    // gap. The table keeps the pre-penalty exp the reader expects.
    const MobExperience = invoke('GameServer/Progression/MobExperience');
    MobExperience.rewards = (exp, sp) => ({ exp: Math.max(0, Number(exp) || 0), sp: Math.max(0, Number(sp) || 0) });
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
        HuntEfficiency: invoke('GameServer/Bot/AI/BotHuntEfficiency'),
        items: invoke('GameServer/DataCache').items
    };
}

// A bot of the class and level in the author's kit for that level (BotGear),
// with the shots of its weapon (or none, never running out) and the healing
// potions the author's restock buys at that level (hunt sets their number).
// kit(bot): changes the worn gear before the shots are chosen (hunt);
// line: the table line's second class the bot fights for.
function newBot(classId, level, shots, simulation = sim, kit = null, line = null) {
    // The reference bot the run time weighs kits against (HuntCycle).
    const bot = invoke('GameServer/Bot/AI/HuntCycle').referenceState(classId, level,
        { gear: simulation.BotGear, profile: simulation.CCP, line });
    if (kit) kit(bot);
    const inventory = bot.inventory;
    let shotId = 0;
    if (shots) {
        const plan = simulation.ShotStock.planForState(bot, { blessed: shots === 2 });
        if (plan?.selfId && plan.perAction > 0) {
            shotId = Number(plan.selfId);
            inventory[String(shotId)] = { selfId: shotId, amount: 1e9 };
        }
    }
    const potion = simulation.Potions.purchasePotionFor({ level });
    if (potion?.selfId) inventory[String(potion.selfId)] = { selfId: Number(potion.selfId), amount: 1e9 };
    const profile = simulation.CCP.profileFor(bot, START);
    bot.vitals = { hp: profile.maxHp, maxHp: profile.maxHp, mp: profile.maxMp, maxMp: profile.maxMp };
    return { bot, shotId, full: { ...bot.vitals }, runSpd: profile.runSpd, reach: simulation.CCP.attackReach(profile) };
}

// The spot as the bot meets it: its own density, so a row's kills pay the
// walk between them (BackgroundResolver.soloWalkMs, T106).
function atSpot(spot) {
    return spot;
}

// At full health, may the bot fight any of the spot's spawns alone (the
// solo gate the resolver picks its targets by, BackgroundResolver.admittedShares)?
// A probe fight would miss a bot that spends its first round on its
// self-buffs and the sit after them (a Warcryer, T106 audit).
function canHunt(spot, role, level, shots) {
    const { bot, profiles } = gateBot(role, level, shots);
    const shares = sim.BR.admittedShares({ ...bot, spotId: spot.id }, spot, START, profiles);
    return !shares || [...shares.values()].some((share) => share > 0);
}

// Distinct stackable drops take a slot only once in this run; non-stackable
// drops always take their physical slots. The native bag policy owns the slot rule.
function countNewStacks(items, seen, definitions = invoke('GameServer/DataCache').items) {
    const Index = require('../src/GameServer/Item/ItemTemplateIndex');
    const inventory = {};
    for (const item of items) {
        const selfId = Number(item.selfId), amount = Math.max(0, Number(item.amount) || 0);
        if (selfId === 57 || !amount) continue;
        const stackable = item.stackable ?? Index.find(definitions, selfId)?.etc?.stackable;
        if (stackable !== false) {
            if (seen.has(selfId)) continue;
            seen.add(selfId);
        }
        inventory[selfId] = { ...item, selfId, amount: (inventory[selfId]?.amount || 0) + amount };
    }
    return invoke('GameServer/Bot/Population/SurvivalFloor').stateInventory({ inventory }, definitions).slots;
}

// The hunt of a row, with the potions a bot of that level really carries
// (T141). The stock rule reads this table (EconomyContext.foundation: use = the
// row's potions), so the row comes first, on an unbounded bag: its drinks are
// the use. A row with deaths gives the stock worth: the bot buys the outing's
// use, which is the bag that run drank from. A row at 0 deaths gives it none:
// the bot buys only the survival tranche (kitReader: the use of one hour,
// whole, each outing), and that hunt is run again on it. The bottles that save
// rest are not here: the reference bot has no hour (RestPotion.betweenFights),
// the reader adds them at the bot's own (RestPotion.stockUse).
function hunt(spot, role, level, shots, hours, simulation = sim, kit = null, classId = classFor(role, level)) {
    const unbounded = huntOn(Infinity, spot, role, level, shots, hours, simulation, kit, classId);
    const tranche = Math.ceil(unbounded.potions / hours);
    return unbounded.deaths > 0 || unbounded.potions <= tranche ? unbounded
        : huntOn(tranche, spot, role, level, shots, hours, simulation, kit, classId);
}

// The author's cold combat for `hours` of game time. A death costs the time
// it costs a live cold bot: the next step is the author's respawn
// (BackgroundResolver resolveDeathRecovery, the respawn delay on the clock),
// so a deadly spot's kills and exp per hour fall as they do live. Its exp
// loss stays out of the row's exp: the loss (DeathExperience) does not scale
// with the exp rate the reader applies to this x1 table; the reader charges
// it per death on the row's deaths (EconomicValuation.deathHours). kit(bot): changes the
// reference bot's worn gear before the hunt (scripts/hunt-cycle-check.js);
// classId: another class than the role's (scripts/hunt-tables);
// potions: the bottles it carries each outing (Infinity: it never runs out).
function huntOn(potions, spot, role, level, shots, hours, simulation, kit, classId) {
    // One seed with and without shots: the two rows' difference is the shots'
    // (common random numbers), not two draws' (T106 audit).
    const seed = hash(`${spot.id}|${classId}|${level}`);
    const rng = mulberry(seed);
    const random = Math.random;
    Math.random = mulberry(seed ^ 0x9e3779b9);
    const sum = { kills: 0, mobs: 0, busyMs: 0, deaths: 0, exp: 0, sp: 0, adena: 0, loot: 0, shots: 0, potions: 0, stacks: 0,
        fightMs: 0, walkMs: 0, buffCasts: 0, heals: 0, actions: 0, shotActions: 0, skillUses: 0, pulls: 0, pullMobs: 0, gapHeals: 0, petHeals: 0, petTaken: 0, summonUses: 0, summonDeaths: 0, restMs: 0, taken: 0, spellTaken: 0, hpLost: 0, mpLost: 0, mix: {}, density: 0, runSpd: 0 };
    try {
        const made = newBot(classId, level, shots, simulation, kit, lineClassFor(role));
        const potionId = String(simulation.Potions.purchasePotionFor({ level }).selfId);
        const restock = inventory => { if (Number.isFinite(potions)) inventory[potionId] = { ...inventory[potionId], amount: potions }; };
        restock(made.bot.inventory);
        const seen = new Set(Object.values(made.bot.inventory).filter(item => item.amount > 0).map(item => Number(item.selfId)));
        let state = { ...made.bot, spotId: spot.id, loc: { ...spot.center } };
        // The monsters it may fight at full health: the cap of its kills (row cap).
        sum.density = simulation.BR.admittedDensity(spot, simulation.BR.admittedShares(state, spot, START));
        sum.runSpd = made.runSpd;
        sum.reach = made.reach;
        sum.area = spot.spawnArea;
        const target = atSpot(spot);
        let t = START;
        const end = START + hours * 3600000;
        const outingMs = invoke('GameServer/Bot/Economy/TownVisitInterval').targetHours() * 3600000;
        let nextVisit = START + outingMs;
        let elapsed = 60000;
        while (t < end) {
            if (t >= nextVisit) { restock(state.inventory); nextVisit += outingMs; }
            const result = simulation.BR.resolveSolo({ state, spot: target, elapsedMs: elapsed, timestamp: t, rng });
            const gained = result.materialize || {};
            const debug = result.debug || {};
            const patch = result.patch || {};
            sum.kills += Number(debug.wins || 0);
            sum.mobs += Number(debug.mobsKilled || 0);
            for (const [selfId, mobs] of Object.entries(debug.killedNpcs || {})) sum.mix[selfId] = (sum.mix[selfId] || 0) + mobs;
            sum.exp += Number(gained.exp || 0);
            sum.sp += Number(gained.sp || 0);
            sum.adena += Number(gained.adena || 0);
            sum.loot += simulation.HuntEfficiency.lootValue(gained.items || []);
            sum.stacks += countNewStacks(gained.items || [], seen, simulation.items);
            sum.potions += Number(debug.potionsUsed || 0);
            // The bots' records count a cycle's combat and the rest it calls for.
            if (Number.isFinite(debug.combatMs)) {
                const restMs = Math.max(0, Number(patch.stats?.restUntil || t) - t);
                sum.busyMs += Number(debug.combatMs) + restMs;
                sum.fightMs += Number(debug.combatMs);
                // Its parts the bots' records do not split: the walk to the mobs, own buffs and heals.
                sum.walkMs += Number(debug.walkedMs || 0);
                sum.buffCasts += Number(debug.buffCasts || 0);
                sum.heals += Number(debug.heals || 0);
                sum.actions += Number(debug.combatActions || 0);
                sum.shotActions += Number(debug.shotActions || 0);
                sum.skillUses += Number(debug.skillUses || 0);
                sum.pulls += Number(debug.pulls || 0);
                sum.pullMobs += Number(debug.pullMobs || 0);
                sum.gapHeals += Number(debug.gapHeals || 0);
                sum.petHeals += Number(debug.petHeals || 0);
                sum.petTaken += Number(debug.petTaken || 0);
                sum.summonUses += Number(debug.summonUses || 0);
                sum.summonDeaths += Number(debug.summonDeaths || 0);
                sum.restMs += restMs;
                sum.taken += Number(debug.damageTaken || 0);
                sum.spellTaken += Number(debug.spellTaken || 0);
                sum.hpLost += Math.max(0, Number(state.vitals?.hp) - Number(patch.vitals?.hp ?? state.vitals?.hp));
                sum.mpLost += Math.max(0, Number(state.vitals?.mp) - Number(patch.vitals?.mp ?? state.vitals?.mp));
            }
            const inventory = patch.inventory || state.inventory;
            state = { ...state, ...patch, vitals: { ...state.vitals, ...(patch.vitals || {}) },
                stats: { ...(patch.stats || state.stats), classId }, inventory };
            if (debug.died || patch.activity === 'dead') sum.deaths += 1;
            if (!['hunting', 'resting', 'dead'].includes(state.activity)) {
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

// Kills per hour the spot's monsters allow a bot that may fight density of
// them: one per walk to the next (BackgroundResolver.soloWalkMs, T106) at
// the cold trip's run speed (the row's bot is not known here).
// runSpd: the bot's (a spot's own cap, with no bot: the author's run speed).
function fightCap(density, runSpd = invoke('GameServer/Bot/Population/ColdTrip').RUN_SPEED, area = undefined, reach = 0) {
    const BR = invoke('GameServer/Bot/Population/BackgroundResolver');
    return 3600000 / Math.max(1, BR.soloWalkMs(density, runSpd, area, reach));
}

// The kills by species, [selfId, share, ...] by share (the first MIX_SPECIES).
function killMix(mix, mobs) {
    return Object.entries(mix).sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0])).slice(0, MIX_SPECIES)
        .flatMap(([selfId, count]) => [Number(selfId), Math.round(count / mobs * 1000) / 1000]);
}

function perKill(sum, hours) {
    if (sum.kills <= 0 || sum.mobs <= 0) return null;
    const k = sum.mobs, pull = sum.mobs / sum.kills;
    return { pull, cap: fightCap(sum.density, sum.runSpd || undefined, sum.area || undefined, sum.reach) * pull, mix: killMix(sum.mix, k), kph: k / hours, busy: sum.busyMs / 1000 / k, deaths: sum.deaths / k, exp: sum.exp / k, sp: sum.sp / k,
        adena: sum.adena / k, loot: sum.loot / k, shots: sum.shots / k, potions: sum.potions / k, stacks: sum.stacks / k,
        fight: sum.fightMs / 1000 / k, rest: sum.restMs / 1000 / k, taken: sum.taken / k, spellTaken: sum.spellTaken / k, hpLost: sum.hpLost / k,
        mpLost: sum.mpLost / k };
}

// The reference bots of the gate, one per role, level and shots in a child:
// { bot, profiles } (BackgroundResolver.roundProfiles), shared by every spot.
const gateBots = new Map();
function gateBot(role, level, shots) {
    const key = `${botFor(role, level)}|${level}|${shots}`;
    let held = gateBots.get(key);
    if (!held) {
        const { bot, runSpd, reach } = newBot(classFor(role, level), level, shots, sim, null, lineClassFor(role));
        gateBots.set(key, held = { bot, runSpd, reach, profiles: sim.BR.roundProfiles(bot, START) });
    }
    return held;
}

// A row's gate at one bot level: [gate, share], gate the cap (fightCap of
// the spawns the bot of that level may fight, times the row's pull) x 256 +
// the bits of the mix species it may fight (BackgroundResolver.admittedShares),
// 0 where it may fight none; share the part of the production of those
// species' spawns it may fight (each spawn group's production times its
// admitted share, over their production: SpotValueTable takes the masked
// species' whole production times it), 1 without shares or production.
function gapGate(spot, role, shots, botLevel, species, pull) {
    if (botLevel < 1 || botLevel > MAX_LEVEL) return [0, 1];
    const { bot, profiles, runSpd, reach } = gateBot(role, botLevel, shots);
    const shares = sim.BR.admittedShares({ ...bot, spotId: spot.id }, spot, START, profiles);
    const admitted = new Set();
    for (const [entry, share] of shares || []) if (share > 0) admitted.add(Number(entry.selfId));
    let mask = 0;
    const masked = new Set();
    species.forEach((selfId, index) => {
        if (shares && !admitted.has(selfId)) return;
        mask |= 1 << index;
        masked.add(selfId);
    });
    const density = sim.BR.admittedDensity(spot, shares);
    if (!mask || !(density > 0)) return [0, 1];
    let whole = 0, taken = 0;
    for (const [entry, share] of shares || []) {
        if (!masked.has(Number(entry.selfId)) || !Number.isFinite(entry.production)) continue;
        whole += entry.production;
        taken += entry.production * share;
    }
    const part = whole > 0 ? Math.max(0.001, Math.min(1, Math.round(taken / whole * 1000) / 1000)) : 1;
    return [Math.max(1, Math.round(fightCap(density, runSpd || undefined, spot.spawnArea || undefined, reach) * pull)) * 256 + mask, part];
}

// A row: the lowest level gap at which the role finds a safe target, then the
// hunt at the reference gap (or that lowest gap when it is higher).
function rowTask({ spotId, hours }) {
    const spot = sim.profiles.get(spotId);
    const level = Number(spot.avgLevel);
    const rows = [];
    // Every step reads only the class a line has at a level (its profession
    // stage there), its level and shots: lines that share a class at a level
    // (Warrior below 40 for Gladiator and Warlord) share that step's result,
    // a spot whose gaps cross a profession level measures both classes.
    const memo = new Map();
    const once = (key, compute) => {
        if (!memo.has(key)) memo.set(key, compute());
        return memo.get(key);
    };
    for (const role of roles()) {
        for (const shots of SHOTS) rows.push(lineRow(spot, role, level, shots, hours, once));
    }
    return rows;
}

// One line's row on a spot (rowTask; once: its memo by class, level and shots).
function lineRow(spot, role, level, shots, hours, once) {
    const at = (botLevel) => `${botFor(role, botLevel)}|${botLevel}|${shots}`;
    if (shots === 2 && !once(`blessed|${at(level)}`,
        () => !!sim.ShotStock.planForState(gateBot(role, level, 0).bot, { blessed: true }))) return null;
    let minGap = null;
    for (let gap = GAPS[0]; gap <= GAPS[GAPS.length - 1]; gap++) {
        const botLevel = level + gap;
        if (botLevel < 1) continue;
        if (botLevel > MAX_LEVEL) break;
        if (once(`probe|${at(botLevel)}`, () => canHunt(spot, role, botLevel, shots))) { minGap = gap; break; }
    }
    if (minGap === null) return null;
    const refLevel = Math.min(MAX_LEVEL, level + Math.max(REF_GAP, minGap));
    const measured = once(`hunt|${at(refLevel)}`, () => perKill(hunt(spot, role, refLevel, shots, hours), hours));
    if (!measured) return null;
    // A spoiler keeps its own loot (poolRowLoot).
    const spoils = invoke('GameServer/Bot/Economy/SpotRewardExpectation')
        .spoilSkillLevel({ level: refLevel, stats: { classId: classFor(role, refLevel) } }) > 0;
    const species = [];
    for (let i = 0; i < measured.mix.length; i += 2) species.push(measured.mix[i]);
    const gates = GAPS.map((gap) => once(`gate|${at(level + gap)}|${species}|${measured.pull}`,
        () => gapGate(spot, role, shots, level + gap, species, measured.pull)));
    return { minGap, refGap: refLevel - level, ...measured, spoils, gate: gates.map(([gate]) => gate),
        gateShare: gates.map(([, share]) => share) };
}

// A curve point: the role on one spot at one gap, shots on.
function curveTask({ spotId, role, gap, hours }) {
    const spot = sim.profiles.get(spotId);
    const level = Number(spot.avgLevel) + gap;
    if (level < 1 || level > MAX_LEVEL) return null;
    if (!canHunt(spot, role, level, 1)) return null;
    return perKill(hunt(spot, role, level, 1, hours), hours);
}

// ---------------------------------------------------------------- kit surface

// The kits a line's bot is measured in on its band's curve spots (user
// 10-29): from the hunt model's ladders (data/Bots/hunt/gear.json: one weapon
// per weapon tier, a set of pieces per armour tier, grades up to the level's),
// this grade's best and weakest weapon and the grade below's best, each with
// this grade's full armour, its body pieces and the grade below's full
// armour; and the best weapon, then the full armour, at +3. Named
// '<weapon>+<armour>[+3w|+3a]'; 'ref' is the author's kit (the table's).
let gearTable = null;
function gear() {
    if (gearTable) return gearTable;
    const raw = JSON.parse(fs.readFileSync(path.join(root, 'data', 'Bots', 'hunt', 'gear.json'), 'utf8'));
    const items = new Map(raw.items.map((row) => [row[0], Object.fromEntries(raw.itemFields.map((field, i) => [field, row[i]]))]));
    return gearTable = { items, classes: new Map(raw.classes.map((row) => [row.key ?? String(row.classId), row])) };
}
// key: the line's bot at the level (botFor; a split-kit Rogue of line 9: its bow ladders).
function kitGrid(key, level) {
    const row = gear().classes.get(String(key));
    if (!row) return [];
    const { GRADES, gradeForLevel } = invoke('GameServer/Bot/AI/GearGradeRule');
    const grade = gradeForLevel(level), below = GRADES[Math.max(0, GRADES.indexOf(grade) - 1)];
    const tier = (list, name) => list.find((entry) => entry[0] === name)?.[1] || null;
    const pick = (list, names) => [...new Set(names)].map((name) => [name, tier(list, name)]).filter(([, ids]) => ids?.length);
    const weapons = pick(row.weaponTiers, [`${grade}-top`, `${grade}-low`, `${below}-top`]);
    const armours = pick(row.armourTiers, [`${grade}-full`, `${grade}-body`, `${below}-full`]);
    const kits = [];
    for (const [w, wIds] of weapons) for (const [a, aIds] of armours) kits.push({ name: `${w}+${a}`, weapon: wIds, armour: aIds });
    if (weapons.length && armours.length) {
        kits.push({ name: `${weapons[0][0]}+${armours[0][0]}+3w`, weapon: weapons[0][1], armour: armours[0][1], weaponEnchant: 3 });
        kits.push({ name: `${weapons[0][0]}+${armours[0][0]}+3a`, weapon: weapons[0][1], armour: armours[0][1], armourEnchant: 3 });
    }
    return kits;
}

// One kit point: the line's bot at a level on a curve spot in that kit (kit
// null: the author's), shots on, the reference's seed (hunt: one seed per
// class and level, so the kit's difference is the kit's). Its kit features
// against the author's kit (HuntCycle.kitFeatures) and its per-kill hunt, or
// gated: true where its solo gate admits none of the spot's spawns.
function kitTask({ spotId, role, level, kit, hours }) {
    const spot = sim.profiles.get(spotId);
    const classId = classFor(role, level), key = botFor(role, level);
    const S = require('./hunt-tables/static-tables');
    const M = require('./hunt-tables/HuntModel');
    const dress = kit && ((bot) => {
        const worn = [...kit.weapon.map((id) => ({ id, enchant: kit.weaponEnchant || 0 })),
            ...kit.armour.map((id) => ({ id, enchant: kit.armourEnchant || 0 }))];
        bot.inventory = M.kitState(key, level, worn.flatMap(({ id, enchant }) =>
            S.wear(gear().items.get(id)).map((entry) => ({ ...entry, enchant })))).inventory;
    });
    const made = newBot(classId, level, 1, sim, dress, lineClassFor(role));
    const shares = sim.BR.admittedShares({ ...made.bot, spotId: spot.id }, spot, START);
    if (shares && ![...shares.values()].some((share) => share > 0)) return { gated: true };
    const HuntCycle = invoke('GameServer/Bot/AI/HuntCycle');
    const numbers = sim.CCP.profileFor(made.bot, START);
    const reference = sim.CCP.profileFor(newBot(classId, level, 1, sim, null, lineClassFor(role)).bot, START);
    const [mobAccur, mobEvasion] = spotMob(spot);
    const features = HuntCycle.kitFeatures(numbers, reference, { mobAccur, mobEvasion },
        invoke('GameServer/Bot/AI/BotRoles').usesCasterWeaponCombat({ classId, stats: { classId } }));
    return { features, measured: perKill(hunt(spot, role, level, 1, hours, sim, dress, classId), hours) };
}

// The kit surface of a line's band: least squares, no intercept (the
// author's kit is 1), of the logs of fight and damage taken per kill over the
// author's kit's on the kit features, from every kit point of its curve
// spots both measured; a small ridge keeps a feature no kit moved at 0.
// null with fewer points than twice the features.
function fitSurface(points) {
    // The ridge pulls toward the closed-form slopes (HuntCycle's old ratios:
    // fight ~ 1/damage rate, taken ~ fight x hits or spells met), not toward
    // 0: a feature the kits never moved (M.Def where no mob casts) keeps the
    // physics, a measured one the measurement.
    const { KIT_PRIOR } = invoke('GameServer/Bot/AI/HuntCycle');
    const solve = (pairs, prior) => {
        const n = pairs[0]?.[0].length || 0;
        if (!n || pairs.length < 2 * n) return null;
        const a = Array.from({ length: n }, () => new Array(n).fill(0)), b = new Array(n).fill(0);
        for (const [x, y] of pairs) for (let i = 0; i < n; i++) {
            b[i] += x[i] * y;
            for (let j = 0; j < n; j++) a[i][j] += x[i] * x[j];
        }
        for (let i = 0; i < n; i++) { a[i][i] += 1e-3; b[i] += 1e-3 * prior[i]; }
        // Gauss-Jordan on the normal equations.
        for (let i = 0; i < n; i++) {
            let pivot = i;
            for (let r = i + 1; r < n; r++) if (Math.abs(a[r][i]) > Math.abs(a[pivot][i])) pivot = r;
            [a[i], a[pivot]] = [a[pivot], a[i]]; [b[i], b[pivot]] = [b[pivot], b[i]];
            for (let r = 0; r < n; r++) {
                if (r === i) continue;
                const f = a[r][i] / a[i][i];
                for (let c = i; c < n; c++) a[r][c] -= f * a[i][c];
                b[r] -= f * b[i];
            }
        }
        const coef = b.map((value, i) => value / a[i][i]);
        const rms = Math.sqrt(pairs.reduce((sum, [x, y]) => sum + (y - x.reduce((s2, v, i) => s2 + v * coef[i], 0)) ** 2, 0) / pairs.length);
        return { coef: coef.map((value) => Math.round(value * 1000) / 1000), rms: Math.round(rms * 1000) / 1000 };
    };
    const { weighFeatures } = invoke('GameServer/Bot/AI/HuntCycle');
    const pairs = (field) => points.flatMap(({ kit, ref }) => kit[field] > 0 && ref[field] > 0
        ? [[weighFeatures(kit.features, ref.taken > 0 ? ref.spellTaken / ref.taken : 0), Math.log(kit[field] / ref[field])]] : []);
    // A caster that kills before contact takes no hit in any kit: taken null.
    const fight = solve(pairs('fight'), KIT_PRIOR.fight), taken = solve(pairs('taken'), KIT_PRIOR.taken);
    return fight ? [fight.coef, taken?.coef || null, points.length, fight.rms, taken?.rms ?? null] : null;
}

function runChild(catalogueFile) {
    loadSimulation(catalogueFile);
    process.on('message', (message) => {
        if (message.type === 'stop') process.exit(0);
        const result = message.kind === 'row' ? rowTask(message) : message.kind === 'kit' ? kitTask(message) : curveTask(message);
        process.send({ id: message.id, result });
    });
    process.send({ ready: true });
}

// ---------------------------------------------------------------- parent

function runPool(catalogueFile, tasks, jobs) {
    if (!tasks.length) return Promise.resolve([]);
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
    rows.forEach((row) => {
        if (!row || row.spoils) return;
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
    return row ? ROW_FIELDS.map((field) => field === 'mix' || field === 'gate' || field === 'gateShare' ? row[field] : round(row[field])) : null;
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
        ProgressionRates.reset();
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
    ProgressionRates.reset();
    return out;
}

// The accuracy and evasion of a kill at the spot: its huntable monsters'
// numbers weighted by their share of an untargeted kill draw
// (ColdCombatProfile.killDraw/killChances, no hunter's matchup filter).
function spotMob(spot) {
    const DataCache = invoke('GameServer/DataCache');
    const ItemTemplateIndex = require('../src/GameServer/Item/ItemTemplateIndex');
    const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
    const Policy = invoke('GameServer/Bot/AI/BotHuntingTargetPolicy');
    const RaidSafety = invoke('GameServer/Bot/AI/BotRaidSafety');
    const entries = spot.npcEntries?.length ? spot.npcEntries : (spot.npcSelfIds || []).map((selfId) => ({ selfId, count: 1 }));
    const rows = entries.flatMap((entry) => {
        const npc = ItemTemplateIndex.find(DataCache.npcs, entry.selfId);
        return !npc || !Policy.canHunt(npc) || RaidSafety.isProtectedRaidEntity(npc) ? []
            : [{ selfId: Number(entry.selfId), count: Math.max(1, Number(entry.count) || 1), production: entry.production, npc }];
    });
    let share = 0, accur = 0, evasion = 0;
    for (const { entry, chance } of Profile.killChances(Profile.killDraw(rows, rows))) {
        const mob = Profile.npcCombatStats(entry.npc);
        if (!mob || !(chance > 0)) continue;
        share += chance;
        accur += chance * mob.accur;
        evasion += chance * mob.evasion;
    }
    return share > 0 ? [round(accur / share), round(evasion / share)] : [0, 0];
}

function gitRevision() {
    try {
        const head = childProcess.execSync('git rev-parse --short=9 HEAD', { cwd: root }).toString().trim();
        const dirty = childProcess.execSync('git status --porcelain -- src data/Npcs data/Items data/Skills data/Templates', { cwd: root })
            .toString().trim() !== '';
        return dirty ? `${head}+local` : head;
    } catch (_) {
        return 'unknown';
    }
}

function rewardCatalog(profiles) {
    return { schema: 1, seed: CATALOGUE_SEED, periodMode: CATALOGUE_PERIODS,
        rows: profiles.filter(spot => !spot.raidBoss).map(spot => [spot.id,
            (spot.npcEntries || []).map(entry => [Number(entry.selfId), Math.max(1, Number(entry.count) || 1)]),
            Number(spot.rewards?.adenaMin || 0), Number(spot.rewards?.adenaMax || 0)]) };
}

async function main() {
    const options = args();
    if (options.child) return runChild(options.child);
    if (options.mergeStacksFrom || options.stacksTable) {
        if (!options.mergeStacksFrom || !options.stacksTable) throw new Error('spot-table merge requires both input files');
        const table = mergeStacks(JSON.parse(fs.readFileSync(options.mergeStacksFrom, 'utf8')),
            JSON.parse(fs.readFileSync(options.stacksTable, 'utf8')));
        fs.mkdirSync(path.dirname(options.out), { recursive: true });
        fs.writeFileSync(options.out, JSON.stringify(table) + '\n');
        process.stderr.write(`merged stacks into ${options.out}: ${table.spots.length} spots\n`);
        return;
    }
    const started = Date.now();
    const revision = options.revision || gitRevision();
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
        const rowResults = await phaseResults('rows', rowTasks, options, catalogueFile);
        if (!rowResults) return;
        if (rowResults.length !== spots.length || rowResults.some((rows) => rows.length !== roles().length * SHOTS.length)) {
            throw new Error('row results do not match the spots');
        }

        // Curve spots: per role and band, up to CURVE_SPOTS spots of the band
        // where the role hunts at the reference gap: the lowest gap it hunts at
        // first (a curve without its low gaps copies the higher one there and
        // lifts every low bot's read, T106), then the narrowest monster level
        // spread (a lone low monster on a spot makes a lower bot farm only it
        // and bends the whole band's curve, T43), then a fixed hashed order.
        const curveSpots = new Map(), minGaps = new Map();
        spots.forEach((spot, index) => {
            roles().forEach((role, roleIndex) => {
                const row = rowResults[index][roleIndex * SHOTS.length];
                if (!row || row.refGap !== REF_GAP) return;
                const key = `${role}|${bandOf(Number(spot.avgLevel))}`;
                if (!curveSpots.has(key)) curveSpots.set(key, []);
                curveSpots.get(key).push(spot.id);
                minGaps.set(`${spot.id}|${role}`, row.minGap);
            });
        });
        const spotById = new Map(spots.map((spot) => [spot.id, spot]));
        const spread = (id) => Number(spotById.get(id).maxLevel) - Number(spotById.get(id).minLevel);
        const curveTasks = [], seenPoints = new Set();
        // A curve point reads only the class at its level (rowTask).
        const pointKey = (spot, role, gap) => `${spot.id}|${botFor(role, Number(spot.avgLevel) + gap)}|${gap}`;
        for (const [key, ids] of curveSpots) {
            const [role] = key.split('|');
            const low = (id) => minGaps.get(`${id}|${role}`);
            // Hashed by the class at the spot's level: lines of one class there
            // pick the same spots and share their points (pointKey).
            const tie = (id) => hash(`${id}|${botFor(role, Number(spotById.get(id).avgLevel))}`);
            const chosen = ids.sort((a, b) => low(a) - low(b) || spread(a) - spread(b) || tie(a) - tie(b)).slice(0, CURVE_SPOTS);
            curveSpots.set(key, chosen);
            for (const spotId of chosen) {
                for (const gap of GAPS) {
                    const point = pointKey(spotById.get(spotId), role, gap);
                    if (seenPoints.has(point)) continue;
                    seenPoints.add(point);
                    curveTasks.push({ kind: 'curve', point, spotId, role, gap, hours: options.curveHours });
                }
            }
        }
        // The kit surface's points (user 10-29): each line's kits on its
        // band's curve spots at the reference gap, keyed by the bot's band;
        // lines of one class at a level share a point (as the curves).
        const kitKeys = [];
        const seenKits = new Map();
        for (const [key, ids] of curveSpots) {
            const [role] = key.split('|');
            for (const spotId of ids) {
                const spot = spotById.get(spotId);
                const level = Math.min(MAX_LEVEL, Number(spot.avgLevel) + REF_GAP);
                // A split-kit Rogue wears its own line's ladders (bows for line 9).
                const bot = botFor(role, level);
                for (const kit of [null, ...kitGrid(bot, level)]) {
                    const point = `${spotId}|${bot}|${level}|${kit?.name || 'ref'}`;
                    if (!seenKits.has(point)) {
                        seenKits.set(point, curveTasks.length);
                        curveTasks.push({ kind: 'kit', point, spotId, role, level, kit, hours: options.curveHours });
                    }
                    kitKeys.push({ role, band: bandOf(level), spotId, ref: `${spotId}|${bot}|${level}|ref`, point });
                }
            }
        }
        const curveResults = await phaseResults('curves', curveTasks, options, catalogueFile);
        if (!curveResults) return;
        const kitResult = (point) => curveResults[seenKits.get(point)];
        const kitPoints = new Map();
        for (const { role, band, ref, point } of kitKeys) {
            if (point === ref) continue;
            const kit = kitResult(point), base = kitResult(ref);
            if (!kit?.measured || !base?.measured) continue;
            const key = `${role}|${band}`;
            if (!kitPoints.has(key)) kitPoints.set(key, []);
            kitPoints.get(key).push({ kit: { ...kit.measured, features: kit.features }, ref: base.measured });
        }
        const kitSurface = { features: invoke('GameServer/Bot/AI/HuntCycle').KIT_FEATURES, fields: ['fight', 'taken'],
            layout: 'rows[line][band] = [fight coefficients, taken coefficients, points, fight rms, taken rms] (log ratio over the author\'s kit)', rows: {} };
        for (const [key, points] of kitPoints) {
            const [role, band] = key.split('|');
            const fit = fitSurface(points);
            if (!fit) continue;
            (kitSurface.rows[role] ||= {})[band] = fit;
        }

        const curveResult = new Map(curveTasks.flatMap((task, index) => task.kind === 'kit' ? [] : [[task.point, curveResults[index]]]));
        const curves = {};
        let curveCount = 0;
        for (const [key, ids] of [...curveSpots].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
            const [role, band] = key.split('|');
            const points = ids.map((spotId) => GAPS.map((gap) => curveResult.get(pointKey(spotById.get(spotId), role, gap))));
            curves[role] = curves[role] || {};
            curves[role][band] = curveFor(points);
            curveCount += 1;
        }

        const table = {
            header: {
                schema: SCHEMA_VERSION,
                generator: 'scripts/generate-spot-table.js',
                revision,
                inputs: { hours: options.hours, curveHours: options.curveHours, catalogueSeed: CATALOGUE_SEED, geodata: catalogue.geodata,
                    periodMode: CATALOGUE_PERIODS, rate: 'x1', maxLevel: MAX_LEVEL, refGap: REF_GAP, bandLevels: BAND_LEVELS,
                    curveSpots: CURVE_SPOTS, roleClasses: roleClasses(), roleLines: ROLE_LINES,
                    spotLimit: options.spots || null },
                counts: { catalogueSpots, spots: spots.length, rows: spots.length * roles().length * SHOTS.length,
                    huntableRows: rowResults.flat().filter(Boolean).length, curves: curveCount,
                    simulatedHours: rowResults.flat().filter(Boolean).length * options.hours
                        + curveResults.filter(Boolean).length * options.curveHours }
            },
            roles: roles(),
            shots: SHOTS,
            gaps: GAPS,
            rowFields: ROW_FIELDS,
            curveFields: CURVE_FIELDS,
            // [id, level, density, kills per hour all its monsters allow (a row's cap
            //  counts those its bot may fight), monsters per pull (rows: their own),
            //  loot at drop rate 10 and 50 over rate x loot at rate 1, the kills' mean accuracy and evasion]
            spots: spots.map((spot) => [spot.id, Number(spot.avgLevel), Number(spot.density), round(fightCap(Number(spot.density) || 1, undefined, spot.spawnArea || undefined)), 1,
                ...lootRateResponse(spot), ...spotMob(spot)]),
            rows: rowResults.map((rows) => poolRowLoot(rows).map(packRow)),
            curves,
            kitSurface
        };
        if (table.rows.length !== table.spots.length) throw new Error('rows and spots differ');
        fs.mkdirSync(path.dirname(options.out), { recursive: true });
        const text = `${JSON.stringify(table)}\n`;
        fs.writeFileSync(options.out, text);
        if (options.out === path.join(root, 'data', 'Bots', 'spot-table.json')) fs.writeFileSync(
            path.join(root, 'data', 'Bots', 'spot-reward-npcs.json'), `${JSON.stringify(rewardCatalog(spots))}\n`);
        process.stderr.write(`wrote ${path.relative(root, options.out)}: ${spots.length} spots, ${table.header.counts.huntableRows} huntable rows, `
            + `${curveCount} curves, ${(text.length / 1024).toFixed(0)} KB, ${Math.round((Date.now() - started) / 1000)} s\n`);
    } finally {
        fs.rmSync(catalogueFile, { force: true });
    }
    process.exit(0);
}

// GameTime reads the local clock (isNight): every run, its children too, in
// one zone (a library caller keeps its own).
if (require.main === module) {
    process.env.TZ = 'UTC';
    main().catch((error) => {
        process.stderr.write(`${error.stack || error}\n`);
        process.exit(1);
    });
}

module.exports = { hunt, perKill, countNewStacks, runPool, phaseResults, tasksHash, mergeStacks, buildCatalogue, rewardCatalog, loadSimulation, classFor, lineClassFor, botFor };
