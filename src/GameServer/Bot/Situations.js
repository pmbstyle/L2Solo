'use strict';

// The situations a bot hears and the decisions they wake: one catalogue for both
// threads (main's raises, the worker's steps; situations.md §14). A bot holds its
// decisions; a situation raised (raise, the one writer of the bits) wakes the ones that
// declare it, heard where the bot stands (NOW, its next STOP, in TOWN); a decision runs
// only woken and clears its bit when it is taken (decided). A new rule is a row here.

const Trace = require('./DecisionTrace');
const Stall = require('./AI/GearStall');
const FIELD_ACTIVITIES = new Set(['hunting', 'resting', 'traveling']);

// Places, as bits of a link's waits. OPEN hears everything: a body near a player, a
// far bot the step it arrives in town. A far bot: WORK on a hunt, the road or in a
// party's fight, REST, VISIT a town visit past its first look, STAND anywhere else (a
// stall, a craft, a meeting).
// BODY: a body near a player in the field (bodyPlace): it hears its build's
// sections at once as OPEN (no row waits on it), its decisions as a far bot at
// work; its stop is its rest's end (DecisionEvents.stop).
const OPEN = 0, WORK = 1, REST = 2, VISIT = 4, STAND = 8, BODY = 16;
const FIELD = WORK | REST, GATED = FIELD | VISIT | STAND;
const NAMES = new Map([[OPEN, 'open'], [WORK, 'work'], [REST, 'rest'], [VISIT, 'visit'], [STAND, 'stand'], [BODY, 'body']]);

// before: the state a step left, read for the one moment that is a change of place:
// arriving in town, where what waited in the field is heard, once.
function place(state, before = null) {
    if (state.phase !== 'cold') return OPEN;
    if (state.stats?.tradeMeeting) return STAND;
    if (state.activity === 'hunting' || state.activity === 'traveling' || state.activity === 'grouped') return WORK;
    if (state.activity === 'resting') return REST;
    if (state.activity === 'shopping') return before && FIELD_ACTIVITIES.has(before.activity) ? OPEN : VISIT;
    return STAND;
}
// Where a body near a player hears its decisions: in the field (a hunt, a rest, the
// road, a party's fight) as at work, elsewhere (a town, a stall) everything.
const bodyPlace = state => FIELD_ACTIVITIES.has(state?.activity) || state?.activity === 'grouped' ? BODY : OPEN;
// A place under the rule (far, not arriving), and one in the field.
const gated = where => !!(where & GATED);
const field = where => !!(where & FIELD);
const reactive = state => gated(place(state));
// On a visit past its look a bot works down what the look decided: what ended a step of
// the agenda moves the plan to the next (goal_done:visit / goal_failed:visit).
const onVisit = state => place(state) === VISIT;
// Which step reads its facts: a hunt's round, a far party's round, and the step that
// arrives in town: its one look.
function readsFacts(before, after) {
    return before.activity === 'hunting'
        || gated(place(before)) && (before.activity === 'grouped' || !place(after, before));
}

// The planes a far bot hears a situation on (a row's heard): NOW anywhere, STOP at
// its next stop (a rest or the town), TOWN in town only (situations.md §10).
const NOW = 0, STOP = 1, TOWN = 2;
const link = (waits, heard = NOW) => Object.freeze({ waits, heard });

// Every situation a bot can hear: the places a far bot does not hear it at (waits:
// read by hears(): the soft point and the plan's own moves, until step 4 C7) and the
// plane a far bot hears it on (heard: NOW, at its next STOP, in TOWN). The decisions
// each wakes are declared below (DECISIONS).
const SITUATIONS = Object.freeze({
    // Its own state (detect). A level moved, or the rest of the kit (worn gear,
    // hennas, skills, class, the craft): read apart, a level up wins a step that moved both.
    level_up: link(WORK | VISIT, STOP),
    gear_changed: link(WORK | VISIT, TOWN),
    recipe_learned: link(WORK | VISIT, STOP),
    died: link(0),
    // A hot body's respawn in town (BotAI): its town arrival follows as its own.
    revived: link(0),
    // Its clan joined, left or changed (detect's clan fact): heard at its next stop. Its
    // friends and enemies wake nothing (Q13): they are read when it decides.
    clan_changed: link(WORK | VISIT, STOP),
    party_joined: link(0),
    party_left: link(0),
    // A contest lost at its arrival on a spot (SpotContest: it avoids the units standing
    // there; payload { spotId, reason: 'contest_lost' }: its spot mark, raisedFacts).
    contest_lost: link(0),
    // The spot's own (subject: the spot, traced, raised on no bot): a contest at an
    // arrival (SpotContest), a grievance pair met there (step 2 S4).
    spot_contested: link(0),
    enemy_met: link(0),
    // What main refused at the act or a body that failed its step five times: the plan
    // cannot stand.
    goal_failed: link(0),
    // The gear plan's craft route collected nothing for its stall's kills (the far
    // kill count crossed equipmentPlan.stall, GearAcquisitionPlanner.stallCrossed).
    source_stalled: link(0),
    // What an executor proved of the held plan where it acts: its goal reached (a
    // purchase landed, a material hunt's count, a paid piece waits for its exchange);
    // a town visit's step done or refused (the visit's own check, a review main could
    // not run): the agenda moves on (Agenda.advance, temporary until step 6).
    'goal_done:goal': link(0),
    'goal_done:visit': link(0),
    'goal_failed:visit': link(0),
    // A spot whose spawns admit none of the bot's fights alone (a kit or level it
    // lost, a stand-in ground): the bot stands with nothing to hunt, its plan cannot
    // stand.
    spot_empty: link(0),
    // A far bot's arrival in town (detect: the step that leaves the field for a town
    // visit) or a body's (ShoppingState).
    arrived_town: link(0),
    // Main moved the bot's goal (its goal revision, until AI-5); the step's own review
    // of a craft or clan market.
    goal_moved: link(0),
    craft_bid: link(0),
    clan_market: link(0),
    funding: link(WORK | VISIT),
    // A move the bot did not order (a flight, a pull, a push out, a party's call).
    moved_by_world: link(0),
    // Deaths at its spot, or the death recovery's level penalty raised (a death, the
    // spot's pressure): the ground the bot may fight on moved.
    spot_dangerous: link(0),
    // The recovery's penalty lifted by clean wins.
    recovered: link(0, STOP),
    // The earning spot's own inputs (situations.md B6): karma that appeared or cleared
    // (detect; the decision takes the karma wash's choice while it lasts), a spot the
    // body's relocation could not reach (payload { spotId, reason }: its spot mark)
    // and a player's command naming a spot (payload { spotId, at }: the held answer
    // itself, no search). raisedFacts writes what they carry (spot_dangerous's too).
    karma_changed: link(0),
    spot_unreachable: link(0),
    player_command: link(0),
    // Its own income on its spot below what its held earning answer expects, beyond its error: weighed at a rest,
    // once a stay (BotHuntEfficiency.disappoints). Wakes the earning spot only.
    spot_disappoints: link(0, STOP),
    supply: link(FIELD | VISIT),
    bag: link(FIELD | VISIT),
    // What its clan asks of it moved (the stores fact: its material demand, the clan
    // supply, the crystals): heard at its next stop (situations.md §3 clan_call; the
    // clan raises it itself in step 9).
    clan_call: link(WORK | VISIT, STOP),
    // Its own warehouse: what it put in and took is its doing, heard as it arrives in town.
    warehouse: link(GATED),
    // A condition, not a change: a need that opened. The shots a fight loads or the
    // survival potions fell under their line (one hour of use, the kit rates'), the
    // shots ran out (the supply fact's flips, factNames); the bag must go to town.
    shots_out: link(0),
    'stock_low:shots': link(0),
    'stock_low:potions': link(0),
    bag_full: link(0),
    // Its own doing is no event (own outputs are not inputs): its trips and where
    // they end, its craft preparation.
    own_move: link(GATED),
    own_preparation: link(GATED),
    // The soft point (DecisionSections.softEvents, until step 4 C7). Money is read in
    // town and when the goal comes in reach; a rest is no review of the purse.
    money: link(FIELD | VISIT),
    // The wallet reached the build's threshold (stats.affordAt): a broke bot's survival
    // potions, an unarmed bot's weapon bridge, its focus.
    'goal_affordable:potions': link(0),
    'goal_affordable:focus': link(0),
    'goal_affordable:survival': link(0),
    // Its own samples moved; a watched board line crossed (until step 4 C7).
    observation: link(WORK | VISIT),
    market: link(0)
});
const hears = (name, where) => !(SITUATIONS[name].waits & where);
// One reason with no decision of its own (a step's market review): is it heard here, counted as a raise.
function woke(name, where) {
    const now = hears(name, where);
    if (now) count(raisedCounts, `${name}@${NAMES.get(where)}`);
    return now;
}

// The decisions a bot holds: one bit each in stats.woken, the same bits per plane
// in stats.waiting (STOP plane the low byte, TOWN the next). Each declares here, once,
// the situations that wake it; a decision joins as the step that moves it does
// (situations.md §10, §14).
// build: the wish projection, the money queue, the leaf and the party request. Beside
// §14's list: player_command (the commanded spot reaches the hunting leaf),
// goal_done:visit / goal_failed:visit (the agenda over the held entry, F4: temporary
// until step 6), funding (out_of_money from step 4 C7), revived (a respawn), the
// step's market reviews (craft_bid, clan_market) and goal_moved (until AI-5).
// gear_plan (F1): the gear plan's full review, every gear candidate weighed and the
// native plan judged afresh (GearPlanSelection); a build it does not wake keeps the
// gear the bot follows.
const DECISIONS = Object.freeze({
    earning_spot: Object.freeze(['level_up', 'gear_changed', 'died', 'recovered', 'spot_disappoints', 'contest_lost', 'spot_empty',
        'spot_dangerous', 'spot_unreachable', 'moved_by_world', 'party_left', 'shots_out', 'stock_low:potions', 'goal_affordable:potions',
        'karma_changed']),
    build: Object.freeze(['arrived_town', 'level_up', 'gear_changed', 'recipe_learned', 'died', 'revived', 'party_left',
        'goal_affordable:potions', 'goal_affordable:focus', 'goal_affordable:survival', 'funding', 'goal_done:goal', 'goal_failed',
        'goal_done:visit', 'goal_failed:visit', 'stock_low:shots', 'stock_low:potions', 'bag_full', 'source_stalled', 'clan_call',
        'clan_changed', 'spot_empty', 'goal_moved', 'player_command', 'craft_bid', 'clan_market']),
    gear_plan: Object.freeze(['level_up', 'gear_changed', 'died', 'party_left', 'goal_failed', 'source_stalled', 'arrived_town'])
});
const BITS = Object.freeze(Object.fromEntries(Object.keys(DECISIONS).map((name, at) => [name, 1 << at])));
const ALL = Object.values(BITS).reduce((all, bit) => all | bit, 0), PLANE = 0xff;
const SHIFT = { [STOP]: 0, [TOWN]: 8 };
// The decisions each situation wakes.
const WAKES = Object.freeze(Object.fromEntries(Object.keys(SITUATIONS).map(name => [name,
    Object.entries(DECISIONS).reduce((bits, [decision, names]) => names.includes(name) ? bits | BITS[decision] : bits, 0)])));
// The planes a place hears: work (and a body in the field) only what is heard
// anywhere; a rest its stop; the town, a stall, a meeting, the arrival in town and
// a body near a player elsewhere all of them.
const planesAt = where => where === WORK || where === BODY ? 0 : where === REST ? STOP : STOP | TOWN;
// A decision's held answer in the mind (situations.md §10): with none the decision
// reads woken (no stored raise), until it decides and holds one.
const HELD = Object.freeze({ earning_spot: 'earning', build: 'wishSections', gear_plan: 'equipmentPlan' });
const unheld = stats => Object.entries(HELD).reduce((bits, [decision, key]) => stats?.[key] === undefined ? bits | BITS[decision] : bits, 0);
// A row saved before the store kept no bits: every decision reads woken, once.
const wokenBits = stats => (stats?.woken === undefined ? ALL : Number(stats.woken) || 0) | unheld(stats);
// The health line's counts (counts()), always on: what was raised where, which
// situation woke which decision, the decisions taken or served, and those taken with
// no bit woken by their caller. Each map holds at most COUNT_KEYS keys (limits.md);
// a key past them is counted in overflow.
const COUNT_KEYS = 256;
const raisedCounts = new Map(), wokeCounts = new Map(), decidedCounts = new Map(), unwokenCounts = new Map();
const overflow = new Map();
function count(map, key, at = 0) {
    let row = map.get(key);
    if (!row) {
        if (map.size >= COUNT_KEYS) { overflow.set(map, (overflow.get(map) || 0) + 1); return; }
        map.set(key, row = map === decidedCounts ? [0, 0] : [0]);
    }
    row[at]++;
}
// A plain copy of the counts: { raised: { name@place: n }, woke: { decision<name: n },
// decided: { decision: [taken, served] }, unwoken: { decision:caller: n }, overflow: n }.
function counts() {
    const plain = map => Object.fromEntries([...map].map(([key, row]) => [key, row.length === 1 ? row[0] : [...row]]));
    return { raised: plain(raisedCounts), woke: plain(wokeCounts), decided: plain(decidedCounts),
        unwoken: plain(unwokenCounts), overflow: [...overflow.values()].reduce((sum, n) => sum + n, 0) };
}
// A named count on the health line's raised map with no situation of its own (the
// spot aggregate's arrivals and contests, SpotContest; a mark dropped).
const note = key => count(raisedCounts, key);
function countWoke(before, after, name) {
    for (const decision in BITS) if (after & ~before & BITS[decision]) count(wokeCounts, `${decision}<${name}`);
}
// The decisions of a set of bits (the trace's woke/waits), comma-joined; the planes' bits read as one.
function decisionNames(bits) {
    const all = (bits | bits >> 8) & PLANE;
    return Object.keys(BITS).filter(decision => all & BITS[decision]).join(',');
}

// The one writer of a bot's woken decisions (both threads): a situation raised at a
// place. Its decisions heard here wake (woken), the rest wait on its plane (waiting).
// A raise that adds no bit and writes no fact is no news: not counted, situationSeq
// stays. payload (plain data): { impossible: true } (an execution that proved the held
// step impossible: a failed goal, a town visit with nothing to do) also drops the
// held step (stats.activityLeaf); the facts its payload carries (raisedFacts) are
// written beside the bits; else diagnostics.
// stats: an object the caller owns (a copy it is building); written and returned.
// subject: the bot's id, for the decision trace (Bot/DecisionTrace).
function raise(stats, name, payload = null, where = OPEN, subject = 0) {
    const bits = delta(name, payload, where, stats);
    if (bits.leaf) stats.activityLeaf = 0;
    const was = wokenBits(stats), waited = Number(stats.waiting) || 0;
    const before = stats.earning?.spotId ?? null, wrote = writeFacts(stats, bits.facts);
    const woken = was | bits.woken, waiting = waited | bits.waiting;
    if (!wrote && woken === was && waiting === waited) return stats;
    stats.woken = woken; stats.waiting = waiting;
    stats.situationSeq = (Number(stats.situationSeq) || 0) + 1;
    counted(name, where, was, woken, subject, waiting & ~waited, payload);
    if (bits.taken) took(stats, bits, name, subject, before);
    return stats;
}
// The decisions a raise's facts took (player_command: the player decided the earning
// spot): decided as that caller (counted, traced; one taken while it slept counts as
// unwoken under that caller), their bits cleared woken and waiting on every plane.
// Written on stats; returns the woken bits left. Also for a far row's raise
// (BotLifeState.raiseOnRow), over its bits.
function took(stats, bits, caller, subject = 0, was = null) {
    stats.woken = decided(stats, Object.keys(BITS).filter(decision => bits.taken & BITS[decision]),
        { caller, subject, answer: bits.facts?.earning?.spotId ?? null, was });
    stats.waiting = (Number(stats.waiting) || 0) & ~planes(bits.taken);
    return stats.woken;
}
// What a raise ORs into a bot's bits (raise; BotLifeState.raiseOnRow's SQL on a far
// row): { woken, waiting, leaf (drop the held step), taken (the decisions
// its facts took: their bits cleared, woken and waiting on every plane: planes()),
// facts (raisedFacts over stats: the facts as they stand before it) }.
function delta(name, payload = null, where = OPEN, stats = null) {
    const row = SITUATIONS[name];
    if (!row) throw new TypeError(`situation: unknown ${name}`);
    const now = !row.heard || !!(planesAt(where) & row.heard);
    // A mark past SpotRiskPolicy.MAX_SPOT_MARKS drops the oldest: counted (limits.md).
    const facts = raisedFacts(stats, name, payload, () => count(raisedCounts, 'spot_mark:dropped'));
    return { woken: now ? WAKES[name] : 0, waiting: now ? 0 : WAKES[name] << SHIFT[row.heard],
        leaf: payload?.impossible === true, taken: facts.earning ? BITS.earning_spot : 0, facts };
}
// The facts a raise writes beside its bits (situations.md B6), each owned by its
// reader: player_command's spot becomes the held earning answer (the player decided:
// EquipmentIncomeRoute.commanded, no search; the earning spot's bit taken); the spot
// of a spot_unreachable, a contest_lost or a spot_dangerous that names one a spot mark
// (SpotRiskPolicy.withSpotMark), which the next held answer retires.
// { earning, spotMarks }, undefined: unchanged. stats: the facts before the raise
// (null: none known). dropped: told a mark past the cap.
// lazy: cycles both owners load spot modules that read this catalogue.
let IncomeRoute = null, Risk = null;
const MARKS = new Set(['spot_unreachable', 'spot_dangerous', 'contest_lost']);
function raisedFacts(stats, name, payload, dropped = null) {
    if (payload?.spotId == null) return {};
    if (name === 'player_command') return { earning: (IncomeRoute ||=
        invoke('GameServer/Bot/Economy/EquipmentIncomeRoute')).commanded(stats?.earning, payload.spotId, payload.at) };
    if (!MARKS.has(name)) return {};
    Risk ||= invoke('GameServer/Bot/Population/SpotRiskPolicy');
    return { spotMarks: Risk.withSpotMark(stats, payload.spotId, payload.reason || name, dropped) };
}
// A decision's bits on both waiting planes (STOP the low byte, TOWN the next).
const planes = bits => bits | bits << 8;
// raisedFacts' facts on stats (written in place, as raise's bits). Did it write any?
function writeFacts(stats, facts) {
    if (facts.earning) stats.earning = facts.earning;
    if (facts.spotMarks) stats.spotMarks = facts.spotMarks;
    return !!facts.earning || !!facts.spotMarks;
}
// A unit (a body, a far bot's kernel record: memory) that needs a spot while its held
// earning answer names none it may take (none found, marked, full): an existing answer
// reads as not woken, so it asks the decision again, once per answer (memory.spotAsk:
// the answer's time it asked against): 'ask', the caller raises spot_empty. Until the
// next answer: 'wait'. An answer after its ask that still names none is counted
// (earning:no_spot) and traced once: 'none', the caller does its defined fallback until
// a situation brings a spot. No answer at all: 'wait' (it reads woken already). A unit
// that holds a spot again forgets its ask (memory.spotAsk = null).
function spotAsk(memory, earning, subject = 0) {
    if (!earning) return 'wait';
    const at = Number(earning.at) || 0, ask = memory.spotAsk;
    if (!ask) { memory.spotAsk = { at, none: false }; return 'ask'; }
    if (ask.at === at) return 'wait';
    if (!ask.none) {
        ask.none = true;
        count(raisedCounts, 'earning:no_spot');
        if (Trace.on()) Trace.record({ kind: 'note', bot: subject, name: 'earning:no_spot' });
    }
    return 'none';
}
// A body's own copy of the facts its raises write (DecisionEvents: main reads them
// while its raise waits for the background thread, which writes the same in its raise).
const applyFacts = (stats, name, payload = null) => writeFacts(stats, raisedFacts(stats, name, payload));
// A raise counted on the health line: where, and the decisions it woke (before, after: the woken bits); and traced
// (subject: the bot; waits: the bits it left waiting on a plane; payload: its impossible mark).
function counted(name, where, before = 0, after = 0, subject = 0, waits = 0, payload = null) {
    count(raisedCounts, `${name}@${NAMES.get(where)}`);
    countWoke(before, after, name);
    if (Trace.on()) Trace.record({ kind: 'raise', bot: subject, name, place: NAMES.get(where), woke: decisionNames(after & ~before),
        waits: decisionNames(waits), ...(payload?.impossible === true ? { reason: 'impossible' } : {}) });
}
// A stop (a far step at a rest or in town, a hot body's rest end): what waited on
// the planes this place hears wakes. Written and returned as raise.
function stop(stats, where, subject = 0) {
    const planes = planesAt(where), waited = Number(stats.waiting) || 0;
    let release = 0, waiting = waited;
    if (planes & STOP) { release |= waited & PLANE; waiting &= ~PLANE; }
    if (planes & TOWN) { release |= waited >> 8 & PLANE; waiting &= ~(PLANE << 8); }
    if (!release) return stats;
    const was = wokenBits(stats);
    stats.woken = was | release; stats.waiting = waiting;
    countWoke(was, stats.woken, `stop@${NAMES.get(where)}`);
    if (Trace.on()) Trace.record({ kind: 'stop', bot: subject, place: NAMES.get(where), woke: decisionNames(stats.woken & ~was) });
    return stats;
}
const woken = (stats, decision) => !!(wokenBits(stats) & BITS[decision]);
const anyWoken = stats => wokenBits(stats) !== 0;
// A decision taken clears its bit; its held answer served (served) is counted and
// clears nothing; a taken one with no bit woken is counted by its caller.
// decisions: a name or a list. Returns the woken bits left (stats.woken). A taken
// one is traced (subject: the bot; answer, was: its answer and the one it replaces,
// short text, or per decision { decision: [answer, was] }).
function decided(stats, decisions, { caller = 'other', served = false, subject = 0, answer = null, was = null } = {}) {
    let bits = wokenBits(stats);
    for (const decision of [decisions].flat()) {
        const bit = BITS[decision], unwoken = !served && !(bits & bit);
        count(decidedCounts, decision, served ? 1 : 0);
        if (unwoken) count(unwokenCounts, `${decision}:${caller}`);
        // A served answer clears nothing: only the decision taken does.
        if (served) continue;
        if (!served && Trace.on()) {
            const [now, before] = answer && typeof answer === 'object' ? answer[decision] || [] : [answer, was];
            Trace.record({ kind: 'decided', bot: subject, decision, caller, how: unwoken ? 'unwoken' : 'taken',
                ...(now == null ? {} : { answer: String(now) }), ...(before == null ? {} : { was: String(before) }) });
        }
        bits &= ~bit;
    }
    return bits;
}

// The fact readers (DecisionSections: the views and facts its builds keep as their
// baseline). lazy: cycle DecisionSections reads this catalogue at its top.
let Readers = null;
const readers = () => Readers ||= require('./Economy/DecisionSections');
// The situations of a bot's own state between the facts a decision kept and the
// facts now, in fact order: previousFact(name) reads the kept one, current the
// facts now (DecisionSections.factsOf). funding: the money fact's hard part moved
// (DecisionSections.moneyChanged). planned: the occupation the held decision ordered
// (DecisionSections.occupationPlanned), its own output, no event. Both threads: the
// step's diff (detect) and the held build's verdict (EconomyContext).
function factNames(previousFact, current, funding = false, planned = false) {
    const names = [];
    const add = name => { if (!names.includes(name)) names.push(name); };
    if (!previousFact('dead') && current.dead) add('died');
    if (previousFact('build') !== current.build) {
        // A baseline kept before the level was its own fact reads as gear.
        const level = previousFact('level');
        add(level !== undefined && level !== current.level ? 'level_up' : 'gear_changed');
    }
    // A baseline that read no recipe book (null) has none to compare.
    const recipes = previousFact('recipes');
    if (recipes != null && recipes !== current.recipes) add('recipe_learned');
    // The clan (its id; a baseline kept before the fact was its own has none to compare).
    const clan = previousFact('clan');
    if (clan !== undefined && clan !== current.clan) add('clan_changed');
    // A new party or a new role in it reads as joining it.
    if (previousFact('party') !== current.party) add(current.party === readers().NO_PARTY ? 'party_left' : 'party_joined');
    if (funding) add('funding');
    // Resting reads as hunting at its spot: a rest where the bot hunted is
    // none, a rest at another spot is an occupation event.
    if (!planned && previousFact('occupation') !== current.occupation) add('moved_by_world');
    if (current.riskDeaths > previousFact('riskDeaths')) add('spot_dangerous');
    // The gear plan's craft route collected nothing for its stall's kills (GearStall):
    // the kill count crossed the stall since the decision. A baseline kept before the
    // count was its fact has none to compare.
    const kills = previousFact('kills');
    if (kills !== undefined && Stall.crossed(kills, current.kills, current.stall)) add('source_stalled');
    // Karma that appeared or cleared (the karma wash, B6). A baseline kept before the
    // fact was recorded has none to compare.
    const karma = previousFact('karma');
    if (karma !== undefined && karma !== current.karma) add('karma_changed');
    // The recovery's level penalty, up (a death, the spot's pressure) or down
    // (its clean wins, SpotRiskPolicy.recordRecovery). A baseline kept before
    // the fact was recorded has none to compare.
    const recovery = previousFact('recovery');
    if (recovery !== undefined && recovery !== current.recovery) add(current.recovery < recovery ? 'recovered' : 'spot_dangerous');
    // Physical exhaustion is never hidden by economic uncertainty.
    if (previousFact('supply') !== current.supply) add('supply');
    // A kind that crossed below its line, or ran out, since the decision (its
    // baseline's lines, under the rates it published; heard near and far alike: a
    // hot body's post reads the same facts). It stands raised until a decision
    // takes it and keeps the new lines.
    const lines = previousFact('lines');
    if (lines !== undefined && lines !== current.lines) {
        const S = readers();
        const below = kind => S.lineAt(lines, kind) < S.LINE_BELOW && S.lineAt(current.lines, kind) >= S.LINE_BELOW;
        if (below('shots')) add('stock_low:shots');
        if (S.lineAt(lines, 'shots') < S.LINE_OUT && S.lineAt(current.lines, 'shots') === S.LINE_OUT) add('shots_out');
        if (below('potions')) add('stock_low:potions');
    }
    if (previousFact('bag') !== current.bag) add('bag');
    if (previousFact('stores') !== current.stores) add('clan_call');
    if (previousFact('warehouse') !== current.warehouse) add('warehouse');
    return names;
}
// The step's fact diff, one function for both threads (a far step's projection,
// BotLifeState.prepareResolve; a near bot's post): the situations of its own state
// against the decision's baseline (stats.wishSections), a fact the baseline lacks
// against the state before. round: escrow (the buy-order escrow the money fact
// reads), leaf (the step's held leaf: the move it ordered raises nothing; none, as
// on main: every move is an event), unhuntable (the round found its spot empty of
// prey, BackgroundResolver, once a stay: a fact of the round, not of the states).
// facts, funding: a body's previous post kept as its facts and its funding mark
// (DecisionEvents.detectNear) in place of the state before; out: receives this
// post's { facts, funding } for the next. body: the post of a body near a player,
// whose moves are its own (main executes its held decisions): a spot it reaches or
// leaves is an arrival for the spot aggregate (the background thread's hot arrival
// hook, the near_spot / near_left posts), not moved_by_world.
// recipes: a reader of the recipe ids the bot's next build reads (WishProviders.recipeIds
// over the book its decision reads: the worker's step reads the state's, main the
// workshop's book), so a recipe learned raises recipe_learned once the decision can
// read it; none: the recipes the decision kept stand.
function detect(before, after, { escrow = 0, leaf = null, unhuntable = false, recipes = null, facts = null, funding: fundingBefore, out = null, body = false } = {}) {
    const Sections = readers();
    // Main may replay a validated worker packet that already describes this
    // same round: a newer build's baseline (its own time) is the one compared;
    // a packet preceding a new death/level/resource event still raises that event.
    const builtAt = state => Number(state.stats?.wishSections?.at) || 0;
    const represented = builtAt(after) > builtAt(before) ? after.stats.wishSections : null;
    const previous = represented || before.stats?.wishSections || {};
    let original;
    // A fact the baseline kept as null (no recipe book read) is kept: only a
    // fact the baseline lacks reads the state before.
    const previousFact = key => Object.hasOwn(previous, key) ? previous[key] : (original ||= facts || Sections.semanticFacts(before))[key];
    // No memory here: the relations the decision kept stand until its next build, which
    // reads them; the party with them. The recipes as the next build reads them.
    const view = Sections.stateView(after);
    const current = { ...Sections.factsOf(view), relations: previousFact('relations'),
        recipes: recipes ? Sections.hash(recipes(after)) : previousFact('recipes'), party: previousFact('party') };
    const fundingAfter = out || !previous.funding ? Sections.fundingMark(after) : null;
    const funding = Sections.moneyChanged(after, represented || before.stats?.wishSections, escrow, false)
        || !previous.funding && (fundingBefore ?? Sections.fundingMark(before)) !== fundingAfter;
    if (out) { out.facts = current; out.funding = fundingAfter; }
    const names = factNames(previousFact, current, funding, body || Sections.occupationPlanned(after, leaf));
    if (unhuntable) names.push('spot_empty');
    // A far bot's arrival in town (the step that leaves the field for a visit): its
    // shopping moment (its stop there wakes what waited for the town).
    if (!body && after.phase === 'cold' && after.activity === 'shopping' && FIELD_ACTIVITIES.has(before.activity)) names.push('arrived_town');
    // A body near a player hears its full bag too (its post's previous facts: bagNeed).
    return body || gated(place(after, before)) ? names.concat(needsOpened(before, names, view, facts)) : names;
}
// A need that opened in this step, one raise: one that stays open raises nothing more.
// now: the step's view of after (stateView); was: a body's previous post's facts, else
// the state before's view. The supply lines are facts (factNames).
function needsOpened(before, names, now, was = null) {
    const opened = [];
    if (names.includes('bag')) {
        was ||= readers().stateView(before);
        if (now.bagNeed > (Number(was.bagNeed) || 0)) opened.push('bag_full');
    }
    return opened;
}
// The sections a list of situations touches wherever the bot stands.

module.exports = { FIELD_ACTIVITIES, OPEN, REST, place, bodyPlace, gated, field, reactive, onVisit, readsFacts, hears, woke,
    DECISIONS, ALL, raise, delta, planes, took, applyFacts, spotAsk, counted, note, stop, woken, anyWoken, decided, counts, COUNT_KEYS,
    placeName: where => NAMES.get(where), SITUATIONS, BITS, detect, factNames };
