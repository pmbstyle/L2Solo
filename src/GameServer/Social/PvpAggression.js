// A 0..1 aggression scale, not combat permission. The midpoint preserves balance.
const PvpRules = require('../PvpRules');
function normalize(value) {
    if (value === undefined || value === null || String(value).trim() === '') return 0.5;
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0.5;
}

function scaleChance(chance, aggression) {
    const base = Math.max(0, Math.min(1, Number(chance) || 0));
    // Do not turn a fully restrained response (e.g. friendship) into aggression.
    if (base === 0) return 0;
    const level = normalize(aggression);
    return level <= 0.5 ? base * level * 2 : base + (1 - base) * (level * 2 - 1);
}

// Lower aggression demands a safer fight and makes withdrawal more likely.
// Keep a floor: aggression never removes risk/resource-based escape decisions.
function retreatMultiplier(aggression) {
    const level = normalize(aggression);
    return level <= 0.5 ? 2 / (1 + level * 2) : 1 - (level - 0.5) * 0.8;
}

function retreatChance(chance, aggression) {
    return Math.max(0, Math.min(1, chance * retreatMultiplier(aggression)));
}

function retreatHp(threshold, aggression) {
    return Math.max(0.1, Math.min(0.6, threshold * retreatMultiplier(aggression)));
}

// What an attack costs a bot in C4 standing (PvpRules, both threads): attacking a
// character without karma flags the attacker, killing a white unflagged one makes it
// red (karma); a PK and an enemy of a mutual clan war are free. The share of an
// attack's chance the bot gives up for it, by its caution (weights ours, not C4).
// standing: { ownKarma, targetKarma, targetFlagged, war } (missing: a white unflagged
// target, no war). A bot with karma gives up every attack it would start outside a war:
// it washes its karma first (C9's karma wash; ours).
function karmaCost(persona, { ownKarma = 0, targetKarma = 0, targetFlagged = false, war = false } = {}) {
    if (war) return 0;
    if (Number(ownKarma) > 0) return 1;
    const caution = Math.max(0, Math.min(1, Number(persona?.traits?.caution ?? 0.5) || 0));
    if (PvpRules.killOutcome({ killerKarma: ownKarma, victimKarma: targetKarma, victimFlagged: !!targetFlagged }) === 'pk') {
        return 0.2 + caution * 0.4;
    }
    return PvpRules.flagsAttacker(targetKarma) ? caution * 0.1 : 0;
}
// A side's standing as karmaCost reads it: a cold row (its karma, its cold PvP flag at
// `at`), a hot actor (its karma and flag now).
const coldStanding = (state, at) => ({ karma: Number(state?.stats?.karma) || 0,
    flagged: Number(state?.stats?.coldPvp?.flagUntil || 0) > at });
const hotStanding = actor => ({ karma: Number(actor?.fetchKarma?.()) || 0, flagged: Number(actor?.fetchPvpFlag?.()) > 0 });
// The standing of cold row `a` attacking cold row `b` at `at` (karmaCost's argument);
// war: their clans' mutual war (the pair's relation, InteractionMemory.assess).
function coldPair(a, b, at, war = false) {
    const target = coldStanding(b, at);
    return { ownKarma: coldStanding(a, at).karma, targetKarma: target.karma, targetFlagged: target.flagged, war: war === true };
}

module.exports = { normalize, scaleChance, retreatMultiplier, retreatChance, retreatHp, karmaCost, coldStanding, hotStanding, coldPair };
