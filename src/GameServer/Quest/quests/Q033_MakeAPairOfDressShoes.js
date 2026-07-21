const WOODLEY = 7838,
  IAN = 7164,
  LEIKAR = 8520,
  LEATHER = 1882,
  THREAD = 1868,
  ADENA = 57,
  SHOES = 7113;
const { service, count, page, formalCondition } = require("./FormalWear");
const A = "ItemSound.quest_accept",
  M = "ItemSound.quest_middle",
  F = "ItemSound.quest_finish";
module.exports = {
  id: 33,
  name: "Make a Pair of Dress Shoes",
  npcs: [WOODLEY, IAN, LEIKAR],
  startNpcs: [WOODLEY],
  eventNpc: (e) =>
    ({
      start: WOODLEY,
      leikar: LEIKAR,
      reply: WOODLEY,
      materials: WOODLEY,
      payment: IAN,
      reward: WOODLEY,
    })[e] ?? null,
  async onEvent(s, e) {
    const Q = service();
    if (e === "start" && !s.isStarted() && !s.isCompleted()) {
      if (
        Number(s.session.actor.fetchLevel()) < 60 ||
        formalCondition(s.session) !== 7
      )
        return null;
      await s.setState("started");
      await s.set("cond", 1);
      s.playSound(A);
      return page("Woodley", "Speak with Leikar.");
    }
    if (e === "leikar" && s.getInt("cond") === 1) {
      await s.set("cond", 2);
      s.playSound(M);
      return page("Leikar", "Return to Woodley.");
    }
    if (e === "reply" && s.getInt("cond") === 2) {
      await s.set("cond", 3);
      s.playSound(M);
      return page(
        "Woodley",
        "Bring 200 Leather, 600 Thread and 200,000 Adena.",
      );
    }
    if (e === "materials" && s.getInt("cond") === 3) {
      if (
        count(s, LEATHER) < 200 ||
        count(s, THREAD) < 600 ||
        count(s, ADENA) < 200000
      )
        return page("Woodley", "You do not have the required materials.");
      await Q.takeItem(s, ADENA, 200000);
      await Q.takeItem(s, LEATHER, 200);
      await Q.takeItem(s, THREAD, 600);
      await s.set("cond", 4);
      s.playSound(M);
      return page("Woodley", "Pay Ian 300,000 Adena.");
    }
    if (e === "payment" && s.getInt("cond") === 4) {
      if (count(s, ADENA) < 300000)
        return page("Ian", "You need 300,000 Adena.");
      await Q.takeItem(s, ADENA, 300000);
      await s.set("cond", 5);
      s.playSound(M);
      return page("Ian", "Return to Woodley.");
    }
    if (e === "reward" && s.getInt("cond") === 5) {
      await Q.giveItem(s.session, SHOES, 1);
      s.playSound(F);
      await s.exit(false);
      return page("Woodley", "Here are the dress shoes.");
    }
    return null;
  },
  async onTalk(s, n) {
    const id = Number(n.fetchSelfId());
    if (s.isCompleted())
      return page("Quest", "You have already completed this quest.");
    if (!s.isStarted())
      return id === WOODLEY
        ? Number(s.session.actor.fetchLevel()) >= 60 &&
          formalCondition(s.session) === 7
          ? page(
              "Woodley",
              "I can make dress shoes.",
              '<a action="bypass -h quest 33 start">Accept.</a>',
            )
          : page("Woodley", "You need Leikar’s formal-wear order.")
        : page("Quest", "You are not on a quest that involves this NPC.");
    const c = s.getInt("cond");
    if (id === LEIKAR)
      return c === 1
        ? page(
            "Leikar",
            "Speak with me.",
            '<a action="bypass -h quest 33 leikar">Speak.</a>',
          )
        : page("Leikar", "Return to Woodley.");
    if (id === IAN)
      return c === 4
        ? page(
            "Ian",
            "Pay 300,000 Adena.",
            '<a action="bypass -h quest 33 payment">Pay.</a>',
          )
        : page("Ian", "Woodley will send you when ready.");
    if (c === 2)
      return page(
        "Woodley",
        "What did Leikar say?",
        '<a action="bypass -h quest 33 reply">Reply.</a>',
      );
    if (c === 3)
      return page(
        "Woodley",
        "Bring the materials.",
        '<a action="bypass -h quest 33 materials">Hand them over.</a>',
      );
    return c === 5
      ? page(
          "Woodley",
          "Your shoes are ready.",
          '<a action="bypass -h quest 33 reward">Receive them.</a>',
        )
      : page("Woodley", "Speak with Ian.");
  },
};
