const ServerResponse = invoke('GameServer/Network/Response');
const NpcModel       = invoke('GameServer/Model/Npc');
const Automation     = invoke('GameServer/Automation');
const ConsoleText    = invoke('GameServer/ConsoleText');
const SpeckMath      = invoke('GameServer/SpeckMath');
const Formulas       = invoke('GameServer/Formulas');
const GeodataEngine  = invoke('GameServer/Geodata/GeodataEngine');
const Attack         = invoke('GameServer/Actor/Attack');
const AttackRange    = invoke('GameServer/Actor/AttackRange');
const ManorData      = invoke('GameServer/Manor/ManorData');
const NpcSkills      = invoke('GameServer/Npc/NpcSkills');
const NpcCombatChoice = invoke('GameServer/Npc/NpcCombatChoice');
const EffectStats    = invoke('GameServer/Effects/EffectStats');
const EffectStore    = invoke('GameServer/Effects/EffectStore');
const EffectTicker   = invoke('GameServer/Effects/EffectTicker');
const EffectRestrictions = invoke('GameServer/Effects/EffectRestrictions');
const TownGuard = invoke('GameServer/Npc/TownGuard');
const NpcHate = invoke('GameServer/Npc/NpcHate');
const PathfindingWorkerPool = invoke('GameServer/Geodata/PathfindingWorkerPool');
const AttackHelper   = new Attack();
// Dropped chases and mobs left out of combat still hating (sleep, stun, fake death).
const hateStats = { outOfReach: 0, noPath: 0, idleWithHate: 0 };

// MoveToPawn already tells the client to follow a moving target. Rebuilding
// that request on every 100ms combat tick yields visible stop/start jitter.
const CHASE_REPATH_DISTANCE = 120;
const CHASE_REPATH_INTERVAL_MS = 300;
const NPC_PATH_MAX_NODES = 8000;
const NPC_PATH_RETRY_INTERVAL_MS = 500;
const NPC_PATH_MAX_RETRY_INTERVAL_MS = 4000;
const NPC_PATH_FAILURE_TIMEOUT_MS = 10000;



class Npc extends NpcModel {
    static hateStats() {
        return { ...hateStats };
    }

    constructor(id, data) {
        // Parent inheritance
        super(data);

        // Explicit datapack coordinates must retain their authored Z (towns
        // and dungeon floors). SpawnNpcs resolves terrain only for random
        // territory positions before constructing the NPC.

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
        this.lastDebuffAt = 0;
        this.aggroList = new Map();
        this.combatTarget = undefined;
    }

    destructor(session) {
        clearInterval(this.timer.babyHeal);
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
        // Despawn without death (quest NPC, minion, day/night, unsummon) must
        // not leave effect timers that later refresh a removed NPC.
        EffectTicker.clearAll(this);
        this.abortCombatState(session);
    }

    showLevelTitle() {
        if (this.fetchAttackable() && this.fetchTitle() === '') {
            this.setTitle('Lv ' + this.fetchLevel() + (this.fetchHostile() ? ' @' : ''));
        }
    }

    isConfusionTarget(actor) {
        return !!actor && actor !== this && actor === this.confusionTarget
            && this.fetchAttackable() && actor.fetchAttackable?.() === true
            && actor.state?.fetchDead?.() !== true
            && EffectStore.hasDebuff(this, 'confusion');
    }

    isValidAggroTarget(actor) {
        if (!actor || Number(actor.fetchId?.()) <= 0) return false;
        // NPC combat can target players and player-owned summons, but not
        // another ordinary NPC, except the target selected by active confusion.
        // That exception uses its own NPC damage path, never the player pipeline.
        if (typeof actor.fetchKind === 'function' && actor.fetchIsSummon?.() !== true
            && !this.isConfusionTarget(actor)) return false;
        if (actor.state?.fetchDead?.() === true || actor.fakeDeath === true) return false;

        // A disconnected player can remain strongly referenced by the hate
        // table after Session.error() clears session.actor. Do not keep
        // chasing that stale object; test the ownership link before falling
        // back to the actor's online flag.
        if (actor.session && actor.session.actor !== actor) return false;
        if (typeof actor.fetchIsOnline === 'function' && actor.fetchIsOnline() === false) return false;

        // NPCs and lightweight test actors may not expose StateModel. Only
        // use the generic isDead() fallback when it cannot trigger the player
        // ActionFailed side effect implemented by Actor.isDead().
        if (!actor.state && actor.isDead?.() === true) return false;
        return true;
    }

    canEngageCombat() {
        // Lisvus gives ordinary L2NpcInstance/L2FolkInstance no retaliatory
        // AI. Guards inherit L2Attackable; owned summons have their own AI.
        return this.fetchAttackable() || TownGuard.isTownGuard(this) || this.fetchIsSummon();
    }

    ensureAggroEntry(actor) {
        if (!this.canEngageCombat()) return null;
        if (!this.isValidAggroTarget(actor)) return null;

        const actorId = Number(actor.fetchId());
        let entry = this.aggroList.get(actorId);
        if (!entry) {
            entry = { actor, damage: 0, hate: 0 };
            this.aggroList.set(actorId, entry);
        }
        else {
            // Keep the live object when a session exposes a refreshed actor
            // instance with the same object id.
            entry.actor = actor;
        }
        return entry;
    }

    addDamageHate(session, actor, damage = 0, aggro = 0) {
        const entry = this.ensureAggroEntry(actor);
        if (!entry) return false;

        const damageValue = Math.max(0, Number(damage) || 0);
        const aggroValue = Number.isFinite(Number(aggro)) ? Number(aggro) : 0;
        entry.damage += damageValue;
        entry.hate = NpcHate.add(entry.hate, aggroValue);

        const target = this.fetchMostHated();
        if (!target) return false;

        if (damageValue > 0) require('../Social/SharedHuntActivity').recordCombat(this, actor);

        if (!this.state.fetchCombats()) {
            this.enterCombatState(session, target, { skipAggro: true });
        }
        else {
            this.switchCombatTarget(target);
        }
        return true;
    }

    fetchMostHated() {
        for (const [actorId, entry] of this.aggroList.entries()) {
            if (!this.isValidAggroTarget(entry?.actor)) this.aggroList.delete(actorId);
        }
        return NpcHate.mostHated(this.aggroList.values())?.actor || null;
    }

    fetchCombatTarget() {
        if (this.isConfusionTarget(this.confusionTarget)) {
            this.switchCombatTarget(this.confusionTarget);
            return this.confusionTarget;
        }
        delete this.confusionTarget;
        const mostHated = this.fetchMostHated();
        if (mostHated) {
            this.switchCombatTarget(mostHated);
            return mostHated;
        }

        if (this.isValidAggroTarget(this.combatTarget)) {
            return this.combatTarget;
        }

        return null;
    }

    switchCombatTarget(actor) {
        if (!this.isValidAggroTarget(actor)) return false;
        const previousTargetId = Number(this.fetchDestId?.() || 0);
        this.combatTarget = actor;
        this.setDestId(actor.fetchId());
        if (previousTargetId !== Number(actor.fetchId())) {
            const World = invoke('GameServer/World/World');
            if (World.npc) {
                World.npc.threatRevision = Number(World.npc.threatRevision || 0) + 1;
            }
        }
        return true;
    }

    getHating(actor) {
        const actorId = Number(actor?.fetchId?.());
        return this.aggroList.get(actorId)?.hate || 0;
    }

    reduceAggro(session, actor, amount) {
        const reduction = Math.max(0, Number(amount) || 0);
        if (reduction <= 0) return false;

        const entries = actor
            ? [this.aggroList.get(Number(actor.fetchId?.()))].filter(Boolean)
            : [...this.aggroList.values()];
        entries.forEach((entry) => {
            entry.hate = Math.max(0, entry.hate - reduction);
        });

        return this.retargetAfterAggroChange(session);
    }

    // The mob turns to the next hated actor, or leaves combat when none is left.
    // cause names a dropped chase for the npcHate status counter.
    removeAggroTarget(session, actor, cause = null) {
        const actorId = Number(actor?.fetchId?.());
        if (!actorId) return false;
        if (this.confusionTarget === actor) delete this.confusionTarget;
        this.aggroList.delete(actorId);
        if (cause) hateStats[cause] += 1;
        return this.retargetAfterAggroChange(session);
    }

    retargetAfterAggroChange(session) {
        const target = this.fetchMostHated();
        if (target) {
            if (!this.state.fetchCombats()) {
                this.enterCombatState(session, target, { skipAggro: true });
            }
            else {
                this.switchCombatTarget(target);
            }
            return true;
        }

        if (this.state.fetchCombats()) this.abortCombatState(session);
        return false;
    }

    clearAggroList() {
        this.aggroList.clear();
        this.combatTarget = undefined;
        invoke('GameServer/Bot/AI/BotMobCompetition').reset(this);
    }

    enterCombatState(session, actor, options = {}) {
        if (!this.canEngageCombat()) return false;
        if (!this.isValidAggroTarget(actor)) return false;

        if (!options.skipAggro) {
            const entry = this.ensureAggroEntry(actor);
            if (entry && entry.hate <= 0) entry.hate = NpcHate.ENGAGE_HATE;
        }

        const target = this.fetchMostHated() || actor;
        if (this.state.fetchCombats()) {
            this.switchCombatTarget(target);
            return true;
        }

        invoke('GameServer/Npc/NpcWander').cancel(this, session);
        this.switchCombatTarget(target);
        this.state.setCombats(true);

        this.setStateRun(true);
        this.setStateAttack(true);
        session.dataSendToMeAndOthers(ServerResponse.walkAndRun(this.fetchId(), this.fetchStateRun()), this);
        session.dataSendToMeAndOthers(ServerResponse.autoAttackStart(this.fetchId()), this);

        this.timer.combatStart = setTimeout(() => {
            this.timer.combatStart = undefined;
            const initialTarget = this.fetchCombatTarget();
            if (!this.state.fetchCombats() || !initialTarget) {
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
            let activeTarget = initialTarget;

            this.timer.combat = setInterval(() => {
                const actor = this.fetchCombatTarget();
                if (!actor) {
                    this.abortCombatState(session);
                    return;
                }

                if (actor !== activeTarget) {
                    activeTarget = actor;
                    pathGeneration++;
                    pendingPath = null;
                    activeMoveCoords = null;
                    activePathWaypoints = [];
                    activePathTargetCoords = null;
                    pathFailureStartedAt = 0;
                    pathFailureCount = 0;
                    nextPathRetryAt = 0;
                    this.automation.abortAll(this);
                }

                // A dead target cannot be chased or hit.  Leaving the NPC in
                // combat here pins its target to the corpse indefinitely and
                // makes party resurrection believe the fight never ended.
                if (actor?.isDead?.() || actor?.state?.fetchDead?.() || actor?.fakeDeath) {
                    this.abortCombatState(session);
                    return;
                }

                if (new SpeckMath.Point(this.fetchLocX(), this.fetchLocY()).distance(new SpeckMath.Point(actor.fetchLocX(), actor.fetchLocY())) >= 1500) {
                    // Lisvus forgets a hated actor that left its known list (3000,
                    // AttackableKnownList); this chase stops at 1500, so it forgets then.
                    this.removeAggroTarget(session, actor, 'outOfReach');
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
                        // Automation tracks actual progress continuously and
                        // synchronizes the final partial tick when cancelling.
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

                // ConfuseMob orders a physical attack; NPC spell damage must
                // not enter the caster's player reward/quest pipeline.
                const combatSkill = this.isConfusionTarget(actor) ? null : this.selectCombatSkill(actor);
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
                                            // Lisvus stops hating an actor it could not hit for
                                            // its attack timeout (L2AttackableAI.thinkAttack).
                                            this.removeAggroTarget(session, actor, 'noPath');
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
                    if (this.fetchCombatTarget() !== actor) {
                        return;
                    }
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

    // C4/Lisvus calculates an attackable NPC's reward from MAX_HP. Permanent
    // Strong Type skills therefore scale both the effective HP and the full
    // XP/SP reward. Damage and party sharing apply their proportional split
    // after this total reward has been calculated.
    fetchRewardMaxHpMultiplier() {
        return EffectStats.multiplier(this, 'maxHpMul');
    }

    fetchAcquiredExp() {
        return super.fetchAcquiredExp() * this.fetchRewardMaxHpMultiplier();
    }

    fetchRewardSp() {
        return super.fetchRewardSp() * this.fetchRewardMaxHpMultiplier();
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

    fetchAiType() {
        // Most imported C4 templates do not carry the source AI enum
        // (NpcCombatChoice.aiTypeFor reads it from skills and attack radius).
        return NpcCombatChoice.aiTypeFor(super.fetchAiType(), this.fetchCombatSkills(), this.fetchAtkRadius());
    }

    fetchSkillCastRange(skill, actor) {
        return Math.max(
            0,
            Number(skill?.fetchDistance?.()) || 0,
            Number(actor?.fetchRadius?.()) || 0
        );
    }

    selectCombatSkill(actor, rng = Math.random) {
        if (!this.fetchCombatSkills().length || !EffectRestrictions.canCast(this)) return null;
        const now = Date.now();
        const picked = NpcCombatChoice.select({
            skills: this.fetchCombatSkills(),
            usable: (skill) => this.fetchMp() >= skill.fetchConsumedMp() && this.canUseSkill(skill),
            buffNeeded: (skill) => {
                const semantic = skill.fetchSemantic?.() || {};
                if (skill.fetchSkillType?.() === 'hot') {
                    const targets = this.attack.resolveSkillTargets(null,this,this,skill);
                    if (!targets.some(target => Number(target.fetchHp?.()) < Number(target.fetchMaxHp?.()))) return false;
                }
                return !EffectStore.list(this).some((effect) => (
                    Number(effect.id) === Number(skill.fetchSelfId()) || effect.key === semantic.effect
                    || semantic.stackFamily && effect.stackFamily === semantic.stackFamily
                        && Number(effect.stackOrder || 0) >= Number(semantic.stackOrder || 0)
                ));
            },
            hasTarget: !!actor,
            impairments: actor ? EffectStore.impairments(actor) : {},
            aiType: this.fetchAiType(),
            targetAiType: actor?.fetchAiType?.() || 'fighter',
            debuffReady: now - this.lastDebuffAt >= NpcCombatChoice.DEBUFF_GAP_MS,
            rng
        });
        if (picked?.category === 'debuff') this.lastDebuffAt = now;
        return picked?.skill || null;
    }

    canUseCombatSkillOn(actor, skill) {
        if (!actor || actor === this) return true;
        const impairments = EffectStore.impairments(actor);
        switch (NpcCombatChoice.category(skill)) {
            case 'hard_control':
            case 'sleep':
                return !impairments.disabled;
            case 'root':
                return !impairments.rooted;
            case 'mute':
                return !impairments.silenced;
            default:
                return true;
        }
    }

    canUseSkill(skill, now = Date.now()) {
        return (this.skillReuseUntil.get(skill.fetchSelfId()) || 0) <= now;
    }

    markSkillReuse(skill, now = Date.now()) {
        this.skillReuseUntil.set(
            skill.fetchSelfId(),
            now + NpcCombatChoice.reuseMs(skill)
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
        if (!this.canUseCombatSkillOn(actor, skill)) return;
        if (actor !== this && !this.hasCombatLineOfSight(actor)) return;
        this.attack.remoteHit({
            actor: this,
            dataSendToMe: (packet) => session.dataSendToMe?.(packet),
            dataSendToMeAndOthers: (packet) => session.dataSendToMeAndOthers(packet, this)
        }, actor, skill);
    }

    abortCombatState(session, { preserveAggro = false } = {}) {
        delete this.confusionTarget;
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

        const previousTargetId = Number(this.fetchDestId?.() || 0);
        this.clearDestId();
        if (previousTargetId) {
            const World = invoke('GameServer/World/World');
            if (World.npc) {
                World.npc.threatRevision = Number(World.npc.threatRevision || 0) + 1;
            }
        }
        if (!preserveAggro) this.clearAggroList();
        else if (this.aggroList.size > 0) hateStats.idleWithHate += 1;
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

        const rangedAttack = AttackRange.weaponKind(src) === 'Weapon.Bow';
        const attackSpeed = src.fetchCollectiveAtkSpd();
        const timing = Formulas.attackTimes(attackSpeed, { bow: rangedAttack });
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

        }, timing.drawMs);

        clearTimeout(this.timer.hitEnd);
        this.timer.hitEnd = setTimeout(() => {
            this.timer.hitEnd = undefined;
            this.state.setHits(false);

        }, timing.cycleMs); // Until end of combat move or bow reload
    }

    checkParticipants(session, src, dst) {
        if (src.state.fetchDead() || dst.state.fetchDead()) {
            const replacement = this.fetchMostHated();
            if (replacement && replacement !== dst) {
                this.switchCombatTarget(replacement);
                return true;
            }
            this.abortCombatState(session);
            return true;
        }
        return false;
    }

    hit(session, actor, hit) {
        ConsoleText.transmit(session, ConsoleText.caption.monsterHit, [
            { kind: ConsoleText.kind.npc, value: this.fetchDispSelfId() }, { kind: ConsoleText.kind.number, value: hit }
        ]);

        if (this.isConfusionTarget(actor) && typeof actor.fetchKind === 'function'
            && actor.fetchIsSummon?.() !== true) {
            EffectRestrictions.wakeOnDamage(actor);
            actor.setHp(Math.max(actor.fetchIsKillable?.() === false ? 1 : 0, actor.fetchHp() - hit));
            actor.broadcastVitals?.();
            if (actor.fetchHp() <= 0) {
                // The original caster's session is only a packet transport.
                // A monster kill must not credit that player with XP/quests.
                invoke(path.npc).die({
                    dataSendToMeAndOthers: (packet, source) => session.dataSendToMeAndOthers(packet, source)
                }, this, actor);
            }
            return;
        }

        if (actor?.fetchIsSummon?.() === true) {
            actor.setHp(Math.max(0, actor.fetchHp() - hit));
            actor.broadcastVitals?.();
            if (actor.fetchHp() <= 0) {
                invoke(path.npc).die(session, this, actor);
            }
            return;
        }

        // Npc combat must only hand off player/bot actors to the actor damage
        // pipeline. A stale or cross-NPC aggro entry used to fall through to
        // Actor/Generics/ReceivedHit, whose lethal PvP bookkeeping expects
        // fetchPvpFlag/fetchKarma and crashed the whole game process.
        if (
            typeof actor?.fetchPvpFlag !== 'function'
            || typeof actor?.fetchKarma !== 'function'
            || typeof actor?.setPvpFlag !== 'function'
        ) {
            this.removeAggroTarget(session, actor);
            return;
        }

        if (actor?.session) {
            actor.session.incomingThreatId = this.fetchId();
            actor.session.incomingThreatAt = Date.now();
        }
        invoke(path.actor).receivedHit(session, actor, hit, { source: this });
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

    addAbsorber(actor, crystalItemId) {
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
            crystalItemId,
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
