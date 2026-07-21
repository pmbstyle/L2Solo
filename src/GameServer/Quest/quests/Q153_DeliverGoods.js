const A = 7041,
  J = 7002,
  S = 7003,
  R = 7054,
  LIST = 1012,
  BOX = 1013,
  CLOTH = 1014,
  POT = 1015,
  JR = 1016,
  SR = 1017,
  RR = 1018,
  SS = 1835,
  RING = 875;
const Q = () => invoke("GameServer/Quest/QuestService");
const p = (t, x, a = "") =>
  `<html><body>${t}:<br>${x}<br><br>${a}</body></html>`;
const n = (s, id) =>
  s.session.actor.backpack.fetchItemFromSelfId(id)?.fetchAmount() || 0;
module.exports = {
  id: 153,
  name: "Deliver Goods",
  npcs: [A, J, S, R],
  startNpcs: [A],
  eventNpc: (e) => (e === "start" ? A : null),
  async onEvent(s, e) {
    if (
      e !== "start" ||
      s.isStarted() ||
      s.isCompleted() ||
      Number(s.session.actor.fetchLevel()) < 2
    )
      return null;
    await s.setState("started");
    await s.set("cond", 1);
    for (const z of [LIST, POT, CLOTH, BOX])
      await Q().giveItem(s.session, z, 1);
    s.playSound("ItemSound.quest_accept");
    return p("Arnold", "Deliver the three packages.");
  },
  async onTalk(s, x) {
    const id = Number(x.fetchSelfId());
    if (s.isCompleted())
      return p("Quest", "You have already completed this quest.");
    if (!s.isStarted())
      return id === A && Number(s.session.actor.fetchLevel()) >= 2
        ? p(
            "Arnold",
            "Will you deliver goods?",
            '<a action="bypass -h quest 153 start">Accept.</a>',
          )
        : p("Arnold", "Come back at level 2.");
    if (id === J && n(s, BOX)) {
      await Q().takeItem(s, BOX);
      await Q().giveItem(s.session, JR, 1);
    }
    if (id === S && n(s, CLOTH)) {
      await Q().takeItem(s, CLOTH);
      await Q().giveItem(s.session, SR, 1);
      await Q().giveItem(s.session, SS, 3);
    }
    if (id === R && n(s, POT)) {
      await Q().takeItem(s, POT);
      await Q().giveItem(s.session, RR, 1);
    }
    if ([JR, SR, RR].every((z) => n(s, z))) {
      await s.set("cond", 2);
      s.playSound("ItemSound.quest_middle");
    }
    if (id === A && s.getInt("cond") === 2) {
      for (const z of [LIST, JR, SR, RR]) await Q().takeItem(s, z);
      await Q().giveItem(s.session, RING, 2);
      Q().rewardExpSp(s.session, 600, 0);
      s.playSound("ItemSound.quest_finish");
      await s.exit(false);
      return p("Arnold", "Well delivered.");
    }
    return p("Quest", "Continue delivering the goods.");
  },
};
