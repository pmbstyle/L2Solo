function service() { return invoke('GameServer/Quest/QuestService'); }
function count(state, id) { return state.session.actor.backpack.fetchItemFromSelfId(id)?.fetchAmount() || 0; }
function page(title, text, action = '') { return `<html><body>${title}:<br>${text}<br><br>${action}</body></html>`; }
function formalCondition(session) { const q = service().quests().find((quest) => quest.id === 37); return q ? service().stateFor(session, q).getInt('cond') : 0; }
async function collect(state, itemId, needed) { const current = count(state, itemId); if (Math.random() >= 0.5) return false; const amount = service().questDropAmount(1, needed, current); if (!amount) return false; await service().giveItem(state.session, itemId, amount); return current + amount >= needed; }
module.exports = { service, count, page, formalCondition, collect };
