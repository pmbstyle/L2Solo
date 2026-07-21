const CADMON = 8296;
const LEON = 8256;
const WAHKAN = 8371;
const MUNITIONS_BOX = 7231;
const SOUND_ACCEPT = 'ItemSound.quest_accept';
const SOUND_MIDDLE = 'ItemSound.quest_middle';
const SOUND_FINISH = 'ItemSound.quest_finish';
function service() { return invoke('GameServer/Quest/QuestService'); }
function page(title, text, action = '') { return `<html><body>${title}:<br>${text}<br><br>${action}</body></html>`; }
module.exports = {
    id: 11, name: 'Secret Meeting With Ketra Orcs', npcs: [CADMON, LEON, WAHKAN], startNpcs: [CADMON],
    eventNpc: (event) => ({ start: CADMON, supplies: LEON, reward: WAHKAN }[event] ?? null),
    async onEvent(state, event) {
        const actor = state.session.actor;
        if (event === 'start' && !state.isStarted() && !state.isCompleted()) { if (Number(actor.fetchLevel()) >= 74) return null; await state.setState('started'); await state.set('cond', 1); state.playSound(SOUND_ACCEPT); return page('Cadmon', 'Meet Leon to collect the munitions.'); }
        if (event === 'supplies' && state.isStarted() && state.getInt('cond') === 1) { await service().giveItem(state.session, MUNITIONS_BOX, 1); await state.set('cond', 2); state.playSound(SOUND_MIDDLE); return page('Leon', 'Deliver the box to Wahkan.'); }
        if (event === 'reward' && state.isStarted() && state.getInt('cond') === 2) { if (!await service().takeItem(state.session, MUNITIONS_BOX)) return null; service().rewardExpSp(state.session, 79787, 0); state.playSound(SOUND_FINISH); await state.exit(false); return page('Wahkan', 'The Ketra Orcs thank you.'); }
        return null;
    },
    async onTalk(state, npc) {
        const npcId = Number(npc.fetchSelfId()); const actor = state.session.actor;
        if (state.isCompleted()) return page('Quest', 'You have already completed this quest.');
        if (!state.isStarted()) return npcId === CADMON ? (Number(actor.fetchLevel()) < 74 ? page('Cadmon', 'I need a discreet courier.', '<a action="bypass -h quest 11 start">Accept.</a>') : page('Cadmon', 'This task is for adventurers below level 74.')) : page('Quest', 'You are not on a quest that involves this NPC.');
        const cond = state.getInt('cond');
        if (npcId === CADMON) return page('Cadmon', 'Meet Leon.');
        if (npcId === LEON) return cond === 1 ? page('Leon', 'Take this munitions box.', '<a action="bypass -h quest 11 supplies">Receive the box.</a>') : page('Leon', 'Deliver it to Wahkan.');
        return cond === 2 ? page('Wahkan', 'Have you brought the box?', '<a action="bypass -h quest 11 reward">Deliver the box.</a>') : page('Wahkan', 'Speak with Leon first.');
    }
};
