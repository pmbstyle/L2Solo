'use strict';
const DiagnosticConfig = require('./PopulationConfig');
const Material = require('./CraftMaterialParty');

const SAFETY_INTERVAL_MS = 30 * 60000;
// The askers of a region and band a seeker's page takes at most (meetingCut counts a page that left some).
const MEETING_PAGE = 8;

function joinPool(pools, key, id, record) {
    if (!pools.has(key)) pools.set(key, new Map());
    pools.get(key).set(id, record);
}
function leavePool(pools, key, id) {
    const pool = pools.get(key);
    pool?.delete(id);
    if (!pool?.size) pools.delete(key);
}

// An input index holds original published states. Combat/coordinate updates
// refresh the reference without restarting an unchanged assembly decision.
// A group (one forming objective's candidates) runs when a member that seeks a party
// (classify: seeks, an open request) moves: in, or a field of its waking stamp; and when
// any member leaves it while it holds seekers (a leaver can unblock a roster). A bot
// merely willing to party is roster fill and wakes nothing. Only the rosters with a
// moved member are judged (a run with none recorded: its seekers'): one of unmoved
// members holds its answer. Its outcome holds until the next move: forming's no closes
// the refused roster's requests (their next build reopens them, a move), none is asked
// again on a clock; one refused past its verdict, or given none, is woken on its
// members' rows (rewakeOn); one with no party slot when a party ends (waitSlot). A group the
// running formation kept waiting (busy) runs when that formation ends (wakeParked);
// only a deferral no event ends (main's lag, the DB queue, the formation budget, a
// replaced state) is retried after retryMs.
class PartyAssemblyEvents {
    constructor({ registry, life, parties, classify, run, now = Date.now,
        retryMs = 30000, onRepair = () => {}, onError = () => {} }) {
        Object.assign(this, { registry, life, parties, classify, run, now,
            retryMs, onRepair, onError });
        this.records = new Map();
        this.groups = new Map();
        this.supports = new Map();
        // meetingKey -> the bots whose open request to meet is heard there (an LFP:
        // PartyRequestPlanner.meetingKey, region x level band), kept at its open and close.
        this.meetings = new Map();
        this.dirty = new Set();
        this.deadlines = new Set();
        this.parked = new Set();
        this.rewake = new Set();
        this.slotWaiters = new Set();
        this.running = false;
        this.active = false;
        this.generation = 0;
        this.safetyKey = {};
        this.helpKey = {};
        this.metrics = { events: 0, attempts: 0, safetyInspected: 0, repaired: 0, meetingCut: 0 };
    }

    arm(key, at, callback) {
        this.deadlines.add(key);
        return this.registry.armDeadline(key, Math.ceil(at), timestamp => {
            this.deadlines.delete(key);
            if (this.active) callback(timestamp);
        });
    }

    cancel(key) { this.deadlines.delete(key); this.registry.cancelDeadline(key); }

    start() {
        if (this.active) return false;
        this.active = true; this.generation++;
        this.unsubscribeLife = this.life.subscribePublications(packet => this.observe(packet), { replay: true });
        this.unsubscribeParty = this.parties.subscribeChanges((party, previous) => {
            if (party.memberIds?.join(':') === previous?.memberIds?.join(':') && party.status === previous?.status) return;
            for (const id of new Set([...(party.memberIds || []), ...(previous?.memberIds || [])])) {
                this.observe({ characterId: id, state: this.life.cachedState(id) });
            }
            // Freed capacity wakes already indexed waiting groups, and the rosters refused for want of a slot.
            if (previous && party.status === 'dissolved') {
                this.enqueue(this.groups.get(`spot:${party.spotId || previous.spotId}`));
                const waiting = [...this.slotWaiters];
                this.slotWaiters.clear();
                for (const id of waiting) this.wakeNow(id);
            }
        });
        this.unsubscribeTick = this.registry.subscribeTicks(timestamp => this.pulse(timestamp));
        this.scheduleSafety(this.now());
        return true;
    }

    stop() {
        this.active = false; this.generation++;
        this.unsubscribeLife?.(); this.unsubscribeParty?.(); this.unsubscribeTick?.();
        for (const key of this.deadlines) this.registry.cancelDeadline(key);
        this.deadlines.clear(); this.records.clear(); this.groups.clear(); this.supports.clear(); this.meetings.clear();
        this.dirty.clear(); this.parked.clear();
        this.rewake.clear(); this.slotWaiters.clear();
        this.cycle = null; this.helpPending = false;
    }

    enqueue(group) {
        if (group && this.active) {
            this.cancel(group);
            group.remaining = group.members.size;
            this.dirty.add(group.key);
        }
    }

    observe(packet, repair = false) {
        if (!this.active) return false;
        if (packet.kind === 'reset') {
            for (const group of this.groups.values()) this.cancel(group);
            this.records.clear(); this.groups.clear(); this.supports.clear(); this.meetings.clear(); this.dirty.clear(); this.rewake.clear();
            this.slotWaiters.clear();
            return false;
        }
        const id = Number(packet.characterId), state = this.life.cachedState(id);
        // A reentrant publication must never revive an old source.
        if (packet.state && packet.state !== state) return false;
        const input = state && this.classify(state, this.now());
        const previous = this.records.get(id);
        if (previous?.supportKey && previous.supportKey !== input?.supportKey) leavePool(this.supports, previous.supportKey, id);
        if (previous?.meetingKey && previous.meetingKey !== input?.meetingKey) leavePool(this.meetings, previous.meetingKey, id);
        const moved = previous?.key !== input?.key;
        const changed = moved || !previous || !input || previous.stamp.some((field, index) => field !== input.stamp[index]);
        const wake = !!input && (this.rewake.delete(id) || changed && input.seeks);
        if (previous && (!input || moved)) {
            const left = this.groups.get(previous.key);
            left?.members.delete(id); left?.seekers.delete(id);
            this.records.delete(id);
            if (left?.seekers.size) { left.revision++; for (const seeker of left.seekers) left.moved.add(seeker); this.enqueue(left); }
        }
        if (!input) {
            this.rewake.delete(id); this.slotWaiters.delete(id);
            if (previous && repair) { DiagnosticConfig.developerDiagnostics && (this.metrics.repaired++); this.onRepair(); }
            return !!previous;
        }
        const record = previous && !moved ? previous : { id, key: input.key, stamp: input.stamp, state };
        record.stamp = input.stamp;
        record.state = state;
        record.supportKey = input.supportKey;
        if (input.supportKey) joinPool(this.supports, input.supportKey, id, record);
        record.meetingKey = input.meetingKey || null;
        if (record.meetingKey) joinPool(this.meetings, record.meetingKey, id, record);
        if (!this.groups.has(input.key)) this.groups.set(input.key, { key: input.key, members: new Map(), revision: 0, handled: 0,
            moved: new Set(), seekers: new Set() });
        const group = this.groups.get(input.key);
        group.members.set(id, record);
        if (input.seeks) group.seekers.add(id); else group.seekers.delete(id);
        this.records.set(id, record);
        if (wake) {
            group.revision++; group.moved.add(id); this.enqueue(group); DiagnosticConfig.developerDiagnostics && (this.metrics.events++);
            if (repair) { DiagnosticConfig.developerDiagnostics && (this.metrics.repaired++); this.onRepair(); }
        }
        if (repair && group.handled < group.revision && !this.dirty.has(group.key)
            && !this.deadlines.has(group) && !this.running) {
            this.enqueue(group); DiagnosticConfig.developerDiagnostics && (this.metrics.repaired++); this.onRepair();
        }
        return changed || !previous;
    }

    // A roster refused past its verdict or given none (states: the rows it was judged
    // on): a member whose row has moved since is already published, its group runs now;
    // the others' next published rows wake their groups (observe).
    rewakeOn(states) {
        if (!this.active) return;
        for (const state of states) {
            const id = Number(state.characterId);
            if (this.life.cachedState(id) !== state) this.wakeNow(id); else this.rewake.add(id);
        }
    }

    // A roster refused for want of a party slot: its groups run when a party ends.
    // Returns how many of its groups were refused at a revision not refused before
    // (a group's later pages and retries at the same revision are the same refusal).
    waitSlot(states) {
        if (!this.active) return 0;
        let refused = 0;
        for (const state of states) {
            const id = Number(state.characterId), group = this.groups.get(this.records.get(id)?.key);
            this.slotWaiters.add(id);
            if (group && group.slotRefused !== group.revision) { group.slotRefused = group.revision; refused++; }
        }
        return refused;
    }

    // The member's group runs now, its rosters judged.
    wakeNow(id) {
        this.rewake.delete(id);
        const group = this.groups.get(this.records.get(id)?.key);
        if (!group) return;
        group.revision++; group.moved.add(id); this.enqueue(group);
    }

    wakeHelp() { if (this.active) this.helpPending = true; }

    // The running formation ended: the groups it kept waiting run.
    wakeParked() {
        for (const group of this.parked) if (this.groups.get(group.key) === group) this.enqueue(group);
        this.parked.clear();
    }

    scheduleSafety(timestamp) {
        this.arm(this.safetyKey, timestamp + SAFETY_INTERVAL_MS, startedAt => {
            this.cycle = { cursor: { afterId: 0 }, startedAt, generation: this.generation,
                membership: this.records.values(), remaining: this.records.size, nativeDone: false };
        });
    }

    async safetyStep() {
        const cycle = this.cycle;
        if (!cycle || this.safetyRunning) return;
        this.safetyRunning = true;
        try {
            if (cycle.nativeDone) {
                for (let inspected = 0; inspected < 64 && cycle.remaining > 0; inspected++) {
                    const next = cycle.membership.next(); cycle.remaining--;
                    if (next.done) { cycle.remaining = 0; break; }
                    const record = next.value; DiagnosticConfig.developerDiagnostics && (this.metrics.safetyInspected++);
                    if (this.records.get(record.id) === record && !this.life.cachedState(record.id)) {
                        this.observe({ characterId: record.id }, true);
                    }
                }
                if (!cycle.remaining) { this.cycle = null; this.scheduleSafety(Math.max(this.now(), cycle.startedAt)); }
                return;
            }
            const page = await this.life.safetyPage({ ...cycle.cursor, limit: 64 });
            if (!this.active || this.cycle !== cycle || this.generation !== cycle.generation) return;
            for (const row of page.rows) {
                DiagnosticConfig.developerDiagnostics && (this.metrics.safetyInspected++);
                this.observe({ characterId: row.characterId, state: this.life.cachedState(row.characterId) }, true);
            }
            cycle.cursor = page.cursor;
            if (page.done) {
                cycle.nativeDone = true;
                if (!cycle.remaining) { this.cycle = null; this.scheduleSafety(Math.max(this.now(), cycle.startedAt)); }
            }
        } catch (error) { this.onError(error); }
        finally { this.safetyRunning = false; }
    }

    // Up to `limit` support candidates (no party goal; healer, buffer or tank)
    // of one level and role. Inspects at most `limit` entries of the pool and
    // rotates each one, so the next call starts with other candidates. A
    // returned id is added to `used`; ids already in it are skipped.
    supportShortlist(level, role, limit, used = new Set()) {
        return this.shortlist(this.supports.get(`${level}:${role}`), limit, used);
    }

    // Up to `limit` current states of a pool, inspecting at most `limit` entries and
    // rotating each one (the next call starts with others); `used` as supportShortlist's.
    shortlist(pool, limit, used = new Set()) {
        const shortlist = [];
        if (!pool?.size) return shortlist;
        const count = Math.min(limit, pool.size), iterator = pool.entries();
        for (let inspected = 0; inspected < count; inspected++) {
            const [id, record] = iterator.next().value;
            pool.delete(id); pool.set(id, record);
            const state = this.life.cachedState(id);
            if (state !== record.state || used.has(id)) continue;
            shortlist.push(state); used.add(id);
        }
        return shortlist;
    }

    pulse(timestamp = this.now()) {
        if (!this.active) return;
        if (this.cycle) this.safetyStep();
        if (this.running || !this.helpPending && !this.dirty.size) return;
        const key = this.helpPending ? null : this.dirty.values().next().value;
        const group = key === null ? null : this.groups.get(key);
        this.helpPending = false; this.dirty.delete(key);
        if (key !== null && (!group || !group.members.size)) { this.groups.delete(key); return; }
        // No move recorded and no seeker (a repair, freed capacity): nothing to judge.
        if (group && !group.moved.size && !group.seekers.size) { group.handled = group.revision; group.remaining = 0; return; }
        const candidates = [];
        if (group) {
            // Rotate a bounded page, including invalid/busy inspections.
            const count = Math.min(64, group.members.size, group.remaining ?? group.members.size), iterator = group.members.entries();
            for (let inspected = 0; inspected < count; inspected++) {
                const [id, record] = iterator.next().value;
                group.members.delete(id); group.members.set(id, record);
                if (this.life.cachedState(id) === record.state) candidates.push(record.state);
            }
            group.remaining = Math.max(0, Number(group.remaining || count) - count);
        }
        const materialCore = candidates.find(state => Material.isObjective(state.stats?.partyRequest));
        if (materialCore) {
            const used = new Set(candidates.map(state => state.characterId));
            let inspected = 0, added = 0;
            for (const gap of [0, -1, 1, -2, 2, -3, 3, -4, 4]) for (const role of ['healer', 'buffer', 'tank']) {
                if (inspected >= 24 || added >= 12) break;
                const level = Number(materialCore.level) + gap;
                if (!this.supports.get(`${level}:${role}`)?.size) continue;
                inspected++;
                for (const state of this.supportShortlist(level, role, 1, used)) { candidates.push(state); added++; }
            }
        }
        // A seeker's LFP is heard by the askers of its band in the region (meetings): up
        // to MEETING_PAGE of them join the page from their own spots.
        const meeting = candidates.find(state => this.records.get(Number(state.characterId))?.meetingKey);
        if (meeting) {
            const used = new Set(candidates.map(state => state.characterId));
            const pool = this.meetings.get(this.records.get(Number(meeting.characterId)).meetingKey);
            // meetingCut: a page that left askers of the pool for a later one.
            if (pool?.size > MEETING_PAGE) DiagnosticConfig.developerDiagnostics && (this.metrics.meetingCut++);
            candidates.push(...this.shortlist(pool, MEETING_PAGE, used));
        }
        const generation = this.generation, revision = group?.revision;
        // The members that moved since the group's last run: only a roster with one of
        // them is judged (none recorded, a repair or freed capacity: its seekers').
        const moved = group ? (group.moved.size ? group.moved : new Set(group.seekers)) : null;
        if (group) group.moved = new Set();
        const keep = () => { for (const id of moved || []) group.moved.add(id); };
        this.running = true; DiagnosticConfig.developerDiagnostics && (this.metrics.attempts++);
        Promise.resolve().then(() => this.active && generation === this.generation
            ? this.run(candidates, timestamp, key === null, moved) : null).then(result => {
            if (!this.active || generation !== this.generation) return;
            if (result?.busy || result?.deferred) keep();
            if (result?.busy && group) this.parked.add(group);
            else if (result?.deferred || result?.continuation) {
                const retryKey = group || this.helpKey;
                this.arm(retryKey, Math.max(timestamp + this.retryMs, Number(result.retryAt || 0)), () => {
                    if (group) this.enqueue(group); else this.wakeHelp();
                });
            } else if (group?.remaining > 0) this.dirty.add(group.key);
            else if (group) group.handled = revision;
            if (group?.revision !== revision) this.enqueue(group);
        }).catch(error => {
            if (this.active && generation === this.generation) {
                this.onError(error);
                this.arm(group || this.helpKey, this.now() + this.retryMs, () => group ? this.enqueue(group) : this.wakeHelp());
            }
        }).finally(() => { this.running = false; });
    }
}

module.exports = { PartyAssemblyEvents, SAFETY_INTERVAL_MS };
