const ELLIE = 7091,
  FELTON = 7879,
  ALLIGATOR = 135,
  ROUGH = 7162,
  ORIHARUKON = 1893,
  NUGGET = 1873,
  THONS = 4044,
  BOX = 7077;
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
  id: 35,
  name: "Find Glittering Jewelry",
  npcs: [ELLIE, FELTON],
  startNpcs: [ELLIE],
  killNpcs: [ALLIGATOR],
  eventNpc: (e) =>
    ({ start: ELLIE, felton: FELTON, ellie: ELLIE, reward: ELLIE })[e] ?? null,
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
      return page("Ellie", "Speak with Felton.");
    }
    if (e === "felton" && s.getInt("cond") === 1) {
      await s.set("cond", 2);
      s.playSound(M);
      return page("Felton", "Hunt Alligators for Rough Jewels.");
    }
    if (e === "ellie" && s.getInt("cond") === 3) {
      if (!(await Q.takeItem(s, ROUGH, 10))) return null;
      await s.set("cond", 4);
      s.playSound(M);
      return page(
        "Ellie",
        "Bring 5 Oriharukon, 500 Silver Nuggets and 150 Thons.",
      );
    }
    if (e === "reward" && s.getInt("cond") === 4) {
      if (
        count(s, ORIHARUKON) < 5 ||
        count(s, NUGGET) < 500 ||
        count(s, THONS) < 150
      )
        return page("Ellie", "You lack the required materials.");
      await Q.takeItem(s, ORIHARUKON, 5);
      await Q.takeItem(s, NUGGET, 500);
      await Q.takeItem(s, THONS, 150);
      await Q.giveItem(s.session, BOX, 1);
      s.playSound(F);
      await s.exit(false);
      return page("Ellie", "Here is the Jewel Box.");
    }
    return null;
  },
  async onTalk(s, n) {
    const id = Number(n.fetchSelfId()),
      c = s.getInt("cond");
    if (s.isCompleted())
      return page("Quest", "You have already completed this quest.");
    if (!s.isStarted())
      return id === ELLIE &&
        Number(s.session.actor.fetchLevel()) >= 60 &&
        formalCondition(s.session) === 6
        ? page(
            "Ellie",
            "I need glittering jewelry.",
            '<a action="bypass -h quest 35 start">Accept.</a>',
          )
        : page("Ellie", "Come with Leikar’s formal-wear order.");
    if (id === FELTON)
      return c === 1
        ? page(
            "Felton",
            "I need Rough Jewels.",
            '<a action="bypass -h quest 35 felton">Accept.</a>',
          )
        : page("Felton", `Rough Jewels: ${count(s, ROUGH)}/10.`);
    return c === 3
      ? page(
          "Ellie",
          "You have the jewels.",
          '<a action="bypass -h quest 35 ellie">Hand them over.</a>',
        )
      : c === 4
        ? page(
            "Ellie",
            "Bring the materials.",
            '<a action="bypass -h quest 35 reward">Receive the box.</a>',
          )
        : page("Ellie", "Speak with Felton.");
  },
  async onKill(s) {
    if (s.getInt("cond") !== 2) return;
    const done = await collect(s, ROUGH, 10);
    if (done) {
      await s.set("cond", 3);
      s.playSound(M);
    }
  },
};
