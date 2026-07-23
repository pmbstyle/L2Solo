const BEZIQUE = 7379;
const NETI = 7425;
const CATS_EYE_BANDIT = 5038;

const BEZIQUES_LETTER = 1180;
const NETIS_BOW = 1181;
const NETIS_DAGGER = 1182;
const SPARTOI_BONES = 1183;
const HORSESHOE_OF_LIGHT = 1184;
const WANTED_BILL = 1185;
const STOLEN_ITEMS = [1186, 1187, 1188, 1189];
const BEZIQUES_RECOMMENDATION = 1190;

const BONE_CHANCE = new Map([
  [35, 0.2], [42, 0.3], [45, 0.2], [51, 0.2], [54, 0.8], [60, 0.8],
]);

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
  return Number(state.session.actor.backpack.fetchPaperdollSelfId?.(7)) || 0;
}

function hasNetiWeapon(state) {
  return [NETIS_BOW, NETIS_DAGGER].includes(equippedWeapon(state));
}

function hasAllStolenItems(state) {
  return STOLEN_ITEMS.every((item) => count(state, item) > 0);
}

async function collectBones(state, chance) {
  const current = count(state, SPARTOI_BONES);
  if (current >= 10 || Math.random() >= chance) return false;
  const amount = service().questDropAmount(1, 10, current);
  if (!amount) return false;
  await service().giveItem(state.session, SPARTOI_BONES, amount);
  return current + amount >= 10;
}

module.exports = {
  id: 403,
  name: 'Path to Rogue',
  npcs: [BEZIQUE, NETI],
  startNpcs: [BEZIQUE],
  killNpcs: [CATS_EYE_BANDIT, ...BONE_CHANCE.keys()],
  eventNpc: (event) => ({ start: BEZIQUE, neti: NETI })[event] ?? null,

  async onEvent(state, event) {
    const quest = service();
    const actor = state.session.actor;
    if (event === 'start' && !state.isStarted() && !state.isCompleted()) {
      if (Number(actor.fetchClassId()) !== 0 || Number(actor.fetchLevel()) < 19) return null;
      await state.setState('started');
      await state.set('cond', 1);
      await quest.giveItem(state.session, BEZIQUES_LETTER, 1);
      state.playSound(ACCEPT);
      return page('Bezique', 'Take this letter to Neti.');
    }
    if (event === 'neti' && state.getInt('cond') === 1) {
      if (!(await quest.takeItem(state.session, BEZIQUES_LETTER))) return null;
      if (!count(state, NETIS_BOW)) await quest.giveItem(state.session, NETIS_BOW, 1);
      if (!count(state, NETIS_DAGGER)) await quest.giveItem(state.session, NETIS_DAGGER, 1);
      await state.set('cond', 2);
      state.playSound(MIDDLE);
      return page('Neti', 'Equip either weapon and bring me ten Spartoi bones.');
    }
    return null;
  },

  async onTalk(state, npc) {
    const npcId = Number(npc.fetchSelfId());
    const quest = service();
    const cond = state.getInt('cond');

    if (state.isCompleted()) return page('Bezique', 'You have already completed the Path to Rogue.');
    if (!state.isStarted()) {
      const actor = state.session.actor;
      if (npcId !== BEZIQUE || Number(actor.fetchClassId()) !== 0) return page('Quest', 'This path is not for your current class.');
      return Number(actor.fetchLevel()) < 19
        ? page('Bezique', 'Come back after reaching level 19.')
        : page('Bezique', 'Do you seek the path of a Rogue?', '<a action="bypass -h quest 403 start">Accept the trial.</a>');
    }

    if (npcId === NETI) {
      if (cond === 1 && count(state, BEZIQUES_LETTER)) return page('Neti', 'Bezique sent you?', '<a action="bypass -h quest 403 neti">Present Bezique’s letter.</a>');
      if (count(state, WANTED_BILL)) return page('Neti', 'Use the wanted bill to recover the stolen items from Cat’s Eye Bandits.');
      if (count(state, SPARTOI_BONES) < 10) return page('Neti', `Spartoi Bones: ${count(state, SPARTOI_BONES)}/10. Equip Neti’s weapon first.`);
      if (!count(state, HORSESHOE_OF_LIGHT)) {
        await quest.takeItem(state.session, SPARTOI_BONES, -1);
        await quest.giveItem(state.session, HORSESHOE_OF_LIGHT, 1);
        await state.set('cond', 4);
        state.playSound(MIDDLE);
        return page('Neti', 'Take the Horseshoe of Light back to Bezique.');
      }
      return page('Neti', 'Return to Bezique.');
    }

    if (hasAllStolenItems(state) && !count(state, HORSESHOE_OF_LIGHT)) {
      const profession = await quest.awardFirstProfession(state, 7);
      if (!profession.ok) {
        return page('Bezique', profession.reason === 'level' ? `Reach level ${profession.requiredLevel} to become a Rogue.` : 'Your profession could not be granted. Keep your quest items and try again.');
      }
      for (const item of [NETIS_BOW, NETIS_DAGGER, WANTED_BILL, ...STOLEN_ITEMS]) await quest.takeItem(state.session, item, -1);
      await quest.giveItem(state.session, BEZIQUES_RECOMMENDATION, 1);
      state.playSound(FINISH);
      await state.exit(false);
      return page('Bezique', 'You have completed the Path to Rogue and become a Rogue.');
    }
    if (count(state, BEZIQUES_LETTER)) return page('Bezique', 'Take my letter to Neti.');
    if (count(state, HORSESHOE_OF_LIGHT)) {
      await quest.takeItem(state.session, HORSESHOE_OF_LIGHT);
      await quest.giveItem(state.session, WANTED_BILL, 1);
      await state.set('cond', 5);
      state.playSound(MIDDLE);
      return page('Bezique', 'Hunt Cat’s Eye Bandits for the stolen items.');
    }
    if (count(state, WANTED_BILL)) return page('Bezique', 'Recover every stolen item from Cat’s Eye Bandits.');
    return page('Bezique', 'Equip Neti’s weapon and complete her request.');
  },

  async onKill(state, npc) {
    if (!state.isStarted() || !hasNetiWeapon(state)) return;
    const npcId = Number(npc.fetchSelfId());
    const chance = BONE_CHANCE.get(npcId);
    if (chance !== undefined && state.getInt('cond') > 0) {
      if (await collectBones(state, chance)) {
        await state.set('cond', 3);
        state.playSound(MIDDLE);
      } else if (count(state, SPARTOI_BONES)) state.playSound(ITEM);
      return;
    }
    if (npcId !== CATS_EYE_BANDIT || !count(state, WANTED_BILL)) return;
    const item = STOLEN_ITEMS[Math.floor(Math.random() * STOLEN_ITEMS.length)];
    if (count(state, item)) return;
    await service().giveItem(state.session, item, 1);
    if (hasAllStolenItems(state)) {
      await state.set('cond', 6);
      state.playSound(MIDDLE);
    } else state.playSound(ITEM);
  },
};
