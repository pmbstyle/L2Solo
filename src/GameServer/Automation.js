const ServerResponse = invoke('GameServer/Network/Response');
const SelectedModel  = invoke('GameServer/Model/Selected');
const Timer          = invoke('GameServer/Timer');
const SpeckMath      = invoke('GameServer/SpeckMath');
const EffectStats    = invoke('GameServer/Effects/EffectStats');
const AttackRange    = invoke('GameServer/Actor/AttackRange');

class Automation extends SelectedModel {
    constructor() {
        // Parent inheritance
        super();

        this.timer = { // TODO: Move this into actual GameServer timer
            replenish : undefined,
            action    : Timer.init(),
            pickup    : Timer.init(),
        };

        this.ticksPerSecond = 10;
    }

    destructor(creature) {
        this.stopReplenish();
        this.abortAll(creature);
    }

    // Set

    setRevHp(data) {
        this.revHp = data;
    }

    setRevMp(data) {
        this.revMp = data;
    }

    // Get

    fetchRevHp() {
        return this.revHp;
    }

    fetchRevMp() {
        return this.revMp;
    }

    // Abstract

    replenishVitals(creature) {
        if (this.timer.replenish) {
            return;
        }

        this.stopReplenish();
        this.timer.replenish = setInterval(() => {
            this.replenishVitalsTick(creature);
        }, 3000);
    }

    replenishVitalsTick(creature) {
        const maxHp = creature.fetchMaxHp();
        const maxMp = creature.fetchMaxMp();
        const hasCp = typeof creature.fetchCp === 'function'
            && typeof creature.fetchMaxCp === 'function'
            && typeof creature.setCp === 'function';
        const maxCp = hasCp ? creature.fetchMaxCp() : 0;
        const minHp = Math.min(creature.fetchHp() + this.fetchRevHpAmount(creature), maxHp);
        const minMp = Math.min(creature.fetchMp() + this.fetchRevMpAmount(creature), maxMp);
        const minCp = hasCp
            ? Math.min(creature.fetchCp() + this.fetchRevCpAmount(creature), maxCp)
            : 0;

        creature.setHp(minHp);
        creature.setMp(minMp);
        if (hasCp) creature.setCp(minCp);

        if (creature.fetchKind === undefined) {
            creature.statusUpdateVitals(creature);
        }
        else {
            creature.broadcastVitals();
        }

        if (minHp >= maxHp && minMp >= maxMp && (!hasCp || minCp >= maxCp)) {
            this.stopReplenish();
        }

        return { hp: minHp, mp: minMp, ...(hasCp ? { cp: minCp } : {}) };
    }

    fetchRevHpAmount(creature) {
        const base = this.fetchPlayerRegenBase(creature, 'CON');
        return Math.max(0, (
            (base * EffectStats.multiplier(creature, 'regHp'))
            + EffectStats.add(creature, 'regHpAdd')
        ) * this.fetchRegenStateMultiplier(creature));
    }

    fetchRevMpAmount(creature) {
        const base = this.fetchPlayerRegenBase(creature, 'MEN');
        return Math.max(0, (
            (base * EffectStats.multiplier(creature, 'regMp'))
            + EffectStats.add(creature, 'regMpAdd')
        ) * this.fetchRegenStateMultiplier(creature));
    }

    fetchRevCpAmount(creature) {
        // C4 derives CP regeneration from the same level-adjusted base HP
        // regeneration value as HP, then applies CON, movement, and regCp
        // modifiers. CP has no separate base regeneration table.
        const base = this.fetchPlayerRegenBase(creature, 'CON');
        return Math.max(0, (
            base * EffectStats.multiplier(creature, 'regCp')
        ) * this.fetchRegenStateMultiplier(creature));
    }

    fetchPlayerRegenBase(creature, stat) {
        const base = Number(stat === 'CON' ? this.fetchRevHp() : this.fetchRevMp()) || 0;

        // L2J C4 applies the level and CON/MEN modifiers to the template's
        // level-adjusted regeneration value. NPCs keep their explicit
        // template regeneration values.
        if (typeof creature?.fetchClassId !== 'function') return base;

        const rawStat = stat === 'CON'
            ? Number(creature.fetchCon?.()) || 0
            : Number(creature.fetchMen?.()) || 0;
        const adjustedStat = Math.max(1, Math.round(
            (rawStat + EffectStats.add(creature, stat))
            * EffectStats.multiplier(creature, `${stat}Mul`)
        ));
        const level = Number(creature.fetchLevel?.()) || 1;
        const statModifier = invoke('GameServer/Formulas').calcBaseMod[stat](adjustedStat);
        return base * invoke('GameServer/Formulas').calcLevelMod(level) * statModifier;
    }

    fetchRegenStateMultiplier(creature) {
        if (typeof creature?.fetchClassId !== 'function') return 1;

        const state = creature.state;
        return state?.fetchSeated?.() === true
            ? 1.5
            : state?.inMotion?.() === true
                ? 0.7
                : 1.1;
    }

    stopReplenish() {
        clearInterval(this.timer.replenish);
        this.timer.replenish = undefined;
    }

    ticksToMove(srcX, srcY, srcZ, dstX, dstY, dstZ, radius, speed) {
        const stopRadius = Math.max(0, Number(radius) || 0);
        const moveDistance = Math.max(0, new SpeckMath.Point3D(srcX, srcY, srcZ).distance(new SpeckMath.Point3D(dstX, dstY, dstZ)) - stopRadius);
        const duration = 1 + ((this.ticksPerSecond * moveDistance) / speed);
        return (1000 / this.ticksPerSecond) * duration;
    }

    actionStopCoords(src, dst, radius) {
        const srcCoords = {
            locX: src.fetchLocX(),
            locY: src.fetchLocY(),
            locZ: src.fetchLocZ(),
        };
        const dstCoords = {
            locX: dst.fetchLocX(),
            locY: dst.fetchLocY(),
            locZ: dst.fetchLocZ(),
        };
        const stopRadius = Math.max(0, Number(radius) || 0);

        if (stopRadius <= 0) {
            return dstCoords;
        }

        const dx = dstCoords.locX - srcCoords.locX;
        const dy = dstCoords.locY - srcCoords.locY;
        const dz = dstCoords.locZ - srcCoords.locZ;
        const distance = Math.sqrt((dx ** 2) + (dy ** 2) + (dz ** 2));

        if (distance <= stopRadius || distance === 0) {
            return srcCoords;
        }

        const ratio = (distance - stopRadius) / distance;
        return {
            locX: Math.round(srcCoords.locX + dx * ratio),
            locY: Math.round(srcCoords.locY + dy * ratio),
            locZ: Math.round(srcCoords.locZ + dz * ratio),
        };
    }

    updateMovePosition() {
        const move = this.moveInterpolation;
        if (!move) return;
        const ratio = Math.min(1, Math.max(0, (Date.now() - move.startedAt) / move.duration));
        move.actor.setLocXYZ({
            locX: Math.round(move.from.locX + (move.to.locX - move.from.locX) * ratio),
            locY: Math.round(move.from.locY + (move.to.locY - move.from.locY) * ratio),
            locZ: Math.round(move.from.locZ + (move.to.locZ - move.from.locZ) * ratio)
        });
    }

    stopMoveInterpolation() {
        const move = this.moveInterpolation;
        if (!move) return;
        this.updateMovePosition();
        clearTimeout(move.timer);
        if (move.session?.moveTimer === move.timer) move.session.moveTimer = null;
        this.moveInterpolation = null;
    }

    startMoveInterpolation(session, actor, to, duration) {
        this.stopMoveInterpolation();
        // NPCs and summons borrow a recipient's session to broadcast. Keep
        // their movement on their own automation, never on that recipient.
        const ownSession = session?.actor === actor ? session : null;
        if (ownSession?.moveTimer) {
            clearInterval(ownSession.moveTimer);
            ownSession.moveTimer = null;
        }
        const move = this.moveInterpolation = {
            actor, session: ownSession, to: { ...to },
            from: { locX: actor.fetchLocX(), locY: actor.fetchLocY(), locZ: actor.fetchLocZ() },
            startedAt: Date.now(), duration: Math.max(1, duration), timer: null
        };
        const advance = () => {
            if (this.moveInterpolation !== move) return;
            this.updateMovePosition();
            const remaining = move.duration - (Date.now() - move.startedAt);
            if (remaining <= 0) return;
            move.timer = setTimeout(advance, Math.min(100, remaining));
            if (ownSession) ownSession.moveTimer = move.timer;
        };
        move.timer = setTimeout(advance, Math.min(100, move.duration));
        if (ownSession) ownSession.moveTimer = move.timer;
    }

    scheduleAction(session, src, dst, radius, callback, options = {}) {
        this.stopMoveInterpolation();
        const actionRange = options.collisionAware
            ? AttackRange.effectiveRange(src, dst, radius)
            : Math.max(0, Number(radius) || 0);
        const weaponAttack = options.action === 'attack';
        if (weaponAttack && AttackRange.distance2d(src, dst) <= actionRange) {
            this.abortAll(src);
            callback();
            return true;
        }
        // Stop inside the legal hit range. Integer client coordinates must
        // not strand a stationary target just outside the exact boundary.
        const movementRadius = weaponAttack
            ? Math.max(0, actionRange - Math.min(10, actionRange / 4))
            : actionRange;
        if (!invoke('GameServer/Effects/EffectRestrictions').canMove(src)) {
            const distance = Math.hypot(dst.fetchLocX() - src.fetchLocX(), dst.fetchLocY() - src.fetchLocY());
            if (distance <= movementRadius) {
                callback();
                return true;
            }
            invoke('GameServer/Effects/EffectRestrictions').reject(session);
            return false;
        }
        // NPCs and summons also send movement through another actor's session.
        // Only the moving actor may replace that session's active route.
        if (session?.actor === src) session.activeMoveGoal = null;
        // Execute each time, or else creature is stuck
        this.setDestId(dst.fetchId());
        session.dataSendToMeAndOthers(ServerResponse.moveToPawn(src, dst, movementRadius), src);
        const stopCoords = this.actionStopCoords(src, dst, movementRadius);

        // Calculate duration
        src.state.setTowards(weaponAttack || radius === 0 ? 'melee' : 'remote');
        const ticks = this.ticksToMove(
            src.fetchLocX(), src.fetchLocY(), src.fetchLocZ(), dst.fetchLocX(), dst.fetchLocY(), dst.fetchLocZ(), movementRadius, src.fetchCollectiveRunSpd()
        );

        const movingSelf = session?.actor === src;
        const movingBot = movingSelf && (
            session.constructor.name === 'BotSession'
            || session.accountId?.startsWith('bot_')
        );
        if (!movingSelf || movingBot) this.startMoveInterpolation(session, src, stopCoords, ticks);

        // Arrived
        Timer.start(this.timer.action, () => {
            this.stopMoveInterpolation();
            src.state.setTowards(false);
            this.clearDestId();
            // A player's last ValidatePosition may describe an intermediate
            // point. C4 need not acknowledge the final MoveToPawn position,
            // so complete the server-owned approach for players as well.
            // Movement cancellation already clears this arrival timer.
            src.setLocXYZ(stopCoords);
            if (movingSelf) {
                if (session.moveTimer) {
                    clearInterval(session.moveTimer);
                    session.moveTimer = null;
                }
            }
            callback();

        }, ticks);
    }

    scheduleMoveToCoords(session, src, to, callback = () => {}) {
        const from = {
            locX: src.fetchLocX(),
            locY: src.fetchLocY(),
            locZ: src.fetchLocZ(),
        };
        const destination = {
            locX: Number(to.locX),
            locY: Number(to.locY),
            locZ: Number(to.locZ),
        };

        if (!Object.values(destination).every(Number.isFinite)) {
            return false;
        }
        this.stopMoveInterpolation();
        Object.assign(from, { locX: src.fetchLocX(), locY: src.fetchLocY(), locZ: src.fetchLocZ() });

        if (session?.actor === src) session.activeMoveGoal = null;

        // Coordinate movement is currently used by NPC path waypoints, but
        // keep it safe for a session moving its own actor too. An older
        // interpolator must not keep writing stale coordinates after the new
        // route has been announced.
        if (session?.actor === src && session.moveTimer) {
            clearInterval(session.moveTimer);
            session.moveTimer = null;
        }

        this.clearDestId();
        session.dataSendToMeAndOthers(
            ServerResponse.moveToLocation(src.fetchId(), { from, to: destination }),
            src
        );
        src.state.setTowards('path');

        const ticks = this.ticksToMove(
            from.locX, from.locY, from.locZ,
            destination.locX, destination.locY, destination.locZ,
            0,
            src.fetchCollectiveRunSpd()
        );

        this.startMoveInterpolation(session, src, destination, ticks);

        Timer.start(this.timer.action, () => {
            this.stopMoveInterpolation();
            src.state.setTowards(false);
            src.setLocXYZ(destination);
            callback(destination);
        }, ticks);
        return true;
    }

    fetchDistanceRatio() {
        if (Timer.exists(this.timer.action)) {
            return Timer.completeness(this.timer.action);
        }
        return false;
    }

    schedulePickup(session, src, dst, callback) {
        if (session) session.activeMoveGoal = null;
        const from = {
            locX: src.fetchLocX(),
            locY: src.fetchLocY(),
            locZ: src.fetchLocZ(),
        };

        const to = {
            locX: dst.fetchLocX(),
            locY: dst.fetchLocY(),
            locZ: dst.fetchLocZ(),
        };

        // Execute each time, or else creature is stuck
        session.dataSendToMeAndOthers(ServerResponse.moveToLocation(src.fetchId(), { from: from, to: to }), src);

        // Calculate duration
        src.state.setTowards('pickup');
        const ticks = this.ticksToMove(
            from.locX, from.locY, from.locZ, to.locX, to.locY, to.locZ, 0, src.fetchCollectiveRunSpd()
        );

        // Dynamically update coordinates step-by-step for bots while running to prevent teleportation/snapping on reschedule
        if (session && (session.constructor.name === 'BotSession' || (session.accountId && session.accountId.startsWith('bot_')))) {
            if (session.moveTimer) {
                clearInterval(session.moveTimer);
                session.moveTimer = null;
            }

            const dx = to.locX - from.locX;
            const dy = to.locY - from.locY;
            const dz = to.locZ - from.locZ;

            const tickRate = 250;
            const steps = Math.ceil(ticks / tickRate);
            let step = 0;

            session.moveTimer = setInterval(() => {
                step++;
                if (step >= steps) {
                    src.setLocXYZ(to);
                    clearInterval(session.moveTimer);
                    session.moveTimer = null;
                } else {
                    const ratio = step / steps;
                    src.setLocXYZ({
                        locX: Math.round(from.locX + dx * ratio),
                        locY: Math.round(from.locY + dy * ratio),
                        locZ: Math.round(from.locZ + dz * ratio)
                    });
                }
            }, tickRate);
        }

        // Arrived
        Timer.start(this.timer.pickup, () => {
            src.state.setTowards(false);
            if (session && (session.constructor.name === 'BotSession' || (session.accountId && session.accountId.startsWith('bot_')))) {
                src.setLocXYZ(to);
                if (session.moveTimer) {
                    clearInterval(session.moveTimer);
                    session.moveTimer = null;
                }
            }
            callback();

        }, ticks);
    }

    abortAll(creature, { notifyClient = true } = {}) {
        this.stopMoveInterpolation();
        const wasMoving = !!creature?.state?.inMotion?.() && !creature?.session?.pendingPathRequest;
        this.clearDestId();
        creature.state?.setTowards?.(false);
        Timer.clear(this.timer.action);
        Timer.clear(this.timer.pickup);

        const session = creature.session;
        if (session) {
            if (session.activeMoveGoal?.town) invoke('GameServer/Bot/AI/TownTraffic').remove(Number(creature.fetchId()));
            session.activeMoveGoal = null;
            session.moveRouteGeneration = Number(session.moveRouteGeneration || 0) + 1;
            if (session.pendingPathRequest?.cancel) {
                session.pendingPathRequest.cancel();
            }
            session.pendingPathRequest = null;
        }
        if (session && session.moveTimer) {
            clearInterval(session.moveTimer);
            session.moveTimer = null;
        }
        const botSession = session && (
            session.constructor?.name === 'BotSession' ||
            session.accountId?.startsWith?.('bot_')
        );

        // The server owns bot movement timers.  If one is cancelled without
        // a StopMove, C4 keeps animating the old route until a later combat
        // packet or CharInfo forces an obvious position correction.
        if (wasMoving && notifyClient && botSession && session.dataSendToMeAndOthers && creature?.fetchId) {
            invoke('GameServer/Actor/Generics/MoveTo').recordMovementTrace(session, {
                event: 'stop',
                at: Date.now(),
                loc: {
                    locX: creature.fetchLocX?.() || 0,
                    locY: creature.fetchLocY?.() || 0,
                    locZ: creature.fetchLocZ?.() || 0
                },
                towards: creature.state?.fetchTowards?.() || false
            });
            session.dataSendToMeAndOthers(
                ServerResponse.stopMove(creature.fetchId(), {
                    locX: creature.fetchLocX?.() || 0,
                    locY: creature.fetchLocY?.() || 0,
                    locZ: creature.fetchLocZ?.() || 0,
                    head: creature.fetchHead?.() || 0
                }),
                creature
            );
        }
    }
}

module.exports = Automation;
