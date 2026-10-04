const BotRoles = invoke('GameServer/Bot/AI/BotRoles');

// HP and MP shares under which a bot stops to rest. A party fights a little
// longer than a solo bot; a bot that already retreated (recovery locked)
// rests until it is nearly full.
const THRESHOLDS = {
    solo: { hp: 0.35, mp: 0.20 },
    party: { hp: 0.30, mp: 0.18 },
    locked: { hp: 0.95, mp: 0.95 }
};

// The mana rule: alone only casters rest for MP; in a party tanks and music
// fighters also recover MP for taunts and songs.
function restsForMana(subject, party = false) {
    return party ? BotRoles.needsPartyManaRecovery(subject) : BotRoles.shouldRestForMana(subject);
}

function needsRest(subject, hpRatio, mpRatio, options = {}) {
    const limits = options.locked ? THRESHOLDS.locked : options.party ? THRESHOLDS.party : THRESHOLDS.solo;
    return hpRatio < limits.hp || (mpRatio < limits.mp && restsForMana(subject, options.party === true));
}

module.exports = { THRESHOLDS, restsForMana, needsRest };
