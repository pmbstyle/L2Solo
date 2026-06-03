const ServerResponse = invoke('GameServer/Network/Response');

function moveTo(session, actor, coords) {
    if (actor.isDead()) {
        return;
    }

    if (actor.isBlocked()) {
        invoke(path.actor).queueRequest(session, actor, 'move', coords);
        return;
    }

    // Abort scheduled movement, user redirected the actor
    actor.automation.abortAll(actor);

    // Dynamic city exit/entrance routing middleware for bots
    if (session && (session.constructor.name === 'BotSession' || (session.accountId && session.accountId.startsWith('bot_')))) {
        const TownPathfinder = invoke('GameServer/Bot/AI/TownPathfinder');
        const routedTo = TownPathfinder.route(actor, coords.from, coords.to);
        
        coords.to.locX = routedTo.locX;
        coords.to.locY = routedTo.locY;
        coords.to.locZ = routedTo.locZ;
    }

    session.dataSendToMeAndOthers(ServerResponse.moveToLocation(actor.fetchId(), coords), actor);

    if (session && (session.constructor.name === 'BotSession' || (session.accountId && session.accountId.startsWith('bot_')))) {
        const startX = coords.from.locX;
        const startY = coords.from.locY;
        const startZ = coords.from.locZ;
        const endX = coords.to.locX;
        const endY = coords.to.locY;
        const endZ = coords.to.locZ;

        const dx = endX - startX;
        const dy = endY - startY;
        const dz = endZ - startZ;
        const distance = Math.sqrt(dx * dx + dy * dy);

        if (distance > 0) {
            const speed = actor.fetchCollectiveRunSpd() || 120;
            const duration = (distance / speed) * 1000;
            const steps = Math.ceil(duration / 250);
            let step = 0;

            session.moveTimer = setInterval(() => {
                step++;
                if (step >= steps) {
                    actor.setLocXYZ(coords.to);
                    clearInterval(session.moveTimer);
                    session.moveTimer = null;
                } else {
                    const ratio = step / steps;
                    actor.setLocXYZ({
                        locX: Math.round(startX + dx * ratio),
                        locY: Math.round(startY + dy * ratio),
                        locZ: Math.round(startZ + dz * ratio)
                    });
                }
            }, 250);
        } else {
            actor.setLocXYZ(coords.to);
        }
    }
}

module.exports = moveTo;
