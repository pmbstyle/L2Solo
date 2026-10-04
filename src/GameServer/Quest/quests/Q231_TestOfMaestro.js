// Lisvus C4 fdc7e33a, 231_TestOfMaestro. Recommendations can be earned in any order.
const H = require('../SecondProfessionQuest');
const NPCS = [7531, 7532, 7533, 7535, 7536, 7556, 7671, 7672, 7673, 7675];
const HANDINS = [
    [2, 7671, 3, [], [[2869, 1]]], [3, 7675, 4, [], []],
    [5, 7671, 6, [[2869, 1], [2870, 1]], [[2868, 1]]], [6, 7533, 7, [[2868, 1]], [[2864, 1]]],
    [8, 7556, 9, [[2871, 1]], [[2916, 1]]], [9, 7556, 10, [[2916, 1]], [[2872, 5]]],
    [10, 7536, 11, [[2872, 5]], [[2866, 1]]],
    [12, 7673, 13, [[2873, 1]], [[2875, 1]]],
    [14, 7673, 15, [[2875, 1], [2876, 10], [2877, 10], [2878, 10]], [[2874, 1]]],
    [15, 7535, 16, [[2874, 1]], [[2865, 1]]], [17, 7531, 0, [[2864, 1], [2865, 1], [2866, 1]], [[2867, 1]]]
];
const CHOICES = [[7533, 2864, 2, []], [7536, 2866, 8, [[2871, 1]]], [7535, 2865, 12, [[2873, 1]]]];
const eligible = s => s.session.actor.fetchClassId() === 56 && s.session.actor.fetchLevel() >= 39;
const l = (e, text) => H.link(231, e, text);
const quest = {
    id: 231, name: 'Test of the Maestro', startNpcs: [7531], npcs: NPCS,
    killNpcs: [5133, 225, 229, 233],
    questItems: [2916, ...Array.from({ length: 3 }, (_, n) => 2864 + n), ...Array.from({ length: 11 }, (_, n) => 2868 + n)],
    eventNpc: e => e === 'start' ? 7531 : e === 'handin' ? NPCS : null,
    canTalk: s => s.isStarted() || s.isCompleted() || eligible(s),
    async onTalk(s, npc) {
        if (s.isCompleted()) return H.page(s, 'You have earned the Mark of Maestro.');
        if (!s.isStarted()) return H.page(s, 'Lockirin asks for recommendations from Balanki, Arin and Filaur in the Dwarven Village.', l('start', 'Accept the test'));
        const cond = s.getInt('cond'), row = HANDINS.find(row => row[0] === cond);
        const choice = [1, 7, 11, 16].includes(cond) && CHOICES.find(row => row[0] === npc.fetchSelfId() && !H.count(s, row[1]));
        const text = row ? `Visit ${H.npcName(row[1])}.<br>` + row[3].map(([id, n]) => `${H.itemName(id)}: ${H.count(s, id)}/${n}`).join('<br>')
            : cond === 3 ? 'Visit Jailer Dubabah, then the Corpse of Kamur in the cave.'
            : cond === 4 ? 'Defeat the Evil Eye Lord in the cave to recover Kamur\'s necklace.'
            : cond === 13 ? 'Collect ten each of Weird Bee Needles, Marsh Spider Webs and Leech Blood near Cruma Tower.'
            : 'Choose the next recommendation from Balanki, Arin or Filaur.';
        return H.page(s, text, choice || row && row[1] === npc.fetchSelfId() && H.has(s, row[3]) ? l('handin', 'Speak and continue the test') : '');
    },
    async onEvent(s, e) {
        if (e === 'start') {
            if (s.isStarted() || s.isCompleted() || !eligible(s)) return null;
            await H.step(s, 1);
        } else if (e === 'handin' && s.isStarted()) {
            const cond = s.getInt('cond'), npc = s.session.activeNpcTalk.selfId;
            const choice = [1, 7, 11, 16].includes(cond) && CHOICES.find(row => row[0] === npc && !H.count(s, row[1]));
            if (choice) await H.step(s, choice[2], { gives: choice[3] });
            else {
                const row = HANDINS.find(row => row[0] === cond && row[1] === npc);
                if (!row || !H.has(s, row[3])) return null;
                const complete = row[4].some(([id]) => [2864, 2865, 2866].includes(id))
                    && [2864, 2865, 2866].every(id => H.count(s, id) || row[4].some(([given]) => given === id));
                await H.step(s, complete ? 17 : row[2], { takes: cond === 17 ? quest.questItems.map(id => [id, H.count(s, id)]) : row[3],
                    gives: row[4], ...(cond === 17 ? { status: 'completed', exp: 154499, sp: 37500 } : {}) });
                if (cond === 8) invoke(path.actor).teleportTo(s.session, s.session.actor, { locX: 140352, locY: -194133, locZ: -2028 });
            }
        } else return null;
        return quest.onTalk(s, { fetchSelfId: () => s.session.activeNpcTalk.selfId });
    },
    async onKill(s, npc) {
        const cond = s.getInt('cond'), id = npc.fetchSelfId();
        if (cond === 4 && id === 5133) await H.step(s, 5, { gives: [[2870, 1]] });
        else if (cond === 13 && H.count(s, 2875)) {
            const item = { 225: 2878, 229: 2876, 233: 2877 }[id];
            if (!item) return;
            const amount = invoke('GameServer/Quest/QuestService').questDropAmount(1, 10, H.count(s, item));
            if (amount) await H.step(s, [2876, 2877, 2878].every(i => H.count(s, i) + (i === item ? amount : 0) >= 10) ? 14 : cond, { gives: [[item, amount]] });
        }
    },
    onAbort: H.abort
};
module.exports = quest;
