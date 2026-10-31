const ItemTemplateIndex = require('../Item/ItemTemplateIndex');
const ServerResponse = invoke('GameServer/Network/Response');
const ConsoleText    = invoke('GameServer/ConsoleText');
const Formulas       = invoke('GameServer/Formulas');
const DataCache      = invoke('GameServer/DataCache');
const SkillEffects   = invoke('GameServer/Skills/C4SkillEffects');
const C4SkillRules   = invoke('GameServer/Skills/C4SkillRules');
const HitRules       = invoke('GameServer/Combat/HitRules');
const CombatantView  = invoke('GameServer/Combat/CombatantView');
const EffectStats    = invoke('GameServer/Effects/EffectStats');
const EffectStore    = invoke('GameServer/Effects/EffectStore');
const C4EquipmentItemSkills = invoke('GameServer/Items/C4EquipmentItemSkills');
const WeaponSA = invoke('GameServer/Items/C4WeaponSA');
const ShotStock = invoke('GameServer/Inventory/ShotStock');
const RaidCurse = invoke('GameServer/RaidBoss/RaidCurse');
const ChargeLifecycle = invoke('GameServer/Skills/ChargeLifecycle');
const AttackRange = invoke('GameServer/Actor/AttackRange');
const HotPartyCastTracker = invoke('GameServer/Bot/AI/HotPartyCastTracker');

const { weaponMaskFor } = invoke('GameServer/Skills/WeaponMask');

class Attack {
    constructor() {
        this.timers = new Set();
        this.bowReloading = false;
        this.repeatTarget = null;
        this.resetQueuedEvent();
    }

    destructor() {
        HotPartyCastTracker.clear(this.activePartyCast?.actor);
        this.clearTimers();
        this.resetQueuedEvent();
    }

    // Queue mechanism

    queueEvent(name, data) {
        this.queue.name = name;
        this.queue.data = data;
    }

    dequeueEvent(session) {
        const Generics = invoke(path.actor);

        let actor = session.actor;
        let queue = this.queue;
        actor.state.setHits(false);

        switch (queue.name) {
            case 'move'   : Generics.moveTo       (session, actor, queue.data); break;
            case 'attack' : Generics.attackRequest(session, actor, queue.data); break;
            case 'skill'  : Generics.skillRequest (session, actor, queue.data); break;
            case 'pickup' : Generics.pickupRequest(session, actor, queue.data); break;
            case 'sit'    : Generics.basicAction  (session, actor, queue.data); break;
        }
        this.resetQueuedEvent();
    }

    resetQueuedEvent() {
        this.queue = { name: undefined, data: undefined };
    }

    queueTimer(callback, delay) {
        const timer = setTimeout(() => {
            this.timers.delete(timer);
            callback();
        }, delay);
        this.timers.add(timer);
        return timer;
    }

    clearTimers() {
        this.activeCast = null;
        this.timers.forEach((timer) => clearTimeout(timer));
        this.timers.clear();
        this.bowReloading = false;
        this.repeatTarget = null;
    }

    abortCast(session, actor) {
        HotPartyCastTracker.clear(actor);
        if (!actor?.state?.fetchCasts?.()) {
            return false;
        }

        this.clearTimers();
        this.resetQueuedEvent();
        actor.state.setCasts(false);
        // clearTimers also cancels a weapon swing that overlapped this cast.
        // Its completion callback can no longer release the movement blocker.
        actor.state.setHits(false);
        actor.storedSpell = undefined;
        invoke('GameServer/Bot/AI/BotSupportPlanner').cancelSupportCast(session, actor);

        session?.dataSendToMeAndOthers?.(
            ServerResponse.magicSkillCanceld(actor.fetchId()),
            actor
        );
        session?.dataSendToMe?.(ServerResponse.actionFailed());
        return true;
    }

    meleeHit(session, creature) {
        if (session?.pvpHandoffPending) return;
        const actor = session.actor;
        const raidParty = invoke('GameServer/Clan/ClanRaidRoster').offensiveParty(session);

        // A swing is already in flight: its end timer owns the next swing and
        // takes the latest requested target. Repeated target clicks handled in
        // one network chunk would otherwise start a second loop that a ground
        // click cannot stop.
        if (actor.state.fetchHits?.()) {
            this.repeatTarget = creature;
            return;
        }
        if (this.blockedPvpDefense(session, actor, creature) || this.checkParticipants(actor, creature)) {
            return;
        }

        const attackRange = AttackRange.fetchNormalAttackRange(actor);
        const rangedAttack = AttackRange.weaponKind(actor) === 'Weapon.Bow';
        if (rangedAttack && this.bowReloading) {
            // Movement and other actions are legal after the arrow is released,
            // but another arrow must still wait for the weapon reuse phase.
            this.repeatTarget = creature;
            return;
        }
        if (!AttackRange.isWithinRange(actor, creature, attackRange)
            || invoke('GameServer/Automation').needsGeodataApproach(session, actor, creature)) {
            actor.state.setHits(false);
            // Auto-attacks and chase arrivals both return here. The target
            // may have moved since the initial attack request or last swing.
            actor.automation.scheduleAction(session, actor, creature, attackRange,
                () => this.meleeHit(session, creature), { collisionAware: true, action: 'attack' });
            return;
        }
        if (rangedAttack && !invoke('GameServer/Actor/BowResources').consume(session, actor)) return;

        // Soulshots are only reloaded after the player enables their hotbar toggle.
        const autoSoulshotId = actor.backpack?.fetchAutoShot?.(actor, 'soulshot');
        if (!actor.soulshotLoaded && (autoSoulshotId || actor.backpack?.isAutoShotEnabled?.(actor, 'soulshot')) && typeof actor.backpack.consumeSoulshot === 'function') {
            actor.backpack.consumeSoulshot(session, (success) => {
                if (success) {
                    actor.soulshotLoaded = true;
                    
                    // Play activation effect (Skill 2039)
                    session.dataSendToMeAndOthers(
                        ServerResponse.skillStarted(actor, actor.fetchId(), {
                            fetchSelfId: () => 2039,
                            fetchCalculatedHitTime: () => 0,
                            fetchReuseTime: () => 0
                        }), 
                        actor
                    );
                }
            }, autoSoulshotId);
        }

        const attackSpeed = actor.fetchCollectiveAtkSpd();
        const weapon = actor.backpack?.fetchEquippedWeapon?.();
        const timing = Formulas.attackTimes(attackSpeed, { bow: rangedAttack,
            reuseDelay: weapon?.fetchAttackReuseDelay?.() ?? 1500,
            // Only a bow's cycle reads its reuse (Formulas.attackTimes).
            reuseMul: rangedAttack ? EffectStats.multiplier(actor, 'atkReuseMul') : 1 });
        const movementGeneration = Number(session.moveRouteGeneration || 0);
        this.repeatTarget = null;
        if (rangedAttack) this.bowReloading = true;
        const attackWeapon = WeaponSA.equipped(actor);
        let secondaryDamageMultiplier = 0.85;
        const hits = this.resolveMeleeTargets(actor, creature).map((target, index) => {
            const hitLanded = Formulas.calcHitChance(actor, target, Math.random, this.positionContext(actor, target));
            const usedSoulshot = hitLanded && !!actor.soulshotLoaded;
            const hit = this.prepareMeleeHit(actor, target, hitLanded, usedSoulshot);

            if (index > 0) {
                if (hitLanded) hit.damage = Math.max(0, Math.floor(hit.damage * secondaryDamageMultiplier));
                secondaryDamageMultiplier /= 1.15;
            }

            return { target, hitLanded, usedSoulshot, hit };
        });
        const primary = hits[0];
        const usedSoulshot = hits.some((entry) => entry.usedSoulshot);
        hits.forEach(({ target }) => invoke('GameServer/Bot/AI/BotMobCompetition').record(actor, target));

        if (rangedAttack && !session.botSession) {
            ConsoleText.transmit(session, ConsoleText.caption.shootArrow);
            session.dataSendToMe(ServerResponse.skillDurationBar(Math.round(timing.cycleMs)));
        }

        session.dataSendToMeAndOthers(ServerResponse.attack(actor, creature.fetchId(), {
            ...primary.hit,
            additionalHits: hits.slice(1).map((entry) => ({
                targetId: entry.target.fetchId(),
                ...entry.hit
            }))
        }), actor);
        actor.state.setHits(true);

        this.queueTimer(() => {
            const releaseBowMovement = () => {
                if (!rangedAttack) return;
                actor.state.setHits(false);
                if (this.queue.name) this.dequeueEvent(session);
            };

            // Losing the old victim must not erase an explicit ground click.
            // Melee keeps it until swing end; bows can move after release.
            if (this.queue.name === 'move' && !actor.state.fetchDead() && creature.state.fetchDead()) {
                releaseBowMovement();
                return;
            }

            if (this.blockedPvpDefense(session, actor, creature) || this.checkParticipants(actor, creature)) {
                releaseBowMovement();
                return;
            }

            if (RaidCurse.normalAttackBlocked(session, actor, creature)) {
                if (usedSoulshot) {
                    actor.soulshotLoaded = false;
                }
                releaseBowMovement();
                return;
            }

            if (usedSoulshot) actor.soulshotLoaded = false;

            hits.forEach((entry, index) => {
                const target = entry.target;
                if (index > 0 && RaidCurse.normalAttackBlocked(session, actor, target)) return;
                if (target?.state?.fetchDead?.() || target?.isDead?.()) return;
                // Check every melee victim again at impact, including polearm
                // secondary targets. Already-launched arrows keep travelling.
                if (!rangedAttack && !AttackRange.isWithinRange(actor, target, attackRange)) return;
                if (!invoke('GameServer/Clan/ClanRaidRoster').beforeOffensiveEffect(session, actor, target, raidParty)) return;

                if (!entry.hitLanded || entry.hit.damage <= 0) this.recordPlayerAggression(session, actor, target);
                if (entry.hitLanded) {
                    const beforeHp = Number(target.fetchHp?.()) || 0;
                    this.hit(session, actor, target, entry.hit.damage);
                    const hpDamage = Math.max(0, beforeHp - (Number(target.fetchHp?.()) || 0));
                    this.applyDamageAbsorb(session, actor, hpDamage);
                    if (entry.hit.flags & ServerResponse.attack.HITFLAG_CRIT) {
                        WeaponSA.onCritical(session, actor, target, { weapon: attackWeapon, damage: entry.hit.damage,
                            hpDamage, anger: entry.hit.anger, attack: this });
                    }
                }
                else if (index === 0) {
                    ConsoleText.transmit(session, ConsoleText.caption.missedHit);
                }
            });

            releaseBowMovement();

        }, timing.drawMs); // Until hit point

        this.queueTimer(() => {
            const repeatTarget = this.repeatTarget;
            const nextTarget = repeatTarget || creature;
            this.repeatTarget = null;
            if (rangedAttack) this.bowReloading = false;
            // A completed bow release may already have handed control to a
            // newer movement. Do not let the old victim's death abort it.
            if (rangedAttack && !repeatTarget && !this.queue.name
                && Number(session.moveRouteGeneration || 0) !== movementGeneration) return;
            if (this.blockedPvpDefense(session, actor, nextTarget)
                || this.checkParticipants(actor, nextTarget, { allowDeadTarget: this.queue.name === 'move' })) {
                return;
            }

            actor.state.setHits(false);
            if (invoke('GameServer/Bot/AI/PartyCompanionService').startQueuedGroundPickup(session)) {
                return;
            }

            if (this.queue.name) {
                this.dequeueEvent(session);
                return;
            }

            if (repeatTarget) {
                this.meleeHit(session, nextTarget);
                return;
            }

            if (rangedAttack && (
                actor.state.inMotion?.()
                || actor.isBlocked?.()
            )) return;

            this.meleeHit(session, creature);

        }, timing.cycleMs); // Until end of combat move or bow reload
    }

    remoteHit(session, creature, skill) {
        if (session?.pvpHandoffPending) return;
        const actor = session.actor;
        const raidParty = invoke('GameServer/Clan/ClanRaidRoster').offensiveParty(session);
        const corpseTarget = ['corpse_mob', 'corpse_player', 'corpse_pet', 'corpse_ally']
            .includes(skill.fetchTargetKind?.());

        if (this.blockedPvpDefense(session, actor, creature, skill) || this.checkParticipants(actor, creature, { allowDeadTarget: corpseTarget })) {
            invoke('GameServer/Bot/AI/BotActionFeedback').record(session, actor, creature, skill, 'rejected', 'invalid_target');
            invoke('GameServer/Bot/AI/BotSupportPlanner').cancelPendingSupportCast(session, actor, creature, skill, 'invalid_target');
            invoke('GameServer/Bot/AI/BotPartyChat').cancelExpectedSkillResult(session, actor, creature, skill);
            return;
        }

        if (actor.canUseSkill?.(skill) === false) {
            invoke('GameServer/Bot/AI/BotActionFeedback').record(session, actor, creature, skill, 'rejected', 'reuse');
            session.dataSendToMe?.(ServerResponse.actionFailed());
            invoke('GameServer/Bot/AI/BotSupportPlanner').cancelPendingSupportCast(session, actor, creature, skill, 'reuse');
            invoke('GameServer/Bot/AI/BotPartyChat').cancelExpectedSkillResult(session, actor, creature, skill);
            return;
        }

        const mpCost = this.skillMpCost(actor, skill);
        if (actor.fetchMp() < mpCost) {
            invoke('GameServer/Bot/AI/BotActionFeedback').record(session, actor, creature, skill, 'rejected', 'depleted_mp');
            ConsoleText.transmit(session, ConsoleText.caption.depletedMp);
            invoke('GameServer/Bot/AI/BotSupportPlanner').cancelPendingSupportCast(session, actor, creature, skill, 'depleted_mp');
            invoke('GameServer/Bot/AI/BotPartyChat').cancelExpectedSkillResult(session, actor, creature, skill);
            return;
        }

        const conditionFailure = this.skillUseConditionFailure(session, actor, skill);
        if (conditionFailure) {
            invoke('GameServer/Bot/AI/BotActionFeedback').record(session, actor, creature, skill, 'rejected', conditionFailure.code || conditionFailure.reason || 'condition');
            this.rejectSkillUseCondition(session, actor, conditionFailure);
            invoke('GameServer/Bot/AI/BotSupportPlanner').cancelPendingSupportCast(session, actor, creature, skill, conditionFailure.code || conditionFailure.reason || 'condition');
            invoke('GameServer/Bot/AI/BotPartyChat').cancelExpectedSkillResult(session, actor, creature, skill);
            return;
        }

        const magicSkill = this.beginRemoteCast(session, actor, creature, skill);

        const castWeapon = WeaponSA.equipped(actor);
        const castTime = skill.fetchCalculatedHitTime();
        // Lisvus C4 launches the client animation 400 ms before impact for
        // casts longer than its 420 ms gauge threshold. Keep short/static
        // casts at their existing duration, without negative timer delays.
        const launchLead = magicSkill && castTime > 420 ? 400 : 0;
        const recoveryMs = !actor.fetchKind && skill.fetchSemantic?.()?.nextActionAttack
            ? this.calculatedSkillCoolTime(actor, skill, magicSkill) : 0;
        const cast = { raidParty, corpseTarget, mpCost, magicSkill, launchLead, castWeapon, recoveryMs };
        const land = () => this.landRemoteCast(session, actor, creature, skill, cast);

        if (launchLead) {
            this.queueTimer(() => this.launchRemoteCast(session, actor, creature, skill, corpseTarget),
                castTime - launchLead);
        }
        // Schedule from the same start time: a delayed launch callback must
        // not shift impact past the original deadline or a pet's follow timer.
        // Cancellation clears both native timers, and casting stays active.
        this.queueTimer(land, castTime);

    }

    beginRemoteCast(session, actor, creature, skill) {
        const magicSkill = this.isMagicSkill(skill);
        this.chargeShotForSkill(session, actor, magicSkill, skill);

        skill.setCalculatedHitTime(this.calculatedSkillHitTime(actor, skill, magicSkill));
        // Companion support selection runs before a native cast is accepted.
        // Only create its reservation at this point, after every rejection
        // gate above has passed and the cast is about to begin. The calculated
        // hit time is available here, so the reservation covers the full cast.
        invoke('GameServer/Bot/AI/BotSupportPlanner').beginSupportCast(session, actor, creature, skill);
        actor.markSkillReuse?.(skill);
        if (skill.fetchTargetKind?.() === 'enemy') invoke('GameServer/Bot/AI/BotMobCompetition').record(actor, creature);
        session.dataSendToMeAndOthers(ServerResponse.skillStarted(actor, creature.fetchId(), skill), actor);
        session.dataSendToMe(ServerResponse.skillDurationBar(skill.fetchCalculatedHitTime()));
        actor.state.setCasts(true);
        invoke('GameServer/Bot/AI/BotActionFeedback').record(session, actor, creature, skill, 'accepted', 'native_cast');
        // Tactical readers need the accepted cast, not skill availability:
        // reuse starts above, before this cast has dealt any damage.
        this.activeCast = { target: creature, skill, landsAt: Date.now() + skill.fetchCalculatedHitTime() };
        HotPartyCastTracker.begin(session, actor, creature, skill);
        return magicSkill;
    }

    launchRemoteCast(session, actor, creature, skill, corpseTarget) {
        if (this.blockedPvpDefense(session, actor, creature, skill)
            || this.checkParticipants(actor, creature, { allowDeadTarget: corpseTarget })) {
            this.clearTimers();
            HotPartyCastTracker.clear(actor);
            invoke('GameServer/Bot/AI/BotSupportPlanner').cancelSupportCast(session, actor);
            invoke('GameServer/Bot/AI/BotPartyChat').cancelExpectedSkillResult(session, actor, creature, skill);
            return;
        }
        const targets = this.resolveSkillTargets(session, actor, creature, skill);
        const semantic = skill.fetchSemantic?.() || {};
        const animationTargets = !targets.length && semantic.sourceTarget === 'aura' && semantic.selfEffect
            ? [actor] : targets;
        if (animationTargets.length) {
            session.dataSendToMeAndOthers(ServerResponse.magicSkillLaunched(actor, skill, animationTargets), actor);
        }
    }

    landRemoteCast(session, actor, creature, skill, { raidParty, corpseTarget, mpCost, magicSkill, launchLead, castWeapon, recoveryMs = 0 }) {
        this.activeCast = null;
        // Once the landing callback owns the turn, no other damage event
        // can interleave before MP and effects resolve. Stop watching the
        // target before the authoritative cast work begins.
        HotPartyCastTracker.clear(actor);
        if (this.blockedPvpDefense(session, actor, creature, skill) || this.checkParticipants(actor, creature, { allowDeadTarget: corpseTarget })) {
            invoke('GameServer/Bot/AI/BotSupportPlanner').cancelSupportCast(session, actor);
            invoke('GameServer/Bot/AI/BotPartyChat').cancelExpectedSkillResult(session, actor, creature, skill);
            return;
        }

        const { corpseAreaCast, selfEffectOnly, executionTargets, emptyEnemyAuraCast } = this.remoteCastTargets(session, actor, creature, skill);

        if (executionTargets.length === 0 && !emptyEnemyAuraCast && !corpseAreaCast) {
            actor.state.setCasts(false);
            invoke('GameServer/Bot/AI/BotSupportPlanner').cancelSupportCast(session, actor);
            invoke('GameServer/Bot/AI/BotPartyChat').cancelExpectedSkillResult(session, actor, creature, skill);
            return;
        }

        if (!this.consumeSkillItems(session, actor, skill)) {
            actor.state.setCasts(false);
            this.rejectSkillUseCondition(session, actor, 'Not enough required items.');
            invoke('GameServer/Bot/AI/BotSupportPlanner').cancelSupportCast(session, actor);
            invoke('GameServer/Bot/AI/BotPartyChat').cancelExpectedSkillResult(session, actor, creature, skill);
            return;
        }

        const openingPayment = raidParty ? { hp: actor.fetchHp(), mp: actor.fetchMp() } : null;
        this.payRemoteCast(session, actor, skill, { magicSkill, launchLead, executionTargets, mpCost });
        if (openingPayment) {
            openingPayment.hp -= actor.fetchHp();
            openingPayment.mp -= actor.fetchMp();
        }

        const shotState = this.captureShotState(actor);
        if (!selfEffectOnly && executionTargets.length > 0 && RaidCurse.skillBlocked(session, actor, executionTargets, skill)) {
            this.abandonCursedRemoteCast(session, actor, creature, skill, magicSkill);
            return;
        }

        // A sonic/force charge belongs to the cast, not to each target of
        // an area skill. Consume it once after the cast has survived all
        // cancellation gates and immediately before authoritative effects.
        if (!this.consumeSkillCharges(session, actor, skill)) {
            actor.state.setCasts(false);
            this.rejectSkillUseCondition(session, actor, 'Not enough charges.');
            invoke('GameServer/Bot/AI/BotSupportPlanner').cancelSupportCast(session, actor);
            invoke('GameServer/Bot/AI/BotPartyChat').cancelExpectedSkillResult(session, actor, creature, skill);
            return;
        }

        if (corpseAreaCast) {
            invoke('GameServer/World/Generics/NpcDecay').decay(invoke('GameServer/World/World'), creature);
        }
        executionTargets.forEach((target) => this.applyRemoteCastEffect(session, actor, target, skill,
            { corpseAreaCast, raidParty, shotState, magicSkill, selfEffectOnly, castWeapon, openingPayment }));
        const finish = () => this.finishRemoteCast(session, actor, skill, magicSkill, creature);
        // Keep the action slot until the C4 recovery ends. Requests arriving
        // after impact still queue ahead of the automatic weapon attack.
        if (recoveryMs > 0) this.queueTimer(finish, recoveryMs);
        else finish();
    }

    remoteCastTargets(session, actor, creature, skill) {
        const semantic = skill.fetchSemantic?.() || {};
        const targets = this.resolveSkillTargets(session, actor, creature, skill);
        const corpseAreaCast = skill.fetchTargetKind?.() === 'corpse_mob'
            && semantic.sourceTarget === 'area' && semantic.skillType === C4SkillRules.DAMAGE;
        const selfEffectOnly = targets.length === 0
            && semantic.sourceTarget === 'aura'
            && !!semantic.selfEffect;
        const emptyEnemyAuraCast = targets.length === 0
            && semantic.sourceTarget === 'aura'
            && skill.fetchTargetKind?.() === 'enemy'
            && !semantic.selfEffect;
        const executionTargets = selfEffectOnly ? [actor] : targets;
        return { corpseAreaCast, selfEffectOnly, executionTargets, emptyEnemyAuraCast };
    }

    payRemoteCast(session, actor, skill, { magicSkill, launchLead, executionTargets, mpCost }) {
        if (magicSkill && !launchLead && executionTargets.length > 0) {
            session.dataSendToMeAndOthers(ServerResponse.magicSkillLaunched(actor, skill, executionTargets), actor);
        }

        actor.setMp(actor.fetchMp() - mpCost);
        if (skill.fetchConsumedHp() > 0) {
            actor.setHp(Math.max(1, actor.fetchHp() - skill.fetchConsumedHp()));
        }
        actor.statusUpdateVitals(actor);
    }

    abandonCursedRemoteCast(session, actor, creature, skill, magicSkill) {
        this.clearLoadedShot(actor, magicSkill);
        actor.state.setCasts(false);
        invoke('GameServer/Bot/AI/BotSupportPlanner').finishSupportCast(session, actor, skill);
        invoke('GameServer/Bot/AI/BotPartyChat').cancelExpectedSkillResult(session, actor, creature, skill);

        actor.automation.replenishVitals(actor);
        if (invoke('GameServer/Bot/AI/PartyCompanionService').startQueuedGroundPickup(session)) {
            return;
        }
        if (this.queue.name) {
            this.dequeueEvent(session);
            return;
        }
        return;
    }

    applyRemoteCastEffect(session, actor, target, skill, { corpseAreaCast, raidParty, shotState, magicSkill, selfEffectOnly, castWeapon, openingPayment }) {
        if ((skill.fetchTargetKind?.() === 'enemy' || corpseAreaCast)
            && !invoke('GameServer/Clan/ClanRaidRoster').beforeOffensiveEffect(session, actor, target, raidParty, openingPayment)) return;
        if (skill.fetchTargetKind?.() === 'enemy') invoke('GameServer/Bot/AI/BotMobCompetition').record(actor, target);
        this.restoreShotState(actor, shotState);
        const outcome = SkillEffects.execute(session, actor, target, skill, {
            attack: this,
            magicSkill,
            selfEffectOnly,
            chargeCount: actor.activeSkillChargeCount
        });
        // A hostile control/debuff is aggression even without HP
        // damage (and even if resisted). Use the same flag and party
        // wake path as a hit, after native target/cast validation.
        if (!(outcome.damage > 0) && skill.fetchTargetKind?.() === 'enemy') this.recordPlayerAggression(session, actor, target);
        // Chat confirmations are emitted only after the authoritative
        // skill result exists. A queued, interrupted, resisted, or
        // stack-rejected cast must never claim success to the party.
        invoke('GameServer/Bot/AI/BotPartyChat').confirmSkillResult(session, actor, target, skill, outcome);
        invoke('GameServer/Bot/AI/BotActionFeedback').result(session, actor, target, skill, outcome);
        if (outcome?.applied && session?.accountId?.startsWith?.('bot_') && target?.session?.accountId && !target.session.accountId.startsWith('bot_')) {
            Promise.resolve(invoke('GameServer/Bot/AI/BotEventJournal').record({
                playerId: target.session.actor?.fetchId?.(),
                botId: actor.fetchId?.(),
                eventType: 'support_result',
                summary: `${actor.fetchName?.() || 'Bot'} successfully used ${skill.model?.name || 'a support skill'} on ${target.fetchName?.() || 'the player'}.`,
                weight: 3,
                dedupeKey: `support:${actor.fetchId?.()}:${target.fetchId?.()}:${skill.fetchSelfId?.()}`,
                coalesceWindowMs: 5000,
                meta: { skillId: skill.fetchSelfId?.(), outcome: outcome.type || null }
            })).catch(() => {});
        }

        if (outcome.damage > 0) {
            this.hit(session, actor, target, outcome.damage, { skill });
            if (outcome.forceLethalVitals && target.fetchHp?.() > 0) {
                target.setHp?.(1);
                target.setCp?.(1);
                target.statusUpdateVitals?.(target);
            }
        }
        else if (outcome.missed) {
            ConsoleText.transmit(session, ConsoleText.caption.missedHit);
        }
        else if (outcome.resisted) {
            const targetSession = target?.session || (this.isNpcCombatant(actor) ? session : null);
            if (targetSession?.dataSendToMe) {
                ConsoleText.transmit(targetSession, ConsoleText.caption.magicResisted, [{
                    kind: ConsoleText.kind.text,
                    value: actor.fetchName?.() || 'The monster'
                }]);
            }
        }
        if (!selfEffectOnly) WeaponSA.onCast(session, actor, target, skill, { weapon: castWeapon, outcome, attack: this });
        if (outcome.spoilOnHit) {
            outcome.spoiled = invoke('GameServer/Npc/SpoilSweep').trySpoilCrush(session, actor, target, skill);
        }
    }

    finishRemoteCast(session, actor, skill, magicSkill, target = null) {
        delete actor.activeSkillChargeCount;
        this.clearLoadedShot(actor, magicSkill);
        actor.state.setCasts(false);
        invoke('GameServer/Bot/AI/BotSupportPlanner').finishSupportCast(session, actor, skill);

        actor.automation.replenishVitals(actor);
        this.finishSkillAction(session, actor, skill, target);
    }

    finishSkillAction(session, actor, skill, target) {
        // Lisvus onMagicFinalizer starts/renews stance after an offensive
        // cast completes, including a resisted spell, rather than at acceptance.
        if (!actor.fetchKind && skill.fetchTargetKind?.() === 'enemy') {
            invoke(path.actor).enterCombatState(session, actor);
        }

        if (invoke('GameServer/Bot/AI/PartyCompanionService').startQueuedGroundPickup(session)) {
            return;
        }

        if (this.queue.name) {
            this.dequeueEvent(session);
            return;
        }

        // A first skill can start the weapon loop; it need not interrupt an
        // existing auto-attack. Keep explicit commands and target changes in
        // control, and leave NPC/summon attack loops to their native AI.
        if (!skill.fetchSemantic?.()?.nextActionAttack || actor.fetchKind || !target || target === actor
            || Number(actor.fetchDestId?.()) !== Number(target.fetchId?.())
            || actor.isDead?.() || target.isDead?.() || target.state?.fetchDead?.()
            || actor.isBlocked?.() || !invoke('GameServer/Effects/EffectRestrictions').canAttack(actor)) return;

        // The accepted cast already validated this target's attack permission.
        // meleeHit rechecks participants, PvP defense, weapon range and chase.
        this.meleeHit(session, target);
    }

    captureShotState(actor) {
        return {
            soulshotLoaded: !!actor.soulshotLoaded,
            spiritshotLoaded: !!actor.spiritshotLoaded,
            blessedSpiritshotLoaded: !!actor.blessedSpiritshotLoaded
        };
    }

    restoreShotState(actor, state) {
        actor.soulshotLoaded = state.soulshotLoaded;
        actor.spiritshotLoaded = state.spiritshotLoaded;
        actor.blessedSpiritshotLoaded = state.blessedSpiritshotLoaded;
    }

    resolveSkillTargets(session, actor, primary, skill) {
        const semantic = skill.fetchSemantic?.() || {};
        const sourceTarget = semantic.sourceTarget;
        const radius = Math.max(0, Number(semantic.radius) || 0);
        const targetKind = skill.fetchTargetKind?.();

        if (sourceTarget === 'clan' && this.isNpcCombatant(actor)) {
            const World = invoke('GameServer/World/World');
            const RaidEntityIndex = invoke('GameServer/World/RaidEntityIndex');
            // Lisvus TARGET_CLAN on a minion reaches its leader and the
            // leader's minions. Other NPCs reach nearby faction members.
            const boss = Number(actor.minionBossObjectId) > 0 ? RaidEntityIndex.bossFor(World, actor) : null;
            const faction = actor.fetchClanName?.();
            const range = Math.max(0, Number(skill.fetchDistance?.()) || 0);
            let targets;
            if (boss) {
                targets = RaidEntityIndex.entitiesForRaid(World, { bossId: boss.fetchId(), bossTemplateId: boss.fetchSelfId() });
            } else if (actor.minionLeader) {
                targets = invoke('GameServer/World/RaidBossMinionManager').leaderGroup(World, actor.minionLeader);
            } else {
                targets = [actor, ...(faction ? (World.npc?.spawns || []).filter(target => (
                    this.isNpcCombatant(target) && target !== actor
                    && target.fetchClanName?.() === faction && this.distance2d(actor,target) <= range
                )) : [])];
            }
            return this.uniqueSkillTargets(targets.filter(target => (
                this.isValidSkillTarget(target,skill,actor) && target.isDead?.() !== true
            )));
        }

        if (targetKind === 'party') {
            const PartyAwareness = invoke('GameServer/Bot/AI/PartyAwareness');
            const SummonControl = invoke('GameServer/Npc/SummonControl');
            const leaderSession = session?.partyCompanion === true && session.followPlayerSession
                ? session.followPlayerSession
                : session;
            const partyActors = PartyAwareness.partyActors(leaderSession)
                .filter((target) => (
                    this.isValidSkillTarget(target, skill, actor) &&
                    (radius <= 0 || this.distance2d(actor, target) <= radius)
                ));
            const party = [];
            for (const target of partyActors) {
                party.push(target);
                const summon = SummonControl.activeSummon(target);
                if (summon && (radius <= 0 || this.distance2d(actor, summon) <= radius)) party.push(summon);
            }
            if (party.length > 0) return this.uniqueSkillTargets(party);
            return this.isValidSkillTarget(primary, skill, actor) && (radius <= 0 || this.distance2d(actor, primary) <= radius)
                ? [primary]
                : [];
        }

        if (targetKind === 'ally' || targetKind === 'corpse_ally') {
            const World = invoke('GameServer/World/World');
            const SummonControl = invoke('GameServer/Npc/SummonControl');
            const PledgeHelpers = invoke('GameServer/Network/Response/PledgeHelpers');
            const clanId = Number(actor?.fetchClanId?.()) || 0;
            const allyId = PledgeHelpers.allyId(actor);
            const corpseOnly = targetKind === 'corpse_ally';
            const targets = [];

            if (!corpseOnly) {
                targets.push(actor);
                const ownSummon = SummonControl.activeSummon(actor);
                if (ownSummon && (radius <= 0 || this.distance2d(actor, ownSummon) <= radius)) targets.push(ownSummon);
            }

            if (clanId > 0 || allyId > 0) {
                for (const targetSession of World.user?.sessions || []) {
                    const target = targetSession?.actor;
                    const sameClan = clanId > 0 && Number(target?.fetchClanId?.()) === clanId;
                    const sameAlliance = allyId > 0 && PledgeHelpers.allyId(target) === allyId;
                    if (!target || target === actor || (!sameClan && !sameAlliance)) continue;
                    if (radius > 0 && this.distance2d(actor, target) > radius) continue;

                    if (corpseOnly) {
                        if (this.isValidSkillTarget(target, skill, actor)) targets.push(target);
                        continue;
                    }

                    if (this.isValidSkillTarget(target, skill, actor)) targets.push(target);
                    const summon = SummonControl.activeSummon(target);
                    if (summon && (radius <= 0 || this.distance2d(actor, summon) <= radius)) targets.push(summon);
                }
            }

            return this.uniqueSkillTargets(targets);
        }

        if (sourceTarget === 'aura' && radius > 0 && primary === actor && targetKind === 'enemy') {
            return this.fetchSkillTargetsInRadius(actor, actor.fetchLocX(), actor.fetchLocY(), radius)
                .filter((target) => this.isValidSkillTarget(target, skill, actor) && this.distance2d(actor, target) <= radius);
        }

        if (
            !sourceTarget ||
            radius <= 0 ||
            !['enemy', 'corpse_mob'].includes(skill.fetchTargetKind?.()) ||
            !this.isAreaPrimary(actor, primary, skill)
        ) {
            return [primary];
        }

        const center = sourceTarget === 'area' ? primary : actor;
        const nearby = this.fetchSkillTargetsInRadius(actor, center.fetchLocX(), center.fetchLocY(), radius);
        const targets = [primary, ...nearby];
        const seen = new Set();
        // A corpse selects the explosion center; its victims must be living enemies.
        const victimSkill = skill.fetchTargetKind?.() === 'corpse_mob'
            ? { fetchTargetKind: () => 'enemy' }
            : skill;

        return targets.filter((target) => {
            const id = target?.fetchId?.();
            if (!id || seen.has(id)) return false;
            seen.add(id);

            if (!this.isValidSkillTarget(target, victimSkill, actor)) return false;
            if (this.distance2d(center, target) > radius) return false;
            if (sourceTarget === 'front_area' && !this.isFacing(actor, target, 120)) return false;
            return true;
        });
    }

    fetchSkillTargetsInRadius(actor, locX, locY, radius) {
        const World = invoke('GameServer/World/World');
        // Arena duels are the one player-vs-player combat path that needs the
        // normal area-skill fanout to include user actors. Keep the existing
        // NPC-only player AoE behavior everywhere else, but expose only the
        // paired arena opponent here so outside players can never be hit.
        if (actor?.session?.arenaDuelId || actor?.session?.arenaEphemeral === true) {
            const ArenaCombatRules = invoke('GameServer/World/ArenaCombatRules');
            return (World.user?.sessions || [])
                .map((session) => session?.actor)
                .filter((target) => target && target !== actor
                    && ArenaCombatRules.canInteract(actor, target)
                    && this.distance2d(actor, target) <= radius);
        }
        if (this.isNpcCombatant(actor)) {
            return (World.user?.sessions || []).map((session) => session?.actor).filter(Boolean);
        }

        return typeof World.fetchNpcsInRadius === 'function'
            ? World.fetchNpcsInRadius(locX, locY, radius)
            : [];
    }

    uniqueSkillTargets(targets) {
        const seen = new Set();
        return targets.filter((target) => {
            const id = Number(target?.fetchId?.()) || 0;
            if (!id || seen.has(id)) return false;
            seen.add(id);
            return true;
        });
    }

    resolveMeleeTargets(actor, primary) {
        if (!this.isPolearmAttack(actor) || EffectStats.add(actor, 'hitMainTarget') > 0) {
            return [primary];
        }

        const maxTargets = Math.max(1, 4 + Math.floor(EffectStats.add(actor, 'atkCountMaxAdd')));
        const enemySkill = { fetchTargetKind: () => 'enemy' };
        const attackRange = AttackRange.fetchNormalAttackRange(actor);
        const nearby = this.fetchSkillTargetsInRadius(
            actor,
            actor.fetchLocX(),
            actor.fetchLocY(),
            AttackRange.targetQueryRadius(actor, attackRange)
        );
        const seen = new Set([primary.fetchId?.()]);
        const targets = [primary];

        for (const target of nearby) {
            const id = target?.fetchId?.();
            if (!id || seen.has(id)) continue;
            if (!this.isValidSkillTarget(target, enemySkill, actor)) continue;
            if (Math.abs((Number(target.fetchLocZ?.()) || 0) - (Number(actor.fetchLocZ?.()) || 0)) > 650) continue;
            if (!AttackRange.isWithinRange(actor, target, attackRange) || !this.isFacing(actor, target, WeaponSA.attackAngle(actor))) continue;

            seen.add(id);
            targets.push(target);
            if (targets.length >= maxTargets) break;
        }

        return targets;
    }

    isAreaPrimary(actor, target, skill) {
        if (skill.fetchTargetKind?.() === 'corpse_mob') {
            return target?.fetchAttackable?.() === true && target?.isDead?.() === true;
        }

        return this.isValidSkillTarget(target, skill, actor);
    }

    isValidSkillTarget(target, skill, actor = null) {
        if (!target) return false;
        const targetKind = skill.fetchTargetKind?.();

        if (targetKind === 'corpse_mob') {
            return target.fetchAttackable?.() === true && target.isDead?.() === true;
        }

        if (['corpse_player', 'corpse_pet', 'corpse_ally'].includes(targetKind)) {
            return target.state?.fetchDead?.() === true || target.isDead?.() === true;
        }

        if (targetKind === 'enemy') {
            if (actor?.session?.arenaDuelId || actor?.session?.arenaEphemeral === true) {
                const ArenaCombatRules = invoke('GameServer/World/ArenaCombatRules');
                if (ArenaCombatRules.canInteract(actor, target)) return true;
            }
            if (this.isNpcCombatant(actor)) {
                return target !== actor && !target.fetchKind && target.state?.fetchDead?.() !== true && target.isDead?.() !== true;
            }
            return target.fetchAttackable?.() === true && target.state?.fetchDead?.() !== true && target.isDead?.() !== true;
        }

        return target.state?.fetchDead?.() !== true;
    }

    distance2d(src, dst) {
        const dx = (Number(src?.fetchLocX?.()) || 0) - (Number(dst?.fetchLocX?.()) || 0);
        const dy = (Number(src?.fetchLocY?.()) || 0) - (Number(dst?.fetchLocY?.()) || 0);
        return Math.sqrt(dx * dx + dy * dy);
    }

    isNpcCombatant(actor) {
        return !!(actor?.fetchKind && actor.fetchIsSummon?.() !== true);
    }

    chargeShotForSkill(session, actor, magicSkill, skill = null) {
        if (!ShotStock.actionShotKind(magicSkill, skill?.fetchSsBoost?.())) return;

        if (magicSkill) {
            const autoShot = actor.backpack?.fetchAutoSpiritshot?.(actor);
            const shotKind = autoShot?.kind || actor.backpack?.fetchAutoSpiritshotKind?.(actor);
            if (!actor.spiritshotLoaded && shotKind && typeof actor.backpack.consumeSpiritshot === 'function') {
                actor.backpack.consumeSpiritshot(session, (success, shot = {}) => {
                    if (success) {
                        actor.spiritshotLoaded = true;
                        actor.blessedSpiritshotLoaded = !!shot.blessedSpiritshot;
                        this.broadcastShotCharge(session, actor, shot.skillId || 2047);
                    }
                }, shotKind, autoShot?.selfId);
            }
            return;
        }

        const autoSoulshotId = actor.backpack?.fetchAutoShot?.(actor, 'soulshot');
        if (!actor.soulshotLoaded && (autoSoulshotId || actor.backpack?.isAutoShotEnabled?.(actor, 'soulshot')) && typeof actor.backpack.consumeSoulshot === 'function') {
            actor.backpack.consumeSoulshot(session, (success, shot = {}) => {
                if (success) {
                    actor.soulshotLoaded = true;
                    this.broadcastShotCharge(session, actor, shot.skillId || 2039);
                }
            }, autoSoulshotId);
        }
    }

    calculatedSkillHitTime(actor, skill, magicSkill) {
        const hitTime = skill?.fetchHitTime?.();
        if (skill?.fetchSemantic?.()?.staticHitTime) return Formulas.calcSkillHitTime(hitTime, 1, { staticHitTime: true });
        const speed = magicSkill ? actor.fetchCollectiveCastSpd() : actor.fetchCollectiveAtkSpd();
        return Formulas.calcSkillHitTime(hitTime, speed, { magic: !!magicSkill, spiritshot: !!actor.spiritshotLoaded });
    }

    calculatedSkillCoolTime(actor, skill, magicSkill) {
        const semantic = skill.fetchSemantic?.() || {};
        const base = Math.max(0, Number(semantic.coolTime) || 0);
        if (!base || semantic.staticHitTime) return base;
        const speed = magicSkill ? actor.fetchCollectiveCastSpd() : actor.fetchCollectiveAtkSpd();
        const scaled = Math.floor((base * 333) / speed);
        // Unlike hitTime, Lisvus does not apply the 500 ms cast minimum to
        // coolTime. Capture the shot and speed modifiers at cast acceptance.
        return magicSkill && actor.spiritshotLoaded ? Math.floor(scaled * 0.70) : scaled;
    }

    skillUseConditionFailure(session, actor, skill) {
        if (skill === undefined) {
            skill = actor;
            actor = session;
            session = null;
        }
        const semantic = skill.fetchSemantic?.() || {};
        const condition = semantic.condition || null;
        if ((actor.fetchMounted?.() || actor.mounted) && !skill.fetchSpell?.() && skill.fetchSelfId() !== 325) return 'Physical skills cannot be used while riding a strider.';
        const summonFailure = SkillEffects.validateSummonUse?.(actor, null, skill, session);
        if (summonFailure) {
            return summonFailure;
        }

        if (this.shouldConsumeSkillItems(skill) && !SkillEffects.hasRequiredSkillItems(actor, skill)) {
            return 'Not enough required items.';
        }

        if (semantic.createItemId) {
            const materialId = Number(semantic.itemConsumeId) || 0;
            const required = Math.max(1, Number(semantic.itemConsumeCount) || 1);
            const material = actor?.backpack?.fetchItems?.().find((item) => Number(item.fetchSelfId?.()) === materialId);
            if (!material || Number(material.fetchAmount?.()) < required) return 'Not enough required items.';
        }

        const requires = semantic.requires || {};
        const requiredCharges = Math.max(0, Number(requires.charges) || 0);
        const charges = Math.max(0, Number(actor.fetchCharges?.() ?? actor.charges ?? 0) || 0);
        if (requiredCharges > charges) return 'Not enough charges.';

        if (requires.weaponsAllowed) {
            const mask = weaponMaskFor(actor);
            if ((Number(requires.weaponsAllowed) & mask) === 0) {
                return 'Incorrect weapon.';
            }
        }

        if (requires.itemKind === 'shield') {
            const hasShield = (actor?.backpack?.fetchEquippedArmors?.() || [])
                .some((item) => item?.fetchKind?.() === 'Armor.Shield');
            if (!hasShield) return 'A shield must be equipped.';
        }

        if (!condition) return null;

        if (condition.actorStanding === true && actor.state?.fetchSeated?.() === true) {
            return 'Cannot use while sitting.';
        }

        if (condition.actorHpPercentAtMost !== undefined) {
            const maxHp = Number(actor.fetchMaxHp?.()) || 0;
            const hp = Number(actor.fetchHp?.()) || 0;
            if (maxHp > 0 && hp / maxHp * 100 > condition.actorHpPercentAtMost) {
                return `Can only be used when one's own remaining HP is ${condition.actorHpPercentAtMost}% or less.`;
            }
        }

        if (condition.elementalSeeds) {
            const required = condition.elementalSeeds;
            const seeds = [
                SkillEffects.seedPower(actor, 1285),
                SkillEffects.seedPower(actor, 1286),
                SkillEffects.seedPower(actor, 1287)
            ];
            const direct = [required.fire, required.water, required.wind].map((value) => Math.max(0, Number(value) || 0));

            for (let index = 0; index < seeds.length; index++) {
                if (seeds[index] < direct[index]) return 'Proper elemental seeds required.';
                seeds[index] -= direct[index];
            }

            let various = Math.max(0, Number(required.various) || 0);
            for (let index = 0; index < seeds.length && various > 0; index++) {
                if (seeds[index] > 0) {
                    seeds[index]--;
                    various--;
                }
            }
            if (various > 0) return 'Proper elemental seeds required.';

            const any = Math.max(0, Number(required.any) || 0);
            if (seeds.reduce((total, power) => total + power, 0) < any) {
                return 'Proper elemental seeds required.';
            }
        }

        return null;
    }

    consumeSkillCharges(session, actor, skill) {
        const required = Math.max(0, Number(skill.fetchSemantic?.().requires?.charges) || 0);
        if (!required) return true;
        const result = ChargeLifecycle.consume(session, actor, required);
        if (!result.ok) return false;
        actor.activeSkillChargeCount = result.previous;
        return true;
    }

    shouldConsumeSkillItems(skill) {
        return [
            C4SkillRules.DAMAGE,
            C4SkillRules.EFFECT,
            C4SkillRules.HEAL_PERCENT
        ].includes(skill.fetchSkillType?.());
    }

    consumeSkillItems(session, actor, skill) {
        if (!this.shouldConsumeSkillItems(skill)) return true;
        const itemId = Number(skill.fetchItemConsumeId?.()) || 0;
        const count = Number(skill.fetchItemConsumeCount?.()) || 0;
        if (!itemId || count <= 0) return true;
        const item = actor?.backpack?.fetchItemFromSelfId?.(itemId);
        if (!item || (Number(item.fetchAmount?.()) || 0) < count) return false;
        actor.backpack.deleteItem(session, item.fetchId(), count, () => {});
        return true;
    }

    skillMpCost(actor, skill) {
        const semantic = skill.fetchSemantic?.() || {};
        let cost = Math.max(0, Number(skill.fetchConsumedMp?.()) || 0);

        if (semantic.isDance) {
            const activeDances = EffectStore.list(actor).filter((effect) => (
                C4SkillRules.resolve({
                    selfId: effect.id,
                    name: effect.name,
                    level: effect.level
                }).isDance
            )).length;
            cost += activeDances * Math.max(0, Number(semantic.nextDanceCost) || 0);
            return Math.max(0, Math.floor(cost * EffectStats.multiplier(actor, 'danceMpConsumeMul')));
        }

        const stat = skill.fetchSpell?.() ? 'magicalMpConsumeMul' : 'physicalMpConsumeMul';
        const equipmentStat = skill.fetchSpell?.() ? 'magicalMpConsumeRateMul' : 'physicalMpConsumeRateMul';
        return Math.max(0, Math.floor(cost * EffectStats.multiplier(actor, stat)
            * EffectStats.multiplier(actor, equipmentStat) + 1e-9));
    }

    rejectSkillUseCondition(session, actor, message) {
        session.dataSendToMe?.(ServerResponse.actionFailed());
        session.dataSendToMe?.(ServerResponse.speak(actor, { kind: 0, text: message }));
    }

    broadcastShotCharge(session, actor, skillId) {
        session.dataSendToMeAndOthers(
            ServerResponse.skillStarted(actor, actor.fetchId(), {
                fetchSelfId: () => skillId,
                fetchCalculatedHitTime: () => 0,
                fetchReuseTime: () => 0
            }),
            actor
        );
    }

    isMagicSkill(skill) {
        return skill.fetchSpell ? skill.fetchSpell() : true;
    }

    prepareSkillDamage(actor, creature, skill, magicSkill, rng = Math.random, magicAtkOverride = null) {
        const semantic = skill.fetchSemantic?.() || {};
        if (magicSkill) {
            const usedSpiritshot = !!actor.spiritshotLoaded;
            const usedBlessedSpiritshot = usedSpiritshot && !!actor.blessedSpiritshotLoaded;
            const attacker = CombatantView.view({
                mAtk: magicAtkOverride ?? actor.fetchCollectiveMAtk(),
                mCritRate: Formulas.magicCriticalRate({
                    multiplier: EffectStats.multiplier(actor, 'mCritRateMul'),
                    add: EffectStats.add(actor, 'mCritRateAdd'),
                    wit: actor.fetchCollectiveWit?.(),
                    weapon: !!actor.backpack?.fetchEquippedWeapon?.()
                })
            });
            const power = HitRules.skillPower(semantic, skill.fetchPower(), actor.fetchHp?.(), actor.fetchMaxHp?.());
            const { damage } = HitRules.magicSkill(attacker, CombatantView.view({ mDef: creature.fetchCollectiveMDef() }), {
                power, spiritshot: usedSpiritshot, blessedSpiritshot: usedBlessedSpiritshot,
                modifier: hitModifier(actor, creature, { magic: true, trait: semantic.trait }) * WeaponSA.pvpMultiplier(actor, creature, 'magic')
            }, rng);
            this.clearLoadedShot(actor, magicSkill);
            return damage;
        }

        const position = this.targetPosition(actor, creature);
        // Only a skill with a critical rate reads STR (physicalSkillCritRate).
        const str = Number(semantic.baseCritRate) > 0
            ? ((Number(actor?.fetchStr?.()) || 1) + EffectStats.add(actor, 'STR')) * EffectStats.multiplier(actor, 'STRMul') : 1;
        const attacker = CombatantView.view({
            pAtk: actor.fetchCollectivePAtk(),
            pAtkRnd: actor.backpack?.fetchTotalWeaponPAtkRnd?.() ?? 0,
            critDamageMul: EffectStats.multiplier(actor, 'pCritDamageMul')
                * EffectStats.situationalMultiplier(actor, 'pCritDamageMul', position),
            critDamageAdd: EffectStats.add(actor, 'pCritDamageAdd'),
            str
        });
        const power = HitRules.skillPower(semantic, skill.fetchPower(), actor.fetchHp?.(), actor.fetchMaxHp?.());
        const { damage } = HitRules.physicalSkill(attacker, this.defenderView(creature), {
            power,
            blow: semantic.skillType === C4SkillRules.BLOW,
            soulshot: !!actor.soulshotLoaded,
            facing: this.isShieldFacing(creature, actor),
            bow: this.isBowAttack(actor),
            skillCritRate: HitRules.physicalSkillCritRate(semantic, attacker.str),
            modifier: hitModifier(actor, creature, { skill: true, trait: semantic.trait })
                * WeaponSA.pvpMultiplier(actor, creature, 'skill')
        }, rng);
        this.clearLoadedShot(actor, magicSkill);
        return damage;
    }

    // The defender's side of a hit (CombatantView): its defences and shield.
    // Without a shield rate no block succeeds (Formulas.rollShieldUse), so its
    // P.Def is not read.
    defenderView(creature) {
        const shieldRate = this.fetchShieldRate(creature);
        return CombatantView.view({
            pDef: creature.fetchCollectivePDef(),
            shieldPDef: shieldRate > 0 ? this.fetchShieldPDef(creature) : 0,
            shieldRate,
            dex: creature.fetchDex ? creature.fetchDex() : 0
        });
    }

    clearLoadedShot(actor, magicSkill) {
        if (magicSkill) {
            actor.spiritshotLoaded = false;
            actor.blessedSpiritshotLoaded = false;
        }
        else actor.soulshotLoaded = false;
    }

    prepareMeleeHit(actor, creature, hitLanded, usedSoulshot, rng = Math.random) {
        if (!hitLanded) {
            return {
                damage: 0,
                flags: ServerResponse.attack.HITFLAG_MISS
            };
        }

        const position = this.targetPosition(actor, creature);
        const attacker = CombatantView.view({
            pAtk: actor.fetchCollectivePAtk(),
            pAtkRnd: actor.backpack.fetchTotalWeaponPAtkRnd() ?? 0,
            critRate: this.fetchSituationalCriticalRate(actor, creature),
            critDamageMul: EffectStats.multiplier(actor, 'pCritDamageMul')
                * EffectStats.situationalMultiplier(actor, 'pCritDamageMul', position),
            critDamageAdd: EffectStats.add(actor, 'pCritDamageAdd')
        });
        const hit = HitRules.melee(attacker, this.defenderView(creature), {
            soulshot: usedSoulshot,
            facing: this.isShieldFacing(creature, actor),
            bow: this.isBowAttack(actor),
            anger: () => WeaponSA.criticalAnger(actor),
            modifier: hitModifier(actor, creature) * WeaponSA.pvpMultiplier(actor, creature, 'melee')
        }, rng);
        let flags = usedSoulshot ? ServerResponse.attack.soulshotFlags(actor) : 0;

        if (hit.critical) flags |= ServerResponse.attack.HITFLAG_CRIT;
        if (hit.shield > Formulas.SHIELD_DEFENSE_FAILED) flags |= ServerResponse.attack.HITFLAG_SHLD;

        return {
            damage: hit.damage,
            flags,
            anger: hit.anger
        };
    }

    prepareNpcMeleeHit(src, dst, hitLanded, rng = Math.random) {
        if (!hitLanded) {
            return {
                damage: 0,
                flags: ServerResponse.attack.HITFLAG_MISS
            };
        }

        const attacker = CombatantView.view({
            pAtk: src.fetchCollectivePAtk(),
            critRate: this.fetchSituationalCriticalRate(src, dst),
            critDamageMul: EffectStats.multiplier(src, 'pCritDamageMul'),
            critDamageAdd: EffectStats.add(src, 'pCritDamageAdd')
        });
        const hit = HitRules.melee(attacker, this.defenderView(dst), {
            soulshot: src.fetchIsPet?.() === true && !!src.soulshotLoaded,
            facing: this.isShieldFacing(dst, src),
            bow: this.isBowAttack(src),
            modifier: hitModifier(src, dst)
        }, rng);
        let flags = 0;
        if (src.fetchIsPet?.() === true && src.soulshotLoaded) {
            flags |= ServerResponse.attack.HITFLAG_USESS;
            src.soulshotLoaded = false;
        }

        if (hit.critical) flags |= ServerResponse.attack.HITFLAG_CRIT;
        if (hit.shield > Formulas.SHIELD_DEFENSE_FAILED) flags |= ServerResponse.attack.HITFLAG_SHLD;

        return { damage: hit.damage, flags };
    }

    fetchShieldPDef(creature) {
        if (creature?.backpack?.fetchTotalShieldPDef) {
            const base = creature.backpack.fetchTotalShieldPDef();
            return (base * EffectStats.multiplier(creature, 'sDefMul')) + EffectStats.add(creature, 'sDefAdd');
        }

        const shield = this.fetchNpcShieldItem(creature);
        return Number(shield?.stats?.pDef || shield?.pDef || 0);
    }

    fetchShieldRate(creature) {
        const rateMultiplier = EffectStats.multiplier(creature, 'rShldMul');
        let shieldRate = 0;

        if (creature?.backpack?.fetchTotalShieldRate) {
            shieldRate = creature.backpack.fetchTotalShieldRate();
        }
        else {
            shieldRate = this.fetchNpcShieldItem(creature) || this.fetchShieldPDef(creature) > 0 ? Formulas.DEFAULT_SHIELD_RATE : 0;
        }

        return Math.max(0, (Number(shieldRate) || 0) * rateMultiplier);
    }

    fetchSituationalCriticalRate(attacker, target) {
        const base = Number(attacker?.fetchCollectiveCritical?.()) || 0;
        const position = this.targetPosition(attacker, target);
        const stats = C4EquipmentItemSkills.situationalStats(attacker, {
            behindTarget: position.behind
        });
        return (base
            * EffectStats.situationalMultiplier(attacker, 'pCritRateMul', position)
            * (Number(stats.pCritRateMul) || 1))
            + (Number(stats.pCritRateAdd) || 0);
    }

    targetPosition(attacker, target) {
        const behind = this.isBehindTarget(attacker, target);
        return {
            behind,
            front: !behind && this.isFacing(target, attacker, 120)
        };
    }

    isBowAttack(creature) {
        return attackKind(creature) === 'Weapon.Bow';
    }

    isPolearmAttack(creature) {
        return attackKind(creature) === 'Weapon.Pole';
    }

    fetchNpcWeaponKind(creature) {
        if (!creature?.fetchWeapon || !DataCache.items) return '';
        const item = ItemTemplateIndex.find(DataCache.items, creature.fetchWeapon());
        return item?.template?.kind || '';
    }

    fetchNpcShieldItem(creature) {
        if (!creature?.fetchShield || !DataCache.items) return null;
        const shieldId = Number(creature.fetchShield());
        if (!shieldId) return null;
        return ItemTemplateIndex.find(DataCache.items, shieldId) || null;
    }

    applyDamageAbsorb(session, actor, damage) {
        if (this.isBowAttack(actor) || actor.fetchHp?.() <= 0 || actor.state?.fetchDead?.()) return 0;

        const currentHp = Number(actor.fetchHp?.()) || 0;
        const absorbDamage = HitRules.absorbedHp(EffectStats.add(actor, 'absorbDam'), damage, currentHp, Number(actor.fetchMaxHp?.()) || 0);
        if (absorbDamage <= 0) return 0;

        actor.setHp(currentHp + absorbDamage);
        actor.statusUpdateVitals?.(actor);
        return absorbDamage;
    }

    isFacing(target, attacker, degrees = Formulas.DEFAULT_SHIELD_DEFENCE_ANGLE) {
        if (!target?.fetchHead || !attacker?.fetchLocX || degrees >= 360) return true;

        const dx = attacker.fetchLocX() - target.fetchLocX();
        const dy = attacker.fetchLocY() - target.fetchLocY();
        if (dx === 0 && dy === 0) return true;

        const heading = Number(target.fetchHead()) || 0;
        const facingRadians = (heading / 65535) * Math.PI * 2;
        const targetRadians = Math.atan2(dy, dx);
        let diff = Math.abs(facingRadians - targetRadians) % (Math.PI * 2);
        if (diff > Math.PI) diff = (Math.PI * 2) - diff;

        return diff <= (degrees / 2) * (Math.PI / 180);
    }

    isShieldFacing(target, attacker) {
        const configured = Number(EffectStats.add(target, 'shieldDefAngle')) || 0;
        return this.isFacing(target, attacker, configured > 0 ? configured : Formulas.DEFAULT_SHIELD_DEFENCE_ANGLE);
    }

    isBehindTarget(attacker, target) {
        if (!target?.fetchHead || !attacker?.fetchLocX) return false;
        return this.isFacing(target, attacker, 60) === false && this.isFacing(target, attacker, 240) === false;
    }

    positionContext(attacker, target) {
        return {
            behind: this.isBehindTarget(attacker, target),
            front: this.isFacing(target, attacker, 120)
        };
    }

    checkParticipants(src, dst, { allowDeadTarget = false } = {}) {
        if (!src || !dst || !src.state || !dst.state) {
            this.resetQueuedEvent();
            return true;
        }

        if (src.state.fetchDead() || (!allowDeadTarget && dst.state.fetchDead())) {
            this.resetQueuedEvent();
            src.state.setHits (false);
            src.state.setCasts(false);
            if (src.session) {
                if (src.state.fetchDead()) invoke(path.actor).abortCombatState(src.session, src);
                else src.automation.abortAll(src);
            }
            return true;
        }
        return false;
    }

    blockedPvpDefense(session, actor, target, skill = null) {
        if (actor?.fetchOwnerId?.() && target && !target.fetchKind && actor !== target &&
            (!skill || skill.fetchTargetKind?.() === 'enemy')) {
            const owner = invoke('GameServer/Bot/AI/BotPvpThreats').character(actor);
            if (!invoke('GameServer/Npc/SummonControl').isValidEnemyTarget(owner, target)) {
                this.clearTimers();
                actor.state?.setHits?.(false);
                actor.state?.setCasts?.(false);
                return true;
            }
        }
        if (!target || !session?.pvpDefense || session.actor !== actor || actor === target || target?.fetchKind ||
            (skill && skill.fetchTargetKind?.() !== 'enemy')) return false;
        const Threats = invoke('GameServer/Bot/AI/BotPvpThreats');
        if ((!skill || skill.fetchSkillType?.() !== 'effect') && Threats.protectedTarget(session, target)) {
            invoke('GameServer/Bot/AI/BotPvpTactics').stop(session, actor);
            return true;
        }
        const allowed = (target.fetchPvpFlag?.() > 0 || target.fetchKarma?.() > 0 ||
            Threats.canDefendWhileChaotic(session, target) ||
            invoke('GameServer/Bot/AI/BotRevenge').allows(session, target)) &&
            !Threats.inPeace(actor) && !Threats.inPeace(target) &&
            !invoke('GameServer/Bot/AI/BotPvpRisk').sameParty(session, target.session) &&
            invoke('GameServer/World/ArenaCombatRules').canInteract(actor, target);
        if (allowed) return false;
        // Recheck at landing as well as selection. A queued swing/cast must
        // not turn into PK after a flag expires, a party invite or a zone move.
        invoke('GameServer/Bot/AI/BotPvpTactics').stop(session, actor);
        return true;
    }

    recordPlayerAggression(session, actor, target) {
        const Threats = invoke('GameServer/Bot/AI/BotPvpThreats');
        const attacker = Threats.character(actor);
        const attackerSession = attacker === actor ? session : attacker?.session;
        if (attacker && attackerSession && target && !target.fetchKind && attacker !== target &&
            Threats.record(target, actor)) {
            invoke('GameServer/Actor/PvpFlag').mark(attackerSession, attacker);
            return true;
        }
        return false;
    }

    hit(session, actor, creature, hit, context = {}) {
        ConsoleText.transmit(session, ConsoleText.caption.actorHit, [{ kind: ConsoleText.kind.number, value: hit }]);
        this.tryBreakCast(creature, hit);

        if (creature.fetchId() >= 2000000) {
            if (actor?.fetchKind) {
                if (creature?.session) {
                    creature.session.incomingThreatId = actor.fetchId();
                    creature.session.incomingThreatAt = Date.now();
                }
                invoke(path.actor).receivedHit(session, creature, hit, { source: actor });
                return;
            }

            const ArenaCombatRules = invoke('GameServer/World/ArenaCombatRules');
            if (!ArenaCombatRules.canInteract(actor, creature)) return;

            if (ArenaCombatRules.suppressConsequences(actor, creature)) {
                invoke(path.actor).receivedHit(session, creature, hit, { source: actor });
                if (!context.skill && hit > 0 && !actor.state.fetchDead?.()) {
                    invoke(path.actor).enterCombatState(session, actor);
                }
                return;
            }

            // Flag the attacker when hitting another player/bot
            invoke('GameServer/Actor/PvpFlag').mark(session, actor);

            invoke(path.actor).receivedHit(session, creature, hit, { source: actor });
        }
        else {
            invoke(path.npc).receivedHit(session, actor, creature, hit, context);
        }

        this.applyReflectedDamage(session, actor, creature, hit);
        // A landed normal attack is the stance event. A skill renews stance
        // in finishRemoteCast; a missed or cancelled swing does not renew it.
        if (!actor.fetchKind && !context.skill && hit > 0 && !actor.state.fetchDead?.()) {
            invoke(path.actor).enterCombatState(session, actor);
        }
    }

    tryBreakCast(creature, damage, rng = Math.random) {
        if (!creature?.state?.fetchCasts?.()) return false;
        const chance = Formulas.calcCastBreakChance({
            damage,
            men: creature.fetchMen?.(),
            cancelAdd: EffectStats.add(creature, 'cancelAdd')
        });
        if (rng() * 100 >= chance) return false;
        return creature.attack?.abortCast?.(creature.session, creature) === true;
    }

    applyReflectedDamage(session, actor, creature, hit) {
        if (!actor || actor === creature || actor.isDead?.() || creature?.isDead?.()) return;
        const reflected = HitRules.reflectedDamage(EffectStats.add(creature, 'reflectDam'), hit);
        if (reflected <= 0) return;

        if (Number(actor.fetchId?.()) >= 2000000) {
            invoke(path.actor).receivedHit(session, actor, reflected, { source: creature });
        } else {
            invoke(path.npc).receivedHit(session, creature, actor, reflected);
        }
    }
}

// The hot adapters of HitRules.targetModifier: the target's weaknesses and
// the attacker's undead and race bonuses from their live effects.
function hitModifier(attacker, target, { magic = false, skill = false, trait = '' } = {}) {
    return HitRules.targetModifier({ magic, skill, trait, weaponKind: attackKind(attacker),
        race: target?.fetchRace?.() ?? target?.model?.race ?? target?.race,
        undead: target?.fetchUndead?.() === true || target?.model?.undead === true },
    stat => EffectStats.multiplier(target, stat, 1), stat => EffectStats.multiplier(attacker, stat));
}

function attackKind(creature) {
    return creature?.backpack?.fetchTotalWeaponKind ? creature.backpack.fetchTotalWeaponKind() : Attack.prototype.fetchNpcWeaponKind(creature);
}

function traitVulnerabilityModifier(target, trait) {
    const stat = HitRules.elementVulnStat(trait);
    return stat ? EffectStats.multiplier(target, stat, 1) : 1;
}

function physicalRaceModifier(attacker, target) {
    const stat = HitRules.raceStat(target?.fetchRace?.() ?? target?.model?.race ?? target?.race);
    return stat ? EffectStats.multiplier(attacker, stat) : 1;
}

module.exports = Attack;
module.exports.weaponMaskFor = weaponMaskFor;
module.exports.physicalRaceModifier = physicalRaceModifier;
module.exports.traitVulnerabilityModifier = traitVulnerabilityModifier;
module.exports.hitModifier = hitModifier;
