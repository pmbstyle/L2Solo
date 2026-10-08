const DiagnosticConfig = require('./PopulationConfig');
'use strict';

const { performance } = require('node:perf_hooks');
const { unknownWorkshop } = require('./ColdEconomyDecision');
const MAX_CONTEXTS = 64, MAX_OWNERS = 8, OWNER_UNITS = 4, MAX_UNITS = 32, SLICE_MS = 4;
const CURSOR_FIELDS = ['stage', 'row', 'ingredient', 'quote', 'edge', 'recipe', 'route', 'price',
    'batch', 'low', 'high', 'outcome', 'segment', 'source', 'reason', 'units'];

// Incomplete contexts stay in slots through yield. Only completed derived
// entries are evictable. Waiting owners carry references to their existing
// native input, a 128 B numeric cursor and one completion callback, no graph.
class ColdOccupationPlanner {
    constructor({ capture, create, step, result, ownCurrent = () => true, sameInput = (left, right) => left === right,
        sourceToken, sourceScope = () => null, sourceScopeToken = () => 0,
        onSlots = () => {}, publish = () => {}, now = () => performance.now(),
        schedule = callback => setImmediate(callback) } = {}) {
        Object.assign(this, { capture, create, step, result, ownCurrent, sameInput, sourceToken, sourceScope, sourceScopeToken, onSlots, publish, now, schedule });
        this.slots = new Map(); this.waiting = new Map(); this.ready = new Set(); this.dependencies = new Map();
        this.scopes = new Map();
        this.scopeDependencies = new Map();
        this.scheduled = false; this.stopped = false;
        this.stats = { portions: 0, units: 0, yields: 0, capacityDeferrals: 0, invalidations: 0,
            staleOwners: 0, unchanged: 0, maxUnitMs: 0, overBudgetUnits: 0, maxPortionUnits: 0 };
    }

    request(id, input, { awaitResult = true } = {}) {
        id = Number(id);
        if (!id || this.stopped) return Promise.resolve(unknownWorkshop());
        const existing = this.slots.get(id) || this.waiting.get(id);
        if (existing && this.sameInput(existing.input, input) && !existing.dirty) {
            if (existing.done) { existing.input = input; DiagnosticConfig.developerDiagnostics && (this.stats.unchanged++); return Promise.resolve(existing.value); }
            return awaitResult ? existing.promise : null;
        }
        if (existing && !existing.done) this.cancel(id, 'owner_replaced');
        else if (existing) this.release(id);
        let resolve;
        const promise = new Promise(done => { resolve = done; });
        const entry = { id, input, resolve, promise, cursor: new Float64Array(16), dirty: false, done: false };
        this.waiting.set(id, entry);
        this.kick();
        return awaitResult ? promise : null;
    }

    valueFor(id, state) {
        const entry = this.slots.get(Number(id));
        return entry?.done && !entry.dirty && entry.input.mode !== 'action' && entry.input.state === state ? entry.value : null;
    }

    kick() {
        if (this.scheduled || this.stopped || !this.waiting.size && !this.ready.size) return;
        this.scheduled = true;
        this.schedule(() => { this.scheduled = false; this.portion(); });
    }

    removeDependencies(entry) {
        for (const id of entry.reads?.keys() || []) {
            const owners = this.dependencies.get(id);
            owners?.delete(entry.id);
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
            owners?.delete(entry.id);
            if (!owners?.size) this.scopeDependencies.delete(scope);
        }
        entry.admissionScope = null; entry.admissionToken = null;
    }

    read(entry, id) {
        id = Number(id);
        if (!(id > 0) || entry.reads.has(id)) return;
        entry.reads.set(id, this.sourceToken(id));
        let owners = this.dependencies.get(id);
        if (!owners) this.dependencies.set(id, owners = new Set());
        owners.add(entry.id);
        const scope = this.sourceScope(id);
        if (scope !== null) {
            let items = this.scopes.get(scope); if (!items) this.scopes.set(scope, items = new Set());
            items.add(id);
        }
    }

    // Producer dispatch names an item; it never walks all owners or a board.
    sourceChanged(id) {
        id = Number(id);
        const token = this.sourceToken(id);
        for (const owner of this.dependencies.get(id) || []) {
            const entry = this.slots.get(owner);
            if (!entry || entry.reads.get(id) === token) continue;
            // Coalesce by the exact used item revision. Updating this token is
            // safe only together with dirty: the obsolete work is never applied.
            entry.reads.set(id, token); entry.dirty = true;
            entry.cursor[14] = 1; DiagnosticConfig.developerDiagnostics && (this.stats.invalidations++);
            if (!entry.done) this.ready.add(owner);
            else this.publish(entry.id, entry.input, unknownWorkshop(), { stale: true });
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
        owners.add(entry.id);
    }
    scopeChanged(scope) {
        for (const id of this.scopes.get(scope) || []) this.sourceChanged(id);
        const token = this.sourceScopeToken(scope);
        for (const owner of this.scopeDependencies.get(scope) || []) {
            const entry = this.slots.get(owner);
            if (!entry || entry.admissionToken === token) continue;
            entry.admissionToken = token;
            const wasDirty = entry.dirty;
            entry.dirty = true; entry.cursor[14] = 1;
            if (!wasDirty) DiagnosticConfig.developerDiagnostics && (this.stats.invalidations++);
            if (!entry.done) this.ready.add(owner);
            else if (!wasDirty) this.publish(entry.id, entry.input, unknownWorkshop(), { stale: true });
        }
        this.kick();
    }
    resetSources() {
        for (const entry of this.slots.values()) {
            if (entry.input.mode === 'wish') continue; // Route-only work has no board/market dependencies.
            if (entry.dirty) continue;
            entry.dirty = true; entry.cursor[14] = 2; DiagnosticConfig.developerDiagnostics && (this.stats.invalidations++);
            if (entry.done) this.publish(entry.id, entry.input, unknownWorkshop(), { stale: true });
        }
    }

    admit() {
        let admitted = 0;
        for (const [id, entry] of this.waiting) {
            if (admitted === MAX_OWNERS) break;
            if (this.slots.size >= MAX_CONTEXTS) {
                let victim;
                for (const held of this.slots.values()) if (held.done) { victim = held.id; break; }
                if (victim === undefined) { DiagnosticConfig.developerDiagnostics && (this.stats.capacityDeferrals++); break; }
                this.release(victim);
            }
            this.waiting.delete(id); this.slots.set(id, entry); this.ready.add(id);
            this.onSlots(this.slots.size); admitted++;
        }
    }

    initialise(entry) {
        this.removeDependencies(entry);
        entry.reads = new Map(); entry.dirty = false; entry.cursor.fill(0);
        entry.captured = this.capture(entry.id, entry.input, id => this.read(entry, id), scope => this.readScope(entry, scope));
        entry.work = this.create(entry.captured);
        entry.validation = null;
    }

    finish(entry, value) {
        entry.done = true; entry.value = value ?? (entry.input.mode === 'action' ? null : unknownWorkshop());
        entry.work = null; entry.captured = null; entry.validation = null;
        // Completion retains compact scalar evidence only, never an owner
        // inventory/recipe graph. The input reference is native lifetime-bound.
        entry.resolve(entry.value); entry.resolve = null; entry.promise = null;
        this.publish(entry.id, entry.input, entry.value);
    }

    unit(entry) {
        if (!this.ownCurrent(entry.id, entry.input)) {
            DiagnosticConfig.developerDiagnostics && (this.stats.staleOwners++); this.cancel(entry.id, 'owner_stale'); return;
        }
        if (!entry.work || entry.dirty) { this.initialise(entry); return; }
        if (entry.validation) {
            const next = entry.validation.next();
            if (!next.done) {
                const [id, token, scope] = next.value;
                entry.cursor[3]++;
                if ((scope ? this.sourceScopeToken(id) : this.sourceToken(id)) !== token) {
                    entry.dirty = true; entry.cursor[14] = 1; DiagnosticConfig.developerDiagnostics && (this.stats.invalidations++);
                }
                return;
            }
            this.finish(entry, this.result(entry.work)); return;
        }
        const done = this.step(entry.work);
        const state = entry.work.cursor || entry.work.position || entry.work;
        for (let i = 0; i < CURSOR_FIELDS.length; i++) {
            const value = Number(state[CURSOR_FIELDS[i]]);
            if (Number.isFinite(value)) entry.cursor[i] = value;
        }
        entry.cursor[15]++;
        if (done) entry.validation = (function* () {
            yield* entry.reads.entries();
            if (entry.admissionScope != null) yield [entry.admissionScope, entry.admissionToken, true];
        })();
    }

    portion() {
        if (this.stopped) return { units: 0, deferred: true };
        this.admit();
        const started = this.now(); let units = 0, owners = 0;
        // Set insertion order supplies round-robin fairness across portions.
        for (const id of [...this.ready].slice(0, MAX_OWNERS)) {
            const entry = this.slots.get(id);
            this.ready.delete(id);
            if (!entry || entry.done) continue;
            owners++;
            for (let count = 0; count < OWNER_UNITS && units < MAX_UNITS; count++) {
                if (units && this.now() - started >= SLICE_MS) break;
                const unitStarted = DiagnosticConfig.developerDiagnostics ? this.now() : 0;
                try { this.unit(entry); }
                catch (error) { entry.error = String(error?.message || error); this.finish(entry, unknownWorkshop()); }
                const duration = DiagnosticConfig.developerDiagnostics ? this.now() - unitStarted : 0;
                DiagnosticConfig.developerDiagnostics && (this.stats.maxUnitMs = Math.max(this.stats.maxUnitMs, duration));
                if (duration > SLICE_MS) DiagnosticConfig.developerDiagnostics && (this.stats.overBudgetUnits++);
                units++; DiagnosticConfig.developerDiagnostics && (this.stats.units++);
                if (entry.done || !this.slots.has(id)) break;
            }
            if (!entry.done && this.slots.has(id)) this.ready.add(id);
            if (units >= MAX_UNITS || this.now() - started >= SLICE_MS) break;
        }
        DiagnosticConfig.developerDiagnostics && (this.stats.portions++); DiagnosticConfig.developerDiagnostics && (this.stats.maxPortionUnits = Math.max(this.stats.maxPortionUnits, units));
        if (this.ready.size || this.waiting.size) { DiagnosticConfig.developerDiagnostics && (this.stats.yields++); this.kick(); }
        return { units, owners, deferred: !units && !!this.waiting.size };
    }

    release(id) {
        id = Number(id);
        const entry = this.slots.get(id);
        if (!entry) return;
        this.removeDependencies(entry); this.slots.delete(id); this.ready.delete(id);
        this.onSlots(this.slots.size);
    }
    cancelState(id, state) {
        const entry = this.slots.get(Number(id)) || this.waiting.get(Number(id));
        if (!entry || entry.input.state !== state) return false;
        this.cancel(id);
        return true;
    }
    cancel(id) {
        const entry = this.slots.get(Number(id)) || this.waiting.get(Number(id));
        if (!entry) return;
        this.waiting.delete(Number(id));
        entry.resolve?.(unknownWorkshop()); entry.resolve = null;
        this.release(Number(id));
    }
    stop() {
        this.stopped = true;
        for (const id of [...this.slots.keys(), ...this.waiting.keys()]) this.cancel(id);
        this.ready.clear(); this.dependencies.clear(); this.scopes.clear(); this.scopeDependencies.clear();
    }
    snapshot() { if (!DiagnosticConfig.developerDiagnostics) return { enabled: false }; return { ...this.stats, contexts: this.slots.size, pending: this.waiting.size,
        active: this.ready.size, dependencies: this.dependencies.size, cursorBytes: (this.slots.size + this.waiting.size) * 128 }; }
}

module.exports = { ColdOccupationPlanner, MAX_CONTEXTS, MAX_OWNERS, OWNER_UNITS, MAX_UNITS, SLICE_MS };
