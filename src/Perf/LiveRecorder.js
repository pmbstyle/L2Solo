'use strict';

const fs = require('fs');
const path = require('path');
const v8 = require('v8');
const { performance } = require('perf_hooks');
const { Worker } = require('worker_threads');
const Threads = require('./Threads');
const CpuProfile = require('./CpuProfile');

// Live recorder for a server that runs for days ([Perf] live, planning/perf-tooling/plan.md).
// Without live it registers nothing and starts no timer. With it, per boot folder:
// - timeline-<day>.jsonl: a "summary" line per population summary (logSummary, every 30 s) and a
//   "cpu" line per profiled thread per chunk (busy and GC time, longest busy run, long turns);
// - spikes-<day>.jsonl: a chunk whose longest busy run reached longTurnMs, with the code that held it;
// - cpu/*.cpuprofile: the raw chunk when its longest run reached keepProfileMs, or on request
//   (scripts/perf.js capture cpu), for Chrome DevTools.
// Rare spikes are the reason for chunks: a profile that always runs has the minute of a spike at
// 3 a.m. without anyone asking for it. Chunks overlap (the next profile starts before the last
// one stops): a profiler that stops forgets the names of optimized code, and every later chunk
// would charge its time to the timer that called it. The samples a chunk shares with the last one
// are left out of its numbers, so a run in the overlap counts once.

const ROOT = path.resolve(__dirname, '..', '..');
const TICK_MS = 5000;
const PRUNE_MS = 3600000;
const BOOT_DIR = /^\d{8}-\d{6}$/;
const DAY_FILE = /^(?:timeline|spikes)-(\d{8})\.jsonl$/;

function settings(config = {}) {
    const number = (value, fallback, min) => (Number.isFinite(Number(value)) && Number(value) >= min ? Number(value) : fallback);
    return {
        live: config.live === true || config.live === 'true',
        dir: path.resolve(ROOT, String(config.dir || 'tmp/perf/live')),
        cpuThreads: String(config.cpuThreads ?? 'main,l2node-cold-simulation').split(',').map(s => s.trim()).filter(Boolean),
        cpuChunkSeconds: number(config.cpuChunkSeconds, 60, 1),
        longTurnMs: number(config.longTurnMs, 50, 1),
        keepProfileMs: number(config.keepProfileMs, 200, 1),
        keepProfiles: number(config.keepProfiles, 300, 0),
        keepDays: number(config.keepDays, 14, 1)
    };
}

const pad = (value) => String(value).padStart(2, '0');
const dayOf = (date) => `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
const stampOf = (date) => `${dayOf(date)}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
const mb = (bytes) => Math.round(bytes / 1048576);

// A profile handle of a thread: main's is synchronous, a worker's answers through its Worker.
const startProfile = (thread) => (thread.worker ? thread.worker.startCpuProfile() : Promise.resolve(v8.startCpuProfile()));

class LiveRecorder {
    constructor() {
        this.running = false;
    }

    start(config = options.default.Perf || {}) {
        const s = settings(config);
        if (!s.live || this.running) return false;
        if (typeof v8.startCpuProfile !== 'function' || typeof Worker.prototype.startCpuProfile !== 'function') {
            utils.infoWarn('Perf', 'live recorder off: Node %s has no v8.startCpuProfile / Worker#startCpuProfile', process.version);
            return false;
        }
        try {
            this.settings = s;
            this.bootDir = path.join(s.dir, stampOf(new Date()));
            fs.mkdirSync(path.join(this.bootDir, 'cpu'), { recursive: true });
            fs.writeFileSync(path.join(s.dir, 'current.json'), `${JSON.stringify({
                boot: path.basename(this.bootDir), pid: process.pid, startedAt: new Date().toISOString() })}\n`);
            this.profiled = new Map();
            this.profiles = [];
            this.writes = Promise.resolve();
            this.ticking = false;
            this.costMs = 0;
            this.cpuMark = process.cpuUsage();
            this.prunedAt = Date.now();
            this.running = true;
            this.threads = new Threads();
            this.threads.start({ onReady: thread => this.attach(thread), onExit: thread => this.profiled.delete(thread.threadId) });
            this.timer = setInterval(() => this.tick(), TICK_MS);
            this.timer.unref?.();
            this.prune().catch(error => this.warn('prune', error));
            utils.infoSuccess('Perf', 'live recorder on: %s (cpu of %s, %d s chunks)',
                path.relative(ROOT, this.bootDir), s.cpuThreads.join(','), s.cpuChunkSeconds);
            return true;
        } catch (error) {
            this.running = false;
            clearInterval(this.timer);
            this.threads?.stop();
            this.warn('start', error);
            return false;
        }
    }

    async stop() {
        if (!this.running) return this.writes;
        this.running = false;
        clearInterval(this.timer);
        await Promise.all([...this.profiled.values()].map(state => Promise.resolve().then(() => state.handle?.stop()).catch(() => null)));
        this.profiled.clear();
        this.threads.stop();
        return this.writes;
    }

    warn(what, error) {
        utils.infoWarn('Perf', 'live recorder %s failed: %s', what, error?.message || error);
    }

    // A path worker gets "#<id>" when its file is shared; the setting names the file.
    wanted(thread) {
        return this.settings.cpuThreads.includes(thread.label.replace(/#\d+$/, ''));
    }

    attach(thread) {
        if (!this.running || !this.wanted(thread)) return;
        const state = { thread, handle: null, startedAt: Date.now(), rotating: false, lastEnd: 0 };
        this.profiled.set(thread.threadId, state);
        startProfile(thread).then(handle => {
            if (this.profiled.get(thread.threadId) !== state) return handle.stop();
            state.handle = handle;
            state.startedAt = Date.now();
        }).catch(error => {
            this.profiled.delete(thread.threadId);
            if (this.running) this.warn(`cpu profile of ${thread.label}`, error);
        });
    }

    // Each thread rotates on its own: a worker stuck in a long step (its profiler answers on its own
    // loop) holds only its chunk, not main's or a capture. The promise is for tests.
    tick() {
        if (!this.running || this.ticking) return Promise.resolve();
        this.ticking = true;
        return this.takeRequest().then((request) => {
            const due = Date.now() - this.settings.cpuChunkSeconds * 1000, forced = request?.kind === 'cpu';
            const ready = [...this.profiled.values()].filter(state => state.handle && !state.rotating);
            if (forced && !ready.length) utils.infoWarn('Perf', 'capture cpu: no profiled thread is up');
            if (Date.now() - this.prunedAt >= PRUNE_MS) {
                this.prunedAt = Date.now();
                this.prune().catch(error => this.warn('prune', error));
            }
            const jobs = ready.filter(state => forced || state.startedAt <= due).map(state => this.rotate(state, forced));
            this.ticking = false;
            return Promise.all(jobs);
        }).catch(error => this.warn('tick', error)).finally(() => { this.ticking = false; });
    }

    // scripts/perf.js capture writes request.json; taken once, then removed.
    async takeRequest() {
        const file = path.join(this.settings.dir, 'request.json');
        let text;
        try {
            text = await fs.promises.readFile(file, 'utf8');
        } catch (error) {
            if (error.code === 'ENOENT') return null;
            throw error;
        }
        await fs.promises.rm(file, { force: true });
        try {
            return JSON.parse(text);
        } catch {
            return null;
        }
    }

    async rotate(state, forced) {
        state.rotating = true;
        try {
            await this.rotateChunk(state, forced);
        } finally {
            state.rotating = false;
        }
    }

    async rotateChunk(state, forced) {
        const { thread } = state, startedAt = state.startedAt, last = state.handle;
        let text;
        try {
            const next = await startProfile(thread);
            if (this.profiled.get(thread.threadId) !== state) {
                await Promise.allSettled([next.stop(), last.stop()]);
                return;
            }
            state.handle = next;
            state.startedAt = Date.now();
            const began = performance.now();
            text = await last.stop();
            if (!thread.worker) this.costMs += performance.now() - began;
        } catch (error) {
            if (this.profiled.has(thread.threadId)) this.warn(`cpu chunk of ${thread.label}`, error);
            return;
        }
        const began = performance.now();
        const profile = typeof text === 'string' ? JSON.parse(text) : text;
        const a = CpuProfile.analyze(profile, { longTurnMs: this.settings.longTurnMs, since: state.lastEnd });
        state.lastEnd = profile.endTime || state.lastEnd;
        this.costMs += performance.now() - began;
        const keep = forced || (a.longest?.ms || 0) >= this.settings.keepProfileMs;
        const file = keep ? path.join(this.bootDir, 'cpu',
            `${stampOf(new Date(startedAt))}-${thread.label.replace(/[^\w.-]+/g, '_')}-${Math.round(a.longest?.ms || 0)}ms.cpuprofile`) : null;
        const at = new Date(startedAt).toISOString();
        this.append({ type: 'cpu', t: at, thread: thread.label, ms: a.durationMs, busyMs: a.busyMs, gcMs: a.gcMs,
            longestMs: a.longest?.ms || 0, longTurns: a.longTurns, runs: a.runs });
        if (a.longTurns > 0 || forced) {
            this.appendTo(`spikes-${dayOf(new Date(startedAt))}.jsonl`, { t: new Date(startedAt + (a.longest?.atMs || 0)).toISOString(), chunk: at,
                thread: thread.label, ms: a.longest?.ms || 0, longTurns: a.longTurns, long: a.long.slice(0, 5),
                code: a.longest?.code || [], self: a.longest?.self || [], gcMs: a.gcMs, busyMs: a.busyMs,
                profile: file && path.relative(this.bootDir, file).split(path.sep).join('/'), forced: !!forced });
        }
        if (!file) return;
        this.write(() => fs.promises.writeFile(file, typeof text === 'string' ? text : JSON.stringify(text)));
        this.profiles.push(file);
        while (this.profiles.length > this.settings.keepProfiles) {
            const old = this.profiles.shift();
            this.write(() => fs.promises.rm(old, { force: true }));
        }
        if (forced) utils.infoSuccess('Perf', 'captured cpu of %s: %s', thread.label, path.relative(ROOT, file));
    }

    // Called by PopulationService.logSummary with what it already built; the coordinator snapshot
    // is a function so nothing is copied with the recorder off.
    recordSummary(reason, summary, coordinatorSnapshot) {
        if (!this.running) return Promise.resolve();
        const began = performance.now();
        const cpu = process.cpuUsage(this.cpuMark);
        this.cpuMark = process.cpuUsage();
        // The console line repeats the object as text; coldQueue goes to its own field. Main's busy
        // share is in the cpu lines (the profile), not a second event-loop utilization window.
        const population = { ...summary };
        delete population.line;
        delete population.coldQueue;
        const record = { type: 'summary', t: new Date().toISOString(), reason,
            main: { memory: process.memoryUsage(),
                processCpuMs: { user: Math.round(cpu.user / 1000), system: Math.round(cpu.system / 1000) } },
            coldQueue: summary?.coldQueue || null,
            coordinator: coordinatorSnapshot ? coordinatorSnapshot() : null,
            population: summary?.enabled === false ? null : population,
            recorder: { costMs: Math.round(this.costMs), profiles: this.profiles.length } };
        this.costMs = performance.now() - began;
        return this.heaps().then(heaps => this.append({ ...record, heaps }))
            .catch(error => this.warn('summary', error));
    }

    // used/total MB of every thread's V8 heap now, read from main: WorkerHeapTelemetry reports the
    // heap after GC from inside a thread, and with diagnostics off only the cold worker's.
    async heaps() {
        const rows = await Promise.all(this.threads.all().map(thread =>
            Promise.resolve().then(() => (thread.worker ? thread.worker.getHeapStatistics() : v8.getHeapStatistics()))
                .then(heap => [thread.label, { usedMb: mb(heap.used_heap_size), totalMb: mb(heap.total_heap_size) }])
                .catch(() => null)));
        return Object.fromEntries(rows.filter(Boolean));
    }

    append(record) {
        this.appendTo(`timeline-${dayOf(new Date(record.t))}.jsonl`, record);
    }

    appendTo(name, record) {
        const text = `${JSON.stringify(record)}\n`;
        this.write(() => fs.promises.appendFile(path.join(this.bootDir, name), text));
    }

    // One write at a time, so long lines of two records never interleave.
    write(job) {
        this.writes = this.writes.then(job).catch(error => this.warn('write', error));
        return this.writes;
    }

    // Older than keepDays: other boot folders, and this boot's day files (a server up for weeks).
    // Raw profiles are capped by keepProfiles instead.
    async prune() {
        const limit = Date.now() - this.settings.keepDays * 86400000, oldestDay = dayOf(new Date(limit));
        for (const name of await fs.promises.readdir(this.settings.dir)) {
            const dir = path.join(this.settings.dir, name);
            if (!BOOT_DIR.test(name) || dir === this.bootDir) continue;
            const stat = await fs.promises.stat(dir);
            if (stat.isDirectory() && stat.mtimeMs < limit) await fs.promises.rm(dir, { recursive: true, force: true });
        }
        for (const name of await fs.promises.readdir(this.bootDir)) {
            const day = DAY_FILE.exec(name)?.[1];
            if (day && day < oldestDay) await fs.promises.rm(path.join(this.bootDir, name), { force: true });
        }
    }
}

module.exports = new LiveRecorder();
module.exports.LiveRecorder = LiveRecorder;
module.exports.settings = settings;
