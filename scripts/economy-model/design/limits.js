'use strict';

// The design's limits for a solo bot in an NPC world: every threshold and
// bound the design reads or is judged by, with its source, its reader and how
// a hit shows. Frozen rows { value, source, readBy, hit }.

const ConsumableTarget = require('../../../src/GameServer/Bot/Economy/ConsumableTarget');

const row = fields => Object.freeze(fields);
const LIMITS = Object.freeze({
    // A consumable's purchase target keeps this share above a full bag's use (the game's stock rule, ConsumableTarget).
    CONSUMABLE_RESERVE: row({ value: ConsumableTarget.RESERVE, source: 'owner 11-16, decision 364; number ours',
        readBy: 'needs.consumable (target)', hit: 'shots carried per trip in the run report' }),
    // The road's share of a bot's wall hours at levels 1-19 the design may reach.
    ROAD_SHARE_LIMIT: row({ value: 0.15, source: 'ours: the walk to and back from the starter towns, measured by the run',
        readBy: 'run report', hit: 'road hours / wall hours at levels 1-19 printed beside it' }),
    // Trips that bought none of the need they went for, as a share of consumable trips.
    EMPTY_TRIP_SHARE: row({ value: 0.05, source: 'ours: the design\'s acceptance bound',
        readBy: 'run report', hit: 'empty trips / consumable trips at levels 1-19 printed beside it' }),
    // A spot is safe for an outing when the expected deaths over the outing (deaths an hour in the form hunted, at the
    // worn kit, times the outing's horizon) are at most this many (inclusive).
    SAFE_OUTING_DEATHS: row({ value: 0.1, source: 'ours: the maintainer\'s bound, about 9 outings in 10 without a death',
        readBy: 'OutingSpot (the held spot, plane.js)', hit: 'unsafe candidates worth more than the choice (all of them when none fits), counted spotChoice.refusedUnsafe in the run report' }),
    // A species is hunted (the hunt table's reader) when a kill costs at most this many deaths.
    KILL_DEATH_LIMIT: row({ value: 0.05, source: 'ours: a C4 player leaves a mob that kills him more than once in twenty kills',
        readBy: 'hunt table reader (admission); hunt-table.js (prints, check spots)', hit: 'cells over it counted by the hunt table build' }),
    // The hunt table's rest rule: the bot fights when its HP and MP above the potion line cover this many expected fights
    // with the mob (survival ratio), else it rests (or at a whole bar).
    FIGHT_COVER: row({ value: 1, source: 'ours: a C4 player sits rather than drinks, so the fight must end above the potion line',
        readBy: 'hunt-lift.js (the readiness lift)', hit: 'rest share per body printed by the hunt table build' }),
    // Today's bots' road share of wall hours, printed beside the design's for comparison only.
    CURRENT_BOTS_ROAD_SHARE: row({ value: 0.41, source: 'a measured run of today\'s bots: target = threshold puts 41 % of the window on the road',
        readBy: 'run report (printed only)', hit: 'none: printed only' })
});

module.exports = LIMITS;
