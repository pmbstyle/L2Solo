const L = 7368,
  B = 7369,
  A = 1022,
  D = 1023;
const Q = () => invoke("GameServer/Quest/QuestService"),
  p = (t, x, a = "") => `<html><body>${t}:<br>${x}<br><br>${a}</body></html>`;
module.exports = {
  id: 156,
  name: "Millennium Love",
  npcs: [L, B],
  startNpcs: [L],
  eventNpc: (e) => (e === "start" ? L : null),
  async onEvent(s, e) {
    if (e !== "start" || s.isStarted() || s.session.actor.fetchLevel() < 15)
      return null;
    await s.setState("started");
    await s.set("cond", 1);
    await Q().giveItem(s.session, A, 1);
    return p("Lilith", "Take this letter to Baenedes.");
  },
  async onTalk(s, x) {
    const q = Q(),
      id = x.fetchSelfId();
    if (!s.isStarted())
      return p("Lilith", '<a action="bypass -h quest 156 start">Accept.</a>');
    if (id === B && s.getInt("cond") === 1) {
      await q.takeItem(s, A);
      await q.giveItem(s.session, D, 1);
      await s.set("cond", 2);
      return p("Baenedes", "Return the diary.");
    }
    if (id === L && s.getInt("cond") === 2) {
      await q.takeItem(s, D);
      await q.giveItem(s.session, 5250, 1);
      await q.rewardExpSp(s.session, 3000, 0);
      s.playSound("ItemSound.quest_finish");
      await s.exit(false);
      return p("Lilith", "Our love endures.");
    }
    return p("Quest", "Continue.");
  },
};
