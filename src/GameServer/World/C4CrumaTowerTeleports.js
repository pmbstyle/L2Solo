'use strict';

// Chronicle 4 Cruma Tower routes from the original gatekeeper and teleport
// rows. The route is also bound to the speaking NPC so a forged bypass cannot
// use a destination exposed by another floor's teleporter.
const DESTINATIONS = new Map([
    [21, { locX: 17724, locY: 114004, locZ: -11672 }],
    [22, { locX: 17192, locY: 114178, locZ: -3439 }],
    [23, { locX: 17730, locY: 108301, locZ: -9057 }],
    [24, { locX: 17714, locY: 107923, locZ: -11850 }],
    [55, { locX: 17719, locY: 115590, locZ: -6584 }],
    [57, { locX: 17719, locY: 115590, locZ: -6584 }]
]);

const NPC_NAMES = new Map([
    [7483, 'Gatekeeper Mozella'],
    [7484, 'Gatekeeper Ponti'],
    [7485, 'Gatekeeper Capella'],
    [7486, 'Gatekeeper Hanna'],
    [7487, 'Gatekeeper Penelope'],
    [12053, 'Teleport Cube']
]);

const ROUTES = new Map([
    [7483, [[21, 'Teleport into the tower']]],
    [7484, [[22, 'Return to the ground']]],
    [7485, [[24, 'Return to the 1st floor']]],
    [7486, [[55, 'Go to the 3rd floor']]],
    [7487, [[23, 'Teleport to the 2nd floor']]],
    [12053, [
        [57, 'Return to the 3rd floor'],
        [22, 'Go above ground']
    ]]
]);

function destination(npcId, teleportId) {
    const routes = ROUTES.get(Number(npcId));
    const id = Number(teleportId);
    if (!routes?.some(([routeId]) => routeId === id)) return null;

    const destination = DESTINATIONS.get(id);
    return destination ? { ...destination } : null;
}

function html(npcId) {
    const id = Number(npcId);
    const routes = ROUTES.get(id);
    if (!routes) return null;

    const name = NPC_NAMES.get(id) || 'Cruma Tower Teleporter';
    const links = routes.map(([teleportId, label]) =>
        `<a action="bypass -h cruma-tower-teleport ${teleportId}">${label}</a><br>`
    );
    return `<html><body>${name}:<br>${links.join('')}</body></html>`;
}

module.exports = { DESTINATIONS, NPC_NAMES, ROUTES, destination, html };
