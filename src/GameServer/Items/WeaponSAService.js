const { randomBytes } = require('node:crypto');
const Catalog = require('./C4WeaponSAExchange');
const NpcIndex = require('../World/NpcObjectIndex');
const Data = invoke('GameServer/DataCache');
const Database = invoke('Database');
const Response = invoke('GameServer/Network/Response');
const World = invoke('GameServer/World/World');
const escape = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const template = id => Data.items.find(item => item.selfId === Number(id));
const itemName = id => template(id)?.template.name || `Item ${id}`;

function nearby(session) {
    const actor = session.actor, talk = session.activeNpcTalk;
    const npc = NpcIndex.find(World, talk?.objectId);
    if (!actor || !npc || !Catalog.station(npc.fetchSelfId()) || npc.fetchSelfId() !== talk?.selfId
        || npc.isDead?.() || actor.isDead?.() || actor.fetchIsOnline?.() === false
        || actor.state?.fetchCombats?.() || actor.state?.fetchHits?.() || actor.state?.fetchCasts?.()
        || session.activeTrade || session.botTrade || actor.fetchPrivateStoreType?.() || session.activeEnchantItem
        || session.persistenceMode === 'ephemeral'
        || Math.hypot(actor.fetchLocX() - npc.fetchLocX(), actor.fetchLocY() - npc.fetchLocY()) > 200
        || Math.abs(actor.fetchLocZ() - npc.fetchLocZ()) > 200) throw Error('Speak to a nearby smith outside combat, trade or enchanting.');
    return npc;
}
function usable(item) { return item && item.isWeapon() && item.fetchAmount() === 1 && !item.fetchEquipped() && !item.fetchPetLocked?.(); }
function render(session, npc, body) {
    session.dataSendToMe(Response.npcHtml(npc.fetchId(), `<html><body>${escape(npc.fetchName())}:<br>${body}</body></html>`));
    session.dataSendToMe(Response.actionFailed());
}
function menu(session, operation = 'install', page = 0, message = '') {
    const npc = nearby(session);
    if (!['install', 'remove'].includes(operation)) throw Error('Unknown service.');
    session.activeWeaponSA = null;
    const choices = session.actor.backpack.fetchItems().filter(usable).flatMap(item =>
        Catalog.options(npc.fetchSelfId(), item.fetchSelfId(), operation).map(recipe => ({ item, recipe })));
    const pages = Math.max(1, Math.ceil(choices.length / 6));
    page = Math.max(0, Math.min(pages - 1, Math.floor(Number(page) || 0)));
    const links = choices.slice(page * 6, page * 6 + 6).map(({ item, recipe }) =>
        `<a action="bypass -h weapon-sa preview ${item.fetchId()} ${recipe.id}">+${item.fetchEnchantLevel()} ${escape(itemName(recipe.productId))}</a><br>`).join('');
    render(session, npc, `${escape(message)}<br>${operation === 'install' ? 'Install' : 'Remove'} a special ability.<br>
        Unequip the weapon first. Its enchantment will be preserved.<br>
        ${Catalog.station(npc.fetchSelfId()) === 'blacksmith' ? 'For A/S-grade weapons or removal, visit the Blacksmith of Mammon.<br>' : ''}
        ${links || 'No eligible unequipped weapons.'}<br>
        ${page > 0 ? `<a action="bypass -h weapon-sa menu ${operation} ${page - 1}">Previous</a><br>` : ''}
        ${page + 1 < pages ? `<a action="bypass -h weapon-sa menu ${operation} ${page + 1}">Next</a><br>` : ''}
        ${Catalog.links(npc.fetchSelfId())}
        ${npc.fetchSelfId() === 8126 ? '<a action="bypass -h mammon-unseal">Unseal equipment</a><br>' : ''}`);
}
function preview(session, objectId, recipeId) {
    const npc = nearby(session), actor = session.actor;
    if (session.weaponSAPending) throw Error('An exchange is already in progress.');
    const item = actor.backpack.fetchItemRaw(Number(objectId));
    const recipe = Catalog.resolve(npc.fetchSelfId(), recipeId);
    if (!usable(item) || !recipe || item.fetchSelfId() !== recipe.sourceId || !template(recipe.productId)) throw Error('This weapon cannot be exchanged here.');
    const token = randomBytes(16).toString('hex');
    session.activeWeaponSA = { token, actor, item, npcId: npc.fetchSelfId(), npcObjectId: npc.fetchId(),
        recipeId, sourceId: item.fetchSelfId(), enchant: item.fetchEnchantLevel(), expiresAt: Date.now() + 120000 };
    const costs = Catalog.costs(recipe).map(cost => `${cost.amount} × ${escape(itemName(cost.selfId))}`).join('<br>');
    render(session, npc, `+${item.fetchEnchantLevel()} ${escape(item.fetchName())}<br>→<br>
        +${item.fetchEnchantLevel()} ${escape(itemName(recipe.productId))}<br><br>
        Required materials:<br>${costs || 'None.'}<br><br>Enchantment +${item.fetchEnchantLevel()} is preserved.<br>
        ${recipe.operation === 'remove' ? 'The Soul Crystal and gemstones will not be returned.<br>' : ''}
        <a action="bypass -h weapon-sa apply ${token}">Confirm ${recipe.operation === 'install' ? 'installation' : 'removal'}</a><br>
        <a action="bypass -h weapon-sa menu ${recipe.operation}">Back</a>`);
    return token;
}
async function exchange(session, token) {
    const npc = nearby(session), context = session.activeWeaponSA;
    if (session.weaponSAPending || !context || context.token !== token || context.expiresAt < Date.now()
        || context.actor !== session.actor || context.npcObjectId !== npc.fetchId()) throw Error('Open the weapon exchange again.');
    session.activeWeaponSA = null; // One confirmation permits exactly one exchange.
    session.weaponSAPending = true;
    const { actor, item, npcId, recipeId, sourceId, enchant } = context;
    const recipe = Catalog.resolve(npcId, recipeId);
    const validate = (rows = []) => {
        const currentNpc = nearby(session);
        if (session.actor !== actor || currentNpc.fetchId() !== context.npcObjectId
            || actor.backpack.fetchItemRaw(item.fetchId()) !== item || !usable(item)
            || item.fetchSelfId() !== sourceId || item.fetchEnchantLevel() !== enchant) throw Error('The weapon or interaction has changed.');
        for (const row of rows) {
            const live = actor.backpack.fetchItemRaw(row.id);
            if (!live || live.fetchSelfId() !== row.selfId || live.fetchAmount() !== row.amount
                || live.fetchEquipped() || live.fetchPetLocked?.()) throw Error('The materials have changed.');
        }
    };
    try {
        const result = await Database.exchangeWeaponSA(actor.fetchId(), { npcId, recipeId,
            sourceObjectId: item.fetchId(), expectedSelfId: sourceId, expectedEnchant: enchant, validate });
        for (const row of result.consumed) {
            const material = actor.backpack.fetchItemRaw(row.id);
            if (row.remaining) material.setAmount(row.remaining);
            else actor.backpack.items = actor.backpack.items.filter(entry => entry.fetchId() !== row.id);
        }
        // Replace template stats, retaining the very same inventory object and
        // all persisted instance fields, including enchant and shortcut id.
        item.model = { ...utils.crushOb(template(result.weapon.selfId)), ...result.weapon, equipped: false };
        if (session.actor === actor) session.dataSendToMe(Response.itemsList(actor.backpack.fetchItems()));
        return { ...result, operation: recipe.operation };
    } finally { session.weaponSAPending = false; }
}
module.exports = { nearby, menu, preview, exchange };
