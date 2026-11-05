'use strict';
const fs = require('node:fs');
const path = require('node:path');
// The decision trace's file (Bot/DecisionTrace): the history thread owns this writer and calls cleanup() at its
// retention tick. Bounded (limits.md "Decision trace"): FILES rotated files of MAX_FILE each, a file older than AGE
// (48 h) deleted; only these FILES known paths are touched.
const MAX_FILE = 32 * 1024 * 1024, FILES = 8, AGE = 48 * 60 * 60 * 1000;
const BATCH = 64, BATCH_BYTES = 65536;
class DecisionTraceWriter {
    constructor(directory, header, { maxFile = MAX_FILE, now = Date.now, enabled = false } = {}) {
        this.path = path.join(directory, 'decision-trace.jsonl'); this.header = header;
        this.maxFile = Math.min(MAX_FILE, Math.max(1024, maxFile)); this.now = now;
        this.size = null; this.initialized = false; this.enabled = enabled;
        this.metrics = { batches: 0, records: 0, dropped: 0, bytes: 0, writeMs: 0, rotations: 0 };
    }
    active() { return typeof this.enabled === 'function' ? this.enabled() === true : this.enabled === true; }
    cleanup() {
        if (!this.active()) return;
        for (let index = 0; index < FILES; index++) {
            const file = this.path + (index ? `.${index}` : '');
            try { if (this.now() - fs.statSync(file).mtimeMs > AGE) {
                fs.unlinkSync(file); if (!index) { this.size = 0; this.initialized = false; }
            } } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
    }
    rotate() {
        if (!this.active()) return;
        this.metrics.rotations++;
        fs.rmSync(`${this.path}.${FILES - 1}`, { force: true });
        for (let index = FILES - 2; index >= 0; index--) {
            const file = this.path + (index ? `.${index}` : '');
            if (fs.existsSync(file)) fs.renameSync(file, `${this.path}.${index + 1}`);
        }
        this.size = 0; this.initialized = false;
    }
    write(records) {
        if (!this.active()) return 0;
        if (!Array.isArray(records) || !records.length || records.length > BATCH
            || records.some(row => typeof row !== 'string' || Buffer.byteLength(row) > 1024 || /[\r\n]/.test(row))) return 0;
        if (Buffer.byteLength(records.join('\n')) + records.length > BATCH_BYTES) return 0;
        const started = performance.now();
        this.metrics.batches++;
        if (this.size === null) {
            fs.mkdirSync(path.dirname(this.path), { recursive: true }); this.cleanup();
            this.size = fs.existsSync(this.path) ? fs.statSync(this.path).size : 0;
        }
        const header = JSON.stringify({ ...this.header, type: 'decision_trace_header', at: this.now(), uptimeMs: process.uptime() * 1000 }) + '\n';
        const headerBytes = Buffer.byteLength(header);
        if (headerBytes > 1024 || headerBytes >= this.maxFile) { this.metrics.dropped += records.length; return 0; }
        let written = 0;
        // A small configured file can be smaller than a batch. Split at row
        // boundaries, never exceed the cap after a rotation or truncate JSON.
        for (let index = 0; index < records.length;) {
            const firstSize = Buffer.byteLength(records[index]) + 1;
            if (firstSize + headerBytes > this.maxFile) { this.metrics.dropped++; index++; continue; }
            if (this.size + firstSize + (this.initialized ? 0 : headerBytes) > this.maxFile) this.rotate();
            let payload = this.initialized ? '' : header;
            let size = Buffer.byteLength(payload), count = 0;
            while (index < records.length) {
                const row = records[index] + '\n', bytes = Buffer.byteLength(row);
                if (this.size + size + bytes > this.maxFile) break;
                payload += row; size += bytes; count++; index++;
            }
            fs.appendFileSync(this.path, payload); this.size += size; this.initialized = true;
            written += count; this.metrics.bytes += size; this.metrics.records += count;
        }
        this.metrics.writeMs += performance.now() - started;
        return written;
    }
    snapshot() { return this.active() ? { enabled: true, ...this.metrics, fileBytes: this.size || 0 } : { enabled: false }; }

}
module.exports = { DecisionTraceWriter, MAX_FILE, FILES, AGE };
