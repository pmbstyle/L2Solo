const SpeckMath      = invoke('GameServer/SpeckMath');
const BotBuffs       = invoke('GameServer/Bot/AI/BotBuffs');
const PartyCombatState = invoke('GameServer/Bot/AI/PartyCombatState');

const RETURN_TELEPORT_SETTLE_MS = 1250;

function returnLocation(session) {
    const resume = session.resumeAfterBuff;
    if (resume?.plan === 'following' && resume.followPlayerSession?.actor?.fetchIsOnline()) {
        if (resume.botStay && resume.stayLocation) {
            return resume.stayLocation;
        }

        const leader = resume.followPlayerSession.actor;
        return {
            locX: leader.fetchLocX() + utils.oneFromSpan(-60, 60),
            locY: leader.fetchLocY() + utils.oneFromSpan(-60, 60),
            locZ: leader.fetchLocZ()
        };
    }

    return session.preBuffLocation || session.initialSpawnCoord || null;
}

function resumePreviousPlan(session, bot) {
    const resume = session.resumeAfterBuff;
    if (resume?.plan === 'following' && resume.followPlayerSession?.actor?.fetchIsOnline()) {
        session.plan = 'following';
        session.followPlayerSession = resume.followPlayerSession;
        session.partyCompanion = true;
        session.botStay = resume.botStay;
        session.stayLocation = resume.stayLocation;
        session.roleDecision = {
            role: resume.role,
            action: 'refresh_buffs',
            reason: 'newbie_blessing_done',
            at: Date.now()
        };
    } else {
        session.plan = session.preBuffPlan || 'hunting';
    }

    session.resumeAfterBuff = undefined;
    session.preBuffPlan = undefined;
    session.preBuffLocation = undefined;
    session.currentTargetId = undefined;
    bot.unselect();
}

function finishVisit(session, bot, Generics) {
    const resume = session.resumeAfterBuff;
    const target = returnLocation(session);

    if (resume?.waitForSafePartyReturn && resume.followPlayerSession && PartyCombatState.isActive(resume.followPlayerSession)) {
        session.roleDecision = {
            role: resume.role,
            action: 'return_to_party',
            reason: 'wait_for_safe_teleport',
            at: Date.now()
        };
        return false;
    }

    if (resume?.returnMode === 'teleport' && target) {
        if (!resume.returnTeleportStartedAt) {
            resume.returnTeleportStartedAt = Date.now();
            Generics.teleportTo(session, bot, target);
            return false;
        }
        if (Date.now() - resume.returnTeleportStartedAt < RETURN_TELEPORT_SETTLE_MS) {
            return false;
        }
        resumePreviousPlan(session, bot);
        return true;
    }

    resumePreviousPlan(session, bot);
    if (target) {
        bot.moveTo({
            from: { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() },
            to: target
        });
    }
    return true;
}

module.exports = {
    tick(session, bot, Generics, BotAI) {
        const resume = session.resumeAfterBuff;
        if (Number(resume?.readyAt || 0) > Date.now()) return;

        const shouldVisitGuide = resume?.conditionalNewbieBuff !== true || BotBuffs.needsNewbieRefresh(bot, 0);
        if (!shouldVisitGuide) {
            finishVisit(session, bot, Generics);
            return;
        }

        const closestGuide = BotAI.getClosestNewbieGuide(bot.fetchLocX(), bot.fetchLocY());
        const guidePt = new SpeckMath.Point3D(closestGuide.locX, closestGuide.locY, closestGuide.locZ);
        const botPt = new SpeckMath.Point3D(bot.fetchLocX(), bot.fetchLocY(), bot.fetchLocZ());
        const dist = botPt.distance(guidePt);

        if (dist > 250) {
            if (dist > 5000) {
                bot.moveTo({
                    from: { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() },
                    to: { locX: closestGuide.locX, locY: closestGuide.locY, locZ: closestGuide.locZ }
                });
            } else {
                if (Math.random() < 0.20 || !bot.state.inMotion()) {
                    bot.moveTo({
                        from: { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() },
                        to: { locX: closestGuide.locX, locY: closestGuide.locY, locZ: closestGuide.locZ }
                    });
                }
            }
        } else {
            BotBuffs.applyFullNewbieBlessing(session, bot, Generics);
            BotAI.say(session, session.resumeAfterBuff ? "Thank you, Newbie Guide! Fully blessed and returning to the party!" : "Thank you, Newbie Guide! Fully blessed and ready to hunt!");
            finishVisit(session, bot, Generics);
        }
    }
};
