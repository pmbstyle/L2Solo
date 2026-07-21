const G = 7523,
  R = 7516,
  M = 7521,
  A = 7522,
  B = 7526,
  MA = 7529,
  T = 7555,
  I = [
    1559, 1560, 1561, 1562, 1563, 1564, 1565, 1566, 1567, 1568, 1569, 1570,
    1571,
  ],
  E = [4412, 4413, 4414, 4415, 4416];
const Q = () => invoke("GameServer/Quest/QuestService");
const p = (t, x, a = "") =>
  `<html><body>${t}:<br>${x}<br><br>${a}</body></html>`;
const n = (s, id) =>
  s.session.actor.backpack.fetchItemFromSelfId(id)?.fetchAmount() || 0;
module.exports = {
  id: 108,
  name: "Jumble Tumble Diamond Fuss",
  npcs: [G, R, M, A, B, MA, T],
  startNpcs: [G],
  killNpcs: [323, 324, 480],
  eventNpc: (e) => (e === "start" ? G : null),
  async onEvent(s, e) {
    const a = s.session.actor;
    if (
      e !== "start" ||
      s.isStarted() ||
      Number(a.fetchRace()) !== 4 ||
      Number(a.fetchLevel()) < 10
    )
      return null;
    await s.setState("started");
    await s.set("cond", 1);
    await Q().giveItem(s.session, I[0], 1);
    s.playSound("ItemSound.quest_accept");
    return p("Gouph", "Take the contract to Reep.");
  },
  async onTalk(s, x) {
    const id = Number(x.fetchSelfId()),
      a = s.session.actor,
      q = Q(),
      c = s.getInt("cond");
    if (s.isCompleted())
      return p("Quest", "You have already completed this quest.");
    if (!s.isStarted())
      return id === G &&
        Number(a.fetchRace()) === 4 &&
        Number(a.fetchLevel()) >= 10
        ? p(
            "Gouph",
            "Will you recover the diamond?",
            '<a action="bypass -h quest 108 start">Accept.</a>',
          )
        : p("Gouph", "Only level 10 dwarves may help.");
    const move = async (take, give, next, msg) => {
      for (const z of take) await q.takeItem(s, z, -1);
      for (const z of give) await q.giveItem(s.session, z, 1);
      await s.set("cond", next);
      s.playSound("ItemSound.quest_middle");
      return p("Quest", msg);
    };
    if (id === R && c === 1)
      return move([I[0]], [I[1]], 2, "Take the contract to Torocco.");
    if (id === T && c === 2)
      return move([I[1]], [I[2]], 3, "Take the wine to Maron.");
    if (id === MA && c === 3)
      return move([I[2]], [I[3]], 4, "Take the dice to Brunon.");
    if (id === B && c === 4)
      return move([I[3]], [I[4]], 5, "Recover Aquamarine and Chrysoberyl.");
    if (id === B && c === 6)
      return move(
        [I[4], I[5], I[6]],
        [I[7]],
        7,
        "Return the gem box to Gouph.",
      );
    if (id === G && c === 7)
      return move([I[7]], [I[8]], 8, "Take coal to Brunon.");
    if (id === B && c === 8)
      return move([I[8]], [I[9]], 9, "Take Brunon's letter to Murdoc.");
    if (id === M && c === 9)
      return move([I[9]], [I[10]], 10, "Take the tart to Airy.");
    if (id === A && c === 10)
      return move([I[10]], [I[11]], 11, "Hunt Blade Bats for the diamond.");
    if (id === G && c === 12) {
      await q.takeItem(s, I[12], -1);
      for (const [z, c] of [[1511, 1], [1060, 100], ...E.map((z) => [z, 10])])
        await q.giveItem(s.session, z, c);
      if (a.isNewbie?.())
        await q.giveItem(
          s.session,
          a.isSpellcaster?.() ? 5790 : 5789,
          a.isSpellcaster?.() ? 3000 : 6000,
        );
      s.playSound("ItemSound.quest_finish");
      await s.exit(false);
      return p("Gouph", "The diamond is safe.");
    }
    return p("Quest", "Continue your task.");
  },
  async onKill(s, m) {
    const c = s.getInt("cond"),
      id = Number(m.fetchSelfId());
    if (c === 5 && [323, 324].includes(id)) {
      const chance = id === 323 ? 0.8 : 0.6;
      if (Math.random() >= chance) return;
      for (const z of [I[5], I[6]])
        if (!n(s, z)) await Q().giveItem(s.session, z, 1);
      if (n(s, I[5]) && n(s, I[6])) {
        await s.set("cond", 6);
        s.playSound("ItemSound.quest_middle");
      } else s.playSound("ItemSound.quest_itemget");
    }
    if (c === 11 && id === 480 && Math.random() < 0.2) {
      await Q().takeItem(s, I[11]);
      await Q().giveItem(s.session, I[12], 1);
      await s.set("cond", 12);
      s.playSound("ItemSound.quest_middle");
    }
  },
};
