'use strict';
// The cold simulation's conservation laws, checked on a recorded hunt. A C4
// player's time is one line and his HP moves only by what he lives: every
// millisecond of a hunt is credited once (a fight, a walk, a rest, a death or
// idle), every regen interval credits its posture's rate times its length
// (capped only by the bar), every stamp a step writes lies in the interval it
// is credited to, loot never takes the bag past its slots, and a row's fight
// and rest fit in its hour per kill.
// Callers: tests/test_cold_sim_invariants.js (the generator's hunt on a fixed
// sample), tests/test_spot_table_generator.js (the built table through the
// reader), tests/test_economy_model_hunt_table.js (the model's hunt table).
// Pure: plain records in, violations out; the recording is the caller's.
//
// A hunt record: { steps: [step], sum } where sum is the generator's hunt sum
// (Generator.hunt) and each step, in the order resolved:
//   t, elapsedMs: the step's moment and the time it credits before it;
//   round: a hunting round (debug.combatMs set); combatMs, walkedMs, seatedMs;
//   doneAt: its last action's end (0: none); restUntil, nextResolveAt: its stamps forward;
//   before/after: { activity, hp, mp, maxHp, maxMp } of the bot;
//   intervals: [{ at, ms, rate: { hp, mp } | null, before: { hp, mp, maxHp, maxMp }, after: { hp, mp } }],
//     every span the step's clock credited regen over (ColdClock), in order;
//   changes: [{ kind, before: { hp, mp }, after: { hp, mp } }], every call that changed the
//     bot's vitals, in order and not nested: a regen interval (kind standing, moving, seated)
//     or a call outside the clock (fight, potion, heal, buff, ready, respawn);
//   opens: the moments its round clocks opened at;
//   gained: loot stacks it added; bag: { slots, slotLimit } after it.

// Rows and stamps carry whole milliseconds; the regen bars carry floats.
const MS = 1;
const VITALS_EPS = 1e-6;
// The HP and MP a balance may miss by: float sums over a hunt's changes.
const BALANCE_EPS = 1e-6;

const add = (violations, kind, step, detail) => violations.push({ kind, step, detail });

// The step's credited interval: from the bot's clock (t - elapsed) to where
// its last action ended (before its moment when a death or a crossing ended
// the round there), or its moment: the lifecycle's clock rule.
function span(step) {
    const from = step.t - step.elapsedMs;
    return { from, to: Number(step.doneAt) > 0 ? Math.ceil(Number(step.doneAt)) : step.t };
}

// Each step goes on from where the previous one ended, so the credited
// intervals chain from the first step's clock to the last one's end: no
// millisecond twice, none skipped. A round's own parts (fight with its walks,
// seated rest) fit in it, the rest idle. A rest step's interval is rest, a
// dead bot's death. The last step's rest past its end is what the next step
// would credit it as: death when it leaves the bot dead or starts its revive's
// rest, else rest.
function tileTime(hunt, violations) {
    const parts = { fight: 0, walk: 0, rest: 0, death: 0, other: 0 };
    const steps = hunt.steps;
    let prevEnd = null, tail = 0;
    // The rest a revive starts (the dead step's) is the death's recovery.
    const recovers = (previous, activity) => activity === 'dead' || (previous === 'dead' && activity === 'resting');
    steps.forEach((step, index) => {
        const revived = recovers(index > 0 ? steps[index - 1].before.activity : null, step.before.activity);
        const { from, to } = span(step);
        if (prevEnd !== null && Math.abs(from - prevEnd) > MS) {
            add(violations, from < prevEnd ? 'time.twice' : 'time.skipped', index, `credits from ${from}, the previous step ended at ${prevEnd}`);
        }
        prevEnd = to;
        const length = to - from;
        if (step.round) {
            const idle = length - step.combatMs - step.seatedMs;
            if (idle < -MS) add(violations, 'time.twice', index, `round of ${length} ms credits ${step.combatMs} combat + ${step.seatedMs} seated`);
            if (step.walkedMs > step.combatMs + MS) add(violations, 'time.twice', index, `walk ${step.walkedMs} ms past combat ${step.combatMs} ms`);
            parts.fight += step.combatMs - step.walkedMs;
            parts.walk += step.walkedMs;
            parts.rest += step.seatedMs;
            parts.other += idle;
        } else if (revived) parts.death += length;
        else if (step.before.activity === 'resting') parts.rest += length;
        else parts.other += length;
        tail = index === steps.length - 1 ? Math.max(0, (Number(step.restUntil) || 0) - to) : 0;
    });
    const last = steps[steps.length - 1];
    if (last) parts[recovers(last.before.activity, last.after.activity) ? 'death' : 'rest'] += tail;
    return { parts };
}

// The generator's own sums (what a row records) against the tiling: its fight
// and rest are the tiled ones, and fight + rest + death leave a non-negative
// idle in its span.
function generatorTime(hunt, tiled, violations, rounding) {
    const sum = hunt.sum;
    if (!sum) return null;
    const slack = Math.max(MS * hunt.steps.length, rounding * sum.spanMs);
    const fight = tiled.parts.fight + tiled.parts.walk, rest = tiled.parts.rest;
    if (Math.abs(sum.fightMs - fight) > slack) add(violations, 'time.generator', -1, `generator fight ${sum.fightMs} ms, tiled ${fight} ms`);
    if (Math.abs(sum.restMs - rest) > slack) add(violations, 'time.generator', -1, `generator rest ${sum.restMs} ms, tiled ${rest} ms`);
    const other = sum.spanMs - sum.fightMs - sum.restMs - tiled.parts.death;
    if (other < -slack) add(violations, 'time.twice', -1, `generator fight ${sum.fightMs} + rest ${sum.restMs} + death ${tiled.parts.death} ms past its span ${sum.spanMs} ms`);
    return { other };
}

// Stamps: a round's clock opens at the step's clock and its regen intervals
// follow one another inside the credited interval; its last action ends in it;
// a rest it starts ends after it, and so does the next step.
function checkStamps(hunt, violations) {
    hunt.steps.forEach((step, index) => {
        const { from, to } = span(step);
        for (const at of step.opens) if (Math.abs(at - from) > MS) add(violations, 'stamp.outside', index, `round clock opens at ${at}, its interval at ${from}`);
        let at = step.round && step.opens.length ? from : null;
        for (const interval of step.intervals) {
            if (interval.at < from - MS || interval.at + interval.ms > to + MS) {
                add(violations, 'stamp.outside', index, `regen interval ${interval.at}+${interval.ms} outside ${from}-${to}`);
            }
            if (at !== null && step.round && Math.abs(interval.at - at) > MS) add(violations, interval.at > at ? 'time.uncovered' : 'time.twice', index, `regen interval at ${interval.at}, the clock at ${at}`);
            if (at !== null) at = interval.at + interval.ms;
        }
        if (step.round && step.opens.length && at !== null && step.after.activity !== 'dead' && Math.abs(to - at) > MS) {
            add(violations, 'time.uncovered', index, `round lived ${at - from} of its ${to - from} ms in a posture`);
        }
        if (step.doneAt && step.doneAt < from - MS) add(violations, 'stamp.outside', index, `last action ends at ${step.doneAt}, before its interval ${from}`);
        if (step.restUntil && step.restUntil < to - MS && step.after.activity === 'resting') add(violations, 'stamp.outside', index, `rest ends at ${step.restUntil}, before its round's end ${to}`);
        if (step.nextResolveAt && step.nextResolveAt < to - MS) add(violations, 'stamp.outside', index, `next step at ${step.nextResolveAt}, before this one's end ${to}`);
    });
}

// Each regen interval credits its rate times its length, capped by the bar,
// no more and no less.
function checkVitals(hunt, violations, tickMs) {
    hunt.steps.forEach((step, index) => {
        for (const interval of step.intervals) {
            const got = { hp: interval.after.hp - interval.before.hp, mp: interval.after.mp - interval.before.mp };
            if (!interval.rate) continue;
            for (const bar of ['hp', 'mp']) {
                const max = bar === 'hp' ? interval.before.maxHp : interval.before.maxMp;
                const due = Math.min(max, interval.before[bar] + interval.rate[bar] * interval.ms / tickMs) - interval.before[bar];
                if (Math.abs(got[bar] - due) > VITALS_EPS * Math.max(1, due)) {
                    add(violations, 'vitals.rate', index, `${bar} credited ${got[bar]} over ${interval.ms} ms, rate x ms capped ${due}`);
                }
            }
        }
    });
}

const differs = (a, b) => Math.abs(a.hp - b.hp) > BALANCE_EPS || Math.abs(a.mp - b.mp) > BALANCE_EPS;

// HP and MP move only by the changes a step records: each change starts from
// the vitals the previous one left, or from the vitals it was handed when the
// step dropped its result (a dead bot's body is not worn; a living bot that
// drops one loses it); the step ends at the last one's. Steps follow one
// another's vitals. So a hunt's HP lost to its fights and casts equals its
// regen (standing, moving, seated), bottles, heals and respawns plus its start
// minus its end. Returns that balance per kind: { hp: { kind: sum }, mp, start, end },
// a move no change accounts for under the kind unaccounted.
function checkBalance(hunt, violations) {
    const balance = { hp: {}, mp: {}, start: null, end: null };
    const credit = (change) => {
        for (const bar of ['hp', 'mp']) balance[bar][change.kind] = (balance[bar][change.kind] || 0) + change.after[bar] - change.before[bar];
    };
    let previous = null;
    hunt.steps.forEach((step, index) => {
        if (previous && differs(step.before, previous.after)) {
            credit({ kind: 'unaccounted', before: previous.after, after: step.before });
            add(violations, 'vitals.between', index, `starts at ${step.before.hp} HP ${step.before.mp} MP, the previous step left ${previous.after.hp} HP ${previous.after.mp} MP`);
        }
        let held = step.before, pending = null;
        // The vitals the next probe sees settle the pending change: worn, dropped or neither.
        const settle = (seen, what) => {
            if (pending && !differs(seen, pending.after)) credit(pending);
            else if (pending && !differs(seen, pending.before)) {
                if (step.after.activity !== 'dead') add(violations, 'vitals.dropped', index, `${pending.kind} of ${pending.after.hp - pending.before.hp} HP ${pending.after.mp - pending.before.mp} MP not worn`);
            } else {
                // Taken as worn, the rest of the move is the balance's unaccounted.
                if (pending) credit(pending);
                const from = pending ? pending.after : held;
                credit({ kind: 'unaccounted', before: from, after: seen });
                add(violations, 'vitals.unaccounted', index, `${what} sees ${seen.hp} HP ${seen.mp} MP, ${pending ? `the ${pending.kind} left` : 'the step began at'} ${from.hp} HP ${from.mp} MP`);
            }
            held = seen;
        };
        for (const change of step.changes) {
            if (pending || differs(change.before, held)) settle(change.before, change.kind);
            pending = change;
        }
        if (pending || differs(step.after, held)) settle(step.after, 'the step\'s end');
        if (index === 0) balance.start = { hp: step.before.hp, mp: step.before.mp };
        balance.end = { hp: step.after.hp, mp: step.after.mp };
        previous = step;
    });
    return balance;
}

// Loot never takes the bag past its slots.
function checkLoot(hunt, violations) {
    hunt.steps.forEach((step, index) => {
        if (step.gained > 0 && step.bag && step.bag.slots > step.bag.slotLimit) {
            add(violations, 'loot.slots', index, `${step.bag.slots} slots after loot, the bag holds ${step.bag.slotLimit}`);
        }
    });
}

// A row's (or a reader's cell's) fight + rest fit in its hour per kill.
// cell: { kph, fight, rest } (seconds per kill).
function overHour(cell, rounding) {
    return cell.fight + cell.rest > 3600 / cell.kph * (1 + rounding);
}

// Kills, deaths and rest per kill: finite and non-negative.
function checkNumbers(row, violations) {
    if (!row) return;
    for (const name of ['kph', 'deaths', 'rest', 'fight']) {
        if (!Number.isFinite(row[name]) || row[name] < 0) add(violations, 'numbers.invalid', -1, `${name} ${row[name]}`);
    }
}

// Every law on one hunt. row: the generator's row of it (Generator.perKill),
// null when it killed nothing. Returns { violations, parts, other, balance }.
function checkHunt(hunt, { row = null, tickMs, rounding }) {
    const violations = [];
    const tiled = tileTime(hunt, violations);
    const generator = generatorTime(hunt, tiled, violations, rounding);
    checkStamps(hunt, violations);
    checkVitals(hunt, violations, tickMs);
    const balance = checkBalance(hunt, violations);
    checkLoot(hunt, violations);
    checkNumbers(row, violations);
    if (row && overHour(row, rounding)) add(violations, 'row.overHour', -1, `fight ${row.fight} + rest ${row.rest} s past ${3600 / row.kph} s`);
    return { violations, parts: tiled.parts, other: generator?.other ?? null, balance };
}

// The model's hunt table (HuntTable: { fields, cells: body -> spot -> species
// -> [form cells] }): every cell's kills and deaths finite and non-negative;
// a cell with a kill keeps its other time above the rounding and its fight +
// rest + other + walk is its hour per kill (3600 / kills), within the
// rounding. Returns the violations, each naming its cell.
function checkTable(table, { rounding }) {
    const violations = [];
    const at = Object.fromEntries(table.fields.map((field, index) => [field, index]));
    for (const [body, bySpot] of Object.entries(table.cells)) {
        for (const [spotId, bySpecies] of Object.entries(bySpot)) {
            for (const [selfId, forms] of Object.entries(bySpecies)) {
                forms.forEach((cell, form) => {
                    const flag = (kind, detail) => violations.push({ kind, cell: `${body} ${spotId}/${selfId} form ${form}`, detail });
                    const kills = cell[at.kills], deaths = cell[at.deaths];
                    if (!Number.isFinite(kills) || kills < 0) return flag('numbers.invalid', `kills ${kills}`);
                    if (kills === 0) return;
                    if (!Number.isFinite(deaths) || deaths < 0) flag('numbers.invalid', `deaths ${deaths}`);
                    const hour = 3600 / kills, partList = [cell[at.fight], cell[at.rest], cell[at.other], cell[at.walk]], parts = partList.reduce((a, b) => a + b, 0);
                    // round() keeps 4 significant digits (error up to 5e-4 of the value): each part and the hour carry that.
                    const tolerance = 5e-4 * (hour + partList.reduce((a, b) => a + Math.abs(b), 0));
                    if (cell[at.other] < -rounding * hour) flag('cell.otherNegative', `other ${cell[at.other]} s of ${hour} s a kill`);
                    if (!(Math.abs(parts - hour) <= tolerance)) flag('cell.untiled', `fight + rest + other + walk ${parts} s, the hour per kill ${hour} s`);
                });
            }
        }
    }
    return violations;
}

module.exports = { checkHunt, checkTable, overHour };
