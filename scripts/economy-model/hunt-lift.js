'use strict';
// The model's hunt measurement with the game's solo readiness switched off: the
// hunt table (hunt-table.js) measures what a bot's combat gives at a spot, not
// whether the game's solo gate lets it start. The lift goes through the module
// objects the cold resolver calls (BackgroundResolver -> BotTargetMatchup,
// ColdCombatProfile, BotEncounterReadiness), so the fight itself is the game's
// code, unchanged. Offline only (the builder and its children); never loaded by
// the server.
require('../../src/Global');
const LIMITS = require('./design/limits');

const TM = invoke('GameServer/Bot/AI/BotTargetMatchup');
const CCP = invoke('GameServer/Bot/Population/ColdCombatProfile');
const ER = invoke('GameServer/Bot/AI/BotEncounterReadiness');

const WHOLE = Symbol('wholeBar');
let saved = null;

// ARCH-NOTE: the solo gate is the game's decision ("our choice, not C4" in
// BotEncounterReadiness); the model measures combat and applies its own
// admission per species when it reads the table. The rest rule here is the
// model's (ours, the FIGHT_COVER limits row): the bot fights when its HP above
// the potion line (the game's atVitals takes the line off the bar) and its MP
// cover one expected fight with this mob, so the fight ends without a potion,
// or at a whole bar; the game's rest physics (sit and stand-up lines) stay.
function lift(on) {
    if (!on) {
        if (saved) {
            TM.spotShares = saved.spotShares;
            CCP.npcForSpot = saved.npcForSpot;
            ER.atVitals = saved.atVitals;
            ER.evaluate = saved.evaluate;
        }
        saved = null;
        return;
    }
    if (saved) return;
    const held = saved = { spotShares: TM.spotShares, npcForSpot: CCP.npcForSpot, atVitals: ER.atVitals, evaluate: ER.evaluate };
    TM.spotShares = (profiles, spot, options = {}) => held.spotShares(profiles, spot, { ...options, soloSafety: false });
    CCP.npcForSpot = (spot, roll, options = {}) => held.npcForSpot(spot, roll, { ...options, soloSafety: false });
    ER.atVitals = (profiles, hp, mp, pet) => {
        const remaining = held.atVitals(profiles, hp, mp, pet);
        remaining[WHOLE] = profiles.filter(profile => profile.servitor !== true).every(owner => hp >= owner.maxHp && mp >= owner.maxMp);
        return remaining;
    };
    ER.evaluate = (remaining, target, attacksOf) => {
        const verdict = held.evaluate(remaining, target, attacksOf);
        if (verdict.ready) return verdict;
        if (remaining[WHOLE]) return { ...verdict, ready: true, reason: 'whole_bar' };
        return Number(verdict.survival?.survivalRatio) >= LIMITS.FIGHT_COVER.value ? { ...verdict, ready: true, reason: 'covers_one_fight' } : verdict;
    };
}

// The canary: a level-1 orc mystic (line 51) in bare hands at a gremlin-only
// spot. The game's gate refuses every gremlin to it (no kill), the lift lets it
// fight (kills). Anything else means the lift no longer reaches the fight and
// a table built now would measure the gate: throw.
const CANARY = Object.freeze({ spotId: '-12_43', line: '51', level: 1, hours: 1 });
function checkLift(Generator, spot) {
    if (!spot) throw new Error(`hunt lift canary: no spot ${CANARY.spotId} in the catalogue`);
    const was = saved !== null;
    lift(false);
    const gated = Generator.hunt(spot, CANARY.line, CANARY.level, 0, CANARY.hours).mobs;
    lift(true);
    const lifted = Generator.hunt(spot, CANARY.line, CANARY.level, 0, CANARY.hours).mobs;
    if (!was) lift(false);
    if (!(lifted > 0) || gated !== 0) {
        throw new Error(`hunt lift canary at ${CANARY.spotId} (line ${CANARY.line} L${CANARY.level} bare): kills ${gated} gated, ${lifted} lifted; `
            + 'expected 0 and more than 0: the lift no longer reaches the resolver\'s solo gate');
    }
    return { gated, lifted };
}

module.exports = { lift, checkLift, CANARY };
