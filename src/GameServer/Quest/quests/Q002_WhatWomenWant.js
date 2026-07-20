const ARUJIEN = 7223;
const MIRABEL = 7146;
const HERBIEL = 7150;
const GREENIS = 7157;
const LETTER_1 = 1092;
const LETTER_2 = 1093;
const LETTER_3 = 1094;
const POETRY_BOOK = 689;
const GREENIS_LETTER = 693;
const BEGINNERS_POTION = 1073;

function service() { return invoke('GameServer/Quest/QuestService'); }
function page(title, text, action = '') { return `<html><body>${title}:<br>${text}<br><br>${action}</body></html>`; }
function startLink() { return '<a action="bypass -h quest 2 start">I will help you.</a>'; }

module.exports = {
    id: 2,
    name: 'What Women Want',
    npcs: [ARUJIEN, MIRABEL, HERBIEL, GREENIS],
    startNpcs: [ARUJIEN],
    eventNpc: (event) => ['start', 'poetry', 'reward'].includes(event) ? ARUJIEN : null,

    async onEvent(state, event) {
        const Quest = service();
        if (event === 'start' && !state.isStarted() && !state.isCompleted()) {
            const actor = state.session.actor;
            if (Number(actor.fetchLevel()) < 2 || ![0, 1].includes(Number(actor.fetchRace()))) return null;
            await state.setState('started');
            await state.set('cond', 1);
            await Quest.giveItem(state.session, LETTER_1, 1);
            return page('Arujien', 'Please ask Mirabel about Greenis.');
        }
        if (event === 'poetry' && state.getInt('cond') === 3) {
            await state.set('cond', 4);
            await Quest.takeItem(state.session, LETTER_3);
            await Quest.giveItem(state.session, POETRY_BOOK, 1);
            return page('Arujien', 'Please deliver this poetry book to Greenis.');
        }
        if (event === 'reward' && state.getInt('cond') === 3) {
            await Quest.takeItem(state.session, LETTER_3);
            await Quest.rewardItem(state.session, 57, 450);
            await state.exit(false);
            return page('Arujien', 'Thank you for your help.');
        }
        return null;
    },

    async onTalk(state, npc) {
        const Quest = service();
        const npcId = Number(npc.fetchSelfId());
        const actor = state.session.actor;
        if (state.isCompleted()) return page('Quest', 'You have already completed this quest.');
        if (!state.isStarted()) {
            if (npcId !== ARUJIEN) return page('Quest', 'You are not on a quest that involves this NPC.');
            if (![0, 1].includes(Number(actor.fetchRace()))) return page('Arujien', 'I only need the help of a Human or an Elf.');
            return Number(actor.fetchLevel()) < 2 ? page('Arujien', 'Come back after reaching level 2.') : page('Arujien', 'I need help with a delicate matter.', startLink());
        }

        const cond = state.getInt('cond');
        if (npcId === MIRABEL) {
            if (cond === 1) {
                await Quest.takeItem(state.session, LETTER_1);
                await Quest.giveItem(state.session, LETTER_2, 1);
                await state.set('cond', 2);
                return page('Mirabel', 'Herbiel may know where Greenis is.');
            }
            return page('Mirabel', 'Please continue your errand.');
        }
        if (npcId === HERBIEL) {
            if (cond === 2) {
                await Quest.takeItem(state.session, LETTER_2);
                await Quest.giveItem(state.session, LETTER_3, 1);
                await state.set('cond', 3);
                return page('Herbiel', 'Take this reply back to Arujien.');
            }
            return page('Herbiel', 'Please return to Arujien.');
        }
        if (npcId === GREENIS) {
            if (cond === 4) {
                await Quest.takeItem(state.session, POETRY_BOOK);
                await Quest.giveItem(state.session, GREENIS_LETTER, 1);
                await state.set('cond', 5);
                return page('Greenis', 'Please take my letter to Arujien.');
            }
            return page('Greenis', 'I cannot help you yet.');
        }
        if (npcId === ARUJIEN) {
            if (cond === 1) return page('Arujien', 'Please speak with Mirabel.');
            if (cond === 2) return page('Arujien', 'Please speak with Herbiel.');
            if (cond === 3) return page('Arujien', 'What did Herbiel say?', '<a action="bypass -h quest 2 poetry">Give him the poetry book.</a><br><a action="bypass -h quest 2 reward">Give him the reply and finish.</a>');
            if (cond === 4) return page('Arujien', 'Please deliver the poetry book to Greenis.');
            if (cond === 5) {
                await Quest.takeItem(state.session, GREENIS_LETTER);
                await Quest.giveItem(state.session, BEGINNERS_POTION, 5);
                await state.exit(false);
                return page('Arujien', 'Thank you. Please accept these beginner potions.');
            }
        }
        return null;
    }
};
