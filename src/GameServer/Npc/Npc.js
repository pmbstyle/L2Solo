const ServerResponse = invoke('GameServer/Network/Response');
const NpcModel       = invoke('GameServer/Model/Npc');
const Automation     = invoke('GameServer/Automation');
const ConsoleText    = invoke('GameServer/ConsoleText');
const SpeckMath      = invoke('GameServer/SpeckMath');
const Formulas       = invoke('GameServer/Formulas');
const GeodataEngine  = invoke('GameServer/Geodata/GeodataEngine');
const Attack         = invoke('GameServer/Actor/Attack');
const ManorData      = invoke('GameServer/Manor/ManorData');
const NpcSkills      = invoke('GameServer/Npc/NpcSkills');
const EffectStats    = invoke('GameServer/Effects/EffectStats');
const EffectStore    = invoke('GameServer/Effects/EffectStore');
const EffectRestrictions = invoke('GameServer/Effects/EffectRestrictions');
const PathfindingWorkerPool = invoke('GameServer/Geodata/PathfindingWorkerPool');
const AttackHelper   = new Attack();

// MoveToPawn already tells the client to follow a moving target. Rebuilding
// that request on every 100ms combat tick yields visible stop/start jitter.
const CHASE_REPATH_DISTANCE = 120;
const CHASE_REPATH_INTERVAL_MS = 300;
const NPC_PATH_MAX_NODES = 8000;
const NPC_PATH_RETRY_INTERVAL_MS = 500;
const NPC_PATH_MAX_RETRY_INTERVAL_MS = 4000;
const NPC_PATH_FAILURE_TIMEOUT_MS = 10000;

class Npc extends NpcModel {
    constructor(id, data) {
        // Parent inheritance
        super(data);

        // NOTE: Do NOT snap spawn Z to geodata here.
        // Coordinates in spawns.json are already correct (taken from authentic L2J data).
        // Applying GeodataEngine.getHeight() overwrites them with inaccurate geodata values
        // causing NPCs to spawn under terrain in Dion, Gludio, Dark Elf Village, etc.

        // Local
        this.automation = new Automation();
        this.automation.setRevHp(this.fetchRevHp());
        this.automation.setRevMp(this.fetchRevMp());
        this.attack = new Attack();

        this.setId(id);
        this.fillupVitals();

        // User preferences
        const optn = options.default.General;

        if (optn.showMonsterLevel) {
            this.showLevelTitle();
        }

        // TODO: Move this into actual GameServer timer
        this.timer = {
            combat: undefined,
            combatStart: undefined,
            hit: undefined,
            hitEnd: undefined
        };
        this.skillReuseUntil = new Map();
    }

    destructor(session) {
        clearInterval(this.timer.followOwner);
        this.timer.followOwner = undefined;
        clearTimeout(this.timer.summonResume);
        this.timer.summonResume = undefined;
        clearInterval(this.timer.summonLifetime);
        this.timer.summonLifetime = undefined;
        clearInterval(this.timer.petFeed);
        this.timer.petFeed = undefined;
        this.automation.stopReplenish();
        this.attack.clearTimers?.();
        this.abortCombatState(session);
    }

    showLevelTitle() {
        if (this.fetchAttackable() && this.fetchTitle() === '') {
            this.setTitle('Lv ' + this.fetchLevel() + (this.fetchHostile() ? ' @' : ''));
        }
    }

    enterCombatState(session, actor) {
        if (this.state.fetchCombats() || actor?.isDead?.() || actor?.state?.fetchDead?.() || actor?.fakeDeath) {
            return;
        }

        this.setDestId(actor.fetchId());
        this.state.setCombats(true);

        this.setStateRun(true);
        this.setStateAttack(true);
        session.dataSendToMeAndOthers(ServerResponse.walkAndRun(this.fetchId(), this.fetchStateRun()), this);
        session.dataSendToMeAndOthers(ServerResponse.autoAttackStart(this.fetchId()), this);

        this.timer.combatStart = setTimeout(() => {
            this.timer.combatStart = undefined;
            if (!this.state.fetchCombats() || actor?.isDead?.() || actor?.state?.fetchDead?.() || actor?.fakeDeath) {
                if (this.state.fetchCombats()) this.abortCombatState(session);
                return;
            }

            const coords = {
                locX: 0,
                locY: 0,
                locZ: 0,
            };
            let lastChaseRepathAt = 0;
            let activeMoveCoords = null;
            let activePathWaypoints = [];
            let activePathTargetCoords = null;
            let pathFailureStartedAt = 0;
            let pathFailureCount = 0;
            let nextPathRetryAt = 0;
            let pendingPath = null;
            let pathGeneration = 0;

            this.timer.combat = setInterval(() => {
                // A dead target cannot be chased or hit.  Leaving the NPC in
                // combat here pins its target to the corpse indefinitely and
                // makes party resurrection believe the fight never ended.
                if (actor?.isDead?.() || actor?.state?.fetchDead?.() || actor?.fakeDeath) {
                    this.abortCombatState(session);
                    return;
                }

                if (new SpeckMath.Point(this.fetchLocX(), this.fetchLocY()).distance(new SpeckMath.Point(actor.fetchLocX(), actor.fetchLocY())) >= 1500) {
                    this.abortCombatState(session); // Actor is out of reach
                    return;
                }

                if (this.state.isBlocked() || !EffectRestrictions.canAttack(this)) {
                    return;
                }

                const newDstX = actor.fetchLocX();
                const newDstY = actor.fetchLocY();
                const newDstZ = actor.fetchLocZ();

                if (this.state.inMotion()) {
                    const targetDrift = activePathTargetCoords
                        ? new SpeckMath.Point3D(
                            activePathTargetCoords.locX,
                            activePathTargetCoords.locY,
                            activePathTargetCoords.locZ
                        ).distance(new SpeckMath.Point3D(newDstX, newDstY, newDstZ))
                        : new SpeckMath.Point(coords.locX, coords.locY)
                            .distance(new SpeckMath.Point(newDstX, newDstY));
                    const canRepath = Date.now() - lastChaseRepathAt >= CHASE_REPATH_INTERVAL_MS;
                    if (targetDrift >= CHASE_REPATH_DISTANCE && canRepath) {
                        const progress = Math.min(1, Math.max(0, Number(this.automation.fetchDistanceRatio()) || 0));
                        const moveTarget = activeMoveCoords || coords;
                        this.setLocXYZ(
                            new SpeckMath.Point3D(this.fetchLocX(), this.fetchLocY(), this.fetchLocZ())
                                .midPoint(new SpeckMath.Point3D(moveTarget.locX, moveTarget.locY, moveTarget.locZ), progress)
                                .toCoords()
                        );
                        this.automation.abortAll(this);
                        activeMoveCoords = null;
                        activePathWaypoints = [];
                        activePathTargetCoords = null;
                        // The authoritative chase position changed before the
                        // scheduled move ended.  Freeze the client at exactly
                        // that position before scheduling the next chase leg.
                        this.stopForCombatAction(session);
                        lastChaseRepathAt = Date.now();
                    }
                    return;
                }

                coords.locX = newDstX;
                coords.locY = newDstY;
                coords.locZ = newDstZ;
                lastChaseRepathAt = Date.now();

                const combatSkill = this.selectCombatSkill(actor);
                if (combatSkill?.fetchTargetKind?.() === 'self') {
                    this.stopForCombatAction(session);
                    this.castSkill(session, this, combatSkill);
                    return;
                }
                const actionRange = combatSkill ? this.fetchSkillCastRange(combatSkill, actor) : this.fetchCombatAttackRange(actor);

                if (!this.hasCombatLineOfSight(actor)) {
                    const now = Date.now();
                    if (activePathTargetCoords) {
                        const pathTargetDrift = new SpeckMath.Point3D(
                            activePathTargetCoords.locX,
                            activePathTargetCoords.locY,
                            activePathTargetCoords.locZ
                        ).distance(new SpeckMath.Point3D(newDstX, newDstY, newDstZ));
                        if (pathTargetDrift >= CHASE_REPATH_DISTANCE) {
                            activePathWaypoints = [];
                            activePathTargetCoords = null;
                        }
                    }

                    if (activePathWaypoints.length === 0) {
                        if (now < nextPathRetryAt) {
                            return;
                        }
                        if (!pendingPath) {
                            const requestedTarget = { locX: newDstX, locY: newDstY, locZ: newDstZ };
                            const generation = ++pathGeneration;
                            pendingPath = this.fetchCombatPathAsync(actor)
                                .then((path) => {
                                    if (generation !== pathGeneration || !this.state.fetchCombats()) return;
                                    const drift = new SpeckMath.Point3D(
                                        requestedTarget.locX,
                                        requestedTarget.locY,
                                        requestedTarget.locZ
                                    ).distance(new SpeckMath.Point3D(
                                        actor.fetchLocX(),
                                        actor.fetchLocY(),
                                        actor.fetchLocZ()
                                    ));
                                    if (drift >= CHASE_REPATH_DISTANCE) return;
                                    if (!path || path.length <= 1) {
                                        pathFailureStartedAt ||= Date.now();
                                        pathFailureCount++;
                                        const retryDelay = Math.min(
                                            NPC_PATH_MAX_RETRY_INTERVAL_MS,
                                            NPC_PATH_RETRY_INTERVAL_MS * (2 ** (pathFailureCount - 1))
                                        );
                                        nextPathRetryAt = Date.now() + retryDelay;
                                        if (Date.now() - pathFailureStartedAt >= NPC_PATH_FAILURE_TIMEOUT_MS) {
                                            this.abortCombatState(session);
                                        }
                                        return;
                                    }
                                    activePathWaypoints = path.slice(1);
                                    activePathTargetCoords = requestedTarget;
                                    pathFailureStartedAt = 0;
                                    pathFailureCount = 0;
                                    nextPathRetryAt = 0;
                                })
                                .catch((error) => {
                                    if (!['STALE_PATH', 'POOL_SHUTDOWN'].includes(error?.code)) {
                                        nextPathRetryAt = Date.now() + NPC_PATH_RETRY_INTERVAL_MS;
                                    }
                                })
                                .finally(() => {
                                    if (generation === pathGeneration) pendingPath = null;
                                });
                        }
                        return;
                    }

                    activeMoveCoords = activePathWaypoints.shift();
                    this.automation.scheduleMoveToCoords(session, this, activeMoveCoords, () => {
                        activeMoveCoords = null;
                    });
                    return;
                }

                pathFailureStartedAt = 0;
                pathFailureCount = 0;
                nextPathRetryAt = 0;
                activePathWaypoints = [];
                activePathTargetCoords = null;
                const stopCoords = this.fetchCombatStopCoords(actor, actionRange);
                activeMoveCoords = stopCoords;

                this.automation.scheduleAction(session, this, actor, actionRange, () => {
                    activeMoveCoords = null;
                    if (!EffectRestrictions.canAttack(this)) {
                        return;
                    }
                    this.setLocXYZ(stopCoords);

                    // The target may have crossed a doorway or rounded a wall
                    // while the chase timer was running. Never turn a stale
                    // straight-line move into an attack through geometry.
                    if (!this.hasCombatLineOfSight(actor)) {
                        return;
                    }

                    if (combatSkill && this.isTargetInAttackRange(actor, actionRange)) {
                        this.stopForCombatAction(session);
                        this.castSkill(session, actor, combatSkill);
                        return;
                    }

                    const attackRange = this.fetchCombatAttackRange(actor);

                    if (this.isTargetInAttackRange(actor, attackRange)) {
                        this.stopForCombatAction(session);
                        this.meleeHit(session, this, actor);
                    }
                });

            }, 100);

        }, 1000);
    }

    fetchCombatAttackRange(actor) {
        return Math.max(
            0,
            Number(this.fetchAtkRadius()) || 0,
            Number(actor?.fetchRadius?.()) || 0
        );
    }

    fetchCollectiveAccur() {
        // NPC templates carry the base accuracy bonus.  As in the C4 stat
        // calculator, add DEX and level before using it in the hit formula.
        return Formulas.calcAccur(this.fetchLevel(), this.fetchDex(), this.fetchAccur())
            + EffectStats.add(this, 'pAccuracyCombatAdd');
    }

    fetchCollectiveEvasion() {
        // NPC templates have no authored evasion value, but they still use
        // the standard DEX/level evasion calculation and active effects.
        return Formulas.calcEvasion(this.fetchLevel(), this.fetchDex(), this.fetchEvasion())
            + EffectStats.add(this, 'pEvasionRateAdd');
    }

    // Lisvus NpcStat inherits CharStat, so NPCs evaluate the same stat
    // functions as players while effects are active. NPC templates already
    // provide this project's base combat values; apply only the active effect
    // modifiers here instead of running the player-only class calculator.
    fetchCollectivePAtk() {
        return effectAdjusted(super.fetchCollectivePAtk(), this, 'pAtk');
    }

    fetchMaxHp() {
        return effectAdjusted(super.fetchMaxHp(), this, 'maxHp');
    }

    fetchCollectiveMAtk() {
        return effectAdjusted(super.fetchCollectiveMAtk(), this, 'mAtk');
    }

    fetchCollectivePDef() {
        return effectAdjusted(super.fetchCollectivePDef(), this, 'pDef');
    }

    fetchCollectiveMDef() {
        return effectAdjusted(super.fetchCollectiveMDef(), this, 'mDef');
    }

    fetchCollectiveAtkSpd() {
        return effectAdjusted(super.fetchCollectiveAtkSpd(), this, 'pAtkSpd');
    }

    fetchCollectiveCastSpd() {
        return effectAdjusted(super.fetchCollectiveCastSpd(), this, 'castSpd');
    }

    fetchCollectiveWalkSpd() {
        return effectAdjusted(super.fetchCollectiveWalkSpd(), this, 'walkSpd', { speed: true });
    }

    fetchCollectiveRunSpd() {
        return effectAdjusted(super.fetchCollectiveRunSpd(), this, 'runSpd', { speed: true });
    }

    fetchCombatStopCoords(actor, attackRange = this.fetchCombatAttackRange(actor)) {
        return this.automation.actionStopCoords(this, actor, attackRange);
    }

    isTargetInAttackRange(actor, attackRange = this.fetchCombatAttackRange(actor)) {
        const distance = new SpeckMath.Point3D(this.fetchLocX(), this.fetchLocY(), this.fetchLocZ()).distance(
            new SpeckMath.Point3D(actor.fetchLocX(), actor.fetchLocY(), actor.fetchLocZ())
        );
        return distance <= attackRange + 1;
    }

    hasCombatLineOfSight(actor) {
        return GeodataEngine.hasLineOfSight(
            this.fetchLocX(), this.fetchLocY(), this.fetchLocZ(),
            actor.fetchLocX(), actor.fetchLocY(), actor.fetchLocZ()
        );
    }

    fetchCombatPath(actor) {
        return GeodataEngine.findPath(
            this.fetchLocX(), this.fetchLocY(), this.fetchLocZ(),
            actor.fetchLocX(), actor.fetchLocY(), actor.fetchLocZ(),
            NPC_PATH_MAX_NODES
        );
    }

    fetchCombatPathAsync(actor) {
        return PathfindingWorkerPool.request({
            startX: this.fetchLocX(),
            startY: this.fetchLocY(),
            startZ: this.fetchLocZ(),
            endX: actor.fetchLocX(),
            endY: actor.fetchLocY(),
            endZ: actor.fetchLocZ(),
            maxNodes: NPC_PATH_MAX_NODES
        }, {
            key: `npc:${this.fetchId()}`,
            timeoutMs: NPC_PATH_FAILURE_TIMEOUT_MS
        });
    }

    fetchCombatSkills() {
        if (!this.combatSkills) {
            this.combatSkills = NpcSkills.combatSkillsFor(this);
        }
        return this.combatSkills;
    }

    fetchPassiveSkills() {
        if (!this.passiveSkills) {
            this.passiveSkills = NpcSkills.passiveSkillsFor(this);
        }
        return this.passiveSkills;
    }

    fetchSkillCastRange(skill, actor) {
        return Math.max(
            0,
            Number(skill?.fetchDistance?.()) || 0,
            Number(actor?.fetchRadius?.()) || 0
        );
    }

    selectCombatSkill(actor) {
        if (!EffectRestrictions.canCast(this)) return null;
        const skills = this.fetchCombatSkills().filter((skill) => {
            if (this.fetchMp() < skill.fetchConsumedMp()) return false;
            return this.canUseSkill(skill);
        });
        const selfBuff = skills.find((skill) => {
            if (skill.fetchTargetKind() !== 'self') return false;
            const semantic = skill.fetchSemantic?.() || {};
            if (semantic.effectType !== 'buff' || !semantic.effect) return false;
            return !EffectStore.list(this).some((effect) => (
                Number(effect.id) === Number(skill.fetchSelfId()) || effect.key === semantic.effect
            ));
        });
        if (selfBuff) return selfBuff;

        return skills.find((skill) => {
            if (skill.fetchTargetKind() !== 'enemy') return false;
            return true;
        }) || null;
    }

    canUseSkill(skill, now = Date.now()) {
        return (this.skillReuseUntil.get(skill.fetchSelfId()) || 0) <= now;
    }

    markSkillReuse(skill, now = Date.now()) {
        this.skillReuseUntil.set(
            skill.fetchSelfId(),
            now + Math.max(1000, Number(skill.fetchReuseTime()) || 0)
        );
    }

    stopForCombatAction(session) {
        session.dataSendToMeAndOthers(
            ServerResponse.stopMove(this.fetchId(), {
                locX: this.fetchLocX(),
                locY: this.fetchLocY(),
                locZ: this.fetchLocZ(),
                head: this.fetchHead(),
            }), this
        );
    }

    castSkill(session, actor, skill) {
        if (!EffectRestrictions.canCast(this)) return;
        if (actor !== this && !this.hasCombatLineOfSight(actor)) return;
        this.attack.remoteHit({
            actor: this,
            dataSendToMe: (packet) => session.dataSendToMe?.(packet),
            dataSendToMeAndOthers: (packet) => session.dataSendToMeAndOthers(packet, this)
        }, actor, skill);
    }

    abortCombatState(session) {
        const wasMoving = this.state.inMotion();
        clearTimeout(this.timer.combatStart);
        this.timer.combatStart = undefined;
        clearInterval(this.timer.combat);
        this.timer.combat = undefined;
        clearTimeout(this.timer.hit);
        this.timer.hit = undefined;
        clearTimeout(this.timer.hitEnd);
        this.timer.hitEnd = undefined;
        PathfindingWorkerPool.cancel(`npc:${this.fetchId()}`);

        this.clearDestId();
        this.state.setCombatEnded();
        this.automation.abortAll(this);

        if (wasMoving) {
            this.stopForCombatAction(session);
        }

        this.setStateRun(false);
        this.setStateAttack(false);
        session.dataSendToMeAndOthers(ServerResponse.walkAndRun(this.fetchId(), this.fetchStateRun()), this);
        session.dataSendToMeAndOthers(ServerResponse.autoAttackStop(this.fetchId()), this);
    }

    meleeHit(session, src, dst) {
        if (
            !EffectRestrictions.canAttack(src)
            || this.checkParticipants(session, src, dst)
            || !this.hasCombatLineOfSight(dst)
        ) {
            return;
        }

        const speed = Formulas.calcMeleeAtkTime(src.fetchCollectiveAtkSpd());
        const hitLanded = Formulas.calcHitChance(src, dst, Math.random, AttackHelper.positionContext(src, dst));
        const hit = AttackHelper.prepareNpcMeleeHit(src, dst, hitLanded);

        session.dataSendToMeAndOthers(ServerResponse.attack(src, dst.fetchId(), hit), this);
        src.state.setHits(true);

        clearTimeout(this.timer.hit);
        this.timer.hit = setTimeout(() => {
            this.timer.hit = undefined;
            if (!EffectRestrictions.canAttack(src) || this.checkParticipants(session, src, dst)) {
                return;
            }

            if (hitLanded) {
                this.hit(session, dst, hit.damage);
            }
            else {
                ConsoleText.transmit(session, ConsoleText.caption.missedHit);
            }

        }, speed * 0.644);

        clearTimeout(this.timer.hitEnd);
        this.timer.hitEnd = setTimeout(() => {
            this.timer.hitEnd = undefined;
            this.state.setHits(false);

        }, speed); // Until end of combat move
    }

    checkParticipants(session, src, dst) {
        if (src.state.fetchDead() || dst.state.fetchDead()) {
            this.abortCombatState(session);
            return true;
        }
        return false;
    }

    hit(session, actor, hit) {
        ConsoleText.transmit(session, ConsoleText.caption.monsterHit, [
            { kind: ConsoleText.kind.npc, value: this.fetchDispSelfId() }, { kind: ConsoleText.kind.number, value: hit }
        ]);

        if (actor?.fetchIsSummon?.() === true) {
            actor.setHp(Math.max(0, actor.fetchHp() - hit));
            actor.broadcastVitals?.();
            if (actor.fetchHp() <= 0) {
                invoke(path.npc).die(session, this, actor);
            }
            return;
        }

        if (actor?.session) {
            actor.session.incomingThreatId = this.fetchId();
            actor.session.incomingThreatAt = Date.now();
        }
        invoke(path.actor).receivedHit(session, actor, hit);
    }

    broadcastVitals() {
        const World = invoke('GameServer/World/World');
        if (!World.user?.sessions) {
            return;
        }
        invoke(path.npc).broadcastVitals(this);
    }

    statusUpdateVitals() {
        this.broadcastVitals();
    }

    addAbsorber(actor) {
        if (!actor?.fetchId) {
            return;
        }

        if (!this.soulCrystalAbsorbers) {
            this.soulCrystalAbsorbers = new Map();
        }

        const absorberId = Number(actor.fetchId());
        this.soulCrystalAbsorbers.set(absorberId, {
            actor,
            absorberId,
            absorbedHp: this.fetchHp()
        });
        this.soulCrystalAbsorbed = true;
    }

    isAbsorbed() {
        return this.soulCrystalAbsorbed === true;
    }

    fetchSoulCrystalAbsorber(actorOrId) {
        const absorberId = Number(
            typeof actorOrId?.fetchId === 'function'
                ? actorOrId.fetchId()
                : actorOrId
        );
        return this.soulCrystalAbsorbers?.get(absorberId) || null;
    }

    resetSoulCrystalAbsorbers() {
        this.soulCrystalAbsorbers?.clear();
        this.soulCrystalAbsorbed = false;
    }

    setManorSeedPending(seedId, seeder) {
        if (this.model.manor?.seeded) {
            return false;
        }

        this.model.manor = {
            seedId,
            seeder,
            seederId: Number(seeder?.fetchId?.()) || 0,
            seeded: false,
            harvestItems: []
        };
        return true;
    }

    clearManorSeedPending(seedId, seeder) {
        if (this.model.manor?.seeded) {
            return;
        }
        if (seedId && Number(this.model.manor?.seedId) !== Number(seedId)) {
            return;
        }
        if (seeder && Number(this.model.manor?.seederId) !== Number(seeder.fetchId?.())) {
            return;
        }
        this.model.manor = undefined;
    }

    setManorSeeded() {
        const manor = this.model.manor;
        if (!manor?.seedId || !manor?.seeder) {
            return false;
        }

        manor.seeded = true;
        manor.harvestItems = ManorData.harvestItems(manor.seedId, this.fetchLevel(), this);
        return true;
    }

    isManorSeeded() {
        return this.model.manor?.seeded === true;
    }

    fetchManorSeeder() {
        return this.model.manor?.seeder || null;
    }

    fetchManorSeederId() {
        return Number(this.model.manor?.seederId) || 0;
    }

    fetchManorSeedId() {
        return Number(this.model.manor?.seedId) || 0;
    }

    takeManorHarvest() {
        const items = this.model.manor?.harvestItems || [];
        if (this.model.manor) {
            this.model.manor.harvestItems = [];
        }
        return items;
    }
}

function effectAdjusted(base, actor, stat, { speed = false } = {}) {
    const add = EffectStats.add(actor, `${stat}Add`);
    const multiplier = EffectStats.multiplier(actor, `${stat}Mul`);
    const adjusted = speed
        ? (Number(base) + add) * multiplier
        : (Number(base) * multiplier) + add;
    return Math.max(1, Math.round(adjusted));
}

module.exports = Npc;
