'use strict';

const Material = require('./CraftMaterialParty');
const REASON = 'party_material_route_unavailable';
const evacuating = party => Material.isObjective(party.stats?.objective) && !!party.stats?.travel?.materialEvacuation;

// Reuse the bounded, indexed B/A material alternatives. A destination must
// supply every unfinished owner's input, possibly from different mobs. Never
// scan the atlas or simulate fights to find a replacement for a risky camp.
function select(party, members, profiles, options) {
    const goals = Material.needs(members, party.stats.objective, party.stats.agreement);
    if (!goals.length) return null;
    const spoiler = !!Material.partySpoiler(members);
    const alternatives = goals.map(goal => Material.campsFor(
        members.find(state => Number(state.characterId) === Number(goal.characterId)), goal.itemId, profiles, spoiler));
    const Index = invoke('GameServer/Bot/AI/SpotIndex'), Routes = invoke('GameServer/Bot/AI/LevelingRoutes');
    const state = members.find(row => row.characterId === party.leaderId) || members[0];
    const routeOptions = { ...options, mode: 'party', capacityStates: members,
        matchupProfiles: invoke('GameServer/Bot/AI/BotTargetMatchup').stateProfiles(state, { ...options, mode: 'party', capacityStates: members }) };
    const candidates = alternatives[0].flatMap(row => {
        if (options.excludedSpotIds.has(String(row.spotId))
            || !alternatives.every(rows => rows.some(source => source.spotId === row.spotId))) return [];
        const spot = Index.spotById(profiles, row.spotId);
        return spot && Routes.isSpotAllowedForState(spot, state, routeOptions) ? [spot] : [];
    });
    if (!candidates.length) return null;
    const spot = Routes.bestSpot(candidates, state, routeOptions)?.spot;
    if (!spot) return null;
    return { spot, sources: goals.map((goal, index) => {
        const source = alternatives[index].find(row => row.spotId === spot.id);
        return { characterId: goal.characterId, itemId: goal.itemId, targetId: goal.targetId,
            spotId: spot.id, npcId: source.npcId, sourceKind: source.sourceKind };
    }) };
}

// Travel and the contract change in the same native party commit. Quotas,
// receipts and helper settlements belong to the old contract and are retained.
function retarget(party, sources) {
    if (!Material.isObjective(party.stats?.objective) || !sources?.length) return party;
    const sourceFor = goal => sources.find(row => Number(row.characterId) === Number(goal.characterId)
        && Number(row.itemId) === Number(goal.itemId) && Number(row.targetId) === Number(goal.targetId));
    const materialNeeds = (party.stats.agreement?.materialNeeds || []).map(goal => ({ ...goal, ...sourceFor(goal) }));
    const first = sources[0];
    return { ...party, stats: { ...party.stats, materialTargetNpcId: null,
        objective: { ...party.stats.objective, spotId: first.spotId, npcId: first.npcId,
            sourceKind: first.sourceKind, objectiveKey: `craft-material:${first.spotId}` },
        agreement: { ...party.stats.agreement, materialNeeds },
        memberGoals: (party.stats.memberGoals || []).map(goal => ({ ...goal, ...sourceFor(goal) })) } };
}

// With no common safe source, escape as a group first. On arrival each owner
// keeps his own remaining need and retries formation after the normal cooldown.
function arrived(party, members, timestamp) {
    if (!evacuating(party)) return null;
    const Lifecycle = require('./BackgroundPartyLifecycle');
    const states = members.map(state => Lifecycle.releaseMember(state, timestamp, REASON, Material.departureRequest(party, state)));
    return { members: states, party: { ...party, status: 'dissolved', nextResolveAt: null,
        stats: { ...party.stats, travel: null, pveEncounter: null, partyBreakReason: REASON } } };
}

module.exports = { REASON, select, retarget, arrived, evacuating };
