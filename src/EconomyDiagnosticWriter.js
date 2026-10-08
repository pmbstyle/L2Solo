'use strict';
const fs = require('node:fs');
const path = require('node:path');
const MAX_FILE = 8 * 1024 * 1024, FILES = 4, AGE = 24 * 60 * 60 * 1000;
// Existing history worker owns this writer. Only four known paths are touched.
class EconomyDiagnosticWriter {
    constructor(directory, header, { maxFile = MAX_FILE, now = Date.now } = {}) {
        this.path = path.join(directory, 'economy-diagnostics.jsonl'); this.header = header;
        this.maxFile = Math.min(MAX_FILE, Math.max(1024, maxFile)); this.now = now;
        this.size = null; this.initialized = false;
    }
    cleanup() {
        for (let index = 0; index < FILES; index++) {
            const file = this.path + (index ? `.${index}` : '');
            try { if (this.now() - fs.statSync(file).mtimeMs > AGE) {
                fs.unlinkSync(file); if (!index) { this.size = 0; this.initialized = false; }
            } } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
    }
    rotate() {
        fs.rmSync(`${this.path}.${FILES - 1}`, { force: true });
        for (let index = FILES - 2; index >= 0; index--) {
            const file = this.path + (index ? `.${index}` : '');
            if (fs.existsSync(file)) fs.renameSync(file, `${this.path}.${index + 1}`);
        }
        this.size = 0; this.initialized = false;
    }
    write(records) {
        if (!Array.isArray(records) || !records.length || records.length > 16
            || records.some(row => typeof row !== 'string' || Buffer.byteLength(row) > 1024 || /[\r\n]/.test(row))) return 0;
        const data = records.join('\n') + '\n';
        if (Buffer.byteLength(data) > 16 * 1024) return 0;
        if (this.size === null) {
            fs.mkdirSync(path.dirname(this.path), { recursive: true }); this.cleanup();
            this.size = fs.existsSync(this.path) ? fs.statSync(this.path).size : 0;
        }
        const header = JSON.stringify({ ...this.header, type: 'economy_diagnostics_header', at: this.now(), uptimeMs: process.uptime() * 1000 }) + '\n';
        if (Buffer.byteLength(header) > 1024) return 0;
        if (this.size + Buffer.byteLength(data) + (this.initialized ? 0 : Buffer.byteLength(header)) > this.maxFile) this.rotate();
        const payload = (this.initialized ? '' : header) + data;
        fs.appendFileSync(this.path, payload); this.size += Buffer.byteLength(payload); this.initialized = true;
        return records.length;
    }
}
module.exports = { EconomyDiagnosticWriter, MAX_FILE, FILES, AGE };
