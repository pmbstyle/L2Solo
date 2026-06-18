const ServerResponse = invoke('GameServer/Network/Response');
const Item           = invoke('GameServer/Item/Item');
const DataCache      = invoke('GameServer/DataCache');
const BotManager     = invoke('GameServer/Bot/BotManager');

module.exports = function(session, parts) {
    session.activeAdminShop = null;

    const player = session.actor;
    if (!player) return;

    const playerPt = { x: player.fetchLocX(), y: player.fetchLocY(), z: player.fetchLocZ() };

    // 1. Находим ближайшего бота-торговца
    let nearestMerchant = null;
    let minDist = Infinity;

    BotManager.sessions.forEach(s => {
        if (s.plan === 'merchant') {
            const actor = s.actor;
            if (actor) {
                const dx = actor.fetchLocX() - playerPt.x;
                const dy = actor.fetchLocY() - playerPt.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist < minDist) {
                    minDist = dist;
                    nearestMerchant = actor;
                }
            }
        }
    });

    if (!nearestMerchant || minDist > 500) {
        session.dataSendToMe(ServerResponse.speak(player, { kind: 0, text: "Merchant is too far." }));
        return;
    }

    const botX = nearestMerchant.fetchLocX();
    const botY = nearestMerchant.fetchLocY();

    // 2. Находим зоны спавна в радиусе 25,000 от торговца
    const targetZones = [];
    DataCache.npcSpawns.forEach(zone => {
        if (!zone.bounds || zone.bounds.length === 0) return;
        
        let sumX = 0, sumY = 0;
        zone.bounds.forEach(pt => {
            sumX += pt.locX;
            sumY += pt.locY;
        });
        const centerX = sumX / zone.bounds.length;
        const centerY = sumY / zone.bounds.length;
        
        const dx = centerX - botX;
        const dy = centerY - botY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        
        if (dist <= 25000) {
            targetZones.push(zone);
        }
    });

    // 3. Собираем уникальные ID монстров из этих зон
    const monsterIds = new Set();
    targetZones.forEach(zone => {
        if (zone.spawns) {
            zone.spawns.forEach(spawn => {
                monsterIds.add(spawn.selfId);
            });
        }
    });

    // 4. Собираем уникальные ID выпадающих предметов (исключаем Adena [57])
    const itemIds = new Set();
    monsterIds.forEach(monsterId => {
        const rewardsData = DataCache.npcRewards.find(r => r.selfId === monsterId);
        if (!rewardsData) return;
        
        if (rewardsData.rewards) {
            rewardsData.rewards.forEach(group => {
                if (group.items) {
                    group.items.forEach(item => {
                        if (item.selfId !== 57) {
                            itemIds.add(item.selfId);
                        }
                    });
                }
            });
        }
        
        if (rewardsData.spoils) {
            rewardsData.spoils.forEach(group => {
                if (group.items) {
                    group.items.forEach(item => {
                        if (item.selfId !== 57) {
                            itemIds.add(item.selfId);
                        }
                    });
                }
            });
        }
    });

    // 5. Создаем список предметов для покупки, сортируем по ID и ограничиваем до 80
    const itemIdsArray = Array.from(itemIds).sort((a, b) => a - b).slice(0, 80);
    const list = [];

    itemIdsArray.forEach((selfId) => {
        DataCache.fetchItemFromSelfId(selfId, (item) => {
            if (item) {
                const nextId = invoke('GameServer/World/Generics/NpcTalkResponse').items.nextId++;
                list.push(new Item(nextId, utils.crushOb(item)));
            }
        });
    });

    if (list.length === 0) {
        session.dataSendToMe(ServerResponse.speak(player, { kind: 0, text: "There are no monsters with drops in this area." }));
        return;
    }

    session.dataSendToMe(
        ServerResponse.purchaseList(list, player.backpack.fetchTotalAdena())
    );
};
