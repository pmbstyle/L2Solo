const LIESEL = 8263;
const GHOST_OF_ADVENTURER = 8538;
const LETTER = 7253;
const SOUND_ACCEPT = 'ItemSound.quest_accept';
const SOUND_FINISH = 'ItemSound.quest_finish';
function service() { return invoke('GameServer/Quest/QuestService'); }
function page(title, text, action = '') { return `<html><body>${title}:<br>${text}<br><br>${action}</body></html>`; }
module.exports = {
    id: 14, name: 'Whereabouts of the Archaeologist', npcs: [LIESEL, GHOST_OF_ADVENTURER], startNpcs: [LIESEL],
    eventNpc: (event) => ({ start: LIESEL, reward: GHOST_OF_ADVENTURER }[event] ?? null),
    async onEvent(state, event) {
        const actor = state.session.actor;
        if (event === 'start' && !state.isStarted() && !state.isCompleted()) { if (Number(actor.fetchLevel()) >= 74) return null; await state.setState('started'); await state.set('cond', 1); await service().giveItem(state.session, LETTER, 1); state.playSound(SOUND_ACCEPT); return page('Liesel', 'Take this letter to the Ghost of an Adventurer.'); }
        if (event === 'reward' && state.isStarted() && state.getInt('cond') === 1) { if (!await service().takeItem(state.session, LETTER)) return null; await service().rewardAdena(state.session, 113228); state.playSound(SOUND_FINISH); await state.exit(false); return page('Ghost of an Adventurer', 'Thank you for the letter.'); }
        return null;
    },
    async onTalk(state, npc) { const npcId = Number(npc.fetchSelfId()); const actor = state.session.actor; if (state.isCompleted()) return page('Quest', 'You have already completed this quest.'); if (!state.isStarted()) return npcId === LIESEL ? (Number(actor.fetchLevel()) < 74 ? page('Liesel', 'Will you carry a letter?', '<a action="bypass -h quest 14 start">Accept.</a>') : page('Liesel', 'This task is for adventurers below level 74.')) : page('Quest', 'You are not on a quest that involves this NPC.'); return npcId === LIESEL ? page('Liesel', 'Find the Ghost of an Adventurer.') : page('Ghost of an Adventurer', 'Do you have Liesel’s letter?', '<a action="bypass -h quest 14 reward">Deliver the letter.</a>'); }
};
