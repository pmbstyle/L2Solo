'use strict';
const TargetMatchup = invoke('GameServer/Bot/AI/BotTargetMatchup');
const TendencyRoll = invoke('GameServer/Bot/AI/TendencyRoll');
const ColdRest = invoke('GameServer/Bot/Population/ColdRest');
const Valuation = invoke('GameServer/Bot/Economy/EconomicValuation');

// Owner: the one decision of "it got dangerous", hot and cold (E70, §13.6):
// drink, run, sit or fight on, each priced in the bot's hours, and what a run
// and a last strike are bound by. No live actor and no world: the hot adapter
// is DangerMoment (each tick of a fight), the cold one BackgroundResolver
// (each slice's end); the worker loads this module, not DangerMoment.
// First choices, calibrated later by the hot harness:
// the survival margin the solo gate admits (BotTargetMatchup.SOLO_GATE_MARGIN)
// reads as a 0.15% lose chance, 0.8 of it as 5%, two thirds of it as 50%:
// the gate sweep (T132) saw cold hunts rarely lost below an even ratio.
const LOSE_SLOPE = 16;
const ADMITTED_LOSE = 0.0015;
// Only a viable escape receives this discount; faster pursuers rule it out.
const FLEE_EXPOSURE = 0.5;
// One roll moves the bot's sense of the death price by up to +-50%.
const ROLL_SPREAD = 0.5;
// A hot Npc forgets a target this far away (Npc's chase), so a run lasts until then.
const CHASE_BREAK_DISTANCE = 1500;
// One leg of a run, with no pursuer behind it.
const EMERGENCY_RETREAT_DISTANCE = 850;
// A run that opens less than this gap in this time is no escape (FleeingState).
const RETREAT_PROGRESS_MS = 8000;
const MIN_RETREAT_DISTANCE_GAIN = 64;
// A wounded bot stays for a kill this close (BotEmergencyFinisher).
const FINISH_DAMAGE_MARGIN = 0.70;
const FINISH_HITS = 2;
const FINISH_MS = 4000;

// The chance to lose the fight from the survival ratio: how many times the
// enemies' remaining HP the bot deals before its own remaining HP runs out.
function loseChance(survivalRatio) {
    const scale = (1 / ADMITTED_LOSE - 1) ** (1 / LOSE_SLOPE) / TargetMatchup.SOLO_GATE_MARGIN;
    return survivalRatio > 0 ? 1 / (1 + (survivalRatio * scale) ** LOSE_SLOPE) : 1;
}

// One decision for hot and cold, in hours. Inputs: own HP now and max, the
// survival ratio at this HP (null = unknown), attacked (someone hits the bot),
// the potion it would drink ({ heal, price } or null), hours to rest to full,
// the hours the fight still needs (given up by running or sitting), the death price (EconomicValuation.deathHours), the price of money (hours
// per adena), the trait weight on risk (EconomicValuation.riskWeight:
// caution, resilience, frustration) and the decision's roll.
// null leaves the caller's own rule in place, also when the price of money is
// unknown: a free potion would be drunk whenever the last one wears off.
function decide({ hp, maxHp, survivalRatio, attacked = true, canEscape = true, potion = null, restHours = 0, fightHours = 0,
    deathHours, moneyPrice, riskWeight, roll = 0.5 } = {}) {
    if (!Number.isFinite(survivalRatio) || !(maxHp > 0) || !(hp > 0)
        || !(deathHours >= 0) || !Number.isFinite(moneyPrice) || moneyPrice < 0 || !(riskWeight >= 0)) return null;
    const risk = deathHours * riskWeight * (1 + ROLL_SPREAD * (2 * roll - 1));
    const lose = loseChance(survivalRatio);
    const hours = { fight: lose * risk };
    const heal = Math.min(Math.max(0, Number(potion?.heal) || 0), maxHp - hp);
    if (heal > 0) {
        hours.drink = Math.max(0, Number(potion.price) || 0) * moneyPrice
            + loseChance(survivalRatio * (hp + heal) / hp) * risk;
    }
    const leave = Math.max(0, restHours) + Math.max(0, fightHours);
    if (attacked && canEscape) hours.flee = lose * FLEE_EXPOSURE * risk + leave;
    if (!attacked) hours.sit = leave;
    let action = 'fight';
    for (const option of Object.keys(hours)) if (hours[option] < hours[action]) action = option;
    return { action, loseChance: lose, hours };
}

// The moment of a fight under way, from both adapters' reads of it. profiles:
// the fighters at the HP and MP left (TargetMatchup.atVitals); enemy: what still
// hits the bot as one mob, its HP left, engaged. botId, targetId: the roll,
// kept for the whole fight with this target. deathHours: the held table
// price (a live death also waits for its respawn). potion: { heal, price }.
function moment({ profiles, enemy, hp, maxHp, mp, maxMp, level, classId, attacked = true, canEscape, potion = null,
    deathHours, moneyPrice, riskWeight, botId, targetId }) {
    const survival = TargetMatchup.soloSurvival(profiles, enemy);
    // Damage per second of the same attack envelope as the survival ratio.
    const damageRate = TargetMatchup.damageRate(profiles, enemy);
    const restHours = ColdRest.estimateRestMs({ level, stats: { classId } }, { hp, maxHp, mp, maxMp }) / 3600000;
    return decide({ hp, maxHp, survivalRatio: survival.survivalRatio, attacked, canEscape, potion, restHours,
        fightHours: damageRate > 0 ? enemy.maxHp / damageRate / 3600 : 0,
        deathHours: Valuation.liveDeathHours(deathHours), moneyPrice, riskWeight,
        roll: TendencyRoll.roll('danger', botId, targetId) });
}

// Does the bot outrun this threat (hot BotEscapePolicy, every threat)?
function outruns(botSpeed, threatSpeed) {
    return botSpeed > threatSpeed;
}

// The run that shakes a chasing monster off: until the gap reaches the chase's
// end. Null when it opens too slowly to be an escape (hot FleeingState turns
// and defends then).
function chaseMs(botSpeed, threatSpeed = 0) {
    const gain = botSpeed - threatSpeed;
    if (!outruns(botSpeed, threatSpeed) || gain * RETREAT_PROGRESS_MS / 1000 < MIN_RETREAT_DISTANCE_GAIN) return null;
    return CHASE_BREAK_DISTANCE / gain * 1000;
}

// How long a chasing monster keeps a running bot in its reach.
function reachMs(reach, botSpeed, threatSpeed = 0) {
    return reach / (botSpeed - threatSpeed) * 1000;
}

// Does a wounded bot stay for the kill: its next hit, at the margin, ends the
// target within the hits and the time a last strike may take?
function finishes(targetHp, hit, actionMs) {
    if (!(hit > 0)) return false;
    const hits = Math.ceil(targetHp / (hit * FINISH_DAMAGE_MARGIN));
    return hits <= FINISH_HITS && (hits + 1) * actionMs <= FINISH_MS;
}

module.exports = { LOSE_SLOPE, FLEE_EXPOSURE, ROLL_SPREAD, CHASE_BREAK_DISTANCE, EMERGENCY_RETREAT_DISTANCE,
    RETREAT_PROGRESS_MS, MIN_RETREAT_DISTANCE_GAIN, FINISH_DAMAGE_MARGIN, FINISH_HITS, FINISH_MS,
    loseChance, decide, moment, outruns, chaseMs, reachMs, finishes };
