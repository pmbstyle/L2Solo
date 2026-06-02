const SpeckMath      = invoke('GameServer/SpeckMath');
const ServerResponse = invoke('GameServer/Network/Response');

module.exports = {
    tick(session, bot, Generics, BotAI) {
        const guidePt = new SpeckMath.Point3D(-84081, 243227, -3723);
        const botPt = new SpeckMath.Point3D(bot.fetchLocX(), bot.fetchLocY(), bot.fetchLocZ());
        const dist = botPt.distance(guidePt);

        if (dist > 250) {
            if (Math.random() < 0.20 || !bot.state.inMotion()) {
                bot.moveTo({
                    from: { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() },
                    to: { locX: -84081, locY: 243227, locZ: -3723 }
                });
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
        }
    }
};
