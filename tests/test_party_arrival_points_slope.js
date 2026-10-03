const assert = require('assert');
require('../src/Global');
const Data = invoke('GameServer/DataCache');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const Geodata = invoke('GameServer/Geodata/GeodataEngine');
const Assembly = require('../src/GameServer/Bot/Population/PartyHuntingAssembly');
Data.init();

// A party's arrival points: one anchor, every member 96-256 units away at a
// hashed angle, the ground height from geodata. On a slope a member's point
// can be more than 100 below the anchor (live 2026-10-03: Delu Lizardman
// fields, dz 176); it must stand on the anchor, not leave the party without
// destinations.
const anchor = { locX: 62943, locY: 168846, locZ: -3048 };
const spot = { id: '10_28', name: 'Delu Lizardman fields', center: { ...anchor }, arrivalPoints: [{ ...anchor }],
    minLevel: 28, maxLevel: 30, avgLevel: 29, density: 12 };
const party = { partyId: 'slope-party', leaderId: 2000105, memberIds: [2000105, 2001419, 2001762, 2000287], spotId: spot.id };
const members = party.memberIds.map((characterId) => ({ characterId, phase: 'cold', activity: 'grouped', spotId: spot.id,
    party: { partyId: party.partyId }, stats: {}, vitals: { hp: 900, maxHp: 900 } }));
const originalHeight = Geodata.getHeight;
const withHeight = (fn, run) => { Geodata.getHeight = fn; try { return run(); } finally { Geodata.getHeight = originalHeight; } };
const distance = (a, b) => Math.hypot(a.locX - b.locX, a.locY - b.locY);
const assembled = (destinations) => members.map((member) => ({ ...member, loc: destinations[member.characterId] }));

// The party's anchor is the leader's own hashed point near the spawn, not the spawn itself.
const flatAnchor = withHeight((x, y, z) => z, () => SpotService.arrivalPointForState(members[0], spot));
// Flat ground: the author's spread, every member within 400 units and on the anchor's height.
const flat = withHeight((x, y, z) => z, () => SpotService.arrivalPointsForParty(members, spot));
assert(flat && Object.keys(flat).length === 4, 'flat ground gives every member a point');
assert(members.some((member) => distance(flat[member.characterId], flatAnchor) > 0), 'members are spread around the anchor');
members.forEach((member) => assert(distance(flat[member.characterId], flatAnchor) <= 400 && flat[member.characterId].locZ === flatAnchor.locZ));
assert(Assembly.ready(party, assembled(flat), spot), 'the spread group is assembled');

// One member's point lies on a slope 176 below the anchor: that member stands on the anchor, the others keep their points.
const slopeMember = members[3];
const slopePoint = flat[slopeMember.characterId];
const oneSlope = withHeight((x, y, z) => (x === slopePoint.locX && y === slopePoint.locY ? z - 176 : z),
    () => SpotService.arrivalPointsForParty(members, spot));
assert(oneSlope, 'a slope under one member must not leave the party without destinations');
assert.deepStrictEqual(oneSlope[slopeMember.characterId], flatAnchor, 'the slope member stands on the anchor');
members.slice(0, 3).forEach((member) => assert.deepStrictEqual(oneSlope[member.characterId], flat[member.characterId], 'the other members keep their points'));
assert(Assembly.ready(party, assembled(oneSlope), spot), 'the group is assembled on one floor');

// Every offset lands on a slope: the whole party gathers on the anchor.
const steep = (x, y, z) => z + 300;
const steepAnchor = withHeight(steep, () => SpotService.arrivalPointForState(members[0], spot));
const allSlope = withHeight(steep, () => SpotService.arrivalPointsForParty(members, spot));
assert(allSlope, 'destinations exist even when every offset leaves the floor');
members.forEach((member) => assert.deepStrictEqual(allSlope[member.characterId], steepAnchor));
assert(Assembly.ready(party, assembled(allSlope), spot), 'a party stacked on the anchor is assembled');

// A raid profile (the floor guard's home case): its anchor is a spawn near the boss; a member whose
// offset lands on a slope joins the others on the anchor and the party counts as assembled.
const raidSpot = { ...spot, id: 'raid:10131', raidBoss: true, arrivalPoints: [{ ...anchor, locX: anchor.locX + 650 }] };
const raidParty = { ...party, spotId: raidSpot.id };
const raidAnchor = withHeight(steep, () => SpotService.arrivalPointForState(members[0], raidSpot));
const raid = withHeight(steep, () => SpotService.arrivalPointsForParty(members, raidSpot));
assert(raid, 'a raid party on a slope still gets destinations');
members.forEach((member) => assert.deepStrictEqual(raid[member.characterId], raidAnchor));
assert(Assembly.ready(raidParty, members.map((member) => ({ ...member, spotId: raidSpot.id, loc: raid[member.characterId] })), raidSpot),
    'a raid party stacked on its anchor may begin preparation');

// Without an anchor there is still nothing to travel to.
assert.strictEqual(SpotService.arrivalPointsForParty(members, { id: '10_28', name: 'no geometry' }), null);

console.log('party arrival points on slopes passed');
