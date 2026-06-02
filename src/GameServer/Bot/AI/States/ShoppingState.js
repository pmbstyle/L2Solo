const SpeckMath      = invoke('GameServer/SpeckMath');
const ServerResponse = invoke('GameServer/Network/Response');

module.exports = {
    tick(session, bot, Generics, BotAI) {
        const distToTown = new SpeckMath.Point3D(bot.fetchLocX(), bot.fetchLocY(), bot.fetchLocZ())
            .distance(new SpeckMath.Point3D(-84318, 244579, -3730));
        
        if (distToTown > 300) {
            // Keep moving to Town center if got diverted
            bot.moveTo({
                from: { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() },
                to: { locX: -84318, locY: 244579, locZ: -3730 }
            });
            return;
        }

        // In town! Wait and pretend to shop
        if (!session.shoppingDoneAnnounced) {
            session.shoppingDoneAnnounced = true;

            // 1. Actually Sell their junk loot using our new sell-junk bypass!
            const NpcTalkResponse = invoke(path.world + 'NpcTalkResponse');
            NpcTalkResponse(session, { link: 'sell-junk' });

            // 2. Schedule actual Soulshot purchase after 4 seconds (giving time for the sell payout to register)
            const Database = invoke('Database');
            setTimeout(() => {
                const backpack = bot.backpack;
                const adena = backpack.fetchTotalAdena();
                
                if (adena >= 7000) {
                    // Deduct 7000 Adena
                    backpack.stackableExists(57).then((adenaItem) => {
                        const total = adenaItem.fetchAmount() - 7000;
                        Database.updateItemAmount(bot.fetchId(), adenaItem.fetchId(), total).then(() => {
                            adenaItem.setAmount(total);
                        });
                    });

                    // Give 1000 No Grade Soulshots (1835)
                    backpack.stackableExists(1835).then((shotItem) => {
                        const total = shotItem.fetchAmount() + 1000;
                        Database.updateItemAmount(bot.fetchId(), shotItem.fetchId(), total).then(() => {
                            shotItem.setAmount(total);
                        });
                    }).catch(() => {
                        Database.setItem(bot.fetchId(), {
                            selfId: 1835,
                            name: "Soulshot: No Grade",
                            amount: 1000,
                            equipped: false,
                            slot: 0
                        }).then((packet) => {
                            backpack.insertItem(Number(packet.insertId), 1835, { amount: 1000 });
                        });
                    });

                    BotAI.say(session, "Bought 1000x Soulshot: No Grade (-7000 Adena)!");
                    // Play a fun casting effect to simulate purchasing / soulshots
                    session.dataSendToOthers(ServerResponse.skillStarted(bot, bot.fetchId(), { fetchSelfId: () => 2001, fetchCalculatedHitTime: () => 500, fetchReuseTime: () => 500 }), bot);
                } else {
                    BotAI.say(session, `Not enough Adena to buy Soulshots (Have ${adena}/7000 Adena). Skipping restocking.`);
                }
            }, 4000);

            setTimeout(() => {
                BotAI.say(session, "All stocked up! Returning to the keltir fields.");
                session.plan = 'hunting';
                session.shoppingDoneAnnounced = false;
                // Teleport close to newbie field to start hunting again
                Generics.teleportTo(session, bot, { locX: -81174, locY: 246037, locZ: -3719 });
            }, 9000);
        }
    }
};
