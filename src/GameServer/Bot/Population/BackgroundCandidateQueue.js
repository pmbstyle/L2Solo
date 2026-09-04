'use strict';

// Keep a bounded selection across governor windows. Always refresh a candidate
// before work: ownership, party membership and inventory can change meanwhile.
class BackgroundCandidateQueue {
    constructor() {
        this.pending = [];
        this.running = false;
        this.selectionFull = false;
    }

    async run({ select, refresh, work, limit = 16, deadlineAt = Infinity, sliceMs = 6, onStage = () => {}, onProgress = () => {} }) {
        if (this.running) return { results: [], continuation: true };
        this.running = true;
        const results = [];
        let processed = 0;
        let skipped = 0;
        let selectedCount = 0;
        const resumed = this.pending.length > 0;
        let sliceStartedAt = Date.now();
        try {
            if (!this.pending.length && Date.now() < deadlineAt) {
                const startedAt = Date.now();
                const selected = await select();
                this.pending = (selected || []).slice(0, limit);
                selectedCount = this.pending.length;
                this.selectionFull = (selected || []).length >= limit;
                onStage('projection', Date.now() - startedAt);
            }
            while (this.pending.length && Date.now() < deadlineAt) {
                const original = this.pending[0];
                const current = await refresh(original);
                if (Date.now() >= deadlineAt) break;
                if (!current) {
                    this.pending.shift();
                    skipped += 1;
                    continue;
                }
                const startedAt = Date.now();
                let result;
                try {
                    result = await work(current);
                } finally {
                    // A permanently failing candidate cannot monopolize all
                    // later windows. Normal selection may retry it later.
                    this.pending.shift();
                }
                onStage('review', Date.now() - startedAt);
                processed += 1;
                if (result) results.push(result);
                if (this.pending.length && Date.now() - sliceStartedAt >= sliceMs) {
                    await new Promise((resolve) => setImmediate(resolve));
                    sliceStartedAt = Date.now();
                }
            }
            return { results, processed, skipped, remaining: this.pending.length,
                continuation: this.selectionFull || this.pending.length > 0 };
        } finally {
            this.running = false;
            onProgress({ selected: selectedCount, processed, skipped, resumed: Number(resumed),
                pending: this.pending.length, deadlineStops: Number(this.pending.length > 0 && Date.now() >= deadlineAt) });
        }
    }
}

module.exports = BackgroundCandidateQueue;
