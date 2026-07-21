const N = 7370,
  U = 7147,
  C = 7149,
  J = 7152,
  S = 1026,
  R = 1027,
  T = 1028,
  L = 1029,
  P = 1060;
const Q = () => invoke("GameServer/Quest/QuestService"),
  p = (t, x, a = "") => `<html><body>${t}:<br>${x}<br><br>${a}</body></html>`;
module.exports = {
  id: 160,
  name: "Nerupa's Request",
  npcs: [N, U, C, J],
  startNpcs: [N],
  eventNpc: (e) => (e === "start" ? N : null),
  async onEvent(s, e) {
    if (
      e !== "start" ||
      s.isStarted() ||
      Number(s.session.actor.fetchRace()) !== 1 ||
      Number(s.session.actor.fetchLevel()) < 3
    )
      return null;
    await s.setState("started");
    await s.set("cond", 1);
    await Q().giveItem(s.session, S, 1);
    s.playSound("ItemSound.quest_accept");
    return p("Nerupa", "Take the silk to Unoren.");
  },
  async onTalk(s, x) {
    const id = Number(x.fetchSelfId()),
      q = Q(),
      c = s.getInt("cond");
    if (s.isCompleted())
      return p("Quest", "You have already completed this quest.");
    if (!s.isStarted())
      return id === N &&
        Number(s.session.actor.fetchRace()) === 1 &&
        Number(s.session.actor.fetchLevel()) >= 3
        ? p(
            "Nerupa",
            "Will you help?",
            '<a action="bypass -h quest 160 start">Accept.</a>',
          )
        : p("Nerupa", "Elves of level 3 or higher only.");
    const step =
      id === U && c === 1
        ? [S, R, 2]
        : id === C && c === 2
          ? [R, T, 3]
          : id === J && c === 3
            ? [T, L, 4]
            : null;
    if (step) {
      if (!(await q.takeItem(s, step[0]))) return null;
      await q.giveItem(s.session, step[1], 1);
      await s.set("cond", step[2]);
      s.playSound("ItemSound.quest_middle");
      return p("Quest", "Continue the errand.");
    }
    if (id === N && c === 4) {
      await q.takeItem(s, L);
      await q.giveItem(s.session, P, 5);
      q.rewardExpSp(s.session, 1000, 0);
      s.playSound("ItemSound.quest_finish");
      await s.exit(false);
      return p("Nerupa", "Thank you.");
    }
    return p("Quest", "Continue your errand.");
  },
};
