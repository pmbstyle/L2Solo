'use strict';

// T174: a bot weighs its goal again only at a moment a player would. This is the
// shadow (design rules, Recompute): today's builds run as before; each is named by
// its moment or by none, and what a build with none decided is counted, so the gate
// is judged on live numbers before it exists.
const Sections = invoke('GameServer/Bot/Economy/DecisionSections');
const ColdSoloWindow = invoke('GameServer/Bot/Population/ColdSoloWindow');

// In town a player reads money, bag and market at once.
const TOWN = new Set(['shopping', 'crafting', 'merchant']);

// baseline: the decision the build replaces (stats.wishSections); facts: what the
// build recorded for this state. An own fact is known to the player at once, a
// planned move is none (the held leaf's: occupationPlanned, a flight or a recall
// stays a fact), a goal that failed is its own moment, and away from town the
// market reaches the bot only as WTB/WTS on what it watches.
function momentOf(state, baseline, facts, { board = null, leaf = null, why = '', nativeHolds = true } = {}) {
    if (!baseline) return 'first';
    if (state.partyId || state.party?.partyId) return 'party';
    if (TOWN.has(state.activity)) return 'town';
    if (!nativeHolds) return 'native';
    if (/^(events:)?check:/.test(why)) return 'goal_failed';
    const names = [];
    Sections.factEvents(name => baseline[name], facts, false, names, Sections.occupationPlanned(state, leaf));
    if (names.length) return names[0];
    return board && Sections.marketCrossed(board, baseline.marketWatch, Number(state.characterId)) ? 'market' : null;
}

function createStats() {
    return { builds: 0, skipped: 0, acted: 0, goal: 0, moments: {}, why: {} };
}

// The first refusal's name; a raised event names its sections (the soft causes share
// the one refusal otherwise).
function whyOf(state, refused) {
    if (refused !== 'wish_dirty') return refused || 'not_asked';
    return `wish_dirty+${Sections.sectionNames(Number(state.stats?.wishDirty) || 0).join('+')}`;
}

// What a build left the bot doing, per bot, to compare the next build with.
const seen = new Map();
function settle(stats, state, plan, { baseline, leaf, refused, nativeHolds, board }) {
    const facts = plan.statsPacket?.wishSections;
    // A served build or a view of an incoming bot made no decision.
    if (!facts || facts.at === baseline?.at) return;
    const id = Number(state.characterId), before = seen.get(id);
    const now = { key: ColdSoloWindow.planKey(plan), focus: plan.economy?.network?.focus?.[0] ?? null,
        target: Number(plan.acquisitionPlan?.target?.selfId) || 0 };
    seen.set(id, now);
    stats.builds++;
    const why = whyOf(state, refused);
    const moment = momentOf(state, baseline, facts, { board, leaf, why, nativeHolds });
    if (moment !== null) { stats.moments[moment] = (stats.moments[moment] || 0) + 1; return; }
    stats.skipped++;
    const row = stats.why[why] ||= [0, 0, 0];
    row[0]++;
    if (!before) return;
    // Acted: the step would have sent the bot elsewhere. Goal: it keeps doing the
    // same while its plan names another target.
    if (ColdSoloWindow.planMoved(plan, before.key, state)) { stats.acted++; row[1]++; }
    else if (before.focus !== now.focus || before.target !== now.target) { stats.goal++; row[2]++; }
}

module.exports = { momentOf, createStats, settle };
