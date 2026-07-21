const RADIA = 7088,
  RALFORD = 7165,
  VARAN = 7294,
  SPIDER = 560,
  TARANTULA = 561,
  SPINNERET = 7528,
  SUEDE = 1866,
  THREAD = 1868,
  SILK = 7161,
  CLOTH = 7076;
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
  id: 34,
  name: "In Search of Cloth",
  npcs: [RADIA, RALFORD, VARAN],
  startNpcs: [RADIA],
  killNpcs: [SPIDER, TARANTULA],
  eventNpc: (e) =>
    ({
      start: RADIA,
      varan: VARAN,
      radia: RADIA,
      ralford: RALFORD,
      silk: RALFORD,
      reward: RADIA,
    })[e] ?? null,
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
      return page("Radia", "Speak with Varan.");
    }
    const steps = { varan: [1, 2], radia: [2, 3], ralford: [3, 4] };
    if (steps[e] && s.getInt("cond") === steps[e][0]) {
      await s.set("cond", steps[e][1]);
      s.playSound(M);
      return page("Quest", "Continue the errand.");
    }
    if (e === "silk" && s.getInt("cond") === 5) {
      if (!(await Q.takeItem(s, SPINNERET, 10))) return null;
      await Q.giveItem(s.session, SILK, 1);
      await s.set("cond", 6);
      s.playSound(M);
      return page("Ralford", "Bring the silk to Radia.");
    }
    if (e === "reward" && s.getInt("cond") === 6) {
      if (
        count(s, SUEDE) < 3000 ||
        count(s, THREAD) < 5000 ||
        count(s, SILK) < 1
      )
        return page(
          "Radia",
          "You need 3,000 Suede, 5,000 Thread and the Spider Silk.",
        );
      await Q.takeItem(s, SILK);
      await Q.takeItem(s, SUEDE, 3000);
      await Q.takeItem(s, THREAD, 5000);
      await Q.giveItem(s.session, CLOTH, 1);
      s.playSound(F);
      await s.exit(false);
      return page("Radia", "Here is the Mysterious Cloth.");
    }
    return null;
  },
  async onTalk(s, n) {
    const id = Number(n.fetchSelfId()),
      c = s.getInt("cond");
    if (s.isCompleted())
      return page("Quest", "You have already completed this quest.");
    if (!s.isStarted())
      return id === RADIA &&
        Number(s.session.actor.fetchLevel()) >= 60 &&
        formalCondition(s.session) === 6
        ? page(
            "Radia",
            "I need special cloth.",
            '<a action="bypass -h quest 34 start">Accept.</a>',
          )
        : page("Radia", "Come with Leikar’s formal-wear order.");
    if (id === VARAN)
      return c === 1
        ? page(
            "Varan",
            "Speak.",
            '<a action="bypass -h quest 34 varan">Speak.</a>',
          )
        : page("Varan", "Return to Radia.");
    if (id === RALFORD) {
      if (c === 3)
        return page(
          "Ralford",
          "I need spinnerets.",
          '<a action="bypass -h quest 34 ralford">Accept.</a>',
        );
      return c === 5
        ? page(
            "Ralford",
            "You have the spinnerets.",
            '<a action="bypass -h quest 34 silk">Make silk.</a>',
          )
        : page("Ralford", `Spinnerets: ${count(s, SPINNERET)}/10.`);
    }
    if (c === 2)
      return page(
        "Radia",
        "What did Varan say?",
        '<a action="bypass -h quest 34 radia">Report.</a>',
      );
    return c === 6
      ? page(
          "Radia",
          "Bring the supplies.",
          '<a action="bypass -h quest 34 reward">Receive cloth.</a>',
        )
      : page("Radia", "Speak with Ralford.");
  },
  async onKill(s) {
    if (s.getInt("cond") !== 4) return;
    const done = await collect(s, SPINNERET, 10);
    if (done) {
      await s.set("cond", 5);
      s.playSound(M);
    }
  },
};
