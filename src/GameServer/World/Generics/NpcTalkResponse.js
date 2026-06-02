const ServerResponse = invoke('GameServer/Network/Response');
const Item           = invoke('GameServer/Item/Item');
const DataCache      = invoke('GameServer/DataCache');
const Database       = invoke('Database');

function npcTalkResponse(session, data) {
    let parts = data.link.split(' ') ?? [];

    switch (parts[0]) {
        case 'html':
            {
                const path = 'data/Html/';
                const filename = path + parts[1] + '.html';

                if (utils.fileExists(filename)) {
                    session.dataSendToMe(
                        ServerResponse.npcHtml(7146, utils.parseRawFile(filename))
                    );
                    return;
                }
                utils.infoWarn('GameServer', 'html file "%s" does not exist', filename);
            }
            break;

        case 'teleport':
            {
                const coords = DataCache.teleports.find((ob) => ob.id === Number(parts[1]))?.spawns;
                coords ? invoke(path.actor).teleportTo(session, session.actor, coords[0]) : null;
            }
            break;

        case 'admin-teleport':
            {
                const coords = {
                    locX: Number(parts[1]),
                    locY: Number(parts[2]),
                    locZ: Number(parts[3]),
                    head: session.actor.fetchHead()
                };

                invoke(path.actor).teleportTo(session, session.actor, coords);
            }
            break;

        case 'admin-teleport-random':
            {
                const count    = utils.size(DataCache.npcSpawns);
                const selected = DataCache.npcSpawns[utils.randomNumber(count)];

                const coords = selected.bounds.map((bound) => {
                    return [bound.locX, bound.locY];
                });

                const pos = require('random-point-in-shape')(coords);
                invoke(path.actor).teleportTo(session, session.actor, {
                    locX: pos[0], locY: pos[1], locZ: selected.bounds[0].maxZ, head: utils.randomNumber(65536),
                });
            }
            break;

        case 'buy-shop':
            {
                let list = [];
                let itemIds = [];

                if (parts[1] === 'grocer' || parts[1] === 'orc_grocer') {
                    itemIds = [1060, 1061, 1831, 1833, 736, 737, 1835, 2509, 3947, 735, 1062, 1863, 17];
                } else if (parts[1] === 'weapons') {
                    itemIds = [
                        // Weapons
                        1, 3, 66, 67, 68,     // Swords
                        4, 5, 1563,           // Blunts
                        13, 14,               // Bows
                        10, 11, 12,           // Daggers
                        6, 7, 8, 9,           // Staffs/Wands
                        15,                   // Spears
                        // Shields
                        18, 19, 20, 102,
                        // Shirts / Tops
                        21, 22, 23, 24, 25, 26, 27, 390,
                        // Pants / Gaiters
                        28, 29, 30, 31, 32, 33, 34, 412,
                        // Footwear
                        35, 36, 37, 38, 39,
                        // Headwear
                        41, 42, 43, 44,
                        // Handwear
                        48, 49, 50, 51
                    ];
                } else if (parts[1] === 'orc_weapons') {
                    itemIds = [
                        // Weapons
                        1, 3, 66, 67, 68,     // Swords
                        4, 5, 1563,           // Blunts
                        13, 14,               // Bows
                        10, 11, 12,           // Daggers
                        6, 7, 8, 9,           // Staffs/Wands
                        15, 291, 292, 297,    // Spears/Polearms (Orc starting weapon types!)
                        253, 254, 255, 256,   // Fist weapons (Orc specialty!)
                        // Shields
                        18, 19, 20, 102,
                        // Shirts / Tops
                        21, 22, 23, 24, 25, 26, 27, 390,
                        // Pants / Gaiters
                        28, 29, 30, 31, 32, 33, 34, 412,
                        // Footwear
                        35, 36, 37, 38, 39,
                        // Headwear
                        41, 42, 43, 44,
                        // Handwear
                        48, 49, 50, 51
                    ];
                } else if (parts[1] === 'jewelry' || parts[1] === 'orc_jewelry') {
                    itemIds = [112, 113, 114, 115, 116, 118, 845, 846, 875, 876, 877, 906, 907, 908];
                } else if (parts[1] === 'amulets' || parts[1] === 'orc_amulets') {
                    itemIds = [1524, 1525, 1526, 1527, 1529, 1522, 1523, 1856, 1518, 1519, 1520, 1521, 1528, 1530];
                } else {
                    itemIds = [1835, 1061, 736];
                }


                itemIds.forEach((selfId) => {
                    DataCache.fetchItemFromSelfId(selfId, (item) => {
                        list.push(new Item(this.items.nextId++, utils.crushOb(item)));
                    });
                });

                session.dataSendToMe(
                    ServerResponse.purchaseList(list, session.actor.backpack.fetchTotalAdena())
                );
            }
            break;

        case 'admin-shop':
            {
                let list = [];

                DataCache.adminShop[parts[1]].forEach((selfId) => {
                    DataCache.fetchItemFromSelfId(selfId, (item) => {
                        item.template.price = 0; // Admin prices :)
                        list.push(new Item(this.items.nextId++, utils.crushOb(item)));
                    });
                });

                session.dataSendToMe(
                    ServerResponse.purchaseList(list, session.actor.backpack.fetchTotalAdena())
                );
            }
            break;

        case 'sell-junk':
            {
                const backpack = session.actor.backpack;
                const items = backpack.items;

                const sellableItems = items.filter(item => !item.fetchEquipped() && item.fetchSelfId() !== 57);

                if (sellableItems.length === 0) {
                    session.dataSendToMe(ServerResponse.speak(session.actor, { kind: 0, text: "You have no unequipped items to sell." }));
                    return;
                }

                let totalAdenaPayout = 0;
                let soldDetails = [];

                sellableItems.forEach((item) => {
                    const price = item.fetchPrice();
                    const sellPrice = Math.max(1, Math.floor(price * 0.5));
                    const payout = sellPrice * item.fetchAmount();
                    
                    totalAdenaPayout += payout;
                    soldDetails.push(`${item.fetchAmount()}x ${item.fetchName()} (+${payout} Adena)`);

                    Database.deleteItem(session.actor.fetchId(), item.fetchId());
                });

                backpack.items = backpack.items.filter(item => item.fetchEquipped() || item.fetchSelfId() === 57);

                backpack.stackableExists(57).then((adenaItem) => {
                    const total = adenaItem.fetchAmount() + totalAdenaPayout;
                    Database.updateItemAmount(session.actor.fetchId(), adenaItem.fetchId(), total).then(() => {
                        adenaItem.setAmount(total);
                        session.dataSendToMe(ServerResponse.itemsList(backpack.fetchItems()));
                        session.dataSendToMe(ServerResponse.userInfo(session.actor));
                        
                        session.dataSendToMe(ServerResponse.speak(session.actor, { kind: 0, text: `Sold: ${soldDetails.join(', ')}` }));
                        session.dataSendToMe(ServerResponse.speak(session.actor, { kind: 0, text: `Successfully sold ${sellableItems.length} items. Gained +${totalAdenaPayout} Adena!` }));
                    });
                }).catch(() => {
                    Database.setItem(session.actor.fetchId(), {
                        selfId: 57,
                        name: "Adena",
                        amount: totalAdenaPayout,
                        equipped: false,
                        slot: 0
                    }).then((packet) => {
                        backpack.insertItem(Number(packet.insertId), 57, { amount: totalAdenaPayout });
                        session.dataSendToMe(ServerResponse.itemsList(backpack.fetchItems()));
                        session.dataSendToMe(ServerResponse.userInfo(session.actor));
                        
                        session.dataSendToMe(ServerResponse.speak(session.actor, { kind: 0, text: `Sold: ${soldDetails.join(', ')}` }));
                        session.dataSendToMe(ServerResponse.speak(session.actor, { kind: 0, text: `Successfully sold ${sellableItems.length} items. Gained +${totalAdenaPayout} Adena!` }));
                    });
                });
            }
            break;

        case 'admin-give-adena':
            {
                const targetName = parts[1];
                const amount = Number(parts[2]);
                const World = invoke('GameServer/World/World');

                if (!targetName || isNaN(amount)) {
                    utils.infoWarn('GameServer', 'Invalid give-adena command parameters');
                    return;
                }

                // 1. Search if target character is online in the World
                const targetSession = World.user.sessions.find(ob => ob.actor && ob.actor.fetchName().toLowerCase() === targetName.toLowerCase());
                if (targetSession && targetSession.actor) {
                    const backpack = targetSession.actor.backpack;
                    backpack.stackableExists(57).then((item) => {
                        const total = item.fetchAmount() + amount;
                        Database.updateItemAmount(targetSession.actor.fetchId(), item.fetchId(), total).then(() => {
                            backpack.updateAmount(item.fetchId(), total);
                            targetSession.dataSendToMe(ServerResponse.userInfo(targetSession.actor));
                            targetSession.dataSendToMe(ServerResponse.itemsList(backpack.fetchItems()));
                            
                            targetSession.dataSendToMe(ServerResponse.speak(targetSession.actor, { kind: 0, text: `Received ${amount} Adena from Admin.` }));
                            if (session !== targetSession) {
                                session.dataSendToMe(ServerResponse.speak(session.actor, { kind: 0, text: `Successfully gave ${amount} Adena to ${targetSession.actor.fetchName()}.` }));
                            }
                        });
                    }).catch(() => {
                        Database.setItem(targetSession.actor.fetchId(), {
                            selfId: 57,
                            name: "Adena",
                            amount: amount,
                            equipped: false,
                            slot: 0
                        }).then((packet) => {
                            backpack.insertItem(Number(packet.insertId), 57, { amount: amount });
                            targetSession.dataSendToMe(ServerResponse.userInfo(targetSession.actor));
                            targetSession.dataSendToMe(ServerResponse.itemsList(backpack.fetchItems()));
                            
                            targetSession.dataSendToMe(ServerResponse.speak(targetSession.actor, { kind: 0, text: `Received ${amount} Adena from Admin.` }));
                            if (session !== targetSession) {
                                session.dataSendToMe(ServerResponse.speak(session.actor, { kind: 0, text: `Successfully gave ${amount} Adena to ${targetSession.actor.fetchName()}.` }));
                            }
                        });
                    });
                } else {
                    // Offline or doesn't exist
                    Database.fetchCharacterName(targetName).then((rows) => {
                        if (rows && rows[0]) {
                            const charId = rows[0].id;
                            const charRealName = rows[0].name;
                            Database.fetchItems(charId).then((items) => {
                                const adenaItem = items.find(ob => ob.selfId === 57);
                                if (adenaItem) {
                                    const total = adenaItem.amount + amount;
                                    Database.updateItemAmount(charId, adenaItem.id, total).then(() => {
                                        session.dataSendToMe(ServerResponse.speak(session.actor, { kind: 0, text: `Successfully gave ${amount} Adena to offline character ${charRealName}.` }));
                                    });
                                } else {
                                    Database.setItem(charId, {
                                        selfId: 57,
                                        name: "Adena",
                                        amount: amount,
                                        equipped: false,
                                        slot: 0
                                    }).then(() => {
                                        session.dataSendToMe(ServerResponse.speak(session.actor, { kind: 0, text: `Successfully gave ${amount} Adena to offline character ${charRealName}.` }));
                                    });
                                }
                            });
                        } else {
                            session.dataSendToMe(ServerResponse.speak(session.actor, { kind: 0, text: `Character with name "${targetName}" does not exist.` }));
                        }
                    });
                }
            }
            break;

        case 'newbie_buff':
            {
                const actor = session.actor;
                if (!actor) return;

                if (actor.fetchLevel() > 25) {
                    session.dataSendToMe(ServerResponse.speak(actor, { kind: 0, text: "Newbie Guide: Your level is too high! I can only help adventurers under level 25." }));
                    return;
                }

                if (!actor.activeBuffs) {
                    actor.activeBuffs = {};
                }

                const buffType = parts[1];

                if (buffType === 'windwalk') {
                    actor.activeBuffs.windWalk = Date.now() + 20 * 60 * 1000;
                    invoke(path.actor).calculateStats(session, actor);
                    session.dataSendToMe(ServerResponse.userInfo(actor));
                    session.dataSendToMe(ServerResponse.speak(actor, { kind: 0, text: "Newbie Guide: Bestowed Wind Walk! May the wind guide your steps." }));
                }
                else if (buffType === 'shield') {
                    actor.activeBuffs.shield = Date.now() + 20 * 60 * 1000;
                    invoke(path.actor).calculateStats(session, actor);
                    session.dataSendToMe(ServerResponse.userInfo(actor));
                    session.dataSendToMe(ServerResponse.speak(actor, { kind: 0, text: "Newbie Guide: Bestowed Shield! May your defenses be unbreakable." }));
                }
                else if (buffType === 'haste') {
                    actor.activeBuffs.haste = Date.now() + 20 * 60 * 1000;
                    invoke(path.actor).calculateStats(session, actor);
                    session.dataSendToMe(ServerResponse.userInfo(actor));
                    session.dataSendToMe(ServerResponse.speak(actor, { kind: 0, text: "Newbie Guide: Bestowed Haste! Strike with the speed of lightning." }));
                }
                else if (buffType === 'heal') {
                    actor.setHp(actor.fetchMaxHp());
                    actor.setMp(actor.fetchMaxMp());
                    actor.statusUpdateVitals(actor);
                    session.dataSendToMe(ServerResponse.speak(actor, { kind: 0, text: "Newbie Guide: You have been fully healed and refreshed!" }));
                }
            }
            break;

        default:
            utils.infoWarn('GameServer', 'unknown NPC response "%s"', parts[0]);
            break;
    }
}

module.exports = npcTalkResponse;
