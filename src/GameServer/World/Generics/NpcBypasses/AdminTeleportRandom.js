const DataCache = invoke('GameServer/DataCache');

module.exports = function(session, parts) {
    const count    = utils.size(DataCache.npcSpawns);
    const selected = DataCache.npcSpawns[utils.randomNumber(count)];

    const coords = selected.bounds.map((bound) => {
        return [bound.locX, bound.locY];
    });

    const pos = require('random-point-in-shape')(coords);
    invoke(path.actor).teleportTo(session, session.actor, {
        locX: pos[0], locY: pos[1], locZ: selected.bounds[0].maxZ, head: utils.randomNumber(65536),
    });
};
