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
    const all = [state, ...peers];
    const context = options.context || invoke('GameServer/Bot/Economy/EconomyContext').forState(state);
    const grouped = options.groupContext || groupContext({ partyId: `proposal:${all.map(member => member.characterId).join(':')}` }, all);
    return participation(state, peers, { ...options, context, groupContext: grouped,
        hours: options.hours ?? grouped?.network?.activity?.costHours,
        persona: options.persona || invoke('GameServer/Bot/AI/BotPersona').of(state),
        roll: options.roll ?? require('../AI/TendencyRoll').roll('party', state.characterId,
            peers.map(peer => peer.characterId).join(':'), state.stats?.partyRequest?.requestedAt || state.updatedAt) });
}

function joint(party, members, { context = null } = {}) {
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
    return { objective, memberGoals: goals, ...(context?.statsPacket || {}) };
}

function participation(state, peers, { persona, context = null, groupContext = null, fee = 0, hours = null, roll = 0.5 } = {}) {
    const traits = persona?.traits || {};
    const solo = positive(context?.hunt?.perHour);
    const total = positive(groupContext?.hunt?.perHour);
    const share = total > 0 ? total / Math.max(1, peers.length + 1) : solo;
    const economic = solo > 0 ? (share + (Number(hours) > 0 ? positive(fee) / Number(hours) : 0) - solo) / solo : 0;
    const social = Number(traits.sociability ?? 0.5), empathy = Number(traits.empathy ?? 0.5);
    const score = economic + social - 0.5 + empathy * 0.25 + Number(traits.commitment ?? 0.5) * 0.15;
    const probability = Math.max(0.02, Math.min(0.98, 0.5 + score / (2 * (1 + Math.abs(score)))));
    return { accept: roll < probability, probability, soloPerHour: solo, sharePerHour: share, goal: declaration(state) };
}

function itemNeed(state, item, projected) {
    const current = { ...state, inventory: projected?.get(Number(state.characterId)) || state.inventory };
    return positive(invoke('GameServer/Bot/Economy/EconomyContext').forState(current).itemUsefulness(Number(item.selfId)));
}

module.exports = { declaration, joint, participation, groupContext, decide, itemNeed };
