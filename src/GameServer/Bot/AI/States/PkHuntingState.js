const SpeckMath = invoke('GameServer/SpeckMath');
const World     = invoke('GameServer/World/World');

module.exports = {
    tick(session, bot, Generics, BotAI) {
        const botPt = new SpeckMath.Point3D(bot.fetchLocX(), bot.fetchLocY(), bot.fetchLocZ());
        
        // 1. Flee/Threat Check
        let threatCount = 0;
        let highestThreat = null;

        World.user.sessions.forEach((user) => {
            const other = user.actor;
            if (other && other !== bot && other.fetchIsOnline() && !other.state.fetchDead() && other.fetchKarma() === 0) {
                const dist = new SpeckMath.Point3D(other.fetchLocX(), other.fetchLocY(), other.fetchLocZ()).distance(botPt);
                if (dist < 1500) {
                    if (other.fetchDestId() === bot.fetchId() || dist < 700) {
                        threatCount++;
                        if (other.fetchLevel() > bot.fetchLevel()) {
                            highestThreat = other;
                        }
                    }
                }
            }
        });

        // Flee check for PK
        if (threatCount >= 2 || highestThreat) {
            if (session.plan !== 'pk_fleeing') {
                session.plan = 'pk_fleeing';
                session.currentTargetId = undefined;

                const panicPhrases = [
                    `Whoa! Too many of them! Fall back!`,
                    `You win this time, white names! Running!`,
                    `Ah, you guys are too strong! Fallback!`,
                    `I will be back for your blood! Fleeing!`
                ];
                BotAI.say(session, panicPhrases[Math.floor(Math.random() * panicPhrases.length)]);

                const escapeFrom = highestThreat || bot; // flee from threat
                const dx = bot.fetchLocX() - escapeFrom.fetchLocX();
                const dy = bot.fetchLocY() - escapeFrom.fetchLocY();
                const length = Math.sqrt(dx*dx + dy*dy) || 1;
                const fleeX = Math.round(bot.fetchLocX() + (dx / length) * 900);
                const fleeY = Math.round(bot.fetchLocY() + (dy / length) * 900);

                bot.moveTo({
                    from: { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() },
                    to: { locX: fleeX, locY: fleeY, locZ: bot.fetchLocZ() }
                });

                setTimeout(() => {
                    if (session.plan === 'pk_fleeing') {
                        session.plan = 'pk_hunting';
                    }
                }, 6000);
            }
            return; // Skip rest of AI tick while fleeing!
        }

        // 2. Normal PK Hunt Targeting
        if (session.currentTargetId) {
            // Keep attacking existing target
            World.fetchUser(session.currentTargetId).then((targetActor) => {
                if (targetActor && targetActor.fetchIsOnline() && !targetActor.state.fetchDead()) {
                    BotAI.executePvPCombat(session, bot, targetActor, Generics);
                } else {
                    session.currentTargetId = undefined;
                }
            }).catch(() => {
                session.currentTargetId = undefined;
            });
        } else {
            // Scan for closest white player/bot
            let closestWhite = null;
            let closestDist = 99999;

            World.user.sessions.forEach((user) => {
                const other = user.actor;
                if (other && other !== bot && other.fetchIsOnline() && !other.state.fetchDead() && other.fetchKarma() === 0) {
                    const dist = new SpeckMath.Point3D(other.fetchLocX(), other.fetchLocY(), other.fetchLocZ()).distance(botPt);
                    if (dist < 2500 && dist < closestDist) {
                        closestDist = dist;
                        closestWhite = other;
                    }
                }
            });

            if (closestWhite) {
                session.currentTargetId = closestWhite.fetchId();
                bot.select({ id: closestWhite.fetchId() });
                
                if (Math.random() < 0.20) {
                    BotAI.say(session, `Found you, ${closestWhite.fetchName()}! Fresh meat!`);
                }
                BotAI.executePvPCombat(session, bot, closestWhite, Generics);
            } else {
                // Wandering around high density coordinates to find players
                if (Math.random() < 0.20) {
                    // Tiny chance to relocate to a new farming sector if completely alone
                    if (Math.random() < 0.05) {
                        try {
                            const BotManager = invoke('GameServer/Bot/BotManager');
                            const densityCoord = BotManager.findHighDensityCoord();
                            Generics.teleportTo(session, bot, densityCoord);
                            return;
                        } catch (err) {}
                    }

                    const randomX = bot.fetchLocX() + utils.oneFromSpan(-150, 150);
                    const randomY = bot.fetchLocY() + utils.oneFromSpan(-150, 150);
                    bot.moveTo({
                        from: { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() },
                        to: { locX: randomX, locY: randomY, locZ: bot.fetchLocZ() }
                    });
                }
            }
        }
    }
};
