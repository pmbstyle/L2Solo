const SpeckMath      = invoke('GameServer/SpeckMath');
const ServerResponse = invoke('GameServer/Network/Response');

module.exports = {
    tick(session, bot, Generics, BotAI) {
        const closestGuide = BotAI.getClosestNewbieGuide(bot.fetchLocX(), bot.fetchLocY());
        const guidePt = new SpeckMath.Point3D(closestGuide.locX, closestGuide.locY, closestGuide.locZ);
        const botPt = new SpeckMath.Point3D(bot.fetchLocX(), bot.fetchLocY(), bot.fetchLocZ());
        const dist = botPt.distance(guidePt);

        if (dist > 250) {
            if (dist > 5000) {
                // Teleport to the guide if too far (prevents getting stuck on geography/ocean)
                Generics.teleportTo(session, bot, { locX: closestGuide.locX, locY: closestGuide.locY, locZ: closestGuide.locZ });
            } else {
                if (Math.random() < 0.20 || !bot.state.inMotion()) {
                    bot.moveTo({
                        from: { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() },
                        to: { locX: closestGuide.locX, locY: closestGuide.locY, locZ: closestGuide.locZ }
                    });
                }
            }
        } else {
            if (!bot.activeBuffs) {
                bot.activeBuffs = {};
            }
            const duration = Date.now() + 20 * 60 * 1000;
            bot.activeBuffs.windWalk = duration;
            bot.activeBuffs.shield = duration;
            bot.activeBuffs.haste = duration;

            bot.setHp(bot.fetchMaxHp());
            bot.setMp(bot.fetchMaxMp());
            bot.statusUpdateVitals(bot);
            
            Generics.calculateStats(session, bot);
            session.dataSendToMe(ServerResponse.userInfo(bot));
            
            BotAI.say(session, "Thank you, Newbie Guide! Fully blessed and ready to hunt!");
            session.plan = 'hunting';

            // Teleport back to original hunting spot
            if (session.preBuffLocation) {
                Generics.teleportTo(session, bot, session.preBuffLocation);
                session.preBuffLocation = undefined;
            } else if (session.initialSpawnCoord) {
                Generics.teleportTo(session, bot, session.initialSpawnCoord);
            }
        }
    }
};
