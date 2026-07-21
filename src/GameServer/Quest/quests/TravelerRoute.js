const G = 7097,
  T = 7094,
  S = 7090,
  D = 7116,
  MARK = 7570,
  O1 = 7563,
  H = 7568,
  O2 = 7564,
  P = 7567,
  O3 = 7565,
  N = 7566;
const A = "ItemSound.quest_accept",
  M = "ItemSound.quest_middle",
  F = "ItemSound.quest_finish";
function q() {
  return invoke("GameServer/Quest/QuestService");
}
function page(t, x, a = "") {
  return `<html><body>${t}:<br>${x}<br><br>${a}</body></html>`;
}
function has(s, id) {
  return (
    (s.session.actor.backpack.fetchItemFromSelfId(id)?.fetchAmount() || 0) > 0
  );
}
module.exports = (c) => ({
  id: c.id,
  name: c.name,
  npcs: [G, T, S, D],
  startNpcs: [G],
  eventNpc: (e) =>
    ({
      start: G,
      hilt: T,
      order2: G,
      powder: S,
      order3: G,
      necklace: D,
      reward: G,
    })[e] ?? null,
  async onEvent(s, e) {
    const Q = q(),
      a = s.session.actor;
    if (e === "start" && !s.isStarted() && !s.isCompleted()) {
      if (
        Number(a.fetchRace()) !== c.race ||
        Number(a.fetchLevel()) < 3 ||
        !has(s, MARK)
      )
        return null;
      await s.setState("started");
      await s.set("cond", 1);
      await Q.giveItem(s.session, O1, 1);
      s.playSound(A);
      return page("Galladucci", "Take the order to Gentler.");
    }
    const x = {
      hilt: [1, 2, O1, H],
      order2: [2, 3, H, O2],
      powder: [3, 4, O2, P],
      order3: [4, 5, P, O3],
      necklace: [5, 6, O3, N],
    }[e];
    if (x && s.getInt("cond") === x[0]) {
      if (!(await Q.takeItem(s, x[2]))) return null;
      await Q.giveItem(s.session, x[3], 1);
      await s.set("cond", x[1]);
      s.playSound(M);
      return page("Quest", "Continue the delivery.");
    }
    if (e === "reward" && s.getInt("cond") === 6) {
      if (!has(s, N)) return null;
      await Q.takeItem(s, MARK);
      await Q.takeItem(s, N);
      await Q.giveItem(s.session, c.reward, 1);
      s.playSound(F);
      await s.exit(false);
      return page("Galladucci", "Your journey is prepared.");
    }
    return null;
  },
  async onTalk(s, n) {
    const id = Number(n.fetchSelfId()),
      cnd = s.getInt("cond"),
      a = s.session.actor;
    if (s.isCompleted())
      return page("Quest", "You have already completed this quest.");
    if (!s.isStarted())
      return id === G &&
        Number(a.fetchRace()) === c.race &&
        Number(a.fetchLevel()) >= 3 &&
        has(s, MARK)
        ? page(
            "Galladucci",
            "Will you travel?",
            '<a action="bypass -h quest ' + c.id + ' start">Accept.</a>',
          )
        : page("Galladucci", "This journey requires the Mark of Traveler.");
    const e =
      id === T
        ? "hilt"
        : id === S
          ? "powder"
          : id === D
            ? "necklace"
            : cnd === 2
              ? "order2"
              : cnd === 4
                ? "order3"
                : cnd === 6
                  ? "reward"
                  : null;
    return e
      ? page(
          "Quest",
          "Continue the delivery.",
          `<a action="bypass -h quest ${c.id} ${e}">Continue.</a>`,
        )
      : page("Galladucci", "Continue your deliveries.");
  },
});
