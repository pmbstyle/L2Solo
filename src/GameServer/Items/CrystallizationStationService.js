const { randomBytes } = require('node:crypto');
const Station = require('../World/GiranCrystallizationStation');
const NpcIndex = require('../World/NpcObjectIndex');
const Rules = require('./C4EnchantRules');
const ItemTemplateIndex = require('../Item/ItemTemplateIndex');
const Data = invoke('GameServer/DataCache');
const Database = invoke('Database');
const Response = invoke('GameServer/Network/Response');
const ConsoleText = invoke('GameServer/ConsoleText');
const World = invoke('GameServer/World/World');
const escape = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function nearby(session) {
    const actor = session.actor, talk = session.activeNpcTalk;
    const npc = NpcIndex.find(World, talk?.objectId);
    if (!actor || !npc || npc.fetchSelfId() !== Station.npcId || talk?.selfId !== Station.npcId
        || npc.isDead?.() || actor.isDead?.() || actor.fetchIsOnline?.() === false
        || actor.state?.fetchCombats?.() || actor.state?.fetchHits?.() || actor.state?.fetchCasts?.()
        || session.activeTrade || session.botTrade || actor.fetchPrivateStoreType?.() || session.activeEnchantItem
        || session.persistenceMode === 'ephemeral'
        || Math.hypot(actor.fetchLocX() - npc.fetchLocX(), actor.fetchLocY() - npc.fetchLocY()) > 200
        || Math.abs(actor.fetchLocZ() - npc.fetchLocZ()) > 200) {
        throw Error('Speak to the nearby crystallization station outside combat, trade or enchanting.');
    }
    return npc;
}

function quote(item) {
    if (!item?.isWearable?.() || item.fetchAmount() !== 1 || item.fetchEquipped() || item.fetchPetLocked?.()) return null;
    const crystalId = Rules.CRYSTAL_IDS[Rules.gradeOf(item)];
    const gross = Rules.crystalCount(item);
    const crystal = ItemTemplateIndex.find(Data.items, crystalId);
    if (!crystal || !Number.isSafeInteger(gross) || gross <= 0) return null;
    const fee = Math.ceil(gross * 15 / 100);
    const net = gross - fee;
    return net > 0 ? { crystalId, crystalName: crystal.template.name, gross, fee, net } : null;
}

function render(session, npc, body) {
    session.dataSendToMe(Response.npcHtml(npc.fetchId(), `<html><body>Crystallization Station:<br>${body}</body></html>`));
    session.dataSendToMe(Response.actionFailed());
}

function menu(session, page = 0, message = '') {
    const npc = nearby(session);
    session.activeCrystallization = null;
    const choices = session.actor.backpack.fetchItems().filter(item => quote(item));
    const pages = Math.max(1, Math.ceil(choices.length / 6));
    page = Math.max(0, Math.min(pages - 1, Math.floor(Number(page) || 0)));
    const links = choices.slice(page * 6, page * 6 + 6).map(item =>
        `<a action="bypass -h crystallization-station preview ${item.fetchId()}">+${item.fetchEnchantLevel()} ${escape(item.fetchName())}</a><br>`).join('');
    render(session, npc, `${escape(message)}<br>Crystallize D through S-grade equipment.<br>
        Unequip the item first. No skill is required.<br>
        Service fee: 15% of the crystals, rounded up.<br>
        The remaining crystals go straight to your inventory.<br><br>
        ${links || 'You have no eligible unequipped equipment.'}<br>
        ${page > 0 ? `<a action="bypass -h crystallization-station page ${page - 1}">Previous</a><br>` : ''}
        ${page + 1 < pages ? `<a action="bypass -h crystallization-station page ${page + 1}">Next</a><br>` : ''}`);
}

function preview(session, objectId) {
    const npc = nearby(session), actor = session.actor;
    if (session.crystallizationPending) throw Error('Crystallization is already in progress.');
    const item = actor.backpack.fetchItemRaw(Number(objectId));
    const reward = quote(item);
    if (!reward) throw Error('Select an eligible unequipped item.');
    const token = randomBytes(16).toString('hex');
    session.activeCrystallization = {
        token, actor, item, npcObjectId: npc.fetchId(), selfId: item.fetchSelfId(),
        enchant: item.fetchEnchantLevel(), reward, expiresAt: Date.now() + 120000
    };
    render(session, npc, `+${item.fetchEnchantLevel()} ${escape(item.fetchName())}<br><br>
        Crystals: ${reward.gross} ${escape(reward.crystalName)}<br>
        Service fee (15%, rounded up): ${reward.fee}<br>
        You receive: ${reward.net} ${escape(reward.crystalName)}<br><br>
        This will permanently destroy the item.<br><br>
        <a action="bypass -h crystallization-station apply ${token}">Confirm crystallization</a><br>
        <a action="bypass -h crystallization-station">Back</a>`);
    return token;
}

async function crystallize(session, token) {
    const npc = nearby(session), context = session.activeCrystallization;
    if (session.crystallizationPending || !context || context.token !== token || context.expiresAt < Date.now()
        || context.actor !== session.actor || context.npcObjectId !== npc.fetchId()) throw Error('Select the item again.');
    session.activeCrystallization = null;
    session.crystallizationPending = true;
    const { actor, item, selfId, enchant, reward } = context;
    const validate = () => {
        const currentNpc = nearby(session), currentReward = quote(item);
        if (session.actor !== actor || currentNpc.fetchId() !== context.npcObjectId
            || actor.backpack.fetchItemRaw(item.fetchId()) !== item || item.fetchSelfId() !== selfId
            || item.fetchEnchantLevel() !== enchant || !currentReward
            || currentReward.crystalId !== reward.crystalId || currentReward.gross !== reward.gross) {
            throw Error('The item or interaction has changed. Select it again.');
        }
    };
    try {
        const result = await Database.crystallizeInventoryItem(actor.fetchId(), {
            sourceId: item.fetchId(), sourceSelfId: selfId, expectedEnchant: enchant,
            crystalId: reward.crystalId, crystalName: reward.crystalName, crystalAmount: reward.net, validate
        });
        actor.backpack.items = actor.backpack.items.filter(entry => entry !== item);
        const existing = actor.backpack.fetchItemRaw(result.id);
        if (existing) existing.setAmount(result.amount);
        else actor.backpack.insertItem(result.id, reward.crystalId, { amount: result.amount, equipped: false, slot: 0 });
        if (session.actor === actor) {
            session.dataSendToMe(Response.itemsList(actor.backpack.fetchItems()));
            const params = [{ kind: ConsoleText.kind.item, value: reward.crystalId }];
            if (reward.net > 1) params.push({ kind: ConsoleText.kind.number, value: reward.net });
            ConsoleText.transmit(session, reward.net > 1 ? ConsoleText.caption.pickupAmountOf : ConsoleText.caption.pickup, params);
            actor.statusUpdateVitals?.(actor);
        }
        return reward;
    } finally {
        session.crystallizationPending = false;
    }
}

module.exports = { nearby, quote, menu, preview, crystallize };
