const DataCache = invoke('GameServer/DataCache');

module.exports = function(session, parts) {
    const coords = DataCache.teleports.find((ob) => ob.id === Number(parts[1]))?.spawns;
    coords ? invoke(path.actor).teleportTo(session, session.actor, coords[0]) : null;
};
