const { isDeepStrictEqual } = require('node:util');
const DiagnosticConfig = require('./PopulationConfig');
const CharacterStateSources = require('../../World/CharacterStateSources');
const { isMainThread } = require('node:worker_threads');
const SIMPLE_ACTIVITIES = new Set(['hunting', 'resting', 'traveling', 'dead']);
const PROPOSAL_PAYLOAD_LIMIT_BYTES = 240 * 1024;
const BackgroundPartyLifecycle = require('./BackgroundPartyLifecycle');
const Protocol = require('./ColdSimulationProtocol');
const ColdStateDelta = require('./ColdStateDelta');
const { HUNTING_TRAVEL_MS, beginHuntingTrip } = require('./HuntingTravel');
const PurchaseFunding = require('../Economy/PurchaseFunding');
const BotErrands = require('./BotErrands');
const { eligible: eligibleBuyer } = require('../Economy/MarketBuyerWaiters');
const { SpotOccupancyIndex, stateKey } = require('./SpotOccupancyIndex');

class DueHeap {
    constructor() {
        this.values = [];
        this.positions = new WeakMap();
        this.decisionHeads = [];
    }

    set(index, entry) {
        this.values[index] = entry;
        this.positions.set(entry, index);
        this.refreshDecision(index);
    }

    // A derived minimum on the SAME heap nodes; normal heads never hide a
    // decision deadline when actor admission is full or paused.
    refreshDecision(index) {
        while (index >= 0) {
            let best = this.values[index]?.alarmKind === 'decision' ? this.values[index] : null;
            for (const child of [index * 2 + 1, index * 2 + 2]) {
                const candidate = child < this.values.length ? this.decisionHeads[child] : null;
                if (candidate && (!best || this.compare(candidate, best) < 0)) best = candidate;
            }
            this.decisionHeads[index] = best;
            if (!index) break;
            index = Math.floor((index - 1) / 2);
        }
    }

    peekDecision() { return this.decisionHeads[0] || null; }

    up(index) {
        const entry = this.values[index];
        while (index > 0) {
            const parent = Math.floor((index - 1) / 2);
            if (this.compare(this.values[parent], entry) <= 0) break;
            this.set(index, this.values[parent]);
            index = parent;
        }
        this.set(index, entry);
    }

    down(index) {
        const entry = this.values[index];
        while (true) {
            const left = index * 2 + 1;
            const right = left + 1;
            if (left >= this.values.length) break;
            let next = left;
            if (right < this.values.length && this.compare(this.values[right], this.values[left]) < 0) next = right;
            if (this.compare(entry, this.values[next]) <= 0) break;
            this.set(index, this.values[next]);
            index = next;
        }
        this.set(index, entry);
    }

    push(entry) {
        this.values.push(entry);
        this.up(this.values.length - 1);
    }

    pop() {
        if (!this.values.length) return null;
        const first = this.values[0];
        this.remove(first);
        return first;
    }

    remove(entry) {
        const index = this.positions.get(entry);
        if (index === undefined) return false;
        const last = this.values.pop();
        this.positions.delete(entry);
        this.refreshDecision(this.values.length);
        this.decisionHeads.length = this.values.length;
        if (index < this.values.length) {
            this.set(index, last);
            const parent = Math.floor((index - 1) / 2);
            if (index > 0 && this.compare(last, this.values[parent]) < 0) this.up(index);
            else this.down(index);
        }
        return true;
    }

    peek() {
        return this.values[0] || null;
    }

    compare(a, b) {
        return Number(a.dueAt || 0) - Number(b.dueAt || 0)
            || Number(a.characterId || 0) - Number(b.characterId || 0);
    }

    get size() {
        return this.values.length;
    }
}

function deterministicRandom(state = {}) {
    const seedText = `${state.characterId || 0}:${state.timing?.lastResolvedAt || 0}:${state.timing?.nextResolveAt || 0}`;
    let seed = 2166136261;
    for (let index = 0; index < seedText.length; index++) {
        seed ^= seedText.charCodeAt(index);
        seed = Math.imul(seed, 16777619);
    }
    return () => {
        seed |= 0;
        seed = (seed + 0x6D2B79F5) | 0;
        let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

function partySessionExpiryAt(state = {}, context = {}, partySession = {}) {
    const party = context?.party || null;
    const partyId = party?.partyId || state.party?.partyId || state.partyId || '';
    if (!partyId) return 0;

    const explicitExpiry = Number(
        party?.stats?.sessionReview?.nextAt
        || party?.stats?.sessionExpiresAt
        || state.stats?.sessionExpiresAt
        || 0
    );
    if (explicitExpiry > 0) return explicitExpiry;

    const startedAt = Number(
        party?.stats?.formedAt
        || party?.startedAt
        || state.stats?.formedAt
        || 0
    );
    return BackgroundPartyLifecycle.rotationExpiry(partyId, startedAt, partySession);
}

function partyIntegrityInvalid(context = {}, partySession = {}) {
    const party = context?.party || null;
    if (!party) return false;
    const minSize = Math.max(2, Number(partySession.partyMinSize) || 2);
    const declaredMemberIds = Array.isArray(party.memberIds) && party.memberIds.length
        ? [...new Set(party.memberIds.map(Number).filter(Boolean))]
        : [];
    if (declaredMemberIds.length < minSize) return true;
    if (!Array.isArray(context.partyMembers)) return false;
    const partyId = String(party.partyId || '');
    const attachedCount = context.partyMembers.filter((member) => (
        String(member?.party?.partyId || member?.partyId || '') === partyId
    )).length;
    return attachedCount < minSize || attachedCount !== declaredMemberIds.length;
}

function nextDueAt(state = {}, timestamp = Date.now(), context = {}, partySession = {}) {
    const stateDue = Number(state.timing?.nextResolveAt || 0);
    // The party row is the durable scheduling authority for a party resolve.
    // A freshly assigned leader can briefly carry no personal due time, and
    // later leader snapshots can also lag behind an advanced party schedule.
    const partyDue = context?.isPartyLeader
        ? Number(context.party?.nextResolveAt || 0)
        : 0;
    const due = partyDue > 0 ? partyDue : stateDue;
    if (partyIntegrityInvalid(context, partySession)) return timestamp;
    const sessionExpiry = partySessionExpiryAt(state, context, partySession);
    if (sessionExpiry > 0) return due > 0 ? Math.min(due, sessionExpiry) : sessionExpiry;
    return due > 0 ? due : Math.max(0, Number(state.updatedAt || timestamp));
}

function finishPartyRouteTravelState(state = {}, timestamp = Date.now()) {
    const travel = state.stats?.travel;
    if (state.activity !== 'traveling'
        || travel?.reason !== 'party_spot_replan'
        || Number(travel.arrivalAt || 0) > timestamp
        || !travel.to) return null;

    return {
        ...state,
        activity: travel.arrivalActivity || 'grouped',
        currentRegion: travel.regionName || state.currentRegion,
        spotId: travel.spotId || state.spotId,
        loc: { ...travel.to },
        timing: {
            ...(state.timing || {}),
            activityStartedAt: timestamp,
            nextResolveAt: timestamp + 1000
        },
        stats: { ...(state.stats || {}), travel: null }
    };
}

function partyTransitionProposals(run, memberStates, party, timestamp, event = null, activity = 'party_travel') {
    const nextResolveAt = Number(memberStates[0]?.timing?.nextResolveAt || timestamp + 1000);
    const requestedLeaderId = Number(run.party.leaderId || 0);
    const resolutionMemberId = memberStates.some((state) => Number(state.characterId) === requestedLeaderId)
        ? requestedLeaderId
        : Number(memberStates[0]?.characterId || 0);
    const atomicGroup = {
        id: `party:${party.partyId}:${timestamp}:${activity}`,
        memberIds: memberStates.map((state) => Number(state.characterId)).filter(Boolean)
    };
    return memberStates.map((state) => {
        const id = Number(state.characterId);
        const events = event && id === resolutionMemberId
            ? [{ ...event, characterId: id }]
            : [];
        return {
            proposalId: `${run.grants.get(id)?.leaseId}:${run.grants.get(id)?.revision}`,
            characterId: id,
            priority: 'P1',
            enqueuedAt: timestamp,
            token: run.grants.get(id),
            baseState: run.members.find((member) => Number(member.characterId) === id) || state,
            nextState: state,
            durable: null,
            result: {
                patch: {},
                events,
                materialize: { exp: 0, sp: 0, adena: 0, items: [] },
                nextResolveAt: Number(state.timing?.nextResolveAt || nextResolveAt),
                debug: { activity, partyId: run.party.partyId, spotId: party.spotId || null }
            },
            options: { allowParty: true, allowLifecycle: true },
            atomicGroup,
            partyResolution: id === resolutionMemberId
                ? { partyId: party.partyId, party }
                : null
        };
    });
}

// Resolved on first use, like the other lazy dependencies of the worker:
// require() inside lifecycleKind ran per inventory item on every row.
let C4Unseal, PartyMarketBreak, ClanPartyDuty;

function lifecycleKind(state = {}, context = {}) {
    if (state.phase !== 'cold' || state.activity === 'pk_hunting') return 'inactive';
    if (state.stats?.tradeMeeting) return ['traveling', 'dead', 'resting', 'fighting'].includes(state.activity) ? 'resolver' : 'event_driven';
    // A solo bot washing karma (ColdKarmaPolicy.active) is planned by the
    // resolver. The test is repeated here: ColdKarmaPolicy loads spot modules.
    if (Number(state.stats?.karma || 0) > 0 && !state.party?.partyId && !state.partyId) return 'resolver';
    if (context.isPartyLeader) return 'party';
    if (state.partyId || state.party?.partyId) return 'party_member';
    if (state.activity === 'crafting' && state.stats?.craftShop) return 'event_driven';
    const stats = state.stats || {};
    const plan = stats.equipmentPlan || {};
    if (context.clanHallServices || stats.clanHallVisit) return 'command';
    // Finite travel/rest/death transitions are completely represented by the
    // pure resolver result and the owner CAS proposal. Economy follow-up, if
    // any, is selected on the next state after the transition is durable.
    if (state.activity === 'traveling' || state.activity === 'dead'
        || (state.activity === 'resting' && Number(stats.restUntil || 0) > 0)) return 'resolver';
    if ((PartyMarketBreak ||= require('./PartyMarketBreak')).ready(state)) return 'command';
    if (stats.partyMarketReturn && ['shopping', 'merchant'].includes(state.activity)) return 'command';
    // Finish town services before waiting for a clan hunt. The pure shopping
    // resolver only advances its deadline and cannot buy, sell or leave town.
    if (['shopping', 'crafting', 'merchant'].includes(state.activity)) return 'command';
    if (String(plan.strategy || '') === 'market') {
        const price = Math.max(0, Number(plan.market?.price || 0));
        const reserve = Math.max(0, Number(plan.market?.reserve || 0));
        if (state.activity !== 'hunting'
            || (price > 0 && (plan.weaponBridge ? PurchaseFunding.budget(state, PurchaseFunding.tripEscrow(plan, context.buyOrderEscrow))
                : PurchaseFunding.spendable(state, PurchaseFunding.tripEscrow(plan, context.buyOrderEscrow),
                    { itemId: plan.target?.selfId })) >= price)) return 'command';
    }
    if ((ClanPartyDuty ||= require('./ClanPartyDuty')).waiting(state)) return 'resolver';
    if (!SIMPLE_ACTIVITIES.has(String(state.activity || ''))) return 'command';
    // craftReturn is a saved destination, not an outstanding crafting action.
    // Actual crafting is routed by activity, shop/station and plan readiness.
    if (BotErrands.busyWith(state, BotErrands.COLD_CLAIM)) return 'command';
    if (stats.mammonReturn || (Number(stats.mammonRetryAt || 0) <= Date.now()
        && Object.values(state.inventory || {}).some(item => Number(item.amount)>0
            && (C4Unseal ||= invoke('GameServer/Items/C4Unseal')).options(item.selfId).length))) return 'command';
    if (String(plan.strategy || '') === 'craft') {
        if (state.activity !== 'hunting' || ['component_ready', 'ready_to_craft'].includes(String(plan.status || ''))) return 'command';
    }
    if (state.activity === 'traveling' && stats.travel) {
        const reason = String(stats.travel.reason || '');
        const arrival = String(stats.travel.arrivalActivity || 'shopping');
        if (!SIMPLE_ACTIVITIES.has(arrival) || /(market|shop|sell|buy|craft)/i.test(reason)) return 'command';
    }
    return 'resolver';
}

function isSchedulableKind(kind) {
    return kind !== 'inactive' && kind !== 'event_driven' && kind !== 'party_member';
}

function priorityForResult(state, result) {
    const activity = String(result?.patch?.activity || state?.activity || '');
    if (activity === 'dead' || state?.activity === 'dead' || (result?.events || []).some((event) => (
        ['death', 'respawn', 'resurrection'].includes(String(event?.type || ''))
    ))) return 'P0';
    if ((result?.materialize?.items || []).some((item) => Number(item.selfId) !== 57 && Number(item.amount || 0) !== 0)) {
        return 'P1';
    }
    return 'P2';
}

// JSON of { proposals: [a, b] } is the empty payload plus each proposal's
// own JSON and one comma between neighbours, so a batch can be sized from
// its members' sizes without serialising the growing batch again.
const EMPTY_PROPOSAL_PAYLOAD_BYTES = Protocol.byteLength({ proposals: [] });

function proposalSizes(proposals = []) {
    return proposals.map((proposal) => Protocol.byteLength(proposal));
}

function proposalPayloadBytes(count, itemBytes) {
    return EMPTY_PROPOSAL_PAYLOAD_BYTES + itemBytes + Math.max(0, count - 1);
}

function groupPayloadBytes(sizes = []) {
    return proposalPayloadBytes(sizes.length, sizes.reduce((sum, size) => sum + size, 0));
}

function compactProposal(proposal = {}, includeInventory = true) {
    const baseState = proposal.baseState || null;
    const result = proposal.result || {};
    const compactBaseState = baseState
        ? {
            characterId: Number(baseState.characterId || proposal.characterId || 0),
            ...(includeInventory ? { inventory: baseState.inventory || {} } : {})
        }
        : null;
    return {
        ...proposal,
        ...(baseState ? { baseState: compactBaseState } : {}),
        result: {
            events: Array.isArray(result.events) ? result.events : [],
            ...(result.memoryEvents ? { memoryEvents: result.memoryEvents } : {}),
            debug: result.debug || {},
            ...(DiagnosticConfig.developerDiagnostics === true && result.consumptionDiagnostics
                ? { consumptionDiagnostics: result.consumptionDiagnostics } : {})
        }
    };
}

// Stable membership of the same authoritative states, not another state
// snapshot or due queue. Producer writes keep traversal O(1) under churn.
class RetainedStateMap extends Map {
    // ARCH-NOTE: ALT: Authorized M6 sharing keeps only frozen exact primitive
    // skill DTOs after native canonical publication. Per-owner mutable arrays
    // and protocol fields remain unchanged; 4096 records bound the Worker pool.
    // Delete/fence/clear synchronously retire captured acquired-slot ledgers.
    // Scoped native 400/1000 saved-wire proof saves 6.432/7.647 KiB per owner,
    // including pool/owner headers and backing; whole default 256 fit is separate.
    #skillDtos;
    #sharingFailures = 0;

    constructor(sources, shotIndex = null) {
        super();
        this.shotIndex = shotIndex;
        this.#skillDtos = require('worker_threads').isMainThread ? null
            : new (require('./SkillDtoInterner').SkillDtoInterner)();
        Object.defineProperty(this, 'locationIndex', { value: sources.index, enumerable: true });
        this.sources = sources;
    }

    get(id) { return this.sources.get(id); }
    has(id) { return this.sources.has(id); }
    get size() { return this.sources.size(); }
    keys() { return this.sources.keys(); }
    values() { return this.sources.values(); }
    entries() { return this.sources.entries(); }
    [Symbol.iterator]() { return this.entries(); }
    forEach(callback, thisArg) {
        if (typeof callback !== 'function') throw new TypeError('invalid_retained_state_callback');
        for (const [id, packet] of this.entries()) Reflect.apply(callback, thisArg, [packet, id, this]);
    }

    set(id, entry) {
        const current = this.get(id);
        if (current?.state !== entry.state && typeof invoke === 'function') {
            invoke('GameServer/Bot/Economy/EconomyContext').forgetContext(id, 'state_publication');
        }
        this.shotIndex?.update(entry.state);
        try { this.sources.publish(id, entry); }
        catch (error) {
            // Preserve native publication/error semantics, including a publisher
            // that throws after setting its input. Such an input is never interned.
            if (this.#skillDtos) {
                try { if (this.get(id)?.state !== current?.state) this.#skillDtos.remove(id); }
                catch (sharingError) {
                    this.#sharingFailures++;
                    try { global.utils?.infoWarn?.('ColdWorker', 'skill sharing release failed for %s: %s', id,
                        sharingError?.message || sharingError); } catch (_) { /* preserve native publication error */ }
                }
            }
            throw error;
        }
        if (this.#skillDtos) {
            let staged;
            try {
                const state = this.get(id)?.state;
                staged = this.#skillDtos.prepare(id, state?.phase === 'cold' ? state.stats?.coldCombat?.skills : null);
                this.#skillDtos.commit(staged);
            } catch (error) {
                this.#sharingFailures++;
                let rollbackFailure;
                try { if (staged) this.#skillDtos.rollback(staged); } catch (failure) { rollbackFailure = failure; }
                try { if (this.get(id)?.state !== current?.state) this.#skillDtos.remove(id); }
                catch (failure) { rollbackFailure ||= failure; }
                try { global.utils?.infoWarn?.('ColdWorker', 'skill sharing skipped for %s: %s; rollback: %s', id,
                    error?.message || error, rollbackFailure?.message || rollbackFailure || 'ok'); }
                catch (_) { /* sharing does not change native publication success */ }
            }
        }
        return this;
    }
    delete(id) {
        this.#skillDtos?.remove(id);
        const current = this.get(id);
        if (!current) return false;
        if (typeof invoke === 'function') invoke('GameServer/Bot/Economy/EconomyContext').forgetContext(id, 'owner_release');
        this.shotIndex?.remove(id);
        return this.sources.remove(id, current.state);
    }
    clear() {
        this.#skillDtos?.clear();
        for (const id of this.keys()) {
            if (typeof invoke === 'function') invoke('GameServer/Bot/Economy/EconomyContext').forgetContext(id, 'owner_release');
            this.shotIndex?.remove(id);
        }
        this.sources.clear();
    }

    skillDtoSize() { return { ...(this.#skillDtos?.size() || { owners: 0, unique: 0, buckets: 0, acquiredSlots: 0 }),
        sharingFailures: this.#sharingFailures }; }

}

class ColdSimulationKernel {
    constructor(options = {}) {
        if (typeof options.resolveSolo !== 'function') throw new Error('resolveSolo is required');
        this.resolveSolo = options.resolveSolo;
        this.resolveParty = typeof options.resolveParty === 'function' ? options.resolveParty : null;
        this.planPartyRequirement = options.planPartyRequirement || null;
        // Numeric member ids only, bounded by active party rosters (<=9 each); dropped at completion, release or dissolve.
        this.partyRequirementProgress = new Map();
        this.planLifecycle = typeof options.planLifecycle === 'function' ? options.planLifecycle : null;
        this.requiresWeaponBridge = typeof options.requiresWeaponBridge === 'function'
            ? options.requiresWeaponBridge
            : null;
        this.equipmentBridgeReason = typeof options.equipmentBridgeReason === 'function'
            ? options.equipmentBridgeReason : null;
        this.projectResolve = typeof options.projectResolve === 'function' ? options.projectResolve : null;
        this.now = options.now || Date.now;
        this.emit = options.emit || (() => {});
        this.maxBatch = Math.max(1, Math.min(64, Number(options.maxBatch) || 64));
        // Resolves are chained below, so maxInFlight is an ownership/lease
        // burst guard rather than a promise-concurrency setting. It must be
        // allowed to stay below maxBatch; otherwise a large batch silently
        // defeats the guard and recreates an expiring-lease backlog.
        this.maxInFlight = Math.max(1, Math.min(128, Number(options.maxInFlight) || 32));
        this.claimAckTimeoutMs = Math.max(1000, Number(options.claimAckTimeoutMs) || 5000);
        this.flushTargetMs = Math.max(100, Number(options.flushTargetMs) || 2000);
        this.flushHardMs = Math.max(this.flushTargetMs, Number(options.flushHardMs) || 5000);
        this.partySession = options.partySession || {};
        this.partyMinSize = Math.max(2, Number(options.partyMinSize) || 2);
        this.maxAtomicPartySize = Math.max(
            this.partyMinSize,
            Math.min(this.maxBatch, Number(options.maxAtomicPartySize) || 5)
        );
        // ARCH-NOTE: M6: the matched 20m native snapshot attributes 78.590
        // KiB/bot to canonical states (d05b2f66: 78.308; task estimate: 66).
        // These are the original shared state objects. Shrinking their shape
        // or the coldCombat packet requires a shared-state task, not another
        // detached copy or an unmeasured fixed-memory subtraction.
        this.states = new RetainedStateMap(CharacterStateSources.attachKernel(options.stateSources || CharacterStateSources.standalone()), options.shotIndex);
        this.occupancy = new SpotOccupancyIndex({ locationIndex: this.states.locationIndex });
        this.interactionMemory = new (require('../../Social/InteractionMemory'))();
        this.interactionMemory.playingHours = id => this.states.get(id)?.state?.stats?.playedHours;
        this.interactionMemory.clanSocial = new (require('../../Clan/ClanSocialView'))();
        this.versions = new Map();
        this.heap = new DueHeap();
        this.scheduleTokens = new Map();
        this.nextScheduleToken = 1;
        this.claiming = new Set();
        this.claimStartedAt = new Map();
        this.claimAttempts = new Map();
        this.nextClaimRequest = 1;
        this.alarms = new Map();
        this.operationalAlarms = new Map();
        this.earliestOperationalAlarm = null;
        this.decisionAlarms = new Map();
        this.decisionEvents = null;
        this.buyerEvents = null;
        this.buyerWakeups = new Set();
        // Own line observations: <=8 numeric {deals, at} rows per claimed bot.
        // Release, hot handoff/remove and shutdown discard them; never saved.
        this.lookSeen = new Map();
        this.nextAlarmToken = 1;
        this.inFlight = new Map();
        this.pendingReleases = new Map();
        this.nextReleaseRequest = 1;
        this.partyRuns = new Map();
        this.dirty = new Map();
        this.commanding = new Set();
        this.commandStartedAt = new Map();
        this.nextCommandRequest = 1;
        this.paused = false;
        this.stopping = false;
        this.resolveChain = Promise.resolve();
        this.stats = {
            snapshots: 0,
            selected: 0,
            claimed: 0,
            resolved: 0,
            proposals: 0,
            commands: 0,
            errors: 0,
            stale: 0,
            claimRecoveries: 0,
            leaseRecoveries: 0,
            leaseRenewals: 0,
            leaseRenewalMisses: 0,
            proposalCompactions: 0,
            proposalOversize: 0,
            proposalOversizeRejected: 0,
            partyCapacityBursts: 0,
            partyCapacityDeferrals: 0,
            flushes: 0,
            flushRows: 0,
            lastFlushRows: 0,
            maxFlushRows: 0,
            flushReasons: {},
            orphanRecoveries: 0,
            loopRuns: 0,
            lastLoopAt: 0,
            lastResolveMs: 0,
            maxResolveMs: 0
        };
    }

    upsert(entry = {}) {
        let state = entry.state || entry;
        const characterId = Number(state?.characterId || 0);
        if (!characterId) return false;
        const previousRecord = this.states.locationIndex.getSource(characterId, 'state');
        const current = this.states.get(characterId);
        // Only an active bilateral preparation needs stable object identity.
        // Repeated structured-clone snapshots of identical physical state are
        // not new consent. Changed bags/timing/ownership still invalidate it.
        if (this.commandStartedAt.get(characterId)?.kind === 'meeting'
            && current && isDeepStrictEqual(current.state, state)) state = current.state;
        if (entry.context?.requirementRefresh === false) {
            this.partyRequirementProgress.delete(String(entry.context?.party?.partyId || current?.context?.party?.partyId || ''));
        }
        let memoryChanged = false;
        if (entry.context?.interactionMemory) {
            if (entry.context.interactionMemory.ownerId !== characterId) throw new Error('interaction memory: wrong snapshot owner');
            memoryChanged = this.interactionMemory.accept(entry.context.interactionMemory);
            const { interactionMemory, ...context } = entry.context;
            entry = { ...entry, context };
        }
        const incomingRevision = Math.max(0, Number(state.simulation?.revision || 0));
        const currentRevision = Math.max(0, Number(current?.state?.simulation?.revision || 0));
        if (current && incomingRevision < currentRevision) {
            // Periodic catalog pages are prepared on main while the worker can
            // still resolve and receive newer commit ACKs. Preserve monotonic
            // ownership state when an older page arrives out of order, while
            // still accepting refreshed routing/party context.
            if (entry.context) this.states.set(characterId, { ...current, context: entry.context });
            this.decisionEvents?.ownerChanged(characterId, previousRecord, current);
            if (memoryChanged) this.decisionEvents?.memoryChanged(characterId);
            this.refreshCommandSource(characterId);
            this.buyerStateChanged(characterId);
            this.ensureScheduled(characterId);
            return false;
        }
        if (current && incomingRevision === currentRevision
            && nextDueAt(current.state, this.now(), current.context, this.partySession)
                === nextDueAt(state, this.now(), entry.context || {}, this.partySession)
            && lifecycleKind(current.state, current.context) === lifecycleKind(state, entry.context || {})) {
            // A full catalog refresh normally changes only context. Keep the
            // existing heap version so ten-second refreshes do not accumulate
            // one invalid future node per bot until its next due time.
            this.states.set(characterId, {
                ...current,
                state,
                context: entry.context || {}
            });
            this.occupancy.update(state);
            this.decisionEvents?.ownerChanged(characterId, previousRecord, current);
            if (memoryChanged) this.decisionEvents?.memoryChanged(characterId);
            DiagnosticConfig.developerDiagnostics && (this.stats.snapshots += 1);
            this.refreshCommandSource(characterId);
            this.buyerStateChanged(characterId);
            this.ensureScheduled(characterId);
            return true;
        }
        const version = Number(this.versions.get(characterId) || 0) + 1;
        this.versions.set(characterId, version);
        this.states.set(characterId, { state, context: entry.context || {}, version });
        this.occupancy.update(state);
        this.decisionEvents?.ownerChanged(characterId, previousRecord, current);
        if (memoryChanged) this.decisionEvents?.memoryChanged(characterId);
        DiagnosticConfig.developerDiagnostics && (this.stats.snapshots += 1);
        this.refreshCommandSource(characterId);
        this.buyerStateChanged(characterId);
        this.ensureScheduled(characterId);
        return true;
    }

    upsertMany(entries = []) {
        entries.forEach((entry) => this.upsert(entry));
        return entries.length;
    }

    remove(characterId) {
        const id = Number(characterId);
        this.pendingReleases.delete(id);
        // Standalone kernels cannot have game economy entries before Global loads.
        if (typeof invoke === 'function') invoke('GameServer/Bot/Economy/EconomyContext').forget(id);
        if (!isMainThread && typeof invoke === 'function') invoke('GameServer/Bot/AI/BotPersona').forget(id);
        const current = this.states.get(id);
        const partyId = String(this.inFlight.get(id)?.partyId || this.claimAttempts.get(id)?.partyId
            || current?.context?.party?.partyId || current?.state?.party?.partyId || '');
        if (partyId && typeof invoke === 'function') invoke('GameServer/Bot/Economy/EconomyContext').forgetGroup(partyId);
        this.partyRequirementProgress.delete(partyId);
        const run = this.partyRuns.get(partyId);
        if (run?.purpose.memberIds.includes(id)) {
            // Retire the captured party before any pending resolver continues.
            // Its remaining native leases use the existing release/ACK path.
            this.partyRuns.delete(partyId);
            for (const memberId of run.purpose.memberIds) this.cancelClaimAttempt(memberId);
            this.requestRelease([...run.grants.values()].filter(token => token.characterId !== id)
                .map(token => ({ token, reason: 'party_member_removed' })));
        }
        this.inFlight.delete(id);
        this.dirty.delete(id);
        const previousRecord = this.states.locationIndex.getSource(id, 'state');
        if (current?.state) this.occupancy.remove(stateKey(current.state));
        this.states.delete(id);
        this.buyerEvents?.remove(id);
        this.buyerWakeups.delete(id);
        this.lookSeen.delete(id);
        this.decisionEvents?.ownerRemoved(id, previousRecord, current);
        this.interactionMemory.forget(id);
        this.versions.set(id, Number(this.versions.get(id) || 0) + 1);
        this.heap.remove(this.scheduleTokens.get(id)?.heapEntry);
        this.scheduleTokens.delete(id);
        this.cancelClaimAttempt(id);
        this.claiming.delete(id);
        this.claimStartedAt.delete(id);
        this.commanding.delete(id);
        this.commandStartedAt.delete(id);
    }

    schedule(characterId, version, dueAt) {
        const id = Number(characterId);
        // Replacing a token also removes its actual indexed node; otherwise a
        // long future deadline keeps every superseded token until it is due.
        this.heap.remove(this.scheduleTokens.get(id)?.heapEntry);
        const token = this.nextScheduleToken++;
        const heapEntry = { characterId: id, version: Number(version),
            dueAt: Number(dueAt || this.now()), scheduleToken: token };
        this.scheduleTokens.set(id, { token, version: Number(version), dueAt: heapEntry.dueAt, heapEntry });
        this.heap.push(heapEntry);
    }

    storeSizes() {
        const skillDtos = this.states.skillDtoSize();
        return {
            skillDtoOwners: skillDtos.owners, skillDtoRows: skillDtos.unique,
            skillDtoAcquisitions: skillDtos.acquiredSlots, skillDtoSharingFailures: skillDtos.sharingFailures,
            states: this.states.size, contexts: this.states.size,
            locationStates: this.states.locationIndex.sourceSize('state'),
            occupancy: this.occupancy.size().owners,
            scheduleTokens: this.scheduleTokens.size, ownerHeapNodes: this.heap.size - this.alarms.size,
            claiming: this.claiming.size, claimStartedAt: this.claimStartedAt.size, claimAttempts: this.claimAttempts.size,
            inFlight: this.inFlight.size, dirty: this.dirty.size, pendingReleases: this.pendingReleases.size,
            commanding: this.commanding.size, commandStartedAt: this.commandStartedAt.size,
            partyRuns: this.partyRuns.size, partyRequirementProgress: this.partyRequirementProgress.size,
            buyerWakeups: this.buyerWakeups.size, lookSeen: this.lookSeen.size
        };
    }

    armAlarm(kind, key, dueAt, options = {}) {
        if (kind !== 'claim_ack' || options.operational !== true) throw new Error('unsupported_alarm');
        if (!Number.isSafeInteger(dueAt) || dueAt < 0) throw new RangeError('invalid_alarm_deadline');
        const id = Number(options.characterId);
        if (typeof options.stamp !== 'string' || !options.stamp || Number(key) !== id
            || (kind === 'claim_ack' && (!Number.isSafeInteger(id) || id <= 0 || !this.claiming.has(id)))) {
            throw new Error('invalid_alarm_owner');
        }
        const alarmKey = `${kind}:${id}`;
        const previous = this.alarms.get(alarmKey);
        if (previous?.stamp === options.stamp && previous.dueAt === dueAt) return previous.alarmToken;
        if (previous) this.cancelAlarm(kind, key, previous.alarmToken);
        const entry = { kind: 'alarm', alarmKind: kind, alarmKey, key, dueAt, stamp: options.stamp,
            characterId: id, alarmToken: this.nextAlarmToken++ };
        this.alarms.set(alarmKey, entry);
        this.operationalAlarms.set(alarmKey, entry);
        this.heap.push(entry);
        if (!this.earliestOperationalAlarm || this.heap.compare(entry, this.earliestOperationalAlarm) < 0) {
            this.earliestOperationalAlarm = entry;
        }
        return entry.alarmToken;
    }

    armDecisionDeadline(key, dueAt, stamp, callback) {
        if (key == null || !Number.isSafeInteger(dueAt) || dueAt < 0 || typeof callback !== 'function') {
            throw new RangeError('invalid_decision_deadline');
        }
        const previous = this.decisionAlarms.get(key);
        if (previous?.stamp === stamp && previous.dueAt === dueAt) return previous.alarmToken;
        if (previous) this.cancelDecisionDeadline(key, previous.alarmToken);
        const entry = { kind: 'alarm', alarmKind: 'decision', alarmKey: {}, key, dueAt,
            stamp, callback, characterId: 0, alarmToken: this.nextAlarmToken++ };
        this.decisionAlarms.set(key, entry);
        this.alarms.set(entry.alarmKey, entry);
        this.heap.push(entry);
        return entry.alarmToken;
    }

    cancelDecisionDeadline(key, expectedToken) {
        const entry = this.decisionAlarms.get(key);
        if (!entry || entry.alarmToken !== expectedToken) return false;
        this.heap.remove(entry);
        this.decisionAlarms.delete(key);
        this.alarms.delete(entry.alarmKey);
        return true;
    }

    drainDecisionDeadlines(timestamp, budget) {
        let fired = 0;
        while (budget.remaining > 0) {
            const entry = this.heap.peekDecision();
            if (!entry || entry.dueAt > timestamp) break;
            budget.remaining--;
            this.cancelDecisionDeadline(entry.key, entry.alarmToken);
            entry.callback(entry.stamp);
            fired++;
        }
        return fired;
    }

    cancelAlarm(kind, key, expectedToken) {
        const alarmKey = `${kind}:${Number(key)}`;
        const entry = this.alarms.get(alarmKey);
        if (!entry || entry.alarmToken !== expectedToken) return false;
        this.heap.remove(entry);
        this.alarms.delete(alarmKey);
        this.operationalAlarms.delete(alarmKey);
        if (this.earliestOperationalAlarm === entry) {
            this.earliestOperationalAlarm = null;
            // Outstanding claims plus one worker safety cycle, bounded by
            // normal/atomic ownership admission + 1; never all bot alarms.
            for (const candidate of this.operationalAlarms.values()) {
                if (!this.earliestOperationalAlarm || this.heap.compare(candidate, this.earliestOperationalAlarm) < 0) {
                    this.earliestOperationalAlarm = candidate;
                }
            }
        }
        return true;
    }

    cancelClaimAttempt(characterId) {
        const id = Number(characterId);
        const attempt = this.claimAttempts.get(id);
        if (attempt) this.cancelAlarm('claim_ack', id, attempt.alarmToken);
        this.claimAttempts.delete(id);
        this.claiming.delete(id);
        this.claimStartedAt.delete(id);
    }

    drainOperationalAlarms(timestamp = this.now()) {
        let fired = 0;
        while (this.earliestOperationalAlarm && this.earliestOperationalAlarm.dueAt <= timestamp) {
            const entry = this.earliestOperationalAlarm;
            this.cancelAlarm(entry.alarmKind, entry.key, entry.alarmToken);
            const id = entry.characterId;
            if (this.claimAttempts.get(id)?.requestId !== entry.stamp || !this.claiming.has(id)) continue;
            const run = [...this.partyRuns.values()].find(party => party.purpose.memberIds.includes(id));
            if (run) {
                run.purpose.memberIds.forEach(memberId => this.cancelClaimAttempt(memberId));
                this.partyRuns.delete(String(run.purpose.partyId));
                this.requeue(run.purpose.leaderId, timestamp + 1000);
                DiagnosticConfig.developerDiagnostics && (this.stats.claimRecoveries += run.purpose.memberIds.length);
            } else {
                this.cancelClaimAttempt(id);
                this.requeue(id, timestamp + 1000);
                DiagnosticConfig.developerDiagnostics && (this.stats.claimRecoveries += 1);
            }
            fired++;
        }
        return fired;
    }

    busy(characterId) {
        const id = Number(characterId);
        return this.claiming.has(id) || this.inFlight.has(id) || this.commanding.has(id);
    }

    hasNormalCoverage(characterId) {
        const id = Number(characterId), current = this.states.get(id), scheduled = this.scheduleTokens.get(id);
        return !!current && scheduled?.version === current.version
            && scheduled.heapEntry?.scheduleToken === scheduled.token
            && scheduled.heapEntry?.version === current.version
            && this.heap.positions.has(scheduled.heapEntry);
    }

    // Matching partial party ACKs already own native leases before the whole
    // party enters inFlight. Inspect this bounded alias set only after the
    // healthy token/busy fast paths, never classify it as lost work.
    hasAcceptedPartyGrant(characterId) {
        for (const run of this.partyRuns.values()) if (run.grants?.has(Number(characterId))) return true;
        return false;
    }

    needsNormalSchedule(characterId) {
        const entry = this.states.get(Number(characterId));
        return !!entry && isSchedulableKind(lifecycleKind(entry.state, entry.context));
    }

    buyerStateChanged(characterId) {
        this.buyerEvents?.ownerChanged(characterId, this.now());
        if (!eligibleBuyer(this.states.get(characterId)?.state)) this.buyerWakeups.delete(characterId);
    }

    wakeBuyer(characterId, timestamp = this.now()) {
        const id = Number(characterId);
        if (this.stopping || !eligibleBuyer(this.states.get(id)?.state) || this.buyerWakeups.has(id)) return false;
        this.buyerWakeups.add(id);
        if (!this.busy(id)) this.requeue(id, timestamp);
        return true;
    }

    ensureScheduled(characterId, dueAt = null) {
        const id = Number(characterId);
        const current = this.states.get(id);
        if (!current || this.busy(id)) return false;
        if (this.buyerWakeups.has(id) && eligibleBuyer(current.state)) {
            if (!this.hasNormalCoverage(id) || this.scheduleTokens.get(id).dueAt > this.now()) this.requeue(id, this.now());
            return true;
        }
        if (this.hasNormalCoverage(id)) return false;
        if (this.hasAcceptedPartyGrant(id) || !isSchedulableKind(lifecycleKind(current.state, current.context))) return false;
        this.schedule(id, current.version, dueAt ?? nextDueAt(current.state, this.now(), current.context, this.partySession));
        return true;
    }

    validHeapEntry(entry) {
        const current = this.states.get(Number(entry?.characterId));
        const scheduled = this.scheduleTokens.get(Number(entry?.characterId));
        return !!current && current.version === entry.version && scheduled?.token === entry.scheduleToken;
    }

    consumeHeapEntry(entry) {
        const id = Number(entry?.characterId);
        if (this.scheduleTokens.get(id)?.token === entry?.scheduleToken) this.scheduleTokens.delete(id);
    }

    dueCandidates(timestamp = this.now(), capacity = this.maxBatch, decisionBudget = { remaining: 64 }) {
        this.partyCapacityBlocked = false;
        const limit = Math.max(0, Math.min(this.maxBatch, Number(capacity) || 0));
        const candidates = [];
        let commandsSelected = 0;
        while (candidates.length + commandsSelected < limit && this.heap.size > 0) {
            const head = this.heap.peek();
            if (head.kind === 'alarm') {
                if (head.dueAt > timestamp) break;
                if (head.alarmKind === 'decision') {
                    if (decisionBudget.remaining <= 0) break;
                    this.drainDecisionDeadlines(timestamp, decisionBudget);
                    continue;
                }
                this.drainOperationalAlarms(timestamp);
                continue;
            }
            if (!this.validHeapEntry(head)) {
                this.heap.pop();
                continue;
            }
            if (Number(head.dueAt || 0) > timestamp) break;
            const entry = this.heap.pop();
            this.consumeHeapEntry(entry);
            const id = Number(entry.characterId);
            // A catalog page may race an ACK and carry a newer revision while
            // the previous revision is still busy. Never create a second
            // writer or depend on the invariant sweep to replace this token;
            // every claim/commit/command completion schedules explicitly.
            if (this.busy(id)) continue;
            const current = this.states.get(id);
            const encounter = current.state.stats?.pvpEncounter;
            if (encounter) {
                this.requeue(id, Math.max(timestamp + 1000, encounter.expiresAt + 1000));
                continue;
            }
            const kind = this.buyerWakeups.has(id) && eligibleBuyer(current.state)
                ? 'command' : lifecycleKind(current.state, current.context);
            if (kind === 'resolver') {
                this.claiming.add(id);
                this.claimStartedAt.set(id, this.now());
                candidates.push({
                    characterId: id,
                    expectedRevision: Math.max(0, Number(current.state.simulation?.revision || 0)),
                    purpose: { kind: 'resolver' },
                    state: current.state,
                    context: current.context
                });
            } else if (kind === 'party') {
                const party = current.context.party;
                const contextMembers = current.context.partyMembers || [];
                const declaredMemberIds = Array.isArray(party?.memberIds) && party.memberIds.length
                    ? party.memberIds
                    : [id];
                const memberIds = [...new Set(declaredMemberIds.map(Number).filter(Boolean))];
                const missingMemberState = memberIds.some((memberId) => {
                    if (this.states.get(memberId)?.state) return false;
                    const fallback = contextMembers.find((member) => Number(member.characterId) === memberId);
                    return !fallback || fallback.compact === true;
                });
                if (missingMemberState) {
                    this.requeue(id, this.now() + 1000);
                    continue;
                }
                // The leader context is a catalog snapshot and can lag behind
                // commit ACKs for individual members. Revision fencing must use
                // the kernel's authoritative per-bot state map or every party
                // refresh will issue a storm of correctly rejected stale CASes.
                const members = memberIds.map((memberId) => (
                    this.states.get(memberId)?.state
                    || contextMembers.find((member) => Number(member.characterId) === memberId)
                    || null
                )).filter(Boolean);
                const attachedMembers = members.filter((member) => (
                    String(member.party?.partyId || member.partyId || '') === String(party?.partyId || '')
                ));
                if (members.some(member => member.stats?.pvpEncounter)) {
                    this.requeue(id, timestamp + 1000);
                    continue;
                }
                const reserved = require('./PartyMarketBreak').pending(party, timestamp).length > 0;
                const minimum = reserved ? 1 : this.partyMinSize;
                const invalidPartySize = memberIds.length < minimum;
                const membershipMismatch = attachedMembers.length !== memberIds.length;
                const invalidReason = invalidPartySize
                    ? 'party_min_size'
                    : attachedMembers.length < minimum || membershipMismatch
                        ? 'party_membership_mismatch'
                        : null;
                const partyMembers = invalidReason
                    ? (attachedMembers.length
                        ? attachedMembers
                        : members.filter((member) => Number(member.characterId) === id))
                    : members;
                const candidateMemberIds = partyMembers.map((member) => Number(member.characterId)).filter(Boolean);
                const occupiedOwnership = this.claiming.size + this.inFlight.size + this.commanding.size;
                const atomicCapacityBurst = candidateMemberIds.length > this.maxInFlight
                    && candidateMemberIds.length <= this.maxAtomicPartySize
                    && occupiedOwnership === 0;
                if (candidateMemberIds.length > this.maxInFlight && !atomicCapacityBurst) {
                    this.partyCapacityBlocked = true;
                    DiagnosticConfig.developerDiagnostics && (this.stats.partyCapacityDeferrals += 1);
                    if (candidateMemberIds.length <= this.maxAtomicPartySize) {
                        // Let current owners drain so the oldest valid party
                        // gets its bounded atomic turn even under player limits.
                        this.schedule(id, current.version, entry.dueAt);
                        break;
                    }
                    this.schedule(id, current.version, this.now() + 250);
                    continue;
                }
                if (!party || !partyMembers.length
                    || candidateMemberIds.some((memberId) => this.claiming.has(memberId) || this.inFlight.has(memberId))) {
                    this.requeue(id, this.now() + 1000);
                    continue;
                }
                if (candidates.length + commandsSelected + candidateMemberIds.length > limit && !atomicCapacityBurst) {
                    this.partyCapacityBlocked = true;
                    // Keep the original overdue priority. Moving a party to
                    // now+100 on every partially free tick lets an endless
                    // stream of overdue solo work starve the atomic claim.
                    this.schedule(id, current.version, entry.dueAt);
                    break;
                }
                if (atomicCapacityBurst) DiagnosticConfig.developerDiagnostics && (this.stats.partyCapacityBursts += 1);
                const purpose = {
                    kind: 'party',
                    partyId: party.partyId,
                    leaderId: id,
                    memberIds: candidateMemberIds,
                    invalidReason
                };
                this.partyRuns.set(String(party.partyId), {
                    purpose,
                    requirementRefresh: current.context.requirementRefresh === true,
                    party,
                    members: partyMembers,
                    spot: current.context.spot,
                    route: current.context.route || null,
                    pressure: current.context.pressure || {},
                    targetNpcId: Number(current.context.targetNpcId || 0),
                    grants: new Map(),
                    rejected: false,
                    invalidReason: purpose.invalidReason
                });
                candidateMemberIds.forEach((memberId) => {
                    const member = partyMembers.find((entry) => Number(entry.characterId) === memberId);
                    this.claiming.add(memberId);
                    this.claimStartedAt.set(memberId, this.now());
                    candidates.push({
                        characterId: memberId,
                        expectedRevision: Math.max(0, Number(member?.simulation?.revision || 0)),
                        purpose
                    });
                });
            } else if (kind === 'command') {
                const attempt = this.beginCommand(id);
                if (!attempt) continue;
                commandsSelected += 1;
                DiagnosticConfig.developerDiagnostics && (this.stats.commands += 1);
                this.resolveChain = this.resolveChain.then(() => this.resolveCommand(id, attempt));
            }
        }
        return candidates;
    }

    receiveMeetingPage(request) {
        const identity = Protocol.meetingIdentity(request), id = identity?.characterId;
        if (!identity || !request.frame || this.stopping) return false;
        let attempt = this.commandStartedAt.get(id);
        if (attempt && (attempt.kind !== 'meeting' || attempt.commandId !== identity.commandId)) return false;
        if (!attempt) {
            const current = this.states.get(id);
            if (!current || this.busy(id) || this.commanding.size >= 16
                || this.claiming.size + this.inFlight.size + this.commanding.size >= this.maxInFlight) return false;
            attempt = { kind: 'meeting', commandId: identity.commandId, state: current.state,
                version: current.version, frames: [], frameHashes: [], sent: false, startedAt: this.now() };
            this.commandStartedAt.set(id, attempt); this.commanding.add(id);
        }
        try {
            const fingerprint = JSON.stringify(request.frame);
            const oldHash = attempt.frameHashes[request.frame[2]];
            const hash = require('../Fnv1a').fnv1a32(fingerprint);
            if (oldHash !== undefined && oldHash !== hash) throw Error('trade_meeting_consent_changed');
            attempt.frameHashes[request.frame[2]] = hash;
            const old = attempt.frames[request.frame[2]];
            if (old && JSON.stringify(old) !== JSON.stringify(request.frame)) throw Error('trade_meeting_consent_changed');
            if (attempt.sent) {
                // A duplicate original packet resends the held result pages.
                for (const frame of attempt.output || []) this.emit('command_request', { requests: [
                    { ...identity, frame }] }, `meeting-result:${id}:${identity.commandId}:${frame[2]}`);
                return true;
            }
            attempt.frames[request.frame[2]] = request.frame;
            if (attempt.preparing || attempt.frames.filter(Boolean).length !== request.frame[3]) return true;
            const input = require('../../AfkTrade/TradeMeetingCodec').fromPages(attempt.frames);
            attempt.frames = []; attempt.preparing = true;
            Promise.resolve(this.prepareMeeting?.(id, input, attempt)).then(result => {
                if (this.commandStartedAt.get(id) !== attempt) return;
                if (!result || this.states.get(id)?.state !== attempt.state) throw Error('trade_meeting_stale_worker');
                const frames = this.meetingResultPages(result, id, identity.commandId);
                attempt.output = frames; attempt.acked = new Set(); attempt.sent = true;
                for (const frame of frames) if (this.emit('command_request', { requests: [{ ...identity, frame }] },
                    `meeting-result:${id}:${identity.commandId}:${frame[2]}`) === false)
                    throw Error('trade_meeting_send_failed');
            }).catch(error => {
                if (!this.cancelCommand(id, attempt)) return;
                this.emit('command_ack', { results: [{ ...identity, pageIndex: -1, ok: false,
                    reason: String(error.message || error) }] });
            });
            return true;
        } catch (error) {
            this.cancelCommand(id, attempt);
            this.emit('command_ack', { results: [{ ...identity, pageIndex: -1, ok: false, reason: error.message }] });
            return true;
        }
    }

    completeMeetingPage(payload) {
        const identity = Protocol.meetingIdentity(payload);
        if (!identity) return false;
        const attempt = this.commandStartedAt.get(identity.characterId);
        if (attempt?.kind !== 'meeting' || attempt.commandId !== identity.commandId) return false;
        if (payload.ok === false) return this.cancelCommand(identity.characterId, attempt);
        if (!attempt.sent || !attempt.output?.some(frame => frame[2] === payload.pageIndex)) return false;
        attempt.acked.add(payload.pageIndex);
        // Prefix acknowledgements never release the sole preparation owner.
        if (attempt.acked.size === attempt.output.length) this.cancelCommand(identity.characterId, attempt);
        return true;
    }

    beginCommand(characterId, kind = 'lifecycle') {
        const id = Number(characterId), current = this.states.get(id);
        if (!Number.isSafeInteger(id) || id <= 0 || kind !== 'lifecycle'
            || this.stopping || !current || current.state.phase !== 'cold' || this.busy(id)
            || this.claiming.size + this.inFlight.size + this.commanding.size >= this.maxInFlight) return null;
        const checkpoint = Protocol.commandCheckpoint(current.state);
        if (!checkpoint) return null;
        const attempt = { startedAt: this.now(), commandId: `${kind}:${id}:${this.nextCommandRequest++}`,
            kind, checkpoint, context: current.context, version: current.version, sent: false };
        if (kind === 'lifecycle' && this.buyerWakeups.delete(id)) attempt.marketWakeup = true;
        this.commandStartedAt.set(id, attempt);
        this.commanding.add(id);
        return attempt;
    }

    cancelCommand(characterId, attempt) {
        const id = Number(characterId);
        if (!attempt || this.commandStartedAt.get(id) !== attempt) return false;
        this.commandStartedAt.delete(id);
        this.commanding.delete(id);
        return true;
    }

    refreshCommandSource(characterId) {
        const id = Number(characterId), attempt = this.commandStartedAt.get(id), current = this.states.get(id);
        if (!attempt || typeof attempt !== 'object') return;
        if (attempt.kind === 'meeting') {
            if (current?.state !== attempt.state) {
                this.cancelCommand(id, attempt);
                this.emit('command_ack', { results: [{ kind: 'meeting', characterId: id, commandId: attempt.commandId,
                    pageIndex: -1, ok: false, reason: 'trade_meeting_owner_changed' }] });
            }
            return;
        }
        if (current?.state.phase !== 'cold' || !Protocol.commandCheckpoint(current.state)) this.cancelCommand(id, attempt);
        else if (Protocol.sameCommandCheckpoint(current.state, attempt.checkpoint)) attempt.version = current.version;
        else if (!attempt.sent) this.cancelCommand(id, attempt);
    }

    currentCommand(characterId, attempt) {
        const id = Number(characterId), current = this.states.get(id);
        return !this.stopping && !!attempt && this.commandStartedAt.get(id) === attempt
            && this.commanding.has(id) && current?.state.phase === 'cold' && current.version === attempt.version
            && Protocol.sameCommandCheckpoint(current.state, attempt.checkpoint);
    }

    async resolveCommand(characterId, attempt) {
        const id = Number(characterId);
        const current = this.states.get(id);
        if (!this.currentCommand(id, attempt)) return;
        const timestamp = this.now();
        try {
            const elapsedMs = current.state.timing?.lastResolvedAt
                ? Math.max(1000, timestamp - Number(current.state.timing.lastResolvedAt))
                : 60000;
            const lifecyclePlan = !current.context.clanHallServices && !current.state.stats?.clanHallVisit && this.planLifecycle
                ? await this.planLifecycle({
                    state: current.state,
                    context: current.context,
                    timestamp
                })
                : null;
            if (!this.currentCommand(id, attempt)) return;
            const resolveState = lifecyclePlan?.plannedState || current.state;
            const result = current.context.clanHallServices || current.state.stats?.clanHallVisit
                ? { patch: {}, events: [], materialize: { exp: 0, sp: 0, adena: 0, items: [] }, nextResolveAt: timestamp + 30000 }
                : await this.resolveSolo({
                assessRelationship: this.interactionMemory.assess.bind(this.interactionMemory),
                state: resolveState,
                spot: current.context.spot || null,
                pressure: current.context.pressure || {},
                targetNpcId: Number(current.context.targetNpcId || lifecyclePlan?.targetNpcId ||
                    (lifecyclePlan?.activityPick?.activity === 'hunting' ? lifecyclePlan.activityPick.npcId : 0) || 0),
                elapsedMs,
                rng: deterministicRandom(current.state),
                timestamp
            });
            if (!this.currentCommand(id, attempt)) return;
            DiagnosticConfig.developerDiagnostics && (this.stats.resolved += 1);
            attempt.sent = true;
            const sent = this.emit('command_request', {
                requests: [{
                    characterId: id,
                    kind: 'lifecycle',
                    commandId: attempt.commandId,
                    commandCheckpoint: attempt.checkpoint,
                    state: current.state,
                    context: current.context,
                    precomputedPlan: lifecyclePlan,
                    precomputedResult: result,
                    computedAt: timestamp,
                    ...(attempt.marketWakeup ? { marketWakeup: true } : {})
                }]
            });
            if (sent === false && this.cancelCommand(id, attempt)) {
                if (attempt.marketWakeup) this.buyerWakeups.add(id);
                this.requeue(id, this.now() + 5000);
            }
        } catch (error) {
            if (!this.currentCommand(id, attempt)) return;
            DiagnosticConfig.developerDiagnostics && (this.stats.errors += 1);
            this.cancelCommand(id, attempt);
            if (attempt.marketWakeup) this.buyerWakeups.add(id);
            this.requeue(id, this.now() + 5000);
        }
    }

    recoverStalled(timestamp = this.now()) {
        this.drainOperationalAlarms(timestamp);

        const expiredLeases = [...this.inFlight.entries()].filter(([, active]) => (
            Number(active?.grant?.leaseUntil || 0) > 0
            && Number(active.grant.leaseUntil) <= timestamp
        ));
        const expiredParties = new Set(expiredLeases.map(([, active]) => active.partyId).filter(Boolean).map(String));
        for (const partyId of expiredParties) {
            const members = [...this.inFlight.entries()].filter(([, active]) => String(active.partyId || '') === partyId);
            members.forEach(([id]) => {
                this.inFlight.delete(Number(id));
                this.dirty.delete(Number(id));
            });
            const leader = [...this.states.entries()].find(([, entry]) => (
                entry.context?.isPartyLeader && String(entry.context?.party?.partyId || '') === partyId
            ));
            if (leader) this.requeue(leader[0], timestamp + 1000);
            DiagnosticConfig.developerDiagnostics && (this.stats.leaseRecoveries += members.length);
        }
        expiredLeases.filter(([, active]) => !active.partyId).forEach(([id]) => {
            this.inFlight.delete(Number(id));
            this.dirty.delete(Number(id));
            this.requeue(Number(id), timestamp + 1000);
            DiagnosticConfig.developerDiagnostics && (this.stats.leaseRecoveries += 1);
        });
    }

    tick() {
        DiagnosticConfig.developerDiagnostics && (this.stats.loopRuns += 1);
        this.stats.lastLoopAt = this.now();
        const decisionBudget = { remaining: 64 };
        this.drainDecisionDeadlines(this.stats.lastLoopAt, decisionBudget);
        this.recoverStalled(this.stats.lastLoopAt);
        if (this.paused || this.stopping) return;
        const capacity = this.maxInFlight - this.claiming.size - this.inFlight.size - this.commanding.size;
        if (capacity <= 0) {
            // Completed work owns these slots until main acknowledges its
            // commit. Drain it on the scheduler tick instead of leaving a
            // full (especially player-sized) window idle until the flush timer.
            this.flushDue();
            return;
        }
        const candidates = this.dueCandidates(this.now(), capacity, decisionBudget);
        if (this.partyCapacityBlocked) this.flushDue();
        if (!candidates.length) return;
        DiagnosticConfig.developerDiagnostics && (this.stats.selected += candidates.length);
        const requestId = `claim:${this.nextClaimRequest++}`;
        for (const candidate of candidates) {
            const id = Number(candidate.characterId);
            this.pendingReleases.delete(id);
            const alarmToken = this.armAlarm('claim_ack', id,
                this.claimStartedAt.get(id) + this.claimAckTimeoutMs,
                { stamp: requestId, characterId: id, operational: true });
            const partyId = candidate.purpose?.kind === 'party' ? String(candidate.purpose.partyId) : null;
            this.claimAttempts.set(id, { requestId, alarmToken, partyId });
            if (partyId) {
                const run = this.partyRuns.get(partyId);
                if (run) run.requestId = requestId;
            }
        }
        this.emit('claim_request', { candidates: candidates.map(({ state, context, ...candidate }) => candidate) }, requestId);
    }

    onClaimAck(payload = {}, requestId) {
        if (this.stopping || typeof requestId !== 'string' || !requestId) return;
        const matches = result => this.claiming.has(Number(result.characterId))
            && this.claimAttempts.get(Number(result.characterId))?.requestId === requestId;
        // Unmatched grants stay inert. An abandoned native lease is cleaned
        // by existing expiry/recovery; releasing an ACK replay could instead
        // release the exact currently accepted solo/partial-party grant.
        const rejected = (payload.rejected || []).filter(matches);
        const grants = (payload.grants || []).filter(matches);
        rejected.forEach((result) => {
            const id = Number(result.characterId);
            this.cancelClaimAttempt(id);
            // A rejected claim carries the main process' current ownership
            // snapshot. Party claims must absorb it just like solo claims do;
            // otherwise the next party attempt repeats the same stale revision
            // forever and creates a CAS/IPC retry storm.
            if (result.state) {
                this.upsert(result);
                if (Number(result.retryAfterMs) > 0) {
                    this.requeue(id, this.now() + Math.max(1000, Number(result.retryAfterMs)));
                }
            }
            if (result.purpose?.kind === 'party') {
                const run = this.partyRuns.get(String(result.purpose.partyId));
                if (run) run.rejected = true;
                return;
            }
            if (!result.state) this.requeue(id, this.now() + 1000);
        });
        grants.forEach((grant) => {
            const id = Number(grant.characterId);
            this.cancelClaimAttempt(id);
            if (grant.purpose?.kind === 'party') {
                const run = this.partyRuns.get(String(grant.purpose.partyId));
                if (run) run.grants.set(id, grant);
                return;
            }
            const entry = this.states.get(id);
            if (!entry) return;
            this.inFlight.set(id, { grant, state: entry.state, context: entry.context, startedAt: this.now(), claimRequestId: requestId });
            DiagnosticConfig.developerDiagnostics && (this.stats.claimed += 1);
            const source = this.captureResolverSource(id);
            this.resolveChain = this.resolveChain.then(() => this.resolveGrant(id, source));
        });
        const touchedParties = new Set([
            ...grants.map((entry) => entry.purpose?.partyId),
            ...rejected.map((entry) => entry.purpose?.partyId)
        ].filter(Boolean).map(String));
        touchedParties.forEach((partyId) => {
            const run = this.partyRuns.get(partyId);
            if (!run) return;
            const complete = run.rejected || run.grants.size === run.purpose.memberIds.length;
            if (!complete) return;
            if (run.rejected) {
                const releases = [...run.grants.values()].map((token) => ({ token, reason: 'party_claim_partial' }));
                if (releases.length) this.requestRelease(releases);
                run.purpose.memberIds.forEach((id) => {
                    this.cancelClaimAttempt(id);
                });
                this.partyRuns.delete(partyId);
                this.requeue(run.purpose.leaderId, this.now() + 1000);
                return;
            }
            run.purpose.memberIds.forEach((id) => {
                const state = run.members.find((member) => Number(member.characterId) === Number(id));
                this.inFlight.set(Number(id), {
                    grant: run.grants.get(Number(id)), state, context: {}, startedAt: this.now(), partyId, claimRequestId: requestId
                });
            });
            DiagnosticConfig.developerDiagnostics && (this.stats.claimed += run.purpose.memberIds.length);
            const source = this.capturePartyResolverSource(partyId);
            this.resolveChain = this.resolveChain.then(() => this.resolvePartyGrant(partyId, source));
        });
    }

    livePartialRun(run) {
        return !!run && !run.rejected && this.partyRuns.get(String(run.purpose.partyId)) === run
            && run.purpose.memberIds.some(id => this.claiming.has(Number(id))
                && this.claimAttempts.get(Number(id))?.requestId === run.requestId
                && this.claimAttempts.get(Number(id))?.partyId === String(run.purpose.partyId));
    }

    renewalHolder(token, liveRuns = new Map()) {
        if (this.stopping || !Protocol.leaseRenewalToken(token)) return null;
        const id = token.characterId, entry = this.states.get(id);
        if (entry?.state.phase !== 'cold') return null;
        const same = grant => grant && grant.ownerId === token.ownerId && grant.revision === token.revision
            && grant.leaseId === token.leaseId && grant.characterId === id;
        const active = this.inFlight.get(id);
        if (active) return same(active.grant) ? active : null;
        const partyId = entry.state.party?.partyId || entry.state.partyId || entry.context?.party?.partyId;
        const run = this.partyRuns.get(String(partyId || ''));
        if (!liveRuns.has(run)) liveRuns.set(run, this.livePartialRun(run));
        return liveRuns.get(run) && same(run.grants.get(id)) ? run : null;
    }

    *leaseRenewalPages({ replyBy } = {}) {
        if (!Number.isSafeInteger(replyBy) || replyBy <= this.now() || this.stopping) return;
        const runs = new Set();
        for (const [id, attempt] of this.claimAttempts) {
            if (!attempt.partyId || !this.claiming.has(id)) continue;
            const run = this.partyRuns.get(attempt.partyId);
            if (run?.requestId === attempt.requestId && !run.rejected) runs.add(run);
        }
        const activeHolders = [];
        for (const active of this.inFlight.values()) activeHolders.push(active);
        const holders = function* (kernel) {
            // Capture only the bounded ownership window. New holders arriving
            // during page ACK waits belong to the next renewal round.
            for (const active of activeHolders) yield active.grant;
            for (const run of runs) if (kernel.livePartialRun(run)) yield* run.grants.values();
        }(this);
        const seen = new Set();
        let page = [], liveRuns = new Map();
        for (const grant of holders) {
            if (this.stopping || this.now() >= replyBy) return;
            const token = Protocol.leaseRenewalToken(grant);
            if (!token || token.leaseUntil <= this.now() || seen.has(token.characterId) || !this.renewalHolder(token, liveRuns)) continue;
            seen.add(token.characterId); page.push(token);
            if (page.length === Protocol.MAX_BATCH) { yield page; page = []; liveRuns = new Map(); }
        }
        if (page.length && !this.stopping && this.now() < replyBy) yield page;
    }

    onLeaseRenewal(payload = {}) {
        const liveRuns = new Map();
        (payload.renewals || []).forEach((renewal) => {
            const id = Number(renewal.characterId);
            const holder = this.renewalHolder(renewal, liveRuns);
            const active = this.inFlight.get(id);
            const grant = active?.grant || holder?.grants.get(id);
            if (!holder || !grant) {
                DiagnosticConfig.developerDiagnostics && (this.stats.leaseRenewalMisses += 1);
                return;
            }
            const leaseUntil = Number(renewal.leaseUntil || 0);
            if (!Number.isFinite(leaseUntil) || leaseUntil <= Number(grant.leaseUntil || 0)) return;
            if (active) active.grant = { ...grant, leaseUntil };
            if (!active || active.partyId) {
                const run = !active ? holder : this.partyRuns.get(String(active.partyId));
                const partyGrant = run?.grants.get(id);
                if (partyGrant) run.grants.set(id, { ...partyGrant, leaseUntil });
            }
            DiagnosticConfig.developerDiagnostics && (this.stats.leaseRenewals += 1);
        });
    }

    captureResolverSource(characterId) {
        const id = Number(characterId), active = this.inFlight.get(id);
        return { id, active, token: Protocol.leaseRenewalToken(active?.grant), requestId: active?.claimRequestId };
    }

    resolverSourceCurrent(source) {
        return !this.stopping && !!source.token && typeof source.requestId === 'string' && !!source.requestId
            && this.inFlight.get(source.id) === source.active && source.active.claimRequestId === source.requestId
            && this.sameLease(source.active.grant, source.token)
            && this.states.get(source.id)?.state.phase === 'cold'
            && Number(source.active.grant.leaseUntil) > this.now();
    }

    capturePartyResolverSource(partyId) {
        const run = this.partyRuns.get(String(partyId));
        return run ? { run, requestId: run.requestId,
            sources: run.members.map(member => this.captureResolverSource(member.characterId)) } : null;
    }

    async resolvePartyGrant(partyId, captured = this.capturePartyResolverSource(partyId)) {
        if (!captured || this.stopping) return;
        const { run, requestId, sources } = captured;
        const current = () => this.partyRuns.get(String(partyId)) === run && run.requestId === requestId
            && sources.every(source => source.requestId === requestId && this.resolverSourceCurrent(source)
                && this.sameLease(run.grants.get(source.id), source.token));
        if (!current()) return;
        const startedAt = this.now();
        let raidStepId = null;
        let published = false, handled = false;
        try {
            if (run.invalidReason) {
                const releasedMembers = run.members.map((state) => (
                    BackgroundPartyLifecycle.releaseMember(state, startedAt, run.invalidReason)
                ));
                const dissolvedParty = {
                    ...run.party,
                    status: 'dissolved',
                    nextResolveAt: null,
                    stats: {
                        ...(run.party.stats || {}),
                        partyBreakReason: run.invalidReason,
                        declaredMemberCount: run.party.memberIds?.length || 0,
                        attachedMemberCount: run.members.length,
                        dissolvedAt: startedAt,
                        travel: null
                    }
                };
                const proposals = partyTransitionProposals(
                    run,
                    releasedMembers,
                    dissolvedParty,
                    startedAt,
                    {
                        type: 'party_invalid_size',
                        summary: `Party ${run.party.partyId} dissolved because it has fewer than ${this.partyMinSize} members`,
                        weight: 1,
                        meta: {
                            partyId: run.party.partyId,
                            reason: run.invalidReason,
                            memberCount: run.members.length
                        }
                    },
                    'party_invalid_size'
                );
                published = handled = true;
                proposals.forEach((proposal) => this.dirty.set(proposal.characterId, proposal));
                DiagnosticConfig.developerDiagnostics && (this.stats.resolved += proposals.length);
                this.flush(null, true);
                return;
            }

            const rescuing = run.members.some(s => s.vitals?.hp <= 0);
            const equipmentBridgeReview = !rescuing && !BackgroundPartyLifecycle.raidStarted(run.party)
                && run.members.some(member => this.equipmentBridgeReason?.(member) || this.requiresWeaponBridge?.(member));
            if (!rescuing && (BackgroundPartyLifecycle.sessionExpired(run.party, startedAt, this.partySession)
                || require('./ClanEquipmentPartyPolicy').needsReview(run.party, run.members, startedAt)
                || equipmentBridgeReview)) {
                const review = BackgroundPartyLifecycle.review(run.party, run.members, startedAt, {
                    ...this.partySession,
                    assessRelationship: this.interactionMemory.assess.bind(this.interactionMemory),
                    chooseLeader: states => typeof invoke === 'function' ? invoke('GameServer/Bot/Population/BackgroundPartyComposition').chooseLeader(states) : states[0],
                    roleCoverage: states => typeof invoke === 'function' ? invoke('GameServer/Bot/Population/BackgroundPartyComposition').roleCoverage(states) : run.party.roleCoverage,
                    personaFor: state => typeof invoke === 'function' ? invoke('GameServer/Bot/AI/BotPersona').of(state) : state.persona,
                    requiresWeaponBridge: this.requiresWeaponBridge,
                    equipmentBridgeReason: this.equipmentBridgeReason,
                    spot: run.spot
                });
                const proposals = partyTransitionProposals(run, review.states, review.party, startedAt, {
                    type: 'party_session_review', summary: `Party ${run.party.partyId} reviewed its shared hunt`, weight: 1,
                    meta: { partyId: run.party.partyId, departed: [...review.leaving.keys()], decisions: review.decisions }
                }, 'party_session_review');
                published = handled = true;
                proposals.forEach(proposal => this.dirty.set(proposal.characterId, proposal));
                DiagnosticConfig.developerDiagnostics && (this.stats.resolved += proposals.length);
                this.flush(null, true);
                return;
            }

            const partyTravel = run.party.stats?.travel;
            if (partyTravel?.reason === 'party_spot_replan') {
                const arrivalAt = Number(partyTravel.arrivalAt || 0);
                if (arrivalAt > startedAt) {
                    const waitingMembers = run.members.map((state) => ({
                        ...state,
                        timing: { ...(state.timing || {}), nextResolveAt: arrivalAt }
                    }));
                    const waitingParty = { ...run.party, nextResolveAt: arrivalAt };
                    const proposals = partyTransitionProposals(
                        run,
                        waitingMembers,
                        waitingParty,
                        startedAt,
                        null,
                        'party_travel_wait'
                    );
                    published = handled = true;
                    proposals.forEach((proposal) => this.dirty.set(proposal.characterId, proposal));
                    DiagnosticConfig.developerDiagnostics && (this.stats.resolved += proposals.length);
                    this.flush(null, true);
                    return;
                }

                const arrivedMembers = run.members.map((state) => (
                    finishPartyRouteTravelState(state, startedAt)
                    || {
                        ...state,
                        timing: { ...(state.timing || {}), nextResolveAt: startedAt + 1000 }
                    }
                ));
                const arrivedParty = {
                    ...run.party,
                    nextResolveAt: startedAt + 1000,
                    stats: {
                        ...(run.party.stats || {}),
                        lastResolveAt: startedAt,
                        travel: null
                    }
                };
                const proposals = partyTransitionProposals(
                    run,
                    arrivedMembers,
                    arrivedParty,
                    startedAt,
                    {
                        type: 'party_travel',
                        summary: `Party ${run.party.partyId} arrived near ${partyTravel.regionName || partyTravel.spotId}`,
                        weight: 1,
                        meta: { partyId: run.party.partyId, spotId: partyTravel.spotId || run.party.spotId }
                    },
                    'party_arrival'
                );
                published = handled = true;
                proposals.forEach((proposal) => this.dirty.set(proposal.characterId, proposal));
                DiagnosticConfig.developerDiagnostics && (this.stats.resolved += proposals.length);
                this.flush(null, true);
                return;
            }

            if (!rescuing && run.route?.needed) {
                const arrivalAt = startedAt + Math.max(1000, Number(run.route.travelMs) || HUNTING_TRAVEL_MS);
                const travellingMembers = run.members.map((state) => (
                    beginHuntingTrip(state, run.route, startedAt)
                    || {
                        ...state,
                        timing: { ...(state.timing || {}), nextResolveAt: arrivalAt }
                    }
                ));
                const travellingParty = {
                    ...run.party,
                    spotId: run.route.spotId,
                    nextResolveAt: arrivalAt,
                    stats: {
                        ...(require('./PartySpotRiskPolicy').withBackoff(run.party, run.route.spotBackoff, startedAt).stats || {}),
                        pveEncounter: null,
                        travel: {
                            reason: 'party_spot_replan',
                            regionName: run.route.regionName,
                            spotId: run.route.spotId,
                            startedAt,
                            arrivalAt
                        }
                    }
                };
                const proposals = partyTransitionProposals(
                    run,
                    travellingMembers,
                    travellingParty,
                    startedAt,
                    null,
                    'party_travel'
                );
                published = handled = true;
                proposals.forEach((proposal) => this.dirty.set(proposal.characterId, proposal));
                DiagnosticConfig.developerDiagnostics && (this.stats.resolved += proposals.length);
                this.flush(null, true);
                return;
            }

            if (!this.resolveParty) throw new Error('party_resolver_unavailable');
            const lastResolvedAt = Math.min(...run.members.map((member) => Number(member.timing?.lastResolvedAt || startedAt - 60000)));
            const resolveOptions = {
                episodeId: run.grants.get(Number(run.party.leaderId))?.leaseId,
                assessRelationship: this.interactionMemory.assess.bind(this.interactionMemory),
                party: run.party,
                members: run.members,
                spot: run.spot,
                pressure: run.pressure,
                targetNpcId: run.targetNpcId,
                elapsedMs: Math.max(1000, startedAt - lastResolvedAt),
                rng: deterministicRandom(run.members[0] || {}),
                timestamp: startedAt
            };
            const raids = require('./ColdRaidEncounter');
            const raid = run.spot?.raidBoss === true;
            let staged = null;
            if (raid) {
                raidStepId = `raid:${run.grants.get(Number(run.party.leaderId))?.leaseId}`;
                staged = await raids.stage({ key: raids.keyFor(run.spot, run.targetNpcId), id: raidStepId,
                    memberIds: run.members.map(member => Number(member.characterId)) }, () => this.resolveParty(resolveOptions));
                if (!current()) return;
            }
            const resolution = staged ? staged.result : await this.resolveParty(resolveOptions);
            if (!current()) return;
            const proposals = [];
            const resolvedParty = {
                ...run.party,
                ...resolution.partyPatch,
                stats: { ...(run.party.stats || {}), ...(resolution.partyPatch?.stats || {}) },
                nextResolveAt: resolution.nextResolveAt
            };
            const paidHelp = run.party.stats?.agreement?.help?.status === 'funded';
            const memoryGroup = raid || paidHelp || resolution.atomic || (resolution.memberResults || []).some(({ result }) => result.memoryEvents?.length)
                ? { id: `hunt:${run.grants.get(Number(run.party.leaderId))?.leaseId}`,
                    memberIds: resolution.memberResults.map(({ state }) => Number(state.characterId)) } : null;
            if (raid || paidHelp) {
                resolvedParty.updatedAt = Math.max(startedAt, Number(run.party.updatedAt) + 1);
                memoryGroup.partyChanges = [{ partyId: run.party.partyId, memberIds: run.party.memberIds,
                    expectedUpdatedAt: run.party.updatedAt, updatedAt: resolvedParty.updatedAt,
                    nextResolveAt: resolvedParty.nextResolveAt, statsJson: JSON.stringify(resolvedParty.stats),
                    status: resolvedParty.status, cohesion: resolvedParty.cohesion, risk: resolvedParty.risk }];
            }
            if (raid) {
                // Even a preparation or unavailable-boss result is atomic.
                const snapshot = staged.snapshot || run.spot.raidAuthority || {
                    key: raids.keyFor(run.spot, run.targetNpcId), raidInstanceId: run.spot.raidInstanceId,
                    status: run.spot.raidWorldAvailable === false ? 'unavailable' : 'active',
                    hp: null, revision: 0, updatedAt: startedAt };
                memoryGroup.raidCommit = { key: snapshot.key,
                    worldRequired: run.spot.raidWorldAvailable !== false,
                    expectedRevision: Number(run.spot.raidAuthorityRevision || 0),
                    revision: Number(run.spot.raidAuthorityRevision || 0) + 1, snapshot };
            }
            let requirementMs = 0, lastRequirementPlanMs = 0;
            let requirementProgress = this.partyRequirementProgress.get(String(run.party.partyId));
            if (run.requirementRefresh && !requirementProgress) {
                requirementProgress = new Set();
                this.partyRequirementProgress.set(String(run.party.partyId), requirementProgress);
            }
            const memberPlans = [];
            for (const { state, result } of resolution.memberResults || []) {
                const id = Number(state.characterId);
                const projection = this.projectResolve
                    ? await this.projectResolve(state, result, startedAt)
                    : null;
                if (!current()) return;
                let projectedState = projection?.state || projection;
                if (resolvedParty.status === 'dissolved') {
                    projectedState = BackgroundPartyLifecycle.releaseMember(
                        projectedState,
                        startedAt,
                        resolvedParty.stats?.partyBreakReason || 'party_dissolved',
                        resolvedParty.stats?.objective
                    );
                }
                if (run.requirementRefresh && this.planPartyRequirement && projectedState
                    && resolvedParty.status !== 'dissolved' && !requirementProgress.has(id)
                    && requirementMs + lastRequirementPlanMs < 20) {
                    const planningStarted = performance.now();
                    const selection = await this.planPartyRequirement({ state: projectedState,
                        context: this.states.get(id)?.context || {}, timestamp: startedAt });
                    lastRequirementPlanMs = performance.now() - planningStarted;
                    requirementMs += lastRequirementPlanMs;
                    const plan = selection?.acquisitionPlan;
                    if (require('./PartyRequirementRefresh').acquisitionRequirementKey(state.stats?.equipmentPlan)
                        !== require('./PartyRequirementRefresh').acquisitionRequirementKey(plan)) {
                        memberPlans.push({ characterId: id, plan });
                        if (selection.replanContext?.failure) result.events = [...(result.events || []),
                            require('./PartyRequirementRefresh').acquisitionFallbackEvent(state, state.stats?.equipmentPlan, selection.replanContext.failure, plan)];
                    }
                    requirementProgress.add(id);
                }
                const proposal = {
                    proposalId: `${run.grants.get(id)?.leaseId}:${run.grants.get(id)?.revision}`,
                    characterId: id,
                    priority: memoryGroup ? 'P1' : priorityForResult(state, result),
                    ...(memoryGroup ? { atomicGroup: memoryGroup } : {}),
                    ...(raid ? { raidStepId } : {}),
                    enqueuedAt: this.now(),
                    token: run.grants.get(id),
                    baseState: state,
                    nextState: projectedState,
                    durable: projection?.durable || null,
                    ...(projection?.market ? { market: projection.market } : {}),
                    // A member released by a dissolved party: its decision was
                    // made on its party state, so main decides on the solo one.
                    ...(projection?.economyDecision && resolvedParty.status !== 'dissolved'
                        ? { economyDecision: projection.economyDecision } : {}),
                    economyEdges: resolvedParty.status === 'dissolved' ? 0 : Number(projection?.economyEdges || 0),
                    ...(projection?.economyPlan && resolvedParty.status !== 'dissolved'
                        ? { economyPlan: projection.economyPlan } : {}),
                    result: {
                        ...result,
                        events: [
                            ...(result.events || []),
                            ...(resolution.events || []).filter((event) => Number(event.characterId || run.party.leaderId) === id)
                        ]
                    },
                    options: { allowParty: true, allowLifecycle: true },
                    partyResolution: id === Number(run.party.leaderId) ? {
                        partyId: run.party.partyId,
                        reviewGoals: true,
                        party: resolvedParty
                    } : null
                };
                proposals.push(proposal);
            }
            if (run.requirementRefresh) {
                const leader = proposals.find(proposal => proposal.partyResolution);
                if (leader) {
                    leader.partyResolution.memberPlans = memberPlans;
                    if (run.members.every(member => requirementProgress.has(Number(member.characterId)))) {
                        leader.partyResolution.requirementRefreshedAt = startedAt;
                        this.partyRequirementProgress.delete(String(run.party.partyId));
                    }
                }
                if (resolvedParty.status === 'dissolved') this.partyRequirementProgress.delete(String(run.party.partyId));
                // Preserve the first-refresh key shape used for byte admission.
                for (const key of ['partyRequirementRefreshes', 'partyRequirementRefreshMs', 'partyRequirementRefreshMaxMs']) {
                    if (!Object.hasOwn(this.stats, key)) this.stats[key] = 0;
                }
                DiagnosticConfig.developerDiagnostics && (this.stats.partyRequirementRefreshes = Number(this.stats.partyRequirementRefreshes || 0) + 1);
                DiagnosticConfig.developerDiagnostics && (this.stats.partyRequirementRefreshMs = requirementMs);
                DiagnosticConfig.developerDiagnostics && (this.stats.partyRequirementRefreshMaxMs = Math.max(Number(this.stats.partyRequirementRefreshMaxMs || 0), requirementMs));
            }
            if (!current()) return;
            published = handled = true;
            proposals.forEach(proposal => this.dirty.set(proposal.characterId, proposal));
            DiagnosticConfig.developerDiagnostics && (this.stats.resolved += proposals.length);
            this.flush(null, true);
        } catch (error) {
            if (raidStepId) require('./ColdRaidEncounter').abort(raidStepId);
            if (!current()) return;
            handled = true;
            for (const source of sources) {
                if (raidStepId && this.dirty.get(source.id)?.raidStepId === raidStepId) this.dirty.delete(source.id);
            }
            if (error?.message !== 'raid_step_pending') {
                DiagnosticConfig.developerDiagnostics && (this.stats.errors += 1);
                this.emit('fault', { reason: error?.message || 'party_resolver_error', stage: 'party_project' });
            }
            this.requestRelease([...run.grants.values()].map((token) => ({ token, reason: error?.message || 'party_resolver_error' })));
        } finally {
            if (raidStepId && !published) require('./ColdRaidEncounter').abort(raidStepId);
            if (this.partyRuns.get(String(partyId)) === run) this.partyRuns.delete(String(partyId));
            if (handled) {
                const elapsed = DiagnosticConfig.developerDiagnostics ? this.now() - startedAt : 0;
                DiagnosticConfig.developerDiagnostics && (this.stats.lastResolveMs = elapsed);
                DiagnosticConfig.developerDiagnostics && (this.stats.maxResolveMs = Math.max(this.stats.maxResolveMs, elapsed));
            }
        }
    }

    async resolveGrant(characterId, source = this.captureResolverSource(characterId)) {
        const active = source.active;
        if (source.id !== Number(characterId) || !this.resolverSourceCurrent(source)) return;
        const startedAt = this.now();
        let handled = false;
        try {
            const timestamp = startedAt;
            const elapsedMs = active.state.timing?.lastResolvedAt
                ? Math.max(1000, timestamp - Number(active.state.timing.lastResolvedAt))
                : 60000;
            const lifecyclePlan = this.planLifecycle
                ? await this.planLifecycle({ state: active.state, context: active.context, timestamp })
                : null;
            if (!this.resolverSourceCurrent(source)) return;
            const resolveState = lifecyclePlan?.plannedState || active.state;
            const result = await this.resolveSolo({
                assessRelationship: this.interactionMemory.assess.bind(this.interactionMemory),
                state: resolveState,
                spot: resolveState.activity === 'traveling' ? null : lifecyclePlan?.spot || active.context.spot || null,
                pressure: active.context.pressure || {},
                targetNpcId: Number(lifecyclePlan?.targetNpcId || lifecyclePlan?.acquisitionPlan?.next?.npcId ||
                    (lifecyclePlan?.activityPick?.activity === 'hunting' ? lifecyclePlan.activityPick.npcId : 0) ||
                    active.context.targetNpcId || 0),
                elapsedMs,
                rng: deterministicRandom(active.state),
                timestamp
            });
            if (!this.resolverSourceCurrent(source)) return;
            const projection = this.projectResolve
                ? await this.projectResolve(resolveState, result, timestamp)
                : null;
            if (!this.resolverSourceCurrent(source)) return;
            const projectedState = projection?.state || projection;
            const priority = projection?.durable ? 'P1' : priorityForResult(active.state, result);
            const proposal = {
                proposalId: `${active.grant.leaseId}:${active.grant.revision}`,
                characterId: Number(characterId),
                priority,
                enqueuedAt: this.now(),
                token: active.grant,
                baseState: resolveState,
                nextState: projectedState,
                durable: projection?.durable || null,
                ...(projection?.market ? { market: projection.market } : {}),
                ...(projection?.economyDecision ? { economyDecision: projection.economyDecision } : {}),
                economyEdges: Number(projection?.economyEdges || 0),
                ...(projection?.economyPlan ? { economyPlan: projection.economyPlan } : {}),
                // The projected state precedes claim; main commits one revision
                // after this grant before consuming the offer.
                ...(projection?.buffOffer ? { buffOffer: { ...projection.buffOffer,
                    providerRevision: active.grant.revision } } : {}),
                result,
                options: { allowLifecycle: true }
            };
            handled = true;
            this.dirty.set(Number(characterId), proposal);
            DiagnosticConfig.developerDiagnostics && (this.stats.resolved += 1);
            if (priority !== 'P2' || this.dirty.size >= this.maxBatch) {
                this.flush(priority, false, { reason: priority !== 'P2' ? 'priority' : 'batch' });
            }
        } catch (error) {
            if (!this.resolverSourceCurrent(source)) return;
            handled = true;
            DiagnosticConfig.developerDiagnostics && (this.stats.errors += 1);
            this.emit('fault', { reason: error?.message || 'resolver_error', stage: 'solo_project', characterId: Number(characterId) });
            this.inFlight.delete(Number(characterId));
            this.requestRelease([{ token: active.grant, reason: error?.message || 'resolver_error' }]);
        } finally {
            if (handled) {
                const elapsed = DiagnosticConfig.developerDiagnostics ? this.now() - startedAt : 0;
                DiagnosticConfig.developerDiagnostics && (this.stats.lastResolveMs = elapsed);
                DiagnosticConfig.developerDiagnostics && (this.stats.maxResolveMs = Math.max(this.stats.maxResolveMs, elapsed));
            }
        }
    }

    flush(priority = null, force = false, options = {}) {
        const timestamp = this.now();
        const limit = Math.max(1, Math.min(
            this.maxBatch,
            Number(options.limit) || this.maxBatch
        ));
        const eligible = [...this.dirty.values()]
            .filter((proposal) => force || priority === null || proposal.priority === priority
                || timestamp - proposal.enqueuedAt >= this.flushHardMs)
            .sort((a, b) => {
                const rank = { P0: 0, P1: 1, P2: 2 };
                return rank[a.priority] - rank[b.priority] || a.enqueuedAt - b.enqueuedAt;
            });
        const proposals = [];
        const proposalBytes = [];
        let itemBytes = 0;
        const oversized = [];
        const visited = new Set();
        for (const proposal of eligible) {
            if (visited.has(proposal.characterId)) continue;
            const group = proposal.atomicGroup?.id
                ? eligible.filter(entry => entry.atomicGroup?.id === proposal.atomicGroup.id) : [proposal];
            if (proposals.length + group.length > limit) break;
            group.forEach(entry => visited.add(entry.characterId));
            let transportGroup = group;
            let transportSizes = proposalSizes(group);
            if (DiagnosticConfig.developerDiagnostics === true && groupPayloadBytes(transportSizes) > PROPOSAL_PAYLOAD_LIMIT_BYTES) {
                group.forEach(entry => require('../Economy/ConsumptionDiagnostics').drop(entry));
                transportSizes = proposalSizes(group);
            }
            if (groupPayloadBytes(transportSizes) > PROPOSAL_PAYLOAD_LIMIT_BYTES) {
                DiagnosticConfig.developerDiagnostics && (this.stats.proposalOversize += group.length);
                transportGroup = group.map(entry => compactProposal(entry, true));
                transportSizes = proposalSizes(transportGroup);
                if (groupPayloadBytes(transportSizes) > PROPOSAL_PAYLOAD_LIMIT_BYTES) {
                    transportGroup = group.map(entry => compactProposal(entry, false));
                    transportSizes = proposalSizes(transportGroup);
                }
                if (groupPayloadBytes(transportSizes) > PROPOSAL_PAYLOAD_LIMIT_BYTES) {
                    transportGroup = transportGroup.map(entry => {
                        const base = this.inFlight.get(Number(entry.characterId))?.state;
                        if (!base || !entry.nextState) return entry;
                        const { nextState, ...transport } = entry;
                        return { ...transport, nextStateDelta: ColdStateDelta.create(base, nextState) };
                    });
                    transportSizes = proposalSizes(transportGroup);
                }
                if (groupPayloadBytes(transportSizes) > PROPOSAL_PAYLOAD_LIMIT_BYTES) {
                    oversized.push(...group);
                    continue;
                }
                DiagnosticConfig.developerDiagnostics && (this.stats.proposalCompactions += group.length);
            }
            let candidateItemBytes = transportSizes.reduce((sum, size) => sum + size, itemBytes);
            const candidateCount = proposals.length + transportGroup.length;
            if (DiagnosticConfig.developerDiagnostics === true && proposalPayloadBytes(candidateCount, candidateItemBytes) > PROPOSAL_PAYLOAD_LIMIT_BYTES) {
                const consumption = require('../Economy/ConsumptionDiagnostics');
                let dropped = false;
                for (const entry of proposals) dropped = consumption.drop(entry) || dropped;
                for (const entry of transportGroup) dropped = consumption.drop(entry) || dropped;
                if (dropped) {
                    const priorSizes = proposalSizes(proposals);
                    proposalBytes.splice(0, proposalBytes.length, ...priorSizes);
                    itemBytes = priorSizes.reduce((sum, size) => sum + size, 0);
                    transportSizes = proposalSizes(transportGroup);
                    candidateItemBytes = transportSizes.reduce((sum, size) => sum + size, itemBytes);
                }
            }
            if (proposalPayloadBytes(candidateCount, candidateItemBytes) > PROPOSAL_PAYLOAD_LIMIT_BYTES) break;
            proposals.push(...transportGroup);
            proposalBytes.push(...transportSizes);
            itemBytes = candidateItemBytes;
        }
        oversized.forEach((proposal) => {
            if (proposal.raidStepId) require('./ColdRaidEncounter').abort(proposal.raidStepId);
            this.dirty.delete(Number(proposal.characterId));
            DiagnosticConfig.developerDiagnostics && (this.stats.proposalOversizeRejected += 1);
            this.requestRelease([{ token: proposal.token, reason: 'proposal_too_large' }]);
            this.requeue(Number(proposal.characterId), timestamp + 5000);
        });
        if (!proposals.length) return 0;
        proposals.forEach((proposal) => this.dirty.delete(Number(proposal.characterId)));
        DiagnosticConfig.developerDiagnostics && (this.stats.proposals += proposals.length);
        DiagnosticConfig.developerDiagnostics && (this.stats.flushes += 1);
        DiagnosticConfig.developerDiagnostics && (this.stats.flushRows += proposals.length);
        DiagnosticConfig.developerDiagnostics && (this.stats.lastFlushRows = proposals.length);
        DiagnosticConfig.developerDiagnostics && (this.stats.maxFlushRows = Math.max(this.stats.maxFlushRows, proposals.length));
        const reason = String(options.reason || (force ? 'forced' : 'direct'));
        // Numeric key presence is operational: FrameSizer expands any value
        // to 32 characters, so off need only preserve the original shape.
        if (!Object.hasOwn(this.stats.flushReasons, reason)) this.stats.flushReasons[reason] = 0;
        DiagnosticConfig.developerDiagnostics && (this.stats.flushReasons[reason] = Number(this.stats.flushReasons[reason] || 0) + 1);
        // Sent proposals keep their ownership slots until the commit ACK.
        // Priority and party flushes can fill that window just like a timer flush.
        const capacityBlocked = this.partyCapacityBlocked === true
            || this.claiming.size + this.inFlight.size + this.commanding.size >= this.maxInFlight;
        // Each proposal's measured size travels with it, so the main commit
        // queue need not serialise it again (the list fits the 16 KiB left
        // between the payload limit and the message limit).
        // The payload's JSON size follows from the sizes already counted:
        // { proposals } and { proposalBytes, capacityBlocked } joined by a
        // comma, less the brace each drops. send() need not serialise it again.
        const tail = { proposalBytes, capacityBlocked };
        const payloadBytes = proposalPayloadBytes(proposals.length, itemBytes) + Protocol.byteLength(tail) - 1;
        for (const proposal of proposals) {
            const active = this.inFlight.get(Number(proposal.characterId));
            if (this.sameLease(active?.grant, proposal.token)) {
                active.pendingCommitId = proposal.proposalId;
                active.pendingRaidStepId = proposal.raidStepId;
            }
        }
        this.emit('proposal_batch', { proposals, ...tail }, null, payloadBytes);
        return proposals.length;
    }

    flushDue() {
        const now = this.now();
        const oldest = Math.min(...[...this.dirty.values()].map((proposal) => Number(proposal.enqueuedAt || now)), now);
        if (!this.dirty.size) return 0;
        const ageMs = now - oldest;
        const capacity = this.maxInFlight - this.claiming.size - this.inFlight.size - this.commanding.size;
        if (capacity <= 0 || this.partyCapacityBlocked) {
            // A player-aware ownership window can be smaller than maxBatch.
            // Do not wait for an unreachable batch threshold while completed
            // proposals occupy every lease; the main commit queue still
            // coalesces these bounded batches before touching SQLite.
            return this.flush(null, false, { reason: 'capacity', limit: this.maxInFlight });
        }
        if (this.dirty.size >= this.maxBatch) {
            return this.flush(null, false, { reason: 'batch' });
        }
        if (ageMs >= this.flushHardMs) {
            return this.flush(null, true, { reason: 'hard_age' });
        }
        if (ageMs >= this.flushTargetMs) {
            return this.flush(null, false, { reason: 'target_age' });
        }
        return 0;
    }

    sameLease(left, right) {
        return !!left && !!right && left.characterId === right.characterId && left.ownerId === right.ownerId
            && left.revision === right.revision && left.leaseId === right.leaseId;
    }

    requestRelease(releases = []) {
        if (this.stopping) return 0;
        const accepted = releases.filter(entry => Protocol.leaseRenewalToken(entry?.token));
        if (!accepted.length) return 0;
        const requestId = `release:${this.nextReleaseRequest++}`;
        for (const entry of accepted) {
            const token = Protocol.leaseRenewalToken(entry.token), id = token.characterId;
            this.pendingReleases.delete(id);
            if (this.pendingReleases.size >= 128 * Protocol.MAX_BATCH) {
                // Forget admission only; the native requested release still
                // runs, and existing snapshots/lease expiry cover a lost ACK.
                this.pendingReleases.delete(this.pendingReleases.keys().next().value);
            }
            this.pendingReleases.set(id, { token, requestId, version: this.versions.get(id) || 0 });
        }
        this.emit('release_request', { releases: accepted }, requestId);
        return accepted.length;
    }

    onCommitAck(payload = {}) {
        const accepted = [];
        if (this.stopping) return accepted;
        (payload.results || []).forEach((result) => {
            const identity = Protocol.leaseAckIdentity(result, 'commit_ack');
            if (!identity) return;
            const id = Number(result.characterId);
            const active = this.inFlight.get(id);
            if (!this.sameLease(active?.grant, identity.token) || active.pendingCommitId !== identity.key
                || this.states.get(id)?.state.phase !== 'cold'
                || Number(active.grant.leaseUntil) <= this.now()) return;
            if (active.pendingRaidStepId) require('./ColdRaidEncounter').acknowledge(active.pendingRaidStepId, id, result.ok);
            this.inFlight.delete(id);
            if (result.ok && result.state) {
                this.upsert({ state: result.state, context: result.context || this.states.get(id)?.context || {} });
            } else {
                this.partyRequirementProgress.delete(String(active?.state?.party?.partyId || ''));
                if (String(result.reason || '').includes('stale')) DiagnosticConfig.developerDiagnostics && (this.stats.stale += 1);
                if (result.state) this.upsert({
                    state: {
                        ...result.state,
                        timing: {
                            ...(result.state.timing || {}),
                            nextResolveAt: Math.max(this.now() + 1000, Number(result.state.timing?.nextResolveAt || 0))
                        }
                    },
                    context: result.context || {}
                });
                else this.requeue(id, this.now() + 1000);
            }
            accepted.push(result);
        });
        return accepted;
    }

    onReleaseAck(payload = {}) {
        const accepted = [];
        if (this.stopping) return accepted;
        (payload.results || []).forEach((result) => {
            const identity = Protocol.leaseAckIdentity(result, 'release_ack');
            if (!identity) return;
            const id = Number(result.characterId);
            const pending = this.pendingReleases.get(id), active = this.inFlight.get(id);
            if (!pending || pending.requestId !== identity.key || !this.sameLease(pending.token, identity.token)
                || this.claiming.has(id) || this.states.get(id)?.state.phase !== 'cold'
                || (active && !this.sameLease(active.grant, identity.token))
                || (!active && pending.version !== this.versions.get(id))
                || Number(active?.grant.leaseUntil || pending.token.leaseUntil) <= this.now()) return;
            this.pendingReleases.delete(id);
            this.partyRequirementProgress.delete(String(active?.state?.party?.partyId || this.states.get(id)?.context?.party?.partyId || ''));
            this.lookSeen.delete(id);
            this.inFlight.delete(id);
            if (result.state) this.upsert(result);
            else this.requeue(id, this.now() + 1000);
            accepted.push(result);
        });
        return accepted;
    }

    completeCommand(payload = {}) {
        if (payload.kind === 'meeting') return this.completeMeetingPage(payload);
        const identity = Protocol.commandIdentity(payload);
        if (!identity || typeof payload.ok !== 'boolean' || this.stopping) return false;
        const id = identity.characterId, attempt = this.commandStartedAt.get(id), current = this.states.get(id);
        if (!attempt?.sent || !this.commanding.has(id) || current?.state.phase !== 'cold'
            || attempt.commandId !== identity.commandId
            || !Protocol.sameCommandCheckpoint(attempt.checkpoint, identity.checkpoint)) return false;
        this.cancelCommand(id, attempt);
        let output = payload.state;
        if (output) {
            const outputCheckpoint = Protocol.commandCheckpoint(output), latest = Protocol.commandCheckpoint(current.state);
            // A command may publish its native catalog before its receipt. Admit
            // the original receipt, but keep any known newer retained state.
            if (!outputCheckpoint || outputCheckpoint.simulationRevision < latest.simulationRevision
                || (outputCheckpoint.simulationRevision === latest.simulationRevision
                    && outputCheckpoint.updatedAt < latest.updatedAt)
                || (!Protocol.sameCommandCheckpoint(latest, attempt.checkpoint)
                    && !Protocol.sameCommandCheckpoint(outputCheckpoint, latest)
                    && outputCheckpoint.simulationRevision === latest.simulationRevision
                    && outputCheckpoint.updatedAt <= latest.updatedAt)) output = current.state;
            if (output !== current.state && outputCheckpoint.simulationOwner === latest.simulationOwner
                && outputCheckpoint.simulationRevision === latest.simulationRevision
                && outputCheckpoint.simulationLeaseId === latest.simulationLeaseId
                && Number(output.simulation?.leaseUntil || 0) < Number(current.state.simulation?.leaseUntil || 0)) {
                output = { ...output, simulation: { ...output.simulation, leaseUntil: current.state.simulation.leaseUntil } };
            }
            const context = current.context === attempt.context
                && Protocol.sameCommandCheckpoint(current.state, attempt.checkpoint)
                ? payload.context || current.context : current.context;
            this.upsert({ state: output, context });
            // Rejected commands often return the unchanged overdue state. Do
            // not let that timestamp immediately re-enter the head of the queue.
            if ((payload.ok === false || Number(payload.retryAfterMs) > 0) && this.scheduleTokens.has(id)) {
                this.requeue(id, Math.max(this.scheduleTokens.get(id).dueAt,
                    this.now() + Math.max(1000, Number(payload.retryAfterMs) || 5000)));
            }
        } else this.requeue(id, this.now() + Math.max(1000, Number(payload.retryAfterMs) || 5000));
        return true;
    }

    requeue(characterId, dueAt) {
        const id = Number(characterId);
        const current = this.states.get(id);
        if (!current) return;
        this.schedule(id, current.version, Number(dueAt || this.now()));
    }

    fence(characterId) {
        const id = Number(characterId);
        const proposal = this.dirty.get(id) || null;
        const active = this.inFlight.get(id) || null;
        this.remove(id);
        return { characterId: id, proposal, token: active?.grant || proposal?.token || null };
    }

    pause() {
        this.paused = true;
    }

    resume() {
        this.paused = false;
    }

    setMaxInFlight(value) {
        this.maxInFlight = Math.max(1, Math.min(128, Number(value) || this.maxInFlight));
        return this.maxInFlight;
    }

    async shutdown() {
        this.stopping = true;
        this.partyRequirementProgress.clear();
        this.buyerEvents?.clear();
        this.buyerWakeups.clear();
        this.lookSeen.clear();
        this.pendingReleases.clear();
        this.commanding.clear();
        this.commandStartedAt.clear();
        for (const id of this.claimAttempts.keys()) this.cancelClaimAttempt(id);
        for (const entry of this.alarms.values()) {
            if (entry.alarmKind === 'decision') this.cancelDecisionDeadline(entry.key, entry.alarmToken);
            else this.cancelAlarm(entry.alarmKind, entry.key, entry.alarmToken);
        }
        await this.resolveChain.catch(() => null);
        this.flush(null, true);
        return this.heartbeatSnapshot();
    }

    heartbeatSnapshot(forSizing = false) {
        const now = this.now(), head = this.heap.peek();
        const scheduled = head && head.kind !== 'alarm' ? this.scheduleTokens.get(Number(head.characterId)) : null;
        const current = !!head && (head.kind === 'alarm'
            ? this.alarms.get(head.alarmKey) === head
            : this.validHeapEntry(head) && scheduled?.version === head.version && scheduled.heapEntry === head);
        const dueAt = head ? Number(head.dueAt) : null;
        const oldestDirtyAt = [...this.dirty.values()].reduce((oldest, proposal) => (
            Math.min(oldest, Number(proposal.enqueuedAt || now))
        ), now);
        const oldestCommandAt = [...this.commandStartedAt.values()].reduce((oldest, startedAt) => (
            Math.min(oldest, Number((typeof startedAt === 'object' ? startedAt.startedAt : startedAt) || now))
        ), now);
        return {
            ...(forSizing || DiagnosticConfig.developerDiagnostics ? this.stats : { diagnosticsEnabled: false }),
            states: this.states.size,
            heap: this.heap.size,
            queueHead: {
                kind: !head ? 'empty' : head.kind === 'alarm' ? 'alarm' : 'normal',
                ...(head?.kind === 'alarm' ? { alarmKind: head.alarmKind } : {}),
                dueAt,
                overdue: !!head && dueAt <= now,
                ageMs: head ? Math.max(0, now - dueAt) : 0,
                current
            },
            claiming: this.claiming.size,
            inFlight: this.inFlight.size,
            dirty: this.dirty.size,
            dirtyAgeMs: this.dirty.size ? Math.max(0, now - oldestDirtyAt) : 0,
            commanding: this.commanding.size,
            commandingAgeMs: this.commanding.size ? Math.max(0, now - oldestCommandAt) : 0,
            maxInFlight: this.maxInFlight,
            maxAtomicPartySize: this.maxAtomicPartySize,
            paused: this.paused,
            stopping: this.stopping
        };
    }

    snapshot() {
        if (!DiagnosticConfig.developerDiagnostics) return this.heartbeatSnapshot();
        const now = this.now();
        const due = [...this.states.values()].filter((entry) => (
            isSchedulableKind(lifecycleKind(entry.state, entry.context))
            && nextDueAt(entry.state, now, entry.context, this.partySession) <= now
        ));
        const oldestDueAt = due.reduce((oldest, entry) => (
            Math.min(oldest, nextDueAt(entry.state, now, entry.context, this.partySession))
        ), now);
        const oldestDirtyAt = [...this.dirty.values()].reduce((oldest, proposal) => (
            Math.min(oldest, Number(proposal.enqueuedAt || now))
        ), now);
        const oldestCommandAt = [...this.commandStartedAt.values()].reduce((oldest, startedAt) => (
            Math.min(oldest, Number((typeof startedAt === 'object' ? startedAt.startedAt : startedAt) || now))
        ), now);
        const dueFences = due.reduce((counts, entry) => {
            const id = Number(entry.state.characterId);
            if (this.claiming.has(id)) counts.claiming += 1;
            else if (this.inFlight.has(id)) counts.inFlight += 1;
            else if (this.commanding.has(id)) counts.commanding += 1;
            else if (this.scheduleTokens.has(id)) counts.scheduled += 1;
            else counts.orphaned += 1;
            return counts;
        }, { scheduled: 0, claiming: 0, inFlight: 0, commanding: 0, orphaned: 0 });
        return {
            ...(DiagnosticConfig.developerDiagnostics ? this.stats : { diagnosticsEnabled: false }),
            states: this.states.size,
            heap: this.heap.size,
            due: due.length,
            dueAgeMs: due.length ? Math.max(0, now - oldestDueAt) : 0,
            dueFences,
            claiming: this.claiming.size,
            inFlight: this.inFlight.size,
            dirty: this.dirty.size,
            dirtyAgeMs: this.dirty.size ? Math.max(0, now - oldestDirtyAt) : 0,
            commanding: this.commanding.size,
            commandingAgeMs: this.commanding.size ? Math.max(0, now - oldestCommandAt) : 0,
            maxInFlight: this.maxInFlight,
            maxAtomicPartySize: this.maxAtomicPartySize,
            paused: this.paused,
            stopping: this.stopping
        };
    }
}

module.exports = {
    ColdSimulationKernel,
    DueHeap,
    deterministicRandom,
    finishPartyRouteTravelState,
    lifecycleKind,
    priorityForResult,
    nextDueAt,
    partyTransitionProposals
};
