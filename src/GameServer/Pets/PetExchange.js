const { randomBytes } = require('crypto');
const { managers, tickets } = require('./PetExchangeData');
const NpcIndex = require('../World/NpcObjectIndex');
const World = invoke('GameServer/World/World');
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const Response = invoke('GameServer/Network/Response');

function manager(session) {
    const actor = session.actor;
    const talk = session.activeNpcTalk;
    const npc = NpcIndex.find(World, talk?.objectId);
    if (!actor || !npc || !managers.has(npc.fetchSelfId()) || npc.fetchSelfId() !== talk?.selfId ||
        actor.isDead?.() || session.activeTrade || session.botTrade || actor.fetchPrivateStoreType?.() ||
        session.persistenceMode === 'ephemeral' ||
        Math.hypot(actor.fetchLocX() - npc.fetchLocX(), actor.fetchLocY() - npc.fetchLocY()) > 200 ||
        Math.abs(actor.fetchLocZ() - npc.fetchLocZ()) > 200) throw new Error('Speak to a nearby Pet Manager to exchange your ticket.');
    return npc;
}
function menu(session, message = '') {
    const npc = manager(session);
    const token = randomBytes(16).toString('hex');
    session.activePetExchange = { token, objectId: npc.fetchId() };
    const links = Object.entries(tickets).map(([id, entry]) =>
        `<a action="bypass -h pet-exchange exchange ${token} ${id}">Exchange one ticket for ${entry.name}</a><br>`).join('');
    session.dataSendToMe(Response.npcHtml(npc.fetchId(), `<html><body>Pet Manager:<br>${message}<br>One matching ticket is required for each pet.<br>${links}<br>Use the received item to summon your pet. Feed baby pets with Baby Spice.</body></html>`));
    session.dataSendToMe(Response.actionFailed());
}
async function exchange(session, token, ticketId) {
    const npc = manager(session);
    const context = session.activePetExchange;
    if (!context || context.token !== token || context.objectId !== npc.fetchId()) throw new Error('Open the ticket exchange menu again.');
    session.activePetExchange = null;
    const entry = tickets[ticketId];
    if (!entry) throw new Error('Unknown pet ticket.');
    if (!DataCache.items.some(item => item.selfId === entry.itemId)) throw new Error('Pet item is unavailable.');
    const actor = session.actor;
    const ticket = actor.backpack.fetchItemFromSelfId(Number(ticketId));
    if (!ticket || ticket.fetchAmount() < 1) throw new Error('You do not have the matching Pet Exchange Ticket.');
    const result = await Database.exchangePetTicket(actor.fetchId(), ticket.fetchId());
    if (result.remaining) ticket.setAmount(result.remaining);
    else actor.backpack.items = actor.backpack.items.filter(item => item.fetchId() !== ticket.fetchId());
    actor.backpack.insertItem(result.id, result.selfId, { amount: 1 });
    if (session.actor === actor) {
        session.dataSendToMe(Response.itemsList(actor.backpack.fetchItems()));
        session.dataSendToMe(Response.consoleText(54, [{ kind: 3, value: result.selfId }]));
    }
    return result;
}
module.exports = { menu, exchange, managers };
