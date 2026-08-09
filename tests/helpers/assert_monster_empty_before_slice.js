const assert = require('assert');
const fs = require('fs');
const path = require('path');

require('../../src/Global');

const DataCache = invoke('GameServer/DataCache');
const root = path.resolve(__dirname, '..', '..');

module.exports = function assertMonsterEmptyBeforeSlice({ slug, displayName, box, ignoreSlugs = [], padding = 300, zPadding = 256 }) {
    const locationBox = {
        minX: box.minX - padding, maxX: box.maxX + padding,
        minY: box.minY - padding, maxY: box.maxY + padding,
        minZ: box.minZ - zPadding, maxZ: box.maxZ + zPadding
    };
    const intersects = (minX, maxX, minY, maxY, minZ, maxZ) =>
        maxX >= locationBox.minX && minX <= locationBox.maxX
        && maxY >= locationBox.minY && minY <= locationBox.maxY
        && maxZ >= locationBox.minZ && minZ <= locationBox.maxZ;
    const monsterIds = new Set(DataCache.npcs
        .filter((npc) => npc.template.kind === 'Monster')
        .map((npc) => Number(npc.selfId)));
    const spawnDirectory = path.join(root, 'data', 'Npcs', 'Spawns');
    const preexistingPresence = fs.readdirSync(spawnDirectory)
        .filter((filename) => filename.endsWith('.json')
            && filename !== `${slug}.json`
            && !ignoreSlugs.includes(path.basename(filename, '.json')))
        .flatMap((filename) => require(path.join(spawnDirectory, filename)))
        .filter((area) => Array.isArray(area?.spawns)
            && area.spawns.some((spawn) => monsterIds.has(Number(spawn.selfId))))
        .filter((area) => {
            const monsterSpawns = area.spawns.filter((spawn) => monsterIds.has(Number(spawn.selfId)));
            if (monsterSpawns.some((spawn) => (spawn.coords || []).some((coord) => intersects(
                coord.locX, coord.locX, coord.locY, coord.locY, coord.locZ, coord.locZ
            )))) return true;
            if (!area.bounds?.length) return false;
            const xs = area.bounds.map((bound) => Number(bound.locX));
            const ys = area.bounds.map((bound) => Number(bound.locY));
            const minZs = area.bounds.map((bound) => Number(bound.minZ));
            const maxZs = area.bounds.map((bound) => Number(bound.maxZ));
            return intersects(Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys),
                Math.min(...minZs), Math.max(...maxZs));
        });
    assert.deepStrictEqual(preexistingPresence, [],
        `${displayName} must remain an additive slice for a previously monster-empty location`);
};
