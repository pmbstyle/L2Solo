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

function groupContext(party, members) {
    return invoke('GameServer/Bot/Economy/EconomyContext').forGroup({ ...party,
        adena: members.reduce((sum, member) => sum + positive(member.adena), 0) }, members);
}

function decide(state, peers, options = {}) {
    return participation(state, peers, { ...options,
        persona: options.persona || invoke('GameServer/Bot/AI/BotPersona').of(state),
        roll: options.roll ?? require('../AI/TendencyRoll').roll('party', state.characterId,
            peers.map(peer => peer.characterId).join(':'), state.stats?.partyRequest?.requestedAt || state.updatedAt) });
}

function joint(party, members, { context = null } = {}) {
    const goals = members.map(declaration);
    if (context?.routePending) return { objective: party.stats?.objective, memberGoals: goals };
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
    return { objective, memberGoals: goals, ...(context?.statsPacket || {}) };
}

function participation(state, peers, { persona, roll = 0.5, bonus = 0 } = {}) {
    const traits = persona?.traits || {};
    // ARCH-NOTE: The interim party policy ignores income and help fees; escrow still pays the agreed fee.
    const social = Number(traits.sociability ?? 0.5), empathy = Number(traits.empathy ?? 0.5);
    const score = social - 0.5 + empathy * 0.25 + Number(traits.commitment ?? 0.5) * 0.15;
    const probability = Math.max(0.02, Math.min(0.98, 0.5 + score / (2 * (1 + Math.abs(score))) + Number(bonus || 0)));
    return { accept: roll < probability, probability, roll, goal: declaration(state) };
}

function formingMembers(members, requested) {
    if (requested?.clanGoalKey || requested?.sourceKind === 'raid') return members;
    return members.filter(member => member.stats?.partyRequest?.priority === 'required'
        || decide(member, members.filter(peer => peer !== member), {
            fee: requested?.helpDeal && Number(requested.helpDeal.payerId) !== Number(member.characterId)
                ? Number(requested.helpDeal.fee) / Math.max(1, members.length - 1) : 0 }).accept);
}

function itemNeed(state, item, projected) {
    const current = { ...state, inventory: projected?.get(Number(state.characterId)) || state.inventory };
    return positive(require('./ColdEconomyDecision').economyFor(current).itemUsefulness(Number(item.selfId)));
}

module.exports = { declaration, joint, participation, groupContext, decide, formingMembers, itemNeed };
