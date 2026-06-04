const ServerResponse = invoke('GameServer/Network/Response');
const GeodataEngine  = invoke('GameServer/Geodata/GeodataEngine');

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

    const isBot = session && (session.constructor.name === 'BotSession' || (session.accountId && session.accountId.startsWith('bot_')));

    if (!isBot) {
        // Normal player movement
        session.dataSendToMeAndOthers(ServerResponse.moveToLocation(actor.fetchId(), coords), actor);
    } else {
        // Bot movement
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

        // Helper to fetch distance to closest real player
        const getDistanceToClosestPlayer = () => {
            const World = invoke('GameServer/World/World');
            const onlinePlayers = World.user.sessions.filter(s => 
                s.actor && 
                s.actor.fetchIsOnline() && 
                s.accountId && 
                !s.accountId.startsWith('bot_')
            );

            if (onlinePlayers.length === 0) return Infinity;

            let minDist = Infinity;
            onlinePlayers.forEach(pSession => {
                const player = pSession.actor;
                const pdx = player.fetchLocX() - startX;
                const pdy = player.fetchLocY() - startY;
                const pdist = Math.sqrt(pdx * pdx + pdy * pdy);
                if (pdist < minDist) {
                    minDist = pdist;
                }
            });
            return minDist;
        };

        const distanceToPlayer = getDistanceToClosestPlayer();
        const isCompanion = !!session.followPlayerSession;

        if (distanceToPlayer > 1500 && !isCompanion) {
            // Low LOD: instant warp (we do not calculate movements at all)
            const snappedTo = { ...coords.to };
            snappedTo.locZ = GeodataEngine.getHeight(snappedTo.locX, snappedTo.locY, snappedTo.locZ);
            actor.setLocXYZ(snappedTo);
            return;
        }

        // Send moveToLocation ONCE to the client at the start so client animates smoothly to target destination
        session.dataSendToMeAndOthers(ServerResponse.moveToLocation(actor.fetchId(), coords), actor);

        const isClose = isCompanion || distanceToPlayer <= 500;

        if (distance > 0) {
            const speed = actor.fetchCollectiveRunSpd() || 120;
            const duration = (distance / speed) * 1000;
            const tickRate = isClose ? 100 : 250; // High LOD updates server coordinates more frequently (100ms)
            const steps = Math.ceil(duration / tickRate);
            let step = 0;

            session.moveTimer = setInterval(() => {
                step++;
                if (step >= steps) {
                    const snappedTo = { ...coords.to };
                    snappedTo.locZ = GeodataEngine.getHeight(snappedTo.locX, snappedTo.locY, snappedTo.locZ);
                    actor.setLocXYZ(snappedTo);
                    clearInterval(session.moveTimer);
                    session.moveTimer = null;
                } else {
                    const ratio = step / steps;
                    const nextX = Math.round(startX + dx * ratio);
                    const nextY = Math.round(startY + dy * ratio);
                    const nextZ = Math.round(startZ + dz * ratio);
                    const snappedZ = GeodataEngine.getHeight(nextX, nextY, nextZ);
                    actor.setLocXYZ({
                        locX: nextX,
                        locY: nextY,
                        locZ: snappedZ
                    });
                }
            }, tickRate);
        } else {
            const snappedTo = { ...coords.to };
            snappedTo.locZ = GeodataEngine.getHeight(snappedTo.locX, snappedTo.locY, snappedTo.locZ);
            actor.setLocXYZ(snappedTo);
        }
    }
}

module.exports = moveTo;
