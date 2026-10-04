// Lisvus C4 fdc7e33a, 219_TestimonyOfFate. Native C4 NPC/item ids.
const H = require('../SecondProfessionQuest');
const NPCS = [7476, 7614, 7463, 7613, 7114, 7210, 7358, 7419, 12084, 12089];
const ALDER = [78977, 149036, -3597];
const INGREDIENTS = Array.from({ length: 5 }, (_, n) => 3178 + n);
const SKULLS = Array.from({ length: 4 }, (_, n) => 3194 + n);
const HANDINS = [
    [1, 7614, 2, [[3173, 1]], [[3174, 1]]],
    [3, 7614, 4, [[3175, 1]], [[3176, 1]]],
    [4, 7463, 5, [[3176, 1]], [[3177, 1]]],
    [5, 7463, 6, [[3177, 1], ...INGREDIENTS.map(id => [id, 10])], [[3183, 1]]],
    [6, 7614, 7, [[3183, 1]], [[3184, 1]]],
    [7, 7476, 8, [[3184, 1]], [[3185, 1]]],
    [8, 7114, 9, [[3185, 1]], [[3186, 1]]],
    [9, 7210, 10, [[3186, 1]], [[3187, 1]]],
    [10, 7476, 12, [[3187, 1]], [[3189, 1]]],
    [11, 7476, 12, [[3188, 1]], [[3189, 1]]],
    [12, 7358, 13, [[3189, 1]], [[3190, 1], [3191, 1]]],
    [13, 7419, 14, [[3191, 1]], [[3192, 1]]],
    [14, 7419, 15, [[3192, 1], [3198, 1], [3201, 1]], [[1246, 1]]],
    [15, 7358, 0, [[3190, 1], [1246, 1]], [[3172, 1], [7562, 16]]]
];
const DROPS = [[158, 3178, .5], [233, 3179, .5], [202, 3180, .5],
    [192, 3181, .5], [193, 3181, .6], [230, 3182, .3], [157, 3182, .4], [232, 3182, .5], [234, 3182, .6]];
const TROPHIES = [[554, 3194], [600, 3195], [270, 3196], [582, 3197]];
const eligible = state => state.session.actor.fetchRace() === 2 && state.session.actor.fetchLevel() >= 37;
const l = (event, label) => H.link(219, event, label);

const quest = {
    id: 219, name: 'Testimony of Fate', startNpcs: [7476], npcs: NPCS,
    killNpcs: [144, ...DROPS.map(row => row[0]), ...TROPHIES.map(row => row[0]), 5079],
    personalNpcs: [7613], questSpawns: [7613], radarPoints: [ALDER],
    questItems: [1246, ...Array.from({ length: 29 }, (_, n) => 3173 + n)],
    eventNpc: event => ({ start: 7476, handin: NPCS.filter(id => id !== 7613), recover: 7476,
        pixy: 12084, dust: 12084, treant: 12089, sap: 12089 })[event],
    canTalk(state, npc) {
        if (npc.fetchSelfId() === 7613) return state.isStarted() && H.owns(state, npc);
        return state.isStarted() || state.isCompleted() || eligible(state);
    },
    async onTalk(state, npc) {
        if (state.isCompleted()) return H.page(state, 'You have earned the Mark of Fate.');
        if (!state.isStarted()) return H.page(state,
            'Kaira asks you to discover the truth about Shilen. Visit Metheus in Giran with her letter.', l('start', 'Accept the testimony'));
        const cond = state.getInt('cond'), npcId = npc.fetchSelfId();
        if (npcId === 7613 && cond === 8) return H.page(state,
            'Alder asks you to visit Sorceress Roa in Giran. Tell her: Even though you cover it with your hands, the moon still shines.');
        const row = HANDINS.find(row => row[0] === cond), actions = [];
        if (row && npcId === row[1] && H.has(state, row[3])) actions.push(l('handin',
            cond === 8 ? 'Even though you cover it with your hands, the moon still shines' : 'Speak and continue the testimony'));
        if (cond === 8 && npcId === 7476) actions.push(l('recover', 'Locate Alder\'s Spirit again'));
        if (cond === 14 && H.has(state, [[3190, 1], [3192, 1]])) {
            if (npcId === 12084 && !H.count(state, 3198)) {
                if (!H.count(state, 3193)) actions.push(l('pixy', 'Ask the Bloody Pixy for Red Fairy Dust'));
                else if (H.has(state, SKULLS.map(id => [id, 10]))) actions.push(l('dust', 'Give the four kinds of skulls'));
            }
            if (npcId === 12089 && !H.count(state, 3201)) {
                if (!H.count(state, 3199)) actions.push(l('treant', 'Ask the Blight Treant for Timiriran Sap'));
                else if (H.count(state, 3200)) actions.push(l('sap', 'Give the Black Willow Leaf'));
            }
        }
        const text = cond === 2 ? 'Hunt a Hangman Tree to retrieve Kasandra\'s remains, then return to Metheus.'
            : cond === 14 ? 'Arkenia needs Red Fairy Dust from the Bloody Pixy and Timiriran Sap from the Blight Treant in the Dark Elven forest.<br>'
                + [...SKULLS.map(id => `${H.itemName(id)}: ${H.count(state, id)}/10`),
                    `${H.itemName(3200)}: ${H.count(state, 3200)}/1`, `${H.itemName(3198)}: ${H.count(state, 3198)}/1`,
                    `${H.itemName(3201)}: ${H.count(state, 3201)}/1`].join('<br>')
            : row ? `Visit ${H.npcName(row[1])}.<br>`
                + row[3].map(([id, amount]) => `${H.itemName(id)}: ${H.count(state, id)}/${amount}`).join('<br>')
                + (cond === 5 ? '<br>Hunt Medusas, Marsh Spiders, Dead Seekers, Tyrants and Marsh Stakatos for Ixia.' : '')
                + (cond === 8 ? '<br>Speak with Alder\'s Spirit near Kaira to learn Roa\'s family secret.' : '')
                + ([10, 11].includes(cond) ? '<br>Kaira requires level 38 before giving her recommendation.' : '') : '';
        return H.page(state, text, actions.join('<br>'));
    },
    async onEvent(state, event) {
        if (event === 'start') {
            if (state.isStarted() || state.isCompleted() || !eligible(state)) return null;
            await H.step(state, 1, { gives: [[3173, 1]] });
        } else {
            if (!state.isStarted()) return null;
            const cond = state.getInt('cond'), npcId = state.session.activeNpcTalk.selfId;
            if (event === 'recover' && cond === 8 && H.count(state, 3185)) {
                H.spawn(state, 7613, ALDER, 300000);
            } else if (event === 'handin') {
                const row = HANDINS.find(row => row[0] === cond && row[1] === npcId);
                if (!row || !H.has(state, row[3])) return null;
                if ([10, 11].includes(cond) && state.session.actor.fetchLevel() < 38) {
                    if (cond === 10) await H.step(state, 11, { takes: row[3], gives: [[3188, 1]] });
                    return H.page(state, 'Return to Kaira at level 38.');
                }
                const finish = cond === 15;
                await H.step(state, row[2], { takes: finish ? quest.questItems.map(id => [id, H.count(state, id)]) : row[3],
                    gives: row[4], ...(finish ? { status: 'completed', exp: 68183, sp: 1750 } : {}) });
                if (cond === 7) H.spawn(state, 7613, ALDER, 300000);
                if (cond === 8 || finish) { H.clearSpawns(state); H.clearRadars(state); }
            } else if (cond === 14 && H.has(state, [[3190, 1], [3192, 1]])) {
                if (event === 'pixy' && !H.count(state, 3193) && !H.count(state, 3198))
                    await H.step(state, cond, { gives: [[3193, 1]] });
                else if (event === 'treant' && !H.count(state, 3199) && !H.count(state, 3201))
                    await H.step(state, cond, { gives: [[3199, 1]] });
                else if (event === 'dust' && !H.count(state, 3198) && H.has(state, [[3193, 1], ...SKULLS.map(id => [id, 10])]))
                    await H.step(state, cond, { takes: [[3193, 1], ...SKULLS.map(id => [id, 10])], gives: [[3198, 1]] });
                else if (event === 'sap' && !H.count(state, 3201) && H.has(state, [[3199, 1], [3200, 1]]))
                    await H.step(state, cond, { takes: [[3199, 1], [3200, 1]], gives: [[3201, 1]] });
                else return null;
            } else return null;
        }
        return quest.onTalk(state, { fetchSelfId: () => state.session.activeNpcTalk.selfId });
    },
    async onKill(state, npc) {
        const cond = state.getInt('cond'), id = npc.fetchSelfId();
        if (cond === 2 && id === 144 && H.count(state, 3174)) {
            await H.step(state, 3, { takes: [[3174, 1]], gives: [[3175, 1]] });
        } else if (cond === 5 && H.count(state, 3177)) {
            const drop = DROPS.find(row => row[0] === id);
            if (!drop || Math.random() >= drop[2]) return;
            const amount = invoke('GameServer/Quest/QuestService').questDropAmount(1, 10, H.count(state, drop[1]));
            if (amount) await H.step(state, cond, { gives: [[drop[1], amount]] });
        } else if (cond === 14 && H.has(state, [[3190, 1], [3192, 1]])) {
            if (id === 5079 && H.count(state, 3199) && !H.count(state, 3200) && !H.count(state, 3201))
                await H.step(state, cond, { gives: [[3200, 1]] });
            else if (H.count(state, 3193) && !H.count(state, 3198)) {
                const row = TROPHIES.find(row => row[0] === id);
                if (!row) return;
                const amount = invoke('GameServer/Quest/QuestService').questDropAmount(1, 10, H.count(state, row[1]));
                if (amount) await H.step(state, cond, { gives: [[row[1], amount]] });
            }
        }
    },
    onAbort: H.abort
};
module.exports = quest;
