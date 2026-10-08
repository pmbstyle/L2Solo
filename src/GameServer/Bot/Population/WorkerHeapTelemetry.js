'use strict';
const { PerformanceObserver, constants } = require('node:perf_hooks');
const MAX_SAMPLES = 128;
const WINDOW_MS = 10 * 60 * 1000;
class MajorGcHeap {
    constructor() { this.last = 0; this.maxima = []; this.head = 0; this.dropped = 0; this.incompleteUntil = 0; }
    prune(at) {
        while (this.head < this.maxima.length && this.maxima[this.head][0] <= at - WINDOW_MS) this.head++;
        if (this.head > 128 && this.head * 2 >= this.maxima.length) {
            this.maxima = this.maxima.slice(this.head); this.head = 0;
        }
    }
    record(heap, at = performance.now()) {
        this.prune(at); this.last = Number(heap) || 0;
        while (this.maxima.length > this.head && this.maxima.at(-1)[1] <= this.last) this.maxima.pop();
        if (this.maxima.length - this.head >= MAX_SAMPLES) {
            this.incompleteUntil = Math.max(this.incompleteUntil, this.maxima[this.head][0] + WINDOW_MS);
            this.head++; this.dropped++;
        }
        this.maxima.push([at, this.last]);
    }
    snapshot(at = performance.now()) {
        this.prune(at);
        return { heapAfterGc: this.last, heapAfterGcMax10: at < this.incompleteUntil ? null : this.maxima[this.head]?.[1] || 0,
            ...(this.dropped ? { heapGcDropped: this.dropped } : {}) };
    }
}
function observe() {
    const window = new MajorGcHeap();
    const observer = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
            if (entry.detail.kind === constants.NODE_PERFORMANCE_GC_MAJOR) window.record(process.memoryUsage().heapUsed);
        }
    });
    observer.observe({ entryTypes: ['gc'] });
    return { snapshot: at => window.snapshot(at), close: () => observer.disconnect() };
}
module.exports = { MAX_SAMPLES, WINDOW_MS, MajorGcHeap, observe };
