'use strict';
// Reads the decision trace (src/GameServer/Bot/DecisionTrace.js; `[BotPopulation] decisionTrace = true`), the files
// logs/decision-trace.jsonl(.1-.7) next to the world database (default tmp/logs).
//   node scripts/trace.js --bot <id> [--since <minutes>]   a bot's timeline: situations, stops, decisions, deaths,
//                                                          its parties, meetings (either side), clan errands, raids
//   node scripts/trace.js [--since <minutes>]              the summary: which situation woke which decision and how
//                                                          often its answer moved, deaths by killer, restarts, failures,
//                                                          lifecycle events (party, meeting, errand, raid) by outcome
// --dir <logs directory>; --json prints the summary as JSON.
const fs = require('node:fs');
const path = require('node:path');
const { FILES } = require('../src/DecisionTraceWriter');

function args(argv) {
    const out = { dir: 'tmp/logs', bot: null, since: null, json: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--json') out.json = true;
        else if (['--dir', '--bot', '--since'].includes(arg)) out[arg.slice(2)] = argv[++i];
        else throw new Error(`unknown argument ${arg}`);
    }
    out.bot = out.bot === null ? null : Number(out.bot);
    out.since = out.since === null ? null : Date.now() - Number(out.since) * 60000;
    return out;
}

// Every record, oldest file first, in time order; headers and broken lines skipped.
function records(dir, since) {
    const base = path.join(dir, 'decision-trace.jsonl'), rows = [];
    for (let index = FILES - 1; index >= 0; index--) {
        const file = base + (index ? `.${index}` : '');
        if (!fs.existsSync(file)) continue;
        for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
            if (!line) continue;
            let row;
            try { row = JSON.parse(line); } catch { continue; }
            if (row.type || (since !== null && row.at < since)) continue;
            rows.push(row);
        }
    }
    return rows.sort((a, b) => a.at - b.at);
}

const LIFECYCLE = new Set(['party', 'meeting', 'errand', 'raid']);
// A lifecycle event's name: kind, phase, outcome and reason (the summary's key).
const event = row => `${row.kind} ${row.phase}${row.outcome ? ` ${row.outcome}` : ''}${row.reason ? ` (${row.reason})` : ''}`;
const time = at => new Date(at).toISOString().slice(5, 23).replace('T', ' ');
function line(row) {
    switch (row.kind) {
    case 'raise': return `${row.name}@${row.place}${row.reason ? ` (${row.reason})` : ''}`
        + `${row.woke ? ` → wakes ${row.woke}` : ''}${row.waits ? ` → waits ${row.waits}` : ''}`;
    case 'stop': return `stop@${row.place} → wakes ${row.woke}`;
    case 'decided': return `${row.decision} ${row.how} by ${row.caller}: ${row.answer ?? '-'}${row.was !== undefined && row.was !== row.answer ? ` (was ${row.was})` : ''}`;
    case 'death': return `died at ${row.spot || '?'} to ${row.killer}${row.level ? ` (level ${row.level})` : ''}`;
    case 'restart': return `${row.worker} worker restarted: ${row.reason}`;
    case 'failure': return `failure ${row.site}`;
    case 'party': case 'meeting': case 'errand': case 'raid': return `${event(row)}${row.party ? ` ${row.party}` : ''}`
        + `${row.kind === 'meeting' ? ` ${row.bot}<->${row.target}` : ''}${row.npcId ? ` boss ${row.npcId}` : ''}${row.item ? ` item ${row.item}` : ''}`;
    default: return `${row.phase || row.kind} ${row.reason || ''} ${row.caller || ''}`.trim();
    }
}

// Which situations woke each decision: a raise or stop that woke it waits, per bot, for the decision's next record.
function summary(rows) {
    const pending = new Map(), pairs = {}, decisions = {}, deaths = {}, restarts = {}, failures = {}, lifecycle = {};
    const add = (table, key) => { table[key] = (table[key] || 0) + 1; };
    for (const row of rows) {
        const bot = row.bot || 0;
        if ((row.kind === 'raise' || row.kind === 'stop') && row.woke) {
            const waiting = pending.get(bot) || pending.set(bot, new Map()).get(bot);
            for (const decision of row.woke.split(',')) (waiting.get(decision) || waiting.set(decision, []).get(decision))
                .push(row.kind === 'stop' ? `stop@${row.place}` : `${row.name}@${row.place}`);
        } else if (row.kind === 'decided') {
            const woke = pending.get(bot)?.get(row.decision) || [];
            pending.get(bot)?.delete(row.decision);
            const moved = row.was !== undefined && row.answer !== row.was ? 'moved' : 'kept';
            const entry = decisions[row.decision] ||= { taken: 0, unwoken: 0, moved: 0 };
            entry[row.how === 'unwoken' ? 'unwoken' : 'taken']++;
            if (moved === 'moved') entry.moved++;
            for (const cause of woke.length ? new Set(woke) : [row.how === 'unwoken' ? `unwoken:${row.caller}` : 'none'])
                add(pairs, `${cause} → ${row.decision} (${moved})`);
        } else if (row.kind === 'death') add(deaths, row.killer);
        else if (row.kind === 'restart') add(restarts, `${row.worker}:${row.reason}`);
        else if (row.kind === 'failure') add(failures, row.site);
        else if (LIFECYCLE.has(row.kind)) add(lifecycle, event(row));
    }
    const bots = new Set(rows.map(row => row.bot).filter(Boolean)).size;
    const hours = rows.length > 1 ? (rows[rows.length - 1].at - rows[0].at) / 3600000 : 0;
    return { records: rows.length, bots, hours, decisions, pairs, deaths, restarts, failures, lifecycle };
}

function print(result) {
    const perBotHour = n => result.bots && result.hours ? (n / result.bots / result.hours).toFixed(2) : '-';
    console.log(`${result.records} records, ${result.bots} bots, ${result.hours.toFixed(2)} h`);
    console.log('\ndecision: taken / unwoken / answer moved (per bot-hour taken)');
    for (const [decision, row] of Object.entries(result.decisions))
        console.log(`  ${decision}: ${row.taken} / ${row.unwoken} / ${row.moved} (${perBotHour(row.taken)})`);
    const sorted = table => Object.entries(table).sort((a, b) => b[1] - a[1]);
    console.log('\nsituation → decision (answer):');
    for (const [pair, n] of sorted(result.pairs)) console.log(`  ${String(n).padStart(7)}  ${pair}`);
    for (const [title, table] of [['deaths by killer', result.deaths], ['worker restarts', result.restarts], ['failures', result.failures],
        ['lifecycle (party, meeting, errand, raid)', result.lifecycle]]) {
        if (!Object.keys(table).length) continue;
        console.log(`\n${title}:`);
        for (const [key, n] of sorted(table)) console.log(`  ${String(n).padStart(7)}  ${key}`);
    }
}

function main() {
    const options = args(process.argv.slice(2));
    const rows = records(options.dir, options.since);
    if (options.bot !== null) {
        for (const row of rows) if (row.bot === options.bot || row.kind === 'meeting' && row.target === options.bot) console.log(`${time(row.at)} ${row.thread.padEnd(6)} ${line(row)}`);
        return;
    }
    const result = summary(rows);
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else print(result);
}

if (require.main === module) main();
module.exports = { records, summary, line };
