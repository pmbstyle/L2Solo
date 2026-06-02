module.exports = function(session, parts) {
    const coords = {
        locX: Number(parts[1]),
        locY: Number(parts[2]),
        locZ: Number(parts[3]),
        head: session.actor.fetchHead()
    };

    invoke(path.actor).teleportTo(session, session.actor, coords);
};
