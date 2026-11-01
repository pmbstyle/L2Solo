const TargetMatchup = invoke('GameServer/Bot/AI/BotTargetMatchup');

// Readiness to start a voluntary solo fight (user 10-30, "Rest like a player"):
// a bot sits when the HP and MP it has now do not cover a bad fight with this
// mob. Emergency retreat thresholds govern an existing fight and must not be
// used to admit the next one. Hot and cold read this one rule.
// atVitals: once per scan; pet: the one beside the bot now, kept at its own HP.
function atVitals(profiles, hp, mp, pet = null) {
    const remaining = TargetMatchup.ownersAtVitals(profiles, hp, mp);
    if (pet) remaining.push(pet);
    return remaining;
}
function evaluate(remaining, target) {
    const survival = TargetMatchup.soloSurvival(remaining, target);
    return { ready: survival.eligible, reason: survival.eligible ? 'ready' : 'no_reserve', survival };
}

module.exports = { atVitals, evaluate };
