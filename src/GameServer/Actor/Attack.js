const ServerResponse = invoke('GameServer/Network/Response');
const ConsoleText    = invoke('GameServer/ConsoleText');
const Formulas       = invoke('GameServer/Formulas');
const DataCache      = invoke('GameServer/DataCache');
const SkillEffects   = invoke('GameServer/Skills/C4SkillEffects');
const C4SkillRules   = invoke('GameServer/Skills/C4SkillRules');
const EffectStats    = invoke('GameServer/Effects/EffectStats');
const EffectStore    = invoke('GameServer/Effects/EffectStore');
const C4EquipmentItemSkills = invoke('GameServer/Items/C4EquipmentItemSkills');
const RaidCurse = invoke('GameServer/RaidBoss/RaidCurse');

// L2WeaponType.mask() values used by the C4 datapack's weaponsAllowed field.
const WEAPON_MASK_BY_KIND = Object.freeze({
    'Weapon.Sword': 4,
    'Weapon.Blunt': 8,
    'Weapon.Knife': 16,
    'Weapon.Bow': 32,
    'Weapon.Pole': 64,
    'Weapon.Fist': 256,
    'Weapon.Dual': 512,
    'Weapon.DualFist': 1024,
    'Weapon.GreatSword': 2048,
    'Weapon.BigBlunt': 16384
});

function weaponMaskFor(actor) {
    const kind = actor?.backpack?.fetchTotalWeaponKind?.() || '';
    const hasShield = (actor?.backpack?.fetchEquippedArmors?.() || [])
        .some((item) => item?.fetchKind?.() === 'Armor.Shield');
    return (WEAPON_MASK_BY_KIND[kind] || 0) | (hasShield ? 1048576 : 0);
}

class Attack {
    constructor() {
        this.timers = new Set();
        this.resetQueuedEvent();
    }

    destructor() {
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
            case 'pickup' : {
                const isBot = session?.constructor?.name === 'BotSession' || String(session?.accountId || '').startsWith('bot_');
                // Hot bots move entirely on the server and never send the
                // ValidatePosition that a player's pickupRequest waits for.
                // A queued pickup commonly follows the killing hit, so it
                // must use the server-side execution path as well.
                if (isBot) Generics.pickupExec(session, actor, queue.data);
                else Generics.pickupRequest(session, actor, queue.data);
                break;
            }
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
        this.timers.forEach((timer) => clearTimeout(timer));
        this.timers.clear();
    }

    abortCast(session, actor) {
        if (!actor?.state?.fetchCasts?.()) {
            return false;
        }

        this.clearTimers();
        this.resetQueuedEvent();
        actor.state.setCasts(false);
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
        const actor = session.actor;

        if (this.checkParticipants(actor, creature)) {
            return;
        }

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

        const speed = Formulas.calcMeleeAtkTime(actor.fetchCollectiveAtkSpd());
        const hitLanded = Formulas.calcHitChance(actor, creature, Math.random, this.positionContext(actor, creature));
        const usedSoulshot = hitLanded && !!actor.soulshotLoaded;
        const hit = this.prepareMeleeHit(actor, creature, hitLanded, usedSoulshot);

        session.dataSendToMeAndOthers(ServerResponse.attack(actor, creature.fetchId(), hit), actor);
        actor.state.setHits(true);

        this.queueTimer(() => {
            if (this.checkParticipants(actor, creature)) {
                return;
            }

            if (RaidCurse.normalAttackBlocked(session, actor, creature)) {
                if (usedSoulshot) {
                    actor.soulshotLoaded = false;
                }
                return;
            }

            if (hitLanded) {
                if (usedSoulshot) {
                    actor.soulshotLoaded = false;
                }

                this.hit(session, actor, creature, hit.damage);
                this.applyDamageAbsorb(session, actor, hit.damage);
            }
            else {
                ConsoleText.transmit(session, ConsoleText.caption.missedHit);
            }

        }, speed * 0.644); // Until hit point

        this.queueTimer(() => {
            if (this.checkParticipants(actor, creature)) {
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

            this.meleeHit(session, creature);

        }, speed); // Until end of combat move
    }

    remoteHit(session, creature, skill) {
        const actor = session.actor;
        const corpseTarget = ['corpse_mob', 'corpse_player', 'corpse_pet', 'corpse_ally']
            .includes(skill.fetchTargetKind?.());

        if (this.checkParticipants(actor, creature, { allowDeadTarget: corpseTarget })) {
            invoke('GameServer/Bot/AI/BotSupportPlanner').cancelPendingSupportCast(session, actor, creature, skill, 'invalid_target');
            invoke('GameServer/Bot/AI/BotPartyChat').cancelExpectedSkillResult(session, actor, creature, skill);
            return;
        }

        if (actor.canUseSkill?.(skill) === false) {
            session.dataSendToMe?.(ServerResponse.actionFailed());
            invoke('GameServer/Bot/AI/BotSupportPlanner').cancelPendingSupportCast(session, actor, creature, skill, 'reuse');
            invoke('GameServer/Bot/AI/BotPartyChat').cancelExpectedSkillResult(session, actor, creature, skill);
            return;
        }

        const mpCost = this.skillMpCost(actor, skill);
        if (actor.fetchMp() < mpCost) {
            ConsoleText.transmit(session, ConsoleText.caption.depletedMp);
            invoke('GameServer/Bot/AI/BotSupportPlanner').cancelPendingSupportCast(session, actor, creature, skill, 'depleted_mp');
            invoke('GameServer/Bot/AI/BotPartyChat').cancelExpectedSkillResult(session, actor, creature, skill);
            return;
        }

        const conditionFailure = this.skillUseConditionFailure(actor, skill);
        if (conditionFailure) {
            this.rejectSkillUseCondition(session, actor, conditionFailure);
            invoke('GameServer/Bot/AI/BotSupportPlanner').cancelPendingSupportCast(session, actor, creature, skill, conditionFailure.code || conditionFailure.reason || 'condition');
            invoke('GameServer/Bot/AI/BotPartyChat').cancelExpectedSkillResult(session, actor, creature, skill);
            return;
        }

        const magicSkill = this.isMagicSkill(skill);
        this.chargeShotForSkill(session, actor, magicSkill, skill);

        const attackRate = magicSkill ? actor.fetchCollectiveCastSpd() : actor.fetchCollectiveAtkSpd();
        skill.setCalculatedHitTime(Formulas.calcRemoteAtkTime(skill.fetchHitTime(), attackRate));
        // Companion support selection runs before a native cast is accepted.
        // Only create its reservation at this point, after every rejection
        // gate above has passed and the cast is about to begin. The calculated
        // hit time is available here, so the reservation covers the full cast.
        invoke('GameServer/Bot/AI/BotSupportPlanner').beginSupportCast(session, actor, creature, skill);
        actor.markSkillReuse?.(skill);
        session.dataSendToMeAndOthers(ServerResponse.skillStarted(actor, creature.fetchId(), skill), actor);
        session.dataSendToMe(ServerResponse.skillDurationBar(skill.fetchCalculatedHitTime()));
        actor.state.setCasts(true);

        this.queueTimer(() => {
            if (this.checkParticipants(actor, creature, { allowDeadTarget: corpseTarget })) {
                invoke('GameServer/Bot/AI/BotSupportPlanner').cancelSupportCast(session, actor);
                invoke('GameServer/Bot/AI/BotPartyChat').cancelExpectedSkillResult(session, actor, creature, skill);
                return;
            }

            const targets = this.resolveSkillTargets(session, actor, creature, skill);

            if (targets.length === 0) {
                actor.state.setCasts(false);
                invoke('GameServer/Bot/AI/BotSupportPlanner').cancelSupportCast(session, actor);
                invoke('GameServer/Bot/AI/BotPartyChat').cancelExpectedSkillResult(session, actor, creature, skill);
                return;
            }

            if (magicSkill) {
                session.dataSendToMeAndOthers(ServerResponse.magicSkillLaunched(actor, skill, targets), actor);
            }

            actor.setMp(actor.fetchMp() - mpCost);
            if (skill.fetchConsumedHp() > 0) {
                actor.setHp(Math.max(1, actor.fetchHp() - skill.fetchConsumedHp()));
            }
            actor.statusUpdateVitals(actor);

            const shotState = this.captureShotState(actor);
            if (RaidCurse.skillBlocked(session, actor, targets, skill)) {
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

            targets.forEach((target) => {
                this.restoreShotState(actor, shotState);
                const outcome = SkillEffects.execute(session, actor, target, skill, {
                    attack: this,
                    magicSkill
                });
                // Chat confirmations are emitted only after the authoritative
                // skill result exists. A queued, interrupted, resisted, or
                // stack-rejected cast must never claim success to the party.
                invoke('GameServer/Bot/AI/BotPartyChat').confirmSkillResult(session, actor, target, skill, outcome);
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
                    this.hit(session, actor, target, outcome.damage);
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
            });
            this.clearLoadedShot(actor, magicSkill);
            actor.state.setCasts(false);
            invoke('GameServer/Bot/AI/BotSupportPlanner').finishSupportCast(session, actor, skill);

            // Start replenish
            actor.automation.replenishVitals(actor);

            if (invoke('GameServer/Bot/AI/PartyCompanionService').startQueuedGroundPickup(session)) {
                return;
            }

            if (this.queue.name) {
                this.dequeueEvent(session);
                return;
            }

        }, skill.fetchCalculatedHitTime());

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

        if (skill.fetchTargetKind?.() === 'party') {
            const PartyAwareness = invoke('GameServer/Bot/AI/PartyAwareness');
            const leaderSession = session?.partyCompanion === true && session.followPlayerSession
                ? session.followPlayerSession
                : session;
            const party = PartyAwareness.partyActors(leaderSession)
                .filter((target) => (
                    this.isValidSkillTarget(target, skill, actor) &&
                    (radius <= 0 || this.distance2d(actor, target) <= radius)
                ));
            if (party.length > 0) return party;
            return this.isValidSkillTarget(primary, skill, actor) &&
                (radius <= 0 || this.distance2d(actor, primary) <= radius)
                ? [primary]
                : [];
        }

        if (sourceTarget === 'aura' && radius > 0 && primary === actor && skill.fetchTargetKind?.() === 'enemy') {
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

        return targets.filter((target) => {
            const id = target?.fetchId?.();
            if (!id || seen.has(id)) return false;
            seen.add(id);

            if (!this.isValidSkillTarget(target, skill, actor)) return false;
            if (this.distance2d(center, target) > radius) return false;
            if (sourceTarget === 'front_area' && !this.isFacing(actor, target, 120)) return false;
            return true;
        });
    }

    fetchSkillTargetsInRadius(actor, locX, locY, radius) {
        const World = invoke('GameServer/World/World');
        if (this.isNpcCombatant(actor)) {
            return (World.user?.sessions || []).map((session) => session?.actor).filter(Boolean);
        }

        return typeof World.fetchNpcsInRadius === 'function'
            ? World.fetchNpcsInRadius(locX, locY, radius)
            : [];
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
        if (skill?.fetchSsBoost && Number(skill.fetchSsBoost()) <= 0) {
            return;
        }

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

    skillUseConditionFailure(actor, skill) {
        const semantic = skill.fetchSemantic?.() || {};
        const condition = semantic.condition || null;
        const summonFailure = SkillEffects.validateSummonUse?.(actor, null, skill);
        if (summonFailure) {
            return summonFailure;
        }

        if (semantic.createItemId) {
            const materialId = Number(semantic.itemConsumeId) || 0;
            const required = Math.max(1, Number(semantic.itemConsumeCount) || 1);
            const material = actor?.backpack?.fetchItems?.().find((item) => Number(item.fetchSelfId?.()) === materialId);
            if (!material || Number(material.fetchAmount?.()) < required) return 'Not enough required items.';
        }

        const requires = semantic.requires || {};
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
        return Math.max(0, Math.floor(cost * EffectStats.multiplier(actor, stat)));
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
        if (magicSkill) {
            const usedSpiritshot = !!actor.spiritshotLoaded;
            const usedBlessedSpiritshot = usedSpiritshot && !!actor.blessedSpiritshotLoaded;
            const semantic = skill.fetchSemantic?.() || {};
            const vulnModifier = traitVulnerabilityModifier(creature, semantic.trait);
            const magicCritRateMultiplier = EffectStats.multiplier(actor, 'mCritRateMul');
            // The legacy combat loop has no baseline magic-critical roll yet. Preserve its
            // established damage output, while allowing C4 effects such as Wild Magic to
            // introduce the sourced roll explicitly.
            const magicCritical = magicCritRateMultiplier > 1
                && Formulas.rollCritical(4 * magicCritRateMultiplier, rng);
            const power = semantic.skillType === C4SkillRules.DEATH_LINK
                ? Formulas.calcDeathLinkPower(skill.fetchPower(), actor.fetchHp?.(), actor.fetchMaxHp?.())
                : skill.fetchPower();
            const damage = Math.round(Formulas.calcMagicDamage(
                magicAtkOverride ?? actor.fetchCollectiveMAtk(),
                power,
                creature.fetchCollectiveMDef(),
                { spiritshot: usedSpiritshot, blessedSpiritshot: usedBlessedSpiritshot, magicCritical }
            ) * vulnModifier);
            this.clearLoadedShot(actor, magicSkill);
            return damage;
        }

        const shield = Formulas.rollShieldUse({
            shieldRate: this.fetchShieldRate(creature),
            dex: creature.fetchDex ? creature.fetchDex() : 0,
            facing: this.isShieldFacing(creature, actor),
            bow: this.isBowAttack(actor)
        }, rng);

        if (shield === Formulas.SHIELD_DEFENSE_PERFECT_BLOCK) {
            this.clearLoadedShot(actor, magicSkill);
            return 1;
        }

        const usedSoulshot = !!actor.soulshotLoaded;
        const shieldPDef = shield === Formulas.SHIELD_DEFENSE_SUCCEED ? this.fetchShieldPDef(creature) : 0;
        const semantic = skill.fetchSemantic?.() || {};
        const position = this.targetPosition(actor, creature);
        const weaponPAtkRnd = actor.backpack?.fetchTotalWeaponPAtkRnd?.() ?? 0;
        const weaponModifier = incomingWeaponVulnerabilityModifier(creature, {
            bow: semantic.trait === 'bow' || this.isBowAttack(actor),
            blunt: this.isBluntAttack(actor),
            dagger: semantic.trait === 'dagger' || this.isDaggerAttack(actor)
        });
        const damageFormula = semantic.skillType === C4SkillRules.BLOW
            ? Formulas.calcBlowDamage.bind(Formulas)
            : Formulas.calcPhysicalDamage.bind(Formulas);
        const damage = Math.round(damageFormula(
            actor.fetchCollectivePAtk(),
            weaponPAtkRnd,
            creature.fetchCollectivePDef() + shieldPDef,
            skill.fetchPower(),
            {
                soulshot: usedSoulshot,
                criticalDamageMultiplier: EffectStats.multiplier(actor, 'pCritDamageMul')
                    * EffectStats.situationalMultiplier(actor, 'pCritDamageMul', position),
                criticalDamageAdd: EffectStats.add(actor, 'pCritDamageAdd'),
                rng
            }
        ) * weaponModifier * physicalUndeadModifier(actor, creature));
        this.clearLoadedShot(actor, magicSkill);
        return damage;
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

        const pAtk  = actor.fetchCollectivePAtk();
        const pRand = actor.backpack.fetchTotalWeaponPAtkRnd() ?? 0;
        const shieldPDef = this.fetchShieldPDef(creature);
        const shield = Formulas.rollShieldUse({
            shieldRate: this.fetchShieldRate(creature),
            dex: creature.fetchDex ? creature.fetchDex() : 0,
            facing: this.isShieldFacing(creature, actor),
            bow: this.isBowAttack(actor)
        }, rng);
        const shielded = shield > Formulas.SHIELD_DEFENSE_FAILED;
        const pDef = creature.fetchCollectivePDef() + (shield === Formulas.SHIELD_DEFENSE_SUCCEED ? shieldPDef : 0);
        const position = this.targetPosition(actor, creature);
        const critical = Formulas.rollCritical(this.fetchSituationalCriticalRate(actor, creature), rng);
        const weaponModifier = incomingWeaponVulnerabilityModifier(creature, {
            bow: this.isBowAttack(actor),
            blunt: this.isBluntAttack(actor)
        });
        const damage = shield === Formulas.SHIELD_DEFENSE_PERFECT_BLOCK
            ? 1
            : Math.round(Formulas.calcMeleeDamage(pAtk, pRand, pDef, {
                critical,
                soulshot: usedSoulshot,
                criticalDamageMultiplier: EffectStats.multiplier(actor, 'pCritDamageMul')
                    * EffectStats.situationalMultiplier(actor, 'pCritDamageMul', position),
                criticalDamageAdd: EffectStats.add(actor, 'pCritDamageAdd')
            }) * weaponModifier * physicalUndeadModifier(actor, creature));
        let flags = usedSoulshot ? ServerResponse.attack.soulshotFlags(actor) : 0;

        if (critical) flags |= ServerResponse.attack.HITFLAG_CRIT;
        if (shielded) flags |= ServerResponse.attack.HITFLAG_SHLD;

        return {
            damage,
            flags
        };
    }

    prepareNpcMeleeHit(src, dst, hitLanded, rng = Math.random) {
        if (!hitLanded) {
            return {
                damage: 0,
                flags: ServerResponse.attack.HITFLAG_MISS
            };
        }

        const shieldPDef = this.fetchShieldPDef(dst);
        const shield = Formulas.rollShieldUse({
            shieldRate: this.fetchShieldRate(dst),
            dex: dst.fetchDex ? dst.fetchDex() : 0,
            facing: this.isShieldFacing(dst, src),
            bow: this.isBowAttack(src)
        }, rng);
        const shielded = shield > Formulas.SHIELD_DEFENSE_FAILED;
        const pDef = dst.fetchCollectivePDef() + (shield === Formulas.SHIELD_DEFENSE_SUCCEED ? shieldPDef : 0);
        const critical = Formulas.rollCritical(this.fetchSituationalCriticalRate(src, dst), rng);
        const weaponModifier = incomingWeaponVulnerabilityModifier(dst, {
            bow: this.isBowAttack(src),
            blunt: this.isBluntAttack(src)
        });
        const damage = shield === Formulas.SHIELD_DEFENSE_PERFECT_BLOCK
            ? 1
            : Math.round(Formulas.calcMeleeDamage(src.fetchCollectivePAtk(), 0, pDef, {
                critical,
                criticalDamageMultiplier: EffectStats.multiplier(src, 'pCritDamageMul'),
                criticalDamageAdd: EffectStats.add(src, 'pCritDamageAdd')
            }) * weaponModifier * physicalUndeadModifier(src, dst));
        let flags = 0;

        if (critical) flags |= ServerResponse.attack.HITFLAG_CRIT;
        if (shielded) flags |= ServerResponse.attack.HITFLAG_SHLD;

        return { damage, flags };
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
        const kind = creature?.backpack?.fetchTotalWeaponKind ? creature.backpack.fetchTotalWeaponKind() : this.fetchNpcWeaponKind(creature);
        return kind === 'Weapon.Bow';
    }

    isBluntAttack(creature) {
        const kind = creature?.backpack?.fetchTotalWeaponKind ? creature.backpack.fetchTotalWeaponKind() : this.fetchNpcWeaponKind(creature);
        return kind === 'Weapon.Blunt' || kind === 'Weapon.BigBlunt';
    }

    isDaggerAttack(creature) {
        const kind = creature?.backpack?.fetchTotalWeaponKind ? creature.backpack.fetchTotalWeaponKind() : this.fetchNpcWeaponKind(creature);
        return kind === 'Weapon.Knife';
    }

    fetchNpcWeaponKind(creature) {
        if (!creature?.fetchWeapon || !DataCache.items) return '';
        const item = DataCache.items.find((entry) => Number(entry.selfId) === Number(creature.fetchWeapon()));
        return item?.template?.kind || '';
    }

    fetchNpcShieldItem(creature) {
        if (!creature?.fetchShield || !DataCache.items) return null;
        const shieldId = Number(creature.fetchShield());
        if (!shieldId) return null;
        return DataCache.items.find((entry) => Number(entry.selfId) === shieldId) || null;
    }

    applyDamageAbsorb(session, actor, damage) {
        if (this.isBowAttack(actor)) return 0;

        const absorbPercent = EffectStats.add(actor, 'absorbDam');
        if (absorbPercent <= 0) return 0;

        const maxHp = Number(actor.fetchMaxHp?.()) || 0;
        const currentHp = Number(actor.fetchHp?.()) || 0;
        const maxCanAbsorb = Math.max(0, maxHp - currentHp);
        const absorbDamage = Math.min(maxCanAbsorb, Math.floor(absorbPercent / 100 * (Number(damage) || 0)));
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
                invoke(path.actor).abortCombatState(src.session, src);
            }
            return true;
        }
        return false;
    }

    hit(session, actor, creature, hit) {
        ConsoleText.transmit(session, ConsoleText.caption.actorHit, [{ kind: ConsoleText.kind.number, value: hit }]);
        this.tryBreakCast(creature, hit);

        if (creature.fetchId() >= 2000000) {
            if (actor?.fetchKind) {
                if (creature?.session) {
                    creature.session.incomingThreatId = actor.fetchId();
                    creature.session.incomingThreatAt = Date.now();
                }
                invoke(path.actor).receivedHit(session, creature, hit);
                return;
            }

            // Flag the attacker when hitting another player/bot
            actor.setPvpFlag(1);
            session.dataSendToMe(ServerResponse.userInfo(actor));
            session.dataSendToOthers(ServerResponse.charInfo(actor), actor);
            session.dataSendToOthers(ServerResponse.relationChanged(actor), actor);

            if (session.pvpFlagTimer) {
                clearTimeout(session.pvpFlagTimer);
            }
            session.pvpFlagTimer = setTimeout(() => {
                actor.setPvpFlag(0);
                session.dataSendToMe(ServerResponse.userInfo(actor));
                session.dataSendToOthers(ServerResponse.charInfo(actor), actor);
                session.dataSendToOthers(ServerResponse.relationChanged(actor), actor);
                session.pvpFlagTimer = undefined;
            }, 15000); // 15 seconds flag duration

            invoke(path.actor).receivedHit(session, creature, hit);
        }
        else {
            invoke(path.npc).receivedHit(session, actor, creature, hit);
        }

        this.applyReflectedDamage(session, actor, creature, hit);
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
        const reflectPercent = Math.max(0, Number(EffectStats.add(creature, 'reflectDam')) || 0);
        const reflected = Math.floor(Math.max(0, Number(hit) || 0) * reflectPercent / 100);
        if (reflected <= 0) return;

        if (Number(actor.fetchId?.()) >= 2000000) {
            invoke(path.actor).receivedHit(session, actor, reflected);
        } else {
            invoke(path.npc).receivedHit(session, creature, actor, reflected);
        }
    }
}

const ELEMENTAL_DAMAGE_TRAITS = new Set(['fire', 'water', 'wind', 'earth', 'holy', 'dark']);

function traitVulnerabilityModifier(target, trait) {
    if (!ELEMENTAL_DAMAGE_TRAITS.has(trait)) return 1;
    return EffectStats.multiplier(target, `${trait}Vuln`, 1);
}

function incomingWeaponVulnerabilityModifier(target, { bow = false, blunt = false, dagger = false } = {}) {
    if (bow) return EffectStats.multiplier(target, 'bowWpnVuln', 1);
    if (blunt) return EffectStats.multiplier(target, 'bluntWpnVuln', 1);
    if (dagger) return EffectStats.multiplier(target, 'daggerWpnVuln', 1);
    return 1;
}

function physicalUndeadModifier(attacker, target) {
    const undead = target?.fetchUndead?.() === true || target?.model?.undead === true;
    return undead ? EffectStats.multiplier(attacker, 'pAtkUndeadMul') : 1;
}

module.exports = Attack;
module.exports.weaponMaskFor = weaponMaskFor;
