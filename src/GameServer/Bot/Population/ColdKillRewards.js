const ProgressionRates = invoke('GameServer/ProgressionRates');
const BackgroundDropResolver = invoke('GameServer/Bot/Population/BackgroundDropResolver');
const ColdCombatProfile = invoke('GameServer/Bot/Population/ColdCombatProfile');

function randInt(rng, min, max) {
    return Math.floor(rng() * (max - min + 1)) + min;
}

// Rewards of the kills one cold fighter or one cold party made in a resolve.
// Solo and party fights both take their rewards from here, so a reward rule
// changes for both at once; the base exp and SP of every cold kill come only
// from this function.
//
// The random draws come in a fixed order: base exp/SP of every kill, the drop
// roll of every kill, the spot's fallback adena for kills without reward data,
// then, for each of the first `lootKills` kills, its drop owner (only when
// `dropOwners` recipients share the drops) and its spoil.
function roll({ spot, kills, killerLevel, rng, spoiler = false, lootKills = kills.length, dropOwners = 0 }) {
    const OverhitReward = invoke('GameServer/Progression/OverhitReward');
    const progression = kills.map((kill) => {
        const base = BackgroundDropResolver.progressionForFight({ spot, npcSelfId: kill.npcSelfId, rng });
        const overhit = OverhitReward.resolveContext(kill.overhitContext, base.exp);
        return { exp: overhit.adjustedExp, sp: base.sp, overhit };
    });
    const rolls = kills.map((kill) => BackgroundDropResolver.rollRewardsForFight({
        spot,
        killerLevel,
        npcSelfId: kill.npcSelfId,
        rng
    }));
    const rates = ProgressionRates.profile();
    const adena = rolls.reduce((sum, rolled) => (
        sum + (rolled === null
            ? Math.round(randInt(rng, spot.rewards.adenaMin, spot.rewards.adenaMax) * rates.adena)
            : rolled.adena)
    ), 0);
    const loot = [];
    for (let index = 0; index < Math.min(kills.length, lootKills); index++) {
        const drops = rolls[index]?.items || [];
        const owner = drops.length && dropOwners > 0
            ? Math.min(dropOwners - 1, Math.floor(rng() * dropOwners))
            : 0;
        const spoil = spoiler
            ? BackgroundDropResolver.rollSpoilForFight({ spot, killerLevel, npcSelfId: kills[index].npcSelfId, rng })
            : [];
        loot.push({ drops, owner, spoil });
    }
    return { progression, adena, loot };
}

// Exp and SP one fighter receives from a base reward (a whole kill or a party
// share): the spot pressure multiplier, the server rates and the fighter's own
// exp bonus.
function scaledProgression({ exp, sp }, { expMultiplier, rates, profile, timestamp }) {
    return {
        exp: Math.round(exp * expMultiplier * rates.exp * ColdCombatProfile.statMultiplier(profile, 'expMul', timestamp)),
        sp: Math.round(sp * expMultiplier * rates.sp)
    };
}

module.exports = { roll, scaledProgression };
