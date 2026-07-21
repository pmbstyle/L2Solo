const W = 7005,
  O = 1024,
  B = 20;
const Q = () => invoke("GameServer/Quest/QuestService"),
  p = (t, x, a = "") => `<html><body>${t}:<br>${x}<br><br>${a}</body></html>`,
  n = (s) =>
    s.session.actor.backpack.fetchItemFromSelfId(O)?.fetchAmount() || 0;
module.exports = {
  id: 157,
  name: "Recover Smuggled Goods",
  npcs: [W],
  startNpcs: [W],
  killNpcs: [121],
  eventNpc: (e) => (e === "start" ? W : null),
  async onEvent(s, e) {
    if (
      e !== "start" ||
      s.isStarted() ||
      Number(s.session.actor.fetchLevel()) < 5
    )
      return null;
    await s.setState("started");
    await s.set("cond", 1);
    s.playSound("ItemSound.quest_accept");
    return p("Wilford", "Recover 20 Adamantite Ore.");
  },
  async onTalk(s, x) {
    if (s.isCompleted())
      return p("Quest", "You have already completed this quest.");
    if (!s.isStarted())
      return Number(s.session.actor.fetchLevel()) >= 5
        ? p(
            "Wilford",
            "Will you recover the goods?",
            '<a action="bypass -h quest 157 start">Accept.</a>',
          )
        : p("Wilford", "Come back at level 5.");
    if (n(s) >= 20) {
      await Q().takeItem(s, O, 20);
      await Q().giveItem(s.session, B, 1);
      s.playSound("ItemSound.quest_finish");
      await s.exit(false);
      return p("Wilford", "Here is your Buckler.");
    }
    return p("Wilford", `Adamantite Ore: ${n(s)}/20.`);
  },
  async onKill(s) {
    if (s.getInt("cond") !== 1 || Math.random() >= 0.4) return;
    const c = n(s),
      a = Q().questDropAmount(1, 20, c);
    if (a) {
      await Q().giveItem(s.session, O, a);
      if (c + a >= 20) {
        await s.set("cond", 2);
        s.playSound("ItemSound.quest_middle");
      } else s.playSound("ItemSound.quest_itemget");
    }
  },
};
