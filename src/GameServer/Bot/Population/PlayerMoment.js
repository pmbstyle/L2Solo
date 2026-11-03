'use strict';

// The reading of the rule (Reaction): every build named by its moment or by none, and
// what it decided, so a leak shows on the health line. The rule itself is Reaction's.
const Sections = invoke('GameServer/Bot/Economy/DecisionSections');
const Reaction = invoke('GameServer/Bot/Economy/Reaction');
const ColdEconomyPlan = invoke('GameServer/Bot/Population/ColdEconomyPlan');

// baseline: the decision the build replaces (stats.wishSections); facts: what the
// build recorded for this state. An own fact is known to the player at once, a
// planned move is none (the held leaf's: occupationPlanned, a flight or a recall
// stays a fact), a goal that failed is its own moment, and away from town the
// market reaches the bot only as WTB/WTS on what it watches.
function momentOf(state, baseline, facts, { board = null, leaf = null, why = '', nativeHolds = true } = {}) {
    if (!baseline) return 'first';
    if (Reaction.onVisit(state)) return 'town';
    if (!nativeHolds) return 'native';
    const goal = Reaction.goalMoment(why);
    if (goal) return goal;
    const names = [];
    Sections.factEvents(name => baseline[name], facts, false, names, Sections.occupationPlanned(state, leaf));
    if (names.length) return names[0];
    return board && Sections.marketCrossed(board, baseline.marketWatch, Number(state.characterId)) ? 'market' : null;
}

function createStats() {
    return { builds: 0, skipped: 0, elsewhere: 0, goal: 0, posted: 0, moments: {}, why: {}, cardDrops: 0,
        cardRefused: {}, where: {},
        // What the queue's economy refreshes are worth: asked, full builds, built
        // on a state whose next step rebuilds anyway, dropped stale, plans sent, sent acts.
        refresh: { asked: 0, built: 0, dirty: 0, stale: 0, sent: 0, acts: 0 } };
}

// The first refusal's name; a raised event names its sections (the soft causes share
// the one refusal otherwise).
function whyOf(state, refused) {
    // A raise drops the card as its state publishes: a dirty bot's no_card is its raise.
    const dirty = Number(state.stats?.wishDirty) || 0;
    if (refused !== 'wish_dirty' && !(refused === 'no_card' && dirty)) return refused || 'not_asked';
    return `wish_dirty+${Sections.sectionNames(dirty).join('+')}`;
}

// What a build left the bot doing, per bot, to compare the next build with.
const seen = new Map();
const added = (rows, name, kind) => {
    const row = rows[name] ||= [0, 0, 0, 0];
    row[0]++;
    if (kind) row[kind]++;
};
// A build whose own card failed its proof as it published: the bot goes on with no card.
function cardRefused(stats, why = 'unknown', sections = 0, rootKey = '', state = null, leaf = null) {
    const name = `${why}${sections ? `+${Sections.sectionNames(sections).join('+')}` : ''}@${String(rootKey).split(':')[0] || 'none'}|${state?.activity}|${leaf?.activity || '-'}`;
    stats.cardRefused[name] = (stats.cardRefused[name] || 0) + 1;
}
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
    // Where the builds still come from: the moment, what refused the plan, the bot's
    // occupation, the leaf it held and what the build chose.
    const cause = /^(not_field|no_card|party|plan_)/.test(why) && plan.economy?.heldRefused || why;
    added(stats.where, `${moment}|${cause}|${state.activity}|${leaf?.activity || '-'}>${pick?.activity || '-'}`, kind);
    if (moment !== null) { added(stats.moments, moment, kind); return; }
    stats.skipped++;
    if (kind === 1) stats.elsewhere++;
    if (kind === 2) stats.goal++;
    if (kind === 3) stats.posted++;
    added(stats.why, why, kind);
}

module.exports = { momentOf, createStats, settle, cardRefused };
