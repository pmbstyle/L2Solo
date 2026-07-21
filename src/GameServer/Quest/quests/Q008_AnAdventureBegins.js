const JASMINE = 7134;
const ROSELYN = 7355;
const HARNE = 7144;
const ROSELYN_NOTE = 7573;
const MARK_OF_TRAVELER = 7570;
const SOE_GIRAN = 7559;
const SOUND_ACCEPT = 'ItemSound.quest_accept';
const SOUND_MIDDLE = 'ItemSound.quest_middle';
const SOUND_FINISH = 'ItemSound.quest_finish';

function service() { return invoke('GameServer/Quest/QuestService'); }
function page(title, text, action = '') { return `<html><body>${title}:<br>${text}<br><br>${action}</body></html>`; }
function hasNote(state) { return (state.session.actor.backpack.fetchItemFromSelfId(ROSELYN_NOTE)?.fetchAmount() || 0) > 0; }

module.exports = {
    id: 8,
    name: 'An Adventure Begins',
    npcs: [JASMINE, ROSELYN, HARNE],
    startNpcs: [JASMINE],
    eventNpc: (event) => {
        if (event === 'start' || event === 'reward') return JASMINE;
        if (event === 'note') return ROSELYN;
        if (event === 'deliver') return HARNE;
        return null;
    },

    async onEvent(state, event) {
        const Quest = service();
        const actor = state.session.actor;
        if (event === 'start' && !state.isStarted() && !state.isCompleted()) {
            if (Number(actor.fetchRace()) !== 2 || Number(actor.fetchLevel()) < 3) return null;
            await state.setState('started');
            await state.set('cond', 1);
            state.playSound(SOUND_ACCEPT);
            return page('Jasmine', 'Speak with Roselyn before your adventure begins.');
        }
        if (event === 'note' && state.isStarted() && state.getInt('cond') === 1) {
            await state.set('cond', 2);
            await Quest.giveItem(state.session, ROSELYN_NOTE, 1);
            state.playSound(SOUND_MIDDLE);
            return page('Roselyn', 'Deliver this note to Harne.');
        }
        if (event === 'deliver' && state.isStarted() && state.getInt('cond') === 2) {
            if (!hasNote(state)) return page('Harne', 'You do not have Roselyn’s note.');
            await Quest.takeItem(state.session, ROSELYN_NOTE);
            await state.set('cond', 3);
            state.playSound(SOUND_MIDDLE);
            return page('Harne', 'Return to Jasmine.');
        }
        if (event === 'reward' && state.isStarted() && state.getInt('cond') === 3) {
            await Quest.giveItem(state.session, MARK_OF_TRAVELER, 1);
            await Quest.giveItem(state.session, SOE_GIRAN, 1);
            state.playSound(SOUND_FINISH);
            await state.exit(false);
            return page('Jasmine', 'Your adventure may now begin.');
        }
        return null;
    },

    async onTalk(state, npc) {
        const npcId = Number(npc.fetchSelfId());
        const actor = state.session.actor;
        if (state.isCompleted()) return page('Quest', 'You have already completed this quest.');
        if (!state.isStarted()) {
            if (npcId !== JASMINE) return page('Quest', 'You are not on a quest that involves this NPC.');
            if (Number(actor.fetchRace()) !== 2 || Number(actor.fetchLevel()) < 3) return page('Jasmine', 'This adventure is for Dark Elves of level 3 or higher.');
            return page('Jasmine', 'Would you like to begin your adventure?', '<a action="bypass -h quest 8 start">Begin.</a>');
        }

        const cond = state.getInt('cond');
        if (npcId === JASMINE) {
            if (cond < 3) return page('Jasmine', 'Please speak with Roselyn and Harne.');
            return page('Jasmine', 'Welcome back.', '<a action="bypass -h quest 8 reward">Receive the traveler’s mark.</a>');
        }
        if (npcId === ROSELYN) {
            return cond === 1
                ? page('Roselyn', 'I can prepare a note for Harne.', '<a action="bypass -h quest 8 note">Take the note.</a>')
                : page('Roselyn', 'Please continue to Harne.');
        }
        if (npcId === HARNE) {
            return cond === 2
                ? page('Harne', 'Do you have Roselyn’s note?', '<a action="bypass -h quest 8 deliver">Deliver the note.</a>')
                : page('Harne', 'Return to Jasmine.');
        }
        return null;
    }
};
