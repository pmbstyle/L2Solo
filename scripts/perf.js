#!/usr/bin/env node
'use strict';

// Reads what the live recorder ([Perf] live, src/Perf/LiveRecorder.js) writes, and asks a running
// server for a capture. Offline: nothing here touches the game.
//   node scripts/perf.js boots
//   node scripts/perf.js spikes [--boot=<name>] [--thread=main] [--top=20] [--sort=ms]
//   node scripts/perf.js timeline [--boot=<name>] [--every=60]   (minutes per row)
//   node scripts/perf.js capture cpu
//   node scripts/perf.js analyze <file.cpuprofile> [--long=50]

const fs = require('fs');
const path = require('path');
require('../src/Global');
const { settings } = require('../src/Perf/LiveRecorder');
const CpuProfile = require('../src/Perf/CpuProfile');

const ROOT = path.resolve(__dirname, '..');

function parse(argv) {
    const flags = {}, words = [];
    for (const arg of argv) {
        if (!arg.startsWith('--')) { words.push(arg); continue; }
        const [key, value = 'true'] = arg.slice(2).split('=', 2);
        flags[key] = value;
    }
    return { words, flags };
}

const liveDir = () => settings(options.default.Perf || {}).dir;

function boots() {
    const dir = liveDir();
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(name => /^\d{8}-\d{6}$/.test(name)).sort();
}

function bootDir(flags) {
    const name = flags.boot || boots().at(-1);
    if (!name) throw new Error(`no recorded boot in ${path.relative(ROOT, liveDir())}: set [Perf] live = true in config/local.ini`);
    const dir = path.join(liveDir(), name);
    if (!fs.existsSync(dir)) throw new Error(`no boot ${name} in ${path.relative(ROOT, liveDir())}`);
    return dir;
}

function readLines(file) {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(line => {
        try { return [JSON.parse(line)]; } catch { return []; }
    });
}

const time = (iso) => new Date(iso).toLocaleString('sv-SE').slice(0, 19);
const ms = (value) => `${Math.round(value)}`.padStart(6);

function printBoots() {
    const current = (() => {
        try { return JSON.parse(fs.readFileSync(path.join(liveDir(), 'current.json'), 'utf8')); } catch { return null; }
    })();
    for (const name of boots()) {
        const dir = path.join(liveDir(), name);
        const spikes = readLines(path.join(dir, 'spikes.jsonl')).length;
        const profiles = fs.existsSync(path.join(dir, 'cpu')) ? fs.readdirSync(path.join(dir, 'cpu')).length : 0;
        console.log(`${name}  spikes=${spikes} profiles=${profiles}${current?.boot === name ? `  (last started, pid ${current.pid})` : ''}`);
    }
}

function printSpikes(flags) {
    const dir = bootDir(flags);
    let rows = readLines(path.join(dir, 'spikes.jsonl'));
    if (flags.thread) rows = rows.filter(row => row.thread === flags.thread);
    const count = Number(flags.top || 20);
    rows = flags.sort === 'ms' ? rows.sort((a, b) => b.ms - a.ms).slice(0, count) : rows.slice(-count);
    console.log(`${path.basename(dir)}: ${rows.length} spike minute(s)${flags.thread ? ` of ${flags.thread}` : ''}`);
    for (const row of rows) {
        console.log(`\n${time(row.t)}  ${row.thread}  longest ${Math.round(row.ms)} ms, ${row.longTurns} long turn(s), gc ${Math.round(row.gcMs)} ms`
            + `${row.forced ? ', captured on request' : ''}${row.profile ? `  ${row.profile}` : ''}`);
        for (const frame of row.code.slice(0, 6)) console.log(`  ${ms(frame.ms)}  ${frame.fn}`);
        if (row.self.length) console.log(`  self: ${row.self.slice(0, 4).map(f => `${f.fn.replace(/ \S+:\d+$/, '')} ${Math.round(f.ms)}`).join(' | ')}`);
    }
}

function bucketOf(iso, minutes) {
    const at = new Date(iso).getTime(), size = minutes * 60000;
    return new Date(Math.floor(at / size) * size).toISOString();
}

function printTimeline(flags) {
    const dir = bootDir(flags), minutes = Number(flags.every || 60);
    const lines = fs.readdirSync(dir).filter(name => /^timeline-\d{8}\.jsonl$/.test(name)).sort()
        .flatMap(name => readLines(path.join(dir, name)));
    const buckets = new Map(), threads = new Set();
    const bucket = (iso) => {
        const key = bucketOf(iso, minutes);
        if (!buckets.has(key)) buckets.set(key, { cpu: {}, heapMb: {}, rssMb: 0, coldDue: 0, workerGcMb: 0 });
        return buckets.get(key);
    };
    for (const line of lines) {
        const b = bucket(line.t);
        if (line.type === 'cpu') {
            threads.add(line.thread);
            const c = b.cpu[line.thread] || (b.cpu[line.thread] = { ms: 0, busy: 0, gc: 0, longest: 0, long: 0 });
            c.ms += line.ms; c.busy += line.busyMs; c.gc += line.gcMs;
            c.longest = Math.max(c.longest, line.longestMs); c.long += line.longTurns;
        } else if (line.type === 'summary') {
            b.rssMb = Math.max(b.rssMb, Math.round((line.main?.memory?.rss || 0) / 1048576));
            for (const [label, heap] of Object.entries(line.heaps || {})) b.heapMb[label] = Math.max(b.heapMb[label] || 0, heap.usedMb);
            b.coldDue = Math.max(b.coldDue, line.coldQueue?.overdue || 0);
            b.workerGcMb = Math.max(b.workerGcMb, Math.round((line.coordinator?.worker?.heapAfterGc || 0) / 1048576));
        }
    }
    const pct = (part, whole) => (whole > 0 ? `${Math.round(100 * part / whole)}%` : '-');
    console.log(`${path.basename(dir)}: ${minutes} min per row. cpu <thread>=busy/gc/longest ms/long turns; heap = max used MB`);
    for (const [key, b] of buckets) {
        const cpu = [...threads].map(t => {
            const c = b.cpu[t];
            return c ? `${t}=${pct(c.busy, c.ms)}/${pct(c.gc, c.ms)}/${Math.round(c.longest)}/${c.long}` : null;
        }).filter(Boolean).join(' ');
        const heaps = Object.entries(b.heapMb).map(([label, used]) => `${label}:${used}`).join(' ');
        console.log(`${time(key)}  ${cpu}  rss=${b.rssMb} coldGc=${b.workerGcMb} coldDue=${b.coldDue}  heap ${heaps}`);
    }
}

// The recorder takes the request within 5 s; no pickup means no live server reads this folder.
async function capture(words) {
    const kind = words[1];
    if (kind !== 'cpu') throw new Error('Use: perf.js capture cpu');
    const file = path.join(liveDir(), 'request.json');
    fs.mkdirSync(liveDir(), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ kind, at: new Date().toISOString() })}\n`);
    for (let waited = 0; waited < 15000; waited += 500) {
        await new Promise(resolve => setTimeout(resolve, 500));
        if (!fs.existsSync(file)) {
            console.log('taken: the current chunk of each profiled thread is saved (perf.js spikes shows it)');
            return;
        }
    }
    fs.rmSync(file, { force: true });
    throw new Error('no live recorder took the request in 15 s (is the server up with [Perf] live = true?)');
}

function analyzeFile(words, flags) {
    const file = words[1];
    if (!file) throw new Error('Use: perf.js analyze <file.cpuprofile>');
    const a = CpuProfile.analyze(JSON.parse(fs.readFileSync(file, 'utf8')), { longTurnMs: Number(flags.long || 50), top: 15 });
    const pct = (part) => `${Math.round(100 * part / (a.durationMs || 1))}%`;
    console.log(`${path.basename(file)}: ${Math.round(a.durationMs)} ms, busy ${pct(a.busyMs)}, gc ${pct(a.gcMs)}, ${a.runs} busy runs, ${a.longTurns} long`);
    console.log('\nself time (whole profile):');
    for (const f of a.self) console.log(`  ${ms(f.ms)}  ${f.fn}`);
    console.log('\nproject files (self):');
    for (const f of a.files) console.log(`  ${ms(f.ms)}  ${f.fn}`);
    if (!a.longest) return;
    console.log(`\nlongest run ${Math.round(a.longest.ms)} ms at +${a.longest.atMs} ms; long runs: ${a.long.map(r => Math.round(r.ms)).join(', ') || '-'}`);
    for (const f of a.longest.code) console.log(`  ${ms(f.ms)}  ${f.fn}`);
    console.log('  self:');
    for (const f of a.longest.self) console.log(`  ${ms(f.ms)}  ${f.fn}`);
}

async function main() {
    const { words, flags } = parse(process.argv.slice(2));
    const command = words[0];
    if (command === 'boots') return printBoots();
    if (command === 'spikes') return printSpikes(flags);
    if (command === 'timeline') return printTimeline(flags);
    if (command === 'capture') return capture(words);
    if (command === 'analyze') return analyzeFile(words, flags);
    console.log('Use: perf.js boots | spikes | timeline | capture cpu | analyze <file.cpuprofile>');
    process.exitCode = command ? 1 : 0;
}

main().catch((error) => {
    console.error(`perf: ${error.message}`);
    process.exitCode = 1;
});
