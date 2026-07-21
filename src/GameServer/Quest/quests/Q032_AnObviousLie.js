const MAXIMILIAN = 7120;
const GENTLER = 7094;
const MIKI = 8706;
const ALLIGATOR = 135;
const MAP = 7165;
const HERB = 7166;
const SUEDE = 1866;
const THREAD = 1868;
const SPIRIT_ORE = 3031;
const REWARDS = { cat: 6843, racoon: 7680, rabbit: 7683 };
const SOUND_ACCEPT = 'ItemSound.quest_accept';
const SOUND_ITEMGET = 'ItemSound.quest_itemget';
const SOUND_MIDDLE = 'ItemSound.quest_middle';
const SOUND_FINISH = 'ItemSound.quest_finish';
function service() { return invoke('GameServer/Quest/QuestService'); }
function count(state, itemId) { return state.session.actor.backpack.fetchItemFromSelfId(itemId)?.fetchAmount() || 0; }
function page(title, text, action = '') { return `<html><body>${title}:<br>${text}<br><br>${action}</body></html>`; }

module.exports = {
    id: 32, name: 'An Obvious Lie', npcs: [MAXIMILIAN, GENTLER, MIKI], startNpcs: [MAXIMILIAN], killNpcs: [ALLIGATOR],
    eventNpc: (event) => ({ start: MAXIMILIAN, map: GENTLER, miki: MIKI, herbs: GENTLER, ore: GENTLER, message: MIKI, return: GENTLER, cat: GENTLER, racoon: GENTLER, rabbit: GENTLER }[event] ?? null),
    async onEvent(state, event) {
        const Quest = service(); const actor = state.session.actor;
        if (event === 'start' && !state.isStarted() && !state.isCompleted()) {
            if (Number(actor.fetchLevel()) >= 45) return null;
            await state.setState('started'); await state.set('cond', 1); state.playSound(SOUND_ACCEPT);
            return page('Maximilian', 'Visit Gentler in Giran.');
        }
        if (event === 'map' && state.isStarted() && state.getInt('cond') === 1) {
            await Quest.giveItem(state.session, MAP, 1); await state.set('cond', 2); state.playSound(SOUND_MIDDLE);
            return page('Gentler', 'Take this map to Miki the Cat.');
        }
        if (event === 'miki' && state.isStarted() && state.getInt('cond') === 2) {
            if (!await Quest.takeItem(state.session, MAP)) return null;
            await state.set('cond', 3); state.playSound(SOUND_MIDDLE);
            return page('Miki the Cat', 'Gather 20 medicinal herbs from Alligators.');
        }
        if (event === 'herbs' && state.isStarted() && state.getInt('cond') === 4) {
            if (!await Quest.takeItem(state.session, HERB, 20)) return null;
            await state.set('cond', 5); state.playSound(SOUND_MIDDLE);
            return page('Gentler', 'Bring me 500 Spirit Ore.');
        }
        if (event === 'ore' && state.isStarted() && state.getInt('cond') === 5) {
            if (count(state, SPIRIT_ORE) < 500) return page('Gentler', 'You still need 500 Spirit Ore.');
            await Quest.takeItem(state.session, SPIRIT_ORE, 500); await state.set('cond', 6); state.playSound(SOUND_MIDDLE);
            return page('Gentler', 'Return to Miki the Cat.');
        }
        if (event === 'message' && state.isStarted() && state.getInt('cond') === 6) {
            await state.set('cond', 7); state.playSound(SOUND_MIDDLE);
            return page('Miki the Cat', 'Take my message back to Gentler.');
        }
        if (event === 'return' && state.isStarted() && state.getInt('cond') === 7) {
            await state.set('cond', 8); state.playSound(SOUND_MIDDLE);
            return page('Gentler', 'Choose the ears you would like made.');
        }
        if (Object.hasOwn(REWARDS, event) && state.isStarted() && state.getInt('cond') === 8) {
            if (count(state, SUEDE) < 500 || count(state, THREAD) < 1000) return page('Gentler', 'You need 500 Suede and 1,000 Thread.');
            await Quest.takeItem(state.session, SUEDE, 500); await Quest.takeItem(state.session, THREAD, 1000);
            await Quest.giveItem(state.session, REWARDS[event], 1); state.playSound(SOUND_FINISH); await state.exit(false);
            return page('Gentler', 'Your custom ears are ready.');
        }
        return null;
    },
    async onTalk(state, npc) {
        const npcId = Number(npc.fetchSelfId()); const actor = state.session.actor;
        if (state.isCompleted()) return page('Quest', 'You have already completed this quest.');
        if (!state.isStarted()) return npcId === MAXIMILIAN ? (Number(actor.fetchLevel()) < 45 ? page('Maximilian', 'Will you investigate an obvious lie?', '<a action="bypass -h quest 32 start">Accept.</a>') : page('Maximilian', 'This task is for adventurers below level 45.')) : page('Quest', 'You are not on a quest that involves this NPC.');
        const cond = state.getInt('cond');
        if (npcId === MAXIMILIAN) return page('Maximilian', 'Speak with Gentler.');
        if (npcId === MIKI) {
            if (cond === 2) return page('Miki the Cat', 'You brought Gentler’s map.', '<a action="bypass -h quest 32 miki">Give Miki the map.</a>');
            if (cond === 6) return page('Miki the Cat', 'I have a message for Gentler.', '<a action="bypass -h quest 32 message">Receive Miki’s message.</a>');
            return page('Miki the Cat', cond === 3 ? `Keep gathering herbs (${count(state, HERB)}/20).` : 'Return to Gentler.');
        }
        if (cond === 1) return page('Gentler', 'Take this map to Miki.', '<a action="bypass -h quest 32 map">Receive the map.</a>');
        if (cond === 4) return page('Gentler', `You have ${count(state, HERB)}/20 herbs.`, '<a action="bypass -h quest 32 herbs">Hand over the herbs.</a>');
        if (cond === 5) return page('Gentler', `You have ${count(state, SPIRIT_ORE)}/500 Spirit Ore.`, '<a action="bypass -h quest 32 ore">Hand over the ore.</a>');
        if (cond === 7) return page('Gentler', 'What did Miki say?', '<a action="bypass -h quest 32 return">Deliver Miki’s message.</a>');
        if (cond === 8) return page('Gentler', 'Which ears would you like?', '<a action="bypass -h quest 32 cat">Cat ears.</a><br><a action="bypass -h quest 32 racoon">Racoon ears.</a><br><a action="bypass -h quest 32 rabbit">Rabbit ears.</a>');
        return page('Gentler', 'Continue your errand for Miki.');
    },
    async onKill(state) {
        if (state.getInt('cond') !== 3) return;
        const current = count(state, HERB); const amount = service().questDropAmount(1, 20, current);
        if (!amount) return;
        await service().giveItem(state.session, HERB, amount); state.playSound(current + amount >= 20 ? SOUND_MIDDLE : SOUND_ITEMGET);
        if (current + amount >= 20) await state.set('cond', 4);
    }
};
