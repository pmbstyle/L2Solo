const A = 7042,
  W = 7311,
  L = 1019,
  H = 734,
  Q = () => invoke("GameServer/Quest/QuestService"),
  p = (t, x, a = "") => `<html><body>${t}:<br>${x}<br><br>${a}</body></html>`;
module.exports = {
  id: 155,
  name: "Find Sir Windawood",
  npcs: [A, W],
  startNpcs: [A],
  eventNpc: (e) => (e === "start" ? A : null),
  async onEvent(s, e) {
    if (
      e !== "start" ||
      s.isStarted() ||
      Number(s.session.actor.fetchLevel()) < 3
    )
      return null;
    await s.setState("started");
    await s.set("cond", 1);
    await Q().giveItem(s.session, L, 1);
    s.playSound("ItemSound.quest_accept");
    return p("Abellos", "Deliver the official letter.");
  },
  async onTalk(s, n) {
    const id = Number(n.fetchSelfId());
    if (s.isCompleted())
      return p("Quest", "You have already completed this quest.");
    if (!s.isStarted())
      return id === A && Number(s.session.actor.fetchLevel()) >= 3
        ? p(
            "Abellos",
            "Find Sir Windawood.",
            '<a action="bypass -h quest 155 start">Accept.</a>',
          )
        : p("Abellos", "Come back at level 3.");
    if (id === W) {
      if (!(await Q().takeItem(s, L))) return null;
      await Q().giveItem(s.session, H, 1);
      s.playSound("ItemSound.quest_finish");
      await s.exit(false);
      return p("Sir Windawood", "Thank you for the letter.");
    }
    return p("Abellos", "Find Sir Windawood.");
  },
};
