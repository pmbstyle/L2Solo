'use strict';

// The class mix of the economy model's mains: one weight per final class (the
// second profession, also the spot table's line), in % of mains. It is ours
// until the new seeder: our estimate of a C4 server's mix, no source, and not
// the game's own (PopulationConfig.classMix names starter classes and counts
// crafters in its dwarf share, which the target gives each main as a twin).
// Every cohort the model builds (synthetic, fresh, the lines drawn for a
// save's first-profession mains) and the capacity bands read this one table,
// so the new seeder's mix replaces it here and nowhere else. Warsmith has no
// main (weight 0): it is only a crafter twin.
const CLASS_WEIGHTS = Object.freeze({
    // nukers: Spellhowler, Sorcerer, Spellsinger, Necromancer
    40: 5.5, 12: 4.5, 27: 4.5, 13: 3.5,
    // melee: Destroyer, Gladiator, Tyrant, Warlord
    46: 6, 2: 4, 48: 3.5, 3: 3.5,
    // archers: Hawkeye, Silver Ranger, Phantom Ranger
    9: 6, 24: 5, 37: 5,
    // daggers: Treasure Hunter, Abyss Walker, Plains Walker
    8: 3.5, 36: 3, 23: 2.5,
    // Bounty Hunter
    55: 8,
    // tanks: Dark Avenger, Shillien Knight, Paladin, Temple Knight
    6: 2.5, 33: 2, 5: 1.5, 20: 1,
    // Bishop
    16: 5,
    // summoners: Phantom Summoner, Warlock, Elemental Summoner
    41: 2, 14: 1.5, 28: 1.5,
    // Overlord
    51: 2,
    // buffers as mains: Prophet, Shillien Elder, Elven Elder, Warcryer, Bladedancer, Swordsinger
    17: 3, 43: 2.5, 30: 2.5, 52: 2, 34: 1.5, 21: 1.5
});

// Crafter twins: every Bounty Hunter main has one (the dwarf pair), and the
// patient-crafter accounts of the other classes: 11 % of all accounts (our
// start value). A twin is an Artisan below level 40 and a Warsmith from 40, at
// its main's level (ours).
const BOUNTY_HUNTER = 55;
const PATIENT_CRAFTER_SHARE = 0.11;
const ARTISAN = 56, WARSMITH = 57, WARSMITH_LEVEL = 40;

function weightSum(weights = CLASS_WEIGHTS) {
    return Object.values(weights).reduce((sum, weight) => sum + weight, 0);
}

// The share of accounts with a crafter twin.
function twinShare(weights = CLASS_WEIGHTS) {
    return (weights[BOUNTY_HUNTER] || 0) / weightSum(weights) + PATIENT_CRAFTER_SHARE;
}

function twinClass(level) {
    return level < WARSMITH_LEVEL ? ARTISAN : WARSMITH;
}

module.exports = { CLASS_WEIGHTS, BOUNTY_HUNTER, PATIENT_CRAFTER_SHARE, ARTISAN, WARSMITH, weightSum, twinShare, twinClass };
