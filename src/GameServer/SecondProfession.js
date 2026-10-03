// C4 village_master requirements, Lisvus fdc7e33a. Level-only transfer stays
// available through the existing temple-priest menus while trials are added.
const routes = require('../../data/Templates/second_profession_trials.json');
const ClassTransfer = require('./ClassTransfer');
const Response = invoke('GameServer/Network/Response');
const Database = invoke('Database');
const World = invoke('GameServer/World/World');
const NpcIndex = invoke('GameServer/World/NpcObjectIndex');
const H = require('./Quest/SecondProfessionQuest');

const handles = id => routes.some(route => route.npcs.includes(Number(id)));

function nearbyNpc(session) {
    const actor = session?.actor, talk = session?.activeNpcTalk;
    const npc = NpcIndex.find(World, talk?.objectId);
    if (!actor || actor.isDead() || !npc || npc.fetchSelfId() !== talk.selfId || npc.isDead()) return null;
    const distance = Math.hypot(actor.fetchLocX() - npc.fetchLocX(), actor.fetchLocY() - npc.fetchLocY());
    return distance <= 250 && Math.abs(actor.fetchLocZ() - npc.fetchLocZ()) <= 250 ? npc : null;
}

function render(session, message = '') {
    const actor = session.actor, id = session.activeNpcTalk?.selfId;
    if (!handles(id)) return false;
    const choices = routes.filter(route => route.npcs.includes(id) && route.race === actor.fetchRace()
        && (ClassTransfer.eligibility(actor, route.classId).ok || actor.fetchClassId() === route.classId));
    const body = choices.map(route => {
        if (actor.fetchClassId() === route.classId) return `<a action="bypass -h second-profession ${route.classId}">Refresh my ${route.name} skills</a><br>`;
        const marks = route.marks.map(mark => {
            const amount = actor.backpack.fetchItems().filter(item => item.fetchSelfId() === mark && !item.fetchEquipped())
                .reduce((sum, item) => sum + item.fetchAmount(), 0);
            return `${H.itemName(mark)}: ${amount ? 'ready' : 'missing'}`;
        }).join('<br>');
        return `${route.name}<br>${marks}<br><a action="bypass -h second-profession ${route.classId}">Become a ${route.name}</a><br><br>`;
    }).join('');
    session.dataSendToMe(Response.npcHtml(session.activeNpcTalk.objectId,
        `<html><body>Second profession:<br>Bring the three trial marks and reach level 40.<br><br>${message}<br>${body || 'No second-profession transfer is available for your current class.'}</body></html>`));
    session.dataSendToMe(Response.actionFailed());
    return true;
}

async function transfer(session, targetClassId) {
    if (!nearbyNpc(session)) return { ok: false, reason: 'npc' };
    const route = routes.find(route => route.classId === targetClassId);
    if (!route?.npcs.includes(session.activeNpcTalk.selfId) || route.race !== session.actor.fetchRace()) {
        return { ok: false, reason: 'wrong_profession' };
    }
    if (session.actor.fetchClassId() === targetClassId) {
        await ClassTransfer.refresh(session, { restoreVitals: false, celebrate: false });
        return { ok: true, targetClassId };
    }
    const check = ClassTransfer.eligibility(session.actor, targetClassId);
    if (!check.ok || check.requiredLevel !== 40) return { ok: false, reason: 'wrong_profession' };
    if (session.actor.fetchLevel() < 40) return { ok: false, reason: 'level' };
    let changed;
    try { changed = await Database.completeSecondProfession(session.actor.fetchId(), check.currentClassId, targetClassId); }
    catch (error) { return { ok: false, reason: 'marks', error }; }
    for (const row of changed) {
        if (row.amount) session.actor.backpack.fetchItemRaw(row.id)?.setAmount(row.amount);
        else session.actor.backpack.items = session.actor.backpack.items.filter(item => item.fetchId() !== row.id);
    }
    session.actor.setClassId(targetClassId);
    session.dataSendToMe(Response.itemsList(session.actor.backpack.fetchItems()));
    try {
        await ClassTransfer.refresh(session);
        return { ok: true, targetClassId };
    } catch (error) {
        // The durable class and consumed marks remain a single committed result.
        // The master can retry refresh, including after login, without charging
        // marks again: the persisted target class is proof of the transfer.
        utils.infoWarn('Character', 'second profession refresh failed for %s: %s', session.actor.fetchName(), error.message);
        return { ok: true, targetClassId, refreshPending: true };
    }
}

module.exports = { routes, handles, nearbyNpc, render, transfer };
