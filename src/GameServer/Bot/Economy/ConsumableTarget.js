'use strict';

// The consumable stock target: how much of each consumable (shots, potions,
// every kind a bot spends while hunting) a bot keeps. It keeps a full bag's
// use plus a small reserve: target = use per hour x hours to a full bag x
// (1 + RESERVE). The rule is the maintainer's (stock for the hunt until the
// bag is full), the reserve ours. The hours to a full bag are the first of two
// bag facts after the visit's sale: the slots fill (each caller's slot
// forecast) or the load reaches the first weight step, the stock's own weight
// counted. The stock weighs use x H x (1 + RESERVE) x mass, so its weight is
// solved for H, with room for each kind's whole unit up, and the stock never
// carries the bag to the first weight step. Pure; read by
// the game's kit rule (hot and cold), the spot table generator and the
// economy model.

// The share kept above a full bag's use: our number (small, until measured).
const RESERVE = 0.1;

// The hunting hours to the bag fact. slotHours: the caller's hours until the
// slots fill (Infinity: they never do); freeLoad: the load left under the
// bag's load limit (SurvivalFloor.loadLimit) after the sale, the consumables
// being sized not counted; loadPerHour: the drop's load an hour; stock:
// [{ use, mass }] per consumable being sized (use an hour, mass a unit).
// The load solved for keeps one unit of each kind free, the unit `target`
// rounds up, so the whole counts fit under the limit. Infinity when nothing
// bounds it.
function bagHours({ slotHours, freeLoad, loadPerHour, stock }) {
    let perHour = Math.max(0, Number(loadPerHour) || 0), room = freeLoad;
    for (const kind of stock) {
        perHour += Math.max(0, kind.use) * Math.max(0, kind.mass) * (1 + RESERVE);
        if (kind.use > 0) room -= Math.max(0, kind.mass);
    }
    if (!(room > 0)) return 0;
    return perHour > 0 ? Math.min(slotHours, room / perHour) : slotHours;
}

// The units kept of a consumable used `use` an hour over `hours` to a full bag
// (a whole unit up; the float error of x 1.1 does not add one).
function target(use, hours) {
    return use > 0 ? Math.ceil(use * hours * (1 + RESERVE) - 1e-9) : 0;
}

module.exports = { RESERVE, bagHours, target };
