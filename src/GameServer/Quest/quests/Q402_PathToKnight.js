const SIR_KLAUS = 7417;
const SIR_ARON = 7332;
const SIR_COLLIN = 7289;
const SIR_KYLE = 7379;
const SIR_DRYSTAN = 7037;
const SIR_JEREMY = 7039;
const SIR_HEROD = 7031;
const HINEN = 7311;
const ROSHEEK = 7653;

const MARK_OF_ESQUIRE = 1271;
const SWORD_OF_RITUAL = 1161;
const COINS = [1162, 1163, 1164, 1165, 1166, 1167];

const assignments = [
  { event: 'aron', npc: SIR_ARON, mark: 1168, item: 1169, coin: 1162, needed: 10, mobs: [775], chance: 1, title: 'Sir Aron', itemName: 'Bugbear Necklaces' },
  { event: 'collin', npc: SIR_COLLIN, mark: 1170, item: 1171, coin: 1163, needed: 12, mobs: [5024], chance: 1, title: 'Sir Collin', itemName: 'Einhasad Crucifixes' },
  { event: 'kyle', npc: SIR_KYLE, mark: 1172, item: 1173, coin: 1164, needed: 20, mobs: [38, 43, 50], chance: 1, title: 'Sir Kyle', itemName: 'Poison Spider Legs' },
  { event: 'drystan', npc: SIR_DRYSTAN, mark: 1174, item: 1175, coin: 1165, needed: 20, mobs: [24, 27, 30], chance: 0.5, title: 'Sir Drystan', itemName: 'Lizardman Totems' },
  { event: 'jeremy', npc: SIR_JEREMY, mark: 1176, item: 1177, coin: 1166, needed: 20, mobs: [103, 106, 108], chance: 0.4, title: 'Sir Jeremy', itemName: 'Giant Spider Husks' },
  { event: 'herod', npc: SIR_HEROD, mark: 1178, item: 1179, coin: 1167, needed: 10, mobs: [404], chance: 1, title: 'Sir Herod', itemName: 'Horrible Skulls' },
];

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

function assignmentForNpc(npcId) {
  return assignments.find((assignment) => assignment.npc === npcId);
}

function assignmentForMob(npcId) {
  return assignments.find((assignment) => assignment.mobs.includes(npcId));
}

function coinsCollected(state) {
  return COINS.reduce((total, itemId) => total + count(state, itemId), 0);
}

async function collect(state, assignment) {
  const current = count(state, assignment.item);
  if (current >= assignment.needed || Math.random() >= assignment.chance) return false;
  const amount = service().questDropAmount(1, assignment.needed, current);
  if (!amount) return false;
  await service().giveItem(state.session, assignment.item, amount);
  return current + amount >= assignment.needed;
}

async function consume(quest, state, itemIds) {
  for (const itemId of itemIds) await quest.takeItem(state.session, itemId, -1);
}

module.exports = {
  id: 402,
  name: 'Path to Knight',
  npcs: [SIR_KLAUS, SIR_ARON, SIR_COLLIN, SIR_KYLE, SIR_DRYSTAN, SIR_JEREMY, SIR_HEROD, HINEN, ROSHEEK],
  startNpcs: [SIR_KLAUS],
  killNpcs: assignments.flatMap((assignment) => assignment.mobs),
  eventNpc: (event) => ({ start: SIR_KLAUS, ...Object.fromEntries(assignments.map((assignment) => [assignment.event, assignment.npc])) })[event] ?? null,

  async onEvent(state, event) {
    const quest = service();
    const actor = state.session.actor;
    if (event === 'start' && !state.isStarted() && !state.isCompleted()) {
      if (Number(actor.fetchClassId()) !== 0 || Number(actor.fetchLevel()) < 19) return null;
      await state.setState('started');
      await state.set('cond', 1);
      await quest.giveItem(state.session, MARK_OF_ESQUIRE, 1);
      state.playSound(ACCEPT);
      return page('Sir Klaus Vasper', 'Seek six coins from the Lords of Gludio.');
    }

    const assignment = assignments.find((entry) => entry.event === event);
    if (assignment && state.getInt('cond') === 1 && count(state, MARK_OF_ESQUIRE) && !count(state, assignment.mark) && !count(state, assignment.coin)) {
      await quest.giveItem(state.session, assignment.mark, 1);
      state.playSound(MIDDLE);
      return page(assignment.title, `Bring me ${assignment.needed} ${assignment.itemName}.`);
    }
    return null;
  },

  async onTalk(state, npc) {
    const npcId = Number(npc.fetchSelfId());
    const quest = service();
    const cond = state.getInt('cond');

    if (state.isCompleted()) return page('Sir Klaus Vasper', 'You have already completed the Path to Knight.');
    if (!state.isStarted()) {
      const actor = state.session.actor;
      if (npcId !== SIR_KLAUS || Number(actor.fetchClassId()) !== 0) return page('Quest', 'This path is not for your current class.');
      return Number(actor.fetchLevel()) < 19
        ? page('Sir Klaus Vasper', 'Come back after reaching level 19.')
        : page('Sir Klaus Vasper', 'Do you seek the path of a Knight?', '<a action="bypass -h quest 402 start">Accept the trial.</a>');
    }
    if (cond !== 1) return page('Quest', 'Continue your trial.');

    if (npcId === SIR_KLAUS) {
      const coins = coinsCollected(state);
      const hasAllCoins = COINS.every((coin) => count(state, coin) >= 1);
      if (!count(state, MARK_OF_ESQUIRE) || !hasAllCoins) return page('Sir Klaus Vasper', `Coins of Lords: ${coins}/6. Complete the Lords’ requests in any order.`);
      const profession = await quest.awardFirstProfession(state, 4);
      if (!profession.ok) {
        return page('Sir Klaus Vasper', profession.reason === 'level' ? `Reach level ${profession.requiredLevel} to become a Human Knight.` : 'Your profession could not be granted. Keep your quest items and try again.');
      }
      await consume(quest, state, [MARK_OF_ESQUIRE, ...COINS, ...assignments.flatMap((assignment) => [assignment.mark, assignment.item])]);
      await quest.giveItem(state.session, SWORD_OF_RITUAL, 1);
      state.playSound(FINISH);
      await state.exit(false);
      return page('Sir Klaus Vasper', 'You have completed the Path to Knight and become a Human Knight.');
    }

    const assignment = assignmentForNpc(npcId);
    if (assignment) {
      if (count(state, assignment.coin)) return page(assignment.title, 'You have already earned my Coin of Lords.');
      if (!count(state, assignment.mark)) {
        return page(assignment.title, `I can help only after you present Sir Klaus’s mark. <a action="bypass -h quest 402 ${assignment.event}">Accept my request.</a>`);
      }
      if (count(state, assignment.item) < assignment.needed) {
        return page(assignment.title, `${assignment.itemName}: ${count(state, assignment.item)}/${assignment.needed}.`);
      }
      await quest.takeItem(state.session, assignment.item, -1);
      await quest.takeItem(state.session, assignment.mark);
      await quest.giveItem(state.session, assignment.coin, 1);
      state.playSound(MIDDLE);
      return page(assignment.title, 'Take this Coin of Lords to Sir Klaus.');
    }
    if ([HINEN, ROSHEEK].includes(npcId)) return page('Quest', 'The Knights of Gludio need the six Coins of Lords.');
    return page('Quest', 'Continue your trial.');
  },

  async onKill(state, npc) {
    if (state.getInt('cond') !== 1) return;
    const assignment = assignmentForMob(Number(npc.fetchSelfId()));
    if (!assignment || !count(state, assignment.mark) || count(state, assignment.coin)) return;
    if (await collect(state, assignment)) state.playSound(MIDDLE);
    else if (count(state, assignment.item)) state.playSound(ITEM);
  },
};
