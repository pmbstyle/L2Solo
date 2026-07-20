const assert = require('assert');

require('../src/Global');

const GatekeeperTeleports = invoke('GameServer/World/C4GatekeeperTeleports');
const LateTownGatekeepers = invoke('GameServer/World/C4LateTownGatekeepers');

const cityGatekeepers = [7006, 7059, 7080, 7134, 7146, 7162, 7177, 7233, 7256, 7320, 7540, 7576, 7848, 8275, 8320];
for (const npcId of cityGatekeepers) {
    assert.ok(GatekeeperTeleports.html(npcId), `gatekeeper ${npcId} must have a C4 destination list`);
    assert.ok(GatekeeperTeleports.lists[npcId].length >= 4, `gatekeeper ${npcId} must not be reduced to a one-link list`);
    for (const [id] of GatekeeperTeleports.lists[npcId]) {
        assert.ok(GatekeeperTeleports.destination(npcId, id), `gatekeeper ${npcId} destination ${id} must resolve`);
    }
}

assert.strictEqual(GatekeeperTeleports.destination(7006, 18), null, 'a gatekeeper must not expose another city’s route by raw id');
assert.deepStrictEqual(GatekeeperTeleports.destination(7059, 19), { locX: 83400, locY: 147943, locZ: -3404, price: 8100 });
assert.match(GatekeeperTeleports.html(7080), /Dragon Valley - 6400 Adena/);
assert.match(GatekeeperTeleports.html(7848), /Forsaken Plains - 840 Adena/);
assert.match(GatekeeperTeleports.html(7233), /Enchanted Valley/);
assert.match(GatekeeperTeleports.html(8275), /Forge of the Gods/);
assert.match(GatekeeperTeleports.html(8320), /Forest of the Dead/);
for (const npcId of [8275, 8320]) {
    assert.ok(LateTownGatekeepers.npcs.some((npc) => npc.selfId === npcId), `NPC template ${npcId} must be present`);
    assert.ok(LateTownGatekeepers.spawns.some((group) => group.spawns.some((spawn) => spawn.selfId === npcId)), `NPC ${npcId} must spawn`);
}
console.log('gatekeeper teleport checks passed');
