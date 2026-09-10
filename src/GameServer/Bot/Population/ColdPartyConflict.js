// Main-process execution of one bounded encounter (at most two C4 parties).
// Membership alone never makes a bot an aggressor or creates a memory edge.
const { seeded } = require('./ColdCompetitionMonitor');
const clamp = (n, low = 0, high = 1) => Math.max(low, Math.min(high, n));
const partyIdOf = state => state?.party?.partyId || state?.partyId || null;

const { reaction, select } = require('../../Social/ConflictParticipationPolicy');

async function apply({ event, life, owner, memory, parties, personaFor, participantAllowed,
    contestContextAllowed, onState, now, waitMs, cooldownMs, pvpEnabled = () => false,
    incrementalPvp = false, resume = null, onEncounter = () => {}, rng = seeded(event.key) }) {
    if (!parties) return { ok: false, reason: 'party_conflicts_unavailable' };
    const timestamp = now();
    const sides = [];
    for (const participant of [event.actor, event.peer]) {
        const principal = life.cachedState(participant.id);
        if (!principal || partyIdOf(principal) !== (participant.partyId || null)
            || Number(principal.simulation?.revision || 0) !== participant.revision
            || memory.snapshot(participant.id)?.revision !== participant.memoryRevision) {
            return { ok: false, reason: 'state_or_memory_changed' };
        }
        const party = participant.partyId ? parties.find(participant.partyId) : null;
        if (participant.partyId && (!party || party.status !== 'active' || party.updatedAt !== participant.partyUpdatedAt
            || party.memberIds.length !== participant.size || party.memberIds.length < 2 || party.memberIds.length > 9
            || !party.memberIds.includes(participant.id) || !party.memberIds.includes(party.leaderId)
            || new Set(party.memberIds).size !== party.memberIds.length || (!resume && party.spotId !== event.spotId)
            || (!resume && Number(party.stats?.objective?.npcId || party.stats?.acquisitionGoal?.next?.npcId || 0) !== event.npcId)
            || party.stats?.travel || (!resume && party.stats?.coldCompetition?.wait))) return { ok: false, reason: 'party_changed' };
        const members = party ? party.memberIds.map(id => life.cachedState(id)) : [principal];
        for (const state of members) {
            const plan = state?.stats?.equipmentPlan;
            if (!state || state.phase !== 'cold' || !(resume ? ['grouped', 'hunting', 'resting'] : ['grouped', 'hunting']).includes(state.activity) || !(state.vitals?.hp > 0)
                || partyIdOf(state) !== (participant.partyId || null) || (!resume && state.spotId !== event.spotId)
                || state.stats?.travel || (!resume && state.stats?.coldCompetition?.wait) || state.stats?.supplyErrand
                || state.stats?.warehouseWorkflow || state.stats?.marketReturn
                || (state.simulation?.ownerId || 'legacy_main') !== 'legacy_main'
                || !participantAllowed(state.characterId) || (!resume && !contestContextAllowed(state, event))
                || !memory.snapshot(state.characterId)
                || (!resume && timestamp - Number(state.stats?.coldCompetition?.at || 0) < 120000)
                || (resume && (state.stats?.pvpEncounter?.key !== resume.key || state.stats.pvpEncounter.sequence !== resume.sequence))
                || (!resume && !party && (state.activity !== 'hunting' || plan?.status !== 'active'
                    || Number(plan.next?.npcId || plan.targetNpcId || 0) !== event.npcId))) return { ok: false, reason: 'party_member_busy_or_changed' };
        }
        if (!resume && (Number(party?.stats?.coldCompetition?.conflictUntil || 0) > timestamp
            || members.some(s => Number(s.stats?.coldCompetition?.conflictUntil || 0) > timestamp))) return { ok: false, reason: 'conflict_cooldown' };
        sides.push({ principal, party, members });
    }
    const states = sides.flatMap(side => side.members);
    if (new Set(states.map(s => s.characterId)).size !== states.length || states.length > 18) return { ok: false, reason: 'overlapping_sides' };
    const nearby = (a, b) => Math.hypot(a.loc.locX - b.loc.locX, a.loc.locY - b.loc.locY) <= 1800
        && Math.abs(a.loc.locZ - b.loc.locZ) <= 500;
    if (resume && (!require('./ColdPvpResolver').allowed(sides) || (resume.materialized
        && (!nearby(sides[0].principal, sides[1].principal) || sides.some(side => side.members.some(s => !nearby(s, side.principal))))))) {
        return { ok: false, reason: 'encounter_separated_or_protected' };
    }
    const revisions = new Map(states.map(s => [s.characterId, memory.snapshot(s.characterId).revision]));
    const { roles, deescalated } = resume ? { roles: new Map(resume.roles), deescalated: false }
        : select(sides, memory, personaFor, rng, timestamp);
    const step = incrementalPvp ? { resuming: !!resume, seen: resume?.seen || [],
        until: timestamp, expiresAt: resume?.expiresAt || timestamp + 30000, maxActions: Math.max(0, 256 - (resume?.actions || 0)) } : null;
    const pvp = !deescalated && event.pvpIntent === true && pvpEnabled()
        ? require('./ColdPvpResolver').resolve({ sides, roles, timestamp: resume ? Math.max(resume.stepAt, timestamp - 1000) : timestamp,
            rng, personaFor, step }) : null;
    const involved = side => side.members.filter(s => s.characterId === side.principal.characterId || roles.get(s.characterId) === 'support');
    const power = side => {
        const supporters = involved(side);
        return supporters.reduce((sum, s) => sum + Number(s.level || 1), 0) / supporters.length + Math.log2(supporters.length) * 4;
    };
    const displaced = !deescalated && rng() < clamp(0.5 + (power(sides[0]) - power(sides[1])) / 40, 0.1, 0.9);
    const losingIndex = pvp?.started ? pvp.losingSide : displaced ? 1 : 0;
    const outcome = pvp?.started ? `pvp_${pvp.outcome}` : deescalated ? 'deescalated' : displaced ? 'displaced' : 'held_ground';
    const encounter = pvp?.ongoing ? { key: event.key, startedAt: resume?.startedAt || timestamp,
        expiresAt: step.expiresAt, stepAt: timestamp, sequence: (resume?.sequence || 0) + 1,
        actions: (resume?.actions || 0) + pvp.actions,
        materialized: resume?.materialized === true,
        spotId: event.spotId, npcId: event.npcId,
        sides: sides.map(s => ({ principalId: s.principal.characterId, memberIds: s.members.map(m => m.characterId), partyId: s.party?.partyId || null })),
        roles: [...roles], seen: [...(resume?.seen || [])] } : null;
    const episode = { key: event.key, at: resume?.startedAt || timestamp, action: 'contest', npcId: event.npcId,
        conflictUntil: (resume?.startedAt || timestamp) + cooldownMs, outcome };
    const wait = { start: timestamp, until: encounter ? timestamp + 1000 : pvp?.started ? Math.max(timestamp, pvp.until) : timestamp + waitMs,
        ...(pvp?.started ? { combat: true } : {}) };
    const preparedParties = sides.map((side, index) => {
        if (!side.party) return null;
        const delayed = pvp?.started || !deescalated && index === losingIndex;
        const prepared = parties.prepareCommit({ ...side.party,
            nextResolveAt: delayed ? (pvp?.started ? Math.max(wait.until, Number(side.party.nextResolveAt || 0))
                : Math.max(timestamp, Number(side.party.nextResolveAt || 0)) + waitMs) : side.party.nextResolveAt,
            stats: { ...side.party.stats, coldCompetition: { ...episode, peerId: sides[1 - index].principal.characterId,
                ...(delayed ? { wait } : {}) } } });
        prepared.row.updatedAt = Math.max(prepared.row.updatedAt, side.party.updatedAt + 1);
        prepared.snapshot.updatedAt = prepared.row.updatedAt;
        return prepared;
    });
    const next = sides.flatMap((side, index) => side.members.map(state => {
        const delayed = pvp?.started || !deescalated && index === losingIndex;
        const result = pvp?.updates?.get(state.characterId) || state;
        return { ...result, stats: { ...result.stats, ...(incrementalPvp ? { pvpEncounter: encounter } : {}), coldCompetition: { ...state.stats?.coldCompetition, ...episode,
            peerId: sides[1 - index].principal.characterId, role: roles.get(state.characterId),
            ...(delayed ? { wait } : {}) } }, timing: delayed ? { ...state.timing,
                ...(pvp?.started ? { lastResolvedAt: timestamp } : {}),
                nextResolveAt: preparedParties[index]?.row.nextResolveAt
                    || (pvp?.started ? Math.max(wait.until, Number(state.timing?.nextResolveAt || 0))
                        : Math.max(timestamp, Number(state.timing?.nextResolveAt || 0)) + waitMs) } : state.timing };
    }));
    // Linear attribution: the direct target remembers actual aggressors;
    // defending supporters remember the initiator. Bystanders get no offense.
    const events = [];
    if (!deescalated && !resume) {
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
    const { grants } = await owner.claimBatch(states, { timestamp, allowParty: true, allowLifecycle: true });
    try {
        if (grants.length !== states.length) return { ok: false, reason: 'claim_rejected' };
        if (states.some(s => !participantAllowed(s.characterId) || (!resume && !contestContextAllowed(s, event))
            || memory.snapshot(s.characterId)?.revision !== revisions.get(s.characterId))
            || pvp?.started && !require('./ColdPvpResolver').allowed(sides)) return { ok: false, reason: 'contest_changed_during_claim' };
        const group = { id: event.key, memberIds: states.map(s => s.characterId),
            ...(pvp?.started ? { pvpContext: sides.map(side => side.members.map(s => ({ id: s.characterId,
                clanId: Number(s.stats?.clanId || s.clanId || 0), karma: Number(s.stats?.karma || 0) }))) } : {}),
            partyChanges: preparedParties.flatMap((prepared, index) => prepared ? [{
            partyId: prepared.row.partyId, expectedUpdatedAt: sides[index].party.updatedAt,
            memberIds: sides[index].party.memberIds, nextResolveAt: prepared.row.nextResolveAt,
            statsJson: prepared.row.statsJson, updatedAt: prepared.row.updatedAt }] : []) };
        const results = await owner.commitAndReleaseBatch(next.map((state, index) => ({
            token: grants.find(g => g.characterId === state.characterId), nextState: state, atomicGroup: group,
            options: { allowParty: true, allowLifecycle: true }, proposal: { baseState: states[index],
                ...(pvp?.started ? { durable: { pvpKills: pvp.fighters.find(f => f.id === state.characterId)?.kills || [] } } : {}),
                result: { memoryEvents: events.filter(e => e.sourceId === state.characterId) } }
        })), { timestamp: now() });
        if (results.length !== states.length || results.some(r => !r.ok)) return { ok: false, reason: 'commit_rejected' };
        preparedParties.filter(Boolean).forEach(prepared => parties.acceptCommit(prepared));
        if (encounter) onEncounter(encounter);
        return { ok: true, deescalated, outcome, pvp: !!pvp?.started,
            ...(pvp ? { pvpReason: pvp.reason || outcome } : {}),
            ...(pvp?.started ? { encounter, combat: { durationMs: pvp.durationMs, actions: pvp.actions, fighters: pvp.fighters } } : {}),
            matchup: sides.map(s => s.party ? 'party' : 'solo').join('_vs_'),
            affectedIds: deescalated ? [] : pvp?.started ? [...pvp.updates.keys()] : sides[losingIndex].members.map(s => s.characterId),
            participants: [...roles].map(([id, role]) => ({ id, role })), memoryEvents: events.length,
            ...(deescalated ? {} : { waitUntil: wait.until, victimId: sides[1].principal.characterId }) };
    } finally {
        const owned = grants.filter(g => life.cachedState(g.characterId)?.simulation?.leaseId === g.leaseId);
        if (owned.length) await owner.releaseBatch(owned);
        states.forEach(s => onState(s.characterId));
    }
}

module.exports = { apply, reaction };
