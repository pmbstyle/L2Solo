const SpotService = invoke('GameServer/Bot/AI/SpotService');

function ready(party, members, spot) {
    // Non-grid profiles have caller-defined geometry. Production hunting
    // sectors use the shared grid and dungeon partition classification.
    if (!/^(-?\d+)_(-?\d+)(?::.+)?$/.test(String(spot?.id || ''))) return true;
    return party?.spotId === spot.id && members.length > 0 && members.every(member =>
        member.phase === 'cold' && ['grouped', 'hunting'].includes(member.activity)
        && !member.stats?.travel && SpotService.containsLocation(spot, member.loc));
}

module.exports = { ready };
