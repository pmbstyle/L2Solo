'use strict';

const MAX_SOURCE_CHECKS = 32, MAX_CAMPS = 4, MAX_CORE = 3, MAX_MEMBERS = 5;
const REVIEW_MS = 5 * 60000, SOURCE_CACHE_SIZE = 256;
const sources = new WeakMap();
const positive = value => Math.max(0, Number(value) || 0);
const isObjective = objective => objective?.materialParty === true && !objective.clanGoalKey;
const requestOf = state => isObjective(state.stats?.partyRequest) ? state.stats.partyRequest : null;

// Match the native party reward resolver: only its first spoiler can cast,
// and a class declaration cannot substitute for the learned Spoil skill.
function partySpoiler(members) {
    const member = members.slice(0, MAX_MEMBERS).find(state => invoke('GameServer/Bot/AI/BotRoles').isSpoiler(state));
    return member ? require('./ColdKillRewards').spoilerFor(member,
        { skills: require('./ColdCombatProfile').skillsFor(member) }) : null;
}

// One indexed item lookup, never a scan of the hunting atlas. Bound both the
// cold-cache work and retained alternatives; shared static rows die with the
// source index. Actor combat/route checks are separate and never cached here.
function campsFor(state, itemId, spots, spoiler) {
    const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
    const index = Planner.sourceIndexFor(spots);
    const role = state.stats?.role || state.party?.role || invoke('GameServer/Bot/AI/BotRoles').inferRole(state.stats?.classId ?? state.classId);
    const tableRole = ({ melee: 'dps', nuker: 'mage', crafter: 'dps' })[role] || role;
    const Table = invoke('GameServer/Bot/AI/SpotValueTable');
    let cache = sources.get(index);
    if (!cache) sources.set(index, cache = new Map());
    const key = `${itemId}:${state.level}:${tableRole}:${Number(spoiler)}:${Planner.rateProfileSignature()}`;
    const held = cache.get(key);
    if (held?.done) {
        // Least recently used: a key read again moves to the newest end.
        cache.delete(key);
        cache.set(key, held);
        return held.rows;
    }
    const camps = new Map((held?.rows || []).map(row => [row.spotId, row])), entries = index.get(itemId) || [];
    const end = Math.min((held?.cursor || 0) + MAX_SOURCE_CHECKS, entries.length);
    for (let i = held?.cursor || 0; i < end; i++) {
        const entry = entries[i], npcId = Number(entry.reward.selfId), level = Number(entry.npcLevel);
        if (entry.spot.raidBoss || entry.kind === 'spoil' && !spoiler
            || level < state.level - 15 || level > state.level + 4
            || !Planner.isBotEligibleSourceNpcId(npcId)) continue;
        const yieldPerKill = Planner.itemDropYield(entry.reward, itemId, entry.kind,
            { npcLevel: level, killerLevel: state.level }).expectedYield;
        const rate = yieldPerKill * positive(entry.sourceCount) / Math.max(1, positive(entry.totalCount));
        if (!(rate > 0)) continue;
        const row = { spotId: entry.spot.id, npcId, itemId, sourceKind: entry.kind, rate, npcLevel: level,
            forecastKnown: !!Table.value(entry.spot.id, tableRole, state.level, true) };
        if (rate > (camps.get(row.spotId)?.rate || 0)) camps.set(row.spotId, row);
    }
    // Prefer already measured camps. Unknown forecasts remain candidates,
    // but never trigger combat simulation or a table rebuild at runtime.
    const result = [...camps.values()].sort((a, b) => Number(b.forecastKnown) - Number(a.forecastKnown)
        || b.rate - a.rate || a.spotId.localeCompare(b.spotId)).slice(0, MAX_CAMPS);
    // An update of a held key frees its own slot first, so it evicts nobody.
    cache.delete(key);
    if (cache.size >= SOURCE_CACHE_SIZE) cache.delete(cache.keys().next().value);
    cache.set(key, { rows: result, cursor: end, done: end === entries.length });
    return result;
}

// memo: the bot's record in the background thread; its materialMemo field
// keeps the last "no camp is worth a party" answer while the bot's decision
// sequence, the memo key and the spot list hold, until the review time.
function request(state, plan, { spots = [], economy, memo = null, timestamp = Date.now() } = {}) {
    if (state.partyId || state.party?.partyId || state.level < 52 || !plan?.recipeId
        || !['active', 'deferred', 'blocked'].includes(plan.status) || plan.clanGoal
        || !spots.length || !economy) return null;
    const focus = economy.network?.focus?.[0];
    if (focus !== `power:${plan.target?.selfId}:${plan.target?.slot}`) return null;
    const Index = require('../../Item/ItemTemplateIndex'), Data = invoke('GameServer/DataCache');
    const target = Index.find(Data.items, plan.target.selfId);
    if (!['b', 'a'].includes(target?.etc?.rank)) return null;
    const Progression = invoke('GameServer/Bot/AI/PersonalGearProgression');
    if (!Progression.adventurer(state) || Progression.marketOnly(state, target)) return null;
    const recipe = invoke('GameServer/Items/C4RecipeItems').resolveByRecipeId(plan.recipeId);
    // Native equipment recipes put the key part immediately after the scroll.
    // This first pass targets that scarce input; ordinary component production
    // keeps its existing owner and does not spawn a second recipe traversal.
    const material = recipe?.materials?.find(row => row.selfId !== recipe.recipeItemId);
    if (!material || Index.find(Data.items, material.selfId)?.template?.kind !== 'Other.Material') return null;
    const requiredTotal = Math.ceil(material.amount * positive(plan.outputAmount || 1));
    const owned = positive(state.inventory?.[material.selfId]?.amount);
    const incoming = positive(economy.stockFor?.(material.selfId, focus)?.incoming);
    const amount = Math.max(0, requiredTotal - owned - incoming);
    if (!amount) return null;
    // A selected executable purchase/farm is already progress, not a reason
    // to recruit a competing operation. Funding hunts may still seek help.
    const activity = economy.network?.activity;
    if (activity && !activity.funding && activity.rootKey === focus
        && (activity.activity === 'shopping' || activity.activity === 'crafting'
            || activity.activity === 'improving' || activity.activity === 'hunting' && activity.itemId === material.selfId)) return null;
    const quote = economy.network?.plans?.get(`item:${material.selfId}`);
    const materialCash = quote?.kind === 'buy' && quote.quoted && quote.availableUnits >= amount
        ? positive(quote.basePrice) * amount + positive(quote.tripFees) : null;
    const materialSoloHours = ['drop', 'spoil'].includes(quote?.kind) && quote.executable
        && quote.readyHours >= 0 ? quote.readyHours * amount + positive(quote.tripHours) : null;
    const heldRequest = requestOf(state);
    const previous = Number(heldRequest?.targetId) === Number(plan.target.selfId)
        && Number(heldRequest?.itemId) === Number(material.selfId) ? heldRequest : null;
    if (previous?.materialLevel === state.level && previous.materialClass === (state.stats?.classId ?? state.classId)
        && timestamp < Number(previous.materialReviewedAt || 0) + REVIEW_MS) {
        const { helpDeal, suspendedFor, ...held } = previous;
        return { ...held, status: 'open', amount, requiredTotal, materialCash, materialSoloHours };
    }
    const memoKey = `${state.level}:${state.stats?.classId ?? state.classId}:${plan.target.selfId}:${material.selfId}:${amount}`;
    const seq = Number(state.stats?.decisionSeq || 0), held = memo?.materialMemo;
    if (held?.key === memoKey && held.seq === seq && held.spots === spots && timestamp < held.until) return null;
    const noRequest = () => {
        // No repeated exact safety work while the bot's decision holds.
        if (memo) memo.materialMemo = { key: memoKey, seq, spots, until: timestamp + REVIEW_MS };
        return null;
    };
    const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
    const spoiler = !!invoke('GameServer/Bot/Population/ColdKillRewards').spoilerFor(state, { skills: Profile.skillsFor(state) });
    const camps = campsFor(state, material.selfId, spots, spoiler);
    if (!camps.length) return noRequest();
    const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
    const allowed = Planner.sourceRouteReader(state, { timestamp, spots });
    const SpotIndex = invoke('GameServer/Bot/AI/SpotIndex');
    if (camps.some(row => allowed(SpotIndex.spotById(spots, row.spotId))
        && Planner.soloSafeForSource(state, row))) return noRequest();
    const { forecastKnown, ...selected } = camps[Number(previous?.attempts || 0) % camps.length];
    return { status: 'open', priority: 'required', reason: 'craft_material', materialParty: true,
        objectiveKey: `craft-material:${selected.spotId}`, strategy: 'craft', ...selected,
        amount, requiredTotal, targetId: plan.target.selfId, materialCash, materialSoloHours,
        attempts: positive(previous?.attempts),
        materialLevel: state.level, materialClass: state.stats?.classId ?? state.classId,
        materialReviewedAt: timestamp, reviewAt: timestamp + REVIEW_MS };
}

function remaining(state, goal, inventory = state.inventory) {
    const plan = state.stats?.equipmentPlan;
    if (!goal || Number(plan?.target?.selfId) !== Number(goal.targetId) || plan.status === 'complete'
        || positive(inventory?.[goal.targetId]?.amount) > 0 || positive(inventory?.[plan.unseal?.sourceId]?.amount) > 0) return 0;
    const physical = Math.max(0, positive(goal.requiredTotal) - positive(inventory?.[goal.itemId]?.amount));
    return Math.min(physical, goal.quota === undefined ? Infinity : Math.max(0, goal.quota - positive(goal.collected)));
}

// Restocking changes the current occupation, not the unfinished craft. Keep
// its one request parked even after the formation cooldown ends; only the
// renewed material decision may reopen it. No source search is needed here.
function supplyPause(state, plan, { economy, timestamp = Date.now() } = {}) {
    const held = requestOf(state);
    const focus = economy?.network?.focus?.[0] || '';
    if (!held || !['open', 'deferred'].includes(held.status) || !focus.startsWith('stock:')
        || state.partyId || state.party?.partyId || state.activity === 'dead'
        || !plan?.recipeId || plan.clanGoal || plan.levelingRecovery
        || !['active', 'deferred', 'blocked'].includes(plan.status)
        || remaining({ ...state, stats: { ...state.stats, equipmentPlan: plan } }, held) <= 0) return null;
    const incoming = positive(economy?.stockFor?.(held.itemId, `power:${held.targetId}:${plan.target.slot}`)?.incoming);
    if (incoming >= positive(held.requiredTotal) - positive(state.inventory?.[held.itemId]?.amount)) return null;
    return { ...held, status: 'deferred', suspendedFor: focus,
        deferredUntil: Number(held.deferredUntil || 0) || timestamp };
}

function needs(members, objective, agreement) {
    const stored = agreement?.materialNeeds || members.map(state => ({ ...requestOf(state), characterId: state.characterId }));
    return stored.slice(0, MAX_MEMBERS).flatMap(goal => {
        const state = members.find(member => Number(member.characterId) === Number(goal.characterId));
        if (!state || goal.spotId !== objective?.spotId) return [];
        const amount = remaining(state, goal);
        return amount > 0 ? [{ ...goal, amount }] : [];
    });
}

function agreement(members, objective, previous = null) {
    const held = new Map((previous?.materialNeeds || []).slice(0, MAX_MEMBERS)
        .map(goal => [Number(goal.characterId), goal]));
    return { ...previous, mode: 'need', spoil: 'need', materialNeeds: members.slice(0, MAX_MEMBERS).flatMap(state => {
        const existing = held.get(Number(state.characterId));
        if (existing) return [{ ...existing }];
        const goal = requestOf(state);
        return goal?.status === 'open' && goal.spotId === objective.spotId && remaining(state, goal) > 0
            ? [{ characterId: Number(state.characterId), itemId: goal.itemId,
            targetId: goal.targetId, requiredTotal: goal.requiredTotal, spotId: goal.spotId,
            npcId: goal.npcId, sourceKind: goal.sourceKind, materialCash: goal.materialCash, materialSoloHours: goal.materialSoloHours,
            quota: goal.amount, collected: 0 }] : [];
    }) };
}

function departureRequest(party, state) {
    const goal = needs([state], party.stats.objective, party.stats.agreement)[0];
    if (!goal) return null;
    const { characterId, quota, collected, ...request } = goal;
    const { helpDeal, ...objective } = party.stats.objective;
    return { ...objective, ...request, attempts: positive(objective.attempts) + 1 };
}

function joint(party, members, { timestamp = Date.now(), spots } = {}) {
    const goals = needs(members, party.stats.objective, party.stats.agreement);
    const Income = require('./PartyIncomeComparison');
    let review = {};
    if (timestamp - Number(party.stats.lastIncomeReviewAt || party.startedAt || timestamp) >= Income.REVIEW_MS) {
        const prepared = Income.prepare(members, { party, objective: party.stats.objective, spots, timestamp });
        review = { lastIncomeReviewAt: timestamp, incomeReviews: members.map(member => ({ characterId: Number(member.characterId),
            ...Income.compare(member, members.filter(peer => peer !== member), { prepared, party, objective: party.stats.objective }) })) };
    }
    return { objective: { ...party.stats.objective, status: goals.length ? 'open' : 'completed' },
        memberGoals: members.map(member => ({ characterId: Number(member.characterId),
            ...goals.find(goal => goal.characterId === Number(member.characterId)) })), ...review };
}

function target(party, members) {
    if (party.stats.pveEncounter) return Number(party.stats.materialTargetNpcId || party.stats.objective.npcId || 0);
    const rows = needs(members, party.stats.objective, party.stats.agreement);
    const npcs = [...new Set(rows.map(row => Number(row.npcId)).filter(Boolean))];
    // Rotate only after a completed fight, never with the wall clock.
    return npcs.length ? npcs[Number(party.stats.fightsWon || 0) % npcs.length] : 0;
}

function selectMembers(candidates, { minSize = 2, maxSize = MAX_MEMBERS, levelRange = 4, timestamp = Date.now() } = {}) {
    const Composition = invoke('GameServer/Bot/Population/BackgroundPartyComposition');
    const Recovery = require('./PartyAssemblyRecovery');
    candidates = [...new Map(candidates.filter(state => state?.characterId && !state.stats?.coldCompetition?.wait
        && invoke('GameServer/Bot/AI/PersonalGearProgression').adventurer(state)
        && !Recovery.coolingDown(state, timestamp)).map(state => [Number(state.characterId), state])).values()];
    const cores = candidates.filter(state => requestOf(state)?.status === 'open');
    if (!cores.length) return [];
    const anchor = cores[0], spotId = requestOf(anchor).spotId;
    const core = cores.filter(state => requestOf(state).spotId === spotId
        && Math.abs(state.level - anchor.level) <= levelRange).slice(0, Math.min(MAX_CORE, maxSize));
    const supports = candidates.filter(state => Composition.supportRole(state, requestOf(state) || state.stats?.clanPartyObjective)
        && !(state.stats?.partyRequest?.status === 'deferred' && Number(state.stats.partyRequest.deferredUntil) > timestamp));
    const recruits = Composition.selectRecruits(core, supports, { maxSize: Math.min(MAX_MEMBERS, maxSize), levelRange, timestamp });
    const members = [...core, ...recruits];
    return members.length >= minSize ? members : [];
}

module.exports = { request, requestOf, isObjective, needs, remaining, supplyPause, selectMembers, agreement, departureRequest, joint, target, campsFor, partySpoiler,
    MAX_SOURCE_CHECKS, MAX_CAMPS, MAX_CORE, MAX_MEMBERS, REVIEW_MS };
