const ServerResponse = invoke('GameServer/Network/Response');
const Database       = invoke('Database');

module.exports = function(session, parts) {
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
};
