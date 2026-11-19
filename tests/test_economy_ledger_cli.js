'use strict';
// The economy ledger over a perf run folder: it finds the run's save, reads
// both worlds read-only, closes the money, refuses another world's start and a
// missing column by name, and compares against an older ledger.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'scripts/economy/ledger.js');
const HOUR = 60 * 60 * 1000;
const T0 = 500000 * HOUR + 10 * 60 * 1000;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'economy-ledger-'));
const savesRoot = path.join(dir, 'saves');
const saveDir = path.join(savesRoot, 'save-1');
const runDir = path.join(dir, 'run-1');
fs.mkdirSync(saveDir, { recursive: true });
fs.mkdirSync(runDir);

// Only the columns the ledger reads.
const WORLD = `
    CREATE TABLE bot_life_state (characterId INTEGER, accountName TEXT, level INTEGER, exp INTEGER, activity TEXT, locX INTEGER, locY INTEGER, locZ INTEGER);
    CREATE TABLE items (characterId INTEGER, selfId INTEGER, amount INTEGER);
    CREATE TABLE warehouse_items (characterId INTEGER, selfId INTEGER, amount INTEGER);
    CREATE TABLE account_warehouse_items (selfId INTEGER, amount INTEGER);
    CREATE TABLE clan_warehouse_items (selfId INTEGER, amount INTEGER);
    CREATE TABLE afk_trade_shops (id INTEGER, ownerId INTEGER, storeType INTEGER, status TEXT, town TEXT, kind TEXT, escrowAdena INTEGER, custodyPolicy INTEGER);
    CREATE TABLE afk_trade_lines (shopId INTEGER, selfId INTEGER, count INTEGER, createdAt INTEGER);
    CREATE TABLE clan_hall_bids (amount INTEGER);
    CREATE TABLE board_trade_meeting_lines (selfId INTEGER, heldCount INTEGER);
    CREATE TABLE board_trade_meetings (escrowA INTEGER, escrowB INTEGER, routeReserveA INTEGER, routeReserveB INTEGER);
    CREATE TABLE board_settlements (ownerId INTEGER, selfId INTEGER, amount INTEGER);
    CREATE TABLE character_recipes (characterId INTEGER, recipeId INTEGER);`;
const HISTORY = `
    CREATE TABLE economy_flow_hour (hour INTEGER, operation TEXT, store TEXT, selfId INTEGER, delta INTEGER, events INTEGER);
    CREATE TABLE market_trades (occurredAt INTEGER, channel TEXT, selfId INTEGER, quantity INTEGER, unitPrice INTEGER, totalPrice INTEGER,
        sellerCharacterId INTEGER, buyerCharacterId INTEGER, eventKey TEXT, sourceType TEXT);
    CREATE TABLE bot_life_events (characterId INTEGER, eventType TEXT, createdAt INTEGER, metaJson TEXT);
    CREATE TABLE history_meta (key TEXT, value TEXT);`;

function build(file, schema, statements) {
    const db = new DatabaseSync(file);
    db.exec(schema);
    db.exec(statements);
    db.close();
}

const flowSql = (hour, operation, store, delta) => `INSERT INTO economy_flow_hour VALUES (${hour}, '${operation}', '${store}', 57, ${delta}, 1);`;
const hour0 = Math.floor(T0 / HOUR);
const bots = (level, exp) => `INSERT INTO bot_life_state VALUES (1, 'bot_a', ${level}, ${exp}, 'hunting', -84000, 244000, -3700),
    (2, 'bot_craft_1', 70, 0, 'crafting', -84000, 244000, -3700), (3, 'bot_m', 30, 0, 'merchant', -84000, 244000, -3700);`;

function writeWorlds({ endToken = 'world-a' } = {}) {
    for (const file of fs.readdirSync(saveDir)) fs.rmSync(path.join(saveDir, file));
    for (const file of fs.readdirSync(runDir)) fs.rmSync(path.join(runDir, file));
    build(path.join(saveDir, 'database.sqlite'), WORLD, `${bots(25, 1000)} INSERT INTO items VALUES (1, 57, 1000);`);
    // The save's own history: an hour before the run (ignored) and nothing at the run's hours.
    build(path.join(saveDir, 'history.sqlite'), HISTORY, `INSERT INTO history_meta VALUES ('worldToken', 'world-a');
        ${flowSql(hour0 - 5, 'inventory:sync-summary:resolve', 'inventory', 777)}`);
    build(path.join(runDir, 'world.sqlite'), WORLD, `${bots(26, 4000)} INSERT INTO items VALUES (1, 57, 1500), (1, 1463, 150);
        INSERT INTO afk_trade_shops VALUES (9, 1, 1, 'active', 'Gludio', 'shop', 100, 0);`);
    // The run's history: retention pruned the save's old hour; the run's own hours follow.
    build(path.join(runDir, 'world.history.sqlite'), HISTORY, `INSERT INTO history_meta VALUES ('worldToken', '${endToken}');
        ${flowSql(hour0, 'inventory:sync-summary:npc_liquidation', 'inventory', 900)}
        ${flowSql(hour0, 'bot:npc-purchase', 'inventory', -300)}
        ${flowSql(hour0, 'afk-trade:create', 'inventory', -100)}
        ${flowSql(hour0, 'afk-trade:create', 'afk_escrow', 100)}
        INSERT INTO market_trades VALUES (${T0 + HOUR / 2}, 'static_wtb', 1864, 10, 70, 700, 1, NULL, 'static:1', 'static_buy_store'),
            (${T0 + HOUR / 2}, 'npc_buy', 1463, 150, 2, 300, NULL, 1, 'npc:1', 'npc');`);
    fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ sha: 'abc1234', save: { id: 'save-1' },
        startedAt: new Date(T0).toISOString(), windowStart: new Date(T0 + HOUR / 4).toISOString(), windowEnd: new Date(T0 + HOUR).toISOString() }));
}

const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
const inputFiles = () => [path.join(saveDir, 'database.sqlite'), path.join(saveDir, 'history.sqlite'), path.join(runDir, 'world.sqlite'), path.join(runDir, 'world.history.sqlite')];
const fingerprint = () => inputFiles().map((file) => `${fs.statSync(file).mtimeMs}:${fs.readFileSync(file).toString('base64')}`);

try {
    writeWorlds();
    const before = fingerprint();
    const result = run('--run', runDir, '--saves', savesRoot, '--json');
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout);
    // The money closes: +500 in the inventory, +100 escrow, against a journal net of +600.
    assert.equal(out.money.closureGap, 0);
    assert.equal(out.money.journalNet, 600);
    // A hunter and a station crafter over the hour; the merchant is scenery.
    assert.equal(out.population.bots, 2);
    assert.deepEqual(Object.keys(out.population.bands), ['d', 'station']);
    assert.equal(out.window.hours, 1);
    assert.equal(out.window.warmupIncluded, true);
    assert.match(out.window.endBasis, /windowEnd/);
    // The run end is one rule for every flow: there is no --to to move it.
    const withTo = run('--run', runDir, '--saves', savesRoot, '--to', '2020-01-01');
    assert.equal(withTo.status, 1);
    assert.match(withTo.stderr, /unknown or incomplete argument --to/);
    assert.equal(out.flows.totals.fixedBuyers, 700);
    assert.equal(out.flows.totals.npcSales, 200);
    assert.equal(out.flows.totals.huntCold, 0);
    assert.equal(out.progress.stageBands['20-29'].expPerBotHour, 3000);
    assert.deepEqual(out.shots.coverage.find((row) => row.grade === 'd'), { grade: 'd', region: out.shots.coverage[0].region, bots: 1, holdingAny: 1, holding100: 1 });
    assert.equal(out.inputs.start.saveId, 'save-1');
    assert.equal(out.inputs.end.sha, 'abc1234');
    assert.match(out.inputs.start.sha256.db, /^[0-9a-f]{64}$/);
    // The inputs are opened read-only: bytes and modification times unchanged.
    assert.deepEqual(fingerprint(), before);

    // Compared against an older ledger: each changed number with its change.
    const old = structuredClone(out);
    old.flows.perBotHour.fixedBuyers = 175;
    fs.writeFileSync(path.join(dir, 'old.json'), JSON.stringify(old));
    const against = run('--run', runDir, '--saves', savesRoot, '--against', path.join(dir, 'old.json'));
    assert.equal(against.status, 0, against.stderr);
    assert.match(against.stdout, /flows\.perBotHour\.fixedBuyers 175 -> 350 \(\+100\.0 %\)/);
    assert.doesNotMatch(against.stdout, /flows\.perBotHour\.npcSales/);

    // A start from another world is refused by name.
    writeWorlds({ endToken: 'world-b' });
    const mismatch = run('--run', runDir, '--saves', savesRoot, '--json');
    assert.equal(mismatch.status, 1);
    assert.match(mismatch.stderr, /different worlds: worldToken world-a against world-b/);

    // A column the ledger reads is missing: it fails by name instead of reading around it.
    writeWorlds();
    const db = new DatabaseSync(path.join(runDir, 'world.sqlite'));
    db.exec('ALTER TABLE bot_life_state DROP COLUMN exp');
    db.close();
    const missing = run('--run', runDir, '--saves', savesRoot, '--json');
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /end world: table bot_life_state lacks column exp/);
} finally {
    fs.rmSync(dir, { recursive: true, force: true });
}

console.log('economy ledger cli ok');
