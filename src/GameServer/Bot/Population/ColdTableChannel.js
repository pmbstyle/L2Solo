'use strict';
const DiagnosticConfig = require('./PopulationConfig');
const { tablePagesWithBytes, streamedTablePageWithBytes } = require('./ColdMessagePages');

const REMOVED = Symbol('removed');

// One versioned channel of tables from the main thread to the background
// workers (the cold worker and the clan planning worker), each holding a
// TableMirror. A table is registered once with its key and a way to read all
// its rows; the main thread reports each changed or removed row, which costs
// one Map write. flush() turns the changes of each table into one new version
// and posts it, in pages limited by size, to every attached worker.
// Event-driven tables schedule that same flush once per burst, before the
// next event-loop turn; passive tables can share it but never schedule it.
//
// No acknowledgements: a MessagePort keeps the order. A worker that sees a
// gap asks for the whole table (resync); a worker with a new epoch (a
// restart) gets every table in full when it attaches. A page that could not
// be posted suspends the worker: the tables of that page and of the pages
// after it, and every table that changes while it is suspended, go in full
// at the next flush, tried once (the worker sees no gap in what it never
// got, so it would not ask); when that try fails too, they wait for a new
// epoch or a resync. The tables it got stay.
class ColdTableChannel {
    constructor() {
        this.tables = new Map();
        this.targets = new Map();
        this.eventFlushQueued = false;
        this.actorRecipient = null;
        this.actorSequence = 0;
        this.actorStats = { pages: 0, inspections: 0, receiptChecks: 0, refused: 0 };
        this.stats = { flushes: 0, pages: 0, rows: 0, fulls: 0, resyncs: 0, skipped: 0, failedPosts: 0, retries: 0, suspendedFlushes: 0 };
    }

    // key(row) gives a row's key; allRows() gives every current row.
    register(name, { key, allRows, eventDriven = false, streamed = null }) {
        if (streamed !== null) return this.registerActorStream(name, { key, eventDriven, streamed });
        this.tables.set(String(name), { name: String(name), key, allRows, eventDriven,
            version: 0, pending: new Map(), changedUnseen: false });
    }

    // change: a row, or { key, removed: true } for a removed row. With no
    // worker attached nobody needs the row: a worker that attaches gets the
    // table in full, so only the next version is marked.
    changed(name, change) {
        const table = this.tables.get(String(name));
        if (!table || !change) return false;
        if (table.streamed) return this.actorChanged(table, change);
        if (!this.targets.size) {
            table.changedUnseen = true;
            return true;
        }
        if (change.removed === true) table.pending.set(change.key, REMOVED);
        else table.pending.set(table.key(change), change);
        if (table.eventDriven && !this.eventFlushQueued) {
            this.eventFlushQueued = true;
            queueMicrotask(() => {
                this.eventFlushQueued = false;
                this.flush();
            });
        }
        return true;
    }

    // target: the worker's coordinator (any key); post(payload, payloadBytes)
    // sends one page and returns false when it could not. A new epoch is a
    // new worker: it gets every table in full.
    attach(target, epoch, post, options = {}) {
        const actors = options.streamedTables;
        const wantsActor = Array.isArray(actors) && actors.includes('actors');
        if (actors !== undefined && (!Array.isArray(actors) || actors.some(name => name !== 'actors'))) {
            throw new TypeError('invalid_actor_recipient');
        }
        if (wantsActor) this.validateActorRecipient(target, post);
        const current = this.targets.get(target);
        if (current && current.epoch === epoch) {
            current.post = post;
            if (wantsActor && !current.actorRecord) {
                this.attachActorRecipient(target, current);
                this.flush();
            }
            return;
        }
        if (current?.actorRecord) this.detachActorRecipient(current.actorRecord);
        this.targets.set(target, { epoch, post, synced: new Set(), suspended: false, retried: false });
        if (wantsActor) this.attachActorRecipient(target, this.targets.get(target));
        this.flush();
    }

    detach(target) {
        const current = this.targets.get(target);
        if (current?.actorRecord) this.detachActorRecipient(current.actorRecord);
        this.targets.delete(target);
    }

    resync(target, epoch, names = []) {
        const entry = this.targets.get(target);
        if (!entry || entry.epoch !== epoch) return;
        for (const name of names) entry.synced.delete(String(name));
        if (entry.actorRecord && (names.includes('actors') || entry.actorRecord.needsFull)) {
            this.cancelActorJob(entry.actorRecord);
        }
        entry.suspended = false;
        entry.retried = false;
        DiagnosticConfig.developerDiagnostics && (this.stats.resyncs += 1);
        this.flush();
    }

    full(table) {
        const rows = [];
        for (const row of table.allRows() || []) rows.push([table.key(row), row]);
        return { name: table.name, from: null, to: table.version, full: true, rows, removed: [] };
    }

    pages(tables) {
        if (!tables.length) return [];
        const { pages, skipped } = tablePagesWithBytes(tables);
        DiagnosticConfig.developerDiagnostics && (this.stats.skipped += skipped);
        return pages;
    }

    flush() {
        // Each table's pending changes become one new version.
        const deltas = [];
        for (const table of this.tables.values()) {
            if (table.streamed) continue;
            if (!table.pending.size && !table.changedUnseen) continue;
            table.changedUnseen = false;
            const rows = [];
            const removed = [];
            for (const [key, row] of table.pending) {
                if (row === REMOVED) removed.push(key);
                else rows.push([key, row]);
            }
            table.pending = new Map();
            deltas.push({ name: table.name, from: table.version, to: table.version + 1, full: false, rows, removed });
            table.version += 1;
        }
        let sharedPages = null;
        for (const target of this.targets.values()) {
            if (target.suspended && target.retried) {
                for (const delta of deltas) target.synced.delete(delta.name);
                DiagnosticConfig.developerDiagnostics && (this.stats.suspendedFlushes += 1);
                continue;
            }
            // The one try after a failed post: what it missed goes in full.
            if (target.suspended) {
                target.suspended = false;
                target.retried = true;
                DiagnosticConfig.developerDiagnostics && (this.stats.retries += 1);
            }
            // A table the worker does not hold yet goes in full; the full copy
            // already has this flush's changes.
            const fulls = [];
            for (const table of this.tables.values()) {
                if (table.streamed) continue;
                if (target.synced.has(table.name)) continue;
                fulls.push(this.full(table));
                target.synced.add(table.name);
                DiagnosticConfig.developerDiagnostics && (this.stats.fulls += 1);
            }
            const fullNames = new Set(fulls.map((full) => full.name));
            const own = fullNames.size ? deltas.filter((delta) => !fullNames.has(delta.name)) : deltas;
            if (own === deltas && !sharedPages) sharedPages = this.pages(deltas);
            const pages = [...this.pages(fulls), ...(own === deltas ? sharedPages : this.pages(own))];
            for (let at = 0; at < pages.length; at++) {
                if (target.post(pages[at].payload, pages[at].bytes)) {
                    DiagnosticConfig.developerDiagnostics && (this.stats.pages += 1);
                    continue;
                }
                // The worker missed this page and the rest: their tables go
                // in full when it is back.
                DiagnosticConfig.developerDiagnostics && (this.stats.failedPosts += 1);
                for (const page of pages.slice(at)) {
                    for (const piece of page.payload.tables) target.synced.delete(piece.name);
                }
                target.suspended = true;
                if (target.actorRecord) this.cancelActorJob(target.actorRecord);
                break;
            }
            // Every page went: a later failed post gets its own try again.
            if (!target.suspended && target.actorRecord) this.ensureActorWork(target.actorRecord);
            if (!target.suspended && !target.actorRecord?.job) target.retried = false;
        }
        if (deltas.length) {
            DiagnosticConfig.developerDiagnostics && (this.stats.flushes += 1);
            for (const delta of deltas) DiagnosticConfig.developerDiagnostics && (this.stats.rows += delta.rows.length + delta.removed.length);
        }
    }

    // Optional actors only. Ordinary register/flush/full/pages never enter
    // this branch. Generic providers here are NOT a Native role grant.
    registerActorStream(name, { key, eventDriven, streamed }) {
        const source = streamed?.source;
        if (name !== 'actors' || this.tables.has(name) || streamed.recipient !== 'cold'
            || eventDriven !== true || typeof key !== 'function'
            || !['subscribe', 'capture', 'resolve', 'currentOccurrence'].every(method => typeof source?.[method] === 'function')) {
            throw new TypeError('invalid_actor_stream');
        }
        const table = { name, key, eventDriven, streamed: { source }, version: 0,
            pending: new Map(), changedUnseen: false };
        this.tables.set(name, table);
        try {
            const unsubscribe = source.subscribe(event => {
                if (this.tables.get(name) !== table) return;
                if (event?.kind === 'reset') {
                    table.pending = new Map();
                    table.changedUnseen = true;
                    if (this.actorRecipient) this.cancelActorJob(this.actorRecipient);
                    this.queueActorFlush();
                } else if (event?.kind === 'dirty') {
                    this.actorChanged(table, event.ref);
                }
            }, () => {
                if (this.tables.get(name) !== table) return;
                table.changedUnseen = true;
                if (this.actorRecipient) this.failActor(this.actorRecipient);
            });
            if (typeof unsubscribe !== 'function') throw new TypeError('invalid_actor_subscription');
            table.unsubscribe = unsubscribe;
        } catch (error) {
            if (this.tables.get(name) === table) this.tables.delete(name);
            throw error;
        }
    }

    nextActorIdentity() {
        if (this.actorSequence === Number.MAX_SAFE_INTEGER) throw new RangeError('actor_stream_identity_exhausted');
        return ++this.actorSequence;
    }

    validateActorRecipient(key, post) {
        if (!this.tables.get('actors')?.streamed || typeof post !== 'function'
            || (this.actorRecipient && this.actorRecipient.key !== key)) {
            throw new TypeError('invalid_actor_recipient');
        }
    }

    attachActorRecipient(key, target) {
        const table = this.tables.get('actors');
        const record = { key, target, epoch: target.epoch, table,
            attachmentId: this.nextActorIdentity(), copyId: null, occurrence: null,
            needsFull: true, stopped: false, job: null };
        target.actorRecord = record;
        this.actorRecipient = record;
        table.pending = new Map();
    }

    cancelActorJob(record) {
        if (record.job) record.job.active = false;
        record.job = null;
        record.needsFull = true;
        record.table.changedUnseen ||= record.table.pending.size > 0;
        record.table.pending = new Map();
        record.target.synced.delete('actors');
    }

    detachActorRecipient(record) {
        this.cancelActorJob(record);
        record.stopped = true;
        if (this.actorRecipient === record) this.actorRecipient = null;
    }

    // Future Coordinator must call this BEFORE its stopping awaits. Resync or
    // same-epoch callback refresh does not revive a stopped source.
    stopActorRecipient(key, epoch) {
        const record = this.actorRecipient;
        if (!record || record.key !== key || record.epoch !== epoch) return false;
        this.cancelActorJob(record);
        record.stopped = true;
        return true;
    }

    queueActorFlush() {
        if (!this.actorRecipient || this.eventFlushQueued) return;
        this.eventFlushQueued = true;
        queueMicrotask(() => {
            this.eventFlushQueued = false;
            this.flush();
        });
    }

    actorChanged(table, ref) {
        const record = this.actorRecipient;
        if (!record || record.table !== table || record.stopped || record.target.suspended) {
            table.changedUnseen = true;
            return true;
        }
        const id = table.key(ref);
        if (!Number.isSafeInteger(id) || id <= 0) {
            this.failActor(record);
            return false;
        }
        table.pending.set(id, ref);
        this.queueActorFlush();
        return true;
    }

    actorRecordCurrent(record) {
        return this.actorRecipient === record && !record.stopped
            && this.targets.get(record.key) === record.target && record.target.epoch === record.epoch
            && this.tables.get('actors') === record.table;
    }

    actorJobCurrent(record, job) {
        return this.actorRecordCurrent(record) && record.job === job && job.active
            && !record.target.suspended
            && record.table.streamed.source.currentOccurrence() === job.occurrence;
    }

    failActor(record) {
        if (!this.actorRecordCurrent(record)) return;
        DiagnosticConfig.developerDiagnostics && (this.actorStats.refused++);
        this.cancelActorJob(record);
        record.target.suspended = true;
        // No new retry task here. Only a NEXT real flush or explicit resync /
        // new epoch uses the existing target suspension/retried contract.
    }

    ensureActorWork(record) {
        if (!this.actorRecordCurrent(record) || record.target.suspended) return;
        if (record.job) { this.scheduleActorPump(record, record.job); return; }
        const table = record.table;
        if (!record.needsFull && !table.pending.size) return;
        try {
            const source = table.streamed.source;
            if (!record.needsFull && source.currentOccurrence() !== record.occurrence) {
                record.needsFull = true;
            }
            const full = record.needsFull;
            const snapshot = full ? source.capture() : null;
            const occurrence = full ? snapshot.bindingOccurrence : record.occurrence;
            const worldGeneration = full ? snapshot.worldGeneration : record.worldGeneration;
            if (!occurrence || !Number.isSafeInteger(worldGeneration) || worldGeneration <= 0
                || (full && (!Number.isSafeInteger(snapshot.count) || snapshot.count < 0))) {
                throw new TypeError('invalid_actor_capture');
            }
            if (source.currentOccurrence() !== occurrence) throw new Error('stale_actor_capture');
            const from = full ? null : table.version;
            if ((!full || table.changedUnseen) && table.version === Number.MAX_SAFE_INTEGER) {
                throw new RangeError('actor_stream_version_exhausted');
            }
            if (!full || table.changedUnseen) table.version++;
            table.changedUnseen = false;
            const copyId = full ? this.nextActorIdentity() : record.copyId;
            const job = { active: true, queued: false, occurrence, worldGeneration, copyId,
                transferId: this.nextActorIdentity(), pageIndex: 0, version: table.version, from, full,
                stage: 'head', baselineRemaining: full ? snapshot.count : 0,
                baseline: full ? snapshot.entries[Symbol.iterator]() : null,
                cut: null, cutIterator: null, cutRemaining: 0, carry: [], carryAt: 0 };
            record.job = job;
            if (!full) this.takeActorCut(record, job);
            this.scheduleActorPump(record, job);
        } catch (_) { this.failActor(record); }
    }

    takeActorCut(record, job) {
        if (job.cut) return;
        job.cut = record.table.pending;
        record.table.pending = new Map();
        job.cutIterator = job.cut.values();
        job.cutRemaining = job.cut.size;
    }

    scheduleActorPump(record, job) {
        if (job.queued || !job.active) return;
        job.queued = true;
        setImmediate(() => {
            job.queued = false;
            try {
                if (!this.actorJobCurrent(record, job)) return;
                this.pumpActor(record, job);
            } catch (_) { this.failActor(record); }
        });
    }

    actorPiece(record, job, rows, removed, { head = false, last = 0 } = {}) {
        return { name: 'actors', from: head ? job.from : job.version, to: job.version,
            full: head && job.full, last, rows, removed,
            attachmentId: record.attachmentId, copyId: job.copyId,
            transferId: job.transferId, pageIndex: job.pageIndex,
            worldGeneration: job.worldGeneration };
    }

    postActorPiece(record, job, rows, removed, receipts = [], flags = {}) {
        const page = streamedTablePageWithBytes(this.actorPiece(record, job, rows, removed, flags));
        let puts = 0, removes = 0;
        for (const receipt of receipts) {
            const selected = receipt.kind === 'put' ? puts++ < page.consumedRows : removes++ < page.consumedRemoved;
            if (!selected) continue;
            DiagnosticConfig.developerDiagnostics && (this.actorStats.receiptChecks++);
            if (!this.actorSyncTrue(receipt.current())) throw new Error('stale_actor_receipt');
        }
        if (!this.actorJobCurrent(record, job)) return false;
        // Same target/epoch may legitimately replace its callback. Capture the
        // CURRENT post once after receipt checks; no await or getter derivation.
        const post = record.target.post;
        if (typeof post !== 'function' || !this.actorSyncTrue(post(page.payload, page.bytes))) {
            this.failActor(record);
            return false;
        }
        if (!this.actorJobCurrent(record, job)) return false;
        DiagnosticConfig.developerDiagnostics && (this.actorStats.pages++);
        job.pageIndex++;
        if (!Number.isSafeInteger(job.pageIndex)) throw new RangeError('actor_stream_page_exhausted');
        return page;
    }

    actorSyncTrue(value) {
        // Invalid asynchronous callbacks refuse without assimilating arbitrary
        // thenables. Drain an actual native Promise rejection only.
        if (value instanceof Promise) Promise.prototype.then.call(value, () => null, () => null);
        return value === true;
    }

    pumpActor(record, job) {
        if (job.stage === 'head') {
            if (!this.postActorPiece(record, job, [], [], [], { head: true })) return;
            job.stage = job.full ? 'baseline' : 'cut';
            this.scheduleActorPump(record, job);
            return;
        }
        if (job.stage === 'terminal' && job.carryAt === job.carry.length) {
            if (!this.postActorPiece(record, job, [], [], [], { last: 1 })) return;
            job.active = false;
            record.job = null;
            record.needsFull = false;
            record.copyId = job.copyId;
            record.occurrence = job.occurrence;
            record.worldGeneration = job.worldGeneration;
            record.target.synced.add('actors');
            record.target.retried = false;
            // Already authored post-cut events may have flushed while this
            // copy was loading. Finish schedules their ordinary event flush,
            // never a failed-copy retry or an empty polling continuation.
            if (record.table.pending.size) this.queueActorFlush();
            return;
        }
        const refs = [];
        let inspected = 0;
        while (inspected < 64 && refs.length < 64) {
            if (job.carryAt < job.carry.length) {
                inspected++;
                DiagnosticConfig.developerDiagnostics && (this.actorStats.inspections++);
                refs.push(job.carry[job.carryAt++]);
                continue;
            }
            if (job.stage === 'terminal') break;
            if (job.stage === 'baseline' && job.baselineRemaining === 0) {
                job.stage = 'cut';
                this.takeActorCut(record, job);
            }
            if (job.stage === 'cut' && job.cutRemaining === 0) {
                job.stage = 'terminal';
                break;
            }
            const iterator = job.stage === 'baseline' ? job.baseline : job.cutIterator;
            inspected++;
            DiagnosticConfig.developerDiagnostics && (this.actorStats.inspections++);
            const next = iterator.next();
            if (!this.actorJobCurrent(record, job)) return;
            if (next.done) {
                if (job.stage === 'baseline') job.baselineRemaining = 0;
                else job.cutRemaining = 0;
                continue;
            }
            if (job.stage === 'baseline') job.baselineRemaining--;
            else job.cutRemaining--;
            refs.push(next.value);
        }
        // Collect/lazily stamp all refs BEFORE deriving an absence receipt.
        // A later publication/cutoff change rejects the whole page, never
        // skips an invalid row and then advertises last/ready.
        const rows = [], removed = [], receipts = [];
        for (const ref of refs) {
            const id = record.table.key(ref);
            const outcome = record.table.streamed.source.resolve(ref, job.occurrence);
            if (!this.actorJobCurrent(record, job)) return;
            if (!Number.isSafeInteger(id) || id <= 0 || outcome?.occurrence !== job.occurrence
                || outcome.row?.id !== id || outcome.row.worldGeneration !== job.worldGeneration
                || typeof outcome.current !== 'function') throw new TypeError('invalid_actor_resolution');
            if (outcome.kind === 'put') rows.push([id, outcome.row]);
            else if (outcome.kind === 'remove') removed.push(outcome.row);
            else throw outcome.error || new Error('actor_source_refused');
            receipts.push(outcome);
        }
        if (refs.length) {
            const page = this.postActorPiece(record, job, rows, removed, receipts);
            if (!page) return;
            let puts = 0, removes = 0;
            const carry = [];
            for (let at = 0; at < receipts.length; at++) {
                const selected = receipts[at].kind === 'put' ? puts++ < page.consumedRows : removes++ < page.consumedRemoved;
                if (!selected) carry.push(refs[at]);
            }
            // Retain only bounded ORIGINAL refs, never old derived DTO facts.
            // They consume inspection/resolve budget again on the next pump.
            job.carry = carry;
            job.carryAt = 0;
        }
        this.scheduleActorPump(record, job);
    }

    actorSnapshot() {
        const record = this.actorRecipient;
        return { subscribed: !!record, stopped: record?.stopped === true,
            transfer: record?.job?.stage ?? null, pending: record?.table.pending.size ?? 0,
            ...(DiagnosticConfig.developerDiagnostics ? this.actorStats : { diagnosticsEnabled: false }) };
    }

    snapshot() {
        if (!DiagnosticConfig.developerDiagnostics) return { enabled: false };
        const tables = {};
        for (const table of this.tables.values()) tables[table.name] = { version: table.version, pending: table.pending.size };
        return { tables, targets: this.targets.size, ...(DiagnosticConfig.developerDiagnostics ? this.stats : { diagnosticsEnabled: false }) };
    }
}

module.exports = { ColdTableChannel, shared: new ColdTableChannel() };
