const GALLADUCCI = 7097,
  GENTLER = 7094,
  SANDRA = 7090,
  DUSTIN = 7116,
  MARK = 7570,
  SOE = 7554;
const ORDER1 = 7563,
  HILT = 7568,
  ORDER2 = 7564,
  POWDER = 7567,
  ORDER3 = 7565,
  NECKLACE = 7566;
const A = "ItemSound.quest_accept",
  M = "ItemSound.quest_middle",
  F = "ItemSound.quest_finish";
function Q() {
  return invoke("GameServer/Quest/QuestService");
}
function p(t, x, a = "") {
  return `<html><body>${t}:<br>${x}<br><br>${a}</body></html>`;
}
function has(s, id) {
  return (
    (s.session.actor.backpack.fetchItemFromSelfId(id)?.fetchAmount() || 0) > 0
  );
}
module.exports = {
  id: 45,
  name: "To Talking Island",
  npcs: [GALLADUCCI, GENTLER, SANDRA, DUSTIN],
  startNpcs: [GALLADUCCI],
  eventNpc: (e) =>
    ({
      start: GALLADUCCI,
      hilt: GENTLER,
      order2: GALLADUCCI,
      powder: SANDRA,
      order3: GALLADUCCI,
      necklace: DUSTIN,
      reward: GALLADUCCI,
    })[e] ?? null,
  async onEvent(s, e) {
    const q = Q(),
      a = s.session.actor;
    if (e === "start" && !s.isStarted()) {
      if (
        Number(a.fetchRace()) !== 0 ||
        Number(a.fetchLevel()) < 3 ||
        !has(s, MARK)
      )
        return null;
      await s.setState("started");
      await s.set("cond", 1);
      await q.giveItem(s.session, ORDER1, 1);
      s.playSound(A);
      return p("Galladucci", "Take the order to Gentler.");
    }
    const steps = {
      hilt: [1, 2, ORDER1, HILT],
      order2: [2, 3, HILT, ORDER2],
      powder: [3, 4, ORDER2, POWDER],
      order3: [4, 5, POWDER, ORDER3],
      necklace: [5, 6, ORDER3, NECKLACE],
    };
    if (steps[e] && s.getInt("cond") === steps[e][0]) {
      const x = steps[e];
      if (!(await q.takeItem(s, x[2]))) return null;
      await q.giveItem(s.session, x[3], 1);
      await s.set("cond", x[1]);
      s.playSound(M);
      return p("Quest", "Continue the delivery.");
    }
    if (e === "reward" && s.getInt("cond") === 6) {
      if (!has(s, NECKLACE)) return null;
      await q.takeItem(s, MARK);
      await q.takeItem(s, NECKLACE);
      await q.giveItem(s.session, SOE, 1);
      s.playSound(F);
      await s.exit(false);
      return p("Galladucci", "Your passage to Talking Island is prepared.");
    }
    return null;
  },
  async onTalk(s, n) {
    const id = Number(n.fetchSelfId()),
      c = s.getInt("cond");
    if (s.isCompleted())
      return p("Quest", "You have already completed this quest.");
    if (!s.isStarted())
      return id === GALLADUCCI &&
        Number(s.session.actor.fetchRace()) === 0 &&
        Number(s.session.actor.fetchLevel()) >= 3 &&
        has(s, MARK)
        ? p(
            "Galladucci",
            "Will you travel to Talking Island?",
            '<a action="bypass -h quest 45 start">Accept.</a>',
          )
        : p(
            "Galladucci",
            "This journey is for Humans with the Mark of Traveler.",
          );
    const event =
      id === GENTLER
        ? "hilt"
        : id === SANDRA
          ? "powder"
          : id === DUSTIN
            ? "necklace"
            : c === 2
              ? "order2"
              : c === 4
                ? "order3"
                : c === 6
                  ? "reward"
                  : null;
    return event
      ? p(
          "Quest",
          "Continue the delivery.",
          `<a action="bypass -h quest 45 ${event}">Continue.</a>`,
        )
      : p("Galladucci", "Continue your deliveries.");
  },
};
