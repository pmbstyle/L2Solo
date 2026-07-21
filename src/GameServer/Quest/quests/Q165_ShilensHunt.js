const N = 7348,
  B = 1160,
  P = 1060,
  C = { 456: 1, 529: 1 / 3, 532: 1 / 3, 536: 2 / 3 };
const Q = () => invoke("GameServer/Quest/QuestService"),
  p = (t, x, a = "") => `<html><body>${t}:<br>${x}<br><br>${a}</body></html>`;
const n = (s, id) =>
  s.session.actor.backpack.fetchItemFromSelfId(id)?.fetchAmount() || 0;
module.exports = {
  id: 165,
  name: "Shilen's Hunt",
  npcs: [N],
  startNpcs: [N],
  killNpcs: [456, 529, 532, 536],
  eventNpc: (e) => (e === "start" ? N : null),
  async onEvent(s, e) {
    if (
      e !== "start" ||
      s.isStarted() ||
      Number(s.session.actor.fetchRace()) !== 2 ||
      Number(s.session.actor.fetchLevel()) < 3
    )
      return null;
    await s.setState("started");
    await s.set("cond", 1);
    s.playSound("ItemSound.quest_accept");
    return p("Nelsya", "Bring 13 Dark Bezoars.");
  },
  async onTalk(s, x) {
    if (s.isCompleted())
      return p("Quest", "You have already completed this quest.");
    if (!s.isStarted())
      return Number(s.session.actor.fetchRace()) === 2 &&
        Number(s.session.actor.fetchLevel()) >= 3
        ? p(
            "Nelsya",
            "Will you hunt for Shilen?",
            '<a action="bypass -h quest 165 start">Accept.</a>',
          )
        : p("Nelsya", "Dark Elves of level 3 or higher only.");
    if (n(s, B) >= 13) {
      await Q().takeItem(s, B, 13);
      await Q().giveItem(s.session, P, 5);
      Q().rewardExpSp(s.session, 1000, 0);
      s.playSound("ItemSound.quest_finish");
      await s.exit(false);
      return p("Nelsya", "Your hunt is complete.");
    }
    return p("Nelsya", `Dark Bezoars: ${n(s, B)}/13.`);
  },
  async onKill(s, m) {
    if (s.getInt("cond") !== 1 || Math.random() >= C[Number(m.fetchSelfId())])
      return;
    const c = n(s, B),
      a = Q().questDropAmount(1, 13, c);
    if (a) {
      await Q().giveItem(s.session, B, a);
      if (c + a >= 13) {
        await s.set("cond", 2);
        s.playSound("ItemSound.quest_middle");
      } else s.playSound("ItemSound.quest_itemget");
    }
  },
};
