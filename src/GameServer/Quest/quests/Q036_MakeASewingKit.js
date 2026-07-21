const FERRIS = 7847,
  GOLEM = 566,
  STEEL = 7163,
  FRAME = 1891,
  ORIHARUKON = 1893,
  KIT = 7078;
const {
  service,
  count,
  page,
  formalCondition,
  collect,
} = require("./FormalWear");
const A = "ItemSound.quest_accept",
  M = "ItemSound.quest_middle",
  F = "ItemSound.quest_finish";
module.exports = {
  id: 36,
  name: "Make a Sewing Kit",
  npcs: [FERRIS],
  startNpcs: [FERRIS],
  killNpcs: [GOLEM],
  eventNpc: (e) =>
    ({ start: FERRIS, steel: FERRIS, reward: FERRIS })[e] ?? null,
  async onEvent(s, e) {
    const Q = service();
    if (e === "start" && !s.isStarted()) {
      if (
        Number(s.session.actor.fetchLevel()) < 60 ||
        formalCondition(s.session) !== 6
      )
        return null;
      await s.setState("started");
      await s.set("cond", 1);
      s.playSound(A);
      return page("Ferris", "Bring 5 Reinforced Steel.");
    }
    if (e === "steel" && s.getInt("cond") === 2) {
      if (!(await Q.takeItem(s, STEEL, 5))) return null;
      await s.set("cond", 3);
      s.playSound(M);
      return page("Ferris", "Bring 10 Artisan’s Frames and 10 Oriharukon.");
    }
    if (e === "reward" && s.getInt("cond") === 3) {
      if (count(s, FRAME) < 10 || count(s, ORIHARUKON) < 10)
        return page(
          "Ferris",
          "You need 10 Artisan’s Frames and 10 Oriharukon.",
        );
      await Q.takeItem(s, FRAME, 10);
      await Q.takeItem(s, ORIHARUKON, 10);
      await Q.giveItem(s.session, KIT, 1);
      s.playSound(F);
      await s.exit(false);
      return page("Ferris", "Here is the Sewing Kit.");
    }
    return null;
  },
  async onTalk(s, n) {
    if (s.isCompleted())
      return page("Quest", "You have already completed this quest.");
    const c = s.getInt("cond");
    if (!s.isStarted())
      return Number(s.session.actor.fetchLevel()) >= 60 &&
        formalCondition(s.session) === 6
        ? page(
            "Ferris",
            "I can make a sewing kit.",
            '<a action="bypass -h quest 36 start">Accept.</a>',
          )
        : page("Ferris", "Come with Leikar’s formal-wear order.");
    if (c === 2)
      return page(
        "Ferris",
        "You have the steel.",
        '<a action="bypass -h quest 36 steel">Hand it over.</a>',
      );
    if (c === 3)
      return page(
        "Ferris",
        "Bring the remaining materials.",
        '<a action="bypass -h quest 36 reward">Receive the kit.</a>',
      );
    return page("Ferris", `Reinforced Steel: ${count(s, STEEL)}/5.`);
  },
  async onKill(s) {
    if (s.getInt("cond") !== 1) return;
    const done = await collect(s, STEEL, 5);
    if (done) {
      await s.set("cond", 2);
      s.playSound(M);
    }
  },
};
