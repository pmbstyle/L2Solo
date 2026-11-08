'use strict';

const TendencyRoll = require('../AI/TendencyRoll');
const PartyProgressComparison = require('./PartyProgressComparison');
const CraftMaterialParty = require('./CraftMaterialParty');
const ColdEconomyDecision = require('./ColdEconomyDecision');
const PartyStay = require('./PartyStay');
const Roles = invoke('GameServer/Bot/AI/BotRoles');

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
    const economic = PartyProgressComparison.compare(state, peers, options);
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

function joint(party, members, { context = null } = {}) {
    if (CraftMaterialParty.isObjective(party.stats?.objective)) return CraftMaterialParty.joint(party, members);
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

// A roster of healers only does not form: a party needs a member whose job is
// the kill (our choice; C4 does not forbid it, but a healer's own blows are its
// side line, and seekers from across a region would otherwise pair healers).
function formingMembers(members, requested, options = {}) {
    if (verdictFree(requested)) return members;
    const roster = acceptedMembers(members, requested, options);
    return roster.every(member => Roles.isHealer(member)) ? [] : roster;
}

function acceptedMembers(members, requested, options) {
    // A candidate whose own stay would leave the party now (karma, its bag:
    // PartyStay.joins) is not taken: no party formed to dissolve.
    members = members.filter(member => PartyStay.joins(member, options.timestamp));
    const filter = roster => {
        const prepared = PartyProgressComparison.prepare(roster, { objective: requested, ...options });
        return roster.filter(member => {
            const adventurer = invoke('GameServer/Bot/AI/PersonalGearProgression').adventurer(member);
            if (!adventurer && member.stats?.partyRequest?.priority === 'required') return true;
            // A candidate with no held earning answer has no solo side to compare: it skips this round (its earning
            // spot is woken and decides at its next step): party_solo:none (developerDiagnostics).
            // (Only where the comparison runs: an adventurer with a spot and a class, PartyProgressComparison.compare.)
            if (adventurer && member.spotId && Number.isFinite(Number(member.stats?.classId ?? member.classId))
                && member.stats?.earning === undefined) {
                invoke('GameServer/Bot/Economy/EconomyDiagnostics').count('party_solo', 'none');
                return false;
            }
            const decision = decide(member, roster.filter(peer => peer !== member), { prepared, objective: requested, solo: options.solo });
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
// all-near roster, the worker's party goal request otherwise): the accepted ids. Only an
// economic accept admits a material hunt (a member without a camp forecast is refused). Not
// held: a refused roster's requests close (forming's no) and it is not asked again until its
// group moves (PartyAssemblyEvents: a request reopened by its build, a member in or out, its
// held solo answer).
function formingVerdict(members, requested, { spots, timestamp = Date.now() } = {}) {
    if (!verdictFree(requested)) spots ||= invoke('GameServer/Bot/Population/SpotProfiles').ensure();
    return judgeForming(members, requested, { spots, timestamp });
}

function judgeForming(members, requested, { spots, timestamp, solo }) {
    if (!CraftMaterialParty.isObjective(requested)) return { formingAccepted: formingMembers(members, requested,
        { spots, timestamp, solo }).map(member => Number(member.characterId)) };
    const decisions = new Map();
    const formed = new Set(formingMembers(members, requested, { spots, timestamp, solo,
        onReview: (member, decision) => decisions.set(Number(member.characterId), decision) })
        .map(member => Number(member.characterId)));
    return { formingAccepted: members.map(member => Number(member.characterId))
        .filter(id => formed.has(id) && decisions.get(id)?.at === timestamp) };
}

// A prospective roster needs one bounded progress/safety forecast, not new
// personal or group wishes. Main commits only if every required voter agrees.
function recruitment(party, members, { spots, timestamp = Date.now() } = {}) {
    const objective = party.stats?.objective;
    const prepared = PartyProgressComparison.prepare(members, { party, objective, spots, timestamp });
    const goals = CraftMaterialParty.isObjective(objective) ? CraftMaterialParty.needs(members, objective, party.stats.agreement) : null;
    return { objective, memberGoals: members.map(member => goals
        ? { characterId: Number(member.characterId), ...goals.find(goal => goal.characterId === Number(member.characterId)) }
        : declaration(member)),
    progressReviews: members.map(member => ({ characterId: Number(member.characterId),
        ...(PartyProgressComparison.compare(member, members.filter(peer => peer !== member), { prepared, party, objective })
            || { ...PartyProgressComparison.evaluate(), at: timestamp, soloSource: null, partySource: null }) })) };
}

// One look per member per share-out: every item of a drop asked a full decision
// of every member. The bag moves only when the member is given something
// (PartyAgreement.allocate replaces the projected bag).
const looked = new WeakMap();
function itemNeed(state, item, projected) {
    const bag = projected?.get(Number(state.characterId)) || state.inventory;
    let economy = looked.get(bag);
    // A look on a copied bag never replaces the bot's held plan.
    if (!economy) looked.set(bag, economy = ColdEconomyDecision.economyFor({ ...state, inventory: bag },
        { caller: 'item_need' }));
    return positive(economy.itemUsefulness(Number(item.selfId)));
}

module.exports = { declaration, pending, joint, participation, groupContext, decide, verdictFree, formingMembers, formingVerdict,
    recruitment, itemNeed };
