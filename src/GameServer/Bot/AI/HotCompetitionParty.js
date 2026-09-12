const { randomUUID } = require('crypto');

// Publish one persistent autonomous roster, never player-companion ownership.
async function form(sides, context, valid) {
    const Life = invoke('GameServer/Bot/Population/BotLifeState');
    const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
    const Lifecycle = invoke('GameServer/Bot/Population/HotPartyLifecycle');
    const sessions = sides.flatMap(s => s.sessions), grouped = sides.filter(s => s.party);
    if (grouped.length > 1 || sessions.length < 2 || sessions.length > 5 || sessions.some(s => s.hotCompetitionCommit)) return { ok: false, reason: 'party_unavailable' };
    if (require('../../Actor/PartyRewardMath').validMemberIndexes(sessions.map(s => s.actor.fetchLevel())).length !== sessions.length) {
        return { ok: false, reason: 'party_experience_mismatch' };
    }
    const existing = grouped[0]?.party;
    if (existing?.stats?.objective?.clanGoalKey || existing?.stats?.objective?.clanOperation) return { ok: false, reason: 'clan_objective' };
    const release = existing ? () => {} : invoke('GameServer/Bot/Population/PopulationService').reserveCompetitionPartySlot();
    if (!release) return { ok: false, reason: 'party_capacity' };
    if (existing && Lifecycle.pending.has(existing.partyId)) { release(); return { ok: false, reason: 'party_transition' }; }
    if (existing) Lifecycle.pending.add(existing.partyId);
    const token = {};
    sessions.forEach(s => { s.hotCompetitionCommit = token; });
    try {
        const ids = sessions.map(s => Number(s.actor.fetchId()));
        await Life.settleWrites(ids);
        const states = ids.map(id => Life.cachedState(id));
        const canCommit = () => valid() && sessions.every(s => s.hotCompetitionCommit === token)
            && Date.now() - context.at <= 10000;
        if (!canCommit() || states.some(s => s?.phase !== 'hot')) return { ok: false, reason: 'hot_party_context_changed' };
        const Composition = invoke('GameServer/Bot/Population/BackgroundPartyComposition');
        const leaderId = existing?.leaderId || Composition.chooseLeader(states)?.characterId || ids[0];
        const partyId = existing?.partyId || `bgp_hot_${randomUUID()}`;
        const prepared = Parties.prepareCommit({ ...existing, partyId, leaderId, memberIds: ids,
            status: 'hot', spotId: context.spotId, nextResolveAt: null,
            startedAt: existing?.startedAt || context.at, roleCoverage: Composition.roleCoverage(states),
            stats: { ...existing?.stats, formedAt: existing?.stats?.formedAt || context.at,
                memberNames: sessions.map(s => s.actor.fetchName()),
                objective: existing?.stats?.objective || { kind: 'shared_target', npcId: context.npcId, spotId: context.spotId },
                hotLifecycle: { startedAt: existing?.stats?.hotLifecycle?.startedAt || context.at, reason: 'hot_competition' } } });
        prepared.row.updatedAt = Math.max(prepared.row.updatedAt, Number(existing?.updatedAt || 0) + 1);
        prepared.snapshot.updatedAt = prepared.row.updatedAt;
        const assignments = states.map(s => Life.preparePartyAssignment({ ...s, activity: 'grouped', spotId: context.spotId },
            partyId, Composition.roleForState(s), leaderId));
        const result = await invoke('Database').commitBackgroundPartyMembership({ party: prepared.row, members: assignments,
            expectedPhase: 'hot', expectedPartyUpdatedAt: existing?.updatedAt ?? null, canCommitHot: canCommit,
            event: { characterId: leaderId, eventType: existing ? 'party_recruit' : 'party',
                summary: 'Hunters joined forces over a shared target', createdAt: context.at,
                meta: { partyId, npcId: context.npcId, source: 'hot_competition' } } });
        if (!result.ok) return result;
        Parties.acceptCommit(prepared);
        const assigned = Life.acceptPartyAssignments(assignments);
        // No await between durable membership and the complete live roster.
        sessions.forEach(s => {
            s.coldLifeState = assigned.find(state => state.characterId === s.actor.fetchId());
            s.hotBackgroundPartyId = partyId;
            s.plan = 'hunting';
            s.hotCompetitionHold = null;
        });
        invoke('GameServer/Bot/AI/BotPvpIndex').invalidate();
        sessions.find(s => s.actor.fetchId() === leaderId).backgroundHuntTarget = context.mob;
        const Metrics = invoke('GameServer/Bot/Population/PopulationMetrics');
        if (existing) Metrics.recordPartyRecruit(1); else Metrics.recordPartyFormation();
        return { ok: true, partyId, recruited: !!existing };
    } finally {
        sessions.forEach(s => { if (s.hotCompetitionCommit === token) s.hotCompetitionCommit = null; });
        if (existing) Lifecycle.pending.delete(existing.partyId);
        release();
    }
}
module.exports = { form };
