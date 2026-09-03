const PartyComposition = invoke('GameServer/Bot/Population/BackgroundPartyComposition');
const PartyRequestPlanner = invoke('GameServer/Bot/Population/PartyRequestPlanner');

const ELIGIBLE_ACTIVITIES = new Set(['hunting', 'resting', 'party_wait']);

function objectiveFor(state) {
    const objective = PartyRequestPlanner.partyObjectiveForState(state);
    return objective?.status === 'open' && objective?.priority === 'required' ? objective : null;
}

function spotFor(state, objective = null) {
    return String(
        objective?.spotId
        || (state?.stats?.equipmentPlan?.status === 'active' ? state.stats.equipmentPlan.next?.spotId : null)
        || state?.spotId
        || ''
    );
}

function eligible(state) {
    return Boolean(
        Number(state?.characterId || 0) > 0
        && state.phase === 'cold'
        && ELIGIBLE_ACTIVITIES.has(state.activity)
        && String(state.simulation?.ownerId || 'legacy_main') === 'legacy_main'
        && !state.party?.partyId
        && !state.partyId
        && spotFor(state)
    );
}

function proposalFromStates(states = [], options = {}) {
    const timestamp = Number(options.timestamp || Date.now());
    const candidateLimit = Math.max(2, Math.min(64, Number(options.candidateLimit) || 12));
    const defaultMinSize = Math.max(2, Number(options.minSize) || 2);
    const defaultMaxSize = Math.max(defaultMinSize, Number(options.maxSize) || 5);
    const defaultLevelRange = Math.max(0, Number(options.levelRange ?? PartyComposition.DEFAULT_LEVEL_RANGE));
    const rows = (states || []).filter(eligible);
    const activePartyIdsBySpot = new Map();
    (states || []).forEach((state) => {
        const partyId = String(state?.party?.partyId || state?.partyId || '');
        const spotId = String(state?.spotId || '');
        if (!partyId || !spotId) return;
        if (!activePartyIdsBySpot.has(spotId)) activePartyIdsBySpot.set(spotId, new Set());
        activePartyIdsBySpot.get(spotId).add(partyId);
    });

    const groups = new Map();
    rows.forEach((state) => {
        const objective = objectiveFor(state);
        if (!objective) return;
        const spotId = spotFor(state, objective);
        if (!spotId) return;
        if (!groups.has(spotId)) groups.set(spotId, []);
        groups.get(spotId).push({ state, objective });
    });
    const requiredCount = [...groups.values()].reduce((sum, group) => sum + group.length, 0);
    const ordered = [...groups.entries()].map(([spotId, group]) => ({
        spotId,
        group,
        oldestAt: Math.min(...group.map(({ state, objective }) => Number(
            objective.requestedAt || state.timing?.activityStartedAt || state.updatedAt || timestamp
        ))),
        activeParties: Number(activePartyIdsBySpot.get(spotId)?.size || 0)
    })).sort((left, right) => (
        (right.group.length / (1 + right.activeParties)) - (left.group.length / (1 + left.activeParties))
        || left.oldestAt - right.oldestAt
        || left.spotId.localeCompare(right.spotId)
    ));

    for (const selectedGroup of ordered) {
        const anchor = [...selectedGroup.group].sort((left, right) => (
            Number(left.objective.requestedAt || left.state.updatedAt || timestamp)
            - Number(right.objective.requestedAt || right.state.updatedAt || timestamp)
            || Number(left.state.characterId) - Number(right.state.characterId)
        ))[0];
        const clanEquipment = anchor.objective.clanOperation === 'equipment'
            && Number(anchor.objective.clanId || 0) > 0;
        const maxSize = clanEquipment
            ? Math.max(defaultMinSize, Math.min(9, Number(anchor.objective.maxPartySize) || defaultMaxSize))
            : defaultMaxSize;
        const minSize = clanEquipment
            ? Math.max(2, Math.min(maxSize, Number(anchor.objective.minPartySize) || defaultMinSize))
            : defaultMinSize;
        const levelRange = clanEquipment
            ? Math.max(defaultLevelRange, Number(anchor.objective.levelRange) || 99)
            : defaultLevelRange;
        const anchorLevel = Number(anchor.state.level || 1);
        const compatible = selectedGroup.group
            .filter(({ state }) => Math.abs(Number(state.level || 1) - anchorLevel) <= levelRange)
            .sort((left, right) => (
                Number(left.objective.requestedAt || left.state.updatedAt || timestamp)
                - Number(right.objective.requestedAt || right.state.updatedAt || timestamp)
                || Number(left.state.characterId) - Number(right.state.characterId)
            ))
            .slice(0, candidateLimit)
            .map(({ state }) => state);
        if (PartyComposition.selectMembers(compatible, { minSize, maxSize, levelRange }).length < minSize) continue;
        return {
            requiredCount,
            spotId: selectedGroup.spotId,
            oldestAt: selectedGroup.oldestAt,
            minSize,
            maxSize,
            levelRange,
            candidates: compatible.map((state) => ({
                characterId: Number(state.characterId),
                updatedAt: Number(state.updatedAt || 0),
                simulation: {
                    ownerId: state.simulation?.ownerId || 'legacy_main',
                    revision: Math.max(0, Number(state.simulation?.revision || 0))
                }
            }))
        };
    }
    return { requiredCount, candidates: [] };
}

module.exports = { eligible, objectiveFor, spotFor, proposalFromStates };
