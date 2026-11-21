'use strict';

const crypto = require('node:crypto');
const Config = require('./ClanSimulationConfig');
const Rules = require('./ClanRules');
const Roles = require('./ClanSimulationPolicy');
const Equipment = require('./ClanEquipmentPolicy');
const Capabilities = require('./ClanCandidateCapabilities');

const TRAITS = ['sociability', 'commitment', 'caution', 'ambition', 'assertiveness', 'empathy', 'resilience'];
const REASONS = ['progression', 'readiness', 'leader_preference', 'member_welfare', 'opportunity', 'recovery', 'keep_course'];
const LABELS = Object.freeze({ advance_clan: 'Develop the clan', equip_roster: 'Strengthen member equipment',
    raid_preparation: 'Prepare a raid upgrade', recruit: 'Strengthen the roster', treasury: 'Build the treasury',
    clan_hall: 'Secure a clan hall', maintain: 'Consolidate the clan' });
const n = value => Math.max(0, Number(value) || 0);
const id = member => Number(member.characterId ?? member.id);
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
const upgradeKey = target => `${Number(target.memberId)}:${Number(target.itemId)}:${Number(target.slot)}`;
function targetKey(strategy) {
    return hash([strategy.objective, strategy.target?.upgrades
        ? strategy.target.upgrades.map(upgradeKey).sort() : strategy.target]);
}
function trialReady(clan) {
    const level = require('./ClanAllianceRules').BOT_LEVEL;
    return clan.members.some(member => id(member) === Number(clan.leaderId) && member.level >= level)
        && clan.members.filter(member => member.level >= level).length >= 4;
}

function active(clan) {
    return Config.strategicManagementEnabled !== false && clan?.state?.mode === 'autonomous'
        && clan.state.strategy?.version === 1 ? clan.state.strategy : null;
}

function leader(clan) {
    const member = (clan.members || []).find(member => id(member) === Number(clan.leaderId));
    const persona = member?.persona || {};
    return { id: Number(clan.leaderId), drive: String(persona.primaryDrive || 'progression'),
        traits: Object.fromEntries(TRAITS.map(key => [key, Math.round(Math.min(1, n(persona.traits?.[key] ?? 0.5)) * 10)])) };
}

function equipped(member, target) {
    const Gear = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
    const catalog = invoke('GameServer/DataCache').items;
    return Equipment.targetFulfilled(member, { target }, Gear.equippedSlotsFor,
        itemId => require('../Item/ItemTemplateIndex').findFinite(catalog, itemId));
}

const hallRows = inputs => (inputs.halls || []).map(hall => ({ ...require('../ClanHall/Policy').definition(hall.id), ...hall }));

function summary(clan, inputs = {}) {
    const members = clan.members || [];
    const available = members.filter(member => member.phase === 'cold' && !member.partyId
        && !member.stats?.playerPartyTakeover && !member.stats?.tradeMeeting);
    const capable = (kind, pool = available) => pool.filter(member => Capabilities.contextualCapability(member, kind,
        { beneficiaries: members })).length;
    const wallet = (inputs.warehouse || []).filter(row => Number(row.selfId) === 57)
        .reduce((sum, row) => sum + Math.max(0, n(row.amount) - n(row.reservedAmount)), 0);
    const levels = members.map(member => n(member.level));
    const hall = hallRows(inputs).find(row => Number(row.ownerId) === Number(clan.id));
    const maintenance = hall ? require('../ClanHall/Policy').reserve(hall, hall.functions || {}) : 0;
    return { leader: leader(clan), level: n(clan.level), members: members.length,
        capacity: Rules.memberLimit(clan.level), available: available.length,
        levels: levels.length ? [Math.min(...levels), Math.round(levels.reduce((a, b) => a + b, 0) / levels.length), Math.max(...levels)] : [0, 0, 0],
        roles: Roles.roleCounts(members), ready: { tank: capable('tank'), healer: capable('healer'), buffer: capable('mainBuffer') },
        capable: { tank: capable('tank', members), healer: capable('healer', members), buffer: capable('mainBuffer', members) },
        wallet, maintenance, income: n(inputs.income), hallId: Number(hall?.id) || null,
        failures: Object.values(clan.state?.raidFailures || {}).reduce((sum, failure) => sum + n(failure.consecutiveFailures), 0),
        roster: members.map(member => [id(member), Number(member.classId), Math.floor(n(member.level) / 5),
            Object.values(member.inventory || {}).filter(item => item.equipped).map(item => [Number(item.selfId), Number(item.slot)]).sort(),
            member.stats?.equipmentPlan?.target?.selfId || 0]).sort((a, b) => a[0] - b[0]) };
}

function equipmentTargets(clan, inputs) {
    const plans = inputs.plans || new Map((clan.members || []).map(member => [id(member), member.stats?.equipmentPlan]));
    return [...plans].flatMap(([memberId, plan]) => {
        const member = clan.members.find(member => id(member) === Number(memberId));
        if (!member || !Equipment.isAcquisitionPlan(plan)
            || equipped(member, { itemId: Number(plan.target?.selfId), slot: Number(plan.target?.slot) })) return [];
        return [{ memberId: Number(memberId), itemId: Number(plan.target.selfId), slot: Number(plan.target.slot),
            role: Roles.rosterRole(member), route: Equipment.routeFor(plan), cost: Math.ceil(n(plan.market?.price || plan.bridgeCost)),
            effort: Math.ceil(n(plan.expectedEffort || plan.expectedKills)), sourceId: plan.next?.spotId || null,
            raid: plan.next?.raidBoss === true }];
    }).sort((a, b) => ({ healer: 0, tank: 1, buffer: 2 }[a.role] ?? 3) - ({ healer: 0, tank: 1, buffer: 2 }[b.role] ?? 3)
        || a.effort - b.effort || a.memberId - b.memberId);
}

function snapshot(clan, inputs = {}) {
    const state = summary(clan, inputs), candidates = [];
    const add = (objective, target, benefit, cost = 0) => candidates.push({ id: objective, objective, target,
        benefit, cost: Math.ceil(n(cost)), label: LABELS[objective] });
    // The live level-five quest has its own bot duties and advances independently of economic objectives.
    if (state.level < 3 || state.level === 3 && trialReady(clan)) {
        const requirement = Rules.LEVEL_REQUIREMENTS[state.level];
        add('advance_clan', { level: state.level + 1 }, 'More member capacity and clan progression',
            state.level < 2 ? require('./ClanContributionPolicy').scaledAdenaRequirement(state.level) : 0);
    }
    const targets = equipmentTargets(clan, inputs);
    if (targets.length) add('equip_roster', { upgrades: targets.slice(0, 3) }, 'Improve the weakest equipped members',
        targets.slice(0, 3).reduce((sum, row) => sum + row.cost, 0));
    const raid = targets.find(row => row.raid);
    if (raid) add('raid_preparation', { upgrades: [raid], sourceId: raid.sourceId }, 'Prepare a native raid route for a useful upgrade', raid.cost);
    const missing = ['tank', 'healer', 'buffer'].filter(role => !state.capable[role]);
    if (state.members < state.capacity) add('recruit', {
        roles: missing, members: state.capacity
    }, missing.length ? `Recruit capable ${missing.join(', ')}` : 'Build a larger stable core');
    const reserve = Math.ceil(Math.max(100000 * Math.max(1, state.level), state.maintenance * 1.5,
        state.income * (2 + state.leader.traits.caution / 5)) / 10000) * 10000;
    if (state.wallet < reserve) add('treasury', { adena: reserve }, 'Fund a reserve before discretionary spending', reserve - state.wallet);
    const lots = hallRows(inputs).filter(hall => !Number(hall.ownerId) && state.level >= 2)
        .map(hall => ({ hallId: Number(hall.id), price: n(hall.minimumBid) + require('../ClanHall/Policy').reserve(hall,
            require('../ClanHall/Policy').desired(hall, clan.members || [])) }))
        .sort((a, b) => a.price - b.price || a.hallId - b.hallId);
    if (!state.hallId && lots.length) add('clan_hall', { hallId: lots[0].hallId, adena: lots[0].price },
        'Acquire a residence with its maintenance reserve', lots[0].price);
    if (!candidates.length) add('maintain', {}, 'Continue personal progress while preserving clan resources');
    const { roster, wallet, ...compact } = state;
    const current = active(clan);
    // Raw revisions, coordinates, ordinary loot and transient party IDs do not
    // invalidate a decision. Readiness uses bands; money uses the current target.
    const moneyTarget = current?.target?.adena || reserve;
    const key = hash({ leader: state.leader, level: state.level, roster, roles: state.roles,
        ready: Object.fromEntries(Object.entries(state.ready).map(([key, value]) => [key, Math.min(2, value)])),
        funds: Math.min(4, Math.floor(wallet / Math.max(1, moneyTarget) * 4)), hall: state.hallId,
        lots: lots.map(row => row.hallId), failures: state.failures });
    return { state, candidates, key, leaderKey: hash(state.leader), context: { ...compact, wallet: Math.round(wallet),
        current: current ? { objective: current.objective, progress: current.progress, required: current.required } : null,
        recent: (current?.history || []).slice(-3), options: candidates.map(({ id, target, benefit, cost }) => ({ id, target, benefit, cost })) } };
}

function progress(strategy, clan, inputs = {}) {
    const s = summary(clan, inputs), target = strategy.target || {};
    let done = 0, required = 1, unit = 'milestone';
    switch (strategy.objective) {
        case 'advance_clan': done = n(clan.level) >= target.level ? 1 : 0;
        if (!done && n(clan.level) < 2) { required = require('./ClanContributionPolicy').scaledAdenaRequirement(clan.level);
            done = Math.min(required - 1, n(inputs.contributed)); unit = 'Adena contributed'; }
            else if (!done && clan.state.goal?.plan?.kind === 'alliance_trial')
                done = Math.min(0.95, n(clan.state.goal.progress) / Math.max(1, n(clan.state.goal.required)) * 0.95);
            break;
        case 'equip_roster': case 'raid_preparation': required = target.upgrades?.length || 1; unit = 'upgrades';
            done = (target.upgrades || []).filter(row => equipped(clan.members.find(member => id(member) === row.memberId), row)).length; break;
        case 'recruit': required = n(target.members); done = s.members; unit = 'members';
            if ((target.roles || []).some(role => !s.capable[role])) done = Math.min(done, Math.max(0, required - 1)); break;
        case 'treasury': done = s.wallet; required = n(target.adena); unit = 'Adena'; break;
        case 'clan_hall': done = s.hallId ? 1 : Math.min(0.95, s.wallet / Math.max(1, n(target.adena))); break;
        case 'maintain': break;
    }
    const complete = strategy.objective !== 'maintain' && done >= required;
    const unavailable = (target.upgrades || []).some(row => !clan.members.some(member => id(member) === row.memberId))
        || strategy.objective === 'advance_clan' && target.level === 4 && n(clan.level) === 3 && !trialReady(clan)
        || strategy.objective === 'raid_preparation'
            && require('./ClanRaidFailurePolicy').blockedSpotIds(null, clan.state).has(target.sourceId)
        || strategy.objective === 'clan_hall' && !s.hallId
            && !(inputs.halls || []).some(row => Number(row.id) === target.hallId && !Number(row.ownerId));
    return { progress: Math.min(done, required), required, unit, percent: Math.min(100, Math.floor(done / Math.max(1, required) * 100)),
        status: complete ? 'completed' : unavailable ? 'blocked' : 'active' };
}

function shouldReview(strategy, snap, status, timestamp) {
    if (!strategy) return true;
    if (strategy.leaderKey !== snap.leaderKey) return true;
    if (status.status !== 'active') return true;
    if (strategy.retryAt > timestamp) return false;
    if (strategy.lastDecisionFailed) return true;
    if (strategy.status === 'blocked') return true;
    if (strategy.executionBlockedAt && timestamp - strategy.executionBlockedAt >= Config.strategyRetryMs) return true;
    const age = timestamp - n(strategy.selectedAt), stalled = timestamp - n(strategy.progressAt || strategy.selectedAt) >= Config.strategyStallMs;
    if (age < Config.strategyMinHoldMs) return false;
    // Ordinary quote, route and roster changes do not abandon accepted work.
    return stalled && n(strategy.lastStallReviewAt) < n(strategy.progressAt || strategy.selectedAt) + Config.strategyStallMs;
}

function fallback(snap) {
    const traits = snap.state.leader.traits, drive = snap.state.leader.drive;
    const scores = { advance_clan: 3 + traits.ambition / 3, equip_roster: 3 + traits.empathy / 3,
        raid_preparation: 2 + traits.ambition / 3 - traits.caution / 4,
        recruit: 2 + traits.sociability / 3, treasury: 1 + traits.caution / 3 + (drive === 'wealth' ? 3 : 0),
        clan_hall: traits.ambition / 3, maintain: 0 };
    return [...snap.candidates].sort((a, b) => scores[b.objective] - scores[a.objective] || a.id.localeCompare(b.id))[0]
        || { id: 'maintain', objective: 'maintain', target: {}, label: LABELS.maintain };
}

function spendingAllowed(clan, kind) {
    const strategy = active(clan);
    if (!strategy || strategy.status !== 'active') return true;
    if (strategy.objective === 'treasury') return false;
    if (strategy.objective === 'clan_hall') return ['hall', 'hall_upgrade'].includes(kind);
    if (['equip_roster', 'raid_preparation'].includes(strategy.objective)) return kind === 'equipment';
    if (strategy.objective === 'advance_clan') return kind === 'level';
    return false;
}

function selection(clan, plans, original) {
    const strategy = active(clan);
    if (!strategy || !['equip_roster', 'raid_preparation'].includes(strategy.objective)) return original;
    for (const target of strategy.target.upgrades || []) {
        const member = clan.members.find(member => id(member) === target.memberId), plan = plans.get(target.memberId);
        if (member && Equipment.isAcquisitionPlan(plan) && Number(plan.target.selfId) === target.itemId
            && (strategy.objective !== 'raid_preparation' || plan.next?.spotId === strategy.target.sourceId)
            && !equipped(member, target)) return { member, plan, selectedBy: 'clan_strategy' };
    }
    return null;
}

module.exports = { LABELS, REASONS, active, leader, summary, snapshot, progress, shouldReview, fallback, spendingAllowed, selection,
    trialReady, hash, targetKey, upgradeKey, equipped };
