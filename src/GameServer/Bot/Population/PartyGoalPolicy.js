'use strict';

const TendencyRoll = require('../AI/TendencyRoll');
const PartyProgressComparison = require('./PartyProgressComparison');
const CraftMaterialParty = require('./CraftMaterialParty');
const ColdEconomyDecision = require('./ColdEconomyDecision');
const Packet = require('../Economy/StatsPacket');
const Rewards = require('../Economy/SpotRewardExpectation');
const PartyStay = require('./PartyStay');
const { fnv1a32 } = require('../Fnv1a');

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

// The inputs of a party's progress review (PartyProgressComparison.prepare and
// compare), each moved by an event, hashed: the roster and the objective with
// its help deal and material needs (party writes), and per member its level,
// class, learned Spoil level, kit (the decision's kit fact), observed hunt
// (the decision's observation baseline: the observation event renews it when
// what the member measures drifts beyond its own error, at its rest),
// solo income (its packet's hour: its held earning spot's, renewed when that is
// searched again) and goal (its wish focus, the price it saves for (affordAt),
// its party request and plan step), and the spot the forecast reads
// (PartyProgressComparison.prepare's: the objective's, else the party's, else
// the first member's). The review runs when this moves, never on the clock.
// Not in it: the exp inside a level (its hours to the level go stale until the
// level or another input moves); the party's cohesion, which drifts every fight
// and scales only the table forecast, which departs nobody; the wallet, heard in
// town by the member's own decision; the solo route of a member whose
// decision holds no earning spot (PartyProgressComparison.soloRoute's own memo).
function progressReviewKey(party, members, objective) {
    const goal = row => row ? [row.spotId ?? null, row.npcId ?? null, row.itemId ?? null, row.strategy ?? row.kind ?? null,
        row.amount ?? null] : null;
    const help = party.stats?.agreement?.help || objective?.helpDeal;
    return fnv1a32(JSON.stringify([members.map(member => Number(member.characterId)).sort((a, b) => a - b),
        objective?.spotId || party.spotId || members[0]?.spotId || null, goal(objective), help ? [help.status ?? null, help.fee ?? null, help.remaining ?? null, help.payerId ?? null,
            help.helperIds ?? null] : null,
        (party.stats?.agreement?.materialNeeds || []).map(row => [row.characterId, row.collected ?? null, row.quota ?? null]),
        members.map(member => {
            const stats = member.stats || {};
            return [Number(member.characterId), Number(member.level || 0), stats.classId ?? member.classId ?? null,
                Rewards.spoilSkillLevel(member), stats.wishSections?.build ?? null, stats.wishSections?.sample ?? null,
                Number(Packet.hourAdena(stats.money)) || 0, stats.wishFocus?.[0] ?? null, stats.wishSections?.affordAt?.at ?? null,
                goal(stats.partyRequest), goal(stats.equipmentPlan?.next)];
        })]));
}

function joint(party, members, { context = null, spots, timestamp = context?.timestamp || Date.now() } = {}) {
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
    let review = {}, key = null;
    if (!previous?.clanGoalKey && previous?.sourceKind !== 'raid' && !previous?.helpDeal
        && members.every(member => invoke('GameServer/Bot/AI/PersonalGearProgression').adventurer(member))
        && members.some(member => member.spotId)
        && (key = progressReviewKey(party, members, previous)) !== party.stats?.progressReviewKey) {
        const prepared = PartyProgressComparison.prepare(members, { party, objective: previous, timestamp, spots });
        review = { lastProgressReviewAt: timestamp, progressReviewKey: key, progressReviews: members.map(member => ({ characterId: Number(member.characterId),
            ...PartyProgressComparison.compare(member, members.filter(peer => peer !== member), { prepared, party, objective: previous }) })) };
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
// all-near roster, the worker's party goal request otherwise): the accepted ids. A material
// roster also carries its reviews, and only an economic accept admits a material hunt (a member
// without a camp forecast is refused). Not held: a refused roster's requests close (forming's
// no) and it is not asked again until its group moves (PartyAssemblyEvents: a request reopened
// by its build, a member in or out, its held solo answer).
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
    const progressReviews = members.map(member => {
        // The wire packet carries only the validated economic fields of the comparison.
        const characterId = Number(member.characterId), checked = decisions.get(characterId);
        const reviewed = checked?.at === timestamp;
        const row = { characterId, ...(reviewed ? checked
            : { ...PartyProgressComparison.evaluate(), at: timestamp, soloSource: null, partySource: null }),
        accept: reviewed && formed.has(characterId) };
        delete row.probability; delete row.roll; delete row.goal;
        return row;
    });
    return { formingAccepted: progressReviews.filter(row => row.accept).map(row => row.characterId),
        lastProgressReviewAt: timestamp, progressReviews };
}

// A prospective roster needs one bounded progress/safety forecast, not new
// personal or group wishes. Main commits only if every required voter agrees.
function recruitment(party, members, { spots, timestamp = Date.now() } = {}) {
    const objective = party.stats?.objective;
    const prepared = PartyProgressComparison.prepare(members, { party, objective, spots, timestamp });
    const goals = CraftMaterialParty.isObjective(objective) ? CraftMaterialParty.needs(members, objective, party.stats.agreement) : null;
    return { objective, memberGoals: members.map(member => goals
        ? { characterId: Number(member.characterId), ...goals.find(goal => goal.characterId === Number(member.characterId)) }
        : declaration(member)), lastProgressReviewAt: timestamp,
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

module.exports = { declaration, pending, joint, progressReviewKey, participation, groupContext, decide, verdictFree, formingMembers, formingVerdict,
    recruitment, itemNeed };
