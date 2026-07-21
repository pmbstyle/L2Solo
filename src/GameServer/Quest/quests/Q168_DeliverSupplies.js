const J = 7349,
  R = 7355,
  K = 7357,
  H = 7360,
  L = 1153,
  B1 = 1154,
  B2 = 1155,
  B3 = 1156,
  S = 1157;
const Q = () => invoke("GameServer/Quest/QuestService"),
  p = (t, x, a = "") => `<html><body>${t}:<br>${x}<br><br>${a}</body></html>`,
  n = (s, id) =>
    s.session.actor.backpack.fetchItemFromSelfId(id)?.fetchAmount() || 0;
module.exports = {
  id: 168,
  name: "Deliver Supplies",
  npcs: [J, R, K, H],
  startNpcs: [J],
  eventNpc: (e) =>
    ({ start: J, harant: H, jenna: J, roselyn: R, kristin: K, reward: J })[e] ??
    null,
  async onEvent(s, e) {
    const q = Q(),
      a = s.session.actor;
    if (e === "start" && !s.isStarted()) {
      if (Number(a.fetchRace()) !== 2 || Number(a.fetchLevel()) < 3)
        return null;
      await s.setState("started");
      await s.set("cond", 1);
      await q.giveItem(s.session, L, 1);
      s.playSound("ItemSound.quest_accept");
      return p("Jenna", "Deliver this letter to Harant.");
    }
    if (e === "harant" && s.getInt("cond") === 1) {
      await q.takeItem(s, L);
      for (const z of [B1, B2, B3]) await q.giveItem(s.session, z, 1);
      await s.set("cond", 2);
      s.playSound("ItemSound.quest_middle");
      return p("Harant", "Return the first blade to Jenna.");
    }
    if (e === "jenna" && s.getInt("cond") === 2) {
      await q.takeItem(s, B1);
      await s.set("cond", 3);
      s.playSound("ItemSound.quest_middle");
      return p("Jenna", "Deliver the other blades.");
    }
    const blade = e === "roselyn" ? B2 : e === "kristin" ? B3 : 0;
    if (blade && s.getInt("cond") === 3 && n(s, blade)) {
      await q.takeItem(s, blade);
      await q.giveItem(s.session, S, 1);
      if (n(s, S) === 2) {
        await s.set("cond", 4);
        s.playSound("ItemSound.quest_middle");
      } else s.playSound("ItemSound.quest_itemget");
      return p("Quest", "You receive an Old Bronze Sword.");
    }
    if (e === "reward" && s.getInt("cond") === 4) {
      await q.takeItem(s, S, 2);
      await q.rewardAdena(s.session, 820);
      s.playSound("ItemSound.quest_finish");
      await s.exit(false);
      return p("Jenna", "Thank you for delivering the supplies.");
    }
    return null;
  },
  async onTalk(s, x) {
    const id = Number(x.fetchSelfId()),
      c = s.getInt("cond");
    if (s.isCompleted())
      return p("Quest", "You have already completed this quest.");
    if (!s.isStarted())
      return id === J &&
        Number(s.session.actor.fetchRace()) === 2 &&
        Number(s.session.actor.fetchLevel()) >= 3
        ? p(
            "Jenna",
            "Will you deliver supplies?",
            '<a action="bypass -h quest 168 start">Accept.</a>',
          )
        : p("Jenna", "Dark Elves of level 3 or higher only.");
    const e =
      id === H
        ? "harant"
        : id === R
          ? "roselyn"
          : id === K
            ? "kristin"
            : c === 2
              ? "jenna"
              : c === 4
                ? "reward"
                : null;
    return e
      ? p(
          "Quest",
          "Continue the delivery.",
          `<a action="bypass -h quest 168 ${e}">Continue.</a>`,
        )
      : p("Jenna", "Continue delivering the supplies.");
  },
};
