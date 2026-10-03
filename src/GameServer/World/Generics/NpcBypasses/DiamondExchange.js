const data = require('../../../../../data/Items/dimensional_diamond_exchanges.json');
const Service = invoke('GameServer/Quest/QuestService');
const Profession = invoke('GameServer/SecondProfession');
const Database = invoke('Database');
const Response = invoke('GameServer/Network/Response');
const H = require('../../../Quest/SecondProfessionQuest');

function render(session, message = '') {
    const links = data.recipes.map(row => `${H.itemName(row.itemId)} - ${row.cost} Dimensional Diamonds `
        + `<a action="bypass -h diamond-exchange ${row.itemId}">Exchange</a><br>`).join('');
    session.dataSendToMe(Response.npcHtml(session.activeNpcTalk.objectId,
        `<html><body>Dimensional Diamond exchange:<br>${message}<br>${links}</body></html>`));
    session.dataSendToMe(Response.actionFailed());
}

module.exports = function diamondExchange(session, parts) {
    return Service.mutate(session, async () => {
        if (!data.npcs.includes(session.activeNpcTalk?.selfId) || !Profession.nearbyNpc(session)) {
            return session.dataSendToMe(Response.actionFailed());
        }
        if (!parts[1]) return render(session);
        const itemId = Number(parts[1]);
        if (!data.recipes.some(row => row.itemId === itemId)) return;
        let rows;
        try { rows = await Database.exchangeDimensionalDiamond(session.actor.fetchId(), itemId); }
        catch (error) { return render(session, 'The exchange could not be completed. Check your Dimensional Diamonds.'); }
        for (const row of rows) {
            if (!row.amount) session.actor.backpack.items = session.actor.backpack.items.filter(item => item.fetchId() !== row.id);
            else if (session.actor.backpack.fetchItemRaw(row.id)) session.actor.backpack.fetchItemRaw(row.id).setAmount(row.amount);
            else session.actor.backpack.insertItem(row.id, row.selfId, row);
        }
        session.dataSendToMe(Response.itemsList(session.actor.backpack.fetchItems()));
        Service.transmitItemReceived(session, itemId, 1);
        return render(session, `Received ${H.itemName(itemId)}.`);
    }).catch(error => {
        utils.infoWarn('Quest', 'diamond exchange failed: %s', error.message);
        session.dataSendToMe(Response.actionFailed());
    });
};
