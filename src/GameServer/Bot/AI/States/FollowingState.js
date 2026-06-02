const SpeckMath      = invoke('GameServer/SpeckMath');
const World          = invoke('GameServer/World/World');

module.exports = {
    tick(session, bot, Generics, BotAI) {
        const playerSession = session.followPlayerSession;
        if (!playerSession || !playerSession.actor || !playerSession.actor.fetchIsOnline()) {
            session.plan = 'hunting';
            BotAI.say(session, "My companion has disconnected. Heading back to hunt.");
            return;
        }

        const player = playerSession.actor;
        const distance = new SpeckMath.Point3D(bot.fetchLocX(), bot.fetchLocY(), bot.fetchLocZ())
            .distance(new SpeckMath.Point3D(player.fetchLocX(), player.fetchLocY(), player.fetchLocZ()));

        if (distance > 3500) {
            session.plan = 'hunting';
            BotAI.say(session, "You ran too far away! I'm going back to hunt on my own.");
            return;
        }

        // Check if player has targeted a valid attackable target
        const playerTargetId = player.fetchDestId();
        if (playerTargetId) {
            // If player is in combat, assist them!
            World.fetchNpc(playerTargetId).then((npc) => {
                if (npc.fetchAttackable() && !npc.isDead()) {
                    if (session.currentTargetId !== playerTargetId) {
                        session.currentTargetId = playerTargetId;
                        bot.select({ id: playerTargetId });
                        if (Math.random() < 0.20) {
                            BotAI.say(session, "Assisting you! Smashing that " + npc.fetchName() + "!");
                        }
                    }
                }
            }).catch(() => {});
        }

        // Move closer to player if not in combat and far
        if (!session.currentTargetId && distance > 250) {
            bot.moveTo({
                from: { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() },
                to: { locX: player.fetchLocX() + utils.oneFromSpan(-60, 60), locY: player.fetchLocY() + utils.oneFromSpan(-60, 60), locZ: player.fetchLocZ() }
            });
        }
    }
};
