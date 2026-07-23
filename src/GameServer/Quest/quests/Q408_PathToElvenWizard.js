const ROSELLA = 7414;
const GREENIS = 7157;
const THALIA = 7371;
const NORTHWIND = 7423;

const PINCER_SPIDER = 466;
const DRYAD_ELDER = 19;
const SUKAR_WERERAT_LEADER = 47;

const ROSELLAS_LETTER = 1218;
const RED_DOWN = 1219;
const MAGICAL_POWERS_RUBY = 1220;
const PURE_AQUAMARINE = 1221;
const APPETIZING_APPLE = 1222;
const GOLD_LEAVES = 1223;
const IMMORTAL_LOVE = 1224;
const AMETHYST = 1225;
const NOBILITY_AMETHYST = 1226;
const FERTILITY_PERIDOT = 1229;
const ETERNITY_DIAMOND = 1230;
const CHARM_OF_GRAIN = 1272;
const SAP_OF_MOTHER_TREE = 1273;
const LUCKY_POTPOURI = 1274;

const ACCEPT = "ItemSound.quest_accept";
const ITEM = "ItemSound.quest_itemget";
const MIDDLE = "ItemSound.quest_middle";
const FINISH = "ItemSound.quest_finish";

function service() {
  return invoke("GameServer/Quest/QuestService");
}

function page(title, text, action = "") {
  return `<html><body>${title}:<br>${text}<br><br>${action}</body></html>`;
}

function count(state, selfId) {
  return state.session.actor.backpack.fetchItemFromSelfId(selfId)?.fetchAmount() || 0;
}

async function collect(state, selfId, needed, chance) {
  const current = count(state, selfId);
  if (current >= needed || Math.random() >= chance) return false;
  const amount = service().questDropAmount(1, needed, current);
  if (!amount) return false;
  await service().giveItem(state.session, selfId, amount);
  return current + amount >= needed;
}

async function takeAll(state, selfId) {
  return service().takeItem(state.session, selfId, -1);
}

function hasAllGems(state) {
  return [MAGICAL_POWERS_RUBY, PURE_AQUAMARINE, NOBILITY_AMETHYST].every((item) => count(state, item));
}

module.exports = {
  id: 408,
  name: "Path to Elven Wizard",
  npcs: [ROSELLA, GREENIS, THALIA, NORTHWIND],
  startNpcs: [ROSELLA],
  killNpcs: [PINCER_SPIDER, DRYAD_ELDER, SUKAR_WERERAT_LEADER],
  eventNpc: (event) => ({
    start: ROSELLA,
    ruby: ROSELLA,
    aquamarine: ROSELLA,
    amethyst: ROSELLA,
    grain: GREENIS,
    sap: THALIA,
  })[event] ?? null,

  async onEvent(state, event) {
    const quest = service();
    const actor = state.session.actor;
    if (event === "start" && !state.isStarted() && !state.isCompleted()) {
      if (Number(actor.fetchClassId()) !== 25 || Number(actor.fetchLevel()) < 19 || count(state, ETERNITY_DIAMOND)) return null;
      await state.setState("started");
      await state.set("cond", 1);
      if (!count(state, FERTILITY_PERIDOT)) await quest.giveItem(state.session, FERTILITY_PERIDOT, 1);
      state.playSound(ACCEPT);
      return page("Rosella", "Recover the Ruby, Aquamarine, and Nobility Amethyst.");
    }
    if (!state.isStarted() || !count(state, FERTILITY_PERIDOT)) return null;
    if (event === "ruby" && !count(state, MAGICAL_POWERS_RUBY) && !count(state, ROSELLAS_LETTER)) {
      await quest.giveItem(state.session, ROSELLAS_LETTER, 1);
      await state.set("cond", 2);
      return page("Rosella", "Take my letter to Greenis.");
    }
    if (event === "aquamarine" && !count(state, PURE_AQUAMARINE) && !count(state, APPETIZING_APPLE)) {
      await quest.giveItem(state.session, APPETIZING_APPLE, 1);
      return page("Rosella", "Take this apple to Thalia.");
    }
    if (event === "amethyst" && !count(state, NOBILITY_AMETHYST) && !count(state, IMMORTAL_LOVE)) {
      await quest.giveItem(state.session, IMMORTAL_LOVE, 1);
      return page("Rosella", "Take Immortal Love to Northwind.");
    }
    if (event === "grain" && count(state, ROSELLAS_LETTER)) {
      await takeAll(state, ROSELLAS_LETTER);
      if (!count(state, CHARM_OF_GRAIN)) await quest.giveItem(state.session, CHARM_OF_GRAIN, 1);
      return page("Greenis", "Collect five Red Down from Pincer Spiders.");
    }
    if (event === "sap" && count(state, APPETIZING_APPLE)) {
      await takeAll(state, APPETIZING_APPLE);
      if (!count(state, SAP_OF_MOTHER_TREE)) await quest.giveItem(state.session, SAP_OF_MOTHER_TREE, 1);
      return page("Thalia", "Collect five Gold Leaves from Dryad Elders.");
    }
    return null;
  },

  async onTalk(state, npc) {
    const npcId = Number(npc.fetchSelfId());
    const quest = service();

    if (state.isCompleted()) return page("Rosella", "You have already completed the Path to Elven Wizard.");
    if (!state.isStarted()) {
      const actor = state.session.actor;
      if (npcId !== ROSELLA || Number(actor.fetchClassId()) !== 25) return page("Quest", "This path is not for your current class.");
      if (count(state, ETERNITY_DIAMOND)) return page("Rosella", "You have already earned the Eternity Diamond.");
      return Number(actor.fetchLevel()) < 19
        ? page("Rosella", "Come back after reaching level 19.")
        : page("Rosella", "Do you seek the path of an Elven Wizard?", '<a action="bypass -h quest 408 start">Accept the trial.</a>');
    }

    if (npcId === ROSELLA) {
      if (hasAllGems(state) && count(state, FERTILITY_PERIDOT)) {
        const profession = await quest.awardFirstProfession(state, 26);
        if (!profession.ok) return page("Rosella", profession.reason === "level" ? `Reach level ${profession.requiredLevel} to become an Elven Wizard.` : "Your profession could not be granted. Keep your gems and try again.");
        for (const item of [MAGICAL_POWERS_RUBY, PURE_AQUAMARINE, NOBILITY_AMETHYST, FERTILITY_PERIDOT]) await takeAll(state, item);
        if (!count(state, ETERNITY_DIAMOND)) await quest.giveItem(state.session, ETERNITY_DIAMOND, 1);
        state.playSound(FINISH);
        await state.exit(false);
        return page("Rosella", "You have completed the Path to Elven Wizard and become an Elven Wizard.");
      }
      if (count(state, ROSELLAS_LETTER)) return page("Rosella", "Take my letter to Greenis.");
      if (count(state, CHARM_OF_GRAIN)) return page("Rosella", `Red Down: ${count(state, RED_DOWN)}/5. Return to Greenis when finished.`);
      if (count(state, APPETIZING_APPLE)) return page("Rosella", "Take the apple to Thalia.");
      if (count(state, SAP_OF_MOTHER_TREE)) return page("Rosella", `Gold Leaves: ${count(state, GOLD_LEAVES)}/5. Return to Thalia when finished.`);
      if (count(state, IMMORTAL_LOVE)) return page("Rosella", "Take Immortal Love to Northwind.");
      if (count(state, LUCKY_POTPOURI)) return page("Rosella", `Amethysts: ${count(state, AMETHYST)}/2. Return to Northwind when finished.`);
      const choices = [];
      if (!count(state, MAGICAL_POWERS_RUBY)) choices.push('<a action="bypass -h quest 408 ruby">Seek the Ruby.</a>');
      if (!count(state, PURE_AQUAMARINE)) choices.push('<a action="bypass -h quest 408 aquamarine">Seek the Aquamarine.</a>');
      if (!count(state, NOBILITY_AMETHYST)) choices.push('<a action="bypass -h quest 408 amethyst">Seek the Nobility Amethyst.</a>');
      return page("Rosella", "Choose an elemental trial.", choices.join("<br>"));
    }

    if (npcId === GREENIS) {
      if (count(state, ROSELLAS_LETTER)) return page("Greenis", "Rosella sent you?", '<a action="bypass -h quest 408 grain">Accept Greenis’s request.</a>');
      if (count(state, CHARM_OF_GRAIN) && count(state, RED_DOWN) < 5) return page("Greenis", `Red Down: ${count(state, RED_DOWN)}/5.`);
      if (count(state, CHARM_OF_GRAIN) && count(state, RED_DOWN) >= 5) {
        await takeAll(state, RED_DOWN);
        await takeAll(state, CHARM_OF_GRAIN);
        if (!count(state, MAGICAL_POWERS_RUBY)) await quest.giveItem(state.session, MAGICAL_POWERS_RUBY, 1);
        state.playSound(MIDDLE);
        return page("Greenis", "Receive the Magical Powers Ruby.");
      }
    }

    if (npcId === THALIA) {
      if (count(state, APPETIZING_APPLE)) return page("Thalia", "Bring me this apple?", '<a action="bypass -h quest 408 sap">Offer the apple.</a>');
      if (count(state, SAP_OF_MOTHER_TREE) && count(state, GOLD_LEAVES) < 5) return page("Thalia", `Gold Leaves: ${count(state, GOLD_LEAVES)}/5.`);
      if (count(state, SAP_OF_MOTHER_TREE) && count(state, GOLD_LEAVES) >= 5) {
        await takeAll(state, GOLD_LEAVES);
        await takeAll(state, SAP_OF_MOTHER_TREE);
        if (!count(state, PURE_AQUAMARINE)) await quest.giveItem(state.session, PURE_AQUAMARINE, 1);
        state.playSound(MIDDLE);
        return page("Thalia", "Receive the Pure Aquamarine.");
      }
    }

    if (npcId === NORTHWIND) {
      if (count(state, IMMORTAL_LOVE)) {
        await takeAll(state, IMMORTAL_LOVE);
        if (!count(state, LUCKY_POTPOURI)) await quest.giveItem(state.session, LUCKY_POTPOURI, 1);
        return page("Northwind", "Collect two Amethysts from Sukar Wererat Leaders.");
      }
      if (count(state, LUCKY_POTPOURI) && count(state, AMETHYST) < 2) return page("Northwind", `Amethysts: ${count(state, AMETHYST)}/2.`);
      if (count(state, LUCKY_POTPOURI) && count(state, AMETHYST) >= 2) {
        await takeAll(state, AMETHYST);
        await takeAll(state, LUCKY_POTPOURI);
        if (!count(state, NOBILITY_AMETHYST)) await quest.giveItem(state.session, NOBILITY_AMETHYST, 1);
        state.playSound(MIDDLE);
        return page("Northwind", "Receive the Nobility Amethyst.");
      }
    }

    return page("Quest", "Continue your trial.");
  },

  async onKill(state, npc) {
    if (!state.isStarted()) return;
    const npcId = Number(npc.fetchSelfId());
    if (npcId === PINCER_SPIDER && count(state, CHARM_OF_GRAIN)) {
      if (await collect(state, RED_DOWN, 5, 0.7)) state.playSound(MIDDLE);
      else if (count(state, RED_DOWN)) state.playSound(ITEM);
    } else if (npcId === DRYAD_ELDER && count(state, SAP_OF_MOTHER_TREE)) {
      if (await collect(state, GOLD_LEAVES, 5, 0.4)) state.playSound(MIDDLE);
      else if (count(state, GOLD_LEAVES)) state.playSound(ITEM);
    } else if (npcId === SUKAR_WERERAT_LEADER && count(state, LUCKY_POTPOURI)) {
      if (await collect(state, AMETHYST, 2, 0.4)) state.playSound(MIDDLE);
      else if (count(state, AMETHYST)) state.playSound(ITEM);
    }
  },
};
