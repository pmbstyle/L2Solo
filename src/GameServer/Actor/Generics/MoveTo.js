const ServerResponse = invoke('GameServer/Network/Response');
const GeodataEngine  = invoke('GameServer/Geodata/GeodataEngine');
const EffectRestrictions = invoke('GameServer/Effects/EffectRestrictions');

// World.fetchVisibleUsers broadcasts movement to observers inside this same
// radius.  Low-detail simulation must never silently relocate a bot that is
// already visible to a player (or whose requested destination is visible).
const CLIENT_VISIBILITY_RADIUS = 6000;

function distanceToClosestPlayer(players, coords) {
    if (!players.length) return Infinity;

    return players.reduce((closest, player) => {
        const dx = player.fetchLocX() - coords.locX;
        const dy = player.fetchLocY() - coords.locY;
        return Math.min(closest, Math.sqrt(dx * dx + dy * dy));
    }, Infinity);
}

function distance2d(first, second) {
    const dx = Number(first?.fetchLocX?.() ?? first?.locX ?? 0) - Number(second?.fetchLocX?.() ?? second?.locX ?? 0);
    const dy = Number(first?.fetchLocY?.() ?? first?.locY ?? 0) - Number(second?.fetchLocY?.() ?? second?.locY ?? 0);
    return Math.sqrt((dx * dx) + (dy * dy));
}

function shouldUseLowLodWarp({ startDistance, destinationDistance, isCompanion, plan }) {
    return !isCompanion &&
        plan !== 'pk_hunting' &&
        startDistance > CLIENT_VISIBILITY_RADIUS &&
        destinationDistance > CLIENT_VISIBILITY_RADIUS;
}

function shouldPreannounceVisibleMove(startDistance, destinationDistance) {
    return startDistance > CLIENT_VISIBILITY_RADIUS && destinationDistance <= CLIENT_VISIBILITY_RADIUS;
}

function previewRouteSession(session) {
    if (!session) return session;
    const plan = session.townRoutePlan;
    return {
        ...session,
        townRoutePlan: plan ? {
            ...plan,
            finalTarget: plan.finalTarget ? { ...plan.finalTarget } : plan.finalTarget,
            waypoint: plan.waypoint ? { ...plan.waypoint } : plan.waypoint
        } : plan
    };
}

function moveTo(session, actor, coords) {
    const previewOnly = coords.previewOnly === true;
    if (!previewOnly && actor.isDead()) {
        return;
    }

    if (!previewOnly && !EffectRestrictions.canMove(actor)) {
        EffectRestrictions.reject(session);
        return;
    }

    if (!previewOnly && actor.isBlocked()) {
        invoke(path.actor).queueRequest(session, actor, 'move', coords);
        return;
    }

    // A route preview must not alter the actor or emit a false movement packet.
    if (!previewOnly) {
        // Abort scheduled movement, user redirected the actor
        actor.automation.abortAll(actor);
    }

    const isBot = session && (session.constructor.name === 'BotSession' || (session.accountId && session.accountId.startsWith('bot_')));
    const requestedTo = { ...coords.to };
    let townRouteDiagnostics = null;

    if (!isBot) {
        // Normal player movement
        session.dataSendToMeAndOthers(ServerResponse.moveToLocation(actor.fetchId(), coords), actor);
    } else {
        // Bot movement
        const startX = coords.from.locX;
        const startY = coords.from.locY;
        const startZ = coords.from.locZ;

        // Keep low-detail simulation outside the client-visible area.  The
        // old 1500-unit threshold was much smaller than the 6000-unit world
        // visibility radius, so a bot could be visibly running and then have
        // its server position silently overwritten.
        const World = invoke('GameServer/World/World');
        const onlinePlayerSessions = World.user.sessions
            .filter(s =>
                s.actor &&
                s.actor.fetchIsOnline() &&
                s.accountId &&
                !s.accountId.startsWith('bot_')
            );
        const onlinePlayers = onlinePlayerSessions.map((playerSession) => playerSession.actor);
        const distanceToPlayer = distanceToClosestPlayer(onlinePlayers, {
            locX: startX,
            locY: startY
        });
        const destinationDistanceToPlayer = distanceToClosestPlayer(onlinePlayers, requestedTo);
        // Movement packets are normally broadcast from the bot's current
        // coordinates. A player who is just outside that radius would miss
        // the first packet and only discover the bot through a later refresh,
        // which looks like a teleport. Prime that observer before the route
        // crosses into their visible area.
        const approachingObservers = onlinePlayerSessions
            .filter((playerSession) => shouldPreannounceVisibleMove(
                distance2d(playerSession.actor, { locX: startX, locY: startY }),
                distance2d(playerSession.actor, requestedTo)
            ))
            .map((playerSession) => ({ session: playerSession, announced: false }));

        const isCompanion = !!session.followPlayerSession && session.partyCompanion === true;

        if (shouldUseLowLodWarp({
            startDistance: distanceToPlayer,
            destinationDistance: destinationDistanceToPlayer,
            isCompanion,
            plan: session.plan
        })) {
            // Low LOD: instant warp (we do not calculate movements at all)
            const snappedTo = { ...requestedTo };
            snappedTo.locZ = GeodataEngine.getHeight(snappedTo.locX, snappedTo.locY, snappedTo.locZ);
            session.lastPathfinding = {
                requestedTo,
                routedTo: { ...snappedTo },
                ...(previewOnly ? { route: [{ ...snappedTo }] } : {}),
                townRoute: null,
                pathLength: 0,
                routeUsable: true,
                lowLodWarp: true,
                distanceToPlayer,
                destinationDistanceToPlayer,
                strategy: 'low_lod_direct',
                at: Date.now()
            };
            if (previewOnly) return session.lastPathfinding;
            actor.setLocXYZ(snappedTo);
            invoke('GameServer/Bot/AI/PartyCompanionService').updatePosition(session, actor);
            return session.lastPathfinding;
        }

        const isClose = isCompanion || distanceToPlayer <= 500;

        let pathTarget = { ...requestedTo };
        let path = GeodataEngine.findPath(startX, startY, startZ, requestedTo.locX, requestedTo.locY, requestedTo.locZ);
        let pathStrategy = 'direct_geodata';

        if (!path || path.length <= 1) {
            const TownPathfinder = invoke('GameServer/Bot/AI/TownPathfinder');
            const routeSession = previewOnly ? previewRouteSession(session) : session;
            const routeResult = TownPathfinder.routeWithSession(routeSession, actor, coords.from, requestedTo);
            pathTarget = { ...routeResult.to };
            townRouteDiagnostics = routeResult.diagnostics;
            if (!previewOnly) {
                coords.to.locX = pathTarget.locX;
                coords.to.locY = pathTarget.locY;
                coords.to.locZ = pathTarget.locZ;
            }
            pathStrategy = townRouteDiagnostics?.changedTarget ? 'town_waypoint_fallback' : 'direct_fallback';

            path = GeodataEngine.findPath(startX, startY, startZ, pathTarget.locX, pathTarget.locY, pathTarget.locZ);
        } else if (session && !previewOnly) {
            session.townRoutePlan = null;
        }

        const routeFound = Array.isArray(path) && path.length > 1;
        // A* is deliberately bounded and can return null in otherwise open
        // terrain. The runtime has always handled that case with a direct
        // movement fallback, so distinguish a clear line from a genuinely
        // blocked destination before callers decide to reject the route.
        const fallbackLineOfSight = !routeFound && GeodataEngine.hasLineOfSight(
            startX, startY, startZ,
            pathTarget.locX, pathTarget.locY, pathTarget.locZ
        );
        if (!previewOnly) {
            console.log(`[PATHFIND] Bot ${actor.fetchName()}: from (${startX}, ${startY}, ${startZ}) to (${pathTarget.locX}, ${pathTarget.locY}, ${pathTarget.locZ}) strategy=${pathStrategy} -> Waypoints: ${path ? path.length : 0}`);
        }
        if (!path || path.length <= 1) {
            path = [{ locX: pathTarget.locX, locY: pathTarget.locY, locZ: pathTarget.locZ }];
        }
        session.lastPathfinding = {
            requestedTo,
            routedTo: { ...pathTarget },
            ...(previewOnly ? { route: path.map((waypoint) => ({ ...waypoint })) } : {}),
            townRoute: townRouteDiagnostics,
            pathLength: path.length,
            routeUsable: routeFound || fallbackLineOfSight,
            lowLodWarp: false,
            distanceToPlayer,
            destinationDistanceToPlayer,
            strategy: pathStrategy,
            at: Date.now()
        };
        if (previewOnly) {
            return session.lastPathfinding;
        }

        const moveAlongPath = (index) => {
            if (index >= path.length) {
                session.moveTimer = null;
                actor.state.setTowards(false);
                return;
            }

            const currentLoc = { locX: actor.fetchLocX(), locY: actor.fetchLocY(), locZ: actor.fetchLocZ() };
            const nextLoc = path[index];

            const dx = nextLoc.locX - currentLoc.locX;
            const dy = nextLoc.locY - currentLoc.locY;
            const dz = nextLoc.locZ - currentLoc.locZ;
            const distance = Math.sqrt(dx * dx + dy * dy);

            if (distance === 0) {
                actor.setLocXYZ(nextLoc);
                invoke('GameServer/Bot/AI/PartyCompanionService').updatePosition(session, actor);
                moveAlongPath(index + 1);
                return;
            }

            const segmentCoords = {
                from: currentLoc,
                to: nextLoc
            };
            const movePacket = ServerResponse.moveToLocation(actor.fetchId(), segmentCoords);
            session.dataSendToMeAndOthers(movePacket, actor);
            approachingObservers.forEach((observer) => {
                const observerSession = observer.session;
                if (!observerSession?.actor?.fetchIsOnline?.() || !observerSession.dataSendToMe) return;
                // Once the bot is in the standard broadcast radius, the
                // normal dataSendToMeAndOthers call above owns delivery.
                if (distance2d(observerSession.actor, currentLoc) <= CLIENT_VISIBILITY_RADIUS) return;
                if (!observer.announced) {
                    observerSession.dataSendToMe(ServerResponse.charInfo(actor));
                    observer.announced = true;
                }
                observerSession.dataSendToMe(movePacket);
            });

            const speed = actor.fetchCollectiveRunSpd() || 120;
            const duration = (distance / speed) * 1000;
            const tickRate = isClose ? 100 : 250;
            const steps = Math.ceil(duration / tickRate);
            let step = 0;

            session.moveTimer = setInterval(() => {
                if (!session.moveTimer) {
                    return;
                }

                step++;
                if (step >= steps) {
                    clearInterval(session.moveTimer);
                    actor.setLocXYZ(nextLoc);
                    invoke('GameServer/Bot/AI/PartyCompanionService').updatePosition(session, actor);
                    moveAlongPath(index + 1);
                } else {
                    const ratio = step / steps;
                    const nextX = Math.round(currentLoc.locX + dx * ratio);
                    const nextY = Math.round(currentLoc.locY + dy * ratio);
                    const nextZ = Math.round(currentLoc.locZ + dz * ratio);
                    const snappedZ = GeodataEngine.getHeight(nextX, nextY, nextZ);
                    actor.setLocXYZ({
                        locX: nextX,
                        locY: nextY,
                        locZ: snappedZ
                    });
                    invoke('GameServer/Bot/AI/PartyCompanionService').updatePosition(session, actor);
                }
            }, tickRate);
        };

        actor.state.setTowards('move');
        moveAlongPath(0);
        return session.lastPathfinding;
    }
}

module.exports = moveTo;
module.exports.shouldUseLowLodWarp = shouldUseLowLodWarp;
module.exports.shouldPreannounceVisibleMove = shouldPreannounceVisibleMove;
module.exports.CLIENT_VISIBILITY_RADIUS = CLIENT_VISIBILITY_RADIUS;
