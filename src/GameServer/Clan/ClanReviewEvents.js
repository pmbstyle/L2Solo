'use strict';

// Addressed planning inputs, never clan/member snapshots. Native rows stay in
// the lifecycle and warehouse; this queue only remembers which clan to visit.
const dirty = new Map();
const members = new Map();
const changedMembers = new Map();
const items = new Map();
const clanItems = new Map();
const listeners = new Set();
let unsubscribeLife = null, unsubscribeBoard = null;
let wake = null;

function changed(clanId, cause = 'clan_input') {
    const id = Number(clanId);
    if (!Number.isSafeInteger(id) || id <= 0) return false;
    const causes = dirty.get(id) || new Set();
    causes.add(cause); dirty.set(id, causes);
    for (const listener of listeners) {
        try { listener(id, cause); } catch (error) { global.utils?.infoWarn?.('ClanReview', '%s', error?.message || error); }
    }
    try { wake?.(); } catch (error) { global.utils?.infoWarn?.('ClanReview', '%s', error?.message || error); }
    return true;
}

function fingerprint(state) {
    if (!state) return null;
    const stats = state.stats || {};
    const plan = stats.equipmentPlan;
    return JSON.stringify([state.level, state.exp, state.sp, state.adena, state.phase, state.partyId,
        stats.clanId, stats.classId, state.inventory, plan && [plan.target, plan.strategy, plan.status, plan.clanGoal?.goalKey], stats.marketErrand,
        stats.lastErrand, stats.clanGoal, stats.persona]);
}

function observe(packet) {
    if (packet.kind === 'reset') {
        for (const id of clanItems.keys()) changed(id, 'lifecycle_reset');
        members.clear(); changedMembers.clear(); return;
    }
    const id = Number(packet.characterId);
    const next = fingerprint(packet.state), before = members.get(id);
    if (next === before) return;
    if (next === null) members.delete(id); else members.set(id, next);
    for (const state of [packet.previousState, packet.state]) {
        if (Number(state?.stats?.clanId) > 0) changed(state.stats.clanId, 'member');
    }
    // Native characters.clanId is the membership authority when an old state
    // has no clan metadata (including hydration).
    changedMembers.set(id, {}); wake?.();
}

function track(clan) {
    const id = Number(clan?.id);
    if (!(id > 0)) return;
    const previous = clanItems.get(id) || new Set();
    const wanted = new Set();
    for (const goal of [clan.state?.goal, clan.state?.productionGoal]) {
        if (goal?.status === 'completed') continue;
        const itemId = Number(goal?.target?.itemId || goal?.target?.selfId);
        if (itemId > 0) wanted.add(itemId);
        for (const item of goal?.plan?.craft?.materials || []) if (Number(item.selfId) > 0) wanted.add(Number(item.selfId));
    }
    // The durable clan goal names its final item; actual material/part needs
    // live on the beneficiary's original equipment plan.
    for (const member of clan.members || []) {
        const plan = member.stats?.equipmentPlan;
        for (const itemId of [plan?.target?.selfId, plan?.next?.itemId]) {
            if (Number(itemId) > 0) wanted.add(Number(itemId));
        }
        for (const item of plan?.materials || []) if (Number(item.selfId) > 0) wanted.add(Number(item.selfId));
    }
    if (Number(clan.level) === 2) wanted.add(require('./ClanRules').LEVEL_REQUIREMENTS[2].itemId);
    for (const itemId of previous) {
        if (wanted.has(itemId)) continue;
        const group = items.get(itemId); group?.delete(id); if (!group?.size) items.delete(itemId);
    }
    for (const itemId of wanted) {
        const group = items.get(itemId) || new Set(); group.add(id); items.set(itemId, group);
    }
    clanItems.set(id, wanted);
}

function boardChanged(change) {
    if (change.reset || change.ready === true && !change.selfIds) {
        for (const id of clanItems.keys()) changed(id, 'board');
    } else {
        for (const itemId of change.selfIds || []) for (const id of items.get(Number(itemId)) || []) changed(id, 'board');
    }
}

async function drain(database, limit = 64) {
    const pending = [...changedMembers].slice(0, limit);
    const ids = pending.map(([id]) => id);
    if (ids.length) {
        const rows = await database.execute([`SELECT DISTINCT members.clanId FROM characters members
            JOIN clan_simulation_clans simulated ON simulated.clanId=members.clanId
            WHERE members.id IN (${ids.map(() => '?').join(',')})`, ids], 'clan-review:changed-members');
        pending.forEach(([id, token]) => { if (changedMembers.get(id) === token) changedMembers.delete(id); });
        for (const row of rows) changed(row.clanId, 'member');
    }
    const result = [...dirty].slice(0, limit).map(([clanId, causes]) => ({ clanId, causes: [...causes] }));
    result.forEach(event => dirty.delete(event.clanId));
    return result;
}

function start(life, board, onWake) {
    wake = onWake;
    if (!unsubscribeLife) unsubscribeLife = life.subscribePublications(observe, { replay: true });
    if (!unsubscribeBoard) unsubscribeBoard = board.subscribeBoardChanges(boardChanged);
}

function stop() {
    unsubscribeLife?.(); unsubscribeBoard?.(); unsubscribeLife = unsubscribeBoard = null; wake = null;
    members.clear(); changedMembers.clear(); dirty.clear(); items.clear(); clanItems.clear();
}

module.exports = { changed, track, start, stop, drain, pending: () => dirty.size + changedMembers.size,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
