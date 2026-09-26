const SpotService = invoke('GameServer/Bot/AI/SpotService');

function nearby(members) {
    const anchor = members[0]?.loc;
    return !!anchor && members.every(member => member.loc
        && Math.hypot(member.loc.locX - anchor.locX, member.loc.locY - anchor.locY) <= 900
        && Math.abs(member.loc.locZ - anchor.locZ) <= 200);
}

function ready(party, members, spot) {
    // Non-grid profiles have caller-defined geometry. Production hunting
    // sectors use the shared grid and dungeon partition classification.
    if (!/^(-?\d+)_(-?\d+)(?::.+)?$/.test(String(spot?.id || '')) && spot?.raidBoss !== true) return true;
    return party?.spotId === spot.id && members.length > 0 && nearby(members) && members.every(member =>
        member.phase === 'cold' && ['grouped', 'hunting'].includes(member.activity)
        && !member.stats?.travel && SpotService.containsLocation(spot, member.loc));
}

module.exports = { ready, nearby };
