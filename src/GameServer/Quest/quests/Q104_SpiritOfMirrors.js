const G = 7017,
  A = 7041,
  J = 7043,
  K = 7045,
  O = 748,
  W = [1135, 1136, 1137],
  R = 747,
  HP = 1060,
  SP = 2509,
  SS = 1835,
  BSP = 5790,
  BSS = 5789,
  E = [4412, 4413, 4414, 4415, 4416];
const Q = () => invoke("GameServer/Quest/QuestService"),
  p = (t, x, a = "") => `<html><body>${t}:<br>${x}<br><br>${a}</body></html>`,
  n = (s, id) =>
    s.session.actor.backpack.fetchItemFromSelfId(id)?.fetchAmount() || 0;
module.exports = {
  id: 104,
  name: "Spirit of Mirrors",
  npcs: [G, A, J, K],
  startNpcs: [G],
  killNpcs: [5003, 5004, 5005],
  eventNpc: (e) => (e === "start" ? G : null),
  async onEvent(s, e) {
    if (
      e !== "start" ||
      s.isStarted() ||
      Number(s.session.actor.fetchRace()) !== 0 ||
      Number(s.session.actor.fetchLevel()) < 10
    )
      return null;
    await s.setState("started");
    await s.set("cond", 1);
    for (let i = 0; i < 3; i++) await Q().giveItem(s.session, O, 1);
    s.playSound("ItemSound.quest_accept");
    return p("Gallint", "Bind the three Oak Wands.");
  },
  async onTalk(s, x) {
    const id = Number(x.fetchSelfId()),
      q = Q(),
      a = s.session.actor;
    if (s.isCompleted())
      return p("Quest", "You have already completed this quest.");
    if (!s.isStarted())
      return id === G &&
        Number(a.fetchRace()) === 0 &&
        Number(a.fetchLevel()) >= 10
        ? p(
            "Gallint",
            "Will you bind the spirits?",
            '<a action="bypass -h quest 104 start">Accept.</a>',
          )
        : p("Gallint", "Humans of level 10 or higher only.");
    if (id !== G && s.getInt("cond") === 1) {
      await s.set("cond", 2);
      s.playSound("ItemSound.quest_middle");
      return p("Quest", "Seek the spirits.");
    }
    if (id === G && W.every((z) => n(s, z))) {
      for (const z of W) await q.takeItem(s, z);
      const mage = Boolean(a.isSpellcaster?.());
      const rewards = [
        [R, 1],
        [HP, 100],
        [mage ? SP : SS, mage ? 500 : 1000],
        ...E.map((z) => [z, 10]),
      ];
      if (a.isNewbie?.()) rewards.push([mage ? BSP : BSS, mage ? 3000 : 7000]);
      for (const [z, c] of rewards) await q.giveItem(s.session, z, c);
      s.playSound("ItemSound.quest_finish");
      await s.exit(false);
      return p("Gallint", "The Wand of Adept is yours.");
    }
    return p("Gallint", "Equip an Oak Wand and defeat each spirit.");
  },
  async onKill(s, m) {
    if (
      !s.isStarted() ||
      !s.session.actor.backpack.fetchEquippedWeapon?.() ||
      Number(s.session.actor.backpack.fetchEquippedWeapon().fetchSelfId()) !== O
    )
      return;
    const i = Number(m.fetchSelfId()) - 5003;
    if (i < 0 || i > 2 || n(s, W[i])) return;
    await Q().takeItem(s, O);
    await Q().giveItem(s.session, W[i], 1);
    if (W.every((z) => n(s, z))) {
      await s.set("cond", 3);
      s.playSound("ItemSound.quest_middle");
    } else s.playSound("ItemSound.quest_itemget");
  },
};
