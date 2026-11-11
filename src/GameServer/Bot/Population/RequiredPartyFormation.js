const PartyComposition = invoke('GameServer/Bot/Population/BackgroundPartyComposition');
const PartyRequestPlanner = invoke('GameServer/Bot/Population/PartyRequestPlanner');
const PersonaPartyPolicy = invoke('GameServer/Bot/Population/PersonaPartyPolicy');

const { isMainThread } = require('node:worker_threads');
const { partyTradeAllowed } = require('./PartyAdmission');

const ELIGIBLE_ACTIVITIES = new Set(['hunting', 'resting', 'party_wait']);

// The open requests this player-safe formation assembles: required ones
// always, preferred ones when the bot is willing by the persona rule the
// background formation applies (PersonaPartyPolicy.backgroundIntent).
function objectiveFor(state) {
    const objective = PartyRequestPlanner.partyObjectiveForState(state);
    if (objective?.status !== 'open') return null;
    if (objective.priority === 'required') return objective;
    return objective.priority === 'preferred' && PersonaPartyPolicy.backgroundIntent(state).accept ? objective : null;
}

function spotFor(state, objective = null) {
    return String(PartyRequestPlanner.objectiveSpot(state, objective) || '');
}

function eligible(state) {
    return Boolean(
        Number(state?.characterId || 0) > 0
        && state.phase === 'cold'
        && ELIGIBLE_ACTIVITIES.has(state.activity)
        && !state.party?.partyId
        && !state.partyId
        && !require('./RaidSupplyPolicy').held(state)
        && partyTradeAllowed('party', state)
        && (!isMainThread || require('../../AfkTrade/TradeMeetingService').canJoinParty(state.characterId, state))
        && spotFor(state)
    );
}

function proposalFromStates(states = [], options = {}) {
    const timestamp = Number(options.timestamp || Date.now());
    const priorityClans = new Set((options.priorityClanIds || []).map(Number).filter(id => id > 0));
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
    // On main this runs on the assembly event's page: its helpers were already
    // read from the support index (PartyAssemblyEvents.supportShortlist) and
    // filtered by PopulationService.runPartyAssemblyEvent. A second index read
    // here would rotate the index again and skip that filter; the worker has no
    // copy of the index. This pool is bounded by the states handed in.
    const supports = new Map();
    rows.forEach((state) => {
        const objective = objectiveFor(state);
        if (!objective) {
            const role = PartyComposition.supportRole(state, objective);
            if (role) {
                const key = `${state.level}:${role}`;
                if (!supports.has(key)) supports.set(key, []);
                const pool = supports.get(key);
                if (pool.length < candidateLimit) pool.push(state);
            }
            return;
        }
        const spotId = spotFor(state, objective);
        if (!spotId) return;
        const key = objective.clanGoalKey ? `${spotId}:${objective.clanGoalKey}`
            : require('./CraftMaterialParty').isObjective(objective) ? `craft-material:${spotId}` : spotId;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ state, objective });
    });
    const requiredCount = [...groups.values()].reduce((sum, group) => (
        sum + group.filter(({ objective }) => objective.priority === 'required').length
    ), 0);
    const ordered = [...groups.values()].map(group => ({
        spotId: spotFor(group[0].state, group[0].objective),
        playerClan: group.some(({ objective }) => objective.clanGoalKey && priorityClans.has(Number(objective.clanId))),
        required: group.some(({ objective }) => objective.priority === 'required'),
        group,
        oldestAt: Math.min(...group.map(({ state, objective }) => Number(
            objective.requestedAt || state.timing?.activityStartedAt || state.updatedAt || timestamp
        ))),
        activeParties: Number(activePartyIdsBySpot.get(spotFor(group[0].state, group[0].objective))?.size || 0)
    })).sort((left, right) => (
        Number(right.playerClan) - Number(left.playerClan)
        || Number(right.required) - Number(left.required)
        || (right.group.length / (1 + right.activeParties)) - (left.group.length / (1 + left.activeParties))
        || left.oldestAt - right.oldestAt
        || left.spotId.localeCompare(right.spotId)
    ));

    for (const selectedGroup of ordered) {
        const anchors = [...selectedGroup.group].sort((left, right) => (
            Number(left.objective.requestedAt || left.state.updatedAt || timestamp)
            - Number(right.objective.requestedAt || right.state.updatedAt || timestamp)
            || Number(left.state.characterId) - Number(right.state.characterId)
        ));
        for (const anchor of anchors) {
            const { maxSize, minSize, levelRange } = PartyRequestPlanner.limitsForObjective(anchor.objective, {
                minSize: defaultMinSize, maxSize: defaultMaxSize, levelRange: defaultLevelRange
            });
            const anchorLevel = Number(anchor.state.level || 1);
            const compatible = anchors
                .filter(({ state }) => !anchor.objective.fullRoster || anchor.objective.fullRoster.memberIds.includes(Number(state.characterId)))
                .filter(({ state }) => Math.abs(Number(state.level || 1) - anchorLevel) <= levelRange)
                .slice(0, anchor.objective.fullRoster ? maxSize : candidateLimit)
                .map(({ state }) => state);
            const Material = require('./CraftMaterialParty');
            if (Material.isObjective(anchor.objective)) {
                const helpers = [];
                for (let gap = 0; gap <= Math.min(4, levelRange); gap++) for (const level of gap ? [anchorLevel - gap, anchorLevel + gap] : [anchorLevel])
                    for (const role of ['healer', 'buffer', 'tank']) {
                        if (helpers.length >= candidateLimit) break;
                        helpers.push(...(supports.get(`${level}:${role}`) || []).slice(0, candidateLimit - helpers.length));
                    }
                if (compatible.length + helpers.length < minSize) continue;
                const members = Material.selectMembers([...compatible.slice(0, Material.MAX_CORE), ...helpers],
                    { minSize, maxSize, levelRange, timestamp });
                if (members.length < minSize) continue;
                return { requiredCount, spotId: selectedGroup.spotId, oldestAt: selectedGroup.oldestAt,
                    minSize, maxSize, levelRange, materialParty: true,
                    candidates: members.map(state => ({ characterId: Number(state.characterId), updatedAt: Number(state.updatedAt || 0),
                        simulation: { revision: Math.max(0, Number(state.simulation?.revision || 0)) } })) };
            }
            if (require('../../Clan/ClanRaidRoster').selectMembers(compatible, anchor.objective, { minSize, maxSize, levelRange }).length < minSize) continue;
            return {
                requiredCount,
                spotId: selectedGroup.spotId,
                oldestAt: selectedGroup.oldestAt,
                minSize,
                maxSize,
                levelRange,
                ...(anchor.objective.fullRoster ? { fullRoster: anchor.objective.fullRoster } : {}),
                candidates: compatible.map((state) => ({
                    characterId: Number(state.characterId),
                    updatedAt: Number(state.updatedAt || 0),
                    simulation: { revision: Math.max(0, Number(state.simulation?.revision || 0)) }
                }))
            };
        }
    }
    return { requiredCount, candidates: [] };
}

module.exports = { eligible, objectiveFor, spotFor, proposalFromStates };
