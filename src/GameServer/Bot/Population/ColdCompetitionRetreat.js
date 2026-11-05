const Validation = require('./ColdCompetitionValidation');
const InventorySummary = require('./InventorySummary');
const Episode = require('./ColdCompetitionEpisode');
const Risk = require('./SpotRiskPolicy');
const PartyRisk = require('./PartySpotRiskPolicy');
const Sections = require('../Economy/DecisionSections');
// Voluntary decisions affect the actor's whole hunting unit, without blame.
// The avoided spot stays excluded for ten of the holder's own steps.
const AVOID_STEPS = 10;
// An avoid raises the unit's occupation: the worker's next step (a member's,
// the party's run) routes it off the excluded spot, as any trip (BotRoute);
// main searches no spot.
const OCCUPATION = Sections.sectionBit('occupation');

async function apply({ event, life, owner, memory, parties, participantAllowed, contestContextAllowed,
    onState, now, waitMs }) {
    const at = now(), sides = [];
    for (const participant of [event.actor, event.peer]) {
        const principal = life.cachedState(participant.id);
        const validation = { retreat: true, at, memory, participantAllowed, contestContextAllowed };
        const principalFailure = Validation.principal(principal, participant, memory);
        if (principalFailure) return principalFailure;
        const party = participant.partyId ? parties?.find(participant.partyId) : null;
        const partyFailure = Validation.party(party, participant, event, { ...validation,
            leader: party ? life.cachedState(party.leaderId) : null });
        if (partyFailure) return partyFailure;
        const memberIds = party ? party.memberIds : [participant.id];
        const members = memberIds.map(id => life.cachedState(id));
        for (let i = 0; i < members.length; i++) {
            const failure = Validation.member(members[i], memberIds[i], participant, event, { ...validation, party });
            if (failure) return failure;
        }
        sides.push({ principal, party, members });
    }
    const states = sides.flatMap(s => s.members);
    if (states.length > 18 || new Set(states.map(s => s.characterId)).size !== states.length) return { ok: false, reason: 'overlapping_sides' };
    const avoiding = event.action === 'avoid';
    // One avoid per holder, on its own counter: each member's far steps, the
    // party's rounds for the party copy.
    const avoidFor = counter => ({ spotId: event.spotId, untilStep: counter + AVOID_STEPS });
    const DecisionEvents = invoke('GameServer/Bot/AI/DecisionEvents');
    const actorMembers = sides[0].members.map(s => avoiding ? { ...s, stats: DecisionEvents.applyRaise({ ...s.stats,
        coldCompetition: { ...s.stats?.coldCompetition, avoid: avoidFor(Risk.stepCount(s)) } }, OCCUPATION) } : s);
    // The actor's unit steps now (the worker routes it); a yield waits.
    const actorDue = due => avoiding ? at : Math.max(at, Number(due || 0)) + waitMs;
    const preparedParties = sides.map((side, i) => {
        if (!side.party) return null;
        const prepared = parties.prepareCommit({ ...side.party,
            nextResolveAt: i === 0 ? actorDue(side.party.nextResolveAt) : side.party.nextResolveAt,
            stats: { ...side.party.stats, coldCompetition: Episode.begin(side.party.stats?.coldCompetition, {
                outcome: event.action, key: event.key, at, action: event.action, peerId: sides[1 - i].principal.characterId,
                ...(i === 0 ? avoiding ? { avoid: avoidFor(PartyRisk.rounds(side.party)) } : { wait: { start: at, until: at + waitMs } } : {})
            }) } });
        prepared.row.updatedAt = Math.max(prepared.row.updatedAt, side.party.updatedAt + 1);
        return prepared;
    });
    const next = sides.flatMap((side, i) => side.members.map((s, j) => {
        const result = i === 0 ? actorMembers[j] : s;
        return { ...result, stats: { ...result.stats, coldCompetition: Episode.begin(result.stats?.coldCompetition, {
            outcome: event.action, key: event.key, at, action: event.action, peerId: sides[1 - i].principal.characterId,
            ...(i === 0 && !avoiding ? { wait: { start: at, until: at + waitMs } } : {}) }) },
        timing: i === 0 ? { ...result.timing,
            nextResolveAt: preparedParties[i]?.row.nextResolveAt || actorDue(s.timing?.nextResolveAt) } : s.timing };
    }));
    const group = { id: event.key, memberIds: states.map(s => s.characterId),
        partyChanges: preparedParties.flatMap((p, i) => p ? [{ partyId: p.row.partyId,
            expectedPartyRevision: sides[i].party.revision, memberIds: sides[i].party.memberIds,
            spotId: p.row.spotId, nextResolveAt: p.row.nextResolveAt, statsJson: p.row.statsJson, updatedAt: p.row.updatedAt }] : []) };
    // Each member commits on its cached revision: a write since then refuses
    // the group whole.
    const results = await owner.commitBatch(next.map((s, i) => ({
        revision: Number(states[i].simulation?.revision || 0), nextState: s, atomicGroup: group,
        options: { allowParty: true, allowLifecycle: true }, proposal: InventorySummary.bagChange(states[i].inventory, s.inventory)
    })), { timestamp: now(), journalReason: 'retreat' });
    if (results.length !== states.length || results.some(r => !r.ok)) return { ok: false, reason: 'commit_rejected' };
    // Each side caches its own committed row (Database commitBatch, partyRow).
    preparedParties.filter(Boolean).forEach(p => parties.acceptRow(results.find(r => r.partyRow?.partyId === p.row.partyId).partyRow));
    states.forEach(s => onState(s.characterId));
    return { ok: true, affectedIds: sides[0].members.map(s => s.characterId), memoryEvents: 0,
        matchup: sides.map(s => s.party ? 'party' : 'solo').join('_vs_'),
        ...(avoiding ? { avoidSteps: AVOID_STEPS } : { waitUntil: at + waitMs }) };
}
module.exports = { apply, AVOID_STEPS };
