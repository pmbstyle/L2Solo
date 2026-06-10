const SpeckMath      = invoke('GameServer/SpeckMath');
const ServerResponse = invoke('GameServer/Network/Response');
const TradeService   = invoke('GameServer/Bot/TradeService');

function formatAdena(value) {
    return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

module.exports = {
    tick(session, bot, Generics, BotAI) {
        const closestTown = BotAI.getClosestTown(bot.fetchLocX(), bot.fetchLocY());

        if (!session.shoppingTarget) {
            const BotManager = invoke('GameServer/Bot/BotManager');
            const buyer = TradeService.findBestBuyerForActor(bot, BotManager.sessions, { town: closestTown });

            if (buyer) {
                session.shoppingTarget = {
                    actorId: buyer.actor.fetchId(),
                    name: buyer.actor.fetchName(),
                    locX: buyer.actor.fetchLocX(),
                    locY: buyer.actor.fetchLocY(),
                    locZ: buyer.actor.fetchLocZ(),
                    town: buyer.store.town || closestTown.name
                };
                BotAI.say(session, `Heading to ${session.shoppingTarget.name} in ${session.shoppingTarget.town} to sell loot.`);
            } else {
                session.shoppingTarget = {
                    actorId: null,
                    name: `${closestTown.name} general shop`,
                    locX: closestTown.x,
                    locY: closestTown.y,
                    locZ: closestTown.z,
                    town: closestTown.name
                };
                BotAI.say(session, `No player buyer wants this bag. Going to ${closestTown.name} to liquidate junk.`);
            }
        }

        const target = session.shoppingTarget;
        const distToTarget = new SpeckMath.Point3D(bot.fetchLocX(), bot.fetchLocY(), bot.fetchLocZ())
            .distance(new SpeckMath.Point3D(target.locX, target.locY, target.locZ));

        if (distToTarget > 300) {
            bot.moveTo({
                from: { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() },
                to: { locX: target.locX, locY: target.locY, locZ: target.locZ }
            });
            return;
        }

        // In town! Wait and pretend to shop
        if (!session.shoppingDoneAnnounced) {
            session.shoppingDoneAnnounced = true;
            this.sellAndRestock(session, bot, Generics, BotAI);
        }
    },

    async sellAndRestock(session, bot, Generics, BotAI) {
        const NpcTalkResponse = invoke(path.world + 'NpcTalkResponse');
        const BotManager = invoke('GameServer/Bot/BotManager');
        let soldToBuyer = false;

        if (session.shoppingTarget?.actorId) {
            const buyerSession = BotManager.findSessionById(session.shoppingTarget.actorId);
            const buyer = buyerSession?.actor;
            const store = buyer && buyer.fetchPrivateStore ? buyer.fetchPrivateStore() : null;

            if (store && store.storeType === 3) {
                try {
                    const result = await TradeService.sellInventoryToStore(bot, store);
                    if (result.itemsSold > 0) {
                        soldToBuyer = true;
                        const sample = result.sold.slice(0, 3).map((line) => `${line.qty}x ${line.name}`).join(', ');
                        session.lastTradeSummary = `sold ${result.itemsSold} to ${buyer.fetchName()} for ${formatAdena(result.totalAdena)}a`;
                        BotAI.say(session, `Sold ${sample} to ${buyer.fetchName()} for ${formatAdena(result.totalAdena)} Adena.`);
                    }
                } catch (err) {
                    utils.infoWarn("Shopping", "buyer sale failed for %s: %s", bot.fetchName(), err);
                }
            }
        }

        if (!soldToBuyer) {
            NpcTalkResponse(session, { link: 'sell-junk' });
            session.lastTradeSummary = `used general sell-junk at ${session.shoppingTarget?.town || 'town'}`;
        } else {
            // Clear leftovers that no local buyer wanted, but keep the market sale as the visible trade event.
            NpcTalkResponse(session, { link: 'sell-junk' });
        }

        this.scheduleRestock(session, bot, Generics, BotAI);
    },

    scheduleRestock(session, bot, Generics, BotAI) {
        const Database = invoke('Database');

        setTimeout(() => {
            const backpack = bot.backpack;
            const adena = backpack.fetchTotalAdena();

            if (adena >= 7000) {
                backpack.stackableExists(57).then((adenaItem) => {
                    const total = adenaItem.fetchAmount() - 7000;
                    Database.updateItemAmount(bot.fetchId(), adenaItem.fetchId(), total).then(() => {
                        adenaItem.setAmount(total);
                    });
                });

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
                session.dataSendToOthers(ServerResponse.skillStarted(bot, bot.fetchId(), { fetchSelfId: () => 2001, fetchCalculatedHitTime: () => 500, fetchReuseTime: () => 500 }), bot);
            } else {
                BotAI.say(session, `Not enough Adena to buy Soulshots (Have ${adena}/7000 Adena). Skipping restocking.`);
            }
        }, 4000);

        setTimeout(() => {
            BotAI.say(session, "All stocked up! Returning to the hunting spot.");
            session.plan = 'hunting';
            session.shoppingDoneAnnounced = false;
            session.shoppingTarget = undefined;

            if (session.preShopLocation) {
                Generics.teleportTo(session, bot, session.preShopLocation);
                session.preShopLocation = undefined;
            } else if (session.initialSpawnCoord) {
                Generics.teleportTo(session, bot, session.initialSpawnCoord);
            } else {
                Generics.teleportTo(session, bot, { locX: -81174, locY: 246037, locZ: -3719 });
            }
        }, 9000);
    }
};
