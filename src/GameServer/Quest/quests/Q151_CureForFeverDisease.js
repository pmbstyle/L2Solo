const E = 7050,
  Y = 7032,
  S = 1006,
  M = 1007;
const Q = () => invoke("GameServer/Quest/QuestService"),
  p = (t, x, a = "") => `<html><body>${t}:<br>${x}<br><br>${a}</body></html>`;
module.exports = {
  id: 151,
  name: "Cure for Fever Disease",
  npcs: [E, Y],
  startNpcs: [E],
  killNpcs: [106],
  eventNpc: (e) => (e === "start" ? E : null),
  async onEvent(s, e) {
    if (e !== "start" || s.isStarted() || s.session.actor.fetchLevel() < 15)
      return null;
    await s.setState("started");
    await s.set("cond", 1);
    s.playSound("ItemSound.quest_accept");
    return p("Elias", "Bring a poison sac.");
  },
  async onTalk(s, x) {
    const q = Q(),
      id = x.fetchSelfId(),
      c = s.getInt("cond");
    if (!s.isStarted())
      return p("Elias", '<a action="bypass -h quest 151 start">Accept.</a>');
    if (id === Y && c === 2) {
      await q.takeItem(s, S);
      await q.giveItem(s.session, M, 1);
      await s.set("cond", 3);
      return p("Yohanes", "Take the medicine to Elias.");
    }
    if (id === E && c === 3) {
      await q.takeItem(s, M);
      await q.giveItem(s.session, 102, 1);
      s.playSound("ItemSound.quest_finish");
      await s.exit(false);
      return p("Elias", "Thank you.");
    }
    return p("Quest", "Continue.");
  },
  async onKill(s) {
    if (s.getInt("cond") === 1 && Math.random() < 0.2) {
      await Q().giveItem(s.session, S, 1);
      await s.set("cond", 2);
      s.playSound("ItemSound.quest_middle");
    }
  },
};
