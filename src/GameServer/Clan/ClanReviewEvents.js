'use strict';

// Addressed planning inputs, never clan/member snapshots. Native rows stay in
// the lifecycle and warehouse; this queue only remembers which clan to visit.
const dirty = new Map();
const items = new Map();
const clanItems = new Map();
const listeners = new Set();
let unsubscribeBoard = null, generation = 0;
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

function tracks(clanId, selfId) { return clanItems.get(Number(clanId))?.has(Number(selfId)) === true; }
function trackedItems(clanId) { return clanItems.get(Number(clanId)) || []; }
function committedMember(previous = {}, state = {}) {
    const clanId = Number(state.stats?.clanId || 0);
    if (!(clanId > 0)) return;
    if (Number(state.level) > Number(previous.level)) changed(clanId, 'member_level');
    for (const itemId of trackedItems(clanId)) {
        if ((Number(previous.inventory?.[itemId]?.amount || 0) > 0) !== (Number(state.inventory?.[itemId]?.amount || 0) > 0)) {
            changed(clanId, 'member_item'); break;
        }
    }
}
async function drain(_database, limit = 64) {
    const result = [...dirty].slice(0, limit).map(([clanId, causes]) => ({ clanId, causes: [...causes] }));
    result.forEach(event => dirty.delete(event.clanId));
    return result;
}
async function start(_life, board, onWake) {
    wake = onWake;
    if (unsubscribeBoard) return;
    const token = ++generation;
    unsubscribeBoard = board.subscribeBoardChanges(boardChanged);
    const clans = await invoke('GameServer/Clan/ClanSimulationService').autonomousClanProjection();
    if (token !== generation) return;
    for (const clan of clans) changed(clan.id, 'startup');
}

function stop() {
    generation++; unsubscribeBoard?.(); unsubscribeBoard = null; wake = null;
    dirty.clear(); items.clear(); clanItems.clear();
}

module.exports = { changed, track, tracks, trackedItems, committedMember, start, stop, drain, pending: () => dirty.size,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
