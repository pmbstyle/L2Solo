const SpeckMath      = invoke('GameServer/SpeckMath');
const World          = invoke('GameServer/World/World');
const ServerResponse = invoke('GameServer/Network/Response');
const BotRoles       = invoke('GameServer/Bot/AI/BotRoles');
const BotBuffs       = invoke('GameServer/Bot/AI/BotBuffs');
const BotSkillCapabilities = invoke('GameServer/Bot/AI/BotSkillCapabilities');
const PartyAwareness = invoke('GameServer/Bot/AI/PartyAwareness');
const PartyCompanionService = invoke('GameServer/Bot/AI/PartyCompanionService');
const EffectStore    = invoke('GameServer/Effects/EffectStore');

const FOLLOW_RUN_DISTANCE = 250;
const FOLLOW_RETARGET_DISTANCE = 900;
const FOLLOW_TARGET_DRIFT = 650;
const FOLLOW_TELEPORT_DISTANCE = 4500;

function ratio(value, max) {
    if (!max) return 0;
    return Math.max(0, Math.min(1, value / max));
}

function isBusy(bot) {
    return !!(bot.state.fetchTowards() || bot.state.fetchHits() || bot.state.fetchCasts());
}

function point(actor) {
    return new SpeckMath.Point3D(actor.fetchLocX(), actor.fetchLocY(), actor.fetchLocZ());
}

function loc(actor) {
    return { locX: actor.fetchLocX(), locY: actor.fetchLocY(), locZ: actor.fetchLocZ() };
}

function distance2d(a, b) {
    const dx = a.locX - b.locX;
    const dy = a.locY - b.locY;
    return Math.sqrt((dx * dx) + (dy * dy));
}

function shouldKeepCurrentFollowMove(session, bot, player, leaderDistance) {
    const isMoving = !!session.moveTimer || bot.state.fetchTowards();
    if (!isMoving) return false;
    if ((session.stuckTicks || 0) >= 2) return false;
    if (leaderDistance > FOLLOW_RETARGET_DISTANCE) return false;

    const target = session.lastFollowMoveTarget;
    if (!target) return false;
    return distance2d(target, loc(player)) <= FOLLOW_TARGET_DRIFT;
}

function standUp(session, bot) {
    if (!bot.state.fetchSeated()) return false;
    bot.state.setSeated(false);
    session.dataSendToOthers(ServerResponse.sitAndStand(bot), bot);
    return true;
}

function sitDown(session, bot) {
    if (bot.state.fetchSeated()) return false;
    bot.state.setSeated(true);
    session.dataSendToOthers(ServerResponse.sitAndStand(bot), bot);
    return true;
}

function recordRoleDecision(session, bot, action, reason, extra = {}) {
    const role = BotRoles.inferRole(bot);
    const previous = session.roleDecision;
    const current = {
        role,
        action,
        reason,
        at: Date.now(),
        ...extra
    };

    session.roleDecision = current;

    const signature = `${role}:${action}:${reason}`;
    const shouldLog = !previous ||
        `${previous.role}:${previous.action}:${previous.reason}` !== signature ||
        current.at - (session.lastRoleDecisionLogAt || 0) > 10000;

    if (shouldLog) {
        session.lastRoleDecisionLogAt = current.at;
        console.info("BotRole :: %s %s/%s (%s)", bot.fetchName(), action, reason, role);
    }
}

function castSkillOn(session, bot, Generics, target, skillId, ctrl) {
    session.currentTargetId = target.fetchId();
    bot.select({ id: target.fetchId() });
    Generics.skillExec(session, bot, { id: target.fetchId(), selfId: skillId, ctrl });
}

function partyActorIds(leaderSession) {
    return new Set(PartyAwareness.partyActors(leaderSession)
        .map((actor) => actor.fetchId())
        .filter((id) => id !== null && id !== undefined));
}

function partyAggroCount(leaderSession) {
    const ids = partyActorIds(leaderSession);
    if (ids.size === 0) return 0;

    const seen = new Set();
    return PartyAwareness.partyActors(leaderSession).flatMap((actor) => (
        World.fetchNpcsInRadius(actor.fetchLocX(), actor.fetchLocY(), 900)
    ))
        .filter((npc) => {
            const id = npc.fetchId?.() || npc;
            if (seen.has(id)) return false;
            seen.add(id);
            return true;
        })
        .filter((npc) => npc.fetchAttackable() && !npc.isDead() && ids.has(npc.fetchDestId()))
        .length;
}

function unsafeSupportMoment(session, bot, target, activeMobs) {
    return !!session.currentTargetId ||
        !!target.fetchDestId() ||
        activeMobs > 0 ||
        isBusy(bot);
}

function partyMembersInSupportRange(leaderSession, bot, maxDistance = 900) {
    return PartyAwareness.partySessions(leaderSession)
        .filter((memberSession) => memberSession.actor && !memberSession.actor.isDead?.())
        .map((memberSession) => ({
            session: memberSession,
            actor: memberSession.actor,
            hpRatio: ratio(memberSession.actor.fetchHp(), memberSession.actor.fetchMaxHp()),
            mpRatio: ratio(memberSession.actor.fetchMp(), memberSession.actor.fetchMaxMp()),
            distance: point(bot).distance(point(memberSession.actor))
        }))
        .filter((entry) => entry.distance <= maxDistance);
}

function weakestPartyMember(leaderSession, bot, maxDistance = 900) {
    return partyMembersInSupportRange(leaderSession, bot, maxDistance)
        .filter((entry) => entry.actor !== bot)
        .sort((a, b) => a.hpRatio - b.hpRatio)[0] || null;
}

function weakestPartyVitals(leaderSession, bot) {
    return partyMembersInSupportRange(leaderSession, bot)
        .reduce((lowest, entry) => !lowest || entry.hpRatio < lowest.hpRatio ? entry : lowest, null);
}

function nextSupportBuffTarget(leaderSession, bot) {
    return partyMembersInSupportRange(leaderSession, bot)
        .sort((a, b) => {
            const aRank = a.session === leaderSession ? 0 : (a.actor === bot ? 2 : 1);
            const bRank = b.session === leaderSession ? 0 : (b.actor === bot ? 2 : 1);
            return aRank - bRank;
        })
        .flatMap((entry) => Object.keys(BotBuffs.SUPPORT_BUFFS)
            .filter((buff) => BotBuffs.needsBuff(entry.actor, buff))
            .map((buff) => ({
                ...entry,
                buff,
                skill: BotSkillCapabilities.buffSkill(bot, buff)
            })))
        .filter((entry) => entry.skill)
        .find((entry) => entry.buff) || null;
}

function pullBlockReason(session, botVitals, partyVitals, activeMobs) {
    if (session.autoTaunt === false) return 'manual_pull_off';
    if (session.botStay) return 'stay_order';
    if (session.currentTargetId) return 'already_assisting';
    if (partyVitals?.hpRatio < 0.65) return 'party_low_hp';
    if (botVitals.hpRatio < 0.55) return 'tank_low_hp';
    if (botVitals.mpRatio < 0.25) return 'save_mp';
    if (activeMobs >= 2) return 'active_mobs';
    return null;
}

function assistActionForRole(role) {
    if (role === 'archer' || role === 'mage') return 'ranged_assist';
    if (role === 'buffer') return 'buff_support';
    if (role === 'dagger') return 'flank_target';
    return 'assist_leader';
}

function assistReasonForRole(role) {
    if (role === 'dagger') return 'close_assist';
    return 'leader_target';
}

function followTargetFor(session, player) {
    return PartyCompanionService.formationTargetFor(session) || {
        locX: player.fetchLocX(),
        locY: player.fetchLocY(),
        locZ: player.fetchLocZ()
    };
}

function supportBuffPhrase(buffType, playerName) {
    if (buffType === 'might') return "Might on " + playerName + ". Hit harder!";
    if (buffType === 'shield') return "Shield on " + playerName + ". Stay sturdy.";
    if (buffType === 'haste') return "Haste on " + playerName + ". Keep the pressure up!";
    if (buffType === 'windwalk') return "Wind Walk on " + playerName + ". Move fast.";
    return "Buffing " + playerName + ".";
}

module.exports = {
    tick(session, bot, Generics, BotAI) {
        const playerSession = session.followPlayerSession;
        if (session.partyCompanion !== true) {
            session.plan = 'hunting';
            session.followPlayerSession = null;
            session.roleDecision = null;
            return;
        }

        if (!playerSession || !playerSession.actor || !playerSession.actor.fetchIsOnline()) {
            session.plan = 'hunting';
            session.roleDecision = null;
            BotAI.say(session, "My companion has disconnected. Heading back to hunt.");
            return;
        }

        const player = playerSession.actor;
        const role = BotRoles.inferRole(bot);
        const distance = point(bot).distance(point(player));
        const partySettings = PartyCompanionService.getSettings(playerSession);
        const combatMode = partySettings.combatMode || 'assist';
        const rawPartyThreat = PartyAwareness.findThreatTargetingParty(playerSession);
        const partyThreat = combatMode === 'passive' && rawPartyThreat?.targetId !== bot.fetchId()
            ? null
            : rawPartyThreat;
        const leaderTargetId = combatMode === 'assist'
            ? PartyAwareness.leaderCombatTargetId(playerSession)
            : undefined;
        const impairments = EffectStore.impairments(bot);

        if (impairments.disabled) {
            session.currentTargetId = undefined;
            bot.unselect();
            recordRoleDecision(session, bot, 'disabled', 'debuff_control');
            return;
        }

        const currentLoc = { x: bot.fetchLocX(), y: bot.fetchLocY() };
        if (!session.lastTickLoc) {
            session.lastTickLoc = currentLoc;
            session.stuckTicks = 0;
        }

        const movedDist = Math.sqrt((currentLoc.x - session.lastTickLoc.x) ** 2 + (currentLoc.y - session.lastTickLoc.y) ** 2);
        session.lastTickLoc = currentLoc;

        const isMoving = !!session.moveTimer || bot.state.fetchTowards();
        if (isMoving && movedDist < 10) {
            session.stuckTicks = (session.stuckTicks || 0) + 1;
        } else {
            session.stuckTicks = 0;
        }

        if (bot.state.fetchSeated() && (partyThreat || leaderTargetId || distance > FOLLOW_RUN_DISTANCE)) {
            session.plan = 'following';
            session.currentTargetId = partyThreat?.actor?.fetchId?.() || leaderTargetId || undefined;
            standUp(session, bot);
            recordRoleDecision(
                session,
                bot,
                partyThreat || leaderTargetId ? assistActionForRole(role) : 'follow_leader',
                partyThreat ? 'party_under_attack' : (leaderTargetId ? assistReasonForRole(role) : 'leader_moved')
            );
            return;
        }

        if (impairments.rooted && !partyThreat && !leaderTargetId && distance > FOLLOW_RUN_DISTANCE) {
            recordRoleDecision(session, bot, 'hold_position', 'rooted');
            return;
        }

        if (session.stuckTicks >= 3 || distance > FOLLOW_TELEPORT_DISTANCE) {
            session.stuckTicks = 0;
            recordRoleDecision(session, bot, 'follow_leader', distance > FOLLOW_TELEPORT_DISTANCE ? 'catch_up' : 'unstuck');
            const TeleportTo = invoke('GameServer/Actor/Generics/TeleportTo');
            if (TeleportTo && typeof TeleportTo === 'function') {
                const targetLoc = {
                    ...followTargetFor(session, player)
                };
                TeleportTo(session, bot, targetLoc);
                if (Math.random() < 0.20) {
                    BotAI.say(session, "Whew, caught up with you!");
                }
            }
            return;
        }

        const botVitals = {
            hpRatio: ratio(bot.fetchHp(), bot.fetchMaxHp()),
            mpRatio: ratio(bot.fetchMp(), bot.fetchMaxMp())
        };
        const leaderVitals = {
            hpRatio: ratio(player.fetchHp(), player.fetchMaxHp()),
            mpRatio: ratio(player.fetchMp(), player.fetchMaxMp())
        };
        const partyVitals = weakestPartyVitals(playerSession, bot) || leaderVitals;
        const leaderSeated = player.state?.fetchSeated?.() === true;
        const botRecovering = botVitals.hpRatio < 0.95 || botVitals.mpRatio < 0.95;

        if (!partyThreat && !leaderTargetId && leaderSeated) {
            session.currentTargetId = undefined;
            bot.unselect();

            if (distance > FOLLOW_RUN_DISTANCE) {
                standUp(session, bot);
                recordRoleDecision(session, bot, 'rest_with_leader', 'move_near_sitting_leader');
                if (!shouldKeepCurrentFollowMove(session, bot, player, distance)) {
                    const followTarget = followTargetFor(session, player);
                    session.lastFollowMoveTarget = followTarget;
                    bot.moveTo({
                        from: { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() },
                        to: followTarget
                    });
                }
                return;
            }

            session.lastFollowMoveTarget = null;
            sitDown(session, bot);
            recordRoleDecision(session, bot, 'rest_with_leader', 'leader_sitting');
            return;
        }

        if (!partyThreat && !leaderTargetId && bot.state.fetchSeated() && !leaderSeated && !botRecovering) {
            standUp(session, bot);
            recordRoleDecision(session, bot, 'follow_leader', 'leader_stood_ready');
            return;
        }

        if (!partyThreat && !leaderTargetId && (botVitals.hpRatio < 0.30 || botVitals.mpRatio < 0.15)) {
            session.plan = 'resting';
            session.currentTargetId = undefined;
            bot.unselect();
            sitDown(session, bot);
            recordRoleDecision(session, bot, botVitals.hpRatio < 0.30 ? 'recover_hp' : 'save_mp', 'resting');
            BotAI.say(session, "Phew! My HP/MP is low. Sitting down to recover.");
            return;
        }

        let acted = false;
        let keepRoleDecision = false;

        const buffsNeedRefresh = BotBuffs.needsNewbieRefresh(bot);
        if (buffsNeedRefresh) {
            const unsafeToRefresh = unsafeSupportMoment(session, bot, player, partyAggroCount(playerSession));

            if (unsafeToRefresh) {
                recordRoleDecision(session, bot, 'refresh_buffs', 'wait_for_safe_moment', {
                    missingBuffs: BotBuffs.missingNewbieBuffs(bot, BotBuffs.REFRESH_THRESHOLD_MS)
                });
                keepRoleDecision = true;
            } else {
                session.preBuffLocation = { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() };
                session.preBuffPlan = 'following';
                session.resumeAfterBuff = {
                    plan: 'following',
                    followPlayerSession: playerSession,
                    partyCompanion: true,
                    botStay: session.botStay === true,
                    stayLocation: session.stayLocation ? { ...session.stayLocation } : null,
                    role
                };
                session.plan = 'getting_buffed';
                session.currentTargetId = undefined;
                bot.unselect();
                bot.automation.abortAll(bot);
                recordRoleDecision(session, bot, 'refresh_buffs', 'newbie_blessing', {
                    missingBuffs: BotBuffs.missingNewbieBuffs(bot, BotBuffs.REFRESH_THRESHOLD_MS)
                });
                BotAI.say(session, "My newbie buffs are fading. Refreshing quickly, then I'll return.");
                return;
            }
        }

        const supportBuffTarget = nextSupportBuffTarget(playerSession, bot);
        if (!acted && BotRoles.canBuff(bot) && supportBuffTarget) {
            const activeMobs = partyAggroCount(playerSession);
            if (unsafeSupportMoment(session, bot, supportBuffTarget.actor, activeMobs)) {
                recordRoleDecision(session, bot, 'buff_party', 'wait_for_safe_moment', {
                    buff: supportBuffTarget.buff,
                    targetId: supportBuffTarget.actor.fetchId(),
                    activeMobs
                });
                keepRoleDecision = true;
            } else if (impairments.silenced) {
                recordRoleDecision(session, bot, 'save_mp', 'silenced');
                keepRoleDecision = true;
            } else if (bot.fetchMp() < supportBuffTarget.skill.fetchConsumedMp() || botVitals.mpRatio < 0.35) {
                recordRoleDecision(session, bot, 'save_mp', 'low_mp_for_buff', {
                    buff: supportBuffTarget.buff,
                    targetId: supportBuffTarget.actor.fetchId()
                });
                keepRoleDecision = true;
            } else {
                acted = true;
                castSkillOn(session, bot, Generics, supportBuffTarget.actor, supportBuffTarget.skill.fetchSelfId(), false);
                recordRoleDecision(session, bot, 'buff_party', supportBuffTarget.buff, {
                    buff: supportBuffTarget.buff,
                    skillId: supportBuffTarget.skill.fetchSelfId(),
                    targetId: supportBuffTarget.actor.fetchId()
                });
                if (Math.random() < 0.30) {
                    BotAI.say(session, supportBuffPhrase(supportBuffTarget.buff, supportBuffTarget.actor.fetchName()));
                }
            }
        }

        if (Math.random() < 0.015) {
            const chatterPhrases = [
                "Nice combat, leader!",
                "Following you! Let's get some good exp.",
                "My mana is looking good, keep pulling!",
                "Are we going to Dion or Gludio next?",
                "Lineage 2 is so nostalgic, love this party.",
                "Anyone got any healing potions?",
                "I've got your back, don't worry!",
                "Let's clean up this spawn!"
            ];
            const classPhrases = {
                healer: [
                    "Healing is ready. Watch your HP!",
                    "Don't worry about HP, I'm casting heals.",
                    "Mana is okay, but don't pull the whole room!"
                ],
                tank: [
                    "I will take the aggro, stay behind me!",
                    "Aggression is ready! Pulling them off you.",
                    "I'm tanking this beast!"
                ],
                buffer: [
                    "I'll keep the party buffed.",
                    "Buffs are ready when we have a safe moment.",
                    "Save a little mana before the next pull."
                ],
                dagger: [
                    "I'll stay close and hit their weak side.",
                    "Mark a target and I'll get in close.",
                    "No bow tricks from me, just blades."
                ]
            };
            const pool = chatterPhrases.concat(classPhrases[role] || []);
            const text = pool[Math.floor(Math.random() * pool.length)];
            BotAI.say(session, text);
        }

        if (role === 'healer') {
            const skill = BotSkillCapabilities.healSkill(bot);
            const canCast = !!skill && bot.fetchMp() >= skill.fetchConsumedMp() && !isBusy(bot) && !impairments.silenced;
            const woundedPartyMember = weakestPartyMember(playerSession, bot);

            if (woundedPartyMember?.hpRatio < 0.45 && canCast) {
                acted = true;
                recordRoleDecision(session, bot, 'heal_party', 'emergency_heal', { targetId: woundedPartyMember.actor.fetchId() });
                castSkillOn(session, bot, Generics, woundedPartyMember.actor, skill.fetchSelfId(), false);
                if (Math.random() < 0.15) {
                    BotAI.say(session, "Emergency heal on " + woundedPartyMember.actor.fetchName() + "!");
                }
            } else if (woundedPartyMember?.hpRatio < 0.70 && botVitals.mpRatio >= 0.35 && canCast) {
                acted = true;
                recordRoleDecision(session, bot, 'heal_party', 'top_off', { targetId: woundedPartyMember.actor.fetchId() });
                castSkillOn(session, bot, Generics, woundedPartyMember.actor, skill.fetchSelfId(), false);
                if (Math.random() < 0.15) {
                    BotAI.say(session, "Healing " + woundedPartyMember.actor.fetchName() + "!");
                }
            } else if (woundedPartyMember?.hpRatio < 0.70 && botVitals.mpRatio < 0.35) {
                recordRoleDecision(session, bot, 'save_mp', woundedPartyMember.hpRatio < 0.45 ? 'low_mp_emergency' : 'party_not_critical');
                keepRoleDecision = true;
            } else if (botVitals.hpRatio < 0.55 && botVitals.mpRatio >= 0.25 && canCast) {
                acted = true;
                recordRoleDecision(session, bot, 'heal_self', 'self_preservation', { targetId: bot.fetchId() });
                castSkillOn(session, bot, Generics, bot, skill.fetchSelfId(), false);
                if (Math.random() < 0.15) {
                    BotAI.say(session, "Healing myself!");
                }
            } else if (impairments.silenced) {
                recordRoleDecision(session, bot, 'save_mp', 'silenced');
                keepRoleDecision = true;
            } else if (botVitals.mpRatio < 0.25) {
                recordRoleDecision(session, bot, 'save_mp', 'low_mp');
                keepRoleDecision = true;
            } else if (!skill && woundedPartyMember?.hpRatio < 0.70) {
                recordRoleDecision(session, bot, 'cannot_heal', 'no_learned_heal');
                keepRoleDecision = true;
            }
        }

        if (!acted && role === 'tank') {
            const nearbyNpcs = World.fetchNpcsInRadius(bot.fetchLocX(), bot.fetchLocY(), 800);
            const monsterToAggro = partyThreat?.type === 'npc'
                ? partyThreat.actor
                : nearbyNpcs.find((npc) => npc.fetchAttackable() && !npc.isDead() && partyActorIds(playerSession).has(npc.fetchDestId()));

            if (monsterToAggro) {
                const skill = BotSkillCapabilities.aggressionSkill(bot);
                if (skill && bot.fetchMp() >= skill.fetchConsumedMp() && !isBusy(bot)) {
                    acted = true;
                    recordRoleDecision(session, bot, 'protect_leader', 'leader_targeted', { targetId: monsterToAggro.fetchId() });
                    castSkillOn(session, bot, Generics, monsterToAggro, skill.fetchSelfId(), true);
                    if (Math.random() < 0.20) {
                        BotAI.say(session, "Hey, " + monsterToAggro.fetchName() + "! Attack me instead!");
                    }
                } else if (!skill) {
                    recordRoleDecision(session, bot, 'cannot_taunt', 'no_learned_aggression');
                    keepRoleDecision = true;
                } else if (botVitals.mpRatio < 0.25) {
                    recordRoleDecision(session, bot, 'save_mp', 'low_mp_for_taunt');
                    keepRoleDecision = true;
                }
            }
        }

        if (!acted && role === 'tank') {
            const activeMobs = partyAggroCount(playerSession);
            const blockReason = pullBlockReason(session, botVitals, partyVitals, activeMobs);

            if (blockReason) {
                recordRoleDecision(session, bot, 'avoid_overpull', blockReason, { activeMobs });
                keepRoleDecision = true;
            } else {
                const nearbyNpcs = World.fetchNpcsInRadius(player.fetchLocX(), player.fetchLocY(), 900);
                let targetMonster = null;
                let closestDist = 900;

                for (const npc of nearbyNpcs) {
                    if (npc.fetchAttackable() && !npc.isDead() && npc.fetchDestId() === undefined) {
                        const distToBot = point(bot).distance(point(npc));
                        if (distToBot < closestDist) {
                            closestDist = distToBot;
                            targetMonster = npc;
                        }
                    }
                }

                if (targetMonster) {
                    const skill = BotSkillCapabilities.aggressionSkill(bot);
                    if (skill && bot.fetchMp() >= skill.fetchConsumedMp() && !isBusy(bot)) {
                        acted = true;
                        recordRoleDecision(session, bot, 'pull_target', 'safe_pull', {
                            targetId: targetMonster.fetchId(),
                            activeMobs
                        });
                        castSkillOn(session, bot, Generics, targetMonster, skill.fetchSelfId(), true);
                        if (Math.random() < 0.30) {
                            BotAI.say(session, "Pulling " + targetMonster.fetchName() + " to the group!");
                        }
                    } else if (!skill) {
                        recordRoleDecision(session, bot, 'avoid_pull', 'no_learned_aggression');
                        keepRoleDecision = true;
                    }
                }
            }
        }

        if (!acted && partyThreat?.actor) {
            const target = partyThreat.actor;
            const targetId = target.fetchId();

            if (session.currentTargetId !== targetId) {
                session.currentTargetId = targetId;
                bot.select({ id: targetId });
                recordRoleDecision(session, bot, assistActionForRole(role), 'party_under_attack', {
                    targetId,
                    targetType: partyThreat.type,
                    protectedId: partyThreat.targetId
                });
                if (Math.random() < 0.20) {
                    BotAI.say(session, "I'm helping the party!");
                }
            }

            if (!isBusy(bot)) {
                if (partyThreat.type === 'player') {
                    BotAI.executePvPCombat(session, bot, target, Generics);
                } else {
                    BotAI.executeCombat(session, bot, target, Generics);
                }
            }
            acted = true;
        }

        if (!acted) {
            const playerTargetId = leaderTargetId;
            if (playerTargetId && playerTargetId !== bot.fetchId() && playerTargetId !== player.fetchId()) {
                acted = true;
                World.fetchUser(playerTargetId).then((user) => {
                    if (PartyAwareness.leaderCombatTargetId(playerSession) !== playerTargetId) return;
                    if (session.currentTargetId && session.currentTargetId !== playerTargetId) return;
                    const targetIsTeammate = user.session && (
                        user.session === playerSession ||
                        (user.session.followPlayerSession === playerSession && user.session.partyCompanion === true)
                    );

                    const isAttackablePvPTarget = user.fetchKarma() > 0 || user.fetchPvpFlag() > 0;

                    if (!user.state.fetchDead() && !targetIsTeammate && isAttackablePvPTarget) {
                        if (session.botStay && session.stayLocation) {
                            const stayDist = new SpeckMath.Point3D(session.stayLocation.locX, session.stayLocation.locY, session.stayLocation.locZ)
                                .distance(new SpeckMath.Point3D(user.fetchLocX(), user.fetchLocY(), user.fetchLocZ()));
                            if (stayDist > 900) {
                                recordRoleDecision(session, bot, 'hold_position', 'stay_order');
                                return;
                            }
                        }

                        if (session.currentTargetId !== playerTargetId) {
                            session.currentTargetId = playerTargetId;
                            bot.select({ id: playerTargetId });
                            recordRoleDecision(session, bot, assistActionForRole(role), 'pvp_target', { targetId: playerTargetId });
                            if (Math.random() < 0.20) {
                                BotAI.say(session, "Assisting you in PvP! Attacking " + user.fetchName() + "!");
                            }
                        }
                        if (isBusy(bot)) {
                            return;
                        }
                        BotAI.executePvPCombat(session, bot, user, Generics);
                    } else {
                        if (session.currentTargetId === playerTargetId) {
                            session.currentTargetId = undefined;
                            bot.unselect();
                        }
                    }
                }).catch(() => {
                    World.fetchNpc(playerTargetId).then((npc) => {
                        if (PartyAwareness.leaderCombatTargetId(playerSession) !== playerTargetId) return;
                        if (session.currentTargetId && session.currentTargetId !== playerTargetId) return;
                        if (npc.fetchAttackable() && !npc.isDead()) {
                            if (session.botStay && session.stayLocation) {
                                const stayDist = new SpeckMath.Point3D(session.stayLocation.locX, session.stayLocation.locY, session.stayLocation.locZ)
                                    .distance(new SpeckMath.Point3D(npc.fetchLocX(), npc.fetchLocY(), npc.fetchLocZ()));
                                if (stayDist > 900) {
                                    recordRoleDecision(session, bot, 'hold_position', 'stay_order');
                                    return;
                                }
                            }

                            if (session.currentTargetId !== playerTargetId) {
                                session.currentTargetId = playerTargetId;
                                bot.select({ id: playerTargetId });
                                recordRoleDecision(session, bot, assistActionForRole(role), assistReasonForRole(role), { targetId: playerTargetId });
                                if (Math.random() < 0.20) {
                                    BotAI.say(session, "Assisting you! Smashing that " + npc.fetchName() + "!");
                                }
                            }
                            if (isBusy(bot)) {
                                return;
                            }
                            BotAI.executeCombat(session, bot, npc, Generics);
                        } else {
                            if (session.currentTargetId === playerTargetId) {
                                session.currentTargetId = undefined;
                                bot.unselect();
                            }
                        }
                    }).catch(() => {
                        if (session.currentTargetId === playerTargetId) {
                            session.currentTargetId = undefined;
                            bot.unselect();
                        }
                    });
                });
            } else {
                session.currentTargetId = undefined;
                bot.unselect();
            }
        }

        if (!session.currentTargetId && !acted) {
            if (session.botStay && session.stayLocation) {
                session.lastFollowMoveTarget = null;
                const stayDist = point(bot).distance(new SpeckMath.Point3D(
                    session.stayLocation.locX,
                    session.stayLocation.locY,
                    session.stayLocation.locZ
                ));
                if (!keepRoleDecision) {
                    recordRoleDecision(session, bot, 'hold_position', 'stay_order');
                }
                if (stayDist > 100) {
                    bot.moveTo({
                        from: { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() },
                        to: { locX: session.stayLocation.locX, locY: session.stayLocation.locY, locZ: session.stayLocation.locZ }
                    });
                }
            } else if (distance > FOLLOW_RUN_DISTANCE) {
                if (impairments.rooted) {
                    recordRoleDecision(session, bot, 'hold_position', 'rooted');
                    return;
                }
                if (!keepRoleDecision) {
                    recordRoleDecision(session, bot, 'follow_leader', 'keep_range');
                }
                if (shouldKeepCurrentFollowMove(session, bot, player, distance)) {
                    session.lastFollowMoveHeldAt = Date.now();
                    return;
                }
                const followTarget = followTargetFor(session, player);
                session.lastFollowMoveTarget = followTarget;
                bot.moveTo({
                    from: { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() },
                    to: followTarget
                });
            } else {
                session.lastFollowMoveTarget = null;
                if (!keepRoleDecision) {
                    recordRoleDecision(session, bot, BotRoles.partyRoleStance(role), 'ready');
                }
            }
        }
    }
};
