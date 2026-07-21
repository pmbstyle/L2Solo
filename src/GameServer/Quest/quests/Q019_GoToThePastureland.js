const VLADIMIR = 8302;
const TUNATUN = 8537;
const MEAT = 7547;
const SOUND_ACCEPT = 'ItemSound.quest_accept';
const SOUND_FINISH = 'ItemSound.quest_finish';
function service() { return invoke('GameServer/Quest/QuestService'); }
function page(title, text, action = '') { return `<html><body>${title}:<br>${text}<br><br>${action}</body></html>`; }

module.exports = {
    id: 19, name: 'Go to the Pastureland!', npcs: [VLADIMIR, TUNATUN], startNpcs: [VLADIMIR],
    eventNpc: (event) => ({ start: VLADIMIR, reward: TUNATUN }[event] ?? null),
    async onEvent(state, event) {
        const actor = state.session.actor;
        if (event === 'start' && !state.isStarted() && !state.isCompleted()) {
            if (Number(actor.fetchLevel()) >= 63) return null;
            await state.setState('started'); await state.set('cond', 1); await service().giveItem(state.session, MEAT, 1); state.playSound(SOUND_ACCEPT);
            return page('Vladimir', 'Take the young wild beast meat to Tunatun.');
        }
        if (event === 'reward' && state.isStarted() && state.getInt('cond') === 1) {
            if (!await service().takeItem(state.session, MEAT)) return null;
            await service().rewardAdena(state.session, 30000); state.playSound(SOUND_FINISH); await state.exit(false);
            return page('Tunatun', 'The meat is exactly what I needed.');
        }
        return null;
    },
    async onTalk(state, npc) {
        const npcId = Number(npc.fetchSelfId()); const actor = state.session.actor;
        if (state.isCompleted()) return page('Quest', 'You have already completed this quest.');
        if (!state.isStarted()) return npcId === VLADIMIR ? (Number(actor.fetchLevel()) < 63 ? page('Vladimir', 'Will you travel to the pastureland?', '<a action="bypass -h quest 19 start">Accept.</a>') : page('Vladimir', 'This task is for adventurers below level 63.')) : page('Quest', 'You are not on a quest that involves this NPC.');
        return npcId === VLADIMIR ? page('Vladimir', 'Take the meat to Tunatun.') : page('Tunatun', 'Have you brought the young wild beast meat?', '<a action="bypass -h quest 19 reward">Deliver the meat.</a>');
    }
};
