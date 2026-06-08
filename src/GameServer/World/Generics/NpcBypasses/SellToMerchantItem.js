const ServerResponse = invoke('GameServer/Network/Response');
const DataCache      = invoke('GameServer/DataCache');
const Database       = invoke('Database');

function fold(v) {
    return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function buildShopHtml(session, bot) {
    const store = bot.fetchPrivateStore();
    const items = store ? store.items : [];
    const adena = session.actor.backpack.fetchTotalAdena();
    const title = store?.title ?? 'Buyer';

    let rows = '';
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const template = DataCache.items.find(ob => ob.selfId === item.selfId);
        const iname = template?.template?.name ?? 'Unknown';
        const icat = template?.template?.kind ?? '';
        const clr = icat.startsWith('Weapon') ? 'FF9900' :
                    icat.startsWith('Armor') || icat.startsWith('Shield') ? '99CCFF' : 'LEVEL';

        const playerItem = session.actor.backpack.fetchItemFromSelfId(item.selfId);
        const playerCount = playerItem ? playerItem.fetchAmount() : 0;
        const maxSell = Math.min(item.count, playerCount);

        let btns = `<a action="bypass -h sell-to-merchant-item ${item.selfId} 1"><font color="FFCC00">x1</font></a>&nbsp;&nbsp;`;
        if (maxSell >= 10) btns += `<a action="bypass -h sell-to-merchant-item ${item.selfId} 10"><font color="FFCC00">x10</font></a>&nbsp;&nbsp;`;
        if (maxSell >= 100) btns += `<a action="bypass -h sell-to-merchant-item ${item.selfId} 100"><font color="FFCC00">x100</font></a>&nbsp;&nbsp;`;
        if (maxSell > 1) btns += `<a action="bypass -h sell-to-merchant-item ${item.selfId} ${maxSell}"><font color="FFCC00">All</font></a>`;

        rows += `<table width=270><tr><td><font color="${clr}">${iname}</font></td></tr></table>`;
        rows += `<table width=270><tr><td width=80>Have: <font color="99CCFF">${fold(playerCount)}</font></td>`;
        rows += `<td width=80 align=right>Price: <font color="00FF00">${fold(item.price)}a</font></td>`;
        rows += `<td width=110 align=right>${btns}</td></tr></table>`;
        if (i < items.length - 1) rows += `<br1><img src="L2UI_CH3.hegaerectangle" width=270 height=1><br1>`;
    }

    return `<html><body>
<center>
<font color="FFCC00">${title}</font><br1>
<font color="00FF00">Adena: ${fold(adena)}a</font><br>
<img src="L2UI_CH3.hegaerectangle" width=270 height=1><br1>
${rows}
<br>
<a action="bypass -h npc_talk">Close</a>
</center></body></html>`;
}

function takeItem(session, selfId, amount) {
    return new Promise((resolve, reject) => {
        const actor = session.actor;
        const backpack = actor.backpack;
        const item = backpack.fetchItemFromSelfId(selfId);
        if (!item || item.fetchAmount() < amount) {
            return reject("Not enough items.");
        }
        const total = item.fetchAmount() - amount;
        if (total > 0) {
            Database.updateItemAmount(actor.fetchId(), item.fetchId(), total).then(() => {
                item.setAmount(total);
                resolve();
            }).catch(reject);
        } else {
            Database.deleteItem(actor.fetchId(), item.fetchId()).then(() => {
                backpack.items = backpack.items.filter(ob => ob.fetchId() !== item.fetchId());
                resolve();
            }).catch(reject);
        }
    });
}

function giveAdena(session, amount) {
    const actor = session.actor;
    const backpack = actor.backpack;
    return new Promise((resolve, reject) => {
        const adenaItem = backpack.fetchItemFromSelfId(57);
        if (adenaItem) {
            const total = adenaItem.fetchAmount() + amount;
            Database.updateItemAmount(actor.fetchId(), adenaItem.fetchId(), total).then(() => {
                adenaItem.setAmount(total);
                resolve();
            }).catch(reject);
        } else {
            Database.setItem(actor.fetchId(), {
                selfId: 57, name: 'Adena', amount: amount, equipped: false, slot: 0
            }).then((packet) => {
                backpack.insertItem(Number(packet.insertId), 57, { amount: amount });
                resolve();
            }).catch(reject);
        }
    });
}

module.exports = async function(session, parts) {
    const bot = session.viewedPrivateStoreSeller;
    if (!bot) {
        session.dataSendToMe(ServerResponse.speak(session.actor, { kind: 0, text: "No merchant selected." }));
        return;
    }

    const store = bot.fetchPrivateStore();
    if (!store || store.storeType !== 2 || !store.items.length) {
        session.dataSendToMe(ServerResponse.speak(session.actor, { kind: 0, text: "This merchant is not buying anything." }));
        return;
    }

    if (parts.length < 2) {
        session.dataSendToMe(ServerResponse.npcHtml(bot.fetchId(), buildShopHtml(session, bot)));
        return;
    }

    const selfId = parseInt(parts[1]);
    const rawQty = parseInt(parts[2]);
    const qty = isNaN(rawQty) || rawQty < 1 ? 1 : rawQty;

    const storeItem = store.items.find(i => i.selfId === selfId);
    if (!storeItem) {
        session.dataSendToMe(ServerResponse.npcHtml(bot.fetchId(), buildShopHtml(session, bot)));
        return;
    }

    const playerItem = session.actor.backpack.fetchItemFromSelfId(selfId);
    const playerCount = playerItem ? playerItem.fetchAmount() : 0;
    const sellQty = Math.min(qty, playerCount, storeItem.count);
    if (sellQty <= 0) {
        session.dataSendToMe(ServerResponse.npcHtml(bot.fetchId(), buildShopHtml(session, bot)));
        return;
    }

    const totalEarn = storeItem.price * sellQty;

    try {
        await takeItem(session, selfId, sellQty);
        await giveAdena(session, totalEarn);

        session.dataSendToMe(ServerResponse.userInfo(session.actor));
        session.dataSendToMe(ServerResponse.itemsList(session.actor.backpack.fetchItems()));
        session.dataSendToMe(ServerResponse.npcHtml(bot.fetchId(), buildShopHtml(session, bot)));
    } catch (err) {
        utils.infoWarn("SellToMerchantItem", "sell error: " + err);
        session.dataSendToMe(ServerResponse.actionFailed());
        session.dataSendToMe(ServerResponse.npcHtml(bot.fetchId(), buildShopHtml(session, bot)));
    }
};
