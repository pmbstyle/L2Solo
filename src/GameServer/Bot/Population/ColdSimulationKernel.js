const { isDeepStrictEqual } = require('node:util');
const PveEncounter = require('./ColdPveEncounter');
const ColdEconomyPlan = require('./ColdEconomyPlan');
const ColdSoloWindow = require('./ColdSoloWindow');
const { ownClock, livedClock, stepElapsedMs } = ColdSoloWindow;
const DiagnosticConfig = require('./PopulationConfig');
const CharacterStateSources = require('../../World/CharacterStateSources');
const SparseNumericStorage = require('./SparseNumericStorage');
const { isMainThread } = require('node:worker_threads');
const FailureLog = require('../../../FailureLog');
const FaultHold = require('../BotFaultHold');
// A step's decision records wait for its commit (DecisionTrace hold/settle).
const Trace = require('../DecisionTrace');
const SIMPLE_ACTIVITIES = new Set(['hunting', 'resting', 'traveling', 'dead']);
const PROPOSAL_PAYLOAD_LIMIT_BYTES = 240 * 1024;
// A step not answered by a commit ack this long after its start is requeued
// (a party by its leader); a late ack then misses its proposal and is dropped.
const STEP_STALL_MS = 30000;
// A bot whose step or command throws again and again (a deterministic bug in
// its state or a rule) is held off, not retried at every due (BotFaultHold:
// longer per fault in a row, quarantined from the fifth) until a step or
// command of it succeeds. The first fault of each message is logged with its
// stack, entering quarantine once; repeats are only counted (status `botFaults`).
// Distinct messages logged per failing bot; others are only counted.
const FAULT_LOGGED_MESSAGES = 4;
// A solo hunt window's most rounds: it ends at its round's events
// (ColdSoloWindow.endOf) or its look-ahead, rarely here.
const MAX_WINDOW_ROUNDS = 32;
// How far past the step's clock a window's rounds run. They run in one burst
// at the step and read the world as it stands then (crowds, prices, the
// board), and a hot session, party or command that interrupts the window
// lives that time again (huntedThrough). Future world state is no input an
// event could carry: this is the simulation's look-ahead, not a window for a
// missing event.
const WINDOW_LEAD_MS = 300000;
// Ready resolver promises chained back to back ran a tick's whole batch as one task (T41 profile
// 10-26: up to 1.3 s with no turn; the heartbeat, the flush and main's acks waited behind it). Each
// queued step and command starts on its own turn: same work, no long task.
const nextTurn = require('../../EventLoopTurn');
// Step lead: a far step starts this much before its due so its commit lands
// by the due (resolved as of the due, max(now, dueAt)). It follows the
// measured start -> commit ack time as a one-sided average: it rises a
// quarter of the gap per slower ack (~4 slow acks catch a slowdown) and
// falls a fiftieth per faster one (~50 acks, a few seconds of traffic, to
// forget it), so it settles near the slow end of the step times, not the
// median. Bounded: a stuck commit queue must not start steps whole rounds
// early.
const STEP_LEAD_RISE = 0.25;
const STEP_LEAD_FALL = 0.02;
const STEP_LEAD_MAX_MS = 5000;
const BackgroundPartyLifecycle = require('./BackgroundPartyLifecycle');
const PartyGoalCalculation = require('./PartyGoalCalculation');
const Protocol = require('./ColdSimulationProtocol');
const ColdStateDelta = require('./ColdStateDelta');
const InventorySummary = require('./InventorySummary');
const { HUNTING_TRAVEL_MS, beginHuntingTrip } = require('./HuntingTravel');
const CraftMaterialPartyRoute = require('./CraftMaterialPartyRoute');
const CraftMaterialParty = require('./CraftMaterialParty');
const PartySpotRiskPolicy = require('./PartySpotRiskPolicy');
const PartyHuntingTarget = require('./PartyHuntingTarget');
const EconomyDiagnostics = require('../Economy/EconomyDiagnostics');
const ColdEconomyDecision = require('./ColdEconomyDecision');
const BotErrands = require('./BotErrands');
const PartyMarketBreak = require('./PartyMarketBreak');
const { SpotOccupancyIndex, stateKey, huntersOn } = require('./SpotOccupancyIndex');
const C4Unseal = require('../../Items/C4Unseal');
const StepLateness = require('./StepLateness');

class DueHeap {
    constructor() {
        this.values = [];
        this.positions = new WeakMap();
        this.playerHeads = [];
        this.meetingHeads = [];
        this.leadHeads = [];
    }

    // Places an entry without refreshing the heads: a sift moves entries
    // along one root path and refreshes that path once, from its deepest
    // changed node (refreshHeads), instead of once per level.
    place(index, entry) {
        this.values[index] = entry;
        this.positions.set(entry, index);
    }

    // A derived minimum on the SAME heap nodes; normal heads never hide a
    // player's wait, a meeting's travel or a round that starts its lead early
    // (`lead`) behind an entry held to its due. A node's heads read only its
    // own entry and its two children's heads, so refreshing from the deepest
    // changed node to the root rebuilds every head a sift changed.
    refreshHeads(index) {
        const values = this.values, length = values.length;
        while (index >= 0) {
            const own = values[index];
            let player = own?.playerWaiting ? own : null;
            let meeting = own?.meetingTravel ? own : null;
            let lead = own?.lead ? own : null;
            for (let child = index * 2 + 1; child <= index * 2 + 2 && child < length; child++) {
                const waiting = this.playerHeads[child];
                if (waiting && (!player || this.compare(waiting, player) < 0)) player = waiting;
                const transit = this.meetingHeads[child];
                if (transit && (!meeting || this.compare(transit, meeting) < 0)) meeting = transit;
                const early = this.leadHeads[child];
                if (early && (!lead || this.compare(early, lead) < 0)) lead = early;
            }
            this.playerHeads[index] = player;
            this.meetingHeads[index] = meeting;
            this.leadHeads[index] = lead;
            if (!index) break;
            index = (index - 1) >> 1;
        }
    }

    peekPlayer() { return this.playerHeads[0] || null; }
    peekMeeting() { return this.meetingHeads[0] || null; }
    peekLead() { return this.leadHeads[0] || null; }

    up(index) {
        const entry = this.values[index], start = index;
        while (index > 0) {
            const parent = Math.floor((index - 1) / 2);
            if (this.compare(this.values[parent], entry) <= 0) break;
            this.place(index, this.values[parent]);
            index = parent;
        }
        this.place(index, entry);
        this.refreshHeads(start);
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
            this.place(index, this.values[next]);
            index = next;
        }
        this.place(index, entry);
        this.refreshHeads(index);
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
        this.refreshHeads(this.values.length);
        this.playerHeads.length = this.values.length;
        this.meetingHeads.length = this.values.length;
        this.leadHeads.length = this.values.length;
        if (index < this.values.length) {
            this.place(index, last);
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

// A step's identity: a bot is in flight once at a time, so its start names
// the step (its acks, its party's episode and raid ids).
function stepProposalId(characterId, startedAt) {
    return `${Number(characterId)}:${Number(startedAt)}`;
}

// The revision a party member's step started from: its proposal's fence.
function memberRevision(run, characterId) {
    const member = run.members.find(entry => Number(entry.characterId) === Number(characterId));
    return Number(member?.simulation?.revision || 0);
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

// The facts the kernel reads from its worker tables: the
// party a bot leads ('parties'), that party's member states (the kernel's
// own records), whether its clan hall needs a visit ('clan_halls') and whether the player waits for it at a
// meeting point ('meetings'). A caller without a kernel (BotLifeState, a
// test) reads none.
const NO_FACTS = Object.freeze({ leaderParty: () => null, partyMembers: () => [],
    hallNeeded: () => false, playerWaiting: () => false });

// party: the party row this bot leads, or null; members: its member states.
function partyIntegrityInvalid(party, members, partySession = {}) {
    if (!party) return false;
    const minSize = Math.max(2, Number(partySession.partyMinSize) || 2);
    const declaredMemberIds = Array.isArray(party.memberIds) && party.memberIds.length
        ? [...new Set(party.memberIds.map(Number).filter(Boolean))]
        : [];
    if (declaredMemberIds.length < minSize) return true;
    const partyId = String(party.partyId || '');
    const attachedCount = members.filter((member) => (
        String(member?.party?.partyId || member?.partyId || '') === partyId
    )).length;
    return attachedCount < minSize || attachedCount !== declaredMemberIds.length;
}

function nextDueAt(state = {}, timestamp = Date.now(), partySession = {}, facts = NO_FACTS) {
    const stateDue = Number(state.timing?.nextResolveAt || 0);
    // Shared hunt/review snapshots may have advanced the personal timer.
    // An accepted obligation keeps its own physical transition deadline,
    // including when the merchant is also the party leader.
    if (state.stats?.tradeMeeting) {
        const transitionDue = state.activity === 'traveling' ? Number(state.stats.travel?.arrivalAt || 0)
            : state.activity === 'resting' ? Number(state.stats.restUntil || 0) : 0;
        return transitionDue > 0 ? transitionDue : stateDue > 0 ? stateDue : timestamp;
    }
    // The party row is the durable scheduling authority for a party resolve.
    // A freshly assigned leader can briefly carry no personal due time, and
    // later leader snapshots can also lag behind an advanced party schedule.
    const party = facts.leaderParty(state.characterId, state);
    const partyDue = party ? Number(party.nextResolveAt || 0) : 0;
    const due = partyDue > 0 ? partyDue : stateDue;
    if (party && partyIntegrityInvalid(party, facts.partyMembers(party), partySession)) return timestamp;
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

// The party row change a whole-roster commit group carries: main writes it in
// the members' transaction only while the row still has the revision the run
// read (Database validateAtomicGroups; else party_revision_stale).
function fencedPartyChange(run, party) {
    return { partyId: run.party.partyId, memberIds: run.party.memberIds,
        expectedPartyRevision: run.party.revision, updatedAt: party.updatedAt,
        nextResolveAt: party.nextResolveAt, statsJson: JSON.stringify(party.stats),
        status: party.status, cohesion: party.cohesion, risk: party.risk };
}

// timestamp: the step's time (as of the leader's due); enqueuedAt: the real
// now, the proposal's flush age. fence: the group always carries the fenced
// party row change.
function partyTransitionProposals(run, memberStates, party, timestamp, enqueuedAt, event = null, activity = 'party_travel', fence = false) {
    const requestedLeaderId = Number(run.party.leaderId || 0);
    const resolutionMemberId = memberStates.some((state) => Number(state.characterId) === requestedLeaderId)
        ? requestedLeaderId
        : Number(memberStates[0]?.characterId || 0);
    const atomicGroup = {
        id: `party:${party.partyId}:${timestamp}:${activity}`,
        memberIds: memberStates.map((state) => Number(state.characterId)).filter(Boolean)
    };
    // Material travel changes the collection contract, and evacuation returns
    // funded help. Fence that party row in the same transaction as every leg.
    if (fence || run.party.stats?.warOperation || (CraftMaterialParty.isObjective(run.party.stats?.objective)
        && ['party_travel', 'party_travel_wait', 'party_arrival'].includes(activity))) {
        party = { ...party, updatedAt: Math.max(enqueuedAt, Number(run.party.updatedAt || 0) + 1) };
        atomicGroup.partyChanges = [{ ...fencedPartyChange(run, party), ...(party.spotId ? { spotId: party.spotId } : {}) }];
    }
    return memberStates.map((state) => {
        const id = Number(state.characterId);
        const events = event && id === resolutionMemberId
            ? [{ ...event, characterId: id }]
            : [];
        const base = run.members.find((member) => Number(member.characterId) === id) || state;
        return {
            proposalId: stepProposalId(id, run.startedAt),
            characterId: id,
            priority: 'P1',
            enqueuedAt,
            revision: memberRevision(run, id),
            ...InventorySummary.bagChange(base.inventory, state.inventory),
            nextState: state,
            durable: null,
            result: { events, debug: { activity, partyId: run.party.partyId, spotId: party.spotId || null } },
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
let ClanPartyDuty, BotCrystallization, ClanCrystalSupply, Situations;

// A near bot's record (hot, nearSeq: its body's last post) against a hot row
// without a newer post number: a writer's copy of the cached row
// (notifyState from the party, PvP and clan writers, the competition's
// onState, a catalog page), whose body is the activation's and older than the
// posts. The record keeps its body and mind. Every activation fences the bot
// first (HotActivation, HotPartyLifecycle, PvpEncounterLifecycle), and so does
// the clan expulsion (ClanSocialRuntime), which removes its record: a new life
// starts from no record, never against an older life's.
function nearHeld(record, row) {
    return row.phase === 'hot' && record.phase === 'hot' && Number(row.nearSeq || 0) < Number(record.nearSeq || 0);
}

// The decision bits a raise set since the bot's last state (its woken bits as
// raised, Situations: a step answers them).
const newlyWoken = (before, after) => !!(Number(after?.stats?.woken || 0) & ~Number(before?.stats?.woken || 0));
// A step main carries out itself (PopulationService's entry branch): its hall's
// step (VisitNeed.needed over the worker's hall row: a visit under way, the
// rebuff's hall answer, a restart there).
function mainVisit(state, facts) {
    return !!state.stats?.clanHallVisit || facts.hallNeeded(state);
}
// A far bot's held guide answer (ColdGuideVisit) is its step's whole round, pure,
// here, read on the state the step starts from: the bot goes for the buffs first and
// that step plans nothing, its errand is planned on its next step (the round carries
// the answer done). A party member's buffs are its party's. The round's result, or null.
let Rebuff = null;
function guideRound(state, timestamp) {
    if (state.party?.partyId || state.partyId || !(Rebuff ||= require('../AI/Rebuff')).pending(state.stats, 'guide')) return null;
    return require('./ColdGuideVisit').plan(state, timestamp);
}
// A held clan waiter (ClanPartyDuty.held) takes no step where the solo resolver
// would plan it: the resolver only holds it again. A command still runs first.
const resolverOrHeld = state => (ClanPartyDuty ||= require('./ClanPartyDuty')).held(state) ? 'event_driven' : 'resolver';
function lifecycleKind(state = {}, facts = NO_FACTS) {
    if (state.phase !== 'cold' || state.activity === 'pk_hunting') return 'inactive';
    const leads = facts.leaderParty(state.characterId, state) !== null;
    // Paid personal journeys retain the existing group writer.
    if (state.party?.partyId) return leads ? 'party' : 'party_member';
    if (state.stats?.tradeMeeting) return ['traveling', 'dead', 'resting', 'fighting'].includes(state.activity) ? 'resolver' : 'event_driven';
    // A solo bot washing karma (ColdKarmaPolicy.active) is planned by the
    // resolver. The test is repeated here: ColdKarmaPolicy loads spot modules.
    if (Number(state.stats?.karma || 0) > 0) return resolverOrHeld(state);
    if (leads) return 'party';
    if (state.activity === 'crafting' && state.stats?.craftShop) return 'event_driven';
    const stats = state.stats || {};
    if (require('./RaidSupplyPolicy').held(state)) {
        return ['shopping', 'merchant'].includes(state.activity) ? 'command' : resolverOrHeld(state);
    }
    const plan = stats.equipmentPlan || {};
    if (mainVisit(state, facts)) return 'command';
    // Finite travel/rest/death transitions are completely represented by the
    // pure resolver result and the owner CAS proposal. Economy follow-up, if
    // any, is selected on the next state after the transition is durable.
    if (state.activity === 'traveling' || state.activity === 'dead'
        || (state.activity === 'resting' && Number(stats.restUntil || 0) > 0)) return 'resolver';
    if (PartyMarketBreak.ready(state)) return 'command';
    if (stats.partyMarketReturn && ['shopping', 'merchant'].includes(state.activity)) return 'command';
    // Finish town services before waiting for a clan hunt. The pure shopping
    // resolver only advances its deadline and cannot buy, sell or leave town.
    if (['shopping', 'crafting', 'merchant'].includes(state.activity)) return 'command';
    // Crystal inputs may still need buying or a trip. The native command must
    // consume this step's chosen wish before another clan review replaces its
    // preparation metadata; the pure hunt resolver cannot perform that work.
    if (plan.clanGoal?.clanId && (ClanCrystalSupply ||= require('../Economy/ClanCrystalSupply')).requirement(state)) return 'command';
    if ((BotCrystallization ||= require('../Economy/BotCrystallization')).ready(state)) return 'command';
    // A published clan wait steps again on its row's next change (ClanPartyDuty.held);
    // a released one goes back to its hunt (ClanPartyDuty.release).
    ClanPartyDuty ||= require('./ClanPartyDuty');
    if (ClanPartyDuty.waiting(state) || ClanPartyDuty.released(state)) return resolverOrHeld(state);
    if (!SIMPLE_ACTIVITIES.has(String(state.activity || ''))) return 'command';
    // craftReturn is a saved destination, not an outstanding crafting action.
    // Actual crafting is routed by activity, shop/station and plan readiness.
    if (BotErrands.busyWith(state, BotErrands.COLD_CLAIM)) return 'command';
    // A sealed item goes to Mammon on a taken build (F6: a side errand runs only when the
    // build was taken, PopulationService.resolveColdServiceBranch): a woken build's step
    // is main's; a failed visit waits for the build's next waking situation.
    if (stats.mammonReturn || (Situations ||= require('../Situations')).woken(stats, 'build')
        && C4Unseal.sealedHeld(state.inventory)) return 'command';
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

// The decision an occupation round is held for: the leaf the bot chose.
function occupationDecision(state, plan) {
    return `${plan.activityPick.activity}:${plan.statsPacket?.activityLeaf ?? state.stats?.activityLeaf}`;
}

// A chosen occupation holds a round once per decision, and only with a plan to
// post: main may refuse the plan (a trip not worth it, a retry window) and keep
// the state, and an empty round starts no trip. The bot hunts on; the plan rides
// each proposal and the fight's edge starts the trip.
function occupationWanted(state, plan, record) {
    return state?.activity === 'hunting' && !state.stats?.pvpEncounter
        && ['shopping', 'selling', 'crafting', 'improving'].includes(plan?.activityPick?.activity)
        && ColdEconomyPlan.acts(plan.economyPlan) && record?.heldOccupation !== occupationDecision(state, plan);
}

// A bot whose next act waits for its fight ends that fight and starts no other:
// a trip (the plan's lastFight, PveEncounter.holdsTrip) or an occupation.
function lastFight(state, plan, record) {
    return plan?.lastFight === true || occupationWanted(state, plan, record);
}

function occupationRound(state, plan, timestamp, record) {
    if (!occupationWanted(state, plan, record) || PveEncounter.pending(state, timestamp)) return null;
    const activity = plan.activityPick.activity;
    if (record) record.heldOccupation = occupationDecision(state, plan);
    // The chosen occupation owns this round. Fighting before posting its
    // execution can spend the kit and replace a purchase with recovery.
    return { patch: {}, events: [], materialize: { exp: 0, sp: 0, adena: 0, items: [] },
        nextResolveAt: timestamp + 30000, debug: { activity, reason: 'selected_occupation' } };
}

// A caller that already read this state's kind in the same call passes it;
// otherwise the kind is read only when the cheap meeting test passes.
function playerWaitingTransition(state, kind = null, facts = NO_FACTS) {
    return !!state?.stats?.tradeMeeting && facts.playerWaiting(state.characterId)
        && (kind ?? lifecycleKind(state, facts)) === 'resolver';
}

function meetingTravelTransition(state, kind = null, facts = NO_FACTS) {
    return state?.activity === 'traveling' && !!state.stats?.tradeMeeting
        && (kind ?? lifecycleKind(state, facts)) === 'resolver';
}

// A lifecycle plan as main receives it: the step's economy object stays in
// the worker (it carries functions and is never posted).
// economy and route are worker-local (the request carries the route's spot); the
// plan's memoryEvents (a displaced bot's grievance) go: main's command commit writes them.
function postedPlan(plan) {
    if (!plan?.economy && !plan?.route && !plan?.stepWakeSeq) return plan;
    const posted = { ...plan };
    delete posted.economy;
    delete posted.route;
    delete posted.stepWakeSeq;
    return posted;
}

function priorityForResult(state, result) {
    const activity = String(result?.patch?.activity || state?.activity || '');
    if (activity === 'dead' || state?.activity === 'dead' || (result?.events || []).some((event) => (
        ['death', 'respawn', 'resurrection'].includes(String(event?.type || ''))
    ))) return 'P0';
    if (state?.stats?.tradeMeeting) return 'P1';
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

// What main reads of a step's result: its events, memory events and debug.
// nextState carries the rest and main commits over its own cached state, so
// no base state travels; of the base, the proposal carries only what the step
// did to the bag (InventorySummary bagChange, top-level, so no flush stage
// drops it).
function proposalResult(result = {}) {
    return {
        events: Array.isArray(result.events) ? result.events : [],
        ...(result.memoryEvents ? { memoryEvents: result.memoryEvents } : {}),
        debug: result.debug || {},
        ...(DiagnosticConfig.developerDiagnostics === true && result.consumptionDiagnostics
            ? { consumptionDiagnostics: result.consumptionDiagnostics } : {})
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

    constructor(sources, shotIndex = null, now = Date.now) {
        super();
        this.shotIndex = shotIndex;
        this.now = now;
        // cardChanged(record): told when a record's held card is new, replaced or dropped (worker).
        this.cardChanged = null;
        // cardRides(id, card): the card's commit is in flight (the kernel's cardInFlight).
        this.cardRides = null;
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
        // Worker calculation advice belongs to this existing native owner, as
        // a field of its record (the record never leaves this thread). A new
        // state is not a new decision: the card the record holds is checked
        // against it. A first row (a restart, a bot this thread held no copy of) restores
        // the card from its bounded restart prefix in stats. A near body's record holds
        // its card unserved (its decision is the packet it posts to main), the card of
        // its last near build once it took one: back far, it serves while its decision
        // echo holds.
        // Readers prove every dependency before reuse, and retirement releases the owner.
        const record = this.get(id);
        const previousAdvice = current?.wishAdvisory;
        const incomingAdvice = !current && this.#skillDtos ? ColdEconomyDecision.restoreAdvisory(record.state, this.now()) : null;
        const wishAdvisory = ColdEconomyDecision.advisoryPublicationHolds(record.state, incomingAdvice, previousAdvice)
            ? incomingAdvice : ColdEconomyDecision.advisoryPublicationHolds(record.state, previousAdvice, null,
                this.cardRides?.(id, previousAdvice) === true) ? previousAdvice : null;
        if (this.#skillDtos && record && (wishAdvisory || record.wishAdvisory)) record.wishAdvisory = wishAdvisory;
        if (previousAdvice && !wishAdvisory) ColdEconomyDecision.noteDropped(record.state, previousAdvice);
        // The board wants follow the held card (the worker's cardChanged): a first row
        // registers the card it restored, a card dropped or replaced here its own.
        if (this.#skillDtos && record && (!current || (record.wishAdvisory?.eventProof || null) !== (previousAdvice?.eventProof || null))) {
            this.cardChanged?.(record);
        }
        if (this.#skillDtos) {
            let staged;
            try {
                const state = this.get(id)?.state;
                SparseNumericStorage.compactState(state);
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
        // The recruit check of a pending join, run at the leader's step
        // (PartyGoalCalculation.recruitCheck in the worker).
        this.reviewRecruits = options.reviewRecruits || null;
        // Numeric member ids only, bounded by active party rosters (<=9 each); dropped at completion, release or dissolve.
        this.partyRequirementProgress = new Map();
        this.planLifecycle = typeof options.planLifecycle === 'function' ? options.planLifecycle : null;
        this.equipmentBridgeReason = typeof options.equipmentBridgeReason === 'function'
            ? options.equipmentBridgeReason : null;
        this.projectResolve = typeof options.projectResolve === 'function' ? options.projectResolve : null;
        // A hunting solo step's window (T120, ColdSoloWindow), the worker's:
        // { projectRound(state, result, timestamp, plan, writtenAt),
        // readers(plan) }. A kernel built without
        // them (a test of another rule) has no window: a step is its one round.
        this.soloWindow = options.soloWindow || null;
        // Read by the health line (PopulationStatus.soloWindowText): solo
        // hunting steps, their rounds and hunt time (steps per hunting
        // bot-hour = 3.6e6 * steps / huntMs); what ended each window.
        this.soloWindowStats = { steps: 0, rounds: 0, huntMs: 0, ended: {} };
        // The spot contest at a party's arrival (the worker's partyArrival):
        // { party, members } with its outcome, or null.
        this.partyArrival = typeof options.partyArrival === 'function' ? options.partyArrival : null;
        // The party's route (the worker's BotRoute.route on the leader's state):
        // { leader, party, members, spot, timestamp, held } -> { route, answer } or null.
        this.partyRoute = typeof options.partyRoute === 'function' ? options.partyRoute : null;
        // A member's held solo answer against its party share in hours to its next level
        // (the worker's PartyProgressComparison): { member, party, members, timestamp } -> boolean.
        this.soloSooner = typeof options.soloSooner === 'function' ? options.soloSooner : null;
        this.now = options.now || Date.now;
        this.emit = options.emit || (() => {});
        this.maxBatch = Math.max(1, Math.min(64, Number(options.maxBatch) || 64));
        // Resolves are chained below, so maxInFlight is a step burst guard
        // rather than a promise-concurrency setting. It must be allowed to
        // stay below maxBatch; otherwise a large batch silently defeats the
        // guard and recreates an unacknowledged-commit backlog.
        this.maxInFlight = Math.max(1, Math.min(128, Number(options.maxInFlight) || 32));
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
        this.states = new RetainedStateMap(CharacterStateSources.attachKernel(options.stateSources || CharacterStateSources.standalone()), options.shotIndex, this.now);
        this.states.cardRides = (id, advice) => this.cardInFlight(id, advice);
        this.occupancy = new SpotOccupancyIndex({ locationIndex: this.states.locationIndex });
        this.interactionMemory = new (require('../../Social/InteractionMemory'))();
        // Worker tables the steps read (partyPut): party rows by party id,
        // each member's party id.
        this.parties = new Map();
        this.partyByMember = new Map();
        // The clan hall rule over the bot's hall row (the worker's 'clan_halls'),
        // the player's meeting waits ('meetings') and a raid boss's row ('raids').
        this.hallNeedOf = typeof options.hallNeeded === 'function' ? options.hallNeeded : () => false;
        this.waitingOf = typeof options.playerWaiting === 'function' ? options.playerWaiting : () => false;
        this.raidRowOf = typeof options.raidRow === 'function' ? options.raidRow : () => null;
        // The spot a bot stands at (SpotService.standingSpot over the worker's
        // spot catalog), computed when a step reads it.
        this.spotOf = typeof options.spotOf === 'function' ? options.spotOf : () => null;
        this.interactionMemory.playingHours = id => this.states.get(id)?.state?.stats?.playedHours;
        this.interactionMemory.clanSocial = new (require('../../Clan/ClanSocialView'))();
        this.interactionMemory.clanWars = new (require('../../Clan/ClanWarView'))();
        this.versions = new Map();
        this.heap = new DueHeap();
        this.scheduleTokens = new Map();
        this.nextScheduleToken = 1;
        this.buyerEvents = null;
        // Bots with no step coming whose row a raise woke: one command step answers it.
        this.raiseWakeups = new Set();
        // Steps by bot, in start order (a Map keeps insertion order): the
        // stall check reads only the oldest entries.
        this.inFlight = new Map();
        // How early a far step starts before its due (STEP_LEAD_*), measured
        // on this thread's own commit acks (onCommitAck); 0 until the first.
        this.stepLeadMs = 0;
        // Each committed step's lateness (StepLateness: ack minus due), cumulative,
        // and the longest since the last heartbeat took it (takeStepLateMax).
        this.stepLate = StepLateness.empty();
        this.stepLateMaxMs = 0;
        this.partyRuns = new Map();
        this.dirty = new Map();
        this.commanding = new Set();
        this.commandStartedAt = new Map();
        this.nextCommandRequest = 1;
        // Reviews a commit ack named that found no command slot (always counted:
        // the plan is re-planned at the bot's next step, its buff or training waits).
        this.reviewsSkipped = 0;
        this.checkpointsRefused = 0;
        // Steps main refused: each is one build paid twice.
        this.stepsRefused = 0;
        this.checkpointErrors = new Set();
        // Bots main named overdue: lines left of their journal (traceWrite).
        this.tracedBots = new Map();
        // Ok commit acks with numbers only whose state this thread could not
        // rebuild (no proposal kept, a bad number): always counted.
        this.ackUnbuilt = 0;
        // Failing bots and parties only (BotFaultHold): bot id, or `party:<id>` for a
        // party run (whoever leads it) -> { count, holdUntil, logged messages }.
        this.faults = new Map();
        // Every bot fault, repeats included, counted always (only on a fault):
        // main sees only the logged ones (fault).
        this.failures = { workerFaults: 0, faultsByStage: {} };
        this.paused = false;
        this.stopping = false;
        this.resolveChain = Promise.resolve();
        this.stats = {
            snapshots: 0,
            // Hot rows older than their near record, kept out (nearHeld).
            nearHeld: 0,
            selected: 0,
            resolved: 0,
            proposals: 0,
            commands: 0,
            errors: 0,
            stale: 0,
            // Steps requeued STEP_STALL_MS after their start with no proposal sent.
            stallRecoveries: 0,
            // commit_acks for a step no longer in flight (requeued as stalled, or removed).
            lateAcks: 0,
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

    dueAt(state, timestamp = this.now()) {
        // Compact catalog members carry no stats. Read the current roster
        // locally; no additional snapshot fields or population scan.
        const party = this.leaderParty(state.characterId, state);
        const meetingPending = !!state.stats?.tradeMeeting
            || (party?.memberIds || []).some(id => this.states.get(Number(id))?.state.stats?.tradeMeeting);
        if (meetingPending && party) {
            if (party.stats?.objective?.sourceKind === 'raid'
                && party.stats?.raidEncounter?.status === 'defeated') return timestamp;
            // Existing accepted meetings keep the group writer. Its deadline
            // is the next physical transition, not a later hunt/review timer.
            let transitionDue = Infinity;
            for (const id of party.memberIds || []) {
                const member = Number(id) === Number(state.characterId) ? state : this.states.get(Number(id))?.state;
                if (!member || !(member.stats?.tradeMeeting || ['resting', 'dead'].includes(member.activity))) continue;
                if (!['traveling', 'resting', 'dead', 'fighting'].includes(member.activity)) continue;
                const due = nextDueAt(member, timestamp, this.partySession);
                if (due > 0) transitionDue = Math.min(transitionDue, due);
            }
            if (Number.isFinite(transitionDue)) return transitionDue;
        }
        return nextDueAt(state, timestamp, this.partySession, this);
    }

    // The 'parties' table (ColdSimulationWorker watch): the rows by party id
    // and each member's party id. A bot leads the party its row names it
    // leader of; the rows are the mirror's own objects, never copied.
    // Each returns the row it replaced (put, remove) or the old leaders (reset).
    partyPut(partyId, row) {
        const previous = this.partyUnindex(partyId);
        this.parties.set(partyId, row);
        for (const id of row.memberIds || []) this.partyByMember.set(Number(id), partyId);
        this.refreshLeaderSchedule(row.leaderId);
        if (previous && Number(previous.leaderId) !== Number(row.leaderId)) this.refreshLeaderSchedule(previous.leaderId);
        return previous;
    }

    partyRemove(partyId) {
        this.clearFault(`party:${partyId}`);
        const previous = this.partyUnindex(partyId);
        if (previous) this.refreshLeaderSchedule(previous.leaderId);
        return previous;
    }

    // A full copy follows: the old leaders are re-read without their rows,
    // the copy's rows schedule their own leaders as they arrive.
    partyReset() {
        const leaders = [...this.parties.values()].map(party => party.leaderId);
        this.parties.clear();
        this.partyByMember.clear();
        for (const id of leaders) this.refreshLeaderSchedule(id);
        return leaders;
    }

    partyUnindex(partyId) {
        const previous = this.parties.get(partyId);
        if (!previous) return null;
        this.parties.delete(partyId);
        for (const id of previous.memberIds || []) {
            if (this.partyByMember.get(Number(id)) === partyId) this.partyByMember.delete(Number(id));
        }
        return previous;
    }

    // The commit a card built or served now rides: the bot's lifecycle or review command
    // in progress (its id), else its step's proposal; null with neither.
    commitOf(characterId) {
        const command = this.commandStartedAt.get(Number(characterId));
        return command && command.kind !== 'meeting' ? command.commandId : this.proposalIdOf(characterId);
    }

    // A card whose decision main has not written yet is still the answer to the row while
    // the commit it rides (record.cardCommit, tied when the worker remembered it) is in
    // flight, or its command answered that it waits (a trade preparation): main's rows
    // sent meanwhile are one decisionSeq behind it. A commit refused, dropped or answered
    // without its decision leaves the card unanswered: the row refuses it (a build).
    cardInFlight(characterId, advice) {
        const ride = advice ? this.states.get(Number(characterId))?.cardCommit : null;
        return !!ride && ride.card === advice && (ride.waiting === true || ride.id !== null && ride.id === this.commitOf(characterId));
    }

    // The party row this bot is a member of, or null.
    // The proposal id of the step a bot has in flight (its commit ack names it), null
    // with none: the spot contest keys an arrival's outcome on it (the worker's outbox).
    proposalIdOf(characterId) {
        const active = this.inFlight.get(Number(characterId));
        return active ? stepProposalId(characterId, active.startedAt) : null;
    }

    partyOf(characterId) {
        const partyId = this.partyByMember.get(Number(characterId));
        return partyId === undefined ? null : this.parties.get(partyId) || null;
    }

    // The party row this bot leads, or null (lifecycleKind, nextDueAt). The
    // bot's own state wins over the row: main publishes the row after its
    // later awaits, so a leader that has just left (or not yet joined) is no
    // party writer. state: the one being read (default: the stored one); a
    // leader with no state keeps the row.
    leaderParty(characterId, state = this.states.get(Number(characterId))?.state) {
        const party = this.partyOf(characterId);
        if (!party || Number(party.leaderId) !== Number(characterId)) return null;
        if (state && String(state.party?.partyId || state.partyId || '') !== String(party.partyId)) return null;
        return party;
    }

    // The member states of a party row the kernel holds (nextDueAt).
    partyMembers(party) {
        const members = [];
        for (const id of party?.memberIds || []) {
            const member = this.states.get(Number(id))?.state;
            if (member) members.push(member);
        }
        return members;
    }

    // Whether this cold bot's step is its clan hall's (lifecycleKind, the command).
    hallNeeded(state) {
        return this.hallNeedOf(state) === true;
    }

    // Whether the player waits for this bot at a meeting point.
    playerWaiting(characterId) {
        return this.waitingOf(Number(characterId)) === true;
    }

    // A raid spot with its boss's live row (instance, authority, engagement,
    // availability); any other spot as it is.
    raidSpot(spot) {
        const row = spot?.raidBoss ? this.raidRowOf(Number(spot.raidBossTemplateId)) : null;
        return row ? { ...spot, ...row } : spot;
    }

    // A follower's change moves its leader's due time (a meeting leg, a
    // transition). Its native membership points to the leader.
    refreshPartyMeetingLeader(characterId, previous) {
        const current = this.states.get(characterId);
        const membership = current?.state?.party;
        const leaderId = Number(membership?.leaderId || this.partyOf(characterId)?.leaderId);
        if (!leaderId || leaderId === characterId) return;
        const party = this.leaderParty(leaderId);
        if (!party || String(membership?.partyId || '') !== String(party.partyId || '')
            || !(party.memberIds || []).some(id => Number(id) === characterId)) return;
        if (previous && current.state.activity === previous.state.activity
            && !!current.state.stats?.tradeMeeting === !!previous.state.stats?.tradeMeeting
            && nextDueAt(current.state, this.now(), this.partySession)
                === nextDueAt(previous.state, this.now(), this.partySession)) return;
        this.refreshLeaderSchedule(leaderId);
    }

    // A leader's due time follows its party row (the parties watch) and its
    // followers (refreshPartyMeetingLeader); the version stays.
    refreshLeaderSchedule(leaderId) {
        const id = Number(leaderId), leader = this.states.get(id);
        if (!id || !leader || this.busy(id)) return;
        const scheduled = this.scheduleTokens.get(id);
        if (!scheduled) { this.ensureScheduled(id); return; }
        const due = this.dueAt(leader.state);
        if (scheduled.dueAt !== due) this.schedule(id, leader.version, due, null, true);
    }

    // entry.ownOutput: the state is this thread's own output echoed back by
    // main, 'commit' (onCommitAck: the proposal) or 'review' (completeCommand:
    // the review that ran the plan sent), handed to states.set for its observers.
    upsert(entry = {}) {
        let state = entry.state || entry;
        const characterId = Number(state?.characterId || 0);
        if (!characterId) return false;
        const ownOutput = entry.ownOutput === 'commit' || entry.ownOutput === 'review' ? entry.ownOutput : null;
        const current = this.states.get(characterId);
        if (this.tracedBots.size) this.traceWrite(characterId, current?.state, state, ownOutput);
        // Only an active bilateral preparation needs stable object identity.
        // Repeated structured-clone snapshots of identical physical state are
        // not new consent. Changed bags/timing/ownership still invalidate it.
        if (this.commandStartedAt.get(characterId)?.kind === 'meeting'
            && current && isDeepStrictEqual(current.state, state)) state = current.state;
        const incomingRevision = Math.max(0, Number(state.simulation?.revision || 0));
        const currentRevision = Math.max(0, Number(current?.state?.simulation?.revision || 0));
        // A hot row older than the near record (nearHeld) leaves it as it is.
        const nearStale = !!current && nearHeld(current.state, state);
        if (nearStale) DiagnosticConfig.developerDiagnostics && (this.stats.nearHeld += 1);
        // A hot row at the cold row's revision is a stale near post that crossed
        // the cooldown: cold -> hot moves the revision (the handoff), hot -> cold does not.
        if (current && (nearStale || incomingRevision < currentRevision || incomingRevision === currentRevision
            && state.phase === 'hot' && current.state.phase === 'cold')) {
            // Periodic catalog pages are prepared on main while the worker can
            // still resolve and receive newer commit ACKs. Preserve monotonic
            // ownership state when an older page arrives out of order.
            this.refreshCommandSource(characterId);
            this.ensureScheduled(characterId);
            this.refreshPartyMeetingLeader(characterId, current);
            return false;
        }
        // The incoming state's due time and kind, read once by the same-revision
        // compare and handed to ensureScheduled below for this state only (the
        // kind also reads the clock, so it is never kept past this call).
        let nextDue = null, nextKind = null, unchanged = false;
        if (current && incomingRevision === currentRevision) {
            const due = this.dueAt(state);
            // dueAt reads this bot's stored row for a meeting in its party;
            // here that row is still the old one, so a due read while the
            // meeting flag clears is read again after the store.
            if (!current.state.stats?.tradeMeeting || state.stats?.tradeMeeting) nextDue = due;
            if (this.dueAt(current.state) === due) {
                nextKind = lifecycleKind(state, this);
                unchanged = lifecycleKind(current.state, this) === nextKind;
            }
        }
        if (unchanged) {
            // A full catalog refresh normally resends the same state. Keep the
            // existing heap version so ten-second refreshes do not accumulate
            // one invalid future node per bot until its next due time.
            this.states.set(characterId, { ...current, state }, ownOutput);
            this.occupancy.update(state);
            DiagnosticConfig.developerDiagnostics && (this.stats.snapshots += 1);
            this.refreshCommandSource(characterId);
            this.ensureScheduled(characterId, nextDue, nextKind);
            this.refreshPartyMeetingLeader(characterId, current);
            return true;
        }
        const version = Number(this.versions.get(characterId) || 0) + 1;
        this.versions.set(characterId, version);
        // The bot's one record: { state, version, huntSpot, spotFit, materialMemo, progressAsk,
        // economyPending, economyPlanHash, wishAdvisory, cardCommit, raiseSeq, nearRoute, stayHeld }.
        // Every field but the state and version is this thread's own and
        // survives a new state: the held hunt spot (BotRoute.heldHuntSpot) until its
        // inputs move or its step drops it, the trip's kept leaf verdict (BotRoute heldVerdict,
        // keyed on what it reads), the material memo and the held party
        // progress ask (partyRequestForPlan), the economy
        // plan sent and its hash, the card it holds and the commit that card
        // rides (cardInFlight), the facts of its last
        // committed action ask (onCommitAck), a clan duty member's held stay trip
        // (partyStay: { partyId, seq }, the party and situationSeq it was held at, kept
        // while that absence holds and its stay stays woken) and, for a near bot, the
        // last raise applied and the route rows of its last decision
        // (ColdSimulationWorker nearEvents, publish).
        // A held event wait (lifecycleKind 'event_driven', stats.eventWait) ends
        // at the write that ends it: that step runs now, not at the hold's due.
        if (current?.state.stats?.eventWait && lifecycleKind(current.state, this) === 'event_driven') {
            nextDue = Math.min(nextDue ?? this.dueAt(state), this.now());
        }
        // A bot with no step coming (event_driven: a craft shop) whose row a raise woke
        // (main's raiseOnRow: a buy ad's need gone, a purchase landed) takes one command
        // step now: its step's gate answers the raise. A meeting answers at its end.
        const raised = !!current && !state.stats?.tradeMeeting && newlyWoken(current.state, state)
            && lifecycleKind(state, this) === 'event_driven';
        if (raised) this.raiseWakeups.add(characterId);
        this.states.set(characterId, { ...current, state, version }, ownOutput);
        this.occupancy.update(state);
        DiagnosticConfig.developerDiagnostics && (this.stats.snapshots += 1);
        this.refreshCommandSource(characterId);
        this.ensureScheduled(characterId, nextDue, nextKind);
        if (raised && !this.busy(characterId)) this.requeue(characterId, this.now());
        this.refreshPartyMeetingLeader(characterId, current);
        return true;
    }

    upsertMany(entries = []) {
        entries.forEach((entry) => this.upsert(entry));
        return entries.length;
    }

    remove(characterId) {
        const id = Number(characterId);
        // Standalone kernels cannot have game economy entries before Global loads.
        if (typeof invoke === 'function') invoke('GameServer/Bot/Economy/EconomyContext').forget(id);
        if (!isMainThread && typeof invoke === 'function') invoke('GameServer/Bot/AI/BotPersona').forget(id);
        const current = this.states.get(id);
        const partyId = String(this.inFlight.get(id)?.partyId
            || this.partyOf(id)?.partyId || current?.state?.party?.partyId || '');
        if (partyId && typeof invoke === 'function') invoke('GameServer/Bot/Economy/EconomyContext').forgetGroup(partyId);
        // A member gone from the party leaves its re-plan; the others' landed plans stand.
        this.partyRequirementProgress.get(partyId)?.delete(id);
        const run = this.partyRuns.get(partyId);
        if (run?.purpose.memberIds.includes(id)) {
            // Retire the captured party before any pending resolver continues;
            // the other members' steps end here and wait for their due.
            this.partyRuns.delete(partyId);
            const others = run.purpose.memberIds.filter(memberId => memberId !== id);
            this.abandonSteps(others);
            others.forEach(memberId => this.requeueAtDue(memberId));
        }
        this.inFlight.delete(id);
        Trace.settle(id, false);
        this.dirty.delete(id);
        if (current?.state) this.occupancy.remove(stateKey(current.state));
        this.states.delete(id);
        this.buyerEvents?.remove(id);
        this.raiseWakeups.delete(id);
        this.versions.set(id, Number(this.versions.get(id) || 0) + 1);
        this.heap.remove(this.scheduleTokens.get(id)?.heapEntry);
        this.scheduleTokens.delete(id);
        this.commanding.delete(id);
        this.commandStartedAt.delete(id);
        this.faults.delete(id);
    }

    // kind: the lifecycleKind of the stored state when the caller has just read it.
    // lead: a round due from the state itself, which may start its lead early (startAt).
    schedule(characterId, version, dueAt, kind = null, lead = false) {
        const id = Number(characterId);
        // Replacing a token also removes its actual indexed node; otherwise a
        // long future deadline keeps every superseded token until it is due.
        this.heap.remove(this.scheduleTokens.get(id)?.heapEntry);
        const token = this.nextScheduleToken++;
        const current = this.states.get(id);
        // A failing bot's hold (fault) wins over every other wake: a catalog
        // refresh, a buyer wake or a deadline does not retry it early.
        // Against the entry's start: a round with a lead starts that much early.
        const holdUntil = this.faults.size ? Number(this.faults.get(id)?.holdUntil || 0) : 0;
        const due = Number(dueAt || this.now());
        if (holdUntil > (lead ? due - this.stepLeadMs : due)) { dueAt = Math.max(due, holdUntil); lead = false; }
        const heapEntry = { characterId: id, version: Number(version),
            dueAt: Math.ceil(Number(dueAt || this.now())), scheduleToken: token,
            playerWaiting: playerWaitingTransition(current?.state, kind, this),
            meetingTravel: meetingTravelTransition(current?.state, kind, this), lead };
        this.scheduleTokens.set(id, { token, version: Number(version), dueAt: heapEntry.dueAt, heapEntry });
        this.heap.push(heapEntry);
    }

    heldEntry(map, now, label) {
        const [id, entry] = map.entries().next().value || [];
        return entry ? { id, what: label(entry), ageMs: Math.max(0, now - Number(entry.startedAt || now)) } : null;
    }

    storeSizes() {
        const skillDtos = this.states.skillDtoSize();
        return {
            skillDtoOwners: skillDtos.owners, skillDtoRows: skillDtos.unique,
            skillDtoAcquisitions: skillDtos.acquiredSlots, skillDtoSharingFailures: skillDtos.sharingFailures,
            states: this.states.size,
            locationStates: this.states.locationIndex.sourceSize('state'),
            occupancy: this.occupancy.size().owners,
            scheduleTokens: this.scheduleTokens.size, ownerHeapNodes: this.heap.size,
            inFlight: this.inFlight.size, dirty: this.dirty.size,
            commanding: this.commanding.size, commandStartedAt: this.commandStartedAt.size,
            partyRuns: this.partyRuns.size, partyRequirementProgress: this.partyRequirementProgress.size
        };
    }

    busy(characterId) {
        const id = Number(characterId);
        return this.inFlight.has(id) || this.commanding.has(id);
    }

    hasNormalCoverage(characterId) {
        const id = Number(characterId), current = this.states.get(id), scheduled = this.scheduleTokens.get(id);
        return !!current && scheduled?.version === current.version
            && scheduled.heapEntry?.scheduleToken === scheduled.token
            && scheduled.heapEntry?.version === current.version
            && this.heap.positions.has(scheduled.heapEntry);
    }

    needsNormalSchedule(characterId) {
        const entry = this.states.get(Number(characterId));
        return !!entry && isSchedulableKind(lifecycleKind(entry.state, this));
    }

    // A situation raised on a far bot by another owner at its next step: the board's
    // (the worker's board diff: offer_posted from MarketBuyerWaiters, line_undercut and
    // goal_done:line on its own lines) and the spot aggregate's (contest_lost: displaced
    // by a stronger arrival, SpotContest). Raised at the bot's next solo step (planLifecycle reads record.stepWake.raises; a party
    // member's waits for the step its own decisions are taken on again) and kept until a
    // step that raised it commits (onCommitAck, completeCommand: its seq), name by name:
    // one heard again after that step read it (heard: its seq) stays. An offer keeps the
    // cheapest heard. A bot with no step coming (a craft shop) takes one command step for
    // it. A worker restart loses a wake not yet committed (counted step:wake:lost by
    // shutdown). payload: plain data ({ itemId, price } for an offer). True when taken.
    stepWake(characterId, name, payload = null) {
        const id = Number(characterId), record = this.states.get(id), state = record?.state;
        if (this.stopping || state?.phase !== 'cold' || this.checkpointErrors.has(id)) return false;
        const wake = record.stepWake, seq = (Number(wake?.seq) || 0) + 1, held = wake?.raises?.[name];
        const kept = held && !(Number(payload?.price) < Number(held.price)) ? held : payload;
        record.stepWake = { seq, raises: { ...wake?.raises, [name]: kept }, heard: { ...wake?.heard, [name]: seq } };
        if (!state.party?.partyId && !state.partyId && lifecycleKind(state, this) === 'event_driven') {
            this.raiseWakeups.add(id);
            if (!this.busy(id)) this.requeue(id, this.now());
        }
        return true;
    }
    // The step wake a committed step raised is answered (its seq): the names heard
    // after it wait for the next step.
    stepWakeAnswered(record, seq) {
        const wake = record?.stepWake;
        if (!wake || !seq) return;
        const left = Object.keys(wake.heard).filter(name => wake.heard[name] > seq);
        record.stepWake = left.length ? { seq: wake.seq, raises: Object.fromEntries(left.map(name => [name, wake.raises[name]])),
            heard: Object.fromEntries(left.map(name => [name, wake.heard[name]])) } : null;
    }

    // dueAt and kind: the due time and lifecycleKind of the stored state when
    // the caller has just read them in the same call; null reads them here.
    ensureScheduled(characterId, dueAt = null, kind = null) {
        const id = Number(characterId);
        const current = this.states.get(id);
        if (!current || this.busy(id)) return false;
        if (this.hasNormalCoverage(id)) {
            const scheduled = this.scheduleTokens.get(id);
            if (scheduled.heapEntry.playerWaiting !== playerWaitingTransition(current.state, kind, this)
                || scheduled.heapEntry.meetingTravel !== meetingTravelTransition(current.state, kind, this)) {
                this.schedule(id, current.version, scheduled.dueAt, kind, scheduled.heapEntry.lead);
            }
            return false;
        }
        kind ??= lifecycleKind(current.state, this);
        if (!isSchedulableKind(kind)) return false;
        // The state's own due: a round (solo or a party's) may start its lead
        // early (startAt); a command is main's world action, held to its due.
        this.schedule(id, current.version, dueAt ?? this.dueAt(current.state), kind,
            kind === 'resolver' || kind === 'party');
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

    dueCandidates(timestamp = this.now(), capacity = this.maxBatch) {
        this.partyCapacityBlocked = false;
        this.duePicked = 0;
        const limit = Math.max(0, Math.min(this.maxBatch, Number(capacity) || 0));
        const candidates = [];
        let commandsSelected = 0;
        let meetingSelected = false;
        // A bot's next round starts its lead before its due (startAt); no
        // entry starts earlier than that, so the scan ends past now + lead.
        // An entry held to its due (a retry, a command)
        // steps aside until the scan ends, so the rounds behind it still
        // start early; each entry is looked at once per scan.
        const startBy = timestamp + this.stepLeadMs;
        const held = [];
        while (candidates.length + commandsSelected < limit && this.heap.size > 0) {
            const waiting = this.heap.peekPlayer();
            const transit = !meetingSelected && this.heap.peekMeeting();
            // One due paid arrival goes ahead of the ordinary hunt backlog;
            // the rest of this batch keeps its existing deadline order.
            const head = waiting && this.startAt(waiting) <= timestamp ? waiting
                : transit && this.startAt(transit) <= timestamp ? transit : this.heap.peek();
            if (Number(head.dueAt || 0) > startBy) break;
            if (this.startAt(head) > timestamp) {
                this.heap.remove(head);
                held.push(head);
                continue;
            }
            if (!this.validHeapEntry(head)) {
                this.heap.remove(head);
                continue;
            }
            const entry = head;
            if (entry.meetingTravel) meetingSelected = true;
            this.heap.remove(entry);
            DiagnosticConfig.developerDiagnostics && (this.duePicked += 1);
            this.consumeHeapEntry(entry);
            const id = Number(entry.characterId);
            // A catalog page may race an ACK and carry a newer revision while
            // the previous revision is still busy. Never create a second
            // writer or depend on the invariant sweep to replace this token;
            // every step/commit/command completion schedules explicitly.
            if (this.busy(id)) continue;
            const current = this.states.get(id);
            const encounter = current.state.stats?.pvpEncounter;
            if (encounter) {
                this.requeueAtDue(id);
                continue;
            }
            const kind = this.raiseWakeups.has(id)
                ? 'command' : lifecycleKind(current.state, this);
            if (kind === 'resolver') {
                // The step starts from the kernel's own copy at once.
                this.inFlight.set(id, { state: current.state, startedAt: this.now(), dueAt: Number(entry.dueAt) });
                Trace.hold(id);
                candidates.push({ characterId: id, purpose: { kind: 'resolver' } });
            } else if (kind === 'party') {
                // The party row (the 'parties' table) without its two
                // published fields, which the run keeps beside it.
                const row = this.leaderParty(id);
                // A party run's hold (fault) holds whoever leads it now.
                const partyHold = this.faults.size ? Number(this.faults.get(`party:${row?.partyId}`)?.holdUntil || 0) : 0;
                if (partyHold > timestamp) {
                    this.requeue(id, partyHold);
                    continue;
                }
                const { raidOwner = null, requirementRefresh = false, ...party } = row || {};
                const declaredMemberIds = Array.isArray(row?.memberIds) && row.memberIds.length
                    ? row.memberIds
                    : [id];
                const memberIds = [...new Set(declaredMemberIds.map(Number).filter(Boolean))];
                // Revision fencing reads the kernel's own per-bot states; a
                // member it does not hold yet waits for its snapshot.
                if (memberIds.some((memberId) => !this.states.get(memberId)?.state)) {
                    this.requeue(id, this.now() + 1000);
                    continue;
                }
                const members = memberIds.map((memberId) => this.states.get(memberId).state);
                const attachedMembers = members.filter((member) => (
                    String(member.party?.partyId || member.partyId || '') === String(party?.partyId || '')
                ));
                // Existing accepted meetings advance through the same atomic
                // group lifecycle; their finite transitions never enter hunt.
                if (members.some(member => member.stats?.pvpEncounter)) {
                    this.requeueAtDue(id);
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
                const occupiedOwnership = this.inFlight.size + this.commanding.size;
                const atomicCapacityBurst = candidateMemberIds.length > this.maxInFlight
                    && candidateMemberIds.length <= this.maxAtomicPartySize
                    && occupiedOwnership === 0;
                if (candidateMemberIds.length > this.maxInFlight && !atomicCapacityBurst) {
                    this.partyCapacityBlocked = true;
                    DiagnosticConfig.developerDiagnostics && (this.stats.partyCapacityDeferrals += 1);
                    if (candidateMemberIds.length <= this.maxAtomicPartySize) {
                        // Let current owners drain so the oldest valid party
                        // gets its bounded atomic turn even under player limits.
                        this.schedule(id, current.version, entry.dueAt, null, entry.lead);
                        break;
                    }
                    this.schedule(id, current.version, this.now() + 250);
                    continue;
                }
                if (!row || !partyMembers.length
                    || candidateMemberIds.some((memberId) => this.inFlight.has(memberId))) {
                    this.requeue(id, this.now() + 1000);
                    continue;
                }
                if (candidates.length + commandsSelected + candidateMemberIds.length > limit && !atomicCapacityBurst) {
                    this.partyCapacityBlocked = true;
                    // Keep the original overdue priority. Moving a party to
                    // now+100 on every partially free tick lets an endless
                    // stream of overdue solo work starve the atomic step.
                    this.schedule(id, current.version, entry.dueAt, null, entry.lead);
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
                const startedAt = this.now();
                this.partyRuns.set(String(party.partyId), {
                    purpose,
                    startedAt,
                    dueAt: Number(entry.dueAt),
                    requirementRefresh: requirementRefresh === true,
                    raidOwner,
                    party,
                    members: partyMembers,
                    spot: this.raidSpot(this.spotOf(current.state)),
                    targetNpcId: Number(PartyHuntingTarget.npcId(party, current.state,
                        memberId => this.states.get(Number(memberId))?.state) || 0),
                    invalidReason: purpose.invalidReason
                });
                candidateMemberIds.forEach((memberId) => {
                    const member = partyMembers.find((entry) => Number(entry.characterId) === memberId);
                    this.inFlight.set(memberId, { state: member, startedAt, dueAt: Number(entry.dueAt), partyId: String(party.partyId) });
                    Trace.hold(memberId);
                    candidates.push({ characterId: memberId, purpose });
                });
            } else if (kind === 'command') {
                // A command is main's world action, run on main's clock: it
                // starts at its due, not its lead before.
                if (entry.dueAt > timestamp) {
                    this.schedule(id, current.version, entry.dueAt, 'command');
                    continue;
                }
                const attempt = this.beginCommand(id);
                if (!attempt) {
                    // Its token is spent and no ACK will return it: back on the
                    // heap, or this bot stays unstepped until its next upsert.
                    if (!this.stopping && !this.busy(id)) this.schedule(id, current.version, timestamp + 1000, 'command');
                    continue;
                }
                commandsSelected += 1;
                DiagnosticConfig.developerDiagnostics && (this.stats.commands += 1);
                this.resolveChain = this.resolveChain.then(nextTurn).then(() => this.resolveCommand(id, attempt));
            }
        }
        // Back on the heap unless the scan replaced or cancelled them.
        for (const entry of held) {
            if (this.validHeapEntry(entry)) this.heap.push(entry);
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
            // Bilateral consent reads a separate, bounded owner slot. A full
            // combat/commit window must not make every other merchant busy.
            // The same owner's active writer remains fenced out.
            if (!current || this.busy(id)
                || [...this.commandStartedAt.values()].filter(value => value.kind === 'meeting').length >= 16) return false;
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
                const result = { ...identity, pageIndex: -1, ok: false, reason: String(error.message || error) };
                if (error.priceEvidence || error.priceFallback) result.priceEvidence = error.priceEvidence || error.priceFallback;
                // The sender checks the full envelope and can use the smaller
                // evidence or omit it without losing the refusal itself.
                this.emit('command_ack', { results: [result] }, null, null, error.priceFallback);
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
        if (!Number.isSafeInteger(id) || id <= 0 || (kind !== 'lifecycle' && kind !== 'review')
            || this.stopping || !current || current.state.phase !== 'cold' || this.busy(id)
            || this.inFlight.size + this.commanding.size >= this.maxInFlight) return null;
        const checkpoint = Protocol.commandCheckpoint(current.state);
        if (!checkpoint) {
            this.refuseCheckpoint(id, current.state);
            return null;
        }
        const attempt = { startedAt: this.now(), commandId: `${kind}:${id}:${this.nextCommandRequest++}`,
            kind, checkpoint, version: current.version, sent: false };
        this.raiseWakeups.delete(id);
        this.commandStartedAt.set(id, attempt);
        this.commanding.add(id);
        Trace.hold(id);
        return attempt;
    }

    // Every state that reaches a bot main named overdue: what moved it, a step or
    // something else. Bounded per bot; only a named bot pays.
    traceWrite(characterId, before, after, ownOutput) {
        const left = this.tracedBots.get(characterId);
        if (!left) return;
        if (left <= 1) this.tracedBots.delete(characterId);
        else this.tracedBots.set(characterId, left - 1);
        const changed = before ? Object.keys({ ...before.stats, ...after.stats })
            .filter(key => !isDeepStrictEqual(before.stats?.[key], after.stats?.[key])) : [];
        console.info('ColdWorker :: overdue write %s', JSON.stringify({ id: characterId, at: this.now(), ownOutput, busy: this.busy(characterId),
            revision: [before?.simulation?.revision, after.simulation?.revision], activity: [before?.activity, after.activity],
            nextResolveAt: [before?.timing?.nextResolveAt, after.timing?.nextResolveAt],
            lastResolvedAt: [before?.timing?.lastResolvedAt, after.timing?.lastResolvedAt], reason: after.stats?.lastReason, changed }));
    }

    // Main's overdue line names the bot and sends its own view; only this thread
    // sees its copy, its token, what holds it. Diagnostics off too.
    traceBot(characterId, main = {}) {
        const id = Number(characterId), record = this.states.get(id), timestamp = this.now();
        if (this.tracedBots.size < 4 && !this.tracedBots.has(id)) this.tracedBots.set(id, 60);
        if (!record) return console.info('ColdWorker :: overdue trace %s', JSON.stringify({ id, main, worker: null }));
        const { state, version } = record, token = this.scheduleTokens.get(id), entry = token?.heapEntry;
        const step = this.inFlight.get(id), command = this.commandStartedAt.get(id), head = this.heap.peek();
        console.info('ColdWorker :: overdue trace %s', JSON.stringify({ id, main, worker: { at: timestamp, activity: state.activity, phase: state.phase,
            kind: lifecycleKind(state, this), nextResolveAt: state.timing?.nextResolveAt, lastResolvedAt: state.timing?.lastResolvedAt,
            updatedAt: state.updatedAt, revision: state.simulation?.revision, kernelDueInMs: Math.round(this.dueAt(state, timestamp) - timestamp), version,
            covered: this.hasNormalCoverage(id), busy: this.busy(id), dirty: this.dirty.has(id), wake: !!record.stepWake,
            token: token ? { dueInMs: Math.round(token.dueAt - timestamp), version: token.version, inHeap: this.heap.positions.has(entry),
                lead: entry?.lead, startInMs: entry ? Math.round(this.startAt(entry) - timestamp) : null } : null,
            step: step ? { ageMs: timestamp - step.startedAt, sent: !!step.pendingCommitId, dueAt: step.dueAt } : null,
            command: command ? { kind: command.kind, sent: !!command.sent, ageMs: timestamp - command.startedAt } : null,
            carries: ['pveEncounter', 'pvpEncounter', 'tradeMeeting', 'travel'].filter(key => state.stats?.[key]),
            heap: this.heap.size, headInMs: head ? Math.round(Number(head.dueAt || 0) - timestamp) : null,
            inFlight: this.inFlight.size, commanding: this.commanding.size, paused: this.paused } }));
    }

    // A state the checkpoint refuses (a fractional clock) is its writer's bug: an
    // error line, so a deploy read fails on it instead of a bot going quiet. A
    // market wake would hold the bot on commands; its resolver steps still run.
    refuseCheckpoint(id, state) {
        this.checkpointsRefused += 1;
        this.raiseWakeups.delete(id);
        if (this.checkpointErrors.has(id) || this.checkpointErrors.size >= 32) return;
        this.checkpointErrors.add(id);
        console.error(`ColdSimulationKernel :: Error: command checkpoint refused bot ${id} ${state.activity}: ${JSON.stringify(state.timing)} updatedAt ${state.updatedAt}`);
    }

    cancelCommand(characterId, attempt) {
        const id = Number(characterId);
        if (!attempt || this.commandStartedAt.get(id) !== attempt) return false;
        this.commandStartedAt.delete(id);
        this.commanding.delete(id);
        // A command ended without its commit: its records go (completeCommand settles a committed one first).
        Trace.settle(id, false);
        // The due heap may have consumed this owner's token while consent
        // held it. ACK, rejection and expiry must all restore its lifecycle.
        if (attempt.kind === 'meeting' && !this.stopping) this.ensureScheduled(id);
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

    // The bots on a spot for a fight's kill share (E69), from this kernel's
    // occupancy index (SpotOccupancyIndex.huntersOn); with a state, that bot
    // counted once. No spot value reads it: a crowd is met at arrival.
    spotHunters(spot, state = null) {
        return huntersOn(this.occupancy, spot?.id, state);
    }

    async resolveCommand(characterId, attempt) {
        const id = Number(characterId);
        const current = this.states.get(id);
        if (!this.currentCommand(id, attempt)) return;
        const timestamp = this.now();
        try {
            const elapsedMs = stepElapsedMs(current.state, timestamp);
            const raidPreparing = require('./RaidSupplyPolicy').held(current.state, timestamp);
            const hallVisit = !raidPreparing && mainVisit(current.state, this);
            const guide = !hallVisit && !raidPreparing && guideRound(current.state, timestamp);
            const lifecyclePlan = !hallVisit && !raidPreparing && !guide && this.planLifecycle
                ? await this.planLifecycle({ state: current.state, timestamp })
                : null;
            if (!this.currentCommand(id, attempt)) return;
            const resolveState = lifecyclePlan?.plannedState || current.state;
            const spot = this.spotOf(current.state);
            const result = hallVisit
                ? { patch: {}, events: [], materialize: { exp: 0, sp: 0, adena: 0, items: [] }, nextResolveAt: timestamp + 30000 }
                : guide || occupationRound(resolveState, lifecyclePlan, timestamp, this.states.get(id)) || await this.resolveSolo({
                assessRelationship: this.interactionMemory.assess.bind(this.interactionMemory),
                state: resolveState,
                spot,
                lastFight: lastFight(resolveState, lifecyclePlan, this.states.get(id)),
                spotHunters: this.spotHunters(spot),
                targetNpcId: Number(lifecyclePlan?.targetNpcId ||
                    (lifecyclePlan?.activityPick?.activity === 'hunting' ? lifecyclePlan.activityPick.npcId : 0) || 0),
                elapsedMs,
                rng: deterministicRandom(current.state),
                timestamp
            });
            if (!this.currentCommand(id, attempt)) return;
            DiagnosticConfig.developerDiagnostics && (this.stats.resolved += 1);
            attempt.sent = true;
            attempt.stepWakeSeq = Number(lifecyclePlan?.stepWakeSeq) || 0;
            const sent = this.emit('command_request', {
                requests: [{
                    characterId: id,
                    kind: 'lifecycle',
                    commandId: attempt.commandId,
                    commandCheckpoint: attempt.checkpoint,
                    state: current.state,
                    precomputedPlan: postedPlan(lifecyclePlan),
                    precomputedResult: result,
                    // The trip the plan started, else the ground this step
                    // fought on (commandSpot on main reads the spot id).
                    route: lifecyclePlan?.route?.needed
                        ? { needed: true, spotId: lifecyclePlan.route.spotId }
                        : { needed: false, spotId: spot?.id ?? null },
                    computedAt: timestamp,
                    ...(hallVisit ? { hallVisit: true } : {})
                }]
            });
            if (sent === false && this.cancelCommand(id, attempt)) {
                this.requeue(id, this.now() + 5000);
            }
        } catch (error) {
            if (!this.currentCommand(id, attempt)) return;
            DiagnosticConfig.developerDiagnostics && (this.stats.errors += 1);
            this.cancelCommand(id, attempt);
            this.requeue(id, this.fault(id, error || 'command_error', 'command'));
        }
    }

    // Steps STEP_STALL_MS past their start whose proposal never left (a hung
    // resolve, a send that failed): requeued, a party by its leader. A sent
    // proposal waits for its commit ack however long main's queue holds it:
    // the ack or the refusal ends it. inFlight is in start order, so the scan
    // stops at the first unsent step still within its time.
    recoverStalled(timestamp = this.now()) {
        for (const [id, active] of this.inFlight) {
            if (active.pendingCommitId) continue;
            if (active.startedAt + STEP_STALL_MS > timestamp) break;
            const run = active.partyId ? this.partyRuns.get(active.partyId) : null;
            const memberIds = active.partyId
                ? [...this.inFlight].filter(([, entry]) => entry.partyId === active.partyId).map(([memberId]) => memberId)
                : [id];
            // A party whose proposal left with any member waits for that ack.
            if (memberIds.some(memberId => this.inFlight.get(memberId).pendingCommitId)) continue;
            if (run) this.partyRuns.delete(active.partyId);
            this.abandonSteps(memberIds);
            if (active.partyId) {
                const leaderId = Number(run?.purpose.leaderId || this.parties.get(active.partyId)?.leaderId || 0);
                if (leaderId) this.requeue(leaderId, timestamp + 1000);
            } else this.requeue(id, timestamp + 1000);
            DiagnosticConfig.developerDiagnostics && (this.stats.stallRecoveries += memberIds.length);
        }
    }

    // A step that ends without a commit ack (an error, an oversized proposal,
    // a stall, a removed party member): its slot frees here, and what the step
    // kept goes: a re-plan it carried is open again at that member. The caller requeues.
    abandonSteps(characterIds) {
        for (const characterId of characterIds) {
            const id = Number(characterId), active = this.inFlight.get(id);
            this.inFlight.delete(id);
            Trace.settle(id, false);
            this.dirty.delete(id);
            if (!active) continue;
            this.reopenReplan(active, id, 'abandoned');
            // No review runs the plan a sent proposal stamped.
            if (active.economyPlan) this.forgetSentPlan(id);
        }
    }

    // A step that carried the party re-plan (a member's new plan, or the leader's end) and
    // did not land: the re-plan plans that member again. A plan landed earlier stands.
    reopenReplan(active, id, reason) {
        if (!active.replanCarried) return;
        if (this.partyRequirementProgress.get(String(active.partyId || active.state?.party?.partyId || ''))?.delete(id)) {
            EconomyDiagnostics.count('party_replan', 'reopened', reason);
        }
    }

    // When a heap entry may start (dueCandidates): a bot's next round, due
    // from its new state (ensureScheduled), its lead before; anything else
    // (a decision deadline, a retry or wait the kernel set) at its due.
    startAt(entry) {
        const dueAt = Number(entry.dueAt || 0);
        return entry.lead ? dueAt - this.stepLeadMs : dueAt;
    }

    // The earliest time tick() can find timed work: the earliest heap start
    // (nextStartAt: a bot or a decision deadline, both on the one heap) or
    // the oldest unsent step's stall (recoverStalled). At or before now: work
    // is due (maybe held by capacity or a pause). A superseded heap node only
    // makes it earlier.
    nextWakeAt() {
        let stallAt = Infinity;
        for (const active of this.inFlight.values()) {
            if (!active.pendingCommitId) { stallAt = active.startedAt + STEP_STALL_MS; break; }
        }
        return Math.min(this.nextStartAt(), stallAt);
    }

    // The earliest heap start: the head (by due) or the earliest round with a
    // lead, which an entry held to its due at the head would hide.
    nextStartAt() {
        const head = this.heap.peek(), lead = this.heap.peekLead();
        return Math.min(head ? this.startAt(head) : Infinity, lead ? this.startAt(lead) : Infinity);
    }

    // Diagnostics only: why a scheduler tick started no step. `no_step`: the tick
    // still took due work (a command, a busy or requeued bot). For a
    // not-yet-due head, how far away the next heap entry is: how
    // often a wake at the earliest entry would fire instead of the 20 ms poll.
    countEmptyTick(timestamp) {
        if (this.duePicked > 0) return EconomyDiagnostics.count('worker_tick', 'empty', 'no_step');
        if (this.heap.size === 0) return EconomyDiagnostics.count('worker_tick', 'empty', 'heap_empty');
        const gap = this.nextStartAt() - timestamp;
        if (!(gap > 0)) return EconomyDiagnostics.count('worker_tick', 'empty', 'no_step');
        EconomyDiagnostics.count('worker_tick', 'empty', 'not_due');
        EconomyDiagnostics.count('worker_tick_gap', gap < 20 ? 'lt20ms' : gap < 100 ? 'lt100ms' : gap < 1000 ? 'lt1s' : 'ge1s');
    }

    tick() {
        DiagnosticConfig.developerDiagnostics && (this.stats.loopRuns += 1);
        this.stats.lastLoopAt = this.now();
        this.recoverStalled(this.stats.lastLoopAt);
        if (this.paused || this.stopping) {
            DiagnosticConfig.developerDiagnostics && EconomyDiagnostics.count('worker_tick', 'empty', 'paused');
            return;
        }
        const capacity = this.maxInFlight - this.inFlight.size - this.commanding.size;
        if (capacity <= 0) {
            DiagnosticConfig.developerDiagnostics && EconomyDiagnostics.count('worker_tick', 'empty', 'no_capacity');
            // Completed work owns these slots until main acknowledges its
            // commit. Drain it on the scheduler tick instead of leaving a
            // full (especially player-sized) window idle until the flush timer.
            this.flushDue();
            return;
        }
        const timestamp = this.now();
        const candidates = this.dueCandidates(timestamp, capacity);
        if (this.partyCapacityBlocked) this.flushDue();
        if (!candidates.length) {
            DiagnosticConfig.developerDiagnostics && this.countEmptyTick(timestamp);
            return;
        }
        DiagnosticConfig.developerDiagnostics && EconomyDiagnostics.count('worker_tick', 'stepped');
        DiagnosticConfig.developerDiagnostics && (this.stats.selected += candidates.length);
        const parties = new Set();
        for (const candidate of candidates) {
            if (candidate.purpose.kind === 'party') {
                const partyId = String(candidate.purpose.partyId);
                if (parties.has(partyId)) continue;
                parties.add(partyId);
                const source = this.capturePartyResolverSource(partyId);
                this.resolveChain = this.resolveChain.then(nextTurn).then(() => this.resolvePartyStep(partyId, source));
            } else {
                const id = Number(candidate.characterId), source = this.captureResolverSource(id);
                this.resolveChain = this.resolveChain.then(nextTurn).then(() => this.resolveStep(id, source));
            }
        }
    }

    captureResolverSource(characterId) {
        const id = Number(characterId);
        return { id, active: this.inFlight.get(id) };
    }

    resolverSourceCurrent(source) {
        return !this.stopping && !!source.active && this.inFlight.get(source.id) === source.active
            && this.states.get(source.id)?.state.phase === 'cold';
    }

    capturePartyResolverSource(partyId) {
        const run = this.partyRuns.get(String(partyId));
        return run ? { run, sources: run.members.map(member => this.captureResolverSource(member.characterId)) } : null;
    }

    // A party step's member stays (party_stay, a member's own decision): the XP share's
    // exclusion of each member raised on its flip (party_outleveled, stats.partyOutleveled
    // its last value), then each member whose stay is woken decides (PartyStay.decide):
    // a leave (its reason), a trip (a leave in an ordinary party; in a clan duty party
    // main starts it with a return ticket: trips). A clan duty lets one member go at a
    // time: a trip answered while another member's absence holds (its ticket live) or
    // another trip went this step is not taken, its bit stays woken
    // (party:stay_trip:held, once per held trip) and the party step after the absence
    // ends decides again. While that absence holds, its stay stays woken and no situation
    // was raised on the member since (the party and situationSeq it was held at, kept on
    // its record: stayHeld), the held answer stands and no step decides it again; any
    // other step ends the hold, and a trip held after it is a new one.
    // Not while the party meets a player, carries a dead member, fights a war or a
    // started raid, or evacuates: the bits wait. Returns { members (new copies where
    // anything moved), leaving: Map(id -> reason), trips: [{ characterId, reason }] }.
    partyStay(run, timestamp, { meetingPending = false, rescuing = false } = {}) {
        Situations ||= require('../Situations');
        const Stay = require('./PartyStay'), party = run.party;
        const eligible = new Set(require('../../Actor/PartyRewardMath').validMemberIndexes(run.members.map(member => Number(member.level || 1))));
        const decides = !meetingPending && !rescuing && !party.stats?.warOperation && !BackgroundPartyLifecycle.raidStarted(party)
            && !CraftMaterialPartyRoute.evacuating(party);
        const duty = PartyMarketBreak.clanDuty(party);
        const absent = duty && PartyMarketBreak.pending(party, timestamp).length > 0;
        // A required objective (not a material hunt's, whose quotas end it) goes on while
        // enough members' plans still need a party; a member whose need of it ended is done.
        const objective = party.stats?.objective;
        const required = objective?.priority === 'required' && !CraftMaterialParty.isObjective(objective)
            && run.members.filter(member => Stay.needsParty(member.stats?.equipmentPlan)).length >= this.partyMinSize;
        // shares: the party's income split, worked out once a step for every member whose stay reads it.
        const leaving = new Map(), trips = [], shares = {};
        const members = run.members.map((member, index) => {
            const id = Number(member.characterId), outleveled = eligible.has(index) ? 0 : 1;
            let stats = member.stats || {};
            if (outleveled !== (Number(stats.partyOutleveled) || 0)) {
                stats = { ...stats, partyOutleveled: outleveled };
                if (outleveled) Situations.raise(stats, 'party_outleveled', null, Situations.place(member), id);
            }
            const record = this.states.get(id), seq = Number(stats.situationSeq) || 0;
            const woken = Situations.woken(stats, 'party_stay');
            if (record?.stayHeld && !(absent && woken && record.stayHeld.partyId === String(party.partyId))) record.stayHeld = null;
            if (decides && woken && record?.stayHeld?.seq !== seq) {
                const { answer, reason } = Stay.decide(member, { now: timestamp, outleveled: !!outleveled, clanDuty: duty,
                    requiredObjective: required,
                    bridgeReason: this.equipmentBridgeReason,
                    soloSooner: () => !!this.soloSooner?.({ member, party, members: run.members, timestamp, shares }) });
                if (answer === 'trip' && duty && (absent || trips.length)) {
                    if (!record?.stayHeld) Situations.note('party:stay_trip:held');
                    if (record) record.stayHeld = { partyId: String(party.partyId), seq };
                } else {
                    if (record) record.stayHeld = null;
                    stats = { ...stats, woken: Situations.decided(stats, 'party_stay', { caller: 'party_step', subject: id, answer: `${answer}:${reason}` }) };
                    if (answer === 'leave' || answer === 'trip' && !duty) leaving.set(id, reason);
                    else if (answer === 'trip') trips.push({ characterId: id, reason });
                }
            }
            return stats === member.stats ? member : { ...member, stats };
        });
        return { members, leaving, trips };
    }

    // A party step's spot decision (Situations' party subject): the party's facts against
    // its held answer (detectParty: roster, its deaths, the leader outleveling the spot,
    // the marks its arrival or rounds left) raised on the party's bits; woken (or none
    // held for its objective) the one search runs and its answer is held with the facts
    // it was taken on. Returns { party (a new row copy when anything moved), route (the
    // trip, or null), none (the decision found no ground) }.
    partySpot(run, timestamp) {
        Situations ||= require('../Situations');
        const party = run.party, leaderId = Number(party.leaderId || 0);
        const leader = run.members.find(member => Number(member.characterId) === leaderId) || run.members[0];
        const held = Situations.partyHeld(party);
        const facts = { deaths: Number(party.stats?.deaths) || 0, leaderLevel: Number(leader?.level) || 1 };
        const names = Situations.detectParty(party, held, { ...facts, marks: PartySpotRiskPolicy.marks(party) });
        let current = names.length ? { ...party, stats: Situations.raiseParty({ ...party.stats }, names, party.partyId, leaderId) } : party;
        const decide = Situations.partyWoken(current);
        const routed = this.partyRoute({ leader, party: current, members: run.members, spot: run.spot, timestamp, held: decide ? null : held });
        const answer = routed?.answer;
        // A spot the party only met at that no longer stands for it ends its objective
        // (BotRoute.choose): the answer is held for the party as it now routes.
        if (answer?.objectiveEnded) current = { ...current, stats: { ...current.stats, objective: null } };
        if (answer) current = { ...current, stats: { ...current.stats,
            woken: Situations.partyDecided(current, 'party_spot', { subject: leaderId, answer: answer.spotId ?? 'none', was: held?.spotId }),
            partySpot: Situations.partySpotAnswer(current, answer, timestamp, facts) } };
        return { party: current, route: routed?.route || null, none: !!answer && answer.spotId == null };
    }

    async resolvePartyStep(partyId, captured = this.capturePartyResolverSource(partyId)) {
        if (!captured || this.stopping) return;
        const { run, sources } = captured;
        const current = () => this.partyRuns.get(String(partyId)) === run
            && sources.every(source => this.resolverSourceCurrent(source));
        if (!current()) return;
        // The party's step time (every stamp below): as of the leader's due,
        // never earlier (resolveStep); its ids keep the real start
        // (run.startedAt), its rows' write stamp the real now (resolveStartedAt).
        const resolveStartedAt = this.now();
        const startedAt = Math.ceil(Math.max(resolveStartedAt, run.dueAt || 0));
        let raidStepId = null;
        let published = false, handled = false;
        // The members' duty trips the stay answered (partyStay: trips): they ride the
        // leader's commit on whichever exit the step takes (publish), main starts them
        // (stayTrips); a dissolved party starts none, its members leave.
        let trips = [];
        const publish = proposals => {
            const leader = trips.length ? proposals.find(proposal => proposal.partyResolution) : null;
            if (leader && leader.partyResolution.party?.status !== 'dissolved') leader.partyResolution.stayTrips = trips;
            published = handled = true;
            proposals.forEach(proposal => this.dirty.set(proposal.characterId, proposal));
            DiagnosticConfig.developerDiagnostics && (this.stats.resolved += proposals.length);
            this.flush(null, true);
        };
        try {
            // The party ends here: every member leaves (the one leave rule), the row dissolves.
            const dissolve = (reason, type, summary) => {
                const releasedMembers = run.members.map(state => BackgroundPartyLifecycle.releaseMember(state, startedAt, reason));
                const dissolvedParty = { ...run.party, status: 'dissolved', nextResolveAt: null,
                    stats: { ...(run.party.stats || {}), partyBreakReason: reason, travel: null } };
                const proposals = partyTransitionProposals(run, releasedMembers, dissolvedParty, startedAt, this.now(),
                    { type, summary, weight: 1, meta: { partyId: run.party.partyId, reason, memberCount: run.members.length } }, type);
                publish(proposals);
            };
            if (run.invalidReason) {
                dissolve(run.invalidReason, 'party_invalid_size',
                    `Party ${run.party.partyId} dissolved because it has fewer than ${this.partyMinSize} members`);
                return;
            }

            const meetingPending = require('./PartyHuntingAssembly').meetingPending(run.members);
            const rescuing = run.members.some(s => s.vitals?.hp <= 0);
            // Its members' stays (party_stay, each on its own situations) and the party's
            // objective ends; a member leaving releases it here, the rest go on. The run's
            // member copies are replaced by the ones carrying their decisions.
            // A member on the party's road whose trip has ended arrives here, whether
            // or not the party's own trip still stands (a recruit's later arrival).
            run.members = run.members.map(state => finishPartyRouteTravelState(state, startedAt) || state);
            const stay = this.partyStay(run, startedAt, { meetingPending, rescuing });
            run.members = stay.members;
            trips = stay.trips;
            const ends = !meetingPending && !rescuing && !run.party.stats?.warOperation && !CraftMaterialPartyRoute.evacuating(run.party)
                ? BackgroundPartyLifecycle.objectiveEnds(run.party, run.members) : null;
            for (const [id, reason] of ends?.leaving || []) stay.leaving.set(id, reason);
            // The members that leave (leaving: Map(id -> reason)) through the one leave
            // rule; the rest go on, under the minimum the party dissolves.
            const releaseLeavers = leaving => {
                const release = BackgroundPartyLifecycle.release(run.party, run.members, leaving, startedAt, {
                    partyMinSize: this.partyMinSize,
                    chooseLeader: states => invoke('GameServer/Bot/Population/BackgroundPartyComposition').chooseLeader(states),
                    roleCoverage: states => invoke('GameServer/Bot/Population/BackgroundPartyComposition').roleCoverage(states) });
                const proposals = partyTransitionProposals(run, release.states, release.party, startedAt, this.now(), {
                    type: 'party_stay', summary: `Party ${run.party.partyId}: ${release.leaving.size} member(s) left`, weight: 1,
                    meta: { partyId: run.party.partyId, departed: Object.fromEntries(release.leaving) }
                }, 'party_stay');
                publish(proposals);
            };
            if (stay.leaving.size) {
                releaseLeavers(stay.leaving);
                return;
            }

            const partyTravel = run.party.stats?.travel;
            if (!meetingPending && partyTravel?.reason === 'party_spot_replan') {
                // The trip ends when its last member arrives.
                const arrivalAt = Math.max(Number(partyTravel.arrivalAt || 0), ...run.members.map(state =>
                    state.stats?.travel?.reason === 'party_spot_replan' ? Number(state.stats.travel.arrivalAt) || 0 : 0));
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
                        this.now(),
                        null,
                        'party_travel_wait'
                    );
                    publish(proposals);
                    return;
                }

                const arrivedMembers = run.members.map((state) => (
                    finishPartyRouteTravelState(state, startedAt)
                    || {
                        ...state,
                        timing: { ...(state.timing || {}), nextResolveAt: startedAt + 1000 }
                    }
                ));
                let arrivedParty = {
                    ...run.party,
                    nextResolveAt: startedAt + 1000,
                    stats: {
                        ...(run.party.stats || {}),
                        lastResolveAt: startedAt,
                        travel: null
                    }
                };
                const materialArrival = CraftMaterialPartyRoute.arrived(run.party, arrivedMembers, startedAt);
                if (materialArrival) {
                    arrivedMembers.splice(0, arrivedMembers.length, ...materialArrival.members);
                    arrivedParty = materialArrival.party;
                }
                // The party meets the spot once, as a whole, here; its members'
                // own arrivals do not.
                const contested = this.partyArrival?.({ party: arrivedParty, members: arrivedMembers,
                    spotId: partyTravel.spotId, timestamp: startedAt,
                    proposalOf: id => stepProposalId(Number(id), run.startedAt) });
                if (contested) {
                    arrivedMembers.splice(0, arrivedMembers.length, ...contested.members);
                    arrivedParty = contested.party;
                }
                const proposals = partyTransitionProposals(
                    run,
                    arrivedMembers,
                    arrivedParty,
                    startedAt,
                    this.now(),
                    {
                        type: 'party_travel',
                        summary: `Party ${run.party.partyId} arrived near ${partyTravel.regionName || partyTravel.spotId}`,
                        weight: 1,
                        meta: { partyId: run.party.partyId, spotId: partyTravel.spotId || run.party.spotId }
                    },
                    'party_arrival'
                );
                publish(proposals);
                return;
            }

            // The party's spot (party_spot): held on the party, searched only at its
            // situations or with no answer for its objective (partySpot). The run's party
            // copy is replaced by the one carrying the decision.
            const spotStep = !meetingPending && !rescuing && this.partyRoute ? this.partySpot(run, startedAt) : null;
            if (spotStep) run.party = spotStep.party;
            if (spotStep?.none) {
                // No ground the party may hunt: it breaks up, each member to its own.
                (Situations ||= require('../Situations')).note('party_no_spot');
                dissolve('party_no_spot', 'party_no_spot', `Party ${run.party.partyId} found no hunting ground and broke up`);
                return;
            }
            const route = spotStep?.route || null;
            const fightHoldsTrip = PveEncounter.holdsTrip(run.party, route, startedAt);
            if (route?.needed && !fightHoldsTrip) {
                const arrivalAt = startedAt + Math.max(1000, Number(route.travelMs) || HUNTING_TRAVEL_MS);
                const travellingMembers = run.members.map((state) => (
                    beginHuntingTrip(state, route, startedAt)
                    || {
                        ...state,
                        timing: { ...(state.timing || {}), nextResolveAt: arrivalAt }
                    }
                ));
                const travellingParty = {
                    ...run.party,
                    spotId: route.spotId,
                    nextResolveAt: arrivalAt,
                    stats: {
                        ...(CraftMaterialPartyRoute.retarget(
                            PartySpotRiskPolicy.withBackoff(run.party, route.spotBackoff, startedAt),
                            route.materialSources).stats || {}),
                        pveEncounter: null,
                        travel: {
                            reason: 'party_spot_replan',
                            regionName: route.regionName,
                            spotId: route.spotId,
                            startedAt,
                            arrivalAt,
                            ...(route.cause ? { cause: route.cause } : {}),
                            ...(route.materialEvacuation ? { materialEvacuation: true } : {})
                        }
                    }
                };
                const proposals = partyTransitionProposals(
                    run,
                    travellingMembers,
                    travellingParty,
                    startedAt,
                    this.now(),
                    null,
                    'party_travel'
                );
                publish(proposals);
                return;
            }

            if (!this.resolveParty) throw new Error('party_resolver_unavailable');
            // A member that held for an event (livedClock) lived its wait.
            const lastResolvedAt = Math.min(...run.members.map((member) => livedClock(member, startedAt) || startedAt - 60000));
            const resolveOptions = {
                episodeId: stepProposalId(run.party.leaderId, run.startedAt),
                assessRelationship: this.interactionMemory.assess.bind(this.interactionMemory),
                party: run.party,
                raidOwner: run.raidOwner || null,
                members: run.members,
                spot: run.spot,
                spotHunters: this.spotHunters(run.spot),
                targetNpcId: run.targetNpcId,
                lastFight: fightHoldsTrip,
                elapsedMs: Math.max(1000, startedAt - lastResolvedAt),
                rng: deterministicRandom(run.members[0] || {}),
                timestamp: startedAt
            };
            const raids = require('./ColdRaidEncounter');
            const raid = !meetingPending && run.spot?.raidBoss === true;
            let staged = null;
            if (raid) {
                raidStepId = `raid:${stepProposalId(run.party.leaderId, run.startedAt)}`;
                staged = await raids.stage({ key: raids.keyFor(run.spot, run.targetNpcId), id: raidStepId,
                    memberIds: run.members.map(member => Number(member.characterId)) }, () => this.resolveParty(resolveOptions));
                if (!current()) return;
            }
            const resolution = staged ? staged.result : await this.resolveParty(resolveOptions);
            if (!current()) return;
            // An assembly nothing more comes to: its absent members leave.
            if (resolution.assemblyAbsent?.length) {
                releaseLeavers(new Map(resolution.assemblyAbsent.map(id => [Number(id), require('./PartyHuntingAssembly').REASON])));
                return;
            }
            const proposals = [];
            let resolvedParty = {
                ...run.party,
                ...resolution.partyPatch,
                stats: { ...(run.party.stats || {}), ...(resolution.partyPatch?.stats || {}) },
                nextResolveAt: resolution.nextResolveAt
            };
            // A round its spot admitted no fight of: the spot marked empty, heard at its next step.
            if (resolution.unhuntable && run.spot?.id != null) resolvedParty = PartySpotRiskPolicy.withMark(resolvedParty, run.spot.id, 'spot_empty');
            // The pending join main recorded (recruitBackgroundMembers): the
            // recruit check runs here on this thread's copies of the recruits;
            // the answer rides the leader's proposal (main commits a join). A
            // recruit mid-step keeps the join pending for the next leader step;
            // after a decline the next formation pass picks again.
            let recruitCheck = null;
            const pendingRecruits = run.party.stats?.pendingRecruits;
            if (pendingRecruits && !meetingPending && resolvedParty.status !== 'dissolved') {
                const ids = (pendingRecruits.ids || []).map(Number);
                if (ids.some(id => this.busy(id))) recruitCheck = { outcome: 'unavailable' };
                else {
                    delete resolvedParty.stats.pendingRecruits;
                    const recruits = ids.map(id => this.states.get(id)?.state);
                    const free = recruits.length > 0 && recruits.every(recruit => recruit?.phase === 'cold'
                        && !recruit.party?.partyId && !recruit.partyId);
                    const checked = free && this.reviewRecruits
                        ? this.reviewRecruits({ party: run.party, members: [...run.members, ...recruits], timestamp: startedAt }) : null;
                    recruitCheck = checked ? { outcome: 'accepted', memberIds: run.party.memberIds, recruitIds: ids,
                        sources: PartyGoalCalculation.sources(recruits), joint: checked }
                        : { outcome: free ? 'declined' : 'gone' };
                }
            }
            const paidHelp = run.party.stats?.agreement?.help?.status === 'funded';
            const materialHunt = CraftMaterialParty.isObjective(run.party.stats?.objective);
            // Collection quotas and their physical receipts share the same
            // commit, including completion with no funded helper contract.
            const atomicParty = raid || paidHelp || materialHunt || resolvedParty.status === 'dissolved';
            const memoryGroup = atomicParty || resolution.atomic || (resolution.memberResults || []).some(({ result }) => result.memoryEvents?.length)
                ? { id: `hunt:${stepProposalId(run.party.leaderId, run.startedAt)}`,
                    memberIds: resolution.memberResults.map(({ state }) => Number(state.characterId)) } : null;
            if (atomicParty) resolvedParty.updatedAt = Math.max(resolveStartedAt, Number(run.party.updatedAt) + 1);
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
            // The open re-plan of the party's needs: the members planned, whose plan stands
            // (unchanged, or a new plan whose commit landed: a step that carried one and did
            // not land, refused or abandoned, takes that member out, reopenReplan, so this
            // step plans it again). It opens on main's due mark (a member joined or left, the
            // objective moved: run.requirementRefresh) or on a member whose step raised its
            // build section (its kit moved, below). Every member planned, the end rides the
            // leader's commit; it holds every member at the next step when that end landed,
            // and closes there, or when the party ends.
            let requirementProgress = this.partyRequirementProgress.get(String(run.party.partyId));
            const nativeExpedition = run.party.stats?.objective?.opportunisticRaid === true;
            if (requirementProgress && run.members.every(member => requirementProgress.has(Number(member.characterId)))) {
                this.partyRequirementProgress.delete(String(run.party.partyId));
                requirementProgress = null;
            }
            if (nativeExpedition) {
                this.partyRequirementProgress.delete(String(run.party.partyId));
                requirementProgress = null;
            }
            const openRequirements = reason => {
                if (nativeExpedition || requirementProgress || meetingPending || materialHunt) return;
                requirementProgress = new Set();
                this.partyRequirementProgress.set(String(run.party.partyId), requirementProgress);
                EconomyDiagnostics.count('party_replan', 'opened', reason);
            };
            if (run.requirementRefresh) openRequirements('event');
            const Refresh = require('./PartyRequirementRefresh'), planned = new Map();
            for (const { state, result } of resolution.memberResults || []) {
                const id = Number(state.characterId);
                const projection = this.projectResolve
                    ? await this.projectResolve(state, result, startedAt, null, resolveStartedAt)
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
                if (projection?.kitMoved) openRequirements('kit');
                if (requirementProgress && !meetingPending && !materialHunt && this.planPartyRequirement && projectedState
                    && resolvedParty.status !== 'dissolved' && !requirementProgress.has(id)
                    && requirementMs + lastRequirementPlanMs < 20) {
                    const planningStarted = performance.now();
                    const selection = await this.planPartyRequirement({ state: projectedState, timestamp: startedAt,
                        economy: projection?.build });
                    lastRequirementPlanMs = performance.now() - planningStarted;
                    requirementMs += lastRequirementPlanMs;
                    // Compared with the plan the re-plan started from (the projection's). A changed
                    // plan rides the member's own commit, its one writer. A plan needing no party
                    // where the held one needed it ends the member's need of this party: the fact
                    // (partyNeedEnded: the party's id) and party_need_ended, which wakes its stay,
                    // ride the same commit.
                    const plan = selection?.acquisitionPlan, held = projectedState.stats?.equipmentPlan;
                    if (Refresh.acquisitionRequirementKey(held) !== Refresh.acquisitionRequirementKey(plan)) {
                        planned.set(id, plan);
                        // The member's step (this run's slot) carries its new plan: unlanded, the
                        // re-plan reopens at it.
                        const entry = sources.find(source => source.id === id)?.active;
                        if (entry) entry.replanCarried = true;
                        const stats = { ...projectedState.stats, equipmentPlan: plan };
                        const Stay = require('./PartyStay');
                        if (Stay.needsParty(held) && !Stay.needsParty(plan)) {
                            stats.partyNeedEnded = run.party.partyId;
                            (Situations ||= require('../Situations')).raise(stats, 'party_need_ended', null, Situations.place(projectedState), id);
                        }
                        projectedState = { ...projectedState, stats };
                        if (selection.replanContext?.failure) result.events = [...(result.events || []),
                            Refresh.acquisitionFallbackEvent(projectedState, held, selection.replanContext.failure, plan)];
                    }
                    requirementProgress.add(id);
                }
                const proposal = {
                    proposalId: stepProposalId(id, run.startedAt),
                    characterId: id,
                    priority: memoryGroup ? 'P1' : priorityForResult(state, result),
                    ...(memoryGroup ? { atomicGroup: memoryGroup } : {}),
                    ...(raid ? { raidStepId } : {}),
                    enqueuedAt: this.now(),
                    revision: memberRevision(run, id),
                    ...InventorySummary.bagChange(state.inventory, projectedState?.inventory),
                    nextState: projectedState,
                    durable: projection?.durable || null,
                    ...(projection?.market ? { market: projection.market } : {}),
                    // A member released by a dissolved party: its decision was
                    // made on its party state, so main decides on the solo one.
                    ...(projection?.economyDecision && resolvedParty.status !== 'dissolved'
                        ? { economyDecision: projection.economyDecision } : {}),
                    ...(projection?.economyPlan && resolvedParty.status !== 'dissolved'
                        ? { economyPlan: projection.economyPlan } : {}),
                    result: proposalResult({
                        ...result,
                        events: [
                            ...(result.events || []),
                            ...(resolution.events || []).filter((event) => Number(event.characterId || run.party.leaderId) === id)
                        ]
                    }),
                    options: { allowParty: true, allowLifecycle: true },
                    partyResolution: null
                };
                proposals.push(proposal);
            }
            // The re-plan ends when every member is planned or the party ends. Done, the party's
            // objective follows its members' plans, on the party row the leader's commit carries
            // with the end (requirementRefreshedAt). Each plan rides its member's own commit: one
            // that does not land (refused, abandoned) re-opens the re-plan at that member, whose
            // next plan sends the end again; an end that does not land re-opens it at the leader.
            const leader = proposals.find(proposal => proposal.characterId === Number(run.party.leaderId));
            const replanning = !!requirementProgress && !meetingPending && !materialHunt;
            const replanned = replanning && !!leader && run.members.every(member => requirementProgress.has(Number(member.characterId)));
            if (replanning && resolvedParty.status === 'dissolved') this.partyRequirementProgress.delete(String(run.party.partyId));
            const party = replanned && resolvedParty.status !== 'dissolved' ? { ...resolvedParty, stats: { ...resolvedParty.stats,
                ...Refresh.partyObjective(run.members.map(member => planned.has(Number(member.characterId))
                    ? { ...member, stats: { ...member.stats, equipmentPlan: planned.get(Number(member.characterId)) } } : member)) } }
                : resolvedParty;
            if (atomicParty) memoryGroup.partyChanges = [fencedPartyChange(run, party)];
            // What the leader's commit carries: main writes the party row from it (the row's
            // next due) and starts its members' duty trips (stayTrips).
            const leaderResolution = { partyId: run.party.partyId, party, ...(recruitCheck ? { recruitCheck } : {}),
                ...(replanned ? { requirementRefreshedAt: startedAt } : {}) };
            if (leader) leader.partyResolution = leaderResolution;
            const leaderEntry = replanned ? sources.find(source => source.id === leader.characterId)?.active : null;
            if (leaderEntry) leaderEntry.replanCarried = true;
            if (!current()) return;
            if (!proposals.length) {
                // No member result (the resolver found no spot): the whole
                // roster commits the party row, fenced on the revision this run
                // read, with the resolver's next due and a goal review. Main's
                // accepted commit publishes the row (its 'parties' event moves
                // the leader's due); a changed row refuses it.
                EconomyDiagnostics.count('party_run', 'no_result', resolution.debug?.reason);
                const waiting = run.members.map(state => ({ ...state,
                    timing: { ...(state.timing || {}), nextResolveAt: resolvedParty.nextResolveAt } }));
                const group = partyTransitionProposals(run, waiting, resolvedParty, startedAt, this.now(), null, 'party_no_result', true);
                group.find(proposal => proposal.partyResolution).partyResolution = {
                    ...leaderResolution, party: { ...party, updatedAt: group[0].atomicGroup.partyChanges[0].updatedAt } };
                proposals.push(...group);
            }
            publish(proposals);
        } catch (error) {
            if (raidStepId) require('./ColdRaidEncounter').abort(raidStepId);
            if (!current()) return;
            handled = true;
            for (const source of sources) {
                if (raidStepId && this.dirty.get(source.id)?.raidStepId === raidStepId) this.dirty.delete(source.id);
            }
            // A raid step waiting for its boss is no fault: the leader comes
            // back in a second. A throw holds the party's run off, by party
            // id: a new leader does not skip it, a member left solo is free.
            let retryAt = this.now() + 1000;
            if (error?.message !== 'raid_step_pending') {
                DiagnosticConfig.developerDiagnostics && (this.stats.errors += 1);
                retryAt = this.fault(`party:${partyId}`, error || 'party_resolver_error', 'party_project');
            }
            this.abandonSteps(run.purpose.memberIds);
            this.requeue(run.purpose.leaderId, retryAt);
        } finally {
            if (raidStepId && !published) require('./ColdRaidEncounter').abort(raidStepId);
            if (this.partyRuns.get(String(partyId)) === run) this.partyRuns.delete(String(partyId));
            if (handled) {
                const elapsed = DiagnosticConfig.developerDiagnostics ? this.now() - resolveStartedAt : 0;
                DiagnosticConfig.developerDiagnostics && (this.stats.lastResolveMs = elapsed);
                DiagnosticConfig.developerDiagnostics && (this.stats.maxResolveMs = Math.max(this.stats.maxResolveMs, elapsed));
            }
        }
    }

    async resolveStep(characterId, source = this.captureResolverSource(characterId)) {
        const active = source.active;
        if (source.id !== Number(characterId) || !this.resolverSourceCurrent(source)) return;
        const startedAt = this.now();
        let handled = false;
        try {
            // Resolved as of its due, never earlier: a step started its lead
            // early lives the same round as one started on time. The row's
            // write stamp (updatedAt) stays the real start. Whole: a due read from
            // the stats can hold a fraction, and every clock of the step comes from here.
            // Never before the bot's own clock: a step woken inside a hunt window
            // (T120) goes on from its end, it lives that time once.
            const timestamp = Math.ceil(Math.max(startedAt, active.dueAt || 0, ownClock(active.state)));
            const elapsedMs = stepElapsedMs(active.state, timestamp);
            const raidPreparing = require('./RaidSupplyPolicy').held(active.state, timestamp);
            const guide = !raidPreparing && guideRound(active.state, timestamp);
            const lifecyclePlan = !raidPreparing && !guide && this.planLifecycle
                ? await this.planLifecycle({ state: active.state, timestamp })
                : null;
            if (!this.resolverSourceCurrent(source)) return;
            const resolveState = lifecyclePlan?.plannedState || active.state;
            const spot = resolveState.activity === 'traveling' ? null : lifecyclePlan?.spot || this.spotOf(active.state);
            const roundOptions = {
                assessRelationship: this.interactionMemory.assess.bind(this.interactionMemory),
                spot,
                spotHunters: this.spotHunters(spot),
                targetNpcId: Number(lifecyclePlan?.targetNpcId || lifecyclePlan?.acquisitionPlan?.next?.npcId ||
                    (lifecyclePlan?.activityPick?.activity === 'hunting' ? lifecyclePlan.activityPick.npcId : 0) || 0)
            };
            const result = guide || occupationRound(resolveState, lifecyclePlan, timestamp, this.states.get(Number(characterId))) || await this.resolveSolo({
                ...roundOptions,
                state: resolveState,
                lastFight: lastFight(resolveState, lifecyclePlan, this.states.get(Number(characterId))),
                elapsedMs,
                rng: deterministicRandom(active.state),
                timestamp
            });
            if (!this.resolverSourceCurrent(source)) return;
            const first = { state: resolveState, result, timestamp };
            const round = this.soloWindow && ColdSoloWindow.opens(resolveState, lifecyclePlan, result, timestamp,
                startedAt + STEP_LEAD_MAX_MS) ? await this.huntWindow(source, first, lifecyclePlan, roundOptions, startedAt) : first;
            if (!round || !this.resolverSourceCurrent(source)) return;
            // The step's one decision (its economy, worker-local) travels
            // through the round: the projection asks no second one.
            const projection = this.projectResolve
                ? await this.projectResolve(round.state, round.result, round.timestamp, lifecyclePlan, startedAt, round.projected || null)
                : null;
            if (!this.resolverSourceCurrent(source)) return;
            const projectedState = projection?.state || projection;
            this.countHuntStep(first, round);
            // The cleanup trip a build decided (stats.cleanupDue, EconomyContext: its bag must go
            // to town), held until it starts: once the bot is free after the fight, over a trip
            // this step started (main starts the trip and drops the hold). No step reads the bag else.
            const cleanupDue = projectedState?.stats?.cleanupDue;
            const cleanupNeed = cleanupDue && !require('./RaidSupplyPolicy').held(active.state, timestamp)
                && PartyMarketBreak.cleanupFree(PartyMarketBreak.withoutStartedTrip(active.state, projectedState)) ? cleanupDue : null;
            const priority = playerWaitingTransition(active.state, null, this) ? 'P0'
                : projection?.durable ? 'P1' : priorityForResult(active.state, round.loot || round.result);
            // The step's spot grievances (SpotContest) ride its own commit, the only memory events a solo step adds.
            const grievances = projection?.memoryEvents || [];
            const proposal = {
                proposalId: stepProposalId(characterId, active.startedAt),
                characterId: Number(characterId),
                priority,
                enqueuedAt: this.now(),
                revision: Number(active.state.simulation?.revision || 0),
                ...InventorySummary.bagChange(resolveState.inventory, projectedState?.inventory),
                nextState: projectedState,
                durable: projection?.durable || null,
                ...(projection?.market ? { market: projection.market } : {}),
                ...(projection?.economyDecision ? { economyDecision: projection.economyDecision } : {}),
                ...(projection?.economyPlan ? { economyPlan: projection.economyPlan } : {}),
                ...(projection?.buffOffer ? { buffOffer: projection.buffOffer } : {}),
                ...(cleanupNeed ? { cleanupNeed } : {}),
                result: proposalResult({ ...round.result, ...round.posted, ...(grievances.length
                    ? { memoryEvents: [...(round.result.memoryEvents || []), ...grievances] } : {}) }),
                options: { allowLifecycle: true, allowParty: !!active.state.stats?.tradeMeeting }
            };
            handled = true;
            active.stepWakeSeq = Number(lifecyclePlan?.stepWakeSeq) || 0;
            active.grievances = grievances.length;
            this.dirty.set(Number(characterId), proposal);
            DiagnosticConfig.developerDiagnostics && (this.stats.resolved += 1);
            if (priority !== 'P2' || this.dirty.size >= this.maxBatch) {
                this.flush(priority, false, { reason: priority !== 'P2' ? 'priority' : 'batch' });
            }
        } catch (error) {
            if (!this.resolverSourceCurrent(source)) return;
            handled = true;
            DiagnosticConfig.developerDiagnostics && (this.stats.errors += 1);
            // Held off by its faults in a row (schedule reads the hold).
            this.fault(characterId, error || 'resolver_error', 'solo_project');
            this.abandonSteps([characterId]);
            this.requeueAtDue(characterId);
        } finally {
            if (handled) {
                const elapsed = DiagnosticConfig.developerDiagnostics ? this.now() - startedAt : 0;
                DiagnosticConfig.developerDiagnostics && (this.stats.lastResolveMs = elapsed);
                DiagnosticConfig.developerDiagnostics && (this.stats.maxResolveMs = Math.max(this.stats.maxResolveMs, elapsed));
            }
        }
    }

    // T120: the hunt runs on from the step's first round, its rounds as its steps
    // would run them (their due, their seed), each projected on the last, until
    // one ends the window (ColdSoloWindow.endOf). Each round is a turn of its
    // own. Returns the last round: its base state for the step's full projection,
    // its timestamp, ended, and the window's sums (the bag's loot for the
    // priority, the events and debug main reads); null when the step went stale.
    async huntWindow(source, first, plan, roundOptions, writtenAt) {
        const { projectRound } = this.soloWindow;
        const readers = this.windowReaders(plan);
        const events = [], soulCrystals = [], items = [];
        let round = first, rounds = 1, debug = {};
        const add = result => {
            events.push(...result.events || []);
            soulCrystals.push(...result.soulCrystals || []);
            if (!items.length) items.push(...(result.materialize?.items || []).filter(item => Number(item.selfId) !== 57));
            debug = ColdSoloWindow.sumDebug(debug, result.debug);
        };
        add(first.result);
        for (;;) {
            // huntedThrough (ColdSoloWindow): the round's start, the end of the credited hunt
            // when it is the last; a round's own clock (lastResolvedAt) is the same.
            const stamped = { ...round.result, patch: { ...round.result.patch,
                stats: { ...round.result.patch?.stats, huntedThrough: round.timestamp } } };
            const after = await projectRound(round.state, stamped, round.timestamp, plan, writtenAt);
            if (!this.resolverSourceCurrent(source)) return null;
            // Three guards bound the loop whatever endOf decides: a round cap, the
            // look-ahead (the next round due past the step's clock + WINDOW_LEAD_MS:
            // huntedThrough stays inside it) and a round that does not move the
            // clock (counted in windowEnd).
            const ended = ColdSoloWindow.endOf(round.state, after, round.result, readers)
                || (rounds >= MAX_WINDOW_ROUNDS ? 'round_cap' : '')
                || (Math.ceil(Number(after.timing?.nextResolveAt)) >= first.timestamp + WINDOW_LEAD_MS ? 'lead' : '')
                || (Math.ceil(Number(after.timing?.nextResolveAt)) > round.timestamp ? '' : 'stalled');
            if (ended) {
                // projected: the last round's projection, the step's own (its situations raised
                // once): the step's projection goes on from it, it does not project the round again.
                const result = { ...stamped, ...(soulCrystals.length ? { soulCrystals } : {}) };
                return { ...round, result, projected: after, ended, rounds, loot: { ...result, materialize: { items } }, posted: { events, debug } };
            }
            await nextTurn();
            if (!this.resolverSourceCurrent(source)) return null;
            const timestamp = Math.ceil(Number(after.timing.nextResolveAt));
            const result = await this.resolveSolo({ ...roundOptions, state: after, elapsedMs: stepElapsedMs(after, timestamp),
                rng: deterministicRandom(after), timestamp });
            if (!this.resolverSourceCurrent(source)) return null;
            add(result);
            round = { state: after, result, timestamp };
            rounds += 1;
        }
    }

    // The health line's count of a solo hunting step: rounds and hunt time over
    // its window, what ended it (none when no window opened).
    countHuntStep(first, round) {
        const stats = this.soloWindowStats;
        if (!ColdSoloWindow.huntingRound(first.result) || first.state.party?.partyId || first.state.partyId) return;
        stats.steps += 1;
        stats.rounds += round.rounds || 1;
        stats.huntMs += Math.max(0, Number(round.result.nextResolveAt) - first.timestamp);
        if (round.ended) stats.ended[round.ended] = (stats.ended[round.ended] || 0) + 1;
    }

    windowReaders(plan) {
        return { ...this.soloWindow.readers(plan), kind: after => lifecycleKind(after, this) };
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
        // Each sent proposal's own next state (a transport copy may carry a delta
        // instead): the in-flight record keeps it for a numbers-only commit ack.
        const proposed = new Map();
        for (const proposal of eligible) {
            if (visited.has(proposal.characterId)) continue;
            const group = proposal.atomicGroup?.id
                ? eligible.filter(entry => entry.atomicGroup?.id === proposal.atomicGroup.id) : [proposal];
            if (proposals.length + group.length > limit) break;
            group.forEach(entry => { visited.add(entry.characterId); proposed.set(Number(entry.characterId), entry.nextState); });
            let transportGroup = group;
            let transportSizes = proposalSizes(group);
            if (DiagnosticConfig.developerDiagnostics === true && groupPayloadBytes(transportSizes) > PROPOSAL_PAYLOAD_LIMIT_BYTES) {
                group.forEach(entry => require('../Economy/ConsumptionDiagnostics').drop(entry));
                transportSizes = proposalSizes(group);
            }
            if (groupPayloadBytes(transportSizes) > PROPOSAL_PAYLOAD_LIMIT_BYTES) {
                DiagnosticConfig.developerDiagnostics && (this.stats.proposalOversize += group.length);
                transportGroup = group.map(entry => {
                    const base = this.inFlight.get(Number(entry.characterId))?.state;
                    if (!base || !entry.nextState) return entry;
                    const { nextState, ...transport } = entry;
                    return { ...transport, nextStateDelta: ColdStateDelta.create(base, nextState) };
                });
                transportSizes = proposalSizes(transportGroup);
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
            DiagnosticConfig.developerDiagnostics && (this.stats.proposalOversizeRejected += 1);
            this.abandonSteps([proposal.characterId]);
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
        for (const proposal of proposals) {
            const active = this.inFlight.get(Number(proposal.characterId));
            if (active && stepProposalId(proposal.characterId, active.startedAt) === proposal.proposalId) {
                active.pendingCommitId = proposal.proposalId;
                active.pendingRaidStepId = proposal.raidStepId;
                // The inputs of the review the commit ack may name (onCommitAck).
                active.economyPlan = proposal.economyPlan;
                active.buffOffer = proposal.buffOffer;
                // What main commits unless it changes it: an ok ack with numbers
                // only rebuilds main's cached state from it (Protocol.committedState).
                active.proposed = proposed.get(Number(proposal.characterId));
            }
        }
        // Sent proposals keep their in-flight slots until the commit ACK. With
        // the window full and every step in it sent (a command waits on main
        // too), nothing more comes before an ack: main commits what it holds at
        // once. A party waiting for slots asks the same.
        const capacityBlocked = this.partyCapacityBlocked === true
            || this.inFlight.size + this.commanding.size >= this.maxInFlight && this.everyStepSent();
        // Each proposal's measured size travels with it, so the main commit
        // queue need not serialise it again (the list fits the 16 KiB left
        // between the payload limit and the message limit).
        // The payload's JSON size follows from the sizes already counted:
        // { proposals } and { proposalBytes, capacityBlocked } joined by a
        // comma, less the brace each drops. send() need not serialise it again.
        const tail = { proposalBytes, capacityBlocked };
        const payloadBytes = proposalPayloadBytes(proposals.length, itemBytes) + Protocol.byteLength(tail) - 1;
        if (this.emit('proposal_batch', { proposals, ...tail }, null, payloadBytes) === false) {
            // Never sent: no ack comes, the stall recovery frees these steps.
            for (const proposal of proposals) {
                const active = this.inFlight.get(Number(proposal.characterId));
                if (active?.pendingCommitId === proposal.proposalId) active.pendingCommitId = null;
            }
        }
        return proposals.length;
    }

    // No step in the window is still running or unsent (at most maxInFlight entries).
    everyStepSent() {
        for (const active of this.inFlight.values()) if (!active.pendingCommitId) return false;
        return true;
    }

    flushDue() {
        const now = this.now();
        const oldest = Math.min(...[...this.dirty.values()].map((proposal) => Number(proposal.enqueuedAt || now)), now);
        if (!this.dirty.size) return 0;
        const ageMs = now - oldest;
        const capacity = this.maxInFlight - this.inFlight.size - this.commanding.size;
        if (capacity <= 0 || this.partyCapacityBlocked) {
            // A player-aware ownership window can be smaller than maxBatch.
            // Do not wait for an unreachable batch threshold while completed
            // proposals occupy every slot; the main commit queue still
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

    onCommitAck(payload = {}) {
        const accepted = [], requeued = [], reviews = [], sampledParties = new Set();
        if (this.stopping) return accepted;
        (payload.results || []).forEach((result) => {
            const identity = Protocol.commitAckIdentity(result);
            if (!identity) return;
            const id = identity.characterId;
            const active = this.inFlight.get(id);
            if (active?.pendingCommitId !== identity.proposalId) {
                DiagnosticConfig.developerDiagnostics && (this.stats.lateAcks += 1);
                return;
            }
            if (this.states.get(id)?.state.phase !== 'cold') return;
            if (active.pendingRaidStepId) require('./ColdRaidEncounter').acknowledge(active.pendingRaidStepId, id, result.ok);
            this.inFlight.delete(id);
            // Its decisions are recorded once, by the step main committed: a refused one re-runs on the moved row.
            Trace.settle(id, result.ok);
            // A committed step ends the bot's (its party run's) faults in a row.
            if (result.ok) {
                this.noteStepLate(active.dueAt);
                this.clearFault(id);
                if (active.partyId) this.clearFault(`party:${active.partyId}`);
                // Its grievances are written: counted once.
                for (let i = 0; i < (active.grievances || 0); i++) (Situations ||= require('../Situations')).note('spot:contest:grievance');
            }
            // A committed step's start -> ack time sets the lead, excluding
            // main's wait for its future events: that wait is the lead's own
            // output, not work. A party's shared start and wait are one sample.
            if (result.ok && !(active.partyId && sampledParties.has(active.partyId))) {
                if (active.partyId) sampledParties.add(active.partyId);
                const elapsedMs = Math.max(0, this.now() - active.startedAt);
                const eventWaitMs = Number.isFinite(result.eventWaitMs)
                    && result.eventWaitMs >= 0 && result.eventWaitMs <= elapsedMs ? result.eventWaitMs : 0;
                this.measureStepLead(elapsedMs - eventWaitMs);
            }
            // An ok ack without the state carries the commit's numbers: main's
            // cache is the proposal's state with them.
            const committed = result.ok ? result.state || Protocol.committedState(active.proposed, result) : null;
            if (committed) {
                this.stepWakeAnswered(this.states.get(id), active.stepWakeSeq);
                // Without result.state main changed nothing: the held state is
                // the step's own output, not news for its economy (ownOutput).
                this.upsert({ state: committed, ownOutput: result.state ? null : 'commit' });
                // The commit's slot is free and the kernel holds main's committed
                // state: the review main named takes the bot before any step does.
                const review = this.beginReview(id, result.review, active);
                if (review) reviews.push(review);
            } else if (result.ok) {
                // Committed, but the held state is the step's base: the bot waits
                // for its due and its next step, refused as stale, hands back the row.
                this.ackUnbuilt += 1;
                requeued.push(id);
            } else {
                // A re-plan it carried did not land: the party's open re-plan plans it again.
                this.reopenReplan(active, id, 'refused');
                // No review runs the plan this step stamped as sent.
                if (active?.economyPlan) this.forgetSentPlan(id);
                this.stepsRefused += 1;
                if (DiagnosticConfig.developerDiagnostics && Protocol.staleRefusal(result)) this.stats.stale += 1;
                EconomyDiagnostics.count('commit_ack', 'refused', result.detail || result.reason);
                if (this.tracedBots.has(id)) console.info('ColdWorker :: overdue refusal %s', JSON.stringify({ id, reason: result.reason, detail: result.detail,
                    stage: result.stage, revision: result.revision, proposed: active?.proposed?.simulation?.revision, stateRevision: result.state?.simulation?.revision,
                    activity: active?.proposed?.activity, proposedDue: active?.proposed?.timing?.nextResolveAt, keys: Object.keys(result).slice(0, 12) }));
                if (result.state) this.upsert({
                    state: {
                        ...result.state,
                        timing: {
                            ...(result.state.timing || {}),
                            nextResolveAt: Math.max(this.now() + 1000, Number(result.state.timing?.nextResolveAt || 0))
                        }
                    }
                });
                requeued.push(id);
            }
            accepted.push(result);
        });
        // After the whole ACK: a follower's state in it moves its leader to the
        // party row's due, which an unchanged row has in the past.
        requeued.forEach(id => this.requeueAtDue(id));
        if (reviews.length && this.emit('command_request', { requests: reviews.map(review => review.request) }) === false) {
            for (const { request, attempt } of reviews) {
                if (!this.cancelCommand(request.characterId, attempt)) continue;
                this.reviewsSkipped += 1;
                if (attempt.economyPlan) this.forgetSentPlan(request.characterId);
                this.ensureScheduled(request.characterId);
            }
        }
        return accepted;
    }

    // A committed step's lateness: this ack's time past its due (none for a step with no due).
    noteStepLate(dueAt) {
        if (!Number.isFinite(dueAt) || dueAt <= 0) return;
        const lateMs = Math.max(0, this.now() - dueAt);
        this.stepLate[StepLateness.bucketOf(lateMs)] += 1;
        this.stepLateMaxMs = Math.max(this.stepLateMaxMs, lateMs);
    }

    // The longest lateness since the last call (the worker's heartbeat).
    takeStepLateMax() {
        const maxMs = this.stepLateMaxMs;
        this.stepLateMaxMs = 0;
        return maxMs;
    }

    // One-sided average of start -> commit ack, excluding event waits (STEP_LEAD_*).
    measureStepLead(sampleMs) {
        if (!Number.isFinite(sampleMs)) return;
        const rate = sampleMs > this.stepLeadMs ? STEP_LEAD_RISE : STEP_LEAD_FALL;
        this.stepLeadMs = Math.max(0, Math.min(STEP_LEAD_MAX_MS, this.stepLeadMs + (sampleMs - this.stepLeadMs) * rate));
    }

    // The plan the step stamped as sent (ColdSimulationWorker economyPlanHash)
    // that no review ran: a refresh reproducing it sends it again instead of
    // dropping it as already sent. economyPending stays: the bot's next state
    // still asks for that refresh.
    forgetSentPlan(characterId) {
        const record = this.states.get(Number(characterId));
        if (record) record.economyPlanHash = null;
    }

    // A `review` command for the steps main named on the commit ack (Protocol
    // REVIEW_STEPS), with the plan and offer this thread kept from the proposal.
    // No state on the wire: main runs the steps on its own cache.
    beginReview(characterId, named, active) {
        const steps = new Set(Array.isArray(named) ? named.filter(step => Protocol.REVIEW_STEPS.includes(step)) : []);
        const economyPlan = steps.has('plan') ? active.economyPlan : undefined;
        const buffOffer = steps.has('buff') ? active.buffOffer : undefined;
        // A plan main did not name (a forced cleanup replaced it) runs nowhere.
        if (active.economyPlan && !economyPlan) this.forgetSentPlan(characterId);
        if (!economyPlan && !buffOffer && !steps.has('training')) return null;
        const attempt = this.beginCommand(characterId, 'review');
        if (!attempt) {
            this.reviewsSkipped += 1;
            if (economyPlan) this.forgetSentPlan(characterId);
            return null;
        }
        attempt.sent = true;
        attempt.economyPlan = !!economyPlan;
        return { attempt, request: { characterId, kind: 'review', commandId: attempt.commandId,
            commandCheckpoint: attempt.checkpoint,
            ...(economyPlan ? { economyPlan } : {}), ...(buffOffer ? { buffOffer } : {}),
            ...(steps.has('training') ? { training: true } : {}) } };
    }

    completeCommand(payload = {}) {
        if (payload.kind === 'meeting') return this.completeMeetingPage(payload);
        const identity = Protocol.commandIdentity(payload);
        if (!identity || typeof payload.ok !== 'boolean' || this.stopping) return false;
        const id = identity.characterId, attempt = this.commandStartedAt.get(id), current = this.states.get(id);
        if (!attempt?.sent || !this.commanding.has(id) || current?.state.phase !== 'cold'
            || attempt.commandId !== identity.commandId
            || !Protocol.sameCommandCheckpoint(attempt.checkpoint, identity.checkpoint)) return false;
        Trace.settle(id, payload.ok);
        this.cancelCommand(id, attempt);
        // A command answered that it waits on its bot's trade preparation (main holds its
        // step until the end): the card it carried stays the answer until the end, which
        // republishes the bot's row (Coordinator.preparationEnded) and schedules it.
        const waiting = payload.ok && payload.waiting === true, ride = current.cardCommit;
        if (ride?.id === attempt.commandId) current.cardCommit = waiting ? { ...ride, waiting: true } : null;
        // A refused review did not run its plan; main asks for a refresh.
        if (attempt.kind === 'review' && payload.ok === false && attempt.economyPlan) this.forgetSentPlan(id);
        // A command that threw on main (payload.fault, its stack) is held off as
        // a throw here is (fault); before the upsert, so its schedule keeps the hold.
        if (payload.ok) this.clearFault(id);
        if (payload.ok) this.stepWakeAnswered(current, attempt.stepWakeSeq);
        const retryAt = payload.fault && payload.ok === false
            ? this.fault(id, { message: payload.reason, stack: payload.fault.stack }, 'main_command')
            : this.now() + Math.max(1000, Number(payload.retryAfterMs) || 5000);
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
            // An ok review of the plan sent ran this step's own plan: its state is
            // own output too. A refused one is an input (main asks a refresh).
            this.upsert({ state: output,
                ownOutput: attempt.kind === 'review' && attempt.economyPlan && payload.ok !== false ? 'review' : null });
            // Rejected commands often return the unchanged overdue state. Do
            // not let that timestamp immediately re-enter the head of the queue.
            if (waiting) this.unschedule(id);
            else if ((payload.ok === false || Number(payload.retryAfterMs) > 0) && this.scheduleTokens.has(id)) {
                this.requeue(id, Math.max(this.scheduleTokens.get(id).dueAt, retryAt));
            }
        } else if (!waiting) this.requeue(id, retryAt);
        return true;
    }

    // A bot held off the heap until a row of main's schedules it again (upsert:
    // ensureScheduled); its record and version stay.
    unschedule(characterId) {
        const id = Number(characterId);
        this.heap.remove(this.scheduleTokens.get(id)?.heapEntry);
        this.scheduleTokens.delete(id);
    }

    // A step or command of this bot (key: its id) or a party run (`party:<id>`)
    // threw (here or, sent back in its command ack, on main): when it may try
    // again (BotFaultHold). Faults in a row count whatever their message (a message
    // with an id in it must not reset the backoff); only a success clears them
    // (clearFault). Returns the hold's end.
    fault(key, error, stage) {
        const party = String(key).startsWith('party:');
        const id = party ? String(key) : Number(key), message = String(error?.message || error || stage);
        const who = party ? { partyId: id.slice(6) } : { characterId: id };
        let entry = this.faults.get(id);
        if (!entry) this.faults.set(id, entry = { count: 0, holdUntil: 0, logged: [] });
        this.failures.workerFaults += 1;
        this.failures.faultsByStage[stage] = (this.failures.faultsByStage[stage] || 0) + 1;
        FaultHold.fault(entry, this.now());
        if (!entry.logged.includes(message) && entry.logged.length < FAULT_LOGGED_MESSAGES) {
            entry.logged.push(message);
            this.emit('fault', { reason: message, stage, ...who,
                stack: String(error?.stack || '').split('\n').slice(0, 10).join('\n').slice(0, 2000) || null });
        }
        if (entry.count === FaultHold.QUARANTINE_AFTER) {
            this.emit('fault', { reason: message, stage, ...who, quarantined: true,
                faults: entry.count, holdMs: FaultHold.QUARANTINE_MS });
        }
        return entry.holdUntil;
    }

    faultCounts() {
        let faultBackoff = 0, faultQuarantined = 0;
        for (const entry of this.faults.values()) {
            if (FaultHold.quarantined(entry)) faultQuarantined += 1;
            else faultBackoff += 1;
        }
        return { faultBackoff, faultQuarantined };
    }

    clearFault(key) {
        if (this.faults.size) this.faults.delete(String(key).startsWith('party:') ? String(key) : Number(key));
    }

    // At the kept copy's own due (a leader's: its party row's), never sooner
    // than a second.
    requeueAtDue(characterId) {
        const current = this.states.get(Number(characterId));
        if (current) this.requeue(characterId, Math.max(this.now() + 1000, this.dueAt(current.state)));
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
        this.remove(id);
        return { characterId: id, proposal };
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
        // A board wake no step committed is lost with this worker (a restart re-plans).
        for (const record of this.states.values()) if (record.stepWake) (Situations ||= require('../Situations')).note('step:wake:lost');
        this.commanding.clear();
        this.commandStartedAt.clear();
        await this.resolveChain.catch(() => null);
        this.flush(null, true);
        return this.heartbeatSnapshot();
    }

    heartbeatSnapshot(forSizing = false) {
        const now = this.now(), head = this.heap.peek(), swallowed = isMainThread ? null : FailureLog.snapshot();
        const scheduled = head ? this.scheduleTokens.get(Number(head.characterId)) : null;
        const current = !!head && this.validHeapEntry(head) && scheduled?.version === head.version && scheduled.heapEntry === head;
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
                kind: !head ? 'empty' : 'normal',
                dueAt,
                overdue: !!head && dueAt <= now,
                ageMs: head ? Math.max(0, now - dueAt) : 0,
                current
            },
            inFlight: this.inFlight.size,
            // The oldest step's age (inFlight is in start order), its commit wait included.
            inFlightAgeMs: this.inFlight.size ? Math.max(0, now - this.inFlight.values().next().value.startedAt) : 0,
            dirty: this.dirty.size,
            dirtyAgeMs: this.dirty.size ? Math.max(0, now - oldestDirtyAt) : 0,
            commanding: this.commanding.size,
            commandingAgeMs: this.commanding.size ? Math.max(0, now - oldestCommandAt) : 0,
            // The oldest step and command by id: a bot long past its due names
            // what holds it (Coordinator.overdueReason); both are in start order.
            heldStep: this.heldEntry(this.inFlight, now, active => (active.pendingCommitId ? 'sent' : 'unsent')),
            heldCommand: this.heldEntry(this.commandStartedAt, now, attempt => `${attempt.kind}${attempt.sent ? ':sent' : ''}`),
            reviewsSkipped: this.reviewsSkipped,
            checkpointsRefused: this.checkpointsRefused,
            stepsRefused: this.stepsRefused,
            ackUnbuilt: this.ackUnbuilt,
            // Bot faults (BotFaultHold): all of them by stage, and the failing bots
            // held off by a backoff / quarantined. swallowed: the failures the worker survived
            // (FailureLog { site: count }, absent while none); a kernel run on main has none of its own.
            failures: { ...this.failures, faultsByStage: { ...this.failures.faultsByStage }, ...this.faultCounts(),
                ...(swallowed ? { swallowed } : {}) },
            stepLeadMs: Math.round(this.stepLeadMs),
            stepLate: this.stepLate.slice(),
            soloWindow: this.soloWindowStats,
            nodeCapBuilds: invoke('GameServer/Bot/Economy/WishProviders').nodeCapBuildCount(), // lazy: the kernel's boot order
            asksPastDepth: invoke('GameServer/Bot/Economy/OfferQuery').pastDepthCount(), // lazy: the kernel's boot order
            sourceShotFlips: invoke('GameServer/Bot/AI/GearAcquisitionPlanner').sourceShotFlipCount(), // lazy: the kernel's boot order
            quietGearBuilds: invoke('GameServer/Bot/Economy/EconomyContext').quietGearBuildCount(), // lazy: the kernel's boot order
            buildDoors: invoke('GameServer/Bot/Economy/EconomyContext').buildDoors(), // lazy: the kernel's boot order
            // lazy: the kernel's boot order. search: the earning spot's searches and their ms (diagnostics off too).
            situations: { ...invoke('GameServer/Bot/Situations').counts(), search: invoke('GameServer/Bot/Economy/EquipmentIncomeRoute').searchTotals() },
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
            isSchedulableKind(lifecycleKind(entry.state, this))
            && this.dueAt(entry.state, now) <= now
        ));
        const oldestDueAt = due.reduce((oldest, entry) => (
            Math.min(oldest, this.dueAt(entry.state, now))
        ), now);
        const dueFences = due.reduce((counts, entry) => {
            const id = Number(entry.state.characterId);
            if (this.inFlight.has(id)) counts.inFlight += 1;
            else if (this.commanding.has(id)) counts.commanding += 1;
            else if (this.scheduleTokens.has(id)) counts.scheduled += 1;
            else counts.orphaned += 1;
            return counts;
        }, { scheduled: 0, inFlight: 0, commanding: 0, orphaned: 0 });
        return {
            ...this.heartbeatSnapshot(),
            due: due.length,
            dueAgeMs: due.length ? Math.max(0, now - oldestDueAt) : 0,
            dueFences
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
