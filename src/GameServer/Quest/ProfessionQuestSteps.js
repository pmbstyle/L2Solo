// Steps shared by the hand-written profession quests. The quest service
// is resolved on each call, as the quests themselves do, so load order and
// test replacements of QuestService methods behave as before.
const MIDDLE = "ItemSound.quest_middle";

function service() {
  return invoke("GameServer/Quest/QuestService");
}

function count(state, selfId) {
  return state.session.actor.backpack.fetchItemFromSelfId(selfId)?.fetchAmount() || 0;
}

// Drop a quest item toward `needed` with probability `chance`; true when the
// stack is now complete. Without a chance every roll drops (Q401 spider legs;
// before sharing, Q406/Q408 had no default and always pass one).
async function collect(state, selfId, needed, chance = 1) {
  const current = count(state, selfId);
  if (current >= needed || Math.random() >= chance) return false;
  const amount = service().questDropAmount(1, needed, current);
  if (!amount) return false;
  await service().giveItem(state.session, selfId, amount);
  return current + amount >= needed;
}

// Take each listed item in order, then give one `give` and set the step.
// A failed take stops there: earlier takes stay done, nothing is given.
async function exchange(state, remove, give, condition) {
  const quest = service();
  for (const item of remove) {
    if (!(await quest.takeItem(state.session, item))) return false;
  }
  await quest.giveItem(state.session, give, 1);
  await state.set("cond", condition);
  state.playSound(MIDDLE);
  return true;
}

module.exports = { collect, exchange };
