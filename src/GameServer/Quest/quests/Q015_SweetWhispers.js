const VLADIMIR = 8302;
const HIERARCH = 8517;
const MYSTERIOUS_NECRO = 8518;
const SOUND_ACCEPT = 'ItemSound.quest_accept';
const SOUND_MIDDLE = 'ItemSound.quest_middle';
const SOUND_FINISH = 'ItemSound.quest_finish';
function service() { return invoke('GameServer/Quest/QuestService'); }
function page(title, text, action = '') { return `<html><body>${title}:<br>${text}<br><br>${action}</body></html>`; }
module.exports = {
    id: 15, name: 'Sweet Whispers', npcs: [VLADIMIR, HIERARCH, MYSTERIOUS_NECRO], startNpcs: [VLADIMIR],
    eventNpc: (event) => ({ start: VLADIMIR, message: MYSTERIOUS_NECRO, reward: HIERARCH }[event] ?? null),
    async onEvent(state, event) {
        const actor = state.session.actor;
        if (event === 'start' && !state.isStarted() && !state.isCompleted()) { if (Number(actor.fetchLevel()) >= 60) return null; await state.setState('started'); await state.set('cond', 1); state.playSound(SOUND_ACCEPT); return page('Vladimir', 'Find the Mysterious Necromancer.'); }
        if (event === 'message' && state.isStarted() && state.getInt('cond') === 1) { await state.set('cond', 2); state.playSound(SOUND_MIDDLE); return page('Mysterious Necromancer', 'Deliver my message to the Hierarch.'); }
        if (event === 'reward' && state.isStarted() && state.getInt('cond') === 2) { service().rewardExpSp(state.session, 60217, 0); state.playSound(SOUND_FINISH); await state.exit(false); return page('Hierarch', 'Your message has been received.'); }
        return null;
    },
    async onTalk(state, npc) { const npcId = Number(npc.fetchSelfId()); const actor = state.session.actor; if (state.isCompleted()) return page('Quest', 'You have already completed this quest.'); if (!state.isStarted()) return npcId === VLADIMIR ? (Number(actor.fetchLevel()) < 60 ? page('Vladimir', 'A message must be delivered.', '<a action="bypass -h quest 15 start">Accept.</a>') : page('Vladimir', 'This task is for adventurers below level 60.')) : page('Quest', 'You are not on a quest that involves this NPC.'); const cond = state.getInt('cond'); if (npcId === VLADIMIR) return page('Vladimir', 'Find the Mysterious Necromancer.'); if (npcId === MYSTERIOUS_NECRO) return cond === 1 ? page('Mysterious Necromancer', 'I have a message.', '<a action="bypass -h quest 15 message">Receive the message.</a>') : page('Mysterious Necromancer', 'Take the message to the Hierarch.'); return cond === 2 ? page('Hierarch', 'Do you bring a message?', '<a action="bypass -h quest 15 reward">Deliver the message.</a>') : page('Hierarch', 'Speak with the Necromancer first.'); }
};
