'use strict';
// The spot aggregate's outcomes that touch other bots, on their way (worker only). An
// arrival's contest (SpotContest: the units it displaces, a PvP dispute) or meeting
// (EnemyMet: revenge, clan_war) waits for the arriving step's own commit ack (keyed per
// arriving bot on its proposal). The arriving unit itself stands on the spot from its
// arrival, not from its ack: until the ack its entry counts it as standing there, and the
// units it displaces as gone (pendingOn), so two arrivals in one commit round trip meet
// each other. At the ack a displaced bot hears contest_lost at its next step (displace,
// the kernel's step wake: no commit of its own); a dispute or meeting is fenced with the
// arriving bot's committed revisions (its own, its party row's: table changes reach the
// worker before the ack) and goes in the competition frame of the next heartbeat (main's
// ColdCompetitionActions executes it, fencing both sides; its receipt frees the frame). A
// refused arriving commit drops it (the arrival did not happen: arrival_refused; the next
// step arrives anew); any other ack, the bot leaving the far simulation, the worker's stop
// or an age past the event's freshness from the arrival (SpotContest.EVENT_TTL_MS) drops
// it (stale), never re-fenced. An outcome with no step to wait for (unsent) is a caller's
// bug: expected 0. Bounds: QUEUE events waiting for a frame, FRAME_EVENTS a frame, the
// message size (ColdCompetitionFrameSizer). Every drop is counted on the situations= line
// (spot:contest:<why>; a displacement dropped counts once per displaced unit).
const Situations = require('../Situations');
const FailureLog = require('../../../FailureLog');
const { EVENT_TTL_MS } = require('./SpotContest');
const QUEUE = 64, FRAME_EVENTS = 160;
const partyIdOf = state => state?.party?.partyId || state?.partyId || null;
function freeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
    }
    return value;
}

class SpotContestOutbox {
    // stateOf(id): the bot's state in the kernel; partyOf(id): its party row; memoryRevision(id);
    // displace(id, spotId, by): a displaced bot told at the arrival's ack (the worker's step wake);
    // frameSizing({ frameId, at }): the sizer of a frame (ColdCompetitionFrameSizer) or null.
    constructor({ stateOf, partyOf, memoryRevision, displace = () => {}, frameSizing = null }) {
        Object.assign(this, { stateOf, partyOf, memoryRevision, displace, frameSizing });
        // id -> { proposalId, events, arrival: { spotId, at, unit (as SpotContest reads a standing
        // unit), displaced: [ids] } | null }.
        this.pending = new Map(); this.queue = []; this.frame = null; this.nextFrame = 0; this.stopped = false;
    }
    note(why, count = 1) { for (let i = 0; i < count; i++) Situations.note(`spot:contest:${why}`); }
    entry(id, proposalId) {
        const entry = this.pending.get(Number(id));
        if (entry?.proposalId === proposalId) return entry;
        if (entry) this.drop(id, 'stale');
        const fresh = { proposalId, events: [], arrival: null };
        this.pending.set(Number(id), fresh);
        return fresh;
    }
    // An arrival's outcome for the arriving bot id, sent after its step's commit (proposalId).
    add(id, proposalId, event) {
        if (this.stopped || !proposalId) { this.note('unsent'); return; }
        this.entry(id, proposalId).events.push(event);
    }
    // The arriving unit standing on spotId from its step (proposalId) until its ack, with the
    // standing units it displaces (displaced: solo bot ids). at: the arrival's time.
    arrive(id, proposalId, { spotId, at, unit, displaced = [] }) {
        if (this.stopped || !proposalId) { this.note('unsent', displaced.length); return; }
        this.entry(id, proposalId).arrival = { spotId: String(spotId), at, unit, displaced };
    }
    // The arrivals in flight on spotId: { units (standing there until their ack), displaced
    // (the ids they displace: no longer standing there) }.
    pendingOn(spotId) {
        const units = [], displaced = new Set(), spot = String(spotId);
        for (const { arrival } of this.pending.values()) {
            if (arrival?.spotId !== spot) continue;
            units.push(arrival.unit);
            for (const id of arrival.displaced) displaced.add(Number(id));
        }
        return { units, displaced };
    }
    drop(id, why) {
        const entry = this.pending.get(Number(id));
        if (!entry) return;
        this.pending.delete(Number(id));
        this.note(why, entry.events.length + (entry.arrival?.displaced.length || 0));
    }
    // The commit acks (ColdSimulationKernel.onCommitAck's results). Returns whether any queued.
    acked(results, now = Date.now()) {
        let queued = false;
        for (const result of results || []) {
            const id = Number(result?.characterId), entry = this.pending.get(id);
            if (!entry) continue;
            if (!result.ok) { this.drop(id, 'arrival_refused'); continue; }
            const committed = this.stateOf(id);
            if (result.proposalId !== entry.proposalId || committed?.phase !== 'cold') { this.drop(id, 'stale'); continue; }
            this.pending.delete(id);
            for (const displaced of entry.arrival?.displaced || []) this.displace(displaced, entry.arrival.spotId, id);
            const party = partyIdOf(committed) ? this.partyOf(id) : null;
            const fenced = side => Number(side.id) !== id ? side : { ...side, revision: Number(committed.simulation?.revision || 0),
                memoryRevision: this.memoryRevision(id),
                ...(party && String(party.partyId) === String(side.partyId) ? { partyRevision: party.revision } : {}) };
            for (const event of entry.events) {
                if (now - event.at > EVENT_TTL_MS) { this.note('stale'); continue; }
                if (this.queue.length >= QUEUE) { this.note('dropped'); continue; }
                this.queue.push({ ...event, actor: fenced(event.actor), peer: fenced(event.peer) });
                queued = true;
            }
        }
        return queued;
    }
    // Entries whose ack never came, past their freshness from the arrival. Each heartbeat.
    sweep(now = Date.now()) {
        for (const [id, entry] of this.pending) {
            if (entry.events.every(event => now - event.at > EVENT_TTL_MS) && !(now - entry.arrival?.at <= EVENT_TTL_MS)) this.drop(id, 'stale');
        }
    }
    // The next frame (one at a time, until main's receipt): the queued events restamped at its time
    // while fresh from their arrival (a stale one goes, counted, never restamped); one a full frame
    // cannot carry waits for the next; one that no frame can carry (refused alone) goes, counted.
    reviewBatch(at) {
        if (this.stopped || this.frame || !this.queue.length) return this.frame;
        const frameId = this.nextFrame + 1, events = [];
        let sizing = null;
        // A frame that cannot be sized waits for the next beat, the failure counted by site.
        try { sizing = this.frameSizing?.({ frameId, at }) || null; } catch (error) { FailureLog.note('spot_contest.frame_sizing', error); return null; }
        while (this.queue.length && events.length < FRAME_EVENTS) {
            const event = this.queue[0];
            if (at - event.at > EVENT_TTL_MS) { this.queue.shift(); this.note('stale'); continue; }
            let copy;
            // An event that cannot be copied is a failure, not a frame's fit: it goes, counted by site.
            try { copy = structuredClone({ ...event, at }); }
            catch (error) { this.queue.shift(); FailureLog.note('spot_contest.event_clone', error); continue; }
            if (!sizing || sizing.offer(copy)) { this.queue.shift(); events.push(freeze(copy)); continue; }
            if (events.length) break;
            this.queue.shift(); this.note('unfit');
        }
        if (!events.length) return null;
        this.nextFrame = frameId;
        return this.frame = freeze({ frameId, at, events });
    }
    // Main's receipt of the frame: accepted, observed and expired free it (an expired frame's events are
    // lost, counted); deferred keeps it for the next heartbeat.
    receipt(receipt) {
        if (!this.frame || !receipt || receipt.frameId !== this.frame.frameId || receipt.at !== this.frame.at
            || !['accepted', 'observed', 'expired', 'deferred'].includes(receipt.status)) return false;
        if (receipt.status === 'deferred') return true;
        if (receipt.status === 'expired') this.note('expired', this.frame.events.length);
        this.frame = null;
        return true;
    }
    // The heartbeat's competition field (main's handleCompetitionForecast); null with no frame.
    snapshot() {
        return this.frame ? { mode: 'addressed', at: this.frame.at, events: this.frame.events, frame: this.frame } : null;
    }
    stop() {
        this.stopped = true; this.frame = null;
        for (const id of [...this.pending.keys()]) this.drop(id, 'stale');
        this.note('stale', this.queue.length); this.queue.length = 0;
    }
}
module.exports = { SpotContestOutbox, QUEUE, FRAME_EVENTS };
