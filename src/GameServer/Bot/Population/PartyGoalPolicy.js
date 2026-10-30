'use strict';

const TendencyRoll = require('../AI/TendencyRoll');
const PartyIncomeComparison = require('./PartyIncomeComparison');
const CraftMaterialParty = require('./CraftMaterialParty');
const ColdEconomyDecision = require('./ColdEconomyDecision');

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
    const economic = PartyIncomeComparison.compare(state, peers, options);
    if (economic) return { ...economic, probability: economic.accept ? 1 : 0,
        roll: options.roll ?? 0.5, goal: declaration(state) };
    return participation(state, peers, { ...options,
        persona: options.persona || invoke('GameServer/Bot/AI/BotPersona').of(state),
        roll: options.roll ?? TendencyRoll.roll('party', state.characterId, peerKey(peers),
            state.stats?.partyRequest?.requestedAt || state.spotId || state.updatedAt) });
}

// One decision per (bot, peer set, request or spot), as PersonaPartyPolicy.backgroundIntent
// seeds it: the peers in id order, and no drifting life-row stamp while a request or spot names it.
function peerKey(peers) {
    return peers.map(peer => Number(peer.characterId)).sort((a, b) => a - b).join(':');
}

// Goals that wait for the wish engine keep the party's current objective.
function pending(party, members) {
    return { objective: party.stats?.objective, memberGoals: members.map(declaration) };
}

function joint(party, members, { context = null, memberContexts, spots, timestamp = context?.timestamp || Date.now() } = {}) {
    if (CraftMaterialParty.isObjective(party.stats?.objective)) return CraftMaterialParty.joint(party, members, { timestamp, spots });
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
    let review = {};
    if (!previous?.clanGoalKey && previous?.sourceKind !== 'raid' && !previous?.helpDeal
        && timestamp - Number(party.stats?.lastIncomeReviewAt || party.startedAt || timestamp) >= PartyIncomeComparison.REVIEW_MS
        && members.every(member => invoke('GameServer/Bot/AI/PersonalGearProgression').adventurer(member))
        && members.some(member => member.spotId)) {
        const prepared = PartyIncomeComparison.prepare(members, { party, objective: previous, timestamp, memberContexts, spots });
        review = { lastIncomeReviewAt: timestamp, incomeReviews: members.map(member => ({ characterId: Number(member.characterId),
            ...PartyIncomeComparison.compare(member, members.filter(peer => peer !== member), { prepared, party, objective: previous }) })) };
    }
    return { objective, memberGoals: goals, ...(context?.statsPacket || {}), ...review };
}

function participation(state, peers, { persona, roll = 0.5, bonus = 0 } = {}) {
    const traits = persona?.traits || {};
    // Clan/social declarations without economic inputs retain their persona policy.
    const social = Number(traits.sociability ?? 0.5), empathy = Number(traits.empathy ?? 0.5);
    const score = social - 0.5 + empathy * 0.25 + Number(traits.commitment ?? 0.5) * 0.15;
    const probability = Math.max(0.02, Math.min(0.98, 0.5 + score / (2 * (1 + Math.abs(score))) + Number(bonus || 0)));
    return { accept: roll < probability, probability, roll, goal: declaration(state) };
}

// Clan and raid rosters form without a forming verdict.
function verdictFree(requested) {
    return !!requested?.clanGoalKey || requested?.sourceKind === 'raid';
}

function formingMembers(members, requested, options = {}) {
    if (verdictFree(requested)) return members;
    const filter = roster => {
        const prepared = PartyIncomeComparison.prepare(roster, { objective: requested, ...options });
        return roster.filter(member => {
            if (!invoke('GameServer/Bot/AI/PersonalGearProgression').adventurer(member)
                && member.stats?.partyRequest?.priority === 'required') return true;
            const decision = decide(member, roster.filter(peer => peer !== member), { prepared, objective: requested });
            options.onReview?.(member, decision);
            return decision.accept;
        });
    };
    const accepted = filter(members);
    if (requested?.helpDeal && !accepted.some(member => Number(member.characterId) === Number(requested.helpDeal.payerId))) return [];
    if (accepted.length === members.length || accepted.length < 2 || members.every(member => !member.spotId)) return accepted;
    // A declined helper changes safety, loot shares and costs. Do not form
    // a roster based on the economics of members who will not actually join.
    const confirmed = filter(accepted);
    return confirmed.length === accepted.length ? confirmed : [];
}

// The forming verdict of one roster, asked once before main builds the party (main for an
// all-near roster, the worker's party goal request otherwise): the accepted ids. A material
// roster also carries its reviews, and only an economic accept admits a material hunt (a member
// without a camp forecast is refused).
function formingVerdict(members, requested, { spots, timestamp = Date.now() } = {}) {
    if (!CraftMaterialParty.isObjective(requested)) return { formingAccepted: formingMembers(members, requested,
        { spots, timestamp }).map(member => Number(member.characterId)) };
    const decisions = new Map();
    const formed = new Set(formingMembers(members, requested, { spots, timestamp,
        onReview: (member, decision) => decisions.set(Number(member.characterId), decision) })
        .map(member => Number(member.characterId)));
    const incomeReviews = members.map(member => {
        // The wire packet carries only the validated economic fields of the comparison.
        const characterId = Number(member.characterId), checked = decisions.get(characterId);
        const reviewed = checked?.at === timestamp;
        const row = { characterId, ...(reviewed ? checked
            : { ...PartyIncomeComparison.evaluate(), at: timestamp, soloSource: null, partySource: null }),
        accept: reviewed && formed.has(characterId) };
        delete row.probability; delete row.roll; delete row.goal;
        return row;
    });
    return { formingAccepted: incomeReviews.filter(row => row.accept).map(row => row.characterId),
        lastIncomeReviewAt: timestamp, incomeReviews };
}

// A prospective roster needs one bounded income/safety forecast, not new
// personal or group wishes. Main commits only if every required voter agrees.
function recruitment(party, members, { spots, timestamp = Date.now() } = {}) {
    const objective = party.stats?.objective;
    const prepared = PartyIncomeComparison.prepare(members, { party, objective, spots, timestamp });
    const goals = CraftMaterialParty.isObjective(objective) ? CraftMaterialParty.needs(members, objective, party.stats.agreement) : null;
    return { objective, memberGoals: members.map(member => goals
        ? { characterId: Number(member.characterId), ...goals.find(goal => goal.characterId === Number(member.characterId)) }
        : declaration(member)), lastIncomeReviewAt: timestamp,
    incomeReviews: members.map(member => ({ characterId: Number(member.characterId),
        ...(PartyIncomeComparison.compare(member, members.filter(peer => peer !== member), { prepared, party, objective })
            || { ...PartyIncomeComparison.evaluate(), at: timestamp, soloSource: null, partySource: null }) })) };
}

function itemNeed(state, item, projected) {
    const current = { ...state, inventory: projected?.get(Number(state.characterId)) || state.inventory };
    return positive(ColdEconomyDecision.economyFor(current).itemUsefulness(Number(item.selfId)));
}

module.exports = { declaration, pending, joint, participation, groupContext, decide, verdictFree, formingMembers, formingVerdict,
    recruitment, itemNeed };
