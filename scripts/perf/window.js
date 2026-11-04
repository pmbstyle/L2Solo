'use strict';

// Window runs: the live recorder ([Perf] live) on a fixed world for a bounded time, so two commits
// can be compared. Scenarios: cold (no player: every bot cold) and hot (src/Perf/HotCrowd: one player
// where the most bots hunt, the crowd around them heated by the normal activation, and a probe of
// what that player feels). The world is a launcher save (scripts/saved-games.js): `prepare` grows one and
// saves it, `run` loads a save into its own folder, so the save itself is never touched and every
// run starts from the same rows. A run: boot, warm-up, heap dump, window, heap dump, stop.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const SavedGames = require('../saved-games');

const ROOT = path.resolve(__dirname, '..', '..');
const PERF_DIR = path.join(ROOT, 'tmp', 'perf');
const pad = (value) => String(value).padStart(2, '0');
const stamp = (date = new Date()) => `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const say = (text) => console.log(`perf :: ${text}`);

const savesDir = (flags) => path.resolve(ROOT, flags.saves || path.join(process.env.L2NODE_RUNTIME_DIR || 'tmp', 'saves'));

function geodataDir() {
    const dir = path.resolve(process.env.L2NODE_GEODATA_DIR || path.join(ROOT, 'data', 'Geodata'));
    if (!fs.existsSync(path.join(dir, '.l2solo-geodata-manifest.json'))) {
        throw new Error(`no geodata in ${dir}: start the server once with npm start, or set L2NODE_GEODATA_DIR`);
    }
    return dir;
}

function commit() {
    try {
        const sha = execFileSync('git', ['rev-parse', '--short=9', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
        const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: ROOT, encoding: 'utf8' }).trim() !== '';
        return { sha, dirty };
    } catch {
        return { sha: 'nogit', dirty: false };
    }
}

function botCounts(databasePath) {
    try {
        const db = new DatabaseSync(databasePath, { readOnly: true });
        try {
            return Object.fromEntries(db.prepare('SELECT phase, COUNT(*) AS n FROM bot_life_state GROUP BY phase').all()
                .map(row => [row.phase, row.n]));
        } finally { db.close(); }
    } catch {
        return {};
    }
}

function writeIni(dir, perf) {
    const lines = ['[Database]', `path = ${path.join(dir, 'world.sqlite')}`, '', '[AuthServer]', 'port = 0', '',
        '[GameServer]', 'port = 0', '', '[WorldObserver]', 'enabled = true', 'hostname = 127.0.0.1', 'port = 0', '',
        '[General]', 'progressionPreset = x50', '', '[Perf]', ...Object.entries(perf).map(([key, value]) => `${key} = ${value}`)];
    const file = path.join(dir, 'server.ini');
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    return file;
}

// The game server itself (src/NodeL2), with this folder's ini instead of config/local.ini.
function startServer(dir, env) {
    const log = fs.createWriteStream(path.join(dir, 'server.log'));
    const child = spawn(process.execPath, ['--openssl-legacy-provider', 'src/NodeL2'], {
        cwd: ROOT,
        env: { ...process.env, L2NODE_CONFIG_FILE: path.join(dir, 'server.ini'), L2NODE_GEODATA_DIR: geodataDir(),
            BOT_POPULATION_ENABLED: '1', NODEL2_DEV_CONSOLE: '0', ...env },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
    return { child, exited, alive: () => child.exitCode === null && child.signalCode === null };
}

// SIGINT is the server's own shutdown (state flushed, database closed); it force-exits by 15 s.
async function stopServer(server) {
    if (!server.alive()) return server.exited;
    server.child.kill('SIGINT');
    const code = await Promise.race([server.exited, sleep(60000).then(() => 'timeout')]);
    if (code !== 'timeout') return code;
    server.child.kill('SIGKILL');
    return server.exited;
}

function logTail(dir) {
    try { return fs.readFileSync(path.join(dir, 'server.log'), 'utf8').split('\n').slice(-20).join('\n'); } catch { return ''; }
}

// Waits while the server lives; a server that dies early ends the run with its log.
async function hold(server, dir, ms, label) {
    for (const end = Date.now() + ms; Date.now() < end;) {
        if (!server.alive()) throw new Error(`the server exited during ${label}:\n${logTail(dir)}`);
        await sleep(Math.min(5000, end - Date.now()));
    }
}

// A capture through the recorder's request file; resolves when the recorder wrote request.done.json
// (every thread it asked has written), whatever the number of threads.
async function capture(dir, kind, server, timeoutMs = 90000) {
    const file = path.join(dir, 'request.json'), done = path.join(dir, 'request.done.json');
    fs.rmSync(done, { force: true });
    fs.writeFileSync(file, `${JSON.stringify({ kind })}\n`);
    for (let waited = 0; waited < timeoutMs && !fs.existsSync(done) && server.alive(); waited += 500) await sleep(500);
    if (!fs.existsSync(done)) throw new Error(`the recorder did not finish ${kind} in ${Math.round(timeoutMs / 1000)} s`);
}

// Heap dumps of every sampled thread at a window's edge.
const dumpHeaps = (dir, server) => capture(dir, 'heap', server);

async function prepare(flags) {
    geodataDir();
    const minutes = Number(flags.minutes || 60);
    if (!(minutes > 0)) throw new Error('Use --minutes=<number>');
    const dir = path.join(PERF_DIR, `prepare-${stamp()}`);
    fs.mkdirSync(dir, { recursive: true });
    writeIni(dir, { live: false });
    say(`growing a world for ${minutes} min at x50 in ${path.relative(ROOT, dir)} (the population grows in waves as bots level)`);
    // Seeding as fast as the wave rule allows (it waits for the mean level, not for this delay).
    const server = startServer(dir, { BOT_POPULATION_BATCH_SIZE: '100', BOT_POPULATION_SEED_DELAY_MS: '1000' });
    for (let left = minutes; left > 0; left -= 5) {
        await hold(server, dir, Math.min(5, left) * 60000, 'prepare');
        say(`${Math.round(minutes - left + Math.min(5, left))} min: bots ${JSON.stringify(botCounts(path.join(dir, 'world.sqlite')))}`);
    }
    await stopServer(server);
    const bots = botCounts(path.join(dir, 'world.sqlite'));
    const save = await SavedGames.run({ operation: 'create', databasePath: path.join(dir, 'world.sqlite'), savesDir: savesDir(flags),
        name: flags.name || `perf world x50 ${minutes} min ${JSON.stringify(bots)}` });
    fs.rmSync(dir, { recursive: true, force: true });
    say(`saved ${save.id} (${save.name}); run it with: node scripts/perf.js run --save=${save.id}`);
}

async function run(flags) {
    geodataDir();
    const scenario = flags.scenario || 'cold';
    if (!['cold', 'hot', 'script'].includes(scenario)) throw new Error('Use --scenario=cold|hot|script');
    const script = scenario === 'script' ? path.resolve(ROOT, String(flags.script || '')) : null;
    if (scenario === 'script' && (!flags.script || !fs.existsSync(script))) throw new Error('Use --scenario=script --script=<tests/e2e/name.js>');
    if (!flags.save) throw new Error('Use --save=<id> (node scripts/perf.js saves lists them)');
    const warmup = Number(flags.warmup || 5), minutes = Number(flags.minutes || 10);
    if (!(warmup >= 0) || !(minutes > 0)) throw new Error('Use --warmup=<min> --minutes=<min>');
    // The transition counters and timings live in PopulationMetrics behind developerDiagnostics: on
    // by default for hot (--diagnostics=false turns it off), off for cold.
    const diagnostics = flags.diagnostics === undefined ? scenario === 'hot' : flags.diagnostics !== 'false';
    const crowd = scenario === 'hot' ? { players: Number(flags.players || 1), route: Number(flags.route || 0),
        routeMinutes: Number(flags['route-minutes'] || 3) } : null;
    const { sha, dirty } = commit();
    const name = script ? `script-${path.basename(script, '.js')}` : scenario;
    const dir = path.join(PERF_DIR, 'runs', `${sha}${dirty ? '+' : ''}-${name}-${stamp()}`);
    fs.mkdirSync(dir, { recursive: true });
    const save = await SavedGames.run({ operation: 'load', databasePath: path.join(dir, 'world.sqlite'), savesDir: savesDir(flags), id: flags.save });
    const bots = botCounts(path.join(dir, 'world.sqlite'));
    // Every chunk kept (keepProfileMs 0): the report adds up where the window's CPU went. Heap dumps
    // only at the window's edges.
    writeIni(dir, { live: true, dir, keepProfileMs: 0, keepProfilesPerDay: 100000, heapEveryMinutes: 100000 });
    const meta = { sha, dirty, scenario, save: { id: flags.save, name: save.name }, bots, warmupMinutes: warmup,
        windowMinutes: minutes, diagnostics, crowd, script: script && path.relative(ROOT, script), node: process.version,
        // The machine: runs of two machines do not compare (compare says so); load at the start shows a busy one.
        host: os.hostname(), cpus: `${os.cpus().length}x ${os.cpus()[0]?.model || '?'}`, loadAtStart: +os.loadavg()[0].toFixed(2),
        startedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(dir, 'run.json'), `${JSON.stringify(meta, null, 2)}\n`);
    say(`${path.relative(ROOT, dir)}: ${save.name}, bots ${JSON.stringify(bots)}; ${warmup} min warm-up, ${minutes} min window`);
    // No seeding: the world is the save's, the same rows in every run.
    const server = startServer(dir, { BOT_POPULATION_SEED_DELAY_MS: String(86400000), L2NODE_PERF_SCENARIO: scenario,
        ...(script ? { L2NODE_PERF_SCRIPT: script } : {}),
        ...(diagnostics ? { BOT_DEVELOPER_DIAGNOSTICS: '1' } : {}),
        ...(crowd ? { L2NODE_PERF_PLAYERS: String(crowd.players), L2NODE_PERF_ROUTE: String(crowd.route),
            L2NODE_PERF_ROUTE_MINUTES: String(crowd.routeMinutes) } : {}) });
    try {
        await hold(server, dir, warmup * 60000, 'warm-up');
        await dumpHeaps(dir, server);
        meta.windowStart = new Date().toISOString();
        say('window open');
        // A script plays inside the window: the runner asks for it now and the window closes when it is
        // done (at most --minutes).
        if (script) await capture(dir, 'script', server, minutes * 60000).catch(error => say(`script: ${error.message}`));
        else await hold(server, dir, minutes * 60000, 'the window');
        meta.windowEnd = new Date().toISOString();
        await dumpHeaps(dir, server);
        say('window closed; stopping the server');
    } finally {
        meta.exitCode = await stopServer(server);
        fs.writeFileSync(path.join(dir, 'run.json'), `${JSON.stringify(meta, null, 2)}\n`);
        // The world after the run is the save plus the window's play: hundreds of MB of a full
        // world per run, needed only to debug the run itself (--keep-world).
        if (!flags['keep-world']) {
            for (const name of fs.readdirSync(dir)) if (/^world\..*sqlite/.test(name)) fs.rmSync(path.join(dir, name), { force: true });
        }
    }
    return dir;
}

module.exports = { prepare, run, savesDir, stamp, PERF_DIR };
