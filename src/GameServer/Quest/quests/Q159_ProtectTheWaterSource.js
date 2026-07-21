const A = 7154,
  D = 1035,
  C1 = 1071,
  C2 = 1072;
const Q = () => invoke("GameServer/Quest/QuestService");
const p = (t, x, a = "") =>
  `<html><body>${t}:<br>${x}<br><br>${a}</body></html>`;
const n = (s, id) =>
  s.session.actor.backpack.fetchItemFromSelfId(id)?.fetchAmount() || 0;
module.exports = {
  id: 159,
  name: "Protect the Water Source",
  npcs: [A],
  startNpcs: [A],
  killNpcs: [5017],
  eventNpc: (e) => (e === "start" ? A : null),
  async onEvent(s, e) {
    const a = s.session.actor;
    if (
      e !== "start" ||
      s.isStarted() ||
      Number(a.fetchRace()) !== 1 ||
      Number(a.fetchLevel()) < 12
    )
      return null;
    await s.setState("started");
    await s.set("cond", 1);
    await Q().giveItem(s.session, C1, 1);
    s.playSound("ItemSound.quest_accept");
    return p("Asterios", "Destroy the plague zombies.");
  },
  async onTalk(s) {
    const a = s.session.actor,
      q = Q(),
      c = s.getInt("cond");
    if (s.isCompleted())
      return p("Quest", "You have already completed this quest.");
    if (!s.isStarted())
      return Number(a.fetchRace()) === 1 && Number(a.fetchLevel()) >= 12
        ? p(
            "Asterios",
            "Will you protect the water?",
            '<a action="bypass -h quest 159 start">Accept.</a>',
          )
        : p("Asterios", "Only elves of level 12 or higher.");
    if (c === 2) {
      await q.takeItem(s, D, -1);
      await q.takeItem(s, C1);
      await q.giveItem(s.session, C2, 1);
      await s.set("cond", 3);
      s.playSound("ItemSound.quest_middle");
      return p("Asterios", "The source is not clean yet.");
    }
    if (c === 4) {
      await q.takeItem(s, C2);
      await q.takeItem(s, D, -1);
      await q.rewardAdena(s.session, 18250);
      s.playSound("ItemSound.quest_finish");
      await s.exit(false);
      return p("Asterios", "The water is safe.");
    }
    return p("Asterios", "Continue your task.");
  },
  async onKill(s) {
    const c = s.getInt("cond"),
      need = c === 1 ? 1 : c === 3 ? 5 : 0;
    if (!need || Math.random() >= 0.4 || n(s, D) >= need) return;
    await Q().giveItem(s.session, D, 1);
    if (n(s, D) >= need) {
      await s.set("cond", c + 1);
      s.playSound("ItemSound.quest_middle");
    } else s.playSound("ItemSound.quest_itemget");
  },
};
