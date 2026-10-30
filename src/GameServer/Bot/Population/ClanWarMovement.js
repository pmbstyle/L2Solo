'use strict';
const Home = require('./ClanWarHome');
// The operation names a witnessed destination. Normal trip payment, timing,
// geodata placement and party arrival still own the physical move.
function route({ leader, party, members, spot, timestamp, spots, wars }) {
    const op = party?.stats?.warOperation;
    if (!op || !require('../../Clan/ClanWarConfig').enabled) return { active: false, route: null };
    const returning = op.status === 'returning' || timestamp >= op.expiresAt || !wars?.between(op.clanId, op.enemyClanId).mutual;
    const spotId = returning ? op.homeSpotId : op.targetSpotId;
    if (!spotId || members.some(s => s.stats?.pvpEncounter)) return { active: true, route: null };
    const catalog = require('../AI/SpotIndex').spotById(spots, spotId);
    if (!catalog) return { active: true, route: null };
    const loc = returning ? Home.point(op, catalog) : op.targetLoc;
    if (!loc) return { active: true, route: null };
    const arrivalSpot = loc ? { ...catalog, center: loc, arrivalPoints: [loc] } : catalog;
    const close = loc && members.every(s => returning ? Home.reached(s.loc, loc)
        : s.loc && Math.hypot(s.loc.locX - loc.locX, s.loc.locY - loc.locY) <= 900
            && Math.abs(s.loc.locZ - loc.locZ) <= 200);
    if (leader.spotId === spotId && close) return { active: true, route: null };
    const movement = require('./BotRoute').record(leader, { spotId }, party, members, { spots, currentSpot: spot, timestamp })
        || (leader.spotId === spotId && members.every(s => s.phase === 'cold' && s.vitals.hp > 0 && !s.stats?.travel)
            ? { needed: true, mode: 'party', currentSpotId: leader.spotId, spotId, regionName: catalog.name } : null);
    if (!movement) return { active: true, route: null };
    const destinations = invoke('GameServer/Bot/AI/SpotService').arrivalPointsForParty(members, arrivalSpot);
    if (!destinations) return { active: true, route: null };
    const to = destinations[String(leader.characterId)];
    return { active: true, route: { ...movement, to, destinations,
        travelMs: require('./ColdTrip').spotTripMs(leader, to), cause: returning ? 'clan_war_return' : 'clan_war_attack' } };
}
module.exports = { route };
