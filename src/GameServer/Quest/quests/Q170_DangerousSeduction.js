const N = 7305,
  I = 1046;
const Q = () => invoke("GameServer/Quest/QuestService"),
  p = (t, x, a = "") => `<html><body>${t}:<br>${x}<br><br>${a}</body></html>`,
  n = (s, id) =>
    s.session.actor.backpack.fetchItemFromSelfId(id)?.fetchAmount() || 0;
module.exports = {
  id: 170,
  questItems: [1046],
  name: "Dangerous Seduction",
  npcs: [N],
  startNpcs: [N],
  killNpcs: [5022],
  eventNpc: (e) => (e === "start" ? N : null),
  async onEvent(s, e) {
    const a = s.session.actor;
    if (
      e !== "start" ||
      s.isStarted() ||
      s.isCompleted() ||
      a.fetchRace() !== 2 ||
      a.fetchLevel() < 21
    )
      return null;
    await s.setState("started");
    await s.set("cond", 1);
    s.playSound("ItemSound.quest_accept");
    return p("Vellior", "Defeat Merkenis.");
  },
  async onTalk(s) {
    if (s.isCompleted())
      return p("Vellior", "Dangerous Seduction: You have already completed this quest.");
    if (!s.isStarted()) {
      const a = s.session.actor;
      if (a.fetchRace() !== 2)
        return p("Vellior", "Dangerous Seduction: This task is for Dark Elves only.");
      if (a.fetchLevel() < 21)
        return p("Vellior", "Dangerous Seduction: Come back after reaching level 21.");
      return p(
        "Vellior",
        "Dangerous Seduction: Defeat Merkenis and bring me the nightmare crystal.",
        '<a action="bypass -h quest 170 start">Accept the task.</a>',
      );
    }
    if (!n(s, I)) return p("Vellior", "Bring the nightmare crystal.");
    await Q().takeItem(s.session, I, -1);
    await Q().rewardAdena(s.session, 102680);
    s.playSound("ItemSound.quest_finish");
    await s.exit(false);
    return p("Vellior", "You have resisted temptation.");
  },
  async onKill(s) {
    if (s.getInt("cond") === 1) {
      await Q().giveItem(s.session, I, 1);
      await s.set("cond", 2);
      s.playSound("ItemSound.quest_middle");
    }
  },
};
