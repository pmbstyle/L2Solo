const ServerResponse = invoke('GameServer/Network/Response');
const SelectedModel  = invoke('GameServer/Model/Selected');
const Timer          = invoke('GameServer/Timer');
const SpeckMath      = invoke('GameServer/SpeckMath');
const EffectStats    = invoke('GameServer/Effects/EffectStats');

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
        const minHp = Math.min(creature.fetchHp() + this.fetchRevHpAmount(creature), maxHp);
        const minMp = Math.min(creature.fetchMp() + this.fetchRevMpAmount(creature), maxMp);

        creature.setHp(minHp);
        creature.setMp(minMp);

        if (creature.fetchKind === undefined) {
            creature.statusUpdateVitals(creature);
        }
        else {
            creature.broadcastVitals();
        }

        if (minHp >= maxHp && minMp >= maxMp) {
            this.stopReplenish();
        }

        return { hp: minHp, mp: minMp };
    }

    fetchRevHpAmount(creature) {
        const base = this.fetchPlayerRegenBase(creature, 'CON');
        return Math.max(0, base * EffectStats.multiplier(creature, 'regHp') * this.fetchRegenStateMultiplier(creature));
    }

    fetchRevMpAmount(creature) {
        const base = this.fetchPlayerRegenBase(creature, 'MEN');
        return Math.max(0, (
            (base * EffectStats.multiplier(creature, 'regMp'))
            + EffectStats.add(creature, 'regMpAdd')
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

    scheduleAction(session, src, dst, radius, callback) {
        // Execute each time, or else creature is stuck
        this.setDestId(dst.fetchId());
        session.dataSendToMeAndOthers(ServerResponse.moveToPawn(src, dst, radius), src);
        const stopCoords = this.actionStopCoords(src, dst, radius);

        // Calculate duration
        src.state.setTowards(radius === 0 ? 'melee' : 'remote');
        const ticks = this.ticksToMove(
            src.fetchLocX(), src.fetchLocY(), src.fetchLocZ(), dst.fetchLocX(), dst.fetchLocY(), dst.fetchLocZ(), radius, src.fetchCollectiveRunSpd()
        );

        // Dynamically update coordinates step-by-step for bots while running to prevent teleportation/snapping on reschedule
        if (session && (session.constructor.name === 'BotSession' || (session.accountId && session.accountId.startsWith('bot_')))) {
            if (session.moveTimer) {
                clearInterval(session.moveTimer);
                session.moveTimer = null;
            }

            const startX = src.fetchLocX();
            const startY = src.fetchLocY();
            const startZ = src.fetchLocZ();
            const endX = stopCoords.locX;
            const endY = stopCoords.locY;
            const endZ = stopCoords.locZ;

            const dx = endX - startX;
            const dy = endY - startY;
            const dz = endZ - startZ;

            const tickRate = 250;
            const steps = Math.ceil(ticks / tickRate);
            let step = 0;

            session.moveTimer = setInterval(() => {
                step++;
                if (step >= steps) {
                    src.setLocXYZ({ locX: endX, locY: endY, locZ: endZ });
                    clearInterval(session.moveTimer);
                    session.moveTimer = null;
                } else {
                    const ratio = step / steps;
                    src.setLocXYZ({
                        locX: Math.round(startX + dx * ratio),
                        locY: Math.round(startY + dy * ratio),
                        locZ: Math.round(startZ + dz * ratio)
                    });
                }
            }, tickRate);
        }

        // Arrived
        Timer.start(this.timer.action, () => {
            src.state.setTowards(false);
            this.clearDestId();
            if (session && (session.constructor.name === 'BotSession' || (session.accountId && session.accountId.startsWith('bot_')))) {
                src.setLocXYZ(stopCoords);
                if (session.moveTimer) {
                    clearInterval(session.moveTimer);
                    session.moveTimer = null;
                }
            }
            callback();

        }, ticks);
    }

    fetchDistanceRatio() {
        if (Timer.exists(this.timer.action)) {
            return Timer.completeness(this.timer.action);
        }
        return false;
    }

    schedulePickup(session, src, dst, callback) {
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

    abortAll(creature) {
        this.clearDestId();
        creature.state.setTowards(false);
        Timer.clear(this.timer.action);
        Timer.clear(this.timer.pickup);

        const session = creature.session;
        if (session && session.moveTimer) {
            clearInterval(session.moveTimer);
            session.moveTimer = null;
        }
    }
}

module.exports = Automation;
