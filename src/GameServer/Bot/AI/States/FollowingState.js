const SpeckMath      = invoke('GameServer/SpeckMath');
const World          = invoke('GameServer/World/World');
const ServerResponse = invoke('GameServer/Network/Response');
const BotRoles       = invoke('GameServer/Bot/AI/BotRoles');
const BotBuffs       = invoke('GameServer/Bot/AI/BotBuffs');
const PartyAwareness = invoke('GameServer/Bot/AI/PartyAwareness');

const SUPPORT_BUFF_MP_COST = 20;
const FOLLOW_RUN_DISTANCE = 250;
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

function standUp(session, bot) {
    if (!bot.state.fetchSeated()) return false;
    bot.state.setSeated(false);
    session.dataSendToOthers(ServerResponse.sitAndStand(bot), bot);
    return true;
}

function ensureSkill(bot, selfId, data) {
    let skill = bot.skillset.fetchSkill(selfId);
    if (skill) return skill;

    const SkillModel = invoke('GameServer/Model/Skill');
    skill = new SkillModel({
        selfId,
        hp: 0,
        passive: false,
        ...data
    });
    bot.skillset.skills.push(skill);
    return skill;
}

function healSkill(bot) {
    return ensureSkill(bot, 1011, {
        name: "Heal",
        level: 1,
        mp: 15,
        hitTime: 1500,
        reuse: 1000,
        power: 20,
        distance: 600
    });
}

function aggressionSkill(bot) {
    return ensureSkill(bot, 28, {
        name: "Aggression",
        level: 1,
        mp: 10,
        hitTime: 1000,
        reuse: 3000,
        power: 0,
        distance: 600
    });
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

function leaderAggroCount(player) {
    return World.fetchNpcsInRadius(player.fetchLocX(), player.fetchLocY(), 900)
        .filter((npc) => npc.fetchAttackable() && !npc.isDead() && npc.fetchDestId() === player.fetchId())
        .length;
}

function unsafeSupportMoment(session, bot, player, activeMobs) {
    return !!session.currentTargetId ||
        !!player.fetchDestId() ||
        activeMobs > 0 ||
        isBusy(bot);
}

function pullBlockReason(session, botVitals, leaderVitals, activeMobs) {
    if (session.autoTaunt === false) return 'manual_pull_off';
    if (session.botStay) return 'stay_order';
    if (session.currentTargetId) return 'already_assisting';
    if (leaderVitals.hpRatio < 0.65) return 'leader_low_hp';
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
        const partyThreat = PartyAwareness.findThreatTargetingParty(playerSession);

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

        if (bot.state.fetchSeated() && (partyThreat || distance > FOLLOW_RUN_DISTANCE)) {
            session.plan = 'following';
            session.currentTargetId = partyThreat?.actor?.fetchId?.();
            standUp(session, bot);
            recordRoleDecision(
                session,
                bot,
                partyThreat ? assistActionForRole(role) : 'follow_leader',
                partyThreat ? 'party_under_attack' : 'leader_moved'
            );
            return;
        }

        if (session.stuckTicks >= 3 || distance > FOLLOW_TELEPORT_DISTANCE) {
            session.stuckTicks = 0;
            recordRoleDecision(session, bot, 'follow_leader', distance > FOLLOW_TELEPORT_DISTANCE ? 'catch_up' : 'unstuck');
            const TeleportTo = invoke('GameServer/Actor/Generics/TeleportTo');
            if (TeleportTo && typeof TeleportTo === 'function') {
                const targetLoc = {
                    locX: player.fetchLocX() + utils.oneFromSpan(-60, 60),
                    locY: player.fetchLocY() + utils.oneFromSpan(-60, 60),
                    locZ: player.fetchLocZ()
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

        if (!partyThreat && (botVitals.hpRatio < 0.30 || botVitals.mpRatio < 0.15)) {
            session.plan = 'resting';
            session.currentTargetId = undefined;
            bot.unselect();
            bot.state.setSeated(true);
            session.dataSendToOthers(ServerResponse.sitAndStand(bot), bot);
            recordRoleDecision(session, bot, botVitals.hpRatio < 0.30 ? 'recover_hp' : 'save_mp', 'resting');
            BotAI.say(session, "Phew! My HP/MP is low. Sitting down to recover.");
            return;
        }

        let acted = false;
        let keepRoleDecision = false;

        const buffsNeedRefresh = BotBuffs.needsNewbieRefresh(bot);
        if (buffsNeedRefresh) {
            const unsafeToRefresh = unsafeSupportMoment(session, bot, player, leaderAggroCount(player));

            if (unsafeToRefresh || session.partyCompanion === true) {
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

        const nextSupportBuff = BotBuffs.nextSupportBuff(player);
        if (!acted && BotRoles.canBuff(bot) && nextSupportBuff) {
            const activeMobs = leaderAggroCount(player);
            if (unsafeSupportMoment(session, bot, player, activeMobs)) {
                recordRoleDecision(session, bot, 'buff_party', 'wait_for_safe_moment', {
                    buff: nextSupportBuff,
                    targetId: player.fetchId(),
                    activeMobs
                });
                keepRoleDecision = true;
            } else if (bot.fetchMp() < SUPPORT_BUFF_MP_COST || botVitals.mpRatio < 0.35) {
                recordRoleDecision(session, bot, 'save_mp', 'low_mp_for_buff', {
                    buff: nextSupportBuff,
                    targetId: player.fetchId()
                });
                keepRoleDecision = true;
            } else {
                const result = BotBuffs.applySupportBuff(playerSession, player, nextSupportBuff, Generics);
                if (result) {
                    acted = true;
                    bot.setMp(Math.max(0, bot.fetchMp() - SUPPORT_BUFF_MP_COST));
                    bot.statusUpdateVitals(bot);
                    recordRoleDecision(session, bot, 'buff_party', nextSupportBuff, {
                        buff: nextSupportBuff,
                        targetId: player.fetchId()
                    });
                    if (Math.random() < 0.30) {
                        BotAI.say(session, supportBuffPhrase(nextSupportBuff, player.fetchName()));
                    }
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
            const skill = healSkill(bot);
            const canCast = bot.fetchMp() >= skill.fetchConsumedMp() && !isBusy(bot);

            if (leaderVitals.hpRatio < 0.45 && canCast) {
                acted = true;
                recordRoleDecision(session, bot, 'heal_leader', 'emergency_heal', { targetId: player.fetchId() });
                castSkillOn(session, bot, Generics, player, 1011, false);
                if (Math.random() < 0.15) {
                    BotAI.say(session, "Emergency heal on " + player.fetchName() + "!");
                }
            } else if (leaderVitals.hpRatio < 0.70 && botVitals.mpRatio >= 0.35 && canCast) {
                acted = true;
                recordRoleDecision(session, bot, 'heal_leader', 'top_off', { targetId: player.fetchId() });
                castSkillOn(session, bot, Generics, player, 1011, false);
                if (Math.random() < 0.15) {
                    BotAI.say(session, "Healing you, " + player.fetchName() + "!");
                }
            } else if (leaderVitals.hpRatio < 0.70 && botVitals.mpRatio < 0.35) {
                recordRoleDecision(session, bot, 'save_mp', leaderVitals.hpRatio < 0.45 ? 'low_mp_emergency' : 'leader_not_critical');
                keepRoleDecision = true;
            } else if (botVitals.hpRatio < 0.55 && botVitals.mpRatio >= 0.25 && canCast) {
                acted = true;
                recordRoleDecision(session, bot, 'heal_self', 'self_preservation', { targetId: bot.fetchId() });
                castSkillOn(session, bot, Generics, bot, 1011, false);
                if (Math.random() < 0.15) {
                    BotAI.say(session, "Healing myself!");
                }
            } else if (botVitals.mpRatio < 0.25) {
                recordRoleDecision(session, bot, 'save_mp', 'low_mp');
                keepRoleDecision = true;
            }
        }

        if (!acted && role === 'tank') {
            const nearbyNpcs = World.fetchNpcsInRadius(bot.fetchLocX(), bot.fetchLocY(), 800);
            const monsterToAggro = nearbyNpcs.find((npc) => npc.fetchAttackable() && !npc.isDead() && npc.fetchDestId() === player.fetchId());

            if (monsterToAggro) {
                const skill = aggressionSkill(bot);
                if (bot.fetchMp() >= skill.fetchConsumedMp() && !isBusy(bot)) {
                    acted = true;
                    recordRoleDecision(session, bot, 'protect_leader', 'leader_targeted', { targetId: monsterToAggro.fetchId() });
                    castSkillOn(session, bot, Generics, monsterToAggro, 28, true);
                    if (Math.random() < 0.20) {
                        BotAI.say(session, "Hey, " + monsterToAggro.fetchName() + "! Attack me instead!");
                    }
                } else if (botVitals.mpRatio < 0.25) {
                    recordRoleDecision(session, bot, 'save_mp', 'low_mp_for_taunt');
                    keepRoleDecision = true;
                }
            }
        }

        if (!acted && role === 'tank') {
            const activeMobs = leaderAggroCount(player);
            const blockReason = pullBlockReason(session, botVitals, leaderVitals, activeMobs);

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
                    const skill = aggressionSkill(bot);
                    if (bot.fetchMp() >= skill.fetchConsumedMp() && !isBusy(bot)) {
                        acted = true;
                        recordRoleDecision(session, bot, 'pull_target', 'safe_pull', {
                            targetId: targetMonster.fetchId(),
                            activeMobs
                        });
                        castSkillOn(session, bot, Generics, targetMonster, 28, true);
                        if (Math.random() < 0.30) {
                            BotAI.say(session, "Pulling " + targetMonster.fetchName() + " to the group!");
                        }
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
            const playerTargetId = player.fetchDestId();
            if (playerTargetId && playerTargetId !== bot.fetchId() && playerTargetId !== player.fetchId()) {
                acted = true;
                World.fetchUser(playerTargetId).then((user) => {
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
                        session.currentTargetId = undefined;
                        bot.unselect();
                    }
                }).catch(() => {
                    World.fetchNpc(playerTargetId).then((npc) => {
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
                            session.currentTargetId = undefined;
                            bot.unselect();
                        }
                    }).catch(() => {
                        session.currentTargetId = undefined;
                        bot.unselect();
                    });
                });
            } else {
                session.currentTargetId = undefined;
                bot.unselect();
            }
        }

        if (!session.currentTargetId && !acted) {
            if (session.botStay && session.stayLocation) {
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
                if (!keepRoleDecision) {
                    recordRoleDecision(session, bot, 'follow_leader', 'keep_range');
                }
                bot.moveTo({
                    from: { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() },
                    to: { locX: player.fetchLocX() + utils.oneFromSpan(-60, 60), locY: player.fetchLocY() + utils.oneFromSpan(-60, 60), locZ: player.fetchLocZ() }
                });
            } else {
                if (!keepRoleDecision) {
                    recordRoleDecision(session, bot, BotRoles.partyRoleStance(role), 'ready');
                }
            }
        }
    }
};
