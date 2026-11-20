'use strict';

// What a design bot needs and what it can spare, on its engine state (the
// main: { shots: { id: count }, bag: { id: count } }; the worn kit is never in
// the bag). Pure; called by the design plane when it builds a decision's state.
const Engine = require('../engine');
const { SHOT_LINE_HOURS } = require('../today');
const BeginnerShots = require('../../../src/GameServer/Items/C4BeginnerShots');
const ConsumableTarget = require('../../../src/GameServer/Bot/Economy/ConsumableTarget');

// The consumable the bot fires at its row (firing: { id, perHour, beginner },
// null when its line fires nothing there): its purchase target is the game's
// stock rule (ConsumableTarget): its use over the hunting hours to a full bag
// after the visit's sale, plus the reserve, at least the line (an hour's use,
// the game's survival line); fill: { slotHours, freeLoad, loadPerHour, mass }
// the plane reads at the held spot. held is what it can fire of it (the
// beginner shots that charge it counted: Engine.heldOf), short what it lacks
// to it (below 0: it holds more than a full bag's use).
function consumable(main, firing, fill) {
    if (!firing) return null;
    const hours = ConsumableTarget.bagHours({ slotHours: fill.slotHours, freeLoad: fill.freeLoad, loadPerHour: fill.loadPerHour,
        stock: [{ use: firing.perHour, mass: fill.mass }] });
    if (!Number.isFinite(hours)) throw new Error(`no bag fact bounds the stock of ${firing.id}: no slot forecast and no weight`);
    const target = Math.max(Math.ceil(firing.perHour * SHOT_LINE_HOURS), ConsumableTarget.target(firing.perHour, hours));
    const held = Engine.heldOf(main, firing);
    return { id: firing.id, perHour: firing.perHour, hours, target, held, short: target - held };
}

// [[id, count]] the bot can spare: every bag item (its drop and the creation
// items it does not wear) and every shot it does not fire (an older grade
// after a weapon change, another kind); never a restricted item (the beginner
// shots: no sale, trade or drop, BeginnerShots.isRestricted). The shot the
// held weapon fires is kept whole: the target bounds purchases, not what it
// keeps (the game's ShotStock.keptAmounts: personal ammunition stays usable
// when the hunt forecast or the bag interval shrinks).
function surplus(main, need) {
    const out = new Map();
    const add = (id, count) => { if (count > 0 && !BeginnerShots.isRestricted(id)) out.set(Number(id), (out.get(Number(id)) || 0) + count); };
    for (const [id, count] of Object.entries(main.bag)) add(id, count);
    for (const [id, count] of Object.entries(main.shots)) if (!need || Number(id) !== need.id) add(id, count);
    return [...out];
}

module.exports = { consumable, surplus };
