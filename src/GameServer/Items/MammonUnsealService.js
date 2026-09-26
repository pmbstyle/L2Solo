const Catalog = require('./C4Unseal');
const Mammon = require('../World/GiranMammon');
const Data = invoke('GameServer/DataCache');
const Database = invoke('Database');
const Response = invoke('GameServer/Network/Response');
const World = invoke('GameServer/World/World');
const NpcIndex = require('../World/NpcObjectIndex');

function nearby(session) {
    const actor = session.actor;
    const npc = NpcIndex.find(World, session.activeNpcTalk?.objectId);
    if (!actor || !npc || npc.fetchSelfId() !== Mammon.npcId || session.activeNpcTalk.selfId !== Mammon.npcId
        || actor.isDead?.() || actor.state?.fetchCombats?.() || actor.state?.fetchHits?.() || actor.state?.fetchCasts?.()
        || session.activeTrade || session.botTrade || actor.fetchPrivateStoreType?.() || session.persistenceMode === 'ephemeral'
        || Math.hypot(actor.fetchLocX()-npc.fetchLocX(),actor.fetchLocY()-npc.fetchLocY()) > 200
        || Math.abs(actor.fetchLocZ()-npc.fetchLocZ()) > 200) throw Error('mammon_unavailable');
    return npc;
}
const escape = value => String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
function menu(session, page = 0, message = '') {
    const npc = nearby(session);
    const choices = session.actor.backpack.fetchItems().filter(i => !i.fetchEquipped()).flatMap(item =>
        Catalog.options(item.fetchSelfId()).map(recipe => ({item,recipe})));
    const pages = Math.max(1, Math.ceil(choices.length / 8));
    page = Math.max(0,Math.min(pages-1,Number(page)||0));
    const links = choices.slice(page*8,page*8+8).map(({item,recipe}) => {
        const target = Data.items.find(i=>i.selfId===recipe.productId);
        return `<a action="bypass -h mammon-unseal exchange ${item.fetchId()} ${recipe.productId}">+${item.fetchEnchantLevel()} ${escape(target.template.name)}</a><br>`;
    }).join('');
    session.dataSendToMe(Response.npcHtml(npc.fetchId(), `<html><body>Blacksmith of Mammon:<br>
        Unsealing is free. Enchantment is preserved.<br>Unequip an item before unsealing it.<br>${escape(message)}<br>
        ${links || 'You have no unequipped sealed equipment.'}<br>
        ${invoke('GameServer/Items/C4WeaponSAExchange').links(npc.fetchSelfId())}
        ${page>0?`<a action="bypass -h mammon-unseal page ${page-1}">Previous</a><br>`:''}
        ${page+1<pages?`<a action="bypass -h mammon-unseal page ${page+1}">Next</a>`:''}</body></html>`));
    session.dataSendToMe(Response.actionFailed());
}
async function exchange(session, objectId, productId, validate = () => {}) {
    nearby(session);
    validate();
    if (session.mammonUnsealPending) throw Error('unseal_in_progress');
    const actor = session.actor;
    const item = actor.backpack.fetchItemRaw(Number(objectId));
    if (!item || item.fetchEquipped() || !Catalog.resolve(item.fetchSelfId(),productId)) throw Error('invalid_unseal_item');
    session.mammonUnsealPending = true;
    try {
        const row = await Database.unsealInventoryItem(actor.fetchId(),item.fetchId(),Number(productId), () => {
            nearby(session);
            validate();
            if (session.actor !== actor || actor.backpack.fetchItemRaw(item.fetchId()) !== item || item.fetchEquipped()) throw Error('unseal_interrupted');
        });
        const template = Data.items.find(i=>i.selfId===row.selfId);
        item.model = {...item.model,...utils.crushOb(template),...row,equipped:false};
        if (session.actor === actor) session.dataSendToMe(Response.itemsList(actor.backpack.fetchItems()));
        return row;
    } finally { delete session.mammonUnsealPending; }
}
module.exports = { menu, exchange, nearby };
