const C = 7350,
  H = 7255,
  N = 7210,
  L = 1076,
  NL = 1106;
const Q = () => invoke("GameServer/Quest/QuestService"),
  p = (t, x, a = "") => `<html><body>${t}:<br>${x}<br><br>${a}</body></html>`;
module.exports = {
  id: 167,
  name: "Dwarven Kinship",
  npcs: [C, H, N],
  startNpcs: [C],
  eventNpc: (e) => (e === "start" ? C : null),
  async onEvent(s, e) {
    if (e !== "start" || s.isStarted() || s.session.actor.fetchLevel() < 15)
      return null;
    await s.setState("started");
    await s.set("cond", 1);
    await Q().giveItem(s.session, L, 1);
    s.playSound("ItemSound.quest_accept");
    return p("Carlon", "Take my letter to Haprock.");
  },
  async onTalk(s, x) {
    const q = Q(),
      id = x.fetchSelfId(),
      c = s.getInt("cond");
    if (s.isCompleted())
      return p("Quest", "You have already completed this quest.");
    if (!s.isStarted())
      return p("Carlon", '<a action="bypass -h quest 167 start">Accept.</a>');
    if (id === H && c === 1)
      return p(
        "Haprock",
        '<a action="bypass -h quest 167 haprock">Deliver the letter.</a>',
      );
    if (id === H && c === 2)
      return p(
        "Haprock",
        '<a action="bypass -h quest 167 haprock_finish">Finish here.</a>',
      );
    if (id === N && c === 2)
      return p(
        "Norman",
        '<a action="bypass -h quest 167 norman_finish">Deliver to Norman.</a>',
      );
    return p("Quest", "Continue.");
  },
  async onEvent(s, e) {
    const q = Q();
    if (e === "start" && !s.isStarted()) {
      if (s.session.actor.fetchLevel() < 15) return null;
      await s.setState("started");
      await s.set("cond", 1);
      await q.giveItem(s.session, L, 1);
      return p("Carlon", "Take my letter to Haprock.");
    }
    if (e === "haprock" && s.getInt("cond") === 1) {
      await q.takeItem(s, L);
      await q.giveItem(s.session, NL, 1);
      await q.rewardAdena(s.session, 2000);
      await s.set("cond", 2);
      return p("Haprock", "Take this to Norman, or finish here.");
    }
    if (e === "haprock_finish" && s.getInt("cond") === 2) {
      await q.takeItem(s, NL);
      await q.rewardAdena(s.session, 3000);
      await s.exit(false);
      return p("Haprock", "Farewell.");
    }
    if (e === "norman_finish" && s.getInt("cond") === 2) {
      await q.takeItem(s, NL);
      await q.rewardAdena(s.session, 20000);
      await s.exit(false);
      return p("Norman", "Welcome, kin.");
    }
    return null;
  },
};
