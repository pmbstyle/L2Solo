// Lisvus C4 fdc7e33a Q211; historical C4 37a3ec95 awards 8 diamonds once.
const H = require('../SecondProfessionQuest');
const CLASSES = [1, 19, 32, 45, 47];
const CHEST = 7647, RALDO = 7646;
const QUEST_ITEMS = [2628, 2629, 2630, 2631, 2632];
const eligible = state => state.session.actor.fetchLevel() >= 35
    && CLASSES.includes(state.session.actor.fetchClassId());
const l = (event, label) => H.link(211, event, label);

function encounter(state) {
    const cond = state.getInt('cond');
    const id = cond === 2 && H.count(state, 2632) ? CHEST : [7, 10].includes(cond) ? RALDO : 0;
    if (!id) return null;
    const saved = JSON.parse(state.get('encounter', 'null'));
    return saved && H.spawn(state, id, saved);
}

const quest = {
    id: 211, name: 'Trial of Challenger', startNpcs: [7644],
    npcs: [7644, 7645, 7535, RALDO, CHEST], killNpcs: [5110, 5112, 5113, 5114],
    personalNpcs: [RALDO, CHEST],
    questSpawns: [RALDO, CHEST],
    radarPoints: [[176560, -184969, -3729]],
    questItems: QUEST_ITEMS,
    eventNpc: event => ({ start: 7644, recover: [7644, 7645, 7535], open: CHEST,
        letter: 7644, martien: 7645, eye: 7645, raldo: RALDO, filaur: 7535, finish: RALDO })[event],
    canTalk(state, npc) {
        if ([CHEST, RALDO].includes(npc.fetchSelfId())) return state.isStarted() && H.owns(state, npc);
        return state.isStarted() || state.isCompleted() || eligible(state);
    },
    async onTalk(state, npc) {
        if (state.isCompleted()) return H.page(state, 'You have already earned the Mark of Challenger.');
        if (!state.isStarted()) return H.page(state,
            'Kash asks you to defeat Shyslassys in the waterfall cave west of the Town of Dion and open her chest.', l('start', 'Accept the trial'));
        const cond = state.getInt('cond'), id = npc.fetchSelfId();
        const actions = [];
        if (id === CHEST && cond === 2 && H.count(state, 2632)) actions.push(l('open', 'Open the chest with the broken key'));
        if (id === 7644 && cond === 2 && H.count(state, 2631)) actions.push(l('letter', 'Show Kash the scroll'));
        if (id === 7645 && cond === 3) actions.push(l('martien', 'Give Martien the letter'));
        if (id === 7645 && cond === 5) actions.push(l('eye', 'Give Martien the first watcher eye'));
        if (id === RALDO && cond === 7) actions.push(l('raldo', 'Listen to Raldo and give him the second eye'));
        if (id === 7535 && [7, 8].includes(cond)) actions.push(l('filaur', 'Ask Filaur about the Mithril Mines'));
        if (id === RALDO && cond === 10) actions.push(l('finish', 'Report the death of the Succubus Queen'));
        if ([7644, 7645, 7535].includes(id) && [2, 7, 10].includes(cond) && state.get('encounter')) {
            actions.push(l('recover', 'Locate the chest or Raldo again'));
        }
        const instructions = {
            1: 'Defeat Shyslassys in the cave west of Dion.',
            2: H.count(state, 2631) ? 'Bring the scroll to Kash in Dion.' : 'Open the chest left by Shyslassys.',
            3: 'Take Kash\'s letter to Martien in Giran.', 4: 'Defeat Gorr in the cave near Floran.',
            5: 'Bring the first watcher eye to Martien in Giran.', 6: 'Defeat Baraham in the cave near Floran.',
            7: 'Speak with Raldo, then visit Elder Filaur in the Dwarven Village at level 36.',
            8: 'Visit Elder Filaur in the Dwarven Village for directions.',
            9: 'Defeat the Succubus Queen in the Mithril Mines.', 10: 'Speak with Raldo at the Mithril Mines.'
        };
        return H.page(state, instructions[cond], actions.join('<br>'));
    },
    async onEvent(state, event) {
        if (event === 'start') {
            if (state.isStarted() || state.isCompleted() || !eligible(state)) return null;
            await H.step(state, 1);
        } else {
            if (!state.isStarted()) return null;
            const cond = state.getInt('cond');
            if (event === 'recover') {
                const npc = encounter(state);
                return H.page(state, npc ? 'Follow the radar to your encounter.' : 'There is no encounter to recover.');
            }
            if (event === 'open' && cond === 2 && H.has(state, [[2632, 1]]) && !H.count(state, 2631)) {
                const rewards = [[2631, 1]];
                if (Math.random() < .2) {
                    const n = Math.floor(Math.random() * 100);
                    rewards.push(...(n > 90 ? [2918, 2927, 1943, 1946, 1940] : n > 70 ? [2030, 1904]
                        : n > 40 ? [1936] : [1940]).map(id => [id, 1]));
                } else rewards.push([57, Math.max(1, Math.round((Math.floor(Math.random() * 1000) + 1)
                    * invoke('GameServer/Quest/QuestService').questRates().questAdena))]);
                await H.step(state, 2, { takes: [[2632, 1]], gives: rewards });
                H.clearSpawns(state, CHEST);
            } else if (event === 'letter' && cond === 2 && H.has(state, [[2631, 1]])) {
                await H.step(state, 3, { takes: [[2631, 1]], gives: [[2628, 1]] });
            } else if (event === 'martien' && cond === 3 && H.has(state, [[2628, 1]])) {
                await H.step(state, 4, { takes: [[2628, 1]] });
            } else if (event === 'eye' && cond === 5 && H.has(state, [[2629, 1]])) {
                await H.step(state, 6, { takes: [[2629, 1]] });
            } else if (event === 'raldo' && cond === 7 && H.has(state, [[2630, 1]])) {
                await H.step(state, 8, { takes: [[2630, 1]] });
                H.clearSpawns(state, RALDO);
            } else if (event === 'filaur' && [7, 8].includes(cond)) {
                if (state.session.actor.fetchLevel() < 36) return H.page(state, 'Return to Filaur at level 36.');
                // Taking the direct Filaur branch still retires the second eye.
                await H.step(state, cond === 7 ? 8 : 9, { takes: [[2630, H.count(state, 2630)]] });
                H.clearSpawns(state, RALDO);
                state.addRadar(176560, -184969, -3729);
            } else if (event === 'finish' && cond === 10) {
                await H.step(state, 0, { status: 'completed', takes: QUEST_ITEMS.map(id => [id, H.count(state, id)]),
                    gives: [[2627, 1], [7562, 8]], exp: 72394, sp: 11250 });
                H.clearSpawns(state);
                H.clearRadars(state);
                return H.page(state, 'You have earned the Mark of Challenger.');
            } else return null;
        }
        const npcId = state.session.activeNpcTalk.selfId;
        return quest.onTalk(state, { fetchSelfId: () => npcId });
    },
    async onKill(state, npc) {
        const cond = state.getInt('cond'), id = npc.fetchSelfId();
        if (id === 5110 && cond === 1) {
            const coords = H.coords(npc, [0, 0, 0]);
            await H.step(state, 2, { gives: [[2632, 1]], variables: { encounter: JSON.stringify(coords) } });
            encounter(state);
        } else if (id === 5112 && cond === 4) await H.step(state, 5, { gives: [[2629, 1]] });
        else if (id === 5113 && cond === 6) {
            const coords = H.coords(npc, [21291, 184673, -3313]);
            await H.step(state, 7, { gives: [[2630, 1]], variables: { encounter: JSON.stringify(coords) } });
            encounter(state);
        } else if (id === 5114 && cond === 9) {
            const coords = H.coords(npc, [176643, -185803, -3677]);
            await H.step(state, 10, { variables: { encounter: JSON.stringify(coords) } });
            encounter(state);
        }
    },
    onAbort: H.abort
};
module.exports = quest;
