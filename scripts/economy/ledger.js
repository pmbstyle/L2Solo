#!/usr/bin/env node
'use strict';
// Economy ledger of one run, read from its databases (never written):
//   node scripts/economy/ledger.js --run <perf run folder> [--saves <saves dir>]
//   node scripts/economy/ledger.js --start <db> --start-history <db> --end <db> --end-history <db>
//        --from <ISO | epoch s | epoch ms>
//   node scripts/economy/ledger.js --save <save id | folder> [--saves <saves dir>]   (one world, no flows)
// Options: --json (the JSON on stdout), --out <file> (the JSON to a file), --against <old ledger JSON>.
// Every input is opened read-only: the WAL is read, never checkpointed.
const fs = require('node:fs');
const nodePath = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = nodePath.resolve(__dirname, '../..');
const Rules = require('./ledger-rules');

class LedgerError extends Error {}

// Owner column of each journal store that belongs to one character.
const OWNER_COLUMN = { items: 'characterId', warehouse_items: 'characterId', afk_trade_shops: 'ownerId', board_settlements: 'ownerId' };
const BOT_COLUMNS = ['characterId', 'accountName', 'level', 'exp', 'activity', 'locX', 'locY', 'locZ'];
const FLOW_COLUMNS = ['hour', 'operation', 'store', 'selfId', 'delta', 'events'];
const TRADE_COLUMNS = ['occurredAt', 'channel', 'selfId', 'quantity', 'unitPrice', 'totalPrice', 'sellerCharacterId', 'buyerCharacterId', 'eventKey', 'sourceType'];

function open(file) {
    if (!fs.existsSync(file)) throw new LedgerError(`missing input file ${file}`);
    return new DatabaseSync(file, { readOnly: true });
}

// A table or column the ledger reads is missing: fail by name, never read around it.
function need(db, label, table, columns) {
    const have = db.prepare('SELECT name FROM pragma_table_info(?)').all(table).map((row) => row.name);
    if (!have.length) throw new LedgerError(`${label}: table ${table} is missing`);
    const missing = columns.filter((column) => !have.includes(column));
    if (missing.length) throw new LedgerError(`${label}: table ${table} lacks column ${missing.join(', ')}`);
}

function readBots(db, label) {
    need(db, label, 'bot_life_state', BOT_COLUMNS);
    return db.prepare(`SELECT ${BOT_COLUMNS.join(', ')} FROM bot_life_state`).all();
}

// Adena in every store the economy journal watches, by owner where a store has one.
function readStock(db, label, stores) {
    const rows = [];
    for (const store of stores) {
        const owner = OWNER_COLUMN[store.table];
        const where = [];
        const columns = [store.column];
        if (owner) columns.push(owner);
        if (!store.adena) {
            columns.push(store.item);
            where.push(`${store.item} = ${Rules.ADENA}`);
        }
        if (store.sellLinesOnly) {
            columns.push('shopId');
            need(db, label, 'afk_trade_shops', ['id', 'storeType', 'custodyPolicy']);
            where.push('shopId IN (SELECT id FROM afk_trade_shops WHERE storeType = 1 AND custodyPolicy != 1)');
        }
        need(db, label, store.table, columns);
        const sql = `SELECT ${owner || 'NULL'} AS ownerId, SUM(${store.column}) AS adena FROM ${store.table}
            ${where.length ? `WHERE ${where.join(' AND ')}` : ''} GROUP BY 1`;
        for (const row of db.prepare(sql).all()) rows.push({ store: store.store, ownerId: row.ownerId, adena: Number(row.adena || 0) });
    }
    return rows;
}

function readFlows(db, label, fromHour) {
    need(db, label, 'economy_flow_hour', FLOW_COLUMNS);
    return db.prepare(`SELECT operation, store, selfId, SUM(delta) AS delta, SUM(events) AS events
        FROM economy_flow_hour WHERE hour >= ? GROUP BY operation, store, selfId`).all(fromHour);
}

// Canonical trades from the run's start to the end of the log: the journal is
// read to its end as well, so the channel splits cover the same deals.
function readTrades(db, label, t0, canonicalFilter) {
    need(db, label, 'market_trades', TRADE_COLUMNS);
    return db.prepare(`SELECT occurredAt, channel, selfId, quantity, unitPrice, totalPrice, sellerCharacterId, buyerCharacterId
        FROM market_trades WHERE occurredAt >= ? AND ${canonicalFilter} ORDER BY occurredAt`).all(t0);
}

// Shots held at the end by every character (the coverage of each grade band).
function readShots(db, label, shotIds) {
    need(db, label, 'items', ['characterId', 'selfId', 'amount']);
    return db.prepare(`SELECT characterId, selfId, SUM(amount) AS amount FROM items
        WHERE selfId IN (${shotIds.map(Number).join(', ')}) GROUP BY characterId, selfId`).all();
}

function readShops(db, label) {
    need(db, label, 'afk_trade_shops', ['town', 'kind', 'storeType', 'status']);
    return db.prepare('SELECT town, kind, storeType, status FROM afk_trade_shops').all();
}

// Bot buy lines still wanting units at the end, in open buy stores.
function readBuyLines(db, label) {
    need(db, label, 'afk_trade_lines', ['shopId', 'count', 'createdAt']);
    need(db, label, 'afk_trade_shops', ['id', 'storeType', 'status']);
    return db.prepare(`SELECT count, createdAt FROM afk_trade_lines WHERE count > 0
        AND shopId IN (SELECT id FROM afk_trade_shops WHERE storeType = 3 AND status = 'active')`).all();
}

function readRecipes(db, label) {
    need(db, label, 'character_recipes', ['characterId', 'recipeId']);
    return db.prepare('SELECT characterId, recipeId FROM character_recipes').all();
}

function readVisits(db, label, t0, t1) {
    need(db, label, 'bot_life_events', ['characterId', 'eventType', 'createdAt', 'metaJson']);
    return db.prepare(`SELECT characterId, json_extract(metaJson, '$.townName') AS town FROM bot_life_events
        WHERE eventType = 'arrived_town' AND createdAt >= ? AND createdAt <= ?`).all(t0, t1);
}

function parseTime(value, flag) {
    const text = String(value || '').trim();
    const ms = /^\d+$/.test(text) ? (Number(text) < 1e11 ? Number(text) * 1000 : Number(text)) : Date.parse(text);
    if (!Number.isFinite(ms)) throw new LedgerError(`${flag}: not a time: ${value}`);
    return ms;
}

function parseArgs(argv) {
    const args = { json: false };
    const valued = new Set(['--start', '--start-history', '--end', '--end-history', '--from', '--run', '--save', '--saves', '--out', '--against']);
    for (let at = 0; at < argv.length; at++) {
        const flag = argv[at];
        if (flag === '--json') args.json = true;
        else if (valued.has(flag) && at + 1 < argv.length) args[flag.slice(2)] = argv[++at];
        else throw new LedgerError(`unknown or incomplete argument ${flag}`);
    }
    for (const flag of ['start', 'start-history', 'end', 'end-history', 'run', 'saves', 'out', 'against']) {
        if (args[flag]) args[flag] = nodePath.resolve(args[flag]);
    }
    if (args.save && fs.existsSync(args.save)) args.save = nodePath.resolve(args.save);
    args.saves ||= nodePath.join(ROOT, 'tmp/saves');
    return args;
}

function readJson(file, what) {
    if (!fs.existsSync(file)) throw new LedgerError(`missing ${what} ${file}`);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function saveFolder(id, savesRoot) {
    return fs.existsSync(id) && fs.statSync(id).isDirectory() ? nodePath.resolve(id) : nodePath.join(savesRoot, id);
}

// A perf run folder: the end is its world copies, the start the save it ran
// from, the window opens at startedAt (the hourly journal cannot cut the warmup).
function runInput(args) {
    const run = readJson(nodePath.join(args.run, 'run.json'), 'run file');
    if (!run.save?.id) throw new LedgerError(`${args.run}/run.json names no save`);
    const save = saveFolder(run.save.id, args.saves);
    return {
        files: { start: nodePath.join(save, 'database.sqlite'), startHistory: nodePath.join(save, 'history.sqlite'),
            end: nodePath.join(args.run, 'world.sqlite'), endHistory: nodePath.join(args.run, 'world.history.sqlite') },
        t0: parseTime(run.startedAt, 'run.json startedAt'),
        windowEnd: run.windowEnd ? parseTime(run.windowEnd, 'run.json windowEnd') : null,
        warmupIncluded: true,
        meta: { start: { saveId: run.save.id }, end: { runFolder: args.run, sha: run.sha || null, windowStart: run.windowStart || null, windowEnd: run.windowEnd || null } }
    };
}

function explicitInput(args) {
    for (const flag of ['start', 'start-history', 'end', 'end-history', 'from']) {
        if (!args[flag]) throw new LedgerError(`--${flag} is required (or --run <perf run folder>, or --save <id>)`);
    }
    return {
        files: { start: args.start, startHistory: args['start-history'], end: args.end, endHistory: args['end-history'] },
        t0: parseTime(args.from, '--from'), windowEnd: null, warmupIncluded: false, meta: { start: {}, end: {} }
    };
}

function sha256(file) {
    const hash = require('node:crypto').createHash('sha256');
    const handle = fs.openSync(file, 'r');
    const chunk = Buffer.alloc(1 << 22);
    try {
        for (let read; (read = fs.readSync(handle, chunk, 0, chunk.length, null)) > 0;) hash.update(chunk.subarray(0, read));
    } finally {
        fs.closeSync(handle);
    }
    return hash.digest('hex');
}

function worldToken(db, label) {
    need(db, label, 'history_meta', ['key', 'value']);
    const row = db.prepare("SELECT value FROM history_meta WHERE key = 'worldToken'").get();
    if (!row?.value) throw new LedgerError(`${label}: history_meta holds no worldToken`);
    return row.value;
}

// Grade of each shot id: the owner lists soulshots, spiritshots and blessed
// spiritshots in wear order (none, D .. S), the beginner shots are no-grade.
function shotGrades(ShotStock, grades) {
    const byId = new Map();
    for (const ids of [ShotStock.SOULSHOT_IDS, ShotStock.SPIRITSHOT_IDS, ShotStock.BLESSED_SPIRITSHOT_IDS]) ids.forEach((id, at) => byId.set(Number(id), grades[at]));
    for (const id of ShotStock.SHOT_IDS) if (!byId.has(Number(id))) byId.set(Number(id), 'none');
    return byId;
}

function loadOwners() {
    process.chdir(ROOT);
    require(nodePath.join(ROOT, 'src/Global'));
    const DataCache = invoke('GameServer/DataCache');
    // The datapack's progress line goes to stderr: stdout is the report.
    const info = console.info;
    console.info = (...line) => process.stderr.write(`${require('node:util').format(...line)}\n`);
    try {
        DataCache.init({ validate: false });
    } finally {
        console.info = info;
    }
    const templates = invoke('GameServer/Item/ItemTemplateIndex').currentLastIndex(DataCache.items);
    const ShotStock = invoke('GameServer/Inventory/ShotStock');
    const Recipes = invoke('GameServer/Items/C4RecipeItems');
    const { npcBuyPrice } = invoke('GameServer/Items/NpcSellRules');
    const shotGrade = shotGrades(ShotStock, invoke('GameServer/Bot/AI/GearGradeRule').GRADES);
    const gradeOf = (selfId) => shotGrade.get(Number(selfId)) || String(templates.get(Number(selfId))?.etc?.rank || 'none').toLowerCase();
    const fact = (selfId) => {
        const row = templates.get(Number(selfId));
        const ref = Number(row?.template?.price || 0);
        const fact = { ref, npcPrice: npcBuyPrice(ref), cls: Rules.itemClass(row?.template), grade: gradeOf(selfId) };
        const recipe = fact.cls === 'recipe' ? Recipes.resolve(selfId) : null;
        if (recipe) fact.productGrade = gradeOf(recipe.productId);
        return fact;
    };
    const TownRespawn = invoke('GameServer/World/TownRespawn');
    return {
        stores: invoke('EconomyJournal').STORES,
        canonicalFilter: invoke('MarketTradeOverview').CANONICAL_FILTER,
        shotIds: ShotStock.SHOT_IDS,
        items: (selfIds) => Object.fromEntries([...new Set(selfIds.map(Number))].map((selfId) => [selfId, fact(selfId)])),
        recipeGrade: (recipeId) => {
            const recipe = Recipes.resolveByRecipeId(recipeId);
            return recipe ? gradeOf(recipe.productId) : 'none';
        },
        region: (bot) => TownRespawn.getClosestTown(Number(bot.locX), Number(bot.locY), Number(bot.locZ))?.name || '?'
    };
}

function readInput(source, args, owners) {
    const { files } = source;
    const db = Object.fromEntries(Object.entries(files).map(([name, file]) => [name, open(file)]));
    try {
        const token = worldToken(db.startHistory, 'start history');
        const endToken = worldToken(db.endHistory, 'end history');
        if (token !== endToken) throw new LedgerError(`start and end are different worlds: worldToken ${token} against ${endToken}`);
        const t0 = source.t0;
        const fromHour = Math.floor(t0 / Rules.HOUR_MS);
        const trades = readTrades(db.endHistory, 'end history', t0, owners.canonicalFilter);
        // The journal and the trade log run to the end of the recording, so the run ends there too: the later of the run's windowEnd and the last trade.
        const t1 = Math.max(source.windowEnd || 0, Number(trades.at(-1)?.occurredAt || 0));
        if (!t1) throw new LedgerError('no trade after the start and no run windowEnd: the run end is unknown');
        const flowRows = Rules.netFlows(readFlows(db.endHistory, 'end history', fromHour), readFlows(db.startHistory, 'start history', fromHour));
        const shotRows = readShots(db.end, 'end world', owners.shotIds);
        const recipesStart = readRecipes(db.start, 'start world');
        const recipesEnd = readRecipes(db.end, 'end world');
        const described = (side, db, history) => ({ db, history, ...source.meta[side], sha256: { db: sha256(db), history: sha256(history) } });
        return {
            inputs: { start: described('start', files.start, files.startHistory), end: described('end', files.end, files.endHistory), worldToken: token },
            window: { t0, t1, warmupIncluded: source.warmupIncluded, endBasis: 'later of run.json windowEnd and the last trade; the journal and trade log are read to the end of the log' },
            startBots: readBots(db.start, 'start world'),
            endBots: readBots(db.end, 'end world').map((bot) => ({ ...bot, region: owners.region(bot) })),
            flowRows,
            trades,
            stockStart: readStock(db.start, 'start world', owners.stores),
            stockEnd: readStock(db.end, 'end world', owners.stores),
            items: owners.items([...flowRows, ...trades, ...shotRows].map((row) => row.selfId)),
            shotRows,
            buyLines: readBuyLines(db.end, 'end world'),
            recipesStart,
            recipesEnd,
            recipeGrades: Object.fromEntries([...new Set(recipesEnd.map((row) => Number(row.recipeId)))].map((id) => [id, owners.recipeGrade(id)])),
            shopsStart: readShops(db.start, 'start world'),
            shopsEnd: readShops(db.end, 'end world'),
            visits: readVisits(db.endHistory, 'end history', t0, t1)
        };
    } finally {
        for (const handle of Object.values(db)) handle.close();
    }
}

function readSnapshot(args, owners) {
    const folder = saveFolder(args.save, args.saves);
    const file = nodePath.join(folder, 'database.sqlite');
    const db = open(file);
    try {
        const shotRows = readShots(db, 'save world', owners.shotIds);
        return {
            inputs: { save: { id: nodePath.basename(folder), db: file, sha256: sha256(file) } },
            endBots: readBots(db, 'save world').map((bot) => ({ ...bot, region: owners.region(bot) })),
            stockEnd: readStock(db, 'save world', owners.stores),
            items: owners.items(shotRows.map((row) => row.selfId)),
            shotRows,
            shopsEnd: readShops(db, 'save world')
        };
    } finally {
        db.close();
    }
}

const k = (adena) => `${(adena / 1e3).toFixed(1)}k`;
const M = (adena) => `${(adena / 1e6).toFixed(1)}M`;
const pct = (share, digits = 2) => `${(100 * share).toFixed(digits)} %`;
const pairs = (object, format) => Object.entries(object).map(([name, value]) => `${name} ${format(value)}`).join(' | ');

function formatText(out) {
    const lines = [];
    const { money, flows, trade, window: span, population } = out;
    const flag = Math.abs(money.closureGapShare) > 0.001 ? '  << CLOSURE GAP ABOVE 0.1 %' : '';
    lines.push(`CLOSURE stock ${M(money.stockStart)} -> ${M(money.stockEnd)} (delta ${M(money.delta)}), journal net ${M(money.journalNet)}, gap ${M(money.closureGap)} (${pct(money.closureGapShare)})${flag}`);
    lines.push(`WINDOW ${new Date(span.t0).toISOString()} .. ${new Date(span.t1).toISOString()} = ${(span.hours * 60).toFixed(1)} min (end: ${span.endBasis})${span.warmupIncluded ? ' (warmup included: the hourly journal cannot cut it)' : ''}`);
    lines.push(`POPULATION bots ${population.bots} (merchants ${population.merchants} apart), ${population.botHours.toFixed(0)} bot-h; bands ${pairs(population.bands, (b) => b.bots)}; stages ${pairs(population.stageBands, (n) => n)}`);
    lines.push(`FLOWS adena per bot-hour: ${pairs(flows.perBotHour, k)}`);
    lines.push(`  totals ${pairs(flows.totals, M)}; faucets ${M(flows.faucets)} sinks ${M(flows.sinks)} net ${M(flows.net)}; fixed buyers ${pct(flows.fixedBuyerShareOfFaucets, 1)} of faucets`);
    if (flows.unclassified.length) lines.push(`  unclassified operations: ${flows.unclassified.map((row) => `${row.operation} ${M(row.adena)}`).join('; ')}`);
    lines.push(`MONEY growth ${pct(money.growthPerHour)}/h (${money.growthBasis}); end stores ${pairs(money.byStore, M)}; Gini ${money.gini.start} -> ${money.gini.end}`);
    lines.push(`  per band (${money.bandsBasis}): ${pairs(money.bands, (b) => `n${b.bots} mean ${M(b.meanStart)} -> ${M(b.meanEnd)}, ${k(b.deltaPerBotHour)}/bot-h`)}`);
    lines.push(`TRADE channels ${pairs(trade.channels, (c) => `${c.deals} deals ${c.units} u ${M(c.adena)}`)}`);
    lines.push(`  bot-to-bot ${M(trade.botToBot.adena)} in ${trade.botToBot.deals} deals = ${k(trade.botToBot.perBotHour)}/bot-h; velocity ${pct(trade.velocityPerHour)}/h of mean stock; share of gross adena moved ${pct(trade.botToBotShareOfGross)}`);
    lines.push(`  per band (${trade.bandsBasis}, bot side, k/bot-h): ${pairs(trade.bands, (c) => Object.entries(c).map(([name, v]) => `${name} ${(v / 1e3).toFixed(0)}`).join(','))}`);
    const progress = out.progress;
    lines.push(`BOTS only at end ${out.bots.onlyAtEnd} (not in money deltas or progress), only at start ${out.bots.onlyAtStart}`);
    lines.push(`PROGRESS by ${progress.bandsBasis} (bots present at both ends)`);
    for (const [title, groups] of [['grade', progress.bands], ['stage', progress.stageBands]]) {
        for (const [name, g] of Object.entries(groups)) {
            lines.push(`  ${title} ${name.padEnd(6)} n${g.bots} exp ${(g.expPerBotHour / 1e3).toFixed(0)}k/bot-h, level-ups ${g.levelUps}, in ${g.bandEntries} out ${g.bandExits}, adena ${M(g.money.meanStart)} -> ${M(g.money.meanEnd)} (${k(g.money.deltaPerBotHour)}/bot-h); activity at end ${pairs(g.activityAtEnd, (n) => n)}`);
        }
    }
    lines.push(`  activity at end: ${pairs(progress.activityAtEnd, (n) => n)}`);
    lines.push('PRICES against datapack price (value index / median ratio / deals):');
    for (const [channel, rows] of Object.entries(Object.groupBy(out.prices, (row) => row.channel))) {
        lines.push(`  ${channel}: ${rows.slice(0, 12).map((row) => `${row.class}/${row.grade} ${row.valueIndex}/${row.medianRatio}/${row.deals}`).join(' | ')}`);
    }
    const bids = out.bids;
    lines.push(`BIDS fills ${bids.fills} (${bids.filledUnits} u); standing lines ${bids.standingLines} (${bids.standingUnits} u, ${bids.postedVisible} opened in the run); filled share ${pct(bids.filledShare)}`);
    const shots = out.shots;
    lines.push(`SHOTS used ${shots.used}, bought at NPC ${shots.boughtNpc}, from fixed sellers ${shots.boughtFixed}, crafted ${shots.crafted}, sold to NPC ${shots.soldNpc}`);
    lines.push(`  own-grade coverage (any / >=${shots.coverageThreshold.shots}, ours, of bots): ${shots.coverage.map((c) => `${c.grade} ${c.region} ${c.holdingAny}/${c.holding100} of ${c.bots}`).join(' | ')}`);
    lines.push('GOODS units (ref value M):');
    for (const row of out.goods) {
        lines.push(`  ${`${row.class}/${row.grade}`.padEnd(15)} ${Object.entries(row.refValue).map(([field, value]) => `${field} ${row[field]} (${M(value)})`).join(' ')}`);
    }
    const gear = out.gear, mats = out.materials, recipes = out.recipes;
    lines.push(`GEAR to NPC ${gear.toNpcUnits} u (ref ${M(gear.toNpcRef)}), bought at NPC ${gear.boughtNpcUnits} u, second-hand ${gear.secondHandDeals} deals ${gear.secondHandUnits} u`);
    lines.push(`MATERIALS to NPC ${mats.toNpcUnits} u for ${M(mats.toNpcValue)}; value lost against bot prices ${M(mats.leak)} over ${mats.unitsPriced} u; ${mats.unitsUnpriced} u without a bot price`);
    lines.push(`RECIPES dropped ${recipes.droppedTotal} (${pairs(recipes.dropped, (n) => n)}), hot unlabeled ${recipes.droppedHotUnlabeled}; learned ${recipes.learnedTotal} (${pairs(recipes.learned, (n) => n)})`);
    for (const side of ['start', 'end']) {
        lines.push(`STORES ${side}: ${pairs(out.stores[side], (t) => `shops ${t.shopSell}+${t.shopBuy} ads ${t.sellAd}+${t.buyAd}`)}`);
    }
    lines.push(`VISITS ${out.visits.perHour}/h (${out.visits.source}): ${out.visits.towns.slice(0, 10).map((t) => `${t.town} ${t.perHour} (${t.bots})`).join(' | ')}`);
    lines.push(`NOT COMPUTED: ${out.notComputed.map((row) => row.metric).join('; ')}`);
    return lines.join('\n');
}

function formatSnapshot(out) {
    const { money, population } = out;
    return [
        `SNAPSHOT ${out.inputs.save.id}: bots ${population.bots} (merchants ${population.merchants} apart); bands ${pairs(population.bands, (b) => b.bots)}; stages ${pairs(population.stageBands, (n) => n)}`,
        `MONEY stock ${M(money.stock)}; stores ${pairs(money.byStore, M)}; Gini ${money.gini}; per band ${pairs(money.bands, (b) => `n${b.bots} mean ${M(b.mean)}`)}`,
        `SHOTS own-grade coverage (any / >=100 of bots): ${out.shots.coverage.map((c) => `${c.grade} ${c.region} ${c.holdingAny}/${c.holding100} of ${c.bots}`).join(' | ')}`,
        `STORES ${pairs(out.stores, (t) => `shops ${t.shopSell}+${t.shopBuy} ads ${t.sellAd}+${t.buyAd}`)}`,
        `ACTIVITY ${pairs(out.activity, (n) => n)}`
    ].join('\n');
}

function formatComparison(file, rows) {
    const number = (value) => (value === null ? '-' : Number.isInteger(value) ? String(value) : value.toFixed(4));
    const changed = rows.filter((row) => row.change !== 0);
    return [`AGAINST ${file} (before -> after, change; ${rows.length - changed.length} numbers unchanged)`, ...changed.map((row) =>
        `  ${row.path} ${number(row.before)} -> ${number(row.after)}${row.change === null ? '' : ` (${row.change > 0 ? '+' : ''}${(100 * row.change).toFixed(1)} %)`}`)].join('\n');
}

function main(argv) {
    const args = parseArgs(argv);
    const owners = loadOwners();
    const out = args.save ? Rules.snapshot(readSnapshot(args, owners))
        : Rules.ledger(readInput(args.run ? runInput(args) : explicitInput(args), args, owners));
    out.generatedAt = new Date().toISOString();
    const json = `${JSON.stringify(out, null, 1)}\n`;
    if (args.out) fs.writeFileSync(args.out, json);
    let text = args.save ? formatSnapshot(out) : formatText(out);
    if (args.against) text += `\n${formatComparison(args.against, Rules.compare(readJson(args.against, 'ledger'), out))}`;
    process.stdout.write(args.json ? json : `${text}\n`);
}

if (require.main === module) {
    try {
        main(process.argv.slice(2));
    } catch (error) {
        if (!(error instanceof LedgerError)) throw error;
        process.stderr.write(`economy ledger: ${error.message}\n`);
        process.exitCode = 1;
    }
}

module.exports = { main, formatText, shotGrades, LedgerError };
