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
    // Its own state (detect). A level alone is none (training reads it in its round):
    // what a level opens is. The C4 expertise grade its level allows moved, either way
    // (a death's lost level too: GearGradeRule); the held earning spot's monsters fell
    // past the deep-blue gap below it (SpotValueTable.outleveled: the search's own cut).
    // The gear a fight turns on (the worn weapon, the body armour's grade, the armour
    // sets worn whole: not a ring, an enchant, hennas, skills, the craft or karma).
    grade_changed: link(WORK | VISIT, STOP),
    spot_outleveled: link(WORK | VISIT, STOP),
    gear_changed: link(WORK | VISIT, TOWN),
    recipe_learned: link(WORK | VISIT, STOP),
    died: link(0),
    // A hot body's respawn in town (BotAI): wakes nothing, its town arrival follows as
    // its own (a death wakes the earning spot; a PvE death costs no gear).
    revived: link(0),
    // Its clan joined, left or changed (detect's clan fact): heard at its next stop. Its
    // friends and enemies wake nothing (Q13): they are read when it decides.
    clan_changed: link(WORK | VISIT, STOP),
    // Its party left (BackgroundPartyLifecycle.releaseMember, the one leave rule: raised
    // where the leave is written; a hot body's by its lifecycle).
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
    // a town visit's last stop done or refused (the visit's own check, a review main
    // could not run): the build takes the next leaf. A stop with a stop after it in the
    // held plan raises nothing: the plan moves on (EconomyContext visitStop).
    'goal_done:goal': link(0),
    'goal_done:visit': link(0),
    'goal_failed:visit': link(0),
    // A spot whose spawns admit none of the bot's fights alone (a kit or level it
    // lost, a stand-in ground): the bot stands with nothing to hunt, its plan cannot
    // stand.
    spot_empty: link(0),
    // A far bot's arrival in town (detect: the step that leaves the field for a town
    // visit) or a body's (ShoppingState); a far bot's on the trip its held leaf ordered
    // to the town it names (:own), which the build does not hear: the visit carries out
    // the step it came for.
    arrived_town: link(0),
    'arrived_town:own': link(0),
    // The held leaf's funded row went unfunded (the wallet fell below the money the
    // queue held for it, DecisionSections.moneyCrossings, F3).
    out_of_money: link(0),
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
    bag: link(FIELD | VISIT),
    // What its clan asks of it moved (the stores fact: its material demand, the clan
    // supply, the crystals): heard at its next stop (situations.md §3 clan_call; the
    // clan raises it itself in step 9).
    clan_call: link(WORK | VISIT, STOP),
    // A condition, not a change: a need that opened. The shots a fight loads or the
    // survival potions fell under their line (one hour of use, the kit rates'), the
    // shots ran out (the supply fact's flips, factNames); the bag must go to town.
    shots_out: link(0),
    'stock_low:shots': link(0),
    'stock_low:potions': link(0),
    bag_full: link(0),
    // The wallet reached the build's threshold (baseline.affordAt): a broke bot's survival
    // potions, else an unarmed bot's weapon bridge, its focus or its gear plan's market
    // piece (all wake the build only: one name).
    'goal_affordable:potions': link(0),
    'goal_affordable:focus': link(0),
    // A board offer its held build wants (MarketBuyerWaiters: a new SELL line, or a cheaper
    // one, within the want's budget), raised at the bot's next step (payload { itemId,
    // price }): it answers the trade it hears, as a C4 player answers a WTS shout.
    offer_posted: link(0),
    // Its own board lines (the worker's board diff): a SELL line of the same item posted
    // or repriced below its own in its town (an unplaced ad counts in every town), as a
    // C4 seller sees a cheaper store or WTS shout; one of its own lines filled (a sale, a
    // bid answered). Heard at its next stop: a hunting player looks at his store when he
    // sits down or reaches town.
    line_undercut: link(0, STOP),
    'goal_done:line': link(0, STOP),
    // Its last hunting buff ended (BotBuffs.rebuffable: a guide's, a hall's or a buffer's;
    // a far bot's buffed fact fell, or it is first read unbuffed on a solo field step,
    // buffFact; a body's last such effect expired, EffectTicker): heard at its next stop,
    // as a player who sees his buffs gone renews them when he sits down or reaches town.
    // A death clears buffs and raises none (its restart's field step reads the fact anew).
    buffs_expired: link(0, STOP),
    // A party's roster moved (the party step's diff against its held spot's roster):
    // a member came or went, the leader's own leave too (subject: the party).
    member_joined: link(0),
    member_left: link(0),
    // The party's XP share came to exclude this member (PartyRewardMath: its level fell
    // too far below the party's), raised by the party step on the member (its flip).
    party_outleveled: link(0),
    // Its gear plan, re-planned by its party's step, came to need no party where it did
    // (the drop it grouped for came, its target moved): raised by that step on the member.
    party_need_ended: link(0)
});
const hears = (name, where) => !(SITUATIONS[name].waits & where);

// The decisions a bot holds: one bit each in stats.woken, the same bits per plane
// in stats.waiting (STOP plane the low byte, TOWN the next). Each declares here, once,
// the situations that wake it; a decision joins as the step that moves it does
// (situations.md §10, §14).
// build: the wish projection, the money queue, the leaf and the party request. Beside
// the catalogue's list: player_command (the commanded spot reaches the hunting leaf,
// which names the spot a body walks to), spot_unreachable (the spot a body could not
// walk to is its hunting leaf's, which the build chose: a material hunt's source spot
// as well as the earning spot; the earning answer alone would retire the mark and send
// the body back to the same leaf spot), goal_done:visit / goal_failed:visit (a visit
// whose held plan has no stop left: the next leaf). A death wakes
// the earning spot alone (EconomyContext.decideEarning: no build). Low potions wake the build
// only: a bot buys them; a broke one moves on at a death or a dangerous spot.
// gear_plan (F1): the gear plan's full review, every gear candidate weighed and the
// native plan judged afresh (GearPlanSelection); a build it does not wake keeps the
// gear the bot follows. One question, which gear to work toward: it hears the bot's
// own grade, gear and clan (a clan's goal plan dropped with it), and its source
// failing: a craft route's stall (source_stalled) or a gear errand failed on its item
// (goal_failed with its mark, GearMarks: delta), as a C4 player whose item was sold
// looks for another; not a death (PvE costs no gear), a party left, a town arrival or
// another failed step.
// workshop: what a crafter offers (its listing on its known book, stats.workshop), taken
// at the start of a town visit (arrived_town, either kind, one per visit; a craft level
// gained in the field is read there) and at a recipe learned, held between: levels, worn
// gear, prices, the board and its own fills wake it not. Only a class line that crafts
// hears it (heardBy); one not yet a service crafter takes it as none. It has no held
// key: only its raises wake it.
// own_lines: the prices of its own board lines (MarketPricing.look over every own
// priced line), taken at a town arrival (it sees the stores), a line undercut and a
// line filled; held between: prices, deals and the clock wake it not. No held key.
// rebuff: how the bot renews its hunting buffs now (Bot/AI/Rebuff: none, the Newbie
// Guide, its clan hall, a buffer), taken when its last buff ended and at a town
// arrival; held between (stats.rebuff, carried out once). No held key: none held reads none.
// party_stay: whether a party member stays (Population/PartyStay: stay, leave, a trip),
// taken by its party's step: its own death, a full bag, its weapon bridge funded,
// a new grade, the party outleveling it, its gear plan needing no party any more (karma
// is no leave: its party EXP washes it). Heard
// only while the bot is in a party (stats.backgroundPartyId): a solo bot's situations
// wake no stay. No held key: a member that holds none stays.
const DECISIONS = Object.freeze({
    earning_spot: Object.freeze(['grade_changed', 'spot_outleveled', 'gear_changed', 'died', 'recovered', 'spot_disappoints', 'contest_lost', 'spot_empty',
        'spot_dangerous', 'spot_unreachable', 'moved_by_world', 'party_left', 'shots_out', 'goal_affordable:potions',
        'karma_changed']),
    build: Object.freeze(['arrived_town', 'grade_changed', 'gear_changed', 'recipe_learned', 'party_left',
        'goal_affordable:potions', 'goal_affordable:focus', 'out_of_money', 'goal_done:goal', 'goal_failed',
        'goal_done:visit', 'goal_failed:visit', 'stock_low:shots', 'stock_low:potions', 'bag_full', 'source_stalled', 'clan_call',
        'clan_changed', 'spot_empty', 'player_command', 'spot_unreachable', 'offer_posted']),
    gear_plan: Object.freeze(['grade_changed', 'gear_changed', 'clan_changed', 'source_stalled']),
    workshop: Object.freeze(['arrived_town', 'arrived_town:own', 'recipe_learned']),
    own_lines: Object.freeze(['arrived_town', 'arrived_town:own', 'line_undercut', 'goal_done:line']),
    rebuff: Object.freeze(['buffs_expired', 'arrived_town', 'arrived_town:own']),
    party_stay: Object.freeze(['died', 'bag_full', 'goal_affordable:focus', 'grade_changed', 'party_outleveled', 'party_need_ended'])
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
// A decision's held answer in the mind: with none the decision reads woken (no
// stored raise), until it decides and holds one. The gear plan has no such key: a
// bot holds no stats.equipmentPlan once its target is bought and worn or its owner
// drops it (a class transition, a clan goal), and that is the plan carried out, not
// a review never taken: the next build plans on, and only its situations (or a
// row with no bits yet, a new bot) wake the full review. Nor has the workshop: a bot
// that is no service crafter holds no listing.
const HELD = Object.freeze({ earning_spot: 'earning', build: 'wishSections' });
const unheld = stats => Object.entries(HELD).reduce((bits, [decision, key]) => stats?.[key] === undefined ? bits | BITS[decision] : bits, 0);
// The bits raised and not yet decided (a row saved before the store kept no bits: every
// decision, once); the ones a decision with no held answer adds are read, never stored.
// A row with no bits yet holds every decision woken once but a member's stay, which
// only its own situations wake (a solo row would carry it forever: no step decides it).
const FIRST = ALL & ~BITS.party_stay;
const storedBits = stats => stats?.woken === undefined ? FIRST : Number(stats.woken) || 0;
// The decisions a bot is a subject of: a member's stay is heard only while the bot is
// in a background party, the workshop only by a class line that crafts (a dwarf's,
// CraftEligibility.craftsLine; a row whose class is not known hears it). A bit a row
// keeps outside them (a leave that dropped the party by another path: a player's
// takeover, an orphan repair; a far row's SQL raise, BotLifeState.raiseOnRow) reads unwoken.
let Craft = null;
const heardBy = stats => ALL & (stats?.backgroundPartyId ? ALL : ~BITS.party_stay)
    & (stats?.classId == null || (Craft ||= require('./Economy/CraftEligibility')).craftsLine(stats.classId) ? ALL : ~BITS.workshop);
const wokenBits = stats => (storedBits(stats) | unheld(stats)) & heardBy(stats);
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
    const stored = storedBits(stats), was = stored | unheld(stats), waited = Number(stats.waiting) || 0;
    const before = stats.earning?.spotId ?? null, wrote = writeFacts(stats, bits.facts);
    const woken = stored | bits.woken, waiting = waited | bits.waiting;
    if (!wrote && woken === stored && waiting === waited) return stats;
    stats.woken = woken; stats.waiting = waiting;
    stats.situationSeq = (Number(stats.situationSeq) || 0) + 1;
    counted(name, where, was, was | woken, subject, waiting & ~waited, payload);
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
    // A spot already marked under the held answer is no news: the decisions its first
    // mark woke answer it (a body that fails the same walk again while it waits).
    if (marked(stats, name, payload)) return { woken: 0, waiting: 0, leaf: false, taken: 0, facts: {} };
    const now = !row.heard || !!(planesAt(where) & row.heard);
    // A mark past SpotRiskPolicy.MAX_SPOT_MARKS drops the oldest: counted (limits.md).
    const facts = raisedFacts(stats, name, payload, () => count(raisedCounts, 'spot_mark:dropped'));
    // A gear errand failed on its item (its mark) is its gear source failing: it wakes
    // what a stalled source wakes too (source_stalled: the gear plan).
    // A decision hears its situations only on its subjects (heardBy).
    const wakes = (facts.gearMarks ? WAKES[name] | WAKES.source_stalled : WAKES[name]) & heardBy(stats);
    return { woken: now ? wakes : 0, waiting: now ? 0 : wakes << SHIFT[row.heard],
        leaf: payload?.impossible === true, taken: facts.earning ? BITS.earning_spot : 0, facts };
}
// The facts a raise writes beside its bits, each owned by its
// reader: player_command's spot becomes the held earning answer (the player decided:
// EquipmentIncomeRoute.commanded, no search; the earning spot's bit taken); the spot
// of a spot_unreachable, a contest_lost or a spot_dangerous that names one a spot mark
// (SpotRiskPolicy.withSpotMark), which the next held answer retires.
// { earning, spotMarks }, undefined: unchanged. stats: the facts before the raise
// (null: none known). dropped: told a mark past the cap.
// lazy: cycles both owners load spot modules that read this catalogue.
let IncomeRoute = null, Risk = null;
const MARKS = new Set(['spot_unreachable', 'spot_dangerous', 'contest_lost']);
const GearMarks = require('./AI/GearMarks');
function marked(stats, name, payload) {
    if (!stats || payload?.spotId == null || !MARKS.has(name)) return false;
    Risk ||= invoke('GameServer/Bot/Population/SpotRiskPolicy');
    return Risk.isMarked(stats, payload.spotId);
}
function raisedFacts(stats, name, payload, dropped = null) {
    // A gear errand failed where the body acts: its key marked for the gear plan (GearMarks).
    if (name === 'goal_failed' && payload?.kind === 'gear_errand') {
        const gearMarks = GearMarks.withMark(stats, payload.key, dropped);
        return gearMarks ? { gearMarks } : {};
    }
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
    if (facts.gearMarks) stats.gearMarks = facts.gearMarks;
    return !!facts.earning || !!facts.spotMarks || !!facts.gearMarks;
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
    stats.woken = storedBits(stats) | release; stats.waiting = waiting;
    countWoke(was, was | release, `stop@${NAMES.get(where)}`);
    if (Trace.on()) Trace.record({ kind: 'stop', bot: subject, place: NAMES.get(where), woke: decisionNames(release & ~was) });
    return stats;
}
const woken = (stats, decision) => !!(wokenBits(stats) & BITS[decision]);
const anyWoken = stats => wokenBits(stats) !== 0;
// A decision taken clears its bit; its held answer served (served) is counted and
// clears nothing; a taken one with no bit woken is counted by its caller.
// decisions: a name or a list. Returns the stored bits left (stats.woken). A taken
// one is traced (subject: the bot; answer, was: its answer and the one it replaces,
// short text, or per decision { decision: [answer, was] }).
function decided(stats, decisions, { caller = 'other', served = false, subject = 0, answer = null, was = null } = {}) {
    const read = wokenBits(stats);
    let bits = storedBits(stats);
    for (const decision of [decisions].flat()) {
        const bit = BITS[decision], unwoken = !served && !(read & bit);
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

// A member's stay answered by its leave (BackgroundPartyLifecycle.releaseMember): a
// solo bot holds no stay, so its bit is decided (as caller) and cleared on every
// waiting plane, or a solo's stop would wake it. Written on stats.
function leftParty(stats, subject = 0, caller = 'party_left') {
    const bits = planes(BITS.party_stay), held = storedBits(stats) & BITS.party_stay;
    if (!held && !(Number(stats.waiting) & bits)) return stats;
    // Decided as the member it was (stats already carry the leave: no party).
    if (held) stats.woken = decided({ ...stats, backgroundPartyId: true }, 'party_stay', { caller, subject, answer: 'left' });
    stats.waiting = (Number(stats.waiting) || 0) & ~bits;
    return stats;
}

// The fact readers (DecisionSections: the views and facts its builds keep as their
// baseline). lazy: cycle DecisionSections reads this catalogue at its top.
let Readers = null;
const readers = () => Readers ||= require('./Economy/DecisionSections');
// The situations of a bot's own state between the facts a decision kept and the
// facts now, in fact order: previousFact(name) reads the kept one, current the
// facts now (DecisionSections.factsOf). planned: the occupation the held decision ordered
// (DecisionSections.occupationPlanned), its own output, no event. Both threads: the
// step's diff (detect) and the held build's verdict (EconomyContext).
function factNames(previousFact, current, planned = false) {
    const names = [];
    const add = name => { if (!names.includes(name)) names.push(name); };
    if (!previousFact('dead') && current.dead) add('died');
    if (previousFact('grade') !== current.grade) add('grade_changed');
    // Its 0 -> 1 flip only: a build's baseline reads it against its own answer.
    if (!previousFact('outleveled') && current.outleveled) add('spot_outleveled');
    // The gear a fight turns on (weapon, body armour grade, whole sets: the gear fact).
    if (previousFact('gear') !== current.gear) add('gear_changed');
    // The clan (its id; a baseline kept before the fact was its own has none to compare).
    const clan = previousFact('clan');
    if (clan !== undefined && clan !== current.clan) add('clan_changed');
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
    return names;
}
// The buffed fact of a far bot hunting on its own (a step on either thread,
// BotLifeState.prepareResolve): a rebuffable effect in force at the state's time
// (BotBuffs.buffedAt). Its value is kept on the row (stats.buffed) and compared there,
// not against the step's state before: a rest or a write between rounds would hide the
// flip. Dead or in a party the row holds none (null): a death and a party's buffs are no
// hunt's. Out of the field (a town visit) the fact is not read and stands as it was: a
// trip ends no buff, and a rebuff in town that answered none leaves an unbuffed hunter
// unbuffed, no news on its way back. A solo field step that finds the bot unbuffed
// raises buffs_expired once when the row held it buffed (its last buff ended, in the
// field or on the trip) or held none (a new row, a death's restart, a party left): a
// hunter who sees no buffs on him renews them at his next stop. next: the stats written;
// field: the step's activity is a field one (FIELD_ACTIVITIES); returns the situation
// name or null.
function buffFact(next, effects, at, { field = true, dead = false, grouped = false } = {}) {
    if (dead || grouped) {
        if (next.buffed != null) next.buffed = null;
        return null;
    }
    if (!field) return null;
    const buffed = Number((Buffs ||= invoke('GameServer/Bot/AI/BotBuffs')).buffedAt(effects, at)), was = next.buffed;
    if (was !== buffed) next.buffed = buffed;
    return was !== 0 && !buffed ? 'buffs_expired' : null;
}
let Buffs = null;
// The step's fact diff, one function for both threads (a far step's projection,
// BotLifeState.prepareResolve; a near bot's post): the situations of its own state
// against the decision's baseline (stats.wishSections), a fact the baseline lacks
// against the state before. round: escrow (the buy-order escrow the money fact
// reads), leaf (the step's held leaf: the move it ordered raises nothing; none, as
// on main: every move is an event), unhuntable (the round found its spot empty of
// prey, BackgroundResolver, once a stay: a fact of the round, not of the states).
// facts: a body's previous post kept as its facts (DecisionEvents.detectNear) in place
// of the state before; out: receives this step's { facts } (a body keeps them for its
// next post). body: the post of a body near a player,
// whose moves are its own (main executes its held decisions): a spot it reaches or
// leaves is an arrival for the spot aggregate (the background thread's hot arrival
// hook, the near_spot / near_left posts), not moved_by_world. A recipe learned is raised
// where it is learned (CraftWorkshopService.recipeLearned), not read here.
function detect(before, after, { escrow = 0, leaf = null, unhuntable = false, facts = null, out = null, body = false } = {}) {
    const Sections = readers();
    // Main may replay a validated worker packet that already describes this
    // same round: a newer build's baseline (its own time) is the one compared;
    // a packet preceding a new death/level/resource event still raises that event.
    const builtAt = state => Number(state.stats?.wishSections?.at) || 0;
    const represented = builtAt(after) > builtAt(before) ? after.stats.wishSections : null;
    const previous = represented || before.stats?.wishSections || {};
    // The earning spot taken alone after the build kept its own situations' facts (withOwnFacts).
    const earning = after.stats?.earning ?? before.stats?.earning;
    const own = earning?.facts && Number(earning.at) > (Number(previous.at) || 0) ? earning.facts : null;
    let original;
    // Only a fact the baseline lacks reads the state before; outleveled is read against
    // the build's own answer only: a baseline without it reads 0 (its flip once).
    const previousFact = key => own && Object.hasOwn(own, key) ? own[key] : Object.hasOwn(previous, key) ? previous[key]
        : key === 'outleveled' ? 0 : (original ||= facts || Sections.semanticFacts(before))[key];
    // No memory here: the relations the decision kept stand until its next build, which
    // reads them. A party left is raised at the leave (party_left), not read here.
    const view = Sections.stateView(after);
    const current = { ...Sections.factsOf(view), relations: previousFact('relations') };
    // The wallet now against the decision's armed money thresholds (goal_affordable:<kind>,
    // out_of_money), while the wallet stands past them (moneyCrossings).
    const money = Sections.moneyCrossings(invoke('GameServer/Bot/Economy/PurchaseFunding').budget(after, escrow),
        represented || before.stats?.wishSections || after.stats?.wishSections);
    if (out) out.facts = current;
    const names = factNames(previousFact, current, body || Sections.occupationPlanned(after, leaf));
    for (const name of money) names.push(name);
    if (unhuntable) names.push('spot_empty');
    // A far bot's arrival in town (the step that leaves the field for a visit): its
    // shopping moment (its stop there wakes what waited for the town). On the trip the
    // held leaf ordered (Sections.leafVisit) the build is not woken: a build in town,
    // where a sale costs no trip, dropped the step the trip came for.
    if (!body && after.phase === 'cold' && after.activity === 'shopping' && FIELD_ACTIVITIES.has(before.activity))
        names.push(Sections.leafVisit(before, leaf) ? 'arrived_town:own' : 'arrived_town');
    // A body near a player hears its full bag too (its post's previous facts: bagNeed).
    return body || gated(place(after, before)) ? names.concat(needsOpened(before, names, view, facts)) : names;
}
// The facts whose situations wake the earning spot alone for a solo bot (died, spot_outleveled,
// moved_by_world, spot_dangerous, recovered, karma_changed): the earning answer taken alone
// (EconomyContext.decideEarning, ColdKarmaPolicy's) keeps them as they stand, with its spot's
// outleveled, as its baseline beside the build's (detect reads them while the answer is the
// newer): else each fact the build's baseline lacks raises again after every answer until a
// build. ~70 B on the answer. earning: the new answer; returned with its facts.
const EARNING_FACTS = Object.freeze(['dead', 'outleveled', 'occupation', 'riskDeaths', 'recovery', 'karma']);
function withOwnFacts(state, earning) {
    const now = readers().semanticFacts({ ...state, stats: { ...state.stats, earning } });
    const facts = {};
    for (const key of EARNING_FACTS) facts[key] = now[key];
    return { ...earning, facts };
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
// The party's decisions (subject: the party, decided on the worker at its step, hot
// parties at their first cold step): one bit each in party.stats.woken, heard at the
// party step (its round end is its stop). party_spot: where the party hunts, held in
// party.stats.partySpot { spotId, at, objective, roster, deaths, outleveled } (the
// answer and the facts it was taken on), taken at its situations: a member joined or
// left, a contest lost at the party's arrival, its own deaths on the spot, a round the
// spot admitted no fight of it, the spot outleveled by its leader. A member's own
// situations wake the member (party_stay), never the party.
const PARTY_DECISIONS = Object.freeze({
    party_spot: Object.freeze(['member_joined', 'member_left', 'contest_lost', 'spot_dangerous', 'spot_empty', 'spot_outleveled'])
});
const PARTY_BITS = Object.freeze(Object.fromEntries(Object.keys(PARTY_DECISIONS).map((name, at) => [name, 1 << at])));
const PARTY_WAKES = Object.freeze(Object.fromEntries(Object.values(PARTY_DECISIONS).flat().map(name => [name,
    Object.entries(PARTY_DECISIONS).reduce((bits, [decision, names]) => names.includes(name) ? bits | PARTY_BITS[decision] : bits, 0)])));
// The objective a party's spot answer was taken for (its kind, target and ground): a
// new objective is a new question, its old answer none.
function partyObjectiveKey(objective) {
    const o = objective || {};
    return readers().hash([o.spotId, o.npcId, o.clanGoalKey, o.sourceKind, o.raidBoss, o.opportunisticRaid, o.reason, o.kind]
        .map(value => value ?? null));
}
const rosterOf = party => [...new Set((party?.memberIds || []).map(Number))].sort((a, b) => a - b);
// The party's held spot answer, when it answers the party as it stands: taken for its
// objective and naming the ground it holds (a party moved by another hand, a hot
// party on main, holds none). None: the decision reads woken.
function partyHeld(party) {
    const held = party?.stats?.partySpot;
    if (!held || held.objective !== partyObjectiveKey(party.stats.objective)) return null;
    return String(held.spotId ?? '') === String(party.spotId ?? '') ? held : null;
}
const partyWoken = (party, decision = 'party_spot') => !partyHeld(party) || !!(Number(party.stats?.woken) & PARTY_BITS[decision]);
// The one writer of a party's bits: its situations raised at its step (the party
// step's diff, detectParty). One that adds no bit is no news: not counted.
// stats: a copy the caller owns, written and returned. subject: the party's leader.
function raiseParty(stats, names, partyId, subject = 0) {
    for (const name of names) {
        const bits = PARTY_WAKES[name] || 0, stored = Number(stats.woken) || 0;
        if (!bits || (stored | bits) === stored) continue;
        stats.woken = stored | bits;
        count(raisedCounts, `${name}@party`);
        count(wokeCounts, `party_spot<${name}`);
        if (Trace.on()) Trace.record({ kind: 'raise', bot: subject, party: String(partyId), name, place: 'party', woke: 'party_spot' });
    }
    return stats;
}
// A party decision taken: its bit cleared (decided's counts: taken, unwoken by caller).
// Returns the bits left.
function partyDecided(party, decision, { caller = 'party_step', subject = 0, answer = null, was = null } = {}) {
    const unwoken = !partyWoken(party, decision);
    count(decidedCounts, decision, 0);
    if (unwoken) count(unwokenCounts, `${decision}:${caller}`);
    if (Trace.on()) Trace.record({ kind: 'decided', bot: subject, party: String(party.partyId), decision, caller, how: unwoken ? 'unwoken' : 'taken',
        ...(answer == null ? {} : { answer: String(answer) }), ...(was == null ? {} : { was: String(was) }) });
    return (Number(party.stats?.woken) || 0) & ~PARTY_BITS[decision];
}
// The party spot's held answer and the facts it stands on: the roster, the party's
// own deaths on the spot and whether the leader outlevels it (detectParty diffs them).
function partySpotAnswer(party, answer, at, { deaths = 0, leaderLevel = 1 } = {}) {
    return { spotId: answer?.spotId ?? null, at, objective: partyObjectiveKey(party.stats?.objective), roster: rosterOf(party),
        deaths, outleveled: answer?.spotId == null ? 0 : outleveledSpot(answer.spotId, leaderLevel) };
}
let SpotTable = null;
const outleveledSpot = (spotId, level) => (SpotTable ||= invoke('GameServer/Bot/AI/SpotValueTable')).outleveled(spotId, level) ? 1 : 0;
// The party step's situations against its held answer (one function, the worker's
// step for every far party): a member joined or left (the roster), its own deaths on
// the spot rose (spot_dangerous), the leader outlevels the spot past the deep-blue gap
// (spot_outleveled, its 0 -> 1 flip), and the marks its writers left on the held spot
// (contest_lost at its arrival, spot_empty from a round that admitted no fight:
// marks: the party's marks that hold, PartySpotRiskPolicy.marks). None held: none
// (the decision reads woken).
function detectParty(party, held, { deaths = 0, leaderLevel = 1, marks = [] } = {}) {
    if (!held) return [];
    const names = [], roster = rosterOf(party), was = new Set(held.roster || []);
    if (roster.some(id => !was.has(id))) names.push('member_joined');
    if ((held.roster || []).some(id => !roster.includes(id))) names.push('member_left');
    if (deaths > Number(held.deaths || 0)) names.push('spot_dangerous');
    if (!held.outleveled && held.spotId != null && outleveledSpot(held.spotId, leaderLevel)) names.push('spot_outleveled');
    for (const mark of marks) {
        if (String(mark.spotId) === String(held.spotId) && PARTY_WAKES[mark.reason] && !names.includes(mark.reason)) names.push(mark.reason);
    }
    return names;
}

module.exports = {
    PARTY_DECISIONS, partyHeld, partyWoken, raiseParty, partyDecided, partySpotAnswer, detectParty, outleveledSpot,
    buffFact, FIELD_ACTIVITIES, OPEN, REST, place, bodyPlace, gated, field, reactive, onVisit, readsFacts, hears,
    DECISIONS, ALL, FIRST, raise, delta, withOwnFacts, planes, took, leftParty, applyFacts, spotAsk, counted, note, stop, woken, anyWoken, decided, counts, COUNT_KEYS,
    placeName: where => NAMES.get(where), SITUATIONS, BITS, detect, factNames };
