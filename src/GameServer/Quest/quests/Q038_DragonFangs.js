const L = 7386,
  I = 7034,
  R = 7344,
  F = 7173,
  T = 7174,
  D = 7175,
  LI = 7176,
  LR = 7177,
  REW = [
    [45, 5200],
    [627, 1500],
    [1123, 3200],
    [605, 3200],
  ];
const Q = () => invoke("GameServer/Quest/QuestService"),
  p = (t, x, a = "") => `<html><body>${t}:<br>${x}<br><br>${a}</body></html>`,
  n = (s, id) =>
    s.session.actor.backpack.fetchItemFromSelfId(id)?.fetchAmount() || 0;
module.exports = {
  id: 38,
  name: "Dragon Fangs",
  npcs: [L, I, R],
  startNpcs: [L],
  killNpcs: [1100, 357, 1101, 356],
  eventNpc: (e) =>
    ({ start: L, feathers: L, iris: I, rohmer: R, returnIris: I, reward: I })[
      e
    ] ?? null,
  async onEvent(s, e) {
    const q = Q(),
      c = s.getInt("cond");
    if (e === "start" && !s.isStarted()) {
      if (s.session.actor.fetchLevel() < 19) return null;
      await s.setState("started");
      await s.set("cond", 1);
      return p("Luis", "Collect 100 Feather Ornaments.");
    }
    if (e === "feathers" && c === 2) {
      await q.takeItem(s, F, 100);
      await q.giveItem(s.session, T, 1);
      await s.set("cond", 3);
      return p("Luis", "Take the totem tooth to Iris.");
    }
    if (e === "iris" && c === 3) {
      await q.takeItem(s, T);
      await q.giveItem(s.session, LI, 1);
      await s.set("cond", 4);
      return p("Iris", "Take this to Rohmer.");
    }
    if (e === "rohmer" && c === 4) {
      await q.takeItem(s, LI);
      await q.giveItem(s.session, LR, 1);
      await s.set("cond", 5);
      return p("Rohmer", "Return to Iris.");
    }
    if (e === "returnIris" && c === 5) {
      await q.takeItem(s, LR);
      await s.set("cond", 6);
      return p("Iris", "Collect 50 dragon teeth.");
    }
    if (e === "reward" && c === 7) {
      await q.takeItem(s, D, 50);
      const r = REW[Math.floor(Math.random() * REW.length)];
      await q.giveItem(s.session, r[0], 1);
      await q.rewardAdena(s.session, r[1]);
      await s.exit(false);
      return p("Iris", "Your reward.");
    }
    return null;
  },
  async onTalk(s, x) {
    if (!s.isStarted())
      return p("Luis", '<a action="bypass -h quest 38 start">Accept.</a>');
    const c = s.getInt("cond"),
      id = x.fetchSelfId(),
      e =
        id === L && c === 2
          ? "feathers"
          : id === I && c === 3
            ? "iris"
            : id === R && c === 4
              ? "rohmer"
              : id === I && c === 5
                ? "returnIris"
                : id === I && c === 7
                  ? "reward"
                  : null;
    return e
      ? p("Quest", '<a action="bypass -h quest 38 ' + e + '">Continue.</a>')
      : p("Quest", "Continue.");
  },
  async onKill(s, m) {
    const c = s.getInt("cond"),
      id = m.fetchSelfId();
    if (c === 1 && [1100, 357].includes(id) && n(s, F) < 100) {
      await Q().giveItem(s.session, F, 1);
      if (n(s, F) >= 100) await s.set("cond", 2);
    }
    if (
      c === 6 &&
      [1101, 356].includes(id) &&
      Math.random() < 0.5 &&
      n(s, D) < 50
    ) {
      await Q().giveItem(s.session, D, 1);
      if (n(s, D) >= 50) await s.set("cond", 7);
    }
  },
};
