'use strict';

// T174: a bot weighs its goal again only at a moment a player would. This is the
// shadow (design rules, Recompute): today's builds run as before; each is named by
// its moment or by none, and what a build with none decided is counted, so the gate
// is judged on live numbers before it exists.
const Sections = invoke('GameServer/Bot/Economy/DecisionSections');
const ColdEconomyPlan = invoke('GameServer/Bot/Population/ColdEconomyPlan');

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
    // Main moved the bot's goal (an order, a party or clan call): no choice of its own.
    if (why === 'goal') return 'goal_moved';
    const names = [];
    Sections.factEvents(name => baseline[name], facts, false, names, Sections.occupationPlanned(state, leaf));
    if (names.length) return names[0];
    return board && Sections.marketCrossed(board, baseline.marketWatch, Number(state.characterId)) ? 'market' : null;
}

function createStats() {
    return { builds: 0, skipped: 0, elsewhere: 0, goal: 0, posted: 0, moments: {}, why: {} };
}

// The first refusal's name; a raised event names its sections (the soft causes share
// the one refusal otherwise).
function whyOf(state, refused) {
    if (refused !== 'wish_dirty') return refused || 'not_asked';
    return `wish_dirty+${Sections.sectionNames(Number(state.stats?.wishDirty) || 0).join('+')}`;
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
        focus: plan.economy?.network?.focus?.[0] ?? null, target: Number(plan.acquisitionPlan?.target?.selfId) || 0 };
    seen.set(id, now);
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
    if (moment !== null) { added(stats.moments, moment, kind); return; }
    stats.skipped++;
    if (kind === 1) stats.elsewhere++;
    if (kind === 2) stats.goal++;
    if (kind === 3) stats.posted++;
    added(stats.why, why, kind);
}

module.exports = { momentOf, createStats, settle };
