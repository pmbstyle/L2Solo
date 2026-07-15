const ServerResponse = invoke('GameServer/Network/Response');
const ExchangeLists  = invoke('GameServer/World/Generics/NpcExchangeShopLists');
const PurchaseItem   = invoke('GameServer/World/Generics/PurchaseItem');

function sendHtml(session, message = '') {
    const npcSelfId = session.activeNpcTalk?.selfId;
    const html = ExchangeLists.renderHtml(npcSelfId, message);
    session.dataSendToMe(ServerResponse.npcHtml(session.activeNpcTalk?.objectId ?? 7146, html));
}

function hasRequiredItems(backpack, required) {
    return required.every((entry) => {
        const item = backpack.fetchItemFromSelfId(entry.selfId);
        return item && item.fetchAmount() >= entry.amount;
    });
}

function deleteItem(session, item, amount) {
    return new Promise((resolve) => {
        session.actor.backpack.deleteItem(session, item.fetchId(), amount, resolve);
    });
}

async function exchange(session, recipe) {
    const backpack = session.actor.backpack;

    if (!hasRequiredItems(backpack, recipe.required)) {
        sendHtml(session, 'You do not have enough crystals.');
        return;
    }

    for (const entry of recipe.required) {
        const owned = backpack.fetchItemFromSelfId(entry.selfId);
        await deleteItem(session, owned, entry.amount);
    }

    PurchaseItem(session, recipe.result.selfId, recipe.result.amount);
    sendHtml(session, `Exchanged for ${recipe.result.name}.`);
}

module.exports = function(session, parts) {
    session.activeMerchantTrade = null;
    session.activeAdminShop = null;
    session.activeNpcShop = null;
    session.activeNpcSellShop = null;

    const npcSelfId = session.activeNpcTalk?.selfId;
    const rows = ExchangeLists.fetchForNpc(npcSelfId);
    if (!rows.length) {
        session.dataSendToMe(ServerResponse.actionFailed());
        return;
    }

    if (parts[1] === 'buy') {
        const index = Number(parts[2]);
        const recipe = rows[index];
        if (!Number.isInteger(index) || !recipe) {
            session.dataSendToMe(ServerResponse.actionFailed());
            return;
        }

        exchange(session, recipe).catch((err) => {
            utils.infoWarn('ExchangeShop', 'exchange error: %s', err.message || err);
            session.dataSendToMe(ServerResponse.actionFailed());
        });
        return;
    }

    sendHtml(session);
};
