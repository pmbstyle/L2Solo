const GALLINT = 7391;
const EARTH_SNAKE = 7409;
const WASTELAND_LIZARDMAN = 7410;
const FLAME_SALAMANDER = 7411;
const WIND_SYLPH = 7412;
const WATER_UNDINE = 7413;

const RED_BEAR = 21;
const RATMAN_WARRIOR = 359;
const WATER_SEER = 5030;

const MAP_OF_LUSTER = 1280;
const KEY_OF_FLAME = 1281;
const FLAME_EARRING = 1282;
const BROKEN_BRONZE_MIRROR = 1283;
const WIND_FEATHER = 1284;
const WIND_BANGLE = 1285;
const RAMAS_DIARY = 1286;
const SPARKLE_PEBBLE = 1287;
const WATER_NECKLACE = 1288;
const RUST_GOLD_COIN = 1289;
const RED_SOIL = 1290;
const EARTH_RING = 1291;
const BEAD_OF_SEASON = 1292;

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

async function exchange(state, remove, give, condition) {
  const quest = service();
  for (const item of remove) {
    if (!(await quest.takeItem(state.session, item))) return false;
  }
  await quest.giveItem(state.session, give, 1);
  await state.set("cond", condition);
  state.playSound(MIDDLE);
  return true;
}

module.exports = {
  id: 404,
  name: "Path to Wizard",
  npcs: [GALLINT, EARTH_SNAKE, WASTELAND_LIZARDMAN, FLAME_SALAMANDER, WIND_SYLPH, WATER_UNDINE],
  startNpcs: [GALLINT],
  killNpcs: [RED_BEAR, RATMAN_WARRIOR, WATER_SEER],
  eventNpc: (event) => ({ start: GALLINT, feather: WASTELAND_LIZARDMAN })[event] ?? null,

  async onEvent(state, event) {
    const quest = service();
    const actor = state.session.actor;
    if (event === "start" && !state.isStarted() && !state.isCompleted()) {
      if (Number(actor.fetchClassId()) !== 10 || Number(actor.fetchLevel()) < 19) return null;
      await state.setState("started");
      await state.set("cond", 1);
      state.playSound(ACCEPT);
      return page("Gallint", "Seek the four elemental signs to prove your mastery.");
    }
    if (event === "feather" && state.getInt("cond") === 5 && count(state, BROKEN_BRONZE_MIRROR) && !count(state, WIND_FEATHER)) {
      await quest.giveItem(state.session, WIND_FEATHER, 1);
      await state.set("cond", 6);
      state.playSound(MIDDLE);
      return page("Wasteland Lizardman", "The Wind Feather has revealed itself in the broken mirror.");
    }
    return null;
  },

  async onTalk(state, npc) {
    const npcId = Number(npc.fetchSelfId());
    const quest = service();
    const cond = state.getInt("cond");

    if (state.isCompleted()) return page("Gallint", "You have already completed the Path to Wizard.");
    if (!state.isStarted()) {
      const actor = state.session.actor;
      if (npcId !== GALLINT || Number(actor.fetchClassId()) !== 10) return page("Quest", "This path is not for your current class.");
      return Number(actor.fetchLevel()) < 19
        ? page("Gallint", "Come back after reaching level 19.")
        : page("Gallint", "Do you seek the path of a Wizard?", '<a action="bypass -h quest 404 start">Accept the trial.</a>');
    }

    if (npcId === FLAME_SALAMANDER) {
      if (cond === 1 && !count(state, MAP_OF_LUSTER) && !count(state, FLAME_EARRING)) {
        await quest.giveItem(state.session, MAP_OF_LUSTER, 1);
        await state.set("cond", 2);
        state.playSound(MIDDLE);
        return page("Flame Salamander", "Find the Key of Flame from Ratman Warriors.");
      }
      if (cond === 3 && count(state, MAP_OF_LUSTER) && count(state, KEY_OF_FLAME)) {
        await exchange(state, [MAP_OF_LUSTER, KEY_OF_FLAME], FLAME_EARRING, 4);
        return page("Flame Salamander", "Receive the Flame Earring.");
      }
      return page("Flame Salamander", "Bring me the Map of Luster and the Key of Flame.");
    }

    if (npcId === WIND_SYLPH) {
      if (cond === 4 && count(state, FLAME_EARRING) && !count(state, BROKEN_BRONZE_MIRROR) && !count(state, WIND_BANGLE)) {
        await quest.giveItem(state.session, BROKEN_BRONZE_MIRROR, 1);
        await state.set("cond", 5);
        state.playSound(MIDDLE);
        return page("Wind Sylph", "Show the broken bronze mirror to a Wasteland Lizardman.");
      }
      if (cond === 6 && count(state, BROKEN_BRONZE_MIRROR) && count(state, WIND_FEATHER)) {
        await exchange(state, [BROKEN_BRONZE_MIRROR, WIND_FEATHER], WIND_BANGLE, 7);
        return page("Wind Sylph", "Receive the Wind Bangle.");
      }
      return page("Wind Sylph", "Return when you have learned the sign of wind.");
    }

    if (npcId === WASTELAND_LIZARDMAN) {
      if (cond === 5 && count(state, BROKEN_BRONZE_MIRROR) && !count(state, WIND_FEATHER)) {
        return page("Wasteland Lizardman", "The mirror reflects a hidden feather.", '<a action="bypass -h quest 404 feather">Examine the reflection.</a>');
      }
      return page("Wasteland Lizardman", "The wind has nothing more to show you.");
    }

    if (npcId === WATER_UNDINE) {
      if (cond === 7 && count(state, WIND_BANGLE) && !count(state, RAMAS_DIARY) && !count(state, WATER_NECKLACE)) {
        await quest.giveItem(state.session, RAMAS_DIARY, 1);
        await state.set("cond", 8);
        state.playSound(MIDDLE);
        return page("Water Undine", "Collect two Sparkle Pebbles from Water Seers.");
      }
      if (cond === 9 && count(state, RAMAS_DIARY) && count(state, SPARKLE_PEBBLE) >= 2) {
        await exchange(state, [RAMAS_DIARY, SPARKLE_PEBBLE, SPARKLE_PEBBLE], WATER_NECKLACE, 10);
        return page("Water Undine", "Receive the Water Necklace.");
      }
      return page("Water Undine", `Sparkle Pebbles: ${count(state, SPARKLE_PEBBLE)}/2.`);
    }

    if (npcId === EARTH_SNAKE) {
      if (cond === 10 && count(state, WATER_NECKLACE) && !count(state, RUST_GOLD_COIN) && !count(state, EARTH_RING)) {
        await quest.giveItem(state.session, RUST_GOLD_COIN, 1);
        await state.set("cond", 11);
        state.playSound(MIDDLE);
        return page("Earth Snake", "Bring me Red Soil from a Red Bear.");
      }
      if (cond === 12 && count(state, RUST_GOLD_COIN) && count(state, RED_SOIL)) {
        await exchange(state, [RUST_GOLD_COIN, RED_SOIL], EARTH_RING, 13);
        return page("Earth Snake", "Receive the Earth Ring.");
      }
      return page("Earth Snake", "Bring me the Rust Gold Coin and Red Soil.");
    }

    if (npcId === GALLINT) {
      const signs = [FLAME_EARRING, WIND_BANGLE, WATER_NECKLACE, EARTH_RING];
      if (signs.every((item) => count(state, item))) {
        const profession = await quest.awardFirstProfession(state, 11);
        if (!profession.ok) {
          return page("Gallint", profession.reason === "level" ? `Reach level ${profession.requiredLevel} to become a Wizard.` : "Your profession could not be granted. Keep your elemental signs and try again.");
        }
        for (const item of signs) await quest.takeItem(state.session, item);
        if (!count(state, BEAD_OF_SEASON)) await quest.giveItem(state.session, BEAD_OF_SEASON, 1);
        state.playSound(FINISH);
        await state.exit(false);
        return page("Gallint", "You have completed the Path to Wizard and become a Wizard.");
      }
      return page("Gallint", "Bring me the four elemental signs.");
    }

    return null;
  },

  async onKill(state, npc) {
    if (!state.isStarted()) return;
    const npcId = Number(npc.fetchSelfId());
    const quest = service();
    const cond = state.getInt("cond");
    if (npcId === RATMAN_WARRIOR && cond === 2 && !count(state, KEY_OF_FLAME)) {
      await quest.giveItem(state.session, KEY_OF_FLAME, 1);
      await state.set("cond", 3);
      state.playSound(MIDDLE);
    } else if (npcId === WATER_SEER && cond === 8 && count(state, SPARKLE_PEBBLE) < 2) {
      await quest.giveItem(state.session, SPARKLE_PEBBLE, 1);
      if (count(state, SPARKLE_PEBBLE) >= 2) {
        await state.set("cond", 9);
        state.playSound(MIDDLE);
      } else state.playSound(ITEM);
    } else if (npcId === RED_BEAR && cond === 11 && !count(state, RED_SOIL)) {
      await quest.giveItem(state.session, RED_SOIL, 1);
      await state.set("cond", 12);
      state.playSound(MIDDLE);
    }
  },
};
