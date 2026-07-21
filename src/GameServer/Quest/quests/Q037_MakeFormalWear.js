const ALEXIS = 7842,
  LEIKAR = 8520,
  JEREMY = 8521,
  MIST = 8627,
  CLOTH = 7076,
  BOX = 7077,
  KIT = 7078,
  SHOES = 7113,
  RING = 7164,
  WINE = 7160,
  COOKIES = 7159,
  WEAR = 6408;
const { service, count, page } = require("./FormalWear");
const A = "ItemSound.quest_accept",
  M = "ItemSound.quest_middle",
  F = "ItemSound.quest_finish";
module.exports = {
  id: 37,
  name: "Make Formal Wear",
  npcs: [ALEXIS, LEIKAR, JEREMY, MIST],
  startNpcs: [ALEXIS],
  eventNpc: (e) =>
    ({
      start: ALEXIS,
      ring: LEIKAR,
      wine: JEREMY,
      mist: MIST,
      cookies: JEREMY,
      components: LEIKAR,
      shoes: LEIKAR,
      reward: LEIKAR,
    })[e] ?? null,
  async onEvent(s, e) {
    const Q = service();
    if (e === "start" && !s.isStarted()) {
      if (Number(s.session.actor.fetchLevel()) < 60) return null;
      await s.setState("started");
      await s.set("cond", 1);
      s.playSound(A);
      return page("Alexis", "Speak with Leikar.");
    }
    if (e === "ring" && s.getInt("cond") === 1) {
      await Q.giveItem(s.session, RING, 1);
      await s.set("cond", 2);
      s.playSound(M);
      return page("Leikar", "Take the Signet Ring to Jeremy.");
    }
    if (e === "wine" && s.getInt("cond") === 2) {
      if (!(await Q.takeItem(s, RING))) return null;
      await Q.giveItem(s.session, WINE, 1);
      await s.set("cond", 3);
      s.playSound(M);
      return page("Jeremy", "Take the Ice Wine to Mist.");
    }
    if (e === "mist" && s.getInt("cond") === 3) {
      if (!(await Q.takeItem(s, WINE))) return null;
      await s.set("cond", 4);
      s.playSound(M);
      return page("Mist", "Return to Jeremy.");
    }
    if (e === "cookies" && s.getInt("cond") === 4) {
      await Q.giveItem(s.session, COOKIES, 1);
      await s.set("cond", 5);
      s.playSound(M);
      return page("Jeremy", "Take the cookies to Leikar.");
    }
    if (e === "components" && s.getInt("cond") === 5) {
      if (!(await Q.takeItem(s, COOKIES))) return null;
      await s.set("cond", 6);
      s.playSound(M);
      return page("Leikar", "Obtain cloth, a jewel box and a sewing kit.");
    }
    if (e === "shoes" && s.getInt("cond") === 6) {
      if (
        count(s, BOX) < 1 ||
        count(s, CLOTH) < 1 ||
        count(s, KIT) < 1
      )
        return page("Leikar", "Bring all three components.");
      await Q.takeItem(s, BOX);
      await Q.takeItem(s, CLOTH);
      await Q.takeItem(s, KIT);
      await s.set("cond", 7);
      s.playSound(M);
      return page("Leikar", "Now bring Dress Shoes.");
    }
    if (e === "reward" && s.getInt("cond") === 7) {
      if (!(await Q.takeItem(s, SHOES)))
        return page("Leikar", "Bring the Dress Shoes.");
      await Q.giveItem(s.session, WEAR, 1);
      s.playSound(F);
      await s.exit(false);
      return page("Leikar", "Your Formal Wear is ready.");
    }
    return null;
  },
  async onTalk(s, n) {
    const id = Number(n.fetchSelfId()),
      c = s.getInt("cond");
    if (s.isCompleted())
      return page("Quest", "You have already completed this quest.");
    if (!s.isStarted())
      return id === ALEXIS && Number(s.session.actor.fetchLevel()) >= 60
        ? page(
            "Alexis",
            "Would you like formal wear?",
            '<a action="bypass -h quest 37 start">Accept.</a>',
          )
        : page("Alexis", "Come back at level 60.");
    if (id === ALEXIS) return page("Alexis", "Speak with Leikar.");
    if (id === JEREMY) {
      if (c === 2)
        return page(
          "Jeremy",
          "Give me the Signet Ring.",
          '<a action="bypass -h quest 37 wine">Exchange it.</a>',
        );
      if (c === 4)
        return page(
          "Jeremy",
          "I have cookies for Leikar.",
          '<a action="bypass -h quest 37 cookies">Receive the cookies.</a>',
        );
      return page("Jeremy", "Continue your errand.");
    }
    if (id === MIST)
      return c === 3
        ? page(
            "Mist",
            "Give me the Ice Wine.",
            '<a action="bypass -h quest 37 mist">Hand it over.</a>',
          )
        : page("Mist", "Speak with Jeremy.");
    if (c === 1)
      return page(
        "Leikar",
        "Take this ring to Jeremy.",
        '<a action="bypass -h quest 37 ring">Receive the ring.</a>',
      );
    if (c === 5)
      return page(
        "Leikar",
        "Give me the cookies.",
        '<a action="bypass -h quest 37 components">Hand them over.</a>',
      );
    if (c === 6)
      return page(
        "Leikar",
        "Bring the three components.",
        '<a action="bypass -h quest 37 shoes">Hand them over.</a>',
      );
    if (c === 7)
      return page(
        "Leikar",
        "Bring the Dress Shoes.",
        '<a action="bypass -h quest 37 reward">Receive Formal Wear.</a>',
      );
    return page("Leikar", "Continue your errands.");
  },
};
