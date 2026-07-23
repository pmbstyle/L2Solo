const AURON = 7010;
const SIMPLON = 7253;
const TRACKER_SKELETON = 35;
const TRACKER_SKELETON_LEADER = 42;
const POISON_SPIDER = 38;
const ARACHNID_SPIDER = 43;

const AURONS_LETTER = 1138;
const WARRIOR_GUILD_MARK = 1139;
const RUSTED_SWORD_1 = 1140;
const RUSTED_SWORD_2 = 1141;
const RUSTED_SWORD_3 = 1142;
const SIMPLONS_LETTER = 1143;
const POISON_SPIDER_LEG = 1144;
const MEDALLION_OF_WARRIOR = 1145;

const ACCEPT = 'ItemSound.quest_accept';
const ITEM = 'ItemSound.quest_itemget';
const MIDDLE = 'ItemSound.quest_middle';
const FINISH = 'ItemSound.quest_finish';

function service() {
  return invoke('GameServer/Quest/QuestService');
}

function page(title, text, action = '') {
  return `<html><body>${title}:<br>${text}<br><br>${action}</body></html>`;
}

function count(state, selfId) {
  return state.session.actor.backpack.fetchItemFromSelfId(selfId)?.fetchAmount() || 0;
}

function equippedWeapon(state) {
  const backpack = state.session.actor.backpack;
  return Number(backpack.fetchPaperdollSelfId?.(7)) || 0;
}

async function collect(state, selfId, needed, chance = 1) {
  const current = count(state, selfId);
  if (current >= needed || Math.random() >= chance) return false;
  const amount = service().questDropAmount(1, needed, current);
  if (!amount) return false;
  await service().giveItem(state.session, selfId, amount);
  return current + amount >= needed;
}

module.exports = {
  id: 401,
  name: 'Path to Warrior',
  npcs: [AURON, SIMPLON],
  startNpcs: [AURON],
  killNpcs: [TRACKER_SKELETON, TRACKER_SKELETON_LEADER, POISON_SPIDER, ARACHNID_SPIDER],
  eventNpc: (event) => ({ start: AURON, guild: SIMPLON, forge: AURON })[event] ?? null,

  async onEvent(state, event) {
    const quest = service();
    const actor = state.session.actor;
    if (event === 'start' && !state.isStarted() && !state.isCompleted()) {
      if (Number(actor.fetchClassId()) !== 0 || Number(actor.fetchLevel()) < 19) return null;
      await state.setState('started');
      await state.set('cond', 1);
      await quest.giveItem(state.session, AURONS_LETTER, 1);
      state.playSound(ACCEPT);
      return page('Auron', 'Take my letter to Simplon in the Warrior Guild.');
    }
    if (event === 'guild' && state.getInt('cond') === 1) {
      if (!(await quest.takeItem(state.session, AURONS_LETTER))) return null;
      await quest.giveItem(state.session, WARRIOR_GUILD_MARK, 1);
      await state.set('cond', 2);
      state.playSound(MIDDLE);
      return page('Simplon', 'Bring me ten pieces of rusted bronze sword.');
    }
    if (event === 'forge' && state.getInt('cond') === 4) {
      if (!(await quest.takeItem(state.session, SIMPLONS_LETTER))) return null;
      if (!(await quest.takeItem(state.session, RUSTED_SWORD_2))) return null;
      await quest.giveItem(state.session, RUSTED_SWORD_3, 1);
      await state.set('cond', 5);
      state.playSound(MIDDLE);
      return page('Auron', 'Equip the Rusted Bronze Sword and hunt Poison Spiders.');
    }
    return null;
  },

  async onTalk(state, npc) {
    const npcId = Number(npc.fetchSelfId());
    const actor = state.session.actor;
    const quest = service();
    const cond = state.getInt('cond');

    if (state.isCompleted()) return page('Auron', 'You have already completed the Path to Warrior.');
    if (!state.isStarted()) {
      if (npcId !== AURON || Number(actor.fetchClassId()) !== 0) return page('Quest', 'This path is not for your current class.');
      return Number(actor.fetchLevel()) < 19
        ? page('Auron', 'Come back after reaching level 19.')
        : page('Auron', 'Do you seek the path of a Warrior?', '<a action="bypass -h quest 401 start">Accept the trial.</a>');
    }

    if (npcId === SIMPLON) {
      if (cond === 1 && count(state, AURONS_LETTER)) {
        return page('Simplon', 'Auron sent you?', '<a action="bypass -h quest 401 guild">Present Auron’s letter.</a>');
      }
      if (cond === 2 && count(state, WARRIOR_GUILD_MARK)) return page('Simplon', `Rusted bronze swords: ${count(state, RUSTED_SWORD_1)}/10.`);
      if (cond === 3 && count(state, WARRIOR_GUILD_MARK) && count(state, RUSTED_SWORD_1) >= 10) {
        await quest.takeItem(state.session, WARRIOR_GUILD_MARK);
        await quest.takeItem(state.session, RUSTED_SWORD_1, -1);
        await quest.giveItem(state.session, RUSTED_SWORD_2, 1);
        await quest.giveItem(state.session, SIMPLONS_LETTER, 1);
        await state.set('cond', 4);
        state.playSound(MIDDLE);
        return page('Simplon', 'Take this sword and my letter back to Auron.');
      }
      return page('Simplon', 'Continue your trial with Auron.');
    }

    if (cond === 1 && count(state, AURONS_LETTER)) return page('Auron', 'Take my letter to Simplon.');
    if (cond === 4 && count(state, SIMPLONS_LETTER)) {
      return page('Auron', 'Simplon has sent the sword.', '<a action="bypass -h quest 401 forge">Repair the Rusted Bronze Sword.</a>');
    }
    if (cond >= 5 && count(state, RUSTED_SWORD_3)) {
      if (count(state, POISON_SPIDER_LEG) < 20) {
        return page('Auron', `Poison Spider’s Legs: ${count(state, POISON_SPIDER_LEG)}/20. Equip the Rusted Bronze Sword first.`);
      }
      const profession = await quest.awardFirstProfession(state, 1);
      if (!profession.ok) {
        return page('Auron', profession.reason === 'level' ? `Reach level ${profession.requiredLevel} to become a Warrior.` : 'Your profession could not be granted. Keep your quest items and try again.');
      }
      await quest.takeItem(state.session, POISON_SPIDER_LEG, -1);
      await quest.takeItem(state.session, RUSTED_SWORD_3);
      await quest.giveItem(state.session, MEDALLION_OF_WARRIOR, 1);
      state.playSound(FINISH);
      await state.exit(false);
      return page('Auron', 'You have completed the Path to Warrior and become a Warrior.');
    }
    return page('Auron', 'Continue your trial.');
  },

  async onKill(state, npc) {
    const npcId = Number(npc.fetchSelfId());
    if ([TRACKER_SKELETON, TRACKER_SKELETON_LEADER].includes(npcId) && state.getInt('cond') === 2) {
      if (await collect(state, RUSTED_SWORD_1, 10, 0.7)) {
        await state.set('cond', 3);
        state.playSound(MIDDLE);
      } else if (count(state, RUSTED_SWORD_1)) state.playSound(ITEM);
      return;
    }
    if (![POISON_SPIDER, ARACHNID_SPIDER].includes(npcId) || state.getInt('cond') !== 5) return;
    if (equippedWeapon(state) !== RUSTED_SWORD_3) return;
    if (await collect(state, POISON_SPIDER_LEG, 20)) {
      await state.set('cond', 6);
      state.playSound(MIDDLE);
    } else if (count(state, POISON_SPIDER_LEG)) state.playSound(ITEM);
  },
};
