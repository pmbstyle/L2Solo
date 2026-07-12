const ServerResponse = invoke('GameServer/Network/Response');
const ConsoleText    = invoke('GameServer/ConsoleText');
const Formulas       = invoke('GameServer/Formulas');
const DataCache      = invoke('GameServer/DataCache');
const SkillEffects   = invoke('GameServer/Skills/C4SkillEffects');
const C4SkillRules   = invoke('GameServer/Skills/C4SkillRules');
const EffectStats    = invoke('GameServer/Effects/EffectStats');
const C4EquipmentItemSkills = invoke('GameServer/Items/C4EquipmentItemSkills');

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

        // Auto-consume Soulshot if available in backpack and not already loaded
        if (!actor.soulshotLoaded && actor.backpack && typeof actor.backpack.consumeSoulshot === 'function') {
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
            });
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

            if (this.queue.name) {
                this.dequeueEvent(session);
                return;
            }

            this.meleeHit(session, creature);

        }, speed); // Until end of combat move
    }

    remoteHit(session, creature, skill) {
        const actor = session.actor;
        const corpseTarget = skill.fetchTargetKind?.() === 'corpse_mob';

        if (this.checkParticipants(actor, creature, { allowDeadTarget: corpseTarget })) {
            return;
        }

        if (actor.fetchMp() < skill.fetchConsumedMp()) {
            ConsoleText.transmit(session, ConsoleText.caption.depletedMp);
            return;
        }

        const conditionFailure = this.skillUseConditionFailure(actor, skill);
        if (conditionFailure) {
            this.rejectSkillUseCondition(session, actor, conditionFailure);
            return;
        }

        const magicSkill = this.isMagicSkill(skill);
        this.chargeShotForSkill(session, actor, magicSkill, skill);

        const attackRate = magicSkill ? actor.fetchCollectiveCastSpd() : actor.fetchCollectiveAtkSpd();
        skill.setCalculatedHitTime(Formulas.calcRemoteAtkTime(skill.fetchHitTime(), attackRate));
        session.dataSendToMeAndOthers(ServerResponse.skillStarted(actor, creature.fetchId(), skill), actor);
        session.dataSendToMe(ServerResponse.skillDurationBar(skill.fetchCalculatedHitTime()));
        actor.state.setCasts(true);

        this.queueTimer(() => {
            if (this.checkParticipants(actor, creature, { allowDeadTarget: corpseTarget })) {
                return;
            }

            const targets = this.resolveSkillTargets(session, actor, creature, skill);

            if (targets.length === 0) {
                actor.state.setCasts(false);
                return;
            }

            if (magicSkill) {
                session.dataSendToMeAndOthers(ServerResponse.magicSkillLaunched(actor, skill, targets), actor);
            }

            actor.setMp(actor.fetchMp() - skill.fetchConsumedMp());
            if (skill.fetchConsumedHp() > 0) {
                actor.setHp(Math.max(1, actor.fetchHp() - skill.fetchConsumedHp()));
            }
            actor.statusUpdateVitals(actor);

            const shotState = this.captureShotState(actor);
            targets.forEach((target) => {
                this.restoreShotState(actor, shotState);
                const outcome = SkillEffects.execute(session, actor, target, skill, {
                    attack: this,
                    magicSkill
                });

                if (outcome.damage > 0) {
                    this.hit(session, actor, target, outcome.damage);
                }
                else if (outcome.missed) {
                    ConsoleText.transmit(session, ConsoleText.caption.missedHit);
                }
            });
            this.clearLoadedShot(actor, magicSkill);
            actor.state.setCasts(false);

            // Start replenish
            actor.automation.replenishVitals(actor);

            if (this.queue.name) {
                this.dequeueEvent(session);
                return;
            }

        }, skill.fetchCalculatedHitTime());

        this.queueTimer(() => {
            // TODO: Prohibit same skill use before reuse time
        }, skill.fetchReuseTime());
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
                .filter((target) => this.isValidSkillTarget(target, skill));
            return party.length > 0 ? party : [primary];
        }

        if (sourceTarget === 'aura' && radius > 0 && primary === actor && skill.fetchTargetKind?.() === 'enemy') {
            const World = invoke('GameServer/World/World');
            const nearby = typeof World.fetchNpcsInRadius === 'function'
                ? World.fetchNpcsInRadius(actor.fetchLocX(), actor.fetchLocY(), radius)
                : [];
            return nearby.filter((target) => this.isValidSkillTarget(target, skill) && this.distance2d(actor, target) <= radius);
        }

        if (
            !sourceTarget ||
            radius <= 0 ||
            !['enemy', 'corpse_mob'].includes(skill.fetchTargetKind?.()) ||
            !this.isNpcAreaPrimary(primary, skill)
        ) {
            return [primary];
        }

        const center = sourceTarget === 'area' ? primary : actor;
        const World = invoke('GameServer/World/World');
        const nearby = typeof World.fetchNpcsInRadius === 'function'
            ? World.fetchNpcsInRadius(center.fetchLocX(), center.fetchLocY(), radius)
            : [];
        const targets = [primary, ...nearby];
        const seen = new Set();

        return targets.filter((target) => {
            const id = target?.fetchId?.();
            if (!id || seen.has(id)) return false;
            seen.add(id);

            if (!this.isValidSkillTarget(target, skill)) return false;
            if (this.distance2d(center, target) > radius) return false;
            if (sourceTarget === 'front_area' && !this.isFacing(actor, target, 120)) return false;
            return true;
        });
    }

    isNpcAreaPrimary(target, skill) {
        if (skill.fetchTargetKind?.() === 'corpse_mob') {
            return target?.fetchAttackable?.() === true && target?.isDead?.() === true;
        }

        return target?.fetchAttackable?.() === true;
    }

    isValidSkillTarget(target, skill) {
        if (!target) return false;
        const targetKind = skill.fetchTargetKind?.();

        if (targetKind === 'corpse_mob') {
            return target.fetchAttackable?.() === true && target.isDead?.() === true;
        }

        if (targetKind === 'enemy') {
            return target.fetchAttackable?.() === true && target.state?.fetchDead?.() !== true && target.isDead?.() !== true;
        }

        return target.state?.fetchDead?.() !== true;
    }

    distance2d(src, dst) {
        const dx = (Number(src?.fetchLocX?.()) || 0) - (Number(dst?.fetchLocX?.()) || 0);
        const dy = (Number(src?.fetchLocY?.()) || 0) - (Number(dst?.fetchLocY?.()) || 0);
        return Math.sqrt(dx * dx + dy * dy);
    }

    chargeShotForSkill(session, actor, magicSkill, skill = null) {
        if (skill?.fetchSsBoost && Number(skill.fetchSsBoost()) <= 0) {
            return;
        }

        if (magicSkill) {
            if (!actor.spiritshotLoaded && actor.backpack && typeof actor.backpack.consumeSpiritshot === 'function') {
                actor.backpack.consumeSpiritshot(session, (success, shot = {}) => {
                    if (success) {
                        actor.spiritshotLoaded = true;
                        this.broadcastShotCharge(session, actor, shot.skillId || 2047);
                    }
                });
            }
            return;
        }

        if (!actor.soulshotLoaded && actor.backpack && typeof actor.backpack.consumeSoulshot === 'function') {
            actor.backpack.consumeSoulshot(session, (success, shot = {}) => {
                if (success) {
                    actor.soulshotLoaded = true;
                    this.broadcastShotCharge(session, actor, shot.skillId || 2039);
                }
            });
        }
    }

    skillUseConditionFailure(actor, skill) {
        const condition = skill.fetchSemantic?.().condition || null;
        const summonFailure = SkillEffects.validateSummonUse?.(actor, null, skill);
        if (summonFailure) {
            return summonFailure;
        }

        if (!condition) return null;

        if (condition.actorHpPercentAtMost !== undefined) {
            const maxHp = Number(actor.fetchMaxHp?.()) || 0;
            const hp = Number(actor.fetchHp?.()) || 0;
            if (maxHp > 0 && hp / maxHp * 100 > condition.actorHpPercentAtMost) {
                return `Can only be used when one's own remaining HP is ${condition.actorHpPercentAtMost}% or less.`;
            }
        }

        return null;
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
        const shield = Formulas.rollShieldUse({
            shieldRate: this.fetchShieldRate(creature),
            dex: creature.fetchDex ? creature.fetchDex() : 0,
            facing: this.isFacing(creature, actor),
            bow: this.isBowAttack(actor)
        }, rng);

        if (shield === Formulas.SHIELD_DEFENSE_PERFECT_BLOCK) {
            this.clearLoadedShot(actor, magicSkill);
            return 1;
        }

        if (magicSkill) {
            const usedSpiritshot = !!actor.spiritshotLoaded;
            const usedBlessedSpiritshot = usedSpiritshot && !!actor.blessedSpiritshotLoaded;
            const shieldMDef = shield === Formulas.SHIELD_DEFENSE_SUCCEED ? this.fetchShieldPDef(creature) : 0;
            const semantic = skill.fetchSemantic?.() || {};
            const vulnModifier = traitVulnerabilityModifier(creature, semantic.trait);
            const power = semantic.skillType === C4SkillRules.DEATH_LINK
                ? Formulas.calcDeathLinkPower(skill.fetchPower(), actor.fetchHp?.(), actor.fetchMaxHp?.())
                : skill.fetchPower();
            const damage = Math.round(Formulas.calcMagicDamage(
                magicAtkOverride ?? actor.fetchCollectiveMAtk(),
                power,
                creature.fetchCollectiveMDef() + shieldMDef,
                { spiritshot: usedSpiritshot, blessedSpiritshot: usedBlessedSpiritshot }
            ) * vulnModifier);
            this.clearLoadedShot(actor, magicSkill);
            return damage;
        }

        const usedSoulshot = !!actor.soulshotLoaded;
        const shieldPDef = shield === Formulas.SHIELD_DEFENSE_SUCCEED ? this.fetchShieldPDef(creature) : 0;
        const semantic = skill.fetchSemantic?.() || {};
        const weaponPAtkRnd = actor.backpack?.fetchTotalWeaponPAtkRnd?.() ?? 0;
        const weaponModifier = incomingWeaponVulnerabilityModifier(creature, {
            bow: semantic.trait === 'bow' || this.isBowAttack(actor)
        });
        const damage = Math.round(Formulas.calcPhysicalDamage(
            actor.fetchCollectivePAtk(),
            weaponPAtkRnd,
            creature.fetchCollectivePDef() + shieldPDef,
            skill.fetchPower(),
            { soulshot: usedSoulshot }
        ) * weaponModifier);
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
            facing: this.isFacing(creature, actor),
            bow: this.isBowAttack(actor)
        }, rng);
        const shielded = shield > Formulas.SHIELD_DEFENSE_FAILED;
        const pDef = creature.fetchCollectivePDef() + (shield === Formulas.SHIELD_DEFENSE_SUCCEED ? shieldPDef : 0);
        const critical = Formulas.rollCritical(this.fetchSituationalCriticalRate(actor, creature), rng);
        const weaponModifier = incomingWeaponVulnerabilityModifier(creature, { bow: this.isBowAttack(actor) });
        const damage = shield === Formulas.SHIELD_DEFENSE_PERFECT_BLOCK
            ? 1
            : Math.round(Formulas.calcMeleeDamage(pAtk, pRand, pDef, {
                critical,
                soulshot: usedSoulshot,
                criticalDamageMultiplier: EffectStats.multiplier(actor, 'pCritDamageMul'),
                criticalDamageAdd: EffectStats.add(actor, 'pCritDamageAdd')
            }) * weaponModifier);
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
            facing: this.isFacing(dst, src),
            bow: this.isBowAttack(src)
        }, rng);
        const shielded = shield > Formulas.SHIELD_DEFENSE_FAILED;
        const pDef = dst.fetchCollectivePDef() + (shield === Formulas.SHIELD_DEFENSE_SUCCEED ? shieldPDef : 0);
        const critical = Formulas.rollCritical(this.fetchSituationalCriticalRate(src, dst), rng);
        const weaponModifier = incomingWeaponVulnerabilityModifier(dst, { bow: this.isBowAttack(src) });
        const damage = shield === Formulas.SHIELD_DEFENSE_PERFECT_BLOCK
            ? 1
            : Math.round(Formulas.calcMeleeDamage(src.fetchCollectivePAtk(), 0, pDef, {
                critical,
                criticalDamageMultiplier: EffectStats.multiplier(src, 'pCritDamageMul'),
                criticalDamageAdd: EffectStats.add(src, 'pCritDamageAdd')
            }) * weaponModifier);
        let flags = 0;

        if (critical) flags |= ServerResponse.attack.HITFLAG_CRIT;
        if (shielded) flags |= ServerResponse.attack.HITFLAG_SHLD;

        return { damage, flags };
    }

    fetchShieldPDef(creature) {
        if (creature?.backpack?.fetchTotalShieldPDef) {
            return creature.backpack.fetchTotalShieldPDef();
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
        const stats = C4EquipmentItemSkills.situationalStats(attacker, {
            behindTarget: this.isBehindTarget(attacker, target)
        });
        return (base * (Number(stats.pCritRateMul) || 1)) + (Number(stats.pCritRateAdd) || 0);
    }

    isBowAttack(creature) {
        const kind = creature?.backpack?.fetchTotalWeaponKind ? creature.backpack.fetchTotalWeaponKind() : this.fetchNpcWeaponKind(creature);
        return kind === 'Weapon.Bow';
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

function incomingWeaponVulnerabilityModifier(target, { bow = false } = {}) {
    if (bow) return EffectStats.multiplier(target, 'bowWpnVuln', 1);
    return 1;
}

module.exports = Attack;
