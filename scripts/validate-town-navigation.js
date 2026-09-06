#!/usr/bin/env node
// Read-only geodata coverage check, including towns without measured polygons.
require('../src/Global');
const fs = require('fs');
const path = require('path');
const Geodata = invoke('GameServer/Geodata/GeodataEngine');
const Corridor = invoke('GameServer/Geodata/TownPathCorridor');
const Services = invoke('GameServer/Bot/Economy/TownServiceCatalog');
const Approach = invoke('GameServer/Bot/AI/TownNpcApproach');
const Towns = invoke('GameServer/World/TownRespawn').towns;

function run() {
    invoke('GameServer/DataCache').init();
    Geodata.init();
    const rows = Services.rows();
    const results = [];
    let invalidSegments = 0;
    for (const town of Object.values(Towns)) {
        const services = rows.filter((row) => row.town === town.name);
        const chosen = [...services].sort((a, b) => Corridor.distance(b, town) - Corridor.distance(a, town)).slice(0, 2);
        const routes = [];
        for (const npc of chosen) {
            const target = Approach.pointsFor(npc)?.interaction;
            if (!target) continue;
            const found = Geodata.findPath(town.locX, town.locY, town.locZ,
                target.locX, target.locY, target.locZ, 120000, { debug: false, goalRadius: 16, goalZTolerance: 64 });
            const corridor = Corridor.build(found);
            let invalid = 0;
            for (const route of corridor.lanes) for (let i = 1; i < route.length; i++) {
                if (!Corridor.visible(route[i - 1], route[i])) invalid++;
            }
            invalidSegments += invalid;
            routes.push({ npc: npc.name, npcSelfId: npc.npcSelfId, reachable: !!found?.length,
                points: found?.length || 0, variants: new Set(corridor.lanes.map((p) => JSON.stringify(p))).size, invalidSegments: invalid });
        }
        results.push({ town: town.name, services: services.length,
            gatekeepers: services.filter((npc) => npc.roles.includes(Services.ROLES.GATEKEEPER)).length, routes });
    }
    const output = path.resolve(__dirname, '../tmp/town-navigation-coverage.json');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify({ at: new Date().toISOString(), invalidSegments, results }, null, 2));
    console.log(JSON.stringify({ output, invalidSegments, results }, null, 2));
    if (invalidSegments) process.exitCode = 1;
}
if (require.main === module) run();
module.exports = { run };
