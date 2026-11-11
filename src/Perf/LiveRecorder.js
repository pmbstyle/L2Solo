'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const v8 = require('v8');
const { performance } = require('perf_hooks');
const { Worker } = require('worker_threads');
const { pipeline } = require('stream/promises');
const Threads = require('./Threads');
const HeapProfile = require('./HeapProfile');

// Live recorder for a server that runs for days ([Perf] live; usage in scripts/perf.js).
// Without live it registers nothing and starts no timer. With it, per boot folder:
// - timeline-<day>.jsonl: a "summary" line per population summary (logSummary, every 30 s) and a
//   "cpu" line per profiled thread per chunk (busy and GC time, longest busy run, long turns); the
//   summary line carries main's GC pauses by kind (count and ms cumulative from the recorder's start, the
//   longest since the line before);
// - spikes-<day>.jsonl: a chunk whose longest busy run reached longTurnMs, with the code that held it;
// - cpu/*.cpuprofile: the raw chunk when its longest run reached keepProfileMs, or on request
//   (scripts/perf.js capture cpu), for Chrome DevTools;
// - heap/*.heapprofile: the sampling heap profile of each heap thread, first FIRST_HEAP_MINUTES after
//   it starts (the world loaded), then every heapEveryMinutes and on capture heap; the sampler is
//   never reset, so two files of one thread diff into what the code kept in between (perf.js heap).
//   heap.jsonl lists them (not a day file: pruning must not lose the baseline). The first file of a
//   thread is the baseline and stays; a thread that exits keeps its first and last. heap/*.heapsnapshot
//   only on capture snapshot.
// Rare spikes are the reason for chunks: a profile that always runs has the minute of a spike at
// 3 a.m. without anyone asking for it. Chunks overlap (the next profile starts before the last
// one stops): a profiler that stops forgets the names of optimized code, and every later chunk
// would charge its time to the timer that called it. The samples a chunk shares with the last one
// are left out of its numbers, so a run in the overlap counts once. A chunk is parsed, analyzed
// and written on the recorder's own thread (ChunkWorker): on main that held 200-400 ms turns.

const ROOT = path.resolve(__dirname, '..', '..');
const TICK_MS = 5000;
const PRUNE_MS = 3600000;
const FIRST_HEAP_MINUTES = 10;
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
        // 0 keeps every chunk (window runs add up the whole window).
        keepProfileMs: number(config.keepProfileMs, 200, 0),
        // Raw chunks kept per day: the worst (longest busy run) ones, and every captured one; a spike at
        // 3 a.m. outlives a busy afternoon.
        keepProfilesPerDay: number(config.keepProfilesPerDay, 100, 0),
        heapThreads: String(config.heapThreads ?? 'main,l2node-cold-simulation').split(',').map(s => s.trim()).filter(Boolean),
        heapSampleKb: number(config.heapSampleKb, 128, 1),
        heapEveryMinutes: number(config.heapEveryMinutes, 60, 1),
        keepHeapProfiles: number(config.keepHeapProfiles, 100, 2),
        keepDays: number(config.keepDays, 14, 1)
    };
}

const pad = (value) => String(value).padStart(2, '0');
const dayOf = (date) => `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
const stampOf = (date) => `${dayOf(date)}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
const mb = (bytes) => Math.round(bytes / 1048576);
const fileLabel = (thread) => thread.label.replace(/[^\w.-]+/g, '_');

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
            fs.mkdirSync(path.join(this.bootDir, 'heap'), { recursive: true });
            fs.writeFileSync(path.join(s.dir, 'current.json'), `${JSON.stringify({
                boot: path.basename(this.bootDir), pid: process.pid, startedAt: new Date().toISOString() })}\n`);
            this.profiled = new Map();
            this.heaped = new Map();
            this.profiles = [];
            this.eluMarks = new Map();
            // Main's heap after major GC (WorkerHeapTelemetry), as the cold worker already has it, and
            // main's GC pauses by kind.
            this.heapWindow = invoke('GameServer/Bot/Population/WorkerHeapTelemetry').observe({ pauses: true });
            this.handlers = new Map();
            this.writes = Promise.resolve();
            this.ticking = false;
            this.costMs = 0;
            this.cpuMark = process.cpuUsage();
            this.prunedAt = Date.now();
            this.running = true;
            this.threads = new Threads();
            this.threads.start({ onReady: thread => this.attach(thread), onExit: (thread) => {
                this.note('thread', { event: 'exit', thread: thread.label, instance: thread.threadId });
                this.eluMarks.delete(thread.threadId);
                this.profiled.delete(thread.threadId);
                const heap = this.heaped.get(thread.threadId);
                this.heaped.delete(thread.threadId);
                // A restarted worker is a new heap: the old one keeps its baseline and its last dump.
                for (const old of heap?.files.slice(1, -1) || []) this.write(() => fs.promises.rm(old, { force: true }));
            } });
            this.chunks = { worker: null, pending: new Map(), nextId: 0 };
            this.timer = setInterval(() => this.tick(), TICK_MS);
            this.timer.unref?.();
            this.prune().catch(error => this.warn('prune', error));
            utils.infoSuccess('Perf', 'live recorder on: %s (cpu of %s, %d s chunks; heap of %s, every %d min)',
                path.relative(ROOT, this.bootDir), s.cpuThreads.join(','), s.cpuChunkSeconds, s.heapThreads.join(','), s.heapEveryMinutes);
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
        this.heaped.clear();
        await this.chunks.worker?.terminate();
        this.heapWindow?.close();
        this.threads.stop();
        return this.writes;
    }

    warn(what, error) {
        utils.infoWarn('Perf', 'live recorder %s failed: %s', what, error?.message || error);
    }

    // A path worker gets "#<id>" when its file is shared; the setting names the file.
    wanted(thread, list) {
        return list.includes(thread.label.replace(/#\d+$/, ''));
    }

    attach(thread) {
        if (!this.running) return;
        // A worker restart shows in the timeline as an exit and a start of the same name.
        this.note('thread', { event: 'start', thread: thread.label, instance: thread.threadId });
        if (this.wanted(thread, this.settings.heapThreads)) this.attachHeap(thread);
        if (!this.wanted(thread, this.settings.cpuThreads)) return;
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

    attachHeap(thread) {
        const state = { thread, sampling: false, dumping: false, dumpedAt: Date.now(), files: [] };
        this.heaped.set(thread.threadId, state);
        // The first dump comes FIRST_HEAP_MINUTES in (or heapEveryMinutes, if sooner), not a full period.
        const firstEarlyMs = Math.max(0, this.settings.heapEveryMinutes - Math.min(FIRST_HEAP_MINUTES, this.settings.heapEveryMinutes)) * 60000;
        this.threads.post(thread, 'HeapProfiler.startSampling', { samplingInterval: this.settings.heapSampleKb * 1024 })
            .then(() => {
                state.sampling = true;
                state.dumpedAt = Date.now() - firstEarlyMs;
            }).catch(error => {
                this.heaped.delete(thread.threadId);
                if (this.running) this.warn(`heap sampling of ${thread.label}`, error);
            });
    }

    // Each thread rotates on its own: a worker stuck in a long step (its profiler answers on its own
    // loop) holds only its chunk, not main's or a capture. The promise is for tests.
    tick() {
        if (!this.running || this.ticking) return Promise.resolve();
        this.ticking = true;
        return this.takeRequest().then((request) => {
            // A capture asks every thread of its kind, or the one named by --thread.
            const asked = (state, kind) => request?.kind === kind && (!request.thread || request.thread === state.thread.label);
            const due = Date.now() - this.settings.cpuChunkSeconds * 1000;
            const ready = [...this.profiled.values()].filter(state => state.handle && !state.rotating);
            if (request?.kind === 'cpu' && !ready.some(state => asked(state, 'cpu'))) {
                utils.infoWarn('Perf', 'capture cpu: no profiled thread %s is up', request.thread || '');
            }
            const heapDue = Date.now() - this.settings.heapEveryMinutes * 60000;
            const sampling = [...this.heaped.values()].filter(state => state.sampling);
            for (const state of sampling.filter(row => row.dumping && asked(row, 'heap'))) {
                utils.infoWarn('Perf', 'capture heap: %s is still writing its last dump', state.thread.label);
            }
            if (request?.kind === 'heap' && !sampling.some(state => asked(state, 'heap'))) {
                utils.infoWarn('Perf', 'capture heap: no sampled thread %s is up', request.thread || '');
            }
            const heapJobs = sampling.filter(state => !state.dumping && (asked(state, 'heap') || state.dumpedAt <= heapDue))
                .map(state => this.dumpHeap(state, asked(state, 'heap')));
            const snapshot = request?.kind === 'snapshot' ? [this.snapshot(String(request.thread || 'main'))] : [];
            // A request another measurement answers (HotCrowd: the script scenario's start); done when it is.
            const handler = request && this.handlers.get(request.kind);
            if (handler) snapshot.push(Promise.resolve().then(() => handler(request)).catch(error => this.warn(`request ${request.kind}`, error)));
            if (Date.now() - this.prunedAt >= PRUNE_MS) {
                this.prunedAt = Date.now();
                this.prune().catch(error => this.warn('prune', error));
            }
            const jobs = ready.filter(state => asked(state, 'cpu') || state.startedAt <= due)
                .map(state => this.rotate(state, asked(state, 'cpu')));
            this.ticking = false;
            const all = Promise.all([...jobs, ...heapJobs, ...snapshot]);
            // request.done.json once every capture of a request is written: a window run waits for it
            // at its edges instead of guessing how many threads answer.
            return request ? all.then(() => fs.promises.writeFile(path.join(this.settings.dir, 'request.done.json'),
                `${JSON.stringify({ ...request, doneAt: new Date().toISOString() })}\n`)) : all;
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
        if (!this.running) return;
        const prefix = path.join(this.bootDir, 'cpu', `${stampOf(new Date(startedAt))}-${fileLabel(thread)}`);
        let reply;
        try {
            // Node's handles give the text; the copy into the chunk thread is main's, counted as cost.
            const began = performance.now();
            const pending = this.analyzeChunk({ text: String(text), since: state.lastEnd,
                longTurnMs: this.settings.longTurnMs, keepProfileMs: this.settings.keepProfileMs, forced: !!forced, prefix,
                keepUnparsed: !state.unparsedKept });
            this.costMs += performance.now() - began;
            reply = await pending;
        } catch (error) {
            if (this.running) this.warn(`cpu chunk of ${thread.label}`, error);
            return;
        }
        if (reply.error) {
            // Text Node wrote that repairText cannot fix: kept once per thread and boot for a report.
            if (reply.unparsed) state.unparsedKept = true;
            this.warn(`cpu chunk of ${thread.label}${reply.unparsed ? ` (text kept in ${path.relative(ROOT, reply.unparsed)})` : ''}`, reply.error);
            return;
        }
        const a = reply.analysis, file = reply.file;
        state.lastEnd = reply.endTime || state.lastEnd;
        const at = new Date(startedAt).toISOString();
        const kept = file && path.relative(this.bootDir, file).split(path.sep).join('/');
        this.append({ type: 'cpu', t: at, thread: thread.label, instance: thread.threadId, ms: a.durationMs, busyMs: a.busyMs,
            gcMs: a.gcMs, longestMs: a.longest?.ms || 0, longTurns: a.longTurns, runs: a.runs, profile: kept,
            // The profile clock at the chunk's end: the report leaves the next chunk's overlap out
            // even when this chunk's file was not kept.
            endTime: reply.endTime || 0, ...(a.starved ? { starved: true, samples: a.samples } : {}),
            // Stretches the profiler left without samples (CpuProfile): in ms but in neither busy nor idle.
            ...(a.unsampledMs ? { unsampledMs: a.unsampledMs } : {}), sampleGaps: a.stretches });
        if (a.starved && !state.starvedWarned) {
            state.starvedWarned = true;
            this.warn(`cpu chunk of ${thread.label}`, new Error(`profiler starved: ${a.samples} samples in ${Math.round(a.durationMs)} ms,`
                + ` ${Math.round(a.unsampledMs)} ms of it without samples (left out of the report)`));
        }
        if (!a.starved && a.longTurns > 0 || forced) {
            this.appendTo(`spikes-${dayOf(new Date(startedAt))}.jsonl`, { t: new Date(startedAt + (a.longest?.atMs || 0)).toISOString(), chunk: at,
                thread: thread.label, ms: a.longest?.ms || 0, longTurns: a.longTurns, long: a.long.slice(0, 5),
                code: a.longest?.code || [], self: a.longest?.self || [], gcMs: a.gcMs, busyMs: a.busyMs,
                profile: kept, forced: !!forced, ...(a.starved ? { starved: true } : {}) });
        }
        if (!file) return;
        this.keepProfile({ file, day: dayOf(new Date(startedAt)), ms: a.longest?.ms || 0, forced: !!forced });
        if (forced) utils.infoSuccess('Perf', 'captured cpu of %s: %s', thread.label, path.relative(ROOT, file));
    }

    // Per day, the keepProfilesPerDay chunks with the longest busy run stay, and every captured one.
    keepProfile(entry) {
        this.profiles.push(entry);
        const day = this.profiles.filter(row => row.day === entry.day && !row.forced);
        if (day.length <= this.settings.keepProfilesPerDay) return;
        const least = day.reduce((low, row) => (row.ms < low.ms ? row : low));
        this.profiles = this.profiles.filter(row => row !== least);
        this.write(() => fs.promises.rm(least.file, { force: true }));
    }

    // The chunk thread (ChunkWorker), started on first use and again after it dies; it does not keep
    // the process alive.
    analyzeChunk(message) {
        const chunks = this.chunks;
        if (!this.running) return Promise.reject(new Error('recorder stopped'));
        if (!chunks.worker) {
            const worker = new Worker(path.join(__dirname, 'ChunkWorker.js'), { name: 'perf-chunks' });
            worker.unref();
            const fail = (error) => {
                if (chunks.worker === worker) chunks.worker = null;
                for (const waiter of chunks.pending.values()) waiter.reject(error);
                chunks.pending.clear();
            };
            worker.on('message', (reply) => {
                const waiter = chunks.pending.get(reply.id);
                chunks.pending.delete(reply.id);
                waiter?.resolve(reply);
            });
            worker.on('error', fail);
            worker.on('exit', () => fail(new Error('chunk thread exited')));
            chunks.worker = worker;
        }
        return new Promise((resolve, reject) => {
            const id = ++chunks.nextId;
            chunks.pending.set(id, { resolve, reject });
            chunks.worker.postMessage({ id, ...message });
        });
    }

    async dumpHeap(state, forced) {
        const { thread } = state;
        state.dumping = true;
        try {
            const { profile } = await this.threads.post(thread, 'HeapProfiler.getSamplingProfile');
            const began = performance.now();
            const summary = HeapProfile.summarize(profile, { top: 5 });
            const text = JSON.stringify(profile);
            this.costMs += performance.now() - began;
            const at = new Date();
            // Milliseconds in the name: two captures in one second must not share a file (the
            // second would replace the baseline, and pruning would then delete it).
            const file = path.join(this.bootDir, 'heap',
                `${stampOf(at)}.${String(at.getMilliseconds()).padStart(3, '0')}-${fileLabel(thread)}.heapprofile`);
            this.write(() => fs.promises.writeFile(file, text));
            this.appendTo('heap.jsonl', { t: at.toISOString(), thread: thread.label, instance: thread.threadId, liveMb: summary.liveMb,
                self: summary.self, code: summary.code, profile: path.relative(this.bootDir, file).split(path.sep).join('/'),
                forced: !!forced });
            // The first file is the baseline every later one is compared with: it stays.
            state.files.push(file);
            while (state.files.length > this.settings.keepHeapProfiles) {
                const old = state.files.splice(1, 1)[0];
                this.write(() => fs.promises.rm(old, { force: true }));
            }
            if (forced) utils.infoSuccess('Perf', 'captured heap of %s: %s', thread.label, path.relative(ROOT, file));
        } catch (error) {
            if (this.heaped.has(thread.threadId)) this.warn(`heap profile of ${thread.label}`, error);
        } finally {
            state.dumpedAt = Date.now();
            state.dumping = false;
        }
    }

    // A full heap snapshot, only on request: main's blocks main for seconds and needs about the heap's
    // size again in memory; a worker's is written by the worker and streamed here.
    async snapshot(label) {
        const thread = this.threads.all().find(row => row.label === label);
        if (!thread) {
            utils.infoWarn('Perf', 'capture snapshot: no thread %s (threads: %s)', label, this.threads.all().map(row => row.label).join(','));
            return;
        }
        const at = new Date();
        const file = path.join(this.bootDir, 'heap',
            `${stampOf(at)}.${String(at.getMilliseconds()).padStart(3, '0')}-${fileLabel(thread)}.heapsnapshot`);
        // Written under .partial and renamed when whole: a worker that exits midway leaves no file
        // that looks complete.
        const partial = `${file}.partial`;
        try {
            if (thread.worker) await pipeline(await thread.worker.getHeapSnapshot(), fs.createWriteStream(partial));
            else v8.writeHeapSnapshot(partial);
            await fs.promises.rename(partial, file);
            utils.infoSuccess('Perf', 'captured heap snapshot of %s: %s', thread.label, path.relative(ROOT, file));
        } catch (error) {
            await fs.promises.rm(partial, { force: true });
            this.warn(`heap snapshot of ${thread.label}`, error);
        }
    }

    // Called by PopulationService.logSummary with what it already built; the coordinator snapshot
    // is a function so nothing is copied with the recorder off.
    recordSummary(reason, summary, coordinatorSnapshot, vitals) {
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
                processCpuMs: { user: Math.round(cpu.user / 1000), system: Math.round(cpu.system / 1000) },
                gc: this.heapWindow.pauses() },
            coldQueue: summary?.coldQueue || null,
            coordinator: coordinatorSnapshot ? coordinatorSnapshot() : null,
            vitals: this.vitals(vitals),
            population: summary?.enabled === false ? null : population,
            machine: this.machine(),
            recorder: { costMs: Math.round(this.costMs), inspectorMs: Math.round(this.threads.syncMs), profiles: this.profiles.length } };
        this.costMs = performance.now() - began;
        this.threads.syncMs = 0;
        return Promise.all([this.heaps(), this.files(record.vitals?.database)])
            .then(([heaps, files]) => this.append({ ...record, heaps, files }))
            .catch(error => this.warn('summary', error));
    }

    // The status owner's readings; a reader that throws costs the line its vitals, never logSummary.
    vitals(read) {
        if (!read) return null;
        try {
            return read();
        } catch (error) {
            if (!this.vitalsFailed) this.warn('vitals', error);
            this.vitalsFailed = true;
            return null;
        }
    }

    // The machine: free memory, and the process's totals since start (a reader takes differences
    // between lines): page faults (a major one reads the disk: swapping shows here before it shows as
    // busy time blamed on random code), file I/O, involuntary switches.
    machine() {
        const now = process.resourceUsage();
        return { freeMemMb: mb(os.freemem()), totalMemMb: mb(os.totalmem()), majorPageFaults: now.majorPageFault,
            minorPageFaults: now.minorPageFault, fsReads: now.fsRead, fsWrites: now.fsWrite,
            involuntarySwitches: now.involuntaryContextSwitches };
    }

    // World, WAL and history file sizes in MB (a WAL that only grows stalls a checkpoint later).
    async files(database) {
        if (!database?.path) return null;
        const size = (file) => fs.promises.stat(file).then(stat => Math.round(stat.size / 1048576 * 10) / 10).catch(() => 0);
        const [world, wal, history, historyWal] = await Promise.all([size(database.path), size(`${database.path}-wal`),
            database.historyPath ? size(database.historyPath) : 0, database.historyPath ? size(`${database.historyPath}-wal`) : 0]);
        return { worldMb: world, walMb: wal, historyMb: history, historyWalMb: historyWal };
    }

    // used/total MB of every thread's V8 heap now, read from main (WorkerHeapTelemetry reports the
    // heap after GC from inside a thread), and each thread's event-loop utilization since the last line.
    // A CPU-profiled thread's ELU reads high (the profiler inflates it): `profiled` says which.
    async heaps() {
        const rows = await Promise.all(this.threads.all().map(thread =>
            Promise.resolve().then(() => (thread.worker ? thread.worker.getHeapStatistics() : v8.getHeapStatistics()))
                .then(heap => [thread.label, { usedMb: mb(heap.used_heap_size), totalMb: mb(heap.total_heap_size),
                    ...this.elu(thread) }])
                .catch(() => null)));
        return Object.fromEntries(rows.filter(Boolean));
    }

    elu(thread) {
        const source = thread.worker ? thread.worker.performance : performance;
        if (typeof source?.eventLoopUtilization !== 'function') return {};
        const mark = this.eluMarks.get(thread.threadId);
        const now = source.eventLoopUtilization();
        this.eluMarks.set(thread.threadId, now);
        if (!mark) return {};
        const window = source.eventLoopUtilization(now, mark);
        return { elu: Math.round(window.utilization * 1000) / 1000, profiled: this.profiled.has(thread.threadId) };
    }

    // A request kind another measurement answers: request.done.json waits for its promise.
    on(kind, handler) {
        if (this.running) this.handlers.set(kind, handler);
    }

    // A line another measurement adds to the timeline (src/Perf/HotCrowd: the player probe).
    note(type, record) {
        if (!this.running) return;
        this.append({ type, t: new Date().toISOString(), ...record });
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
    // Raw profiles: the worst keepProfilesPerDay a day (keepProfile), and older days go below.
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
        const old = this.profiles.filter(row => row.day < oldestDay);
        this.profiles = this.profiles.filter(row => row.day >= oldestDay);
        for (const row of old) await fs.promises.rm(row.file, { force: true });
    }
}

module.exports = new LiveRecorder();
module.exports.LiveRecorder = LiveRecorder;
module.exports.settings = settings;
