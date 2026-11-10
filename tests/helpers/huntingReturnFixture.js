'use strict';

// Travel tests need a catalogued hunting origin: an arbitrary old coordinate
// is no longer enough to send a shopper out without a valid hunting ground.
module.exports = function huntingReturnFixture(id, loc, name = id) {
    const Service = invoke('GameServer/Bot/AI/SpotService');
    const Profiles = invoke('GameServer/Bot/Population/SpotProfiles');
    const profiles = Profiles.ensure(), spots = Service.ensureIndexed();
    const spot = { id, name, center: { ...loc }, arrivalPoints: [{ ...loc }],
        minLevel: 1, maxLevel: 80, avgLevel: 20, density: 1,
        npcEntries: [], npcSelfIds: [], npcNames: [], tags: [], tagsAuthoritative: true };
    Service.spots = [...spots, spot];
    Profiles.cache = [...profiles, spot];
    return { loc: { ...loc }, regionName: name, spotId: id };
};
