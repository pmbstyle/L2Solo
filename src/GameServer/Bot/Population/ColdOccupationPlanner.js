'use strict';
const DiagnosticConfig = require('./PopulationConfig');
const Diagnostics = require('../Economy/EconomyDiagnostics');

const { performance } = require('node:perf_hooks');
const { unknownWorkshop } = require('./ColdEconomyDecision');
const MAX_CONTEXTS = 64, MAX_OWNERS = 8, OWNER_UNITS = 4, MAX_UNITS = 32, SLICE_MS = 4;
// One job per bot per mode (input.mode, 'occupation' when none): an ask of
// one mode never replaces another mode's answer.
const MODES = Object.freeze(['occupation', 'near', 'refresh', 'action', 'showcase', 'craft_market', 'meeting', 'wish']);
const keyOf = (id, mode) => `${mode || 'occupation'}:${Number(id)}`;

// Incomplete contexts stay in the working pool (slots, MAX_CONTEXTS) through
// yield. A finished job leaves the pool as a card (cards): its answer, the
// value key of what it read (inputKey) and its read board tokens, no graph,
// one per bot per mode, until its bot's next ask of that mode with another
// key, a source move on what it read, or its release. Waiting owners carry
// references to their existing native input, a 128 B numeric cursor and one
// completion callback, no graph.
// inputKey(input): the job's inputs as a value (compared with ===);
// valueKey(input): the values it reads of its state, compared only when the
// inputKey matches (the worker digests a state once). A new ask with both the
// same and no moved source gets the answer or joins the work.
// servesUntil(input): the clock (input.timestamp) from which a finished
// answer no longer serves an ask of the same key: a window for an input the
// answer reads that has no event (the worker states which); none by default.
class ColdOccupationPlanner {
    constructor({ capture, create, step, result, ownCurrent = () => true, inputKey = input => input, valueKey = () => '',
        servesUntil = () => Infinity, sourceToken, sourceScope = () => null, sourceScopeToken = () => 0,
        onSlots = () => {}, onWorking = () => {}, publish = () => {}, onPublishError = () => {}, now = () => performance.now(),
        schedule = callback => setImmediate(callback) } = {}) {
        Object.assign(this, { capture, create, step, result, ownCurrent, inputKey, valueKey, servesUntil, sourceToken, sourceScope, sourceScopeToken, onSlots, onWorking, publish, onPublishError, now, schedule });
        this.slots = new Map(); this.cards = new Map(); this.waiting = new Map(); this.ready = new Set(); this.dependencies = new Map();
        this.workingContexts = 0;
        this.errorsSeen = new Set();
        this.scopes = new Map();
        this.scopeDependencies = new Map();
        // Meeting readers share one representative item per category: their
        // token is the category fingerprint, not one item's revision.
        this.representatives = new Map();
        this.scheduled = false; this.stopped = false;
        this.stats = { portions: 0, units: 0, yields: 0, capacityDeferrals: 0, invalidations: 0,
            staleOwners: 0, unchanged: 0, maxUnitMs: 0, overBudgetUnits: 0, maxPortionUnits: 0 };
    }

    keyOf(id, mode) { return keyOf(id, mode); }
    // The bot's job of a mode: waiting, working or finished.
    entry(id, mode) {
        const key = keyOf(id, mode);
        return this.waiting.get(key) || this.slots.get(key) || this.cards.get(key);
    }
    held(key) { return this.slots.get(key) || this.cards.get(key); }
    // Every job of the bot, one per mode.
    entriesOf(id) {
        const out = [];
        for (const mode of MODES) { const entry = this.entry(id, mode); if (entry) out.push(entry); }
        return out;
    }

    request(id, input, { awaitResult = true } = {}) {
        id = Number(id);
        if (!id || this.stopped) return Promise.resolve(unknownWorkshop());
        const mode = input?.mode || 'occupation', key = keyOf(id, mode);
        const existing = this.waiting.get(key) || this.slots.get(key) || this.cards.get(key);
        const fingerprint = this.inputKey(input);
        if (existing && existing.fingerprint === fingerprint && !existing.dirty
            && !(existing.done && Number(input?.timestamp) >= existing.until) && this.valuesOf(existing) === this.valueKey(input)) {
            if (existing.done) { existing.input = input; DiagnosticConfig.developerDiagnostics && (this.stats.unchanged++); return Promise.resolve(existing.value); }
            return awaitResult ? existing.promise : null;
        }
        if (existing) this.cancel(id, mode);
        let resolve;
        const promise = new Promise(done => { resolve = done; });
        const entry = { key, id, mode, input, fingerprint, until: this.servesUntil(input), resolve, promise,
            cursor: new Float64Array(16), dirty: false, done: false, values: null };
        this.waiting.set(key, entry);
        this.kick();
        return awaitResult ? promise : null;
    }

    // The values a job was asked on (valueKey), taken at its first comparison
    // (or before its state is edited in place) and kept: a rebase keeps them.
    valuesOf(entry) { return entry.values ??= this.valueKey(entry.input); }

    // A new state of the bot on which a job reads the same (its key holds):
    // the job is kept and follows the state: a finished one takes the new
    // input, one in flight its state and owner check (its build reads the
    // same values; its publication names the new state's stamps and echo).
    rebase(entry, input) {
        if (entry.done) entry.input = input;
        else { entry.input.state = input.state; entry.input.sourceState = input.sourceState; }
    }

    kick() {
        if (this.scheduled || this.stopped || !this.waiting.size && !this.ready.size) return;
        this.scheduled = true;
        this.schedule(() => { this.scheduled = false; this.portion(); });
    }

    removeDependencies(entry) {
        for (const id of entry.reads?.keys() || []) {
            const owners = this.dependencies.get(id);
            owners?.delete(entry.key);
            if (!owners?.size) {
                this.dependencies.delete(id);
                const scope = this.sourceScope(id), items = this.scopes.get(scope);
                items?.delete(id); if (!items?.size) this.scopes.delete(scope);
            }
        }
        entry.reads?.clear();
        if (entry.admissionScope != null) {
            const scope = entry.admissionScope;
            const owners = this.scopeDependencies.get(scope);
            owners?.delete(entry.key);
            if (!owners?.size) this.scopeDependencies.delete(scope);
        }
        entry.admissionScope = null; entry.admissionToken = null;
    }

    read(entry, id) {
        id = Number(id);
        if (!(id > 0) || entry.reads.has(id)) return;
        entry.reads.set(id, this.sourceToken(id, entry.input));
        let owners = this.dependencies.get(id);
        if (!owners) this.dependencies.set(id, owners = new Set());
        owners.add(entry.key);
        const scope = this.sourceScope(id);
        if (scope !== null) {
            let items = this.scopes.get(scope); if (!items) this.scopes.set(scope, items = new Set());
            items.add(id);
        }
    }

    readGroup(entry, id) {
        const scope = this.sourceScope(Number(id));
        if (scope === null) return this.read(entry, id);
        if (!this.representatives.has(scope)) this.representatives.set(scope, Number(id));
        this.read(entry, this.representatives.get(scope));
    }

    // A board row change in a category: per-item readers are rechecked by
    // sourceChanged(item); only the category representative is rechecked here.
    groupChanged(scope) {
        const id = this.representatives.get(scope);
        if (id !== undefined) this.sourceChanged(id);
    }

    // Producer dispatch names an item; it never walks all owners or a board.
    sourceChanged(id) {
        id = Number(id);
        for (const owner of this.dependencies.get(id) || []) {
            const entry = this.held(owner);
            if (!entry) continue;
            const token = this.sourceToken(id, entry.input);
            if (entry.reads.get(id) === token) continue;
            // Coalesce by the exact used item revision. Updating this token is
            // safe only together with dirty: the obsolete work is never applied.
            const wasDirty = entry.dirty;
            entry.reads.set(id, token); entry.dirty = true;
            if (entry.cursor) entry.cursor[14] = 1;
            DiagnosticConfig.developerDiagnostics && (this.stats.invalidations++);
            if (!entry.done) this.ready.add(owner);
            else if (!wasDirty) this.publish(entry.id, entry.input, unknownWorkshop(), { stale: true });
        }
        this.kick();
    }
    readScope(entry, scope) {
        if (scope == null || entry.admissionScope === scope) return;
        // Admission needs one scope. Do not turn discovery into a per-bot
        // catalogue of category dependencies.
        if (entry.admissionScope != null) throw Error('occupation_admission_scope_limit');
        entry.admissionScope = scope; entry.admissionToken = this.sourceScopeToken(scope);
        let owners = this.scopeDependencies.get(scope);
        if (!owners) this.scopeDependencies.set(scope, owners = new Set());
        owners.add(entry.key);
    }
    scopeChanged(scope) {
        for (const id of this.scopes.get(scope) || []) this.sourceChanged(id);
        const token = this.sourceScopeToken(scope);
        for (const owner of this.scopeDependencies.get(scope) || []) {
            const entry = this.held(owner);
            if (!entry || entry.admissionToken === token) continue;
            entry.admissionToken = token;
            const wasDirty = entry.dirty;
            entry.dirty = true; if (entry.cursor) entry.cursor[14] = 1;
            if (!wasDirty) DiagnosticConfig.developerDiagnostics && (this.stats.invalidations++);
            if (!entry.done) this.ready.add(owner);
            else if (!wasDirty) this.publish(entry.id, entry.input, unknownWorkshop(), { stale: true });
        }
        this.kick();
    }
    markReset(entry) {
        // A source table was replaced, no board move: a build kept on the input
        // may have read it empty (ColdSimulationWorker, refresh).
        entry.input.builtRefresh = null;
        entry.dirty = true; if (entry.cursor) entry.cursor[14] = 2;
        DiagnosticConfig.developerDiagnostics && (this.stats.invalidations++);
        if (entry.done) this.publish(entry.id, entry.input, unknownWorkshop(), { stale: true });
    }
    // After a whole source table was replaced and its full copy applied: only
    // the jobs whose read items or admission scope moved are marked, as
    // sourceChanged/scopeChanged mark them per row; a row the copy no longer
    // has reads as a moved token. Not during the copy: the table reads empty.
    recheckSources() {
        let moved = 0, kept = 0;
        for (const entry of [...this.slots.values(), ...this.cards.values()]) {
            if (entry.mode === 'wish' || entry.dirty || !entry.reads) continue;
            let changed = entry.admissionScope != null && entry.admissionToken !== this.sourceScopeToken(entry.admissionScope);
            if (!changed) {
                for (const [id, token] of entry.reads) {
                    if (this.sourceToken(id, entry.input) !== token) { changed = true; break; }
                }
            }
            if (changed) { this.markReset(entry); moved++; } else kept++;
        }
        if (moved) Diagnostics.count('occupation', 'source_reset', 'moved', moved);
        if (kept) Diagnostics.count('occupation', 'source_reset', 'kept', kept);
    }

    admit() {
        let admitted = 0;
        for (const [key, entry] of this.waiting) {
            if (admitted === MAX_OWNERS) break;
            // Finished jobs are cards outside the pool: only unfinished work
            // holds a context, and it is never evicted.
            if (this.slots.size >= MAX_CONTEXTS) { DiagnosticConfig.developerDiagnostics && (this.stats.capacityDeferrals++); break; }
            this.waiting.delete(key); this.slots.set(key, entry); this.ready.add(key);
            this.onWorking(++this.workingContexts);
            this.onSlots(this.slots.size); admitted++;
        }
    }

    initialise(entry) {
        this.removeDependencies(entry);
        entry.reads = new Map(); entry.dirty = false; entry.cursor.fill(0);
        const read = entry.mode === 'meeting' ? id => this.readGroup(entry, id) : id => this.read(entry, id);
        entry.captured = this.capture(entry.id, entry.input, read, scope => this.readScope(entry, scope));
        entry.work = this.create(entry.captured);
        entry.validation = null;
    }

    // A failed build ends as an empty result: each distinct failure is logged
    // once, as an error the deploy read counts. A meeting's refusal is its answer.
    reportError(entry) {
        if (entry.mode === 'meeting' || this.errorsSeen.has(entry.error) || this.errorsSeen.size >= 32) return;
        this.errorsSeen.add(entry.error);
        console.error(`ColdOccupationPlanner :: Error: ${entry.error}`);
    }

    finish(entry, value) {
        if (entry.done || this.slots.get(entry.key) !== entry) return;
        entry.done = true; entry.value = value ?? (entry.mode === 'action' ? null : unknownWorkshop());
        // The card keeps the answer, its key and its read tokens: no scratch
        // graph, no cursor. It leaves the working pool.
        entry.work = null; entry.captured = null; entry.validation = null; entry.cursor = null;
        this.slots.delete(entry.key); this.ready.delete(entry.key); this.cards.set(entry.key, entry);
        this.onWorking(--this.workingContexts); this.onSlots(this.slots.size);
        entry.resolve(entry.value); entry.resolve = null; entry.promise = null;
        try { this.publish(entry.id, entry.input, entry.value); }
        catch (error) {
            entry.error = String(error?.message || error);
            this.onPublishError(error, entry.id, entry.input);
        }
    }

    unit(entry) {
        if (!this.ownCurrent(entry.id, entry.input)) {
            DiagnosticConfig.developerDiagnostics && (this.stats.staleOwners++); this.cancel(entry.id, entry.mode); return;
        }
        if (!entry.work || entry.dirty) { this.initialise(entry); return; }
        if (entry.validation) {
            const next = entry.validation.next();
            if (!next.done) {
                const [id, token, scope] = next.value;
                entry.cursor[3]++;
                if ((scope ? this.sourceScopeToken(id) : this.sourceToken(id, entry.input)) !== token) {
                    entry.dirty = true; entry.cursor[14] = 1; DiagnosticConfig.developerDiagnostics && (this.stats.invalidations++);
                }
                return;
            }
            this.finish(entry, this.result(entry.work)); return;
        }
        // The cursor keeps the validation, invalidation and unit marks only:
        // nothing reads a per-unit copy of the work's own position fields.
        const done = this.step(entry.work);
        entry.cursor[15]++;
        if (done) entry.validation = (function* () {
            yield* entry.reads.entries();
            if (entry.admissionScope != null) yield [entry.admissionScope, entry.admissionToken, true];
        })();
    }

    portion() {
        if (this.stopped) return { units: 0, deferred: true };
        this.admit();
        // One clock read per unit: the end of a unit is the slice check of
        // the next one and, with diagnostics, the unit's own duration.
        let clock = this.now(); const started = clock; let units = 0, owners = 0;
        // Set insertion order supplies round-robin fairness across portions.
        for (const key of [...this.ready].slice(0, MAX_OWNERS)) {
            const entry = this.slots.get(key);
            this.ready.delete(key);
            if (!entry || entry.done) continue;
            owners++;
            for (let count = 0; count < OWNER_UNITS && units < MAX_UNITS; count++) {
                if (units && clock - started >= SLICE_MS) break;
                const unitStarted = clock;
                try { this.unit(entry); }
                catch (error) { entry.error = String(error?.message || error); this.reportError(entry); this.finish(entry, entry.mode === 'meeting'
                    ? { refused: true, reason: entry.error, ...(error.priceEvidence ? { priceEvidence: error.priceEvidence } : {}),
                        ...(error.priceFallback ? { priceFallback: error.priceFallback } : {}) }
                    : unknownWorkshop()); }
                clock = this.now();
                const duration = clock - unitStarted;
                DiagnosticConfig.developerDiagnostics && (this.stats.maxUnitMs = Math.max(this.stats.maxUnitMs, duration));
                if (duration > SLICE_MS) DiagnosticConfig.developerDiagnostics && (this.stats.overBudgetUnits++);
                units++; DiagnosticConfig.developerDiagnostics && (this.stats.units++);
                if (entry.done || this.slots.get(key) !== entry) break;
            }
            if (!entry.done && this.slots.get(key) === entry) this.ready.add(key);
            if (units >= MAX_UNITS || clock - started >= SLICE_MS) break;
        }
        DiagnosticConfig.developerDiagnostics && (this.stats.portions++); DiagnosticConfig.developerDiagnostics && (this.stats.maxPortionUnits = Math.max(this.stats.maxPortionUnits, units));
        if (this.ready.size || this.waiting.size) { DiagnosticConfig.developerDiagnostics && (this.stats.yields++); this.kick(); }
        return { units, owners, deferred: !units && !!this.waiting.size };
    }

    // Drops the bot's job of a mode (finished or in the pool).
    release(id, mode) {
        const key = keyOf(id, mode);
        const entry = this.slots.get(key) || this.cards.get(key);
        if (!entry) return;
        this.removeDependencies(entry); this.ready.delete(key);
        if (this.slots.delete(key)) { this.onWorking(--this.workingContexts); this.onSlots(this.slots.size); }
        else this.cards.delete(key);
    }
    // Drops every job of the bot that was asked on this state object.
    cancelState(id, state) {
        let cancelled = false;
        for (const entry of this.entriesOf(id)) if (entry.input.state === state) { this.cancel(id, entry.mode); cancelled = true; }
        return cancelled;
    }
    // mode: one job of the bot; none: every job of the bot.
    cancel(id, mode = null) {
        if (mode === null) { for (const each of MODES) this.cancel(id, each); return; }
        const key = keyOf(id, mode);
        const entry = this.waiting.get(key) || this.slots.get(key) || this.cards.get(key);
        if (!entry) return;
        this.waiting.delete(key);
        entry.resolve?.(unknownWorkshop()); entry.resolve = null;
        this.release(id, mode);
    }
    stop() {
        this.stopped = true;
        for (const entry of [...this.slots.values(), ...this.cards.values(), ...this.waiting.values()]) this.cancel(entry.id, entry.mode);
        this.ready.clear(); this.dependencies.clear(); this.scopes.clear(); this.scopeDependencies.clear(); this.representatives.clear();
    }
    snapshot() { if (!DiagnosticConfig.developerDiagnostics) return { enabled: false }; return { ...this.stats, contexts: this.slots.size, cards: this.cards.size,
        working: this.workingContexts, pending: this.waiting.size,
        active: this.ready.size, dependencies: this.dependencies.size, cursorBytes: (this.slots.size + this.waiting.size) * 128 }; }
}

module.exports = { ColdOccupationPlanner, MAX_CONTEXTS, MAX_OWNERS, OWNER_UNITS, MAX_UNITS, SLICE_MS, MODES };
