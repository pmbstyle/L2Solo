'use strict';

const path = require('node:path');
const { readJson, writeJson } = require('./files.cjs');
const { listReleases } = require('./releases.cjs');
const interval = 4 * 60 * 60 * 1000;

class ReleaseCatalog {
    constructor({ userData, fetcher = fetch }) {
        this.file = path.join(userData, 'release-catalog.json');
        this.fetcher = fetcher;
        this.cached = null;
        this.pending = null;
    }
    async releases(force = false) {
        if (!this.cached) {
            try { this.cached = await readJson(this.file, {}); }
            catch { this.cached = {}; }
        }
        if (!force && Array.isArray(this.cached.releases) && Date.now() - this.cached.checkedAt < interval) return this.cached.releases;
        if (this.pending) return this.pending;
        this.pending = (async () => {
            const releases = await listReleases(this.fetcher);
            this.cached = { checkedAt: Date.now(), releases };
            await writeJson(this.file, this.cached);
            return releases;
        })();
        try { return await this.pending; } finally { this.pending = null; }
    }
}

module.exports = { ReleaseCatalog, interval };
