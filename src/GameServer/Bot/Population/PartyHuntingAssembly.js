const SpotService = invoke('GameServer/Bot/AI/SpotService');

function nearby(members) {
    const anchor = members[0]?.loc;
    return !!anchor && members.every(member => member.loc
        && Math.hypot(member.loc.locX - anchor.locX, member.loc.locY - anchor.locY) <= 900
        && Math.abs(member.loc.locZ - anchor.locZ) <= 200);
}

// The assembly's wait (a C4 party waits for the members on their way and goes on
// without one nothing brings): on the party's ground stands a cold member, grouped or
// hunting, on no trip, inside the spot and near the first such member. { at: the
// latest arrival of a member on its way (its trip's known end; null: none on its way),
// absent: the ids neither on the ground nor on their way }. Pure: worker, party step.
const REASON = 'party_assembly_timeout';
function wait(members, spot, timestamp) {
    const placed = member => member.phase === 'cold' && ['grouped', 'hunting'].includes(member.activity)
        && !member.stats?.travel && SpotService.containsLocation(spot, member.loc);
    const anchor = members.find(placed);
    let at = 0;
    const absent = [];
    for (const member of members) {
        const arrival = Number(member.stats?.travel?.arrivalAt) || 0;
        if (member.phase === 'cold' && arrival > timestamp) at = Math.max(at, arrival);
        else if (!placed(member) || !nearby([anchor, member])) absent.push(Number(member.characterId));
    }
    return { at: at || null, absent };
}

// Does the party stand gathered on its ground: every member inside the spot (a raid's
// area; any ground for a profile without one) and near the first member? The one answer
// of "the party is together" for the cold step (ready), its route's repair (BotRoute),
// a party turning hot (HotPartyLifecycle: a C4 party gathers before it hunts together,
// so a party still on its way to its members stays cold) and a marked raid's opening.
// Pure: worker and main.
function gathered(members, spot) {
    return nearby(members) && members.every(member => SpotService.containsLocation(spot, member.loc));
}

function meetingPending(members) {
    return members.some(member => !!member.stats?.tradeMeeting);
}

function ready(party, members, spot) {
    const Roster = require('../../Clan/ClanRaidRoster');
    if (Roster.markerFor(party) && !Roster.held(party, spot)
        && !Roster.exact(members.map(member => Number(member.characterId)), Roster.markerFor(party).memberIds)) return false;
    // Non-grid profiles have caller-defined geometry. Production hunting
    // sectors use the shared grid and dungeon partition classification.
    if (!/^(-?\d+)_(-?\d+)(?::.+)?$/.test(String(spot?.id || '')) && spot?.raidBoss !== true) return true;
    return party?.spotId === spot.id && gathered(members, spot) && members.every(member =>
        member.phase === 'cold' && ['grouped', 'hunting'].includes(member.activity) && !member.stats?.travel);
}

module.exports = { ready, nearby, gathered, meetingPending, wait, REASON };
