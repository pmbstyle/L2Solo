// Lisvus C4 fdc7e33a, 225_TestOfSearcher. Two independent map searches.
const H = require('../SecondProfessionQuest');
const NPCS = [7690, 7291, 7728, 7729, 7420, 7730, 7627, 7628];
const ASSASSIN = [55841, 176464, -2993], CHEST = [10011, 157449, -2374], MAP = [10133, 157155, -2383];
const HANDINS = [
    [1, 7291, 2, [[2784, 1]], [[2785, 1]]], [2, 7728, 3, [[2785, 1]], [[2786, 1]]],
    [4, 7728, 5, [[2786, 1], [2787, 10]], [[2788, 1]]],
    [6, 7728, 7, [[2788, 1], [2789, 1]], [[2790, 1]]],
    [7, 7291, 8, [[2790, 1], [2791, 1]], [[2792, 1], [2793, 1], [2794, 1]]],
    [8, 7729, 9, [[2793, 1]], [[2795, 1]]], [9, 7420, 10, [[2795, 1]], [[2796, 1]]],
    [11, 7420, 12, [[2796, 1], [2797, 10]], [[2798, 1]]],
    [12, 7729, 13, [[2798, 1]], [[2799, 1]]], [13, 7730, 14, [[2799, 1]], [[2800, 1]]],
    [14, 7730, 18, [[2800, 1], [2792, 1], [2803, 1], [2804, 1]], [[2805, 1]]],
    [18, 7627, 20, [[2805, 1]], [[2806, 1]]],
    [20, 7628, 21, [[2806, 1]], [[2807, 20]]],
    [21, 7291, 22, [[2794, 1], [2805, 1], [2807, 20]], [[2808, 1]]],
    [22, 7690, 0, [[2808, 1]], [[2809, 1]]]
];
const eligible = s => [7, 22, 35, 54].includes(s.session.actor.fetchClassId()) && s.session.actor.fetchLevel() >= 39;
const l = (e, text) => H.link(225, e, text);
const quest = {
    id: 225, name: 'Test of the Searcher', startNpcs: [7690], npcs: NPCS,
    killNpcs: [781, 5094, 5093, 555, 551, 144], questSpawns: [5094, 7628], personalNpcs: [7628],
    radarPoints: [ASSASSIN, CHEST, MAP], questItems: Array.from({ length: 25 }, (_, n) => 2784 + n),
    eventNpc: e => e === 'start' ? 7690 : e === 'handin' ? NPCS : e === 'recover' ? 7627 : null,
    canTalk(s, npc) {
        if (npc.fetchSelfId() === 7628) return s.isStarted() && H.owns(s, npc);
        return s.isStarted() || s.isCompleted() || eligible(s);
    },
    async onTalk(s, npc) {
        if (s.isCompleted()) return H.page(s, 'You have earned the Mark of Searcher.');
        if (!s.isStarted()) return H.page(s, 'Luther asks you to help Captain Alex in Floran investigate the Delu Lizardmen.', l('start', 'Accept the test'));
        const cond = s.getInt('cond'), row = HANDINS.find(row => row[0] === cond);
        let text = row ? `Visit ${H.npcName(row[1])}.<br>` + row[3].map(([id, n]) => `${H.itemName(id)}: ${H.count(s, id)}/${n}`).join('<br>')
            : cond === 3 ? `Collect ten Delu Totems from Delu Lizardman Warriors and their Assassins: ${H.count(s, 2787)}/10.`
            : cond === 5 ? 'Defeat Chief Kalkis in the Delu Lizardman camp.'
            : cond === 10 ? `Collect ten Red Spore Dust from Trisalim: ${H.count(s, 2797)}/10.` : '';
        if (cond === 14) text += '<br>Find Solt\'s four map pieces on Road Scavengers and Makel\'s four pieces on Hangman Trees.';
        const actions = [];
        if (row && npc.fetchSelfId() === row[1] && H.has(s, row[3])) actions.push(l('handin', 'Speak and continue the search'));
        if (cond === 20 && npc.fetchSelfId() === 7627) actions.push(l('recover', 'Locate the Strong Wooden Chest again'));
        return H.page(s, text, actions.join('<br>'));
    },
    async onEvent(s, e) {
        if (e === 'start') {
            if (s.isStarted() || s.isCompleted() || !eligible(s)) return null;
            await H.step(s, 1, { gives: [[2784, 1]] });
        } else {
            if (!s.isStarted()) return null;
            const cond = s.getInt('cond');
            if (e === 'recover' && cond === 20 && H.count(s, 2806)) H.spawn(s, 7628, CHEST, 300000);
            else if (e === 'handin') {
                const row = HANDINS.find(row => row[0] === cond && row[1] === s.session.activeNpcTalk.selfId);
                if (!row || !H.has(s, row[3])) return null;
                // The map is shown to the hag and retained for Alex.
                const takes = cond === 18 ? [] : cond === 22 ? quest.questItems.map(id => [id, H.count(s, id)]) : row[3];
                await H.step(s, row[2], { takes, gives: row[4],
                    ...(cond === 13 ? { variables: { soltsMap: '1', makelsMap: '1' } } : {}),
                    ...(cond === 22 ? { status: 'completed', exp: 37831, sp: 18750 } : {}) });
                if (cond === 14) s.addRadar(...MAP);
                if (cond === 18) H.spawn(s, 7628, CHEST, 300000);
                if (cond === 20) H.clearSpawns(s, 7628);
                if (cond === 21 || cond === 22) { H.clearSpawns(s); H.clearRadars(s); }
            } else return null;
        }
        return quest.onTalk(s, { fetchSelfId: () => s.session.activeNpcTalk.selfId });
    },
    async onKill(s, npc) {
        const cond = s.getInt('cond'), id = npc.fetchSelfId();
        if (cond === 3 && [781, 5094].includes(id) && H.count(s, 2786) && (id !== 5094 || H.owns(s, npc))) {
            const amount = invoke('GameServer/Quest/QuestService').questDropAmount(1, 10, H.count(s, 2787));
            if (!amount) return;
            const done = H.count(s, 2787) + amount === 10;
            await H.step(s, done ? 4 : 3, { gives: [[2787, amount]] });
            if (done) H.clearSpawns(s, 5094);
            else if (id === 781 && Math.random() < .3) H.spawn(s, 5094, ASSASSIN, 300000);
        } else if (cond === 5 && id === 5093 && H.count(s, 2788))
            await H.step(s, 6, { gives: [[2789, 1], [2791, 1]] });
        else if (cond === 10 && id === 555 && H.count(s, 2796)) {
            const amount = invoke('GameServer/Quest/QuestService').questDropAmount(1, 10, H.count(s, 2797));
            if (amount) await H.step(s, H.count(s, 2797) + amount === 10 ? 11 : 10, { gives: [[2797, amount]] });
        } else if (cond === 14 && [551, 144].includes(id) && Math.random() < .5) {
            const key = id === 551 ? 'soltsMap' : 'makelsMap', item = id === 551 ? 2801 : 2802, map = id === 551 ? 2803 : 2804;
            if (s.getInt(key) !== 1) return;
            const count = H.count(s, item), done = count === 3;
            await H.step(s, cond, done ? { takes: [[item, count]], gives: [[map, 1]], variables: { [key]: '2' } } : { gives: [[item, 1]] });
        }
    },
    onAbort: H.abort
};
module.exports = quest;
