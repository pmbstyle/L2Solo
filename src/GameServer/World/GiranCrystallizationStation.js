// Permanent service at the requested Giran location. Reuse the C4 Mammon
// appearance so the station needs no custom client NPC assets.
const npcId = 90001;
const loc = { locX: 83279, locY: 148396, locZ: -3405 };
const template = structuredClone(require('./GiranMammon').npcs[0]);
template.selfId = npcId;
template.template = {
    ...template.template,
    displayId: 8126,
    name: 'Crystallization Station',
    title: 'Service Fee: 15%'
};
const spawns = [{
    selfId: 'giran_crystallization_station',
    bounds: [{ locX: loc.locX, locY: loc.locY, minZ: loc.locZ - 200, maxZ: loc.locZ + 200 }],
    spawns: [{ selfId: npcId, name: template.template.name, coords: [{ ...loc, head: 37264 }], total: 1, respawn: 60, bias: 0 }]
}];
module.exports = { npcId, loc, npcs: [template], spawns };
