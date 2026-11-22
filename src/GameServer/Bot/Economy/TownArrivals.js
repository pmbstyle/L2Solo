'use strict';
// The bots' town arrivals per town and grade group since the server started (read by
// SupplierRoles.storeTown: a supplier sits where the bots it serves come to shop). One
// arrival is one arrived_town situation: a far bot's step that leaves the field for a
// town visit (Situations.arrivesInTown, counted at its commit on main: BotLifeState's
// committed-state publication) and a near body's arrival in town (ShoppingState.arrive).
// It counts under the town the bot arrived in and the grade group its level wears
// (GearGradeRule: 'd', or 'c+' for C and above); a no-grade bot and a service bot (a
// craft station or station trader) count nowhere. Main only, O(1) per arrival; the worker
// keeps none (a supplier's store town is decided on main and held in its state).
const counts = new Map();

// A grade's group: 'd', 'c+' (C and above), else null.
function gradeGroup(grade) {
    const value = String(grade || '').toLowerCase();
    return value === 'd' ? 'd' : ['c', 'b', 'a', 's'].includes(value) ? 'c+' : null;
}
// The key `${town}|${group}` an arrival of this state in this town counts under, else null.
function keyOf(state, town) {
    const stats = state?.stats || {};
    if (!town || stats.stationTrader || stats.craftStationId || stats.craftShop) return null;
    const group = gradeGroup(invoke('GameServer/Bot/AI/GearGradeRule').gradeForLevel(state?.level));
    return group ? `${town}|${group}` : null;
}
// A bot's arrival in a town (its state as it arrives).
function arrived(state, town) {
    const key = keyOf(state, town);
    if (key) counts.set(key, (counts.get(key) || 0) + 1);
}
// A committed far step (previous -> state): an arrival when it raised arrived_town. A near
// body's row going far is no arrival (its body counted its own).
function committed(previous, state) {
    if (previous?.phase === 'cold' && state && invoke('GameServer/Bot/Situations').arrivesInTown(previous, state)) {
        arrived(state, state.currentRegion);
    }
}
// The arrivals of a grade group per town: Map town -> arrivals.
function arrivals(group) {
    const result = new Map();
    for (const [key, units] of counts) {
        const at = key.lastIndexOf('|');
        if (key.slice(at + 1) === group) result.set(key.slice(0, at), units);
    }
    return result;
}
function reset() { counts.clear(); }

module.exports = { gradeGroup, keyOf, arrived, committed, arrivals, reset };
