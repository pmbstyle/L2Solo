'use strict';

const TendencyRoll = require('../AI/TendencyRoll');
const PartyIncomeComparison = require('./PartyIncomeComparison');
const CraftMaterialParty = require('./CraftMaterialParty');
const ColdEconomyDecision = require('./ColdEconomyDecision');
const Packet = require('../Economy/StatsPacket');
const Rewards = require('../Economy/SpotRewardExpectation');
const WalkBack = require('../Economy/WalkBack');
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

// The inputs of a party's income review (PartyIncomeComparison.prepare and
// compare), each moved by an event, hashed: the roster and the objective with
// its help deal and material needs (party writes), and per member its level,
// class, learned Spoil level, kit (the decision's kit fact), observed income
// (the decision's observation baseline: the observation event renews it when
// the income the member measures drifts beyond its own error, at its rest),
// solo income (its packet's hour: its held earning spot's, or its workshop's,
// renewed when that is searched again) and goal (its wish focus with the cash
// it names, its party request and plan step), and the spot the forecast reads
// (PartyIncomeComparison.prepare's: the objective's, else the party's, else
// the first member's). The review runs when this moves, never on the clock.
// Not in it: the party's cohesion, which drifts every fight and scales only
// the table forecast, which departs nobody
// (PopulationService departs on an own_party review); the wallet, heard in
// town by the member's own decision; the solo route of a member whose
// decision holds no earning spot (PartyIncomeComparison.soloRoute's own memo).
function incomeReviewKey(party, members, objective) {
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
                Number(Packet.hourAdena(stats.money)) || 0, stats.wishFocus?.[0] ?? null, stats.wishFocus?.[2] ?? null,
                goal(stats.partyRequest), goal(stats.equipmentPlan?.next)];
        })]));
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
    let review = {}, key = null;
    if (!previous?.clanGoalKey && previous?.sourceKind !== 'raid' && !previous?.helpDeal
        && members.every(member => invoke('GameServer/Bot/AI/PersonalGearProgression').adventurer(member))
        && members.some(member => member.spotId)
        && (key = incomeReviewKey(party, members, previous)) !== party.stats?.incomeReviewKey) {
        const prepared = PartyIncomeComparison.prepare(members, { party, objective: previous, timestamp, memberContexts, spots });
        review = { lastIncomeReviewAt: timestamp, incomeReviewKey: key, incomeReviews: members.map(member => ({ characterId: Number(member.characterId),
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
            const adventurer = invoke('GameServer/Bot/AI/PersonalGearProgression').adventurer(member);
            if (!adventurer && member.stats?.partyRequest?.priority === 'required') return true;
            // A candidate with no held earning answer has no solo side to compare: it skips this round (its earning
            // spot is woken and decides at its next step; situations.md §8): party_solo:none (developerDiagnostics).
            // (Only where the comparison runs: an adventurer with a spot and a class, PartyIncomeComparison.compare.)
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

// A held forming verdict per roster: one mechanism for its two readers, main's
// ask (PopulationService.formingVerdict: the members' source identity) and the
// verdict itself (verdictInputs). The key: the requested objective and, in
// roster order (the verdict reads the first member's spot and profile first),
// what inputsOf(member, context, drift) reads of each member; the spot
// catalog by identity. drift: [value, error] pairs a reader adds, held while
// each moves by at most its error (the observation event's rule, as the held
// earning spot compares its money weight). A held answer is restamped to the
// read (a material verdict's review time): it is the verdict on these inputs now.
// Bounded: FORMING_HOLD_LIMIT rosters, the oldest out.
const FORMING_HOLD_LIMIT = 256;
function formingHold(inputsOf, site) {
    const held = new Map();
    const Diagnostics = () => invoke('GameServer/Bot/Economy/EconomyDiagnostics');
    function inputs(members, requested, context) {
        const drift = [];
        const key = [JSON.stringify(requested ?? null), ...members.map(member => inputsOf(member, context, drift))].join('|');
        return { roster: members.map(member => Number(member.characterId)).join(','), key, drift, spots: context.spots };
    }
    function read(asked, timestamp) {
        const entry = held.get(asked.roster);
        const kept = entry && entry.key === asked.key && entry.spots === asked.spots && entry.drift.length === asked.drift.length
            && entry.drift.every((value, at) => at % 2 || Math.abs(asked.drift[at] - value) <= Math.abs(value) * entry.drift[at + 1]);
        Diagnostics().count('forming_verdict', kept ? 'held' : 'judged', site);
        if (!kept) return null;
        held.delete(asked.roster); held.set(asked.roster, entry);
        const verdict = entry.verdict;
        return verdict.lastIncomeReviewAt === undefined ? verdict : { ...verdict, lastIncomeReviewAt: timestamp,
            incomeReviews: verdict.incomeReviews.map(row => ({ ...row, at: timestamp })) };
    }
    function write(asked, verdict) {
        held.delete(asked.roster);
        held.set(asked.roster, { key: asked.key, drift: asked.drift, spots: asked.spots, verdict });
        if (held.size > FORMING_HOLD_LIMIT) {
            held.delete(held.keys().next().value);
            Diagnostics().count('forming_verdict', 'evicted', site);
        }
        return verdict;
    }
    return { inputs, read, write, clear: () => held.clear(), size: () => held.size };
}

// What the forming comparison reads of one member (PartyIncomeComparison.compare
// and prepare; participation when no comparison applies). Exact: level, class,
// kit fact (gear, skills, craft, the karma flip), spot, whether it can sell a
// buff, its gear plan's next step as a goal reads it (goalReads; also a payer's,
// whose delivery another member times). A participant: its request's priority,
// persona and roll seed. A comparison: its request as a goal (a material need
// as its agreement holds it), the focused gear
// and the cash, survival reserve, workshop quote, planned potion, its party
// samples at the grounds (any sub-roster), the solo side's held earning answer
// (its spot and the decision's time: a new answer judges again, prices and the
// crowd read anew by soloRoute wake nothing), the solo drop's hours for its goal
// (soloGoalHours), and its position as its trips read it: the
// hours to the solo spot and to each ground (WalkBack.tripHours).
// The fight's moment by what the matchups and buff offers read of it: the
// shot its prices name and the kind it loads (DecisionSections.shotInputs; none
// once the charges end), alive
// (a dead or 0 HP member leaves the capacity), the effects running at the read,
// the buffs each seller in the roster would sell it now (ColdBuffOffer.select:
// the seller's MP, its cooldowns, the buyer's cooldown and its own running
// buffs), a summoner's MP, summon and running cooldowns (its servitor's cast and
// heal sustain); the night is the roster's (formingVerdict). By the bot's income
// error (drift; debt.md 23): the wallet and the time on the spot; a material
// roster's wallets exactly, as its reviews carry the hours they give.
const goalReads = row => JSON.stringify(row ? [row.spotId ?? null, row.npcId ?? null, row.itemId ?? null, row.strategy ?? null,
    row.sourceKind ?? null, row.kind ?? null, row.amount ?? null] : null);
function verdictInputs(member, context, drift) {
    const stats = member.stats || {}, id = Number(member.characterId);
    const Sections = invoke('GameServer/Bot/Economy/DecisionSections');
    const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
    const Offer = invoke('GameServer/Bot/Economy/ColdBuffOffer');
    const classId = stats.classId ?? member.classId, timestamp = context.timestamp;
    const economic = invoke('GameServer/Bot/AI/PersonalGearProgression').adventurer(member)
        && !!member.spotId && Number.isFinite(Number(classId));
    const running = (stats.coldCombat?.effects || []).filter(effect => !(Number(effect.expiresAt) > 0) || Number(effect.expiresAt) > timestamp)
        .map(effect => `${effect.key}:${effect.level ?? ''}`).sort().join('+');
    const recipient = PartyIncomeComparison.soloState(member);
    const sold = context.members.filter(peer => peer !== member && invoke('GameServer/Bot/Economy/BuffServicePolicy').serviceClass(peer))
        .map(peer => (Offer.select(PartyIncomeComparison.soloState(peer), recipient, timestamp)?.selected || [])
            .map(skill => `${skill.fetchSelfId()}:${skill.fetchLevel()}`).join('+')).join('/');
    const summoner = invoke('GameServer/Bot/AI/BotRoles').isSummoner({ classId, characterId: id }) || !!stats.coldCombat?.summon;
    const summon = stats.coldCombat?.summon;
    const parts = [id, member.level, classId, member.spotId, Sections.kit(member), economic,
        Offer.available(member), Number(member.vitals?.hp === 0 || member.activity === 'dead'), running, sold,
        Sections.shotInputs(member, timestamp).join(':'),
        summoner ? [member.vitals?.mp, !!(summon?.active && Number(summon.hp ?? summon.maxHp) > 0 && summon.expiresAt > timestamp),
            Object.entries(stats.coldCombat?.cooldowns || {}).filter(([, until]) => Number(until) > timestamp).map(([skill]) => skill).sort().join('+')].join(':') : '',
        goalReads(stats.equipmentPlan?.next)];
    if (!economic) {
        // participation: the priority (formingMembers), the persona and its roll's seed (decide).
        parts.push(stats.partyRequest?.priority, JSON.stringify(invoke('GameServer/Bot/AI/BotPersona').of(member)?.traits || {}),
            stats.partyRequest?.requestedAt || member.spotId || member.updatedAt);
        return parts.join(',');
    }
    const route = PartyIncomeComparison.heldSoloRoute(member, context.spots, timestamp);
    context.solo.set(id, route);
    const trip = spot => WalkBack.tripHours(member.loc, spot, member, context.spots);
    // As compare times it: the member first (a material agreement holds the first members' needs).
    const own = context.material ? [member, ...context.members.filter(peer => peer !== member)] : context.members;
    const aim = PartyIncomeComparison.goalOf(member, own, context.requested,
        context.material ? CraftMaterialParty.agreement(own, context.requested) : null);
    const workshop = invoke('GameServer/Bot/Economy/EconomyContext').craftIncome(member);
    // Every roster's samples at the grounds: the second pass prepares a sub-roster.
    const samples = Hunt.sampledRows(member, timestamp, 'party').filter(row => context.grounds.ids.has(String(row.spotId)));
    // No held answer (skipped this round) and an answer with no spot are two inputs: the answer's arrival judges again.
    parts.push(route ? [route.spot.id, stats.earning.at, trip(route.spot)].join(':') : stats.earning ? `none:${stats.earning.at}` : 'unheld',
        context.grounds.spots.map(trip).join(':'), PartyIncomeComparison.soloGoalHours(member, aim, context.spots, timestamp),
        goalReads(stats.partyRequest), JSON.stringify(aim.materialGoal ?? null), PartyIncomeComparison.focusedItem(member), stats.wishFocus?.[2],
        require('../Economy/StatsPacket').refillReserve(stats.money),
        workshop?.known, workshop?.incomePerHour, workshop?.cycleHours,
        invoke('GameServer/Bot/AI/HealingPotionStock').purchasePotionFor(member)?.selfId,
        samples.map(row => `${row.partyRoster}@${row.at}:${row.samples}`).join(';'));
    const error = context.material ? 0
        : Math.max(positive(stats.wishSections?.incomeError), invoke('GameServer/Bot/AI/KnowledgeLearning').INCOME_ERROR_FLOOR);
    drift.push(positive(member.adena), error, Hunt.onSpotShare(member), error);
    return parts.join(',');
}
const verdicts = formingHold(verdictInputs, 'verdict');

// The forming verdict of one roster, asked once before main builds the party (main for an
// all-near roster, the worker's party goal request otherwise): the accepted ids. A material
// roster also carries its reviews, and only an economic accept admits a material hunt (a member
// without a camp forecast is refused). Held while its inputs stand (verdicts).
function formingVerdict(members, requested, { spots, timestamp = Date.now() } = {}) {
    if (verdictFree(requested)) return judgeForming(members, requested, { spots, timestamp });
    spots ||= invoke('GameServer/Bot/Population/SpotProfiles').ensure();
    const agreement = CraftMaterialParty.isObjective(requested) ? CraftMaterialParty.agreement(members, requested) : null;
    const material = agreement ? CraftMaterialParty.needs(members, requested, agreement) : null;
    // The grounds a forecast reads (PartyIncomeComparison.prepare: the objective's
    // spot, else the first member's of the roster or of a sub-roster).
    const grounds = requested?.spotId ? [requested.spotId] : [...new Set(members.map(member => member.spotId).filter(Boolean))];
    const context = { spots, timestamp, members, requested, material: !!material, solo: new Map(),
        grounds: { ids: new Set(grounds.map(String)), spots: grounds.map(spotId => invoke('GameServer/Bot/AI/SpotIndex').spotById(spots, spotId)) } };
    // The roster's own inputs: the requested objective (a material one with its
    // members' needs), the night the fight profiles read and the spot table's
    // revision (the forecast's table rows and rewards).
    const read = verdicts.inputs(members, { requested, material,
        night: invoke('GameServer/World/GameTime').isNight(timestamp),
        table: invoke('GameServer/Bot/AI/SpotValueTable').revision() }, context);
    return verdicts.read(read, timestamp)
        || verdicts.write(read, judgeForming(members, requested, { spots, timestamp, solo: context.solo }));
}

function judgeForming(members, requested, { spots, timestamp, solo }) {
    if (!CraftMaterialParty.isObjective(requested)) return { formingAccepted: formingMembers(members, requested,
        { spots, timestamp, solo }).map(member => Number(member.characterId)) };
    const decisions = new Map();
    const formed = new Set(formingMembers(members, requested, { spots, timestamp, solo,
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

module.exports = { declaration, pending, joint, incomeReviewKey, participation, groupContext, decide, verdictFree, formingMembers, formingVerdict,
    formingHold, FORMING_HOLD_LIMIT, recruitment, itemNeed };
