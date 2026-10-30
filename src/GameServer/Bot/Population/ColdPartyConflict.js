const Validation = require('./ColdCompetitionValidation');
const InventorySummary = require('./InventorySummary');
const Episode = require('./ColdCompetitionEpisode');
const EncounterBudget = require('./PvpEncounterBudget');
const Journal = require('../../../PvpJournal');
const BotErrands = require('./BotErrands');
// Main-process execution of one bounded encounter (at most two C4 parties).
// Membership alone never makes a bot an aggressor or creates a memory edge.
const { seeded } = require('../AI/TendencyRoll');
const partyIdOf = state => state?.party?.partyId || state?.partyId || null;

const { reaction, select } = require('../../Social/ConflictParticipationPolicy');
const RevengePolicy = require('../../Social/RevengePolicy');
const ColdRevengeMonitor = require('./ColdRevengeMonitor');
const ColdPvpResolver = require('./ColdPvpResolver');
const RelationshipContext = require('../../Social/RelationshipContext');
const CombatHelpPolicy = require('../../Social/CombatHelpPolicy');
const ClanSocialEvidence = require('../../Clan/ClanSocialEvidence');

async function apply({ event, life, owner, memory, parties, personaFor, participantAllowed,
    contestContextAllowed, onState, now, waitMs, cooldownMs, disputeCooldownMs = cooldownMs, pvpEnabled = () => false,
    incrementalPvp = false, resume = null, onEncounter = () => {}, rng = seeded(event.key) }) {
    if (!parties) return { ok: false, reason: 'party_conflicts_unavailable' };
    const timestamp = now();
    const war = (resume?.reason || event.action) === 'clan_war';
    const revenge = war || (resume?.reason || event.action) === 'revenge';
    const sides = [];
    for (const participant of [event.actor, event.peer]) {
        const principal = life.cachedState(participant.id);
        const validation = { resume, revenge, at: timestamp, memory, participantAllowed, contestContextAllowed };
        const principalFailure = Validation.principal(principal, participant, memory);
        if (principalFailure) return principalFailure;
        const party = participant.partyId ? parties.find(participant.partyId) : null;
        const partyFailure = Validation.party(party, participant, event, { ...validation,
            leader: party ? life.cachedState(party.leaderId) : null });
        if (partyFailure) return partyFailure;
        const memberIds = party ? party.memberIds : [participant.id];
        const members = memberIds.map(id => life.cachedState(id));
        for (let i = 0; i < members.length; i++) {
            const failure = Validation.member(members[i], memberIds[i], participant, event, { ...validation, party });
            if (failure) return failure;
        }
        if (!resume && (Number(party?.stats?.coldCompetition?.conflictUntil || 0) > timestamp
            || members.some(s => Number(s.stats?.coldCompetition?.conflictUntil || 0) > timestamp))) return { ok: false, reason: 'conflict_cooldown' };
        sides.push({ principal, party, members });
    }
    const states = sides.flatMap(side => side.members);
    if (new Set(states.map(s => s.characterId)).size !== states.length || states.length > 18) return { ok: false, reason: 'overlapping_sides' };
    const nearby = (a, b) => Math.hypot(a.loc.locX - b.loc.locX, a.loc.locY - b.loc.locY) <= 1800
        && Math.abs(a.loc.locZ - b.loc.locZ) <= 500;
    const revengeAllowed = () => {
        if (war) return memory.assess({ id: sides[0].principal.characterId }, { id: sides[1].principal.characterId }, {}, timestamp).war?.mutual === true;
        if (!revenge || resume) return true;
        const [a, b] = sides.map(s => s.principal);
        const identity = s => ({ id: s.characterId, clanId: Number(s.stats?.clanId || 0), partyId: partyIdOf(s) });
        const social = RevengePolicy.evaluate(memory.assess(identity(a), identity(b), {}, now()), personaFor(a));
        return Number.isFinite(event.revengeRoll) && event.revengeRoll >= 0 && event.revengeRoll < social.chance
            && states.every(s => ColdRevengeMonitor.available(s, now()))
            && ColdRevengeMonitor.nearby(a, b)
            && sides.every(side => side.members.every(s => nearby(s, side.principal)));
    };
    if (!revengeAllowed()) return { ok: false, reason: 'revenge_no_longer_wanted' };
    if (resume && (!ColdPvpResolver.allowed(sides, war) || (resume.materialized
        && (!nearby(sides[0].principal, sides[1].principal) || sides.some(side => side.members.some(s => !nearby(s, side.principal))))))) {
        return { ok: false, reason: 'encounter_separated_or_protected' };
    }
    const { roles, deescalated } = resume ? { roles: new Map(resume.roles), deescalated: false }
        : war ? { roles: new Map(sides.flatMap((side, i) => side.members.map(s => [s.characterId,
            s.characterId === side.principal.characterId ? i === 0 ? 'initiator' : 'target'
                : memory.assess({ id: s.characterId }, { id: sides[1 - i].principal.characterId }, {}, timestamp).war?.mutual ? 'support' : 'stand_aside']))), deescalated: false }
            : select(sides, memory, personaFor, rng, timestamp);
    const step = incrementalPvp ? { resuming: !!resume, seen: resume?.seen || [],
        until: timestamp, expiresAt: resume?.expiresAt || timestamp + EncounterBudget.INITIAL_MS,
        maxActions: Math.max(0, EncounterBudget.MAX_ACTIONS - (resume?.actions || 0)) } : null;
    const opener = revenge ? 0 : 1;
    // Each side's can-I-win was rolled once at the dispute and travels on the
    // event (U26) for who gives way; the PvP start has its own gate.
    const willing = event.willing || [];
    const combatAt = resume ? Math.max(resume.stepAt, timestamp - 1000) : timestamp;
    const pvp = !deescalated && event.pvpIntent === true && pvpEnabled()
        ? ColdPvpResolver.resolve({ sides, roles, timestamp: combatAt,
            rng, personaFor, step, openingSide: opener, key: event.key, wars: memory.clanWars, war }) : null;
    // A refused revenge forecast cannot displace hunters or fabricate a resource offense.
    if (revenge && !pvp?.started) return { ok: false, reason: deescalated ? 'revenge_deescalated' : pvp?.reason || 'pvp_disabled' };
    const involved = side => side.members.filter(s => s.characterId === side.principal.characterId || roles.get(s.characterId) === 'support');
    // Who gives way without a fight, by the same willingness: one side willing
    // and the other not, the willing side pushes with the author's bound 0.9 (or
    // 0.1); both or neither willing: the author's even coin flip.
    const pushChance = !!willing[0] === !!willing[1] ? 0.5 : willing[0] ? 0.9 : 0.1;
    const displaced = !deescalated && rng() < (pvp?.started ? 0.5 : pushChance);
    const losingIndex = pvp?.started ? pvp.losingSide : displaced ? 1 : 0;
    const outcome = pvp?.started ? `pvp_${pvp.outcome}` : deescalated ? 'deescalated' : displaced ? 'displaced' : 'held_ground';
    const encounter = pvp?.ongoing ? EncounterBudget.extend({ key: event.key, startedAt: resume?.startedAt || timestamp,
        expiresAt: step.expiresAt, stepAt: timestamp, sequence: (resume?.sequence || 0) + 1,
        actions: (resume?.actions || 0) + pvp.actions,
        extensions: Number(resume?.extensions || 0),
        materialized: resume?.materialized === true,
        ...(revenge ? { reason: war ? 'clan_war' : 'revenge' } : {}),
        spotId: event.spotId, npcId: event.npcId,
        sides: sides.map(s => ({ principalId: s.principal.characterId, memberIds: s.members.map(m => m.characterId), partyId: s.party?.partyId || null })),
        roles: [...roles], seen: [...(resume?.seen || [])], willing }, pvp, timestamp) : null;
    const episode = { key: event.key, at: resume?.startedAt || timestamp, action: revenge ? 'revenge' : 'contest', npcId: event.npcId,
        conflictUntil: (resume?.startedAt || timestamp) + (pvp?.started ? cooldownMs : disputeCooldownMs), outcome };
    const wait = { start: timestamp, until: encounter ? timestamp + EncounterBudget.STEP_MS : pvp?.started ? Math.max(timestamp, pvp.until) : timestamp + waitMs,
        ...(pvp?.started ? { combat: true } : {}) };
    const preparedParties = sides.map((side, index) => {
        if (!side.party) return null;
        const delayed = pvp?.started || !deescalated && index === losingIndex;
        const prepared = parties.prepareCommit({ ...side.party,
            nextResolveAt: delayed ? (pvp?.started ? Math.max(wait.until, Number(side.party.nextResolveAt || 0))
                : Math.max(timestamp, Number(side.party.nextResolveAt || 0)) + waitMs) : side.party.nextResolveAt,
            stats: { ...side.party.stats, coldCompetition: Episode.begin(side.party.stats?.coldCompetition, { ...episode, peerId: sides[1 - index].principal.characterId,
                ...(delayed ? { wait } : {}) }) } });
        prepared.row.updatedAt = Math.max(prepared.row.updatedAt, side.party.updatedAt + 1);
        return prepared;
    });
    const next = sides.flatMap((side, index) => side.members.map(state => {
        const delayed = pvp?.started || !deescalated && index === losingIndex;
        const result = pvp?.updates?.get(state.characterId) || state;
        return { ...result, stats: { ...result.stats,
            ...(war && pvp?.started && BotErrands.staleWarMarketReturn(state, side.party) ? { marketReturn: null } : {}),
            ...(revenge && !war ? { revengeUntil: Math.max(Number(state.stats?.revengeUntil || 0), (resume?.startedAt || timestamp) + RevengePolicy.RETRY_MS) } : {}),
            ...(incrementalPvp ? { pvpEncounter: encounter } : {}), coldCompetition: Episode.begin(state.stats?.coldCompetition, { ...episode,
            peerId: sides[1 - index].principal.characterId, role: roles.get(state.characterId),
            ...(delayed ? { wait } : {}) }) }, timing: delayed ? { ...state.timing,
                ...(pvp?.started ? { lastResolvedAt: timestamp } : {}),
                nextResolveAt: preparedParties[index]?.row.nextResolveAt
                    || (pvp?.started ? Math.max(wait.until, Number(state.timing?.nextResolveAt || 0))
                        : Math.max(timestamp, Number(state.timing?.nextResolveAt || 0)) + waitMs) } : state.timing };
    }));
    // Linear attribution: the direct target remembers actual aggressors;
    // defending supporters remember the initiator. Bystanders get no offense.
    const events = [];
    if (!deescalated && !resume && !revenge) {
        const add = (sourceId, targetId) => events.push({ key: `${event.key}:${sourceId}:${targetId}`, sourceId, targetId,
            kind: 'character', type: 'mob_contested', at: timestamp });
        involved(sides[0]).forEach(s => add(sides[1].principal.characterId, s.characterId));
        involved(sides[1]).filter(s => s.characterId !== sides[1].principal.characterId)
            .forEach(s => add(s.characterId, sides[0].principal.characterId));
    }
    if (pvp?.started) for (const incident of pvp.incidents) {
        const { sourceId, targetId } = incident;
        for (const type of incident.killed ? ['attacked', 'killed'] : ['attacked']) {
            const incidentId = `${sourceId}:${targetId}:${type}`;
            if (resume?.seen.includes(incidentId)) continue;
            encounter?.seen.push(incidentId);
            events.push({ key: `${event.key}:${sourceId}:${targetId}:${type}`, sourceId, targetId,
                kind: 'character', type, at: resume?.startedAt || timestamp });
        }
    }
    for (const helped of [...(pvp?.help || []), ...(pvp?.opponentAid || [])]) {
        if (events.length >= 64) break;
        const incidentId = `${helped.sourceId}:${helped.targetId}:${helped.type}`;
        if (resume?.seen.includes(incidentId)) continue;
        encounter?.seen.push(incidentId);
        events.push({ ...helped, key: `${event.key}:${incidentId}`, kind: 'character', at: resume?.startedAt || timestamp });
    }
    for (let i = 0; i < events.length; i++) {
        const source = states.find(s => s.characterId === events[i].sourceId);
        const e = RelationshipContext.enrich(events[i], source);
        const positive = CombatHelpPolicy.TYPES.includes(e.type);
        const aggressor = sides[revenge ? 0 : 1].members.some(s => s.characterId === e.targetId);
        const relation = memory.assess({ id: e.sourceId }, { id: e.targetId }, {}, timestamp);
        events[i] = ClanSocialEvidence.attach(e,
            relation.sourceClanId !== undefined ? { clanId: relation.sourceClanId } : states.find(s => s.characterId === e.sourceId),
            relation.targetClanId !== undefined ? { clanId: relation.targetClanId } : states.find(s => s.characterId === e.targetId), event.key,
            positive ? 'cooperation' : e.type === 'mob_contested' ? 'aggression'
                : aggressor ? revenge ? 'aggression' : 'provoked' : 'defense', positive || e.type === 'aided_opponent');
    }
    const warState = war ? memory.assess({ id: sides[0].principal.characterId }, { id: sides[1].principal.characterId }, {}, timestamp) : null;
    const group = { id: event.key, memberIds: states.map(s => s.characterId),
        ...(war ? { warContext: { fromClanId: warState.sourceClanId, toClanId: warState.targetClanId, revision: warState.war.revision } } : {}),
        ...(pvp?.started ? { pvpContext: sides.map(side => side.members.map(s => ({ id: s.characterId,
            clanId: Number(s.stats?.clanId || s.clanId || 0), karma: Number(s.stats?.karma || 0) }))) } : {}),
        partyChanges: preparedParties.flatMap((prepared, index) => prepared ? [{
        partyId: prepared.row.partyId, expectedPartyRevision: sides[index].party.revision,
        memberIds: sides[index].party.memberIds, nextResolveAt: prepared.row.nextResolveAt,
        statsJson: prepared.row.statsJson, updatedAt: prepared.row.updatedAt }] : []) };
    // Each member commits on its cached revision: a write since then refuses
    // the group whole.
    const results = await owner.commitBatch(next.map((state, index) => ({
        revision: Number(states[index].simulation?.revision || 0), nextState: state, atomicGroup: group,
        options: { allowParty: true, allowLifecycle: true }, proposal: {
            ...InventorySummary.bagChange(states[index].inventory, state.inventory),
            ...(pvp?.started ? { durable: { pvpKills: pvp.fighters.find(f => f.id === state.characterId)?.kills || [] } } : {}),
            result: { memoryEvents: events.filter(e => e.sourceId === state.characterId) } }
    })), { timestamp: now(), journalReason: pvp?.started ? 'pvp' : 'party_conflict' });
    if (results.length !== states.length || results.some(r => !r.ok)) return { ok: false, reason: 'commit_rejected' };
    // Each side caches its own committed row (Database commitBatch, partyRow).
    preparedParties.filter(Boolean).forEach(prepared => parties.acceptRow(results.find(r => r.partyRow?.partyId === prepared.row.partyId).partyRow));
    states.forEach(s => onState(s.characterId));
    if (encounter) onEncounter(encounter);
    const partyIds = sides.map(s => s.party?.partyId);
    const matchup = Journal.matchup(partyIds);
    // One journal row when the conflict ends; a fight still going writes none.
    // Its length runs from the first step to the end of this one, never past the deadline.
    const startedAt = resume?.startedAt || timestamp;
    if (!encounter) Journal.coldConflict({ key: event.key, revenge, reason: pvp?.reason || event.action,
        spotId: event.spotId, npcId: event.npcId, partyIds,
        sideSizes: sides.map(s => s.members.length), outcome, fought: !!pvp?.started,
        principals: sides.map(s => s.principal), combatants: states, personaFor, at: timestamp,
        ...(pvp?.started ? { losingSide: pvp.losingSide, kills: pvp.fighters.flatMap(f => f.kills.map(k => ({ ...k, killerId: f.id }))),
            durationMs: Math.min(combatAt + pvp.durationMs, step?.expiresAt ?? Infinity) - startedAt,
            actions: (resume?.actions || 0) + pvp.actions } : {}) });
    return { ok: true, deescalated, outcome, pvp: !!pvp?.started,
        ...(pvp ? { pvpReason: pvp.reason || outcome } : {}),
        ...(pvp?.started ? { encounter, extensionMs: encounter ? Math.max(0, encounter.expiresAt - step.expiresAt) : 0,
            combat: { durationMs: pvp.durationMs, actions: pvp.actions, fighters: pvp.fighters } } : {}),
        matchup,
        affectedIds: deescalated ? [] : pvp?.started ? [...pvp.updates.keys()] : sides[losingIndex].members.map(s => s.characterId),
        participants: [...roles].map(([id, role]) => ({ id, role })), memoryEvents: events.length,
        ...(deescalated ? {} : { waitUntil: wait.until, victimId: sides[1].principal.characterId }) };
}

module.exports = { apply, reaction };
