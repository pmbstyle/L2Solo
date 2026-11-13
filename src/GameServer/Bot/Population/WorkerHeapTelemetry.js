'use strict';
const { PerformanceObserver, constants } = require('node:perf_hooks');
const v8 = require('node:v8');
const MB = 1024 * 1024;
const MAX_SAMPLES = 128;
const WINDOW_MS = 10 * 60 * 1000;
// The observer callback runs after the task the GC interrupted, so its heapUsed includes what that task allocated
// after the GC. A sample later than LATE_MS after the GC's end is dropped and counted (late); the error of an
// accepted one is LATE_MS times the allocation rate.
const LATE_MS = 25;
class MajorGcHeap {
    constructor() { this.maxima = []; this.head = 0; this.dropped = 0; this.late = 0; this.incompleteUntil = 0; }
    prune(at) {
        while (this.head < this.maxima.length && this.maxima[this.head][0] <= at - WINDOW_MS) this.head++;
        if (this.head > 128 && this.head * 2 >= this.maxima.length) {
            this.maxima = this.maxima.slice(this.head); this.head = 0;
        }
    }
    record(heap, at = performance.now()) {
        this.prune(at); heap = Number(heap) || 0;
        while (this.maxima.length > this.head && this.maxima.at(-1)[1] <= heap) this.maxima.pop();
        if (this.maxima.length - this.head >= MAX_SAMPLES) {
            this.incompleteUntil = Math.max(this.incompleteUntil, this.maxima[this.head][0] + WINDOW_MS);
            this.head++; this.dropped++;
        }
        this.maxima.push([at, heap]);
    }
    snapshot(at = performance.now()) {
        this.prune(at);
        // The newest record is always the tail (record() pushes last, prune() removes only the head), so the heap after
        // the last major GC is 0 once the window holds none.
        return { heapAfterGc: this.head < this.maxima.length ? this.maxima.at(-1)[1] : 0,
            heapAfterGcMax10: at < this.incompleteUntil ? null : this.maxima[this.head]?.[1] || 0,
            ...(this.dropped ? { heapGcDropped: this.dropped } : {}), ...(this.late ? { heapGcLate: this.late } : {}) };
    }
}
// The heap of the calling isolate in MB: V8 heap used and reserved, the
// external memory V8 counts (Buffers, ArrayBuffers) and the isolate's own
// heap cap (heap_size_limit; a worker without resourceLimits shows the default). Every thread sends this
// one shape on a message it already sends; PopulationStatus.heaps() merges them. `used` is read at an arbitrary
// moment and includes uncollected garbage; afterGc (heap used after the last major GC) and afterGcMax (its maximum over
// the WINDOW_MS window) are the live data. Both come from this isolate's observe() window and are present only
// while it runs (null: no accepted major GC in the window; afterGcMax is also null while a sample overflow
// (incompleteUntil) makes the maximum unknown, afterGc stays). late counts major GCs whose sample arrived after LATE_MS and was dropped.
const megabytes = bytes => bytes > 0 ? Math.round(bytes / MB) : null;
function heapRecord(at) {
    const stats = v8.getHeapStatistics();
    const record = { used: Math.round(stats.used_heap_size / MB), total: Math.round(stats.total_heap_size / MB),
        external: Math.round(stats.external_memory / MB), limit: Math.round(stats.heap_size_limit / MB) };
    if (active) {
        const gc = active.window.snapshot(at);
        record.afterGc = megabytes(gc.heapAfterGc);
        record.afterGcMax = megabytes(gc.heapAfterGcMax10);
        record.late = gc.heapGcLate || 0;
    }
    return record;
}
// heaps=<thread>:<used>/<total>/<external>/<limit>/<afterGc>/<afterGcMax>/<late>,... in MB (late is a count); '-' for a
// thread that has not reported yet and for an afterGc/afterGcMax without an accepted major GC. clan is as of its last plan, history its last
// minute tick, market its last answer.
function heapsLine(heaps) {
    return Object.entries(heaps).map(([name, heap]) => `${name}:${heap
        ? `${heap.used}/${heap.total}/${heap.external}/${heap.limit}/${heap.afterGc ?? '-'}/${heap.afterGcMax ?? '-'}/${heap.late ?? '-'}` : '-'}`).join(',');
}
// GC pauses by V8 kind: the CPU profile's GC time does not say whether a long turn waited for scavenges
// (young generation) or for a mark-compact (old).
const GC_KINDS = { [constants.NODE_PERFORMANCE_GC_MINOR]: 'minor', [constants.NODE_PERFORMANCE_GC_MAJOR]: 'major',
    [constants.NODE_PERFORMANCE_GC_INCREMENTAL]: 'incremental', [constants.NODE_PERFORMANCE_GC_WEAKCB]: 'weak' };
function addPause(shared, entry) {
    const kind = GC_KINDS[entry.detail?.kind] || 'other';
    const sum = shared.pauses[kind] ||= { count: 0, ms: 0 };
    sum.count += 1;
    sum.ms += entry.duration;
    for (const longest of shared.pauseMaxima) if (!(longest[kind] >= entry.duration)) longest[kind] = entry.duration;
}
// A loop-delay window of a monitorEventLoopDelay histogram, in ms: a sample is the time between two runs of
// its timer, so the resolution comes off (a task that held the loop L ms reads L to L - resolution). The turn
// length of main (PopulationMetrics) and the worker (its turn window), as the run summary reports it.
function loopDelay(histogram, resolutionMs) {
    const samples = Number(histogram?.count || 0);
    if (!samples) return { samples: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 };
    const ms = ns => Math.max(0, Math.round(Number(ns) / 1e6 - resolutionMs));
    return { samples, p95Ms: ms(histogram.percentile(95)), p99Ms: ms(histogram.percentile(99)), maxMs: ms(histogram.max) };
}
// The GC observer of this isolate; every thread that reports v8Heap starts it once when developer
// diagnostics are on, the perf live recorder starts it on main, and heapRecord() reads its window. Each
// observe() gets its own handle on the one observer; it stops when the last handle is closed, so
// PopulationMetrics stopping does not end the recorder's window. A handle opened with { pauses: true }
// (the recorder, the worker's turn window) also has the isolate's GC pauses by kind: { kind: { count, ms, maxMs } },
// count and ms cumulative from the first such handle while the observer lives (the reader takes deltas), maxMs
// the longest pause since this handle's last read (a window's longest, not boot's); with none open the observer
// only tests a count per GC entry.
let active = null;
function observe({ pauses: wantsPauses = false } = {}) {
    if (!active) {
        const window = new MajorGcHeap();
        const shared = { window, observer: null, handles: 0, pauseMaxima: new Set(), pauses: {} };
        shared.observer = new PerformanceObserver(list => {
            for (const entry of list.getEntries()) {
                if (shared.pauseMaxima.size) addPause(shared, entry);
                if (entry.detail.kind !== constants.NODE_PERFORMANCE_GC_MAJOR) continue;
                const at = entry.startTime + entry.duration;
                if (performance.now() - at > LATE_MS) { window.late++; continue; }
                window.record(process.memoryUsage().heapUsed, at);
            }
        });
        shared.observer.observe({ entryTypes: ['gc'] });
        active = shared;
    }
    const shared = active;
    shared.handles += 1;
    const longest = wantsPauses ? {} : null;
    if (longest) shared.pauseMaxima.add(longest);
    let open = true;
    return { window: shared.window, snapshot: at => ({ ...shared.window.snapshot(at), v8Heap: heapRecord(at) }),
        pauses: () => {
            if (!longest) return null;
            const read = Object.fromEntries(Object.entries(shared.pauses).map(([kind, sum]) => [kind,
                { count: sum.count, ms: Math.round(sum.ms), maxMs: Math.round((longest[kind] || 0) * 10) / 10 }]));
            for (const kind of Object.keys(longest)) longest[kind] = 0;
            return read;
        },
        close: () => {
            if (!open) return;
            open = false;
            if (longest) shared.pauseMaxima.delete(longest);
            if (--shared.handles > 0) return;
            shared.observer.disconnect();
            if (active === shared) active = null;
        } };
}
module.exports = { MAX_SAMPLES, WINDOW_MS, LATE_MS, MajorGcHeap, observe, heapRecord, heapsLine, loopDelay };
