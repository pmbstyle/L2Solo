const Config = require('./PopulationConfig');
const { INTERVAL_MS, hunterSpot } = require('./ColdCompetitionMonitor');
const PartyTarget = require('./PartyHuntingTarget');
const { StableOwnerMap } = require('./StableOwnerSet');
const Diagnostics = require('../Economy/EconomyDiagnostics');
const Situations = require('../Situations');
const { EVENT_TTL_MS } = require('./SpotContest');
const contestEvent = event => String(event?.key || '').startsWith('spot_contest:');
const metaKey = Symbol('coldCompetitionCandidate');
const CONTEST_QUEUE = 64;
const partyOf = state => state?.party?.partyId || state?.partyId || null;
const unitOf = state => partyOf(state) || `solo:${state?.characterId}`;
function add(map, key, value) {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(value);
}
function drop(map, key, value) {
    const set = map.get(key);
    if (set?.delete(value) && !set.size) map.delete(key);
}
function freeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
    }
    return value;
}

// Only derived memberships/keys, current record references and scalar clocks.
// The packet/state always comes from the one canonical provider at use time.
class ColdCompetitionCandidates {
    // leaderParty(id): the party row a bot leads, or null (the worker's
    // parties table, ColdSimulationKernel.leaderParty); partyChanged follows it.
    // spotOf(state): the spot a bot stands at (SpotService.standingSpot).
    constructor({ records, packets, memory, monitor, deadlines, leaderParty = () => null, spotOf = () => null, sequence = null, fitsFrame = () => true, frameSizing = null }) {
        if ([records, packets, leaderParty, spotOf].some(read => typeof read !== 'function') || !memory || !monitor || !deadlines) {
            throw new TypeError('invalid_competition_candidates');
        }
        Object.assign(this, { records, packets, memory, monitor, deadlines, leaderParty, spotOf, sequence, fitsFrame, frameSizing });
        this.spots = new Map(); this.parties = new Map(); this.partyHunters = new Map();
        this.memberParties = new Map(); this.relationOwners = new StableOwnerMap(); this.clans = new Map(); this.units = new Map();
        this.pendingSpots = new Map(); this.pendingActors = new Map(); this.policyDeadlines = new Map();
        // The spot contest's outcomes that touch a standing unit (SpotContest, after the
        // arriving commit's ack): sent first in the next frame, stamped with its time.
        // At most CONTEST_QUEUE wait; one past it is dropped, counted (limits.md "Spot contest").
        this.contestEvents = [];
        this.nextSequence = 0; this.nextInput = 0; this.nextFrame = 0; this.activeHunters = 0;
        this.frame = null; this.stopped = false;
        monitor.onCooldown = (...args) => this.cooldown(...args);
        monitor.revenge.onCooldown = monitor.onCooldown;
    }
    queueSpot(id) {
        if (!this.stopped && id != null) {
            const spot = this.spots.get(id);
            if (spot) spot.pairOffset = 0;
            this.pendingSpots.set(id, ++this.nextInput);
        }
    }
    queueActor(id) {
        if (!this.stopped && id != null) this.pendingActors.set(id, ++this.nextInput);
    }
    queueUnit(key) {
        for (const record of this.units.get(key) || []) this.queueRecord(record);
    }
    queueRecord(record) {
        const meta = record?.[metaKey];
        if (!meta) return;
        this.queueActor(meta.id);
        if (meta.hunter) this.queueSpot(meta.spot);
    }
    notifyIncoming(id) {
        for (const owner of this.relationOwners.get(id) || []) this.queueActor(owner);
        for (const key of this.memberParties.get(id) || []) {
            for (const record of this.partyHunters.get(key) || []) this.queueRecord(record);
        }
    }
    party(key) {
        if (!this.parties.has(key)) this.parties.set(key, { contributors: new Set(), winner: null, members: [] });
        return this.parties.get(key);
    }
    refreshParty(key) {
        const metadata = this.parties.get(key);
        if (!metadata) return;
        for (const id of metadata.members) drop(this.memberParties, id, key);
        // One row per party with one leader: at most one contributor leads it.
        let winner = null, winnerParty = null;
        for (const record of metadata.contributors) {
            const party = this.leaderParty(record.id);
            if (!party || party.partyId !== key) continue;
            winner = record; winnerParty = party;
            break;
        }
        metadata.winner = winner;
        const ids = winnerParty?.memberIds;
        // Dependency syntax is independent of current member availability.
        metadata.members = Array.isArray(ids) && ids.length >= 2 && ids.length <= 9
            && new Set(ids).size === ids.length && ids.includes(winnerParty.leaderId) ? ids.map(Number) : [];
        for (const id of metadata.members) add(this.memberParties, id, key);
        for (const record of this.partyHunters.get(key) || []) this.queueRecord(record);
        if (!metadata.contributors.size && !this.partyHunters.has(key)) this.parties.delete(key);
    }
    detach(record, meta) {
        if (!meta) return;
        if (meta.hunter) {
            this.spots.get(meta.spot)?.records.delete(record);
            this.activeHunters--;
            if (meta.party) drop(this.partyHunters, meta.party, record);
            this.queueSpot(meta.spot);
        }
        if (meta.ledParty != null) this.parties.get(meta.ledParty)?.contributors.delete(record);
        drop(this.units, meta.unit, record); drop(this.clans, meta.clan, record);
        for (const target of meta.targets) drop(this.relationOwners, target, meta.id);
        if (meta.deadlineToken != null) this.deadlines.cancelDecisionDeadline(meta.deadlineKey, meta.deadlineToken);
        delete record[metaKey];
    }
    ownerChanged(id, previousRecord = null, previousPacket = null) {
        if (this.stopped) return;
        const record = this.records(id), packet = this.packets(id);
        if (!record || !packet || record.source !== packet.state) return;
        const old = previousRecord?.[metaKey] || record[metaKey];
        if (previousRecord && previousRecord !== record && !previousRecord[metaKey] && record[metaKey]) return;
        // Kernel captures old packet BEFORE publication, including a same-source
        // record replacement; old grouping tags are stored only as metadata.
        if (previousRecord && previousPacket && previousRecord.source !== previousPacket.state) return;
        const affected = new Set([old?.ledParty, old?.party]);
        const sequence = this.sequence?.(id) ?? old?.sequence ?? ++this.nextSequence;
        this.detach(previousRecord || record, old);
        const state = packet.state;
        const meta = { id, sequence, hunter: !!hunterSpot(state, this.spotOf), spot: state.spotId,
            party: partyOf(state), ledParty: this.leaderParty(id)?.partyId ?? null, unit: unitOf(state),
            clan: this.memory.clanSocial?.identity({ id, clanId: Number(state.stats?.clanId || 0) }).clanId
                ?? Number(state.stats?.clanId || 0), targets: [], deadlineKey: {}, deadlineToken: null };
        record[metaKey] = meta;
        add(this.units, meta.unit, record); add(this.clans, meta.clan, record);
        if (meta.hunter) {
            if (!this.spots.has(meta.spot)) this.spots.set(meta.spot, { records: new Set(), rollAt: null, rollWindow: null, rollElapsed: 0, pairOffset: 0 });
            this.spots.get(meta.spot).records.add(record); this.activeHunters++;
            if (meta.party) add(this.partyHunters, meta.party, record);
            this.queueSpot(meta.spot);
        }
        if (meta.ledParty != null) this.party(meta.ledParty).contributors.add(record);
        affected.add(meta.ledParty); affected.add(meta.party);
        for (const key of affected) if (key != null) this.refreshParty(key);
        this.memoryChanged(id);
        this.armEligibility(record, packet);
        this.queueActor(id); this.notifyIncoming(id);
    }
    // A party row changed (the parties watch): its leader's grouping is re-read.
    partyChanged(leaderId) {
        this.ownerChanged(Number(leaderId));
    }
    ownerRemoved(id, expectedRecord, expectedPacket) {
        const current = this.records(id);
        if (current && (current !== expectedRecord || this.packets(id) !== expectedPacket)) return false;
        const meta = expectedRecord?.[metaKey];
        if (!meta || expectedPacket?.state !== expectedRecord.source) return false;
        this.detach(expectedRecord, meta);
        for (const key of new Set([meta.ledParty, meta.party])) if (key != null) this.refreshParty(key);
        this.queueActor(id); this.notifyIncoming(id);
        return true;
    }
    memoryChanged(id) {
        const record = this.records(id), meta = record?.[metaKey];
        if (meta) {
            for (const target of meta.targets) drop(this.relationOwners, target, id);
            meta.targets = [...(this.memory.views.get(id)?.characterIds || [])];
            for (const target of meta.targets) add(this.relationOwners, target, id);
            this.queueRecord(record);
        }
        this.notifyIncoming(id);
    }
    clanChanged(id) {
        for (const record of this.clans.get(id) || []) this.queueRecord(record);
    }
    membershipsChanged(previous, current, removed = []) {
        const changed = new Set();
        for (const [id, clan] of previous) if (current.get(id) !== clan) changed.add(id);
        for (const [id, clan] of current) if (previous.get(id) !== clan) changed.add(id);
        for (const id of changed) this.ownerChanged(id);
        for (const clan of removed) this.clanChanged(clan);
    }
    armEligibility(record, packet) {
        const meta = record[metaKey], state = packet.state, party = this.leaderParty(meta.id);
        const at = this.deadlines.now();
        const times = [state.stats?.revengeUntil, state.stats?.coldCompetition?.conflictUntil,
            state.stats?.pvpEncounter?.expiresAt, party?.stats?.coldCompetition?.conflictUntil]
            .map(Number).filter(value => Number.isFinite(value) && value > at && Number.isSafeInteger(Math.ceil(value)));
        if (!times.length) return;
        const due = Math.ceil(Math.min(...times));
        meta.deadlineToken = this.deadlines.armDecisionDeadline(meta.deadlineKey, due, meta, stamp => {
            if (this.stopped || this.records(meta.id) !== record || record[metaKey] !== stamp) return;
            meta.deadlineToken = null;
            this.queueRecord(record); this.notifyIncoming(meta.id);
            for (const hunter of this.partyHunters.get(meta.ledParty) || []) this.queueRecord(hunter);
            // The next distinct authored expiry is genuine evidence, not a poll.
            this.armEligibility(record, this.packets(meta.id));
        });
    }
    cooldown(kind, key, until, units) {
        if (!this.policyDeadlines.has(kind)) this.policyDeadlines.set(kind, new Map());
        const policies = this.policyDeadlines.get(kind), previous = policies.get(key);
        if (previous) this.deadlines.cancelDecisionDeadline(previous.key, previous.token);
        const entry = { key: {}, until, units };
        policies.set(key, entry);
        entry.token = this.deadlines.armDecisionDeadline(entry.key, until, until, stamp => {
            if (this.stopped || policies.get(key) !== entry || entry.until !== stamp) return;
            policies.delete(key);
            const map = kind === 'pair' ? this.monitor.pairs : kind === 'unit' ? this.monitor.bots : this.monitor.revenge.cooldowns;
            if (map.get(key) !== stamp) return;
            map.delete(key);
            for (const unit of units) this.queueUnit(unit);
        });
    }
    currentParty(key) {
        const winner = this.parties.get(key)?.winner;
        return winner ? this.leaderParty(winner.id) : null;
    }
    targetForParty(key) {
        const party = this.currentParty(key);
        if (!party) return 0;
        let first = null;
        for (const record of this.partyHunters.get(key) || []) {
            if (!first || record[metaKey].sequence < first[metaKey].sequence) first = record;
        }
        return first ? PartyTarget.competitionNpcId(party, this.packets(Number(party.leaderId))?.state,
            this.spotOf(this.packets(first.id)?.state), id => this.packets(Number(id))?.state) : 0;
    }
    // One encounter roll per spot and 30 s window, its decision point. The
    // monitor seeds a group's rolls by the window, so every review of the spot
    // in one window (another hunter's commit, a pair continuation) must pass
    // the same chance: the time since the first review of the window before,
    // capped at one window. Over any commit pace the chances then cover the
    // elapsed time once, as with one review per window.
    windowElapsed(spot, at) {
        const window = Math.floor(at / INTERVAL_MS);
        if (spot.rollWindow === window) {
            Diagnostics.count('competition_roll', 'window', 'repeat');
            return spot.rollElapsed;
        }
        spot.rollElapsed = spot.rollAt === null ? 0 : Math.max(0, Math.min(INTERVAL_MS, at - spot.rollAt));
        spot.rollWindow = window;
        spot.rollAt = at;
        Diagnostics.count('competition_roll', 'window', 'first');
        return spot.rollElapsed;
    }
    queueEvent(event) {
        if (this.stopped) return false;
        if (this.contestEvents.length >= CONTEST_QUEUE) { Situations.note('spot:contest:dropped'); return false; }
        this.contestEvents.push(event);
        return true;
    }
    takeKeys(queue, limit) {
        const selected = [];
        for (const [key, generation] of queue) {
            if (selected.length >= limit) break;
            selected.push({ key, generation }); queue.delete(key);
        }
        return selected;
    }
    reviewBatch(at) {
        if (this.stopped || this.frame) return this.frame;
        const spots = this.takeKeys(this.pendingSpots, 32), actors = this.takeKeys(this.pendingActors, 128);
        if (!spots.length && !actors.length && !this.contestEvents.length) return null;
        const events = [], frameId = this.nextFrame + 1;
        let sizing;
        try { sizing = this.frameSizing?.({ frameId, at }); }
        catch {
            for (const { key, generation } of spots) this.pendingSpots.set(key, generation);
            for (const { key, generation } of actors) this.pendingActors.set(key, generation);
            return null;
        }
        const offer = event => {
            let copy;
            try {
                copy = structuredClone(event);
                if (events.length >= 160 || sizing && !sizing.offer(copy)) return false;
                if (!sizing) {
                    events.push(copy);
                    try { if (!this.fitsFrame({ frameId, at, events })) { events.pop(); return false; } }
                    catch (error) { events.pop(); throw error; }
                    events.pop();
                }
            } catch { return false; }
            events.push(freeze(copy)); return true;
        };
        // The contests first, each restamped at the frame's time (main takes a frame's
        // events at its time) while fresh from its arrival (its own at; a stale one goes,
        // counted, never restamped); one a full frame cannot carry waits for the next, one
        // that no frame can carry (refused alone) goes, counted, and the rest flow.
        while (this.contestEvents.length) {
            const event = this.contestEvents[0];
            if (at - event.at > EVENT_TTL_MS) { this.contestEvents.shift(); Situations.note('spot:contest:stale'); continue; }
            if (offer({ ...event, at })) { this.contestEvents.shift(); continue; }
            if (events.length) break;
            this.contestEvents.shift(); Situations.note('spot:contest:unfit');
        }
        let pairs = 0;
        for (const { key } of spots) {
            const spot = this.spots.get(key);
            if (!spot) continue;
            if (pairs >= 32) { this.pendingSpots.set(key, ++this.nextInput); continue; }
            const entries = [...spot.records].sort((a, b) => a[metaKey].sequence - b[metaKey].sequence)
                .map(record => this.packets(record.id)).filter(Boolean);
            const elapsed = this.windowElapsed(spot, at);
            const report = this.monitor.sampleSpot(entries, this.memory, at, { elapsed, maxPairs: 32 - pairs, pairOffset: spot.pairOffset,
                states: { get: id => this.packets(id)?.state }, parties: { get: key => this.currentParty(key) },
                targetForParty: key => this.targetForParty(key), acceptEvent: offer });
            pairs += report.sampledPairs;
            spot.pairOffset = report.overflow ? spot.pairOffset : report.nextPairOffset;
            if (report.overflow || spot.pairOffset) this.pendingSpots.set(key, ++this.nextInput);
        }
        const selected = actors.map(({ key }) => this.packets(key)).filter(Boolean);
        const revengeEvents = this.monitor.revenge.sampleActors(selected, id => this.packets(id), this.memory, at,
            this.monitor.personaFor, null, offer);
        this.monitor.lastAt = at;
        this.monitor.report.recent = [...this.monitor.report.recent, ...revengeEvents].slice(-12);
        if (this.monitor.revenge.report.overflow) for (const { key } of actors) this.queueActor(key);
        Object.assign(this.monitor.report, { at, activeHunters: this.activeHunters, events,
            lastScanEvents: events.length, consumedSpotKeys: spots.length, consumedActorKeys: actors.length,
            pendingSpotKeys: this.pendingSpots.size, pendingActorKeys: this.pendingActors.size,
            revenge: { ...this.monitor.revenge.report }, deliveryMode: 'addressed' });
        if (!events.length) return null;
        this.nextFrame = frameId;
        this.frame = freeze({ frameId, at, events });
        this.selected = { spots, actors };
        return this.frame;
    }
    receipt(receipt) {
        if (!this.frame || !receipt || receipt.frameId !== this.frame.frameId || receipt.at !== this.frame.at
            || !['accepted', 'observed', 'expired', 'deferred'].includes(receipt.status)) return false;
        if (receipt.status === 'deferred') return true;
        if (receipt.status === 'expired') {
            // A contest's outcome lost with its frame is not sent again (its arrival is past).
            for (const event of this.frame.events) if (contestEvent(event)) Situations.note('spot:contest:expired');
            this.releaseForecasts(this.frame.events);
            for (const { key } of this.selected.spots) this.queueSpot(key);
            for (const { key } of this.selected.actors) this.queueActor(key);
        }
        this.frame = null; this.selected = null;
        return true;
    }
    releaseForecasts(events) {
        this.monitor.release(events);
        for (const event of events) for (const participant of [event.actor, event.peer]) {
            if (participant) this.queueUnit(participant.partyId || `solo:${participant.id}`);
        }
    }
    snapshot() {
        // A retired frame must never re-enter Main's legacy array adapter.
        const report = Config.developerDiagnostics
            ? { ...this.monitor.snapshot(), events: this.frame?.events || [] }
            : { diagnosticsEnabled: false, mode: this.monitor.report.mode, at: this.monitor.report.at, events: this.frame?.events || [] };
        if (this.frame) report.frame = this.frame;
        return report;
    }
    stop() { this.stopped = true; this.frame = null; this.selected = null; this.pendingSpots.clear(); this.pendingActors.clear(); this.contestEvents.length = 0; }
}
module.exports = ColdCompetitionCandidates;
