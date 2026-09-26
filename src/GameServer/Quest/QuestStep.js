const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const Response = invoke('GameServer/Network/Response');

// One compare-and-swap transaction for state, hand-in and reward. The caller
// must be a server-authored handler that has validated its NPC and conditions.
async function apply(state, { takes = [], gives = [], variables = state.variables, status = 'started', exp = 0, sp = 0, beginner = null, pk = null }) {
    const actor = state.session.actor;
    const next = { state: status, variables: { ...variables, revision: String(state.getInt('revision') + 1) } };
    const rewards = gives.flatMap(([selfId, amount]) => {
        const template = DataCache.items.find(item => item.selfId === selfId);
        if (!template) throw new Error(`Missing quest item ${selfId}`);
        const item = { selfId, amount, name: template.template.name, stackable: template.etc.stackable };
        return item.stackable ? [item] : Array.from({ length: amount }, () => ({ ...item, amount: 1 }));
    });
    const rates = invoke('GameServer/ProgressionRates').profile();
    const experience = exp || sp ? {
        exp: Math.max(0, Math.round(exp * rates.questExp * invoke('GameServer/Effects/EffectStats').multiplier(actor, 'expMul'))),
        sp: Math.max(0, Math.round(sp * rates.questSp))
    } : null;
    const rows = await Database.applyQuestStep(actor.fetchId(), state.quest.id,
        { state: state.state, variables: state.variables }, next,
        takes.map(([selfId, amount]) => ({ selfId, amount })), rewards, experience, beginner, pk);
    for (const row of rows) {
        const item = actor.backpack.fetchItemRaw(row.id);
        if (!row.amount) {
            actor.backpack.items = actor.backpack.items.filter(i => i.fetchId() !== row.id);
        } else if (item) item.setAmount(row.amount);
        else actor.backpack.insertItem(row.id, row.selfId, row);
    }
    state.state = next.state;
    state.variables = next.variables;
    if (rows.experience) {
        const award = rows.experience;
        actor.setExpSp(award.totalExp, award.totalSp);
        if (award.level > actor.fetchLevel()) invoke('GameServer/Actor/Generics/LevelUp')(state.session, actor, award.level);
        const text = invoke('GameServer/ConsoleText');
        text.transmit(state.session, text.caption.earnedExpAndSp, [
            { kind: text.kind.number, value: award.grantedExp }, { kind: text.kind.number, value: award.grantedSp }
        ]);
        if (actor.fetchMaxHp) state.session.dataSendToMe(Response.userInfo(actor));
    }
    // Keep the in-memory actor's receipt aligned with the committed one.
    if (rows.beginner) {
        if (actor.setNewbieShotsReceived) actor.setNewbieShotsReceived(rows.beginner.received);
        else actor.newbieShotsReceived = rows.beginner.received;
    }
    if (rows.pk !== undefined) actor.setPk(rows.pk);
    state.session.dataSendToMe(Response.itemsList(actor.backpack.fetchItems()));
    for (const [id, amount] of gives) invoke('GameServer/Quest/QuestService').transmitItemReceived(state.session, id, amount);
    return { ok: true };
}
module.exports = { apply };
