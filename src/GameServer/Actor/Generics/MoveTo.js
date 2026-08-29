const ServerResponse = invoke('GameServer/Network/Response');
const GeodataEngine  = invoke('GameServer/Geodata/GeodataEngine');
const EffectRestrictions = invoke('GameServer/Effects/EffectRestrictions');
const PopulationMetrics = invoke('GameServer/Bot/Population/PopulationMetrics');
const PathfindingWorkerPool = invoke('GameServer/Geodata/PathfindingWorkerPool');

// World.fetchVisibleUsers broadcasts movement to observers inside this same
// radius.  Low-detail simulation must never silently relocate a bot that is
// already visible to a player (or whose requested destination is visible).
const CLIENT_VISIBILITY_RADIUS = 6000;
const COMPANION_DIRECT_DISTANCE = 256;
const COMPANION_PATH_TIMEOUT_MS = 2000;
const COMPANION_PATH_MAX_NODES = 4000;
const COMPANION_ERRAND_PATH_MAX_NODES = 120000;
const COMPANION_MAX_ARRIVAL_RADIUS = 512;
const ACTIVE_GOAL_XY_TOLERANCE = 32;
const ACTIVE_GOAL_Z_TOLERANCE = 64;
const INITIAL_WAYPOINT_SKIP_DISTANCE = 24;
const MOVE_PROGRESS_SAMPLE_MS = 750;
const MOVE_PROGRESS_DISTANCE = 8;
const MOVE_STALL_SAMPLES = 3;
const MOVEMENT_TRACE_LIMIT = 24;

function recordMovementTrace(session, entry) {
    if (!session) return;
    if (!Array.isArray(session.movementTrace)) session.movementTrace = [];
    session.movementTrace.push({ at: Date.now(), ...entry });
    if (session.movementTrace.length > MOVEMENT_TRACE_LIMIT) {
        session.movementTrace.splice(0, session.movementTrace.length - MOVEMENT_TRACE_LIMIT);
    }
}

function locOf(actor) {
    return {
        locX: Number(actor.fetchLocX()),
        locY: Number(actor.fetchLocY()),
        locZ: Number(actor.fetchLocZ())
    };
}

function sameLoc(first, second, tolerance = 1) {
    return Math.abs(Number(first?.locX) - Number(second?.locX)) <= tolerance &&
        Math.abs(Number(first?.locY) - Number(second?.locY)) <= tolerance &&
        Math.abs(Number(first?.locZ) - Number(second?.locZ)) <= tolerance;
}

function sameMoveGoal(first, second) {
    return Math.abs(Number(first?.locX) - Number(second?.locX)) <= ACTIVE_GOAL_XY_TOLERANCE &&
        Math.abs(Number(first?.locY) - Number(second?.locY)) <= ACTIVE_GOAL_XY_TOLERANCE &&
        Math.abs(Number(first?.locZ) - Number(second?.locZ)) <= ACTIVE_GOAL_Z_TOLERANCE;
}

function activeMoveGoal(session, actor, now = Date.now()) {
    if (!session?.activeMoveGoal) return null;
    if (session.pendingPathRequest) return session.activeMoveGoal;
    if (!session.moveTimer) return null;

    const goal = session.activeMoveGoal;
    if (now - Number(goal.lastProgressSampleAt || 0) < MOVE_PROGRESS_SAMPLE_MS) return goal;

    const current = locOf(actor);
    const previous = goal.lastProgressLoc || current;
    const progressed = distance2d(current, previous) >= MOVE_PROGRESS_DISTANCE;
    goal.lastProgressSampleAt = now;
    if (progressed) {
        goal.lastProgressLoc = current;
        goal.stalledSamples = 0;
        return goal;
    }

    goal.stalledSamples = Number(goal.stalledSamples || 0) + 1;
    return goal.stalledSamples >= MOVE_STALL_SAMPLES ? null : goal;
}

function beginMoveGoal(session, actor, requestedTo, targetActor = null) {
    const goal = {
        generation: Number(session.moveRouteGeneration || 0),
        requestedTo: { ...requestedTo },
        targetId: Number(targetActor?.fetchId?.()) || null,
        startedAt: Date.now(),
        lastProgressSampleAt: Date.now(),
        lastProgressLoc: locOf(actor),
        stalledSamples: 0
    };
    session.activeMoveGoal = goal;
    return goal;
}

function clearMoveGoal(session, goal) {
    if (session && goal && session.activeMoveGoal === goal) session.activeMoveGoal = null;
}

function shouldSkipInitialWaypoint(index, path, distance, dz) {
    return index === 0 &&
        path.length > 1 &&
        distance <= INITIAL_WAYPOINT_SKIP_DISTANCE &&
        Math.abs(dz) <= ACTIVE_GOAL_Z_TOLERANCE;
}

function startPathMovement({ session, actor, path, isClose, approachingObservers, moveGoal }) {
    const moveAlongPath = (index) => {
        if (index >= path.length) {
            session.moveTimer = null;
            actor.state.setTowards(false);
            clearMoveGoal(session, moveGoal);
            return;
        }

        const currentLoc = locOf(actor);
        const nextLoc = path[index];
        const dx = nextLoc.locX - currentLoc.locX;
        const dy = nextLoc.locY - currentLoc.locY;
        const dz = nextLoc.locZ - currentLoc.locZ;
        const distance = Math.sqrt(dx * dx + dy * dy);

        // A* begins at the centre of the actor's current 16-unit geodata cell.
        // Announcing that tiny correction before the real leg makes C4 briefly
        // turn or stop at the start of every route. Keep the authoritative
        // current coordinate and begin with the first meaningful waypoint.
        if (shouldSkipInitialWaypoint(index, path, distance, dz)) {
            moveAlongPath(index + 1);
            return;
        }

        if (distance === 0) {
            actor.setLocXYZ(nextLoc);
            invoke('GameServer/Bot/AI/PartyCompanionService').updatePosition(session, actor);
            moveAlongPath(index + 1);
            return;
        }

        const segmentCoords = { from: currentLoc, to: nextLoc };
        const movePacket = ServerResponse.moveToLocation(actor.fetchId(), segmentCoords);
        session.dataSendToMeAndOthers(movePacket, actor);
        approachingObservers.forEach((observer) => {
            const observerSession = observer.session;
            if (!observerSession?.actor?.fetchIsOnline?.() || !observerSession.dataSendToMe) return;
            if (distance2d(observerSession.actor, currentLoc) <= CLIENT_VISIBILITY_RADIUS) return;
            if (!observer.announced) {
                observerSession.dataSendToMe(ServerResponse.charInfo(actor));
                observer.announced = true;
            }
            observerSession.dataSendToMe(movePacket);
        });

        const speed = actor.fetchCollectiveRunSpd() || 120;
        const duration = Math.max(1, (distance / speed) * 1000);
        const tickRate = isClose ? 100 : 250;
        const segmentStartedAt = Date.now();
        recordMovementTrace(session, {
            event: 'move',
            index,
            pathLength: path.length,
            from: { ...currentLoc },
            to: { ...nextLoc },
            distance,
            speed,
            duration,
            baseRunSpeed: Number(actor.fetchRunSpd?.()) || 0,
            walking: actor.state?.fetchWalkin?.() === true
        });

        const advanceSegment = () => {
            if (!session.moveTimer) return;
            const elapsed = Math.max(0, Date.now() - segmentStartedAt);
            const ratio = Math.min(1, elapsed / duration);
            if (ratio >= 1) {
                actor.setLocXYZ(nextLoc);
                invoke('GameServer/Bot/AI/PartyCompanionService').updatePosition(session, actor);
                session.moveTimer = null;
                recordMovementTrace(session, {
                    event: 'arrive',
                    index,
                    pathLength: path.length,
                    to: { ...nextLoc },
                    elapsed,
                    duration
                });
                moveAlongPath(index + 1);
            } else {
                const nextX = Math.round(currentLoc.locX + dx * ratio);
                const nextY = Math.round(currentLoc.locY + dy * ratio);
                const nextZ = Math.round(currentLoc.locZ + dz * ratio);
                const snappedZ = GeodataEngine.getHeight(nextX, nextY, nextZ);
                actor.setLocXYZ({ locX: nextX, locY: nextY, locZ: snappedZ });
                invoke('GameServer/Bot/AI/PartyCompanionService').updatePosition(session, actor);
                const remaining = Math.max(1, duration - elapsed);
                session.moveTimer = setTimeout(advanceSegment, Math.min(tickRate, remaining));
            }
        };

        session.moveTimer = setTimeout(advanceSegment, Math.min(tickRate, duration));
    };

    actor.state.setTowards('move');
    moveAlongPath(0);
}

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

    const isBot = session && (session.constructor.name === 'BotSession' || (session.accountId && session.accountId.startsWith('bot_')));
    const requestedTo = { ...coords.to };
    const arrivalRadius = Math.min(COMPANION_MAX_ARRIVAL_RADIUS, Math.max(0, Number(coords.arrivalRadius || 0)));
    const pathMaxNodes = Math.min(
        COMPANION_ERRAND_PATH_MAX_NODES,
        Math.max(COMPANION_PATH_MAX_NODES, Number(coords.pathMaxNodes || COMPANION_PATH_MAX_NODES))
    );
    let townRouteDiagnostics = null;

    // Hot AI states may evaluate the same fixed destination every second. A
    // repeated command to the active goal must not abort movement, rerun A*,
    // or broadcast StopMove + MoveToLocation again. Recovery callers can
    // explicitly replace a healthy-looking route with forceRepath.
    if (!previewOnly && isBot && coords.forceRepath !== true) {
        const activeGoal = activeMoveGoal(session, actor);
        if (activeGoal && sameMoveGoal(activeGoal.requestedTo, requestedTo)) {
            return session.lastPathfinding;
        }
    }

    // A route preview must not alter the actor or emit a false movement packet.
    if (!previewOnly) {
        // Abort scheduled movement, user redirected the actor
        actor.automation.abortAll(actor);
    }

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
        const pathStartedAt = Date.now();
        const moveGoal = previewOnly ? null : beginMoveGoal(session, actor, requestedTo, coords.targetActor);

        if (isCompanion && !previewOnly) {
            const pool = session.pathfindingWorkerPool || PathfindingWorkerPool;
            const routeGeneration = Number(session.moveRouteGeneration || 0);
            const actorId = Number(actor.fetchId());
            const leaderSession = session.followPlayerSession;
            const targetActor = coords.targetActor || null;
            const targetId = Number(targetActor?.fetchId?.()) || null;
            const targetStart = targetActor ? locOf(targetActor) : null;
            const start = { locX: startX, locY: startY, locZ: startZ };
            const requestKey = `companion:${actorId}`;
            const clearPending = ({ clearGoal = false } = {}) => {
                const pending = session.pendingPathRequest;
                if (pending?.key === requestKey && pending.generation === routeGeneration) {
                    session.pendingPathRequest = null;
                    if (actor.state?.fetchTowards?.() === 'path') actor.state.setTowards(false);
                }
                if (clearGoal) clearMoveGoal(session, moveGoal);
            };
            const isCurrent = () => (
                Number(session.moveRouteGeneration || 0) === routeGeneration &&
                session.partyCompanion === true &&
                session.followPlayerSession === leaderSession &&
                session.actor === actor &&
                Number(actor.fetchId()) === actorId &&
                (!targetActor || (
                    Number(targetActor.fetchId?.()) === targetId &&
                    targetActor.fetchIsOnline?.() !== false &&
                    targetActor.isDead?.() !== true &&
                    sameLoc(locOf(targetActor), targetStart, 128)
                )) &&
                !actor.isDead() &&
                EffectRestrictions.canMove(actor) &&
                sameLoc(locOf(actor), start) &&
                sameLoc(coords.to, pathTarget)
            );
            const finish = (candidatePath, strategy, error = null) => {
                if (!isCurrent()) {
                    clearPending({ clearGoal: true });
                    return null;
                }
                clearPending();
                const routeFound = Array.isArray(candidatePath) && candidatePath.length > 1;
                const fallbackLineOfSight = !routeFound && GeodataEngine.hasLineOfSight(
                    startX, startY, startZ,
                    pathTarget.locX, pathTarget.locY, pathTarget.locZ
                );
                const movementPath = routeFound
                    ? candidatePath
                    : (fallbackLineOfSight ? [{ ...pathTarget }] : []);
                PopulationMetrics.recordPathfindingDuration('companion', Date.now() - pathStartedAt);
                session.lastPathfinding = {
                    requestedTo,
                    routedTo: { ...pathTarget },
                    townRoute: townRouteDiagnostics,
                    pathLength: movementPath.length,
                    routeUsable: routeFound || fallbackLineOfSight,
                    lowLodWarp: false,
                    distanceToPlayer,
                    destinationDistanceToPlayer,
                    strategy,
                    worker: true,
                    arrivalRadius,
                    maxNodes: pathMaxNodes,
                    ...(error ? { error: error.code || error.message || String(error) } : {}),
                    at: Date.now()
                };
                if (movementPath.length) {
                    startPathMovement({ session, actor, path: movementPath, isClose, approachingObservers, moveGoal });
                } else {
                    clearMoveGoal(session, moveGoal);
                }
                return session.lastPathfinding;
            };
            const requestPath = (target, strategy) => pool.request({
                startX, startY, startZ,
                endX: target.locX,
                endY: target.locY,
                endZ: target.locZ,
                maxNodes: pathMaxNodes,
                goalRadius: arrivalRadius,
                goalZTolerance: ACTIVE_GOAL_Z_TOLERANCE
            }, {
                key: requestKey,
                priority: 100,
                timeoutMs: COMPANION_PATH_TIMEOUT_MS
            }).then((candidatePath) => {
                if (!isCurrent()) {
                    clearPending({ clearGoal: true });
                    return null;
                }
                if (Array.isArray(candidatePath) && candidatePath.length > 1) {
                    session.townRoutePlan = null;
                    return finish(candidatePath, strategy);
                }

                const TownPathfinder = invoke('GameServer/Bot/AI/TownPathfinder');
                const routeResult = TownPathfinder.routeWithSession(session, actor, start, requestedTo);
                pathTarget = { ...routeResult.to };
                townRouteDiagnostics = routeResult.diagnostics;
                const waypointArrivalRadius = Number.isFinite(routeResult.arrivalRadius)
                    ? Math.max(0, Number(routeResult.arrivalRadius))
                    : arrivalRadius;
                coords.to.locX = pathTarget.locX;
                coords.to.locY = pathTarget.locY;
                coords.to.locZ = pathTarget.locZ;
                const fallbackStrategy = townRouteDiagnostics?.changedTarget
                    ? 'worker_town_waypoint_fallback'
                    : 'worker_direct_fallback';
                if (sameLoc(pathTarget, requestedTo)) return finish(candidatePath, fallbackStrategy);
                return pool.request({
                    startX, startY, startZ,
                    endX: pathTarget.locX,
                    endY: pathTarget.locY,
                    endZ: pathTarget.locZ,
                    maxNodes: pathMaxNodes,
                    goalRadius: waypointArrivalRadius,
                    goalZTolerance: ACTIVE_GOAL_Z_TOLERANCE
                }, {
                    key: requestKey,
                    priority: 100,
                    timeoutMs: COMPANION_PATH_TIMEOUT_MS
                }).then((fallbackPath) => finish(fallbackPath, fallbackStrategy));
            }).catch((error) => {
                if (error?.code === 'STALE_PATH' || !isCurrent()) {
                    clearPending({ clearGoal: true });
                    return null;
                }
                return finish(null, `${strategy}_error_fallback`, error);
            });

            session.pendingPathRequest = {
                key: requestKey,
                generation: routeGeneration,
                requestedTo: { ...requestedTo },
                cancel: () => pool.cancel(requestKey),
                promise: null
            };

            const directDistance = distance2d(start, requestedTo);
            if (directDistance <= COMPANION_DIRECT_DISTANCE && GeodataEngine.hasLineOfSight(
                startX, startY, startZ,
                requestedTo.locX, requestedTo.locY, requestedTo.locZ
            )) {
                session.pendingPathRequest = null;
                return finish([{ ...start }, { ...requestedTo }], 'short_direct');
            }

            session.pendingPathRequest.promise = requestPath(requestedTo, 'worker_geodata');
            actor.state.setTowards('path');
            session.lastPathfinding = {
                requestedTo,
                routedTo: { ...requestedTo },
                townRoute: null,
                pathLength: 0,
                routeUsable: null,
                lowLodWarp: false,
                distanceToPlayer,
                destinationDistanceToPlayer,
                strategy: 'worker_pending',
                worker: true,
                arrivalRadius,
                maxNodes: pathMaxNodes,
                at: Date.now()
            };
            return session.lastPathfinding;
        }

        let path = GeodataEngine.findPath(
            startX, startY, startZ,
            requestedTo.locX, requestedTo.locY, requestedTo.locZ,
            undefined,
            { debug: false }
        );
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

            path = GeodataEngine.findPath(
                startX, startY, startZ,
                pathTarget.locX, pathTarget.locY, pathTarget.locZ,
                undefined,
                { debug: false }
            );
        } else if (session && !previewOnly) {
            session.townRoutePlan = null;
        }

        const routeFound = Array.isArray(path) && path.length > 1;
        PopulationMetrics.recordPathfindingDuration(isCompanion ? 'companion' : 'actor', Date.now() - pathStartedAt);
        // A* is deliberately bounded and can return null in otherwise open
        // terrain. The runtime has always handled that case with a direct
        // movement fallback, so distinguish a clear line from a genuinely
        // blocked destination before callers decide to reject the route.
        const fallbackLineOfSight = !routeFound && GeodataEngine.hasLineOfSight(
            startX, startY, startZ,
            pathTarget.locX, pathTarget.locY, pathTarget.locZ
        );
        if (!routeFound) {
            // Never announce a straight segment through blocked geodata. In a
            // multilevel town cell that can also snap the authoritative Z to
            // a roof while the C4 client remains on the street, stretching
            // its animation until the next packet visibly corrects it.
            path = fallbackLineOfSight
                ? [{ locX: pathTarget.locX, locY: pathTarget.locY, locZ: pathTarget.locZ }]
                : [];
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
        if (path.length > 0) {
            startPathMovement({ session, actor, path, isClose, approachingObservers, moveGoal });
        } else {
            clearMoveGoal(session, moveGoal);
        }
        return session.lastPathfinding;
    }
}

module.exports = moveTo;
module.exports.recordMovementTrace = recordMovementTrace;
module.exports.shouldUseLowLodWarp = shouldUseLowLodWarp;
module.exports.shouldPreannounceVisibleMove = shouldPreannounceVisibleMove;
module.exports.CLIENT_VISIBILITY_RADIUS = CLIENT_VISIBILITY_RADIUS;
module.exports.COMPANION_DIRECT_DISTANCE = COMPANION_DIRECT_DISTANCE;
module.exports.COMPANION_PATH_MAX_NODES = COMPANION_PATH_MAX_NODES;
module.exports.COMPANION_ERRAND_PATH_MAX_NODES = COMPANION_ERRAND_PATH_MAX_NODES;
module.exports.ACTIVE_GOAL_XY_TOLERANCE = ACTIVE_GOAL_XY_TOLERANCE;
module.exports.INITIAL_WAYPOINT_SKIP_DISTANCE = INITIAL_WAYPOINT_SKIP_DISTANCE;
module.exports.MOVE_STALL_SAMPLES = MOVE_STALL_SAMPLES;
