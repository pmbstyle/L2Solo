'use strict';

// What an hour of a design bot is worth, in hours of value: its exp over the
// line's best exp an hour at its level, its NPC income (adena, drop and spoil
// at the NPC's price) over the line's best income an hour there, weighted by
// its persona. The best hours are its line's top rows with shots (static
// spot-table data). The weights come from the persona alone (the game's
// powerWeight, without the wallet: a value held between decisions would go
// stale with every purchase if it moved with money). No road and no deaths
// enter it: a spot's deaths are the outing spot rule's safety bound, and where
// the bot stands does not rank the spots. deathCost is the price of an hour's
// deaths (its level's death exp and the way back from the respawn town to the
// held spot; the row's death rate already holds the respawn wait), read only
// by the formula variant of supply. Read by that variant and by the held
// spot's candidates (plane.js); pure on the view and plain data.
const Engine = require('../engine');
const EconomicValuation = require('../../../src/GameServer/Bot/Economy/EconomicValuation');

// The weight of money in an hour's value; exp takes the rest.
const moneyWeight = persona => 1 / (1 + EconomicValuation.powerWeight(persona));

// { exp, npc }: the line's best exp and best NPC income an hour at a level
// with shots. Held per view, line and level (its inputs).
const bests = new WeakMap();
function bestOf(view, main) {
    if (!bests.has(view)) bests.set(view, new Map());
    const held = bests.get(view), key = `${main.line}@${main.level}`;
    if (held.has(key)) return held.get(key);
    // Past the hunting table's last row with shots (its range end), the
    // nearest lower level's best stands in (a stub for long runs).
    const out = { exp: 0, npc: 0 };
    for (let level = main.level; level >= 1 && !(out.exp > 0 && out.npc > 0); level--) {
        for (const row of view.hours[main.line]?.[level]?.top || []) {
            out.exp = Math.max(out.exp, row.exp);
            out.npc = Math.max(out.npc, Engine.rowItems(view, { ...main, level }, row, 'shots').npc);
        }
    }
    if (!(out.exp > 0) || !(out.npc > 0)) throw new Error(`no best hour with shots for line ${main.line} at level ${main.level}`);
    held.set(key, out);
    return out;
}

// The hour's value at the main's spot row in a form ('bare', 'shots',
// 'blessed'; factors: the worn kit's { kills, deaths } per form against the
// line's reference kit). withoutDrop: the same hour with a full bag, its items
// not taken (adena and exp stay; the engine's hunt, full).
function hourValue(view, main, form, factors, persona, { withoutDrop = false } = {}) {
    const row = Engine.spotRowOf(view, main), hour = Engine.rowIn(row, form), factor = factors[form];
    const best = bestOf(view, main), wMoney = moneyWeight(persona);
    const items = Engine.rowItems(view, main, row, form);
    const exp = Engine.huntExp(main, hour, 1) * factor.kills;
    const income = (withoutDrop ? items.adena : items.npc) * factor.kills;
    return exp / best.exp * (1 - wMoney) + income / best.npc * wMoney;
}

// The price of an hour's deaths at the main's spot row in a form, in hours of
// value: each death loses its level's death exp (over the best exp an hour)
// and wayBackHours, the trip from the respawn town back to the held spot.
function deathCost(view, main, form, factors, wayBackHours) {
    const hour = Engine.rowIn(Engine.spotRowOf(view, main), form);
    return (hour.deaths || 0) * factors[form].deaths * (Engine.tripLeg(wayBackHours, 'the way back from the respawn town') + view.deathExp[main.level - 1] / bestOf(view, main).exp);
}

module.exports = { moneyWeight, hourValue, deathCost, bestOf };
