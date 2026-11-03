'use strict';

// T174: a bot weighs its goal again only at a moment a player would. This is the
// shadow (design rules, Recompute): today's builds run as before; each is named by
// its moment or by none, and what a build with none decided is counted, so the gate
// is judged on live numbers before it exists.
const Sections = invoke('GameServer/Bot/Economy/DecisionSections');
const ColdEconomyPlan = invoke('GameServer/Bot/Population/ColdEconomyPlan');
const Equipment = invoke('GameServer/Bot/AI/BotEquipmentCompatibility');

// In town a player reads money, bag and market at once.
const TOWN = new Set(['shopping', 'crafting', 'merchant']);

// baseline: the decision the build replaces (stats.wishSections); facts: what the
// build recorded for this state. An own fact is known to the player at once, a
// planned move is none (the held leaf's: occupationPlanned, a flight or a recall
// stays a fact), a goal that failed is its own moment, and away from town the
// market reaches the bot only as WTB/WTS on what it watches.
function goalMoment(why) {
    if (/^(events:)?check:/.test(why)) return 'goal_failed';
    // Main moved the bot's goal (an order, a party or clan call): no choice of its own.
    return why === 'goal' ? 'goal_moved' : null;
}
function momentOf(state, baseline, facts, { board = null, leaf = null, why = '', nativeHolds = true } = {}) {
    if (!baseline) return 'first';
    if (state.partyId || state.party?.partyId) return 'party';
    if (TOWN.has(state.activity)) return 'town';
    if (!nativeHolds) return 'native';
    const goal = goalMoment(why);
    if (goal) return goal;
    const names = [];
    Sections.factEvents(name => baseline[name], facts, false, names, Sections.occupationPlanned(state, leaf));
    if (names.length) return names[0];
    return board && Sections.marketCrossed(board, baseline.marketWatch, Number(state.characterId)) ? 'market' : null;
}

// Decision 11-02: a bot at work weighs only the gear it follows; every candidate
// waits for a real review (the build's own: EconomyContext heldGear). why: what
// refused the held card; none: no card stood, as at a first build or a market review.
const AT_WORK = new Set(['hunting', 'traveling']);
function quiet(state, why) {
    return !!why && AT_WORK.has(state.activity) && !Sections.partyIdOf(state) && !goalMoment(why);
}

function createStats() {
    return { builds: 0, skipped: 0, elsewhere: 0, goal: 0, posted: 0, moments: {}, why: {},
        // What the queue's economy refreshes are worth: asked, full builds, built
        // on a state whose next step rebuilds anyway, dropped stale, plans sent, sent acts.
        refresh: { asked: 0, built: 0, dirty: 0, stale: 0, sent: 0, acts: 0 },
        pause: { waited: 0, elsewhere: 0, goal: 0, posted: 0, pauses: 0, merged: 0, waitMs: 0, newRoots: 0, newGoals: 0 } };
}

// Decision 11-02, the shadow of pauses: a change waits until the bot enters the
// right state. These go at once; every other build outside a rest would wait,
// and the builds that waited are one build at the pause.
// Decision 11-02, the shadow of a quiet build: one that would wait counts only
// the gear families the last build held. fresh 1: a family this build holds and
// the last one did not, such a build would not see it. 2: that family is its goal.
const AT_ONCE = new Set(['first', 'party', 'native', 'goal_failed', 'goal_moved', 'dead', 'town', 'occupation', 'supply', 'bag']);
const waiting = new Map();
function settlePause(pause, id, state, moment, kind, at, fresh) {
    const held = waiting.get(id);
    // Over every build: at a review, what the quiet builds before it did not see.
    if (fresh === 1) pause.newRoots++;
    if (fresh === 2) pause.newGoals++;
    if (AT_ONCE.has(moment) || state.activity === 'resting') {
        if (held) { pause.pauses++; pause.merged += held.builds; pause.waitMs += Math.max(0, at - held.at); waiting.delete(id); }
        return;
    }
    pause.waited++;
    if (kind === 1) pause.elsewhere++;
    if (kind === 2) pause.goal++;
    if (kind === 3) pause.posted++;
    if (held) held.builds++;
    else waiting.set(id, { builds: 1, at });
}

// The first refusal's name; a raised event names its sections (the soft causes share
// the one refusal otherwise).
function whyOf(state, refused) {
    if (refused !== 'wish_dirty') return refused || 'not_asked';
    return `wish_dirty+${Sections.sectionNames(Number(state.stats?.wishDirty) || 0).join('+')}`;
}

// power:<item>:<slot>: the weapon slots are one family, as at the gear admission.
function gearFamily(key) {
    const slot = /^power:\d+:(\d+)/.exec(String(key))?.[1];
    return slot === undefined ? null : Equipment.isWeaponSlot(Number(slot)) ? 'weapon' : slot;
}
// What a build left the bot doing, per bot, to compare the next build with.
const seen = new Map();
const added = (rows, name, kind) => {
    const row = rows[name] ||= [0, 0, 0, 0];
    row[0]++;
    if (kind) row[kind]++;
};
function settle(stats, state, plan, { baseline, leaf, refused, nativeHolds, board }) {
    const facts = plan.statsPacket?.wishSections;
    // A served build or a view of an incoming bot made no decision.
    if (!facts || facts.at === baseline?.at) return;
    const id = Number(state.characterId), before = seen.get(id), pick = plan.activityPick;
    const now = { doing: pick?.activity ?? null, spot: pick?.spotId ?? null, npc: pick?.npcId ?? null,
        focus: plan.economy?.network?.focus?.[0] ?? null, target: Number(plan.acquisitionPlan?.target?.selfId) || 0,
        gear: new Set((plan.economy?.network?.queue || []).map(row => gearFamily(row.key)).filter(Boolean)) };
    seen.set(id, now);
    const goal = gearFamily(now.focus);
    const fresh = !before ? 0 : goal && goal !== gearFamily(before.focus) && !before.gear.has(goal) ? 2
        : [...now.gear].some(family => !before.gear.has(family)) ? 1 : 0;
    // 1 elsewhere: the decision sends the bot to another activity or spot. 3 posted:
    // it stays and posts an act (a line, a sale), which can wait for town. 2 goal: it
    // stays while its plan names another mob or target. Rest and travel are the
    // bot's own: only what the decision chose is compared.
    const kind = !before ? 0 : before.doing !== now.doing || before.spot !== now.spot ? 1
        : ColdEconomyPlan.acts(plan.economyPlan) ? 3
            : before.npc !== now.npc || before.focus !== now.focus || before.target !== now.target ? 2 : 0;
    const why = whyOf(state, refused);
    const moment = momentOf(state, baseline, facts, { board, leaf, why, nativeHolds });
    stats.builds++;
    settlePause(stats.pause, id, state, moment, kind, Number(facts.at) || 0, fresh);
    if (moment !== null) { added(stats.moments, moment, kind); return; }
    stats.skipped++;
    if (kind === 1) stats.elsewhere++;
    if (kind === 2) stats.goal++;
    if (kind === 3) stats.posted++;
    added(stats.why, why, kind);
}

module.exports = { momentOf, quiet, createStats, settle };
