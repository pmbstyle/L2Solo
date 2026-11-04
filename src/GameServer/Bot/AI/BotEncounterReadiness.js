const TargetMatchup = invoke('GameServer/Bot/AI/BotTargetMatchup');
// lazy: HealingPotionStock reaches the economy, which loads this module's readers.
let PotionStock;
const potionStock = () => PotionStock || (PotionStock = invoke('GameServer/Bot/AI/HealingPotionStock'));

// Readiness to start a voluntary solo fight (user 10-30, "Rest like a player"):
// a bot sits when the HP and MP it has now do not carry it through a bad fight
// with this mob above the line where it would reach for a potion
// (HealingPotionStock.useThreshold, the one the fight drinks by): a potion is
// the answer to a fight gone wrong, not part of the plan, as a C4 player sits
// down between mobs instead of drinking every fight. The attacks count only
// the MP they may spend (BotTargetMatchup.spendableMp: a healer keeps its
// heals' share). The longer the fight, the more can go wrong in it (misses,
// a mob's skill, a neighbour that joins), so the damage it must cover grows
// with the fight's expected length: by FIGHT_MARGIN_SECONDS a second fight's
// worth. Emergency retreat thresholds govern an existing fight and must not be
// used to admit the next one. Hot (HuntingState) and cold (BackgroundResolver)
// read this one rule.
// Our choice, not C4 (a player's judgement): calibrated on the spot table's
// sample spots (melee fighters keep resting, healers stop dying).
const FIGHT_MARGIN_SECONDS = 60;
const SPARE_SECONDS = 3;

// The owners at the HP above their potion line and the MP they have, once per
// scan; pet: the one beside the bot now, kept at its own HP. An owner at or
// below its line has no HP to fight on (evaluate: not ready).
// The profiles of a whole bar (the route's gate, soloCanHunt, and its spot
// bound): one copy per profiles array, so the caches keyed by a profile
// object (the opening, the mob's incoming rate, the hit views) hit on every
// verdict of a search, as they do on the array itself. Dies with the array.
const wholeBars = new WeakMap();
function atWholeBar(profiles) {
    let remaining = wholeBars.get(profiles);
    if (!remaining) wholeBars.set(profiles, remaining = atVitals(profiles, Infinity, Infinity,
        profiles.find(profile => profile.servitor === true) || null));
    return remaining;
}
// hp, mp: Infinity for a whole bar (atWholeBar).
function atVitals(profiles, hp, mp, pet = null) {
    const owners = profiles.filter(profile => profile.servitor !== true);
    const remaining = TargetMatchup.ownersAtVitals(owners, hp, mp);
    // Each receiver its own line on its own bar (a copy of ownersAtVitals' own).
    remaining.forEach((profile, index) => {
        const bar = Number(owners[index].maxHp);
        if (profile !== owners[index] && bar > 0 && Number.isFinite(profile.maxHp)) profile.maxHp -= potionLine(owners[index]) * bar;
    });
    if (pet) remaining.push(pet);
    return remaining;
}
// The owner's potion line, once per profile object (a cold round's fights and
// a hot scan share theirs).
const lines = new WeakMap();
function potionLine(owner) {
    let line = lines.get(owner);
    if (line === undefined) lines.set(owner, line = potionStock().useThreshold(owner));
    return line;
}
// Does the side stand (survival.seconds, above the line) through the fight it
// expects (survival.fightSeconds: the time its attacks take to deal the mob's
// HP, whatever HP it has), with a share more for each second of it, and a few
// seconds more of the mob's damage: a fight of a few hits is decided by one
// critical hit? More HP never refuses a fight less HP takes.
function covers(survival) {
    const ratio = Number(survival.survivalRatio), seconds = Number(survival.seconds);
    if (!(ratio >= 1)) return false;
    if (!Number.isFinite(seconds)) return true;
    const fight = Number.isFinite(Number(survival.fightSeconds)) ? Number(survival.fightSeconds) : seconds / ratio;
    return seconds >= fight * (1 + fight / FIGHT_MARGIN_SECONDS) + SPARE_SECONDS;
}
// attacksOf: as soloSurvival's.
function evaluate(remaining, target, attacksOf = undefined) {
    if (remaining.some(profile => profile.servitor !== true && profile.soloDamageReceiver !== false && profile.maxHp <= 0)) {
        const survival = { eligible: false, survivalRatio: 0, areaShare: 0, reason: 'potion_line' };
        return { ready: false, reason: 'no_reserve', survival };
    }
    const survival = TargetMatchup.soloSurvival(remaining, target, TargetMatchup.SOLO_GATE_MARGIN, attacksOf);
    const ready = survival.survivalRatio === null || covers(survival);
    return { ready, reason: ready ? 'ready' : 'no_reserve', survival };
}

// Where a rest for a fight it was refused ends (RestPolicy.restOver; hot
// HuntingState, cold BackgroundResolver): the HP and MP, on the way its regen
// takes (regen: { hp, mp } a tick, MP regained whatever its mana rule), at which
// readiness admits that fight (profiles, pet: as atVitals'; fight: the view it
// was refused, its pull with it), capped at whole: full HP and MP. The way is
// halved REST_TARGET_STEPS times, so the target lies within 1/32 of the rest
// to whole past the exact point, never before it: 1 + 5 verdicts, once a rest.
// ticks: the regen ticks it takes to get there.
const REST_TARGET_STEPS = 5;
function restTarget(profiles, pet, fight, vitals, regen) {
    const hp = Number(vitals.hp) || 0, maxHp = Number(vitals.maxHp) || 0;
    const mp = Number(vitals.mp) || 0, maxMp = Number(vitals.maxMp) || 0;
    const rateHp = Number(regen?.hp) || 0, rateMp = Number(regen?.mp) || 0;
    const ticksFor = (missing, rate) => missing > 0 ? (rate > 0 ? missing / rate : Infinity) : 0;
    const whole = Math.max(ticksFor(maxHp - hp, rateHp), ticksFor(maxMp - mp, rateMp));
    if (!Number.isFinite(whole)) return { hp: maxHp, mp: maxMp, ticks: Infinity };
    const at = share => ({ hp: Math.min(maxHp, hp + rateHp * whole * share),
        mp: Math.min(maxMp, mp + rateMp * whole * share), ticks: whole * share });
    const admits = point => evaluate(atVitals(profiles, point.hp, point.mp, pet), fight).ready;
    if (!admits(at(1))) return at(1);
    let low = 0, high = 1;
    for (let step = 0; step < REST_TARGET_STEPS; step++) {
        const middle = (low + high) / 2;
        if (admits(at(middle))) high = middle;
        else low = middle;
    }
    return at(high);
}

module.exports = { FIGHT_MARGIN_SECONDS, atVitals, atWholeBar, evaluate, restTarget };
