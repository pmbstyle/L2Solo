const SpeckMath      = invoke('GameServer/SpeckMath');
const BotBuffs       = invoke('GameServer/Bot/AI/BotBuffs');

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

module.exports = {
    tick(session, bot, Generics, BotAI) {
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

            const target = returnLocation(session);
            resumePreviousPlan(session, bot);
            if (target) {
                bot.moveTo({
                    from: { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() },
                    to: target
                });
            }
        }
    }
};
