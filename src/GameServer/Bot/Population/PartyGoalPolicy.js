'use strict';

const positive = value => Math.max(0, Number(value) || 0);

function declaration(state) {
    const plan = state.stats?.equipmentPlan;
    const request = state.stats?.partyRequest || state.stats?.clanPartyObjective;
    return { characterId: Number(state.characterId), wish: state.stats?.wishFocus?.[0] || null,
        spotId: request?.spotId || plan?.next?.spotId || state.spotId,
        npcId: Number(request?.npcId || plan?.next?.npcId || 0) || null,
        itemId: Number(request?.itemId || plan?.next?.itemId || 0) || null,
        need: request?.reason || (plan?.status === 'active' ? 'gear_acquisition' : 'progression') };
}

function groupContext(party, members, deps = {}) {
    return invoke('GameServer/Bot/Economy/EconomyContext').forGroup({ ...party,
        adena: members.reduce((sum, member) => sum + positive(member.adena), 0) }, members, deps);
}

function decide(state, peers, options = {}) {
    const economic = require('./PartyIncomeComparison').compare(state, peers, options);
    if (economic) return { ...economic, probability: economic.accept ? 1 : 0,
        roll: options.roll ?? 0.5, goal: declaration(state) };
    return participation(state, peers, { ...options,
        persona: options.persona || invoke('GameServer/Bot/AI/BotPersona').of(state),
        roll: options.roll ?? require('../AI/TendencyRoll').roll('party', state.characterId,
            peers.map(peer => peer.characterId).join(':'), state.stats?.partyRequest?.requestedAt || state.updatedAt) });
}

// Goals that wait for the wish engine keep the party's current objective.
function pending(party, members) {
    return { objective: party.stats?.objective, memberGoals: members.map(declaration) };
}

function joint(party, members, { context = null, memberContexts, spots, timestamp = context?.timestamp || Date.now() } = {}) {
    const goals = members.map(declaration);
    // The same wish engine merges members' actual wishes. Its selected leaf
    // carries a native route; a shopping/crafting leaf does not teleport a party.
    const activity = context?.network?.activity;
    const selected = activity?.activity === 'hunting' && activity.spotId
        ? { ...goals[Number(String(activity.nodeKey).split(':')[0])] || goals[0],
            spotId: activity.spotId, npcId: activity.npcId || null, itemId: activity.itemId || null }
        : goals.find(goal => goal.spotId === party.stats?.objective?.spotId) || goals[0];
    const previous = party.stats?.objective;
    const objective = previous?.clanGoalKey || previous?.sourceKind === 'raid' || previous?.helpDeal
        ? previous : selected ? { ...previous, ...selected, status: 'open', priority: previous?.priority || 'preferred',
            objectiveKey: ['joint', selected.spotId, selected.npcId || 0].join(':') } : previous;
    const Income = require('./PartyIncomeComparison');
    let review = {};
    if (!previous?.clanGoalKey && previous?.sourceKind !== 'raid' && !previous?.helpDeal
        && timestamp - Number(party.stats?.lastIncomeReviewAt || party.startedAt || timestamp) >= Income.REVIEW_MS
        && members.every(member => invoke('GameServer/Bot/AI/PersonalGearProgression').personal(member))
        && members.some(member => member.spotId)) {
        const prepared = Income.prepare(members, { party, objective: previous, timestamp, memberContexts, spots });
        review = { lastIncomeReviewAt: timestamp, incomeReviews: members.map(member => ({ characterId: Number(member.characterId),
            ...Income.compare(member, members.filter(peer => peer !== member), { prepared, party, objective: previous }) })) };
    }
    // Waiting for a travel quote keeps the objective, but must not suspend
    // the cheap personal income review for an already active hunt.
    return { ...(context?.routePending ? pending(party, members)
        : { objective, memberGoals: goals, ...(context?.statsPacket || {}) }), ...review };
}

function participation(state, peers, { persona, roll = 0.5, bonus = 0 } = {}) {
    const traits = persona?.traits || {};
    // Clan/social declarations without economic inputs retain their persona policy.
    const social = Number(traits.sociability ?? 0.5), empathy = Number(traits.empathy ?? 0.5);
    const score = social - 0.5 + empathy * 0.25 + Number(traits.commitment ?? 0.5) * 0.15;
    const probability = Math.max(0.02, Math.min(0.98, 0.5 + score / (2 * (1 + Math.abs(score))) + Number(bonus || 0)));
    return { accept: roll < probability, probability, roll, goal: declaration(state) };
}

function formingMembers(members, requested) {
    if (requested?.clanGoalKey || requested?.sourceKind === 'raid') return members;
    const Income = require('./PartyIncomeComparison');
    const filter = roster => {
        const prepared = Income.prepare(roster, { objective: requested });
        return roster.filter(member => !invoke('GameServer/Bot/AI/PersonalGearProgression').personal(member)
            && member.stats?.partyRequest?.priority === 'required'
            || decide(member, roster.filter(peer => peer !== member), { prepared, objective: requested }).accept);
    };
    const accepted = filter(members);
    if (accepted.length === members.length || accepted.length < 2 || members.every(member => !member.spotId)) return accepted;
    // A declined helper changes safety, loot shares and costs. Do not form
    // a roster based on the economics of members who will not actually join.
    const confirmed = filter(accepted);
    return confirmed.length === accepted.length ? confirmed : [];
}

function itemNeed(state, item, projected) {
    const current = { ...state, inventory: projected?.get(Number(state.characterId)) || state.inventory };
    return positive(require('./ColdEconomyDecision').economyFor(current).itemUsefulness(Number(item.selfId)));
}

module.exports = { declaration, pending, joint, participation, groupContext, decide, formingMembers, itemNeed };
