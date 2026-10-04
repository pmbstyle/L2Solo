// Lisvus C4 fdc7e33a, 221_TestimonyOfProsperity. Independent first-ring tasks.
const H = require('../SecondProfessionQuest');
const NPCS = [7104, 7531, 7532, 7533, 7534, 7535, 7536, 7517, 7519, 7553, 7554, 7555, 7556, 7597, 7005, 7368, 7466, 7620, 7621, 7622];
const RECEIPTS = [3258, 3259, 3260, 3261, 3262];
const NOTICES = [3247, 3248, 3249, 3250, 3251];
const DROPS = [[1, 223, 3265, 20, .3], [1, 154, 3265, 20, .6], [1, 155, 3265, 20, .8], [1, 156, 3265, 20, 1], [1, 228, 3266, 10, 1],
    [5, 157, 3273, 20, .2], [5, 230, 3273, 20, .3], [5, 232, 3273, 20, .5], [5, 234, 3273, 20, .6], [5, 231, 3274, 20, .5], [5, 233, 3275, 20, .5]];
const eligible = s => s.session.actor.fetchRace() === 4 && s.session.actor.fetchLevel() >= 37;
const l = (e, text) => H.link(221, e, text);

function handin(s, npc) {
    const cond = s.getInt('cond'), has = id => H.count(s, id) > 0;
    const row = (takes, gives, next = cond) => ({ takes, gives, next });
    if (cond === 1 && has(3239)) {
        if (npc === 7104) return row([[3239, 1], [3241, 1], [3242, 1], [3243, 1], [3244, 1]], [[3240, 1], [3269, 1]], 3);
        if (npc === 7531 && !has(3241)) return has(3246)
            ? row([[3246, 1], ...RECEIPTS.map(id => [id, 1])], [[3241, 1]])
            : row([], [[3246, 1], ...NOTICES.map(id => [id, 1])]);
        if (has(3246)) {
            const elder = [7532, 7533, 7534, 7535, 7536].indexOf(npc);
            if (elder >= 0 && !has(RECEIPTS[elder])) {
                if (has(NOTICES[elder])) return row([[NOTICES[elder], 1]], []);
                const contribution = [[[3252, 1]], [[3253, 1], [3254, 1]], [[3263, 1], [57, 5000]], [[3257, 1]], [[3256, 1]]][elder];
                return row(contribution, [[RECEIPTS[elder], 1]]);
            }
            const ready = index => !has(NOTICES[index]) && !has(RECEIPTS[index]);
            if (npc === 7517 && ready(0) && !has(3252)) return row([], [[3252, 1]]);
            if (npc === 7519 && ready(1) && !has(3253)) return row([], [[3253, 1]]);
            if (npc === 7553 && ready(1) && !has(3254)) return has(3255)
                ? row([[3255, 1], [1867, 100]], [[3254, 1]]) : row([], [[3255, 1]]);
            if (npc === 7555 && ready(2) && !has(3263)) return row([], [[3263, 1]]);
            if (npc === 7554 && ready(3) && !has(3257)) return row([], [[3257, 1]]);
            if (npc === 7556 && ready(4) && !has(3256)) return row([], [[3256, 1]]);
        }
        if (npc === 7597 && !has(3242)) return row([], [[3242, 1]]);
        if (npc === 7005 && !has(3244) && !has(3428)) return row([], [[3428, 1]]);
        if (npc === 7368 && !has(3244)) return row([[3428, 1]], [[3244, 1]]);
        if (npc === 7466 && !has(3243) && !has(3267)) return has(3264)
            ? row([[3264, 1], [3265, 20], [3266, 10]], [[3267, 1]]) : row([], [[3264, 1]]);
        if (npc === 7620 && !has(3243)) return row([[3267, 1]], [[3243, 1]]);
    }
    if (cond === 2 && npc === 7104) return row([[3268, 1]], [[3240, 1], [3269, 1]], 3);
    if (cond === 3 && npc === 7621) return row([], [[3270, 1]], 4);
    if (cond === 4 && npc === 7622 && has(3270)) return row([[3270, 1]], [[3271, 1]]);
    if (cond === 4 && npc === 7621) return row([[3271, 1], [3269, 1]], [[3272, 1], [3023, 1]], 5);
    if (cond === 5 && npc === 7622) return { ...row([[3030, 1], [3272, 1]], [[3245, 1]], 6), removeRecipes: [314] };
    if (cond === 6 && npc === 7104) return row([[3240, 1], [3245, 1]], [[3238, 1], [7562, 16]], 0);
    return null;
}

const quest = {
    id: 221, name: 'Testimony of Prosperity', startNpcs: [7104], npcs: NPCS,
    clientCondition: () => 1, // C4's item-driven testimony retains cond 1.
    killNpcs: [...new Set(DROPS.map(row => row[1]))], questRecipes: [314],
    questItems: [3023, 3030, 3428, ...Array.from({ length: 37 }, (_, n) => 3239 + n)],
    eventNpc: e => e === 'start' ? 7104 : e === 'handin' ? NPCS : null,
    canTalk: s => s.isStarted() || s.isCompleted() || eligible(s),
    async onTalk(s, npc) {
        if (s.isCompleted()) return H.page(s, 'You have earned the Mark of Prosperity.');
        if (!s.isStarted()) return H.page(s, 'Parman asks for proof of wealth, fertility, abundance and health.', l('start', 'Accept the testimony'));
        const row = handin(s, npc.fetchSelfId());
        const text = s.getInt('cond') === 1 ? 'Gather the Old Account Book from Lockirin, Blessed Seed from Piotur, Recipe of Emilly through Bright, and Elven Wafer through Guard Alvah and Lilith.<br>'
            + 'Collect guild contributions from Chali, Mion, Maryse (100 Animal Skins), Torocco (5000 adena), Bolter and Toma. Visit the five elders with Lockirin\'s notices first.<br>'
            + `Mandragora Petals: ${H.count(s, 3265)}/20; Crimson Moss from Giant Crimson Ants: ${H.count(s, 3266)}/10.`
            : s.getInt('cond') === 2 ? 'Return to Parman at level 38.'
            : s.getInt('cond') === 3 ? 'Visit Nikola near Cruma Tower.'
            : s.getInt('cond') === 4 ? 'Use Nikola\'s Clay Dough on the Box of Titan, then return the keyhole pattern to Nikola.'
            : s.getInt('cond') === 5 ? 'Craft the Titan Key and open the Box of Titan. It requires 20 Stakato Shells, 10 Toad Lord Sacs, 10 Spider Thorns and 10 D-grade Crystals.' : 'Return the Maphr Tablet Fragment to Parman.';
        return H.page(s, text + (row?.takes.length ? '<br>' + row.takes.map(([id, n]) => `${H.itemName(id)}: ${H.count(s, id)}/${n}`).join('<br>') : ''),
            row && H.has(s, row.takes) ? l('handin', 'Speak and continue the testimony') : '');
    },
    async onEvent(s, e) {
        if (e === 'start') {
            if (s.isStarted() || s.isCompleted() || !eligible(s)) return null;
            await H.step(s, 1, { gives: [[3239, 1]] });
        } else if (e === 'handin' && s.isStarted()) {
            const row = handin(s, s.session.activeNpcTalk.selfId), cond = s.getInt('cond');
            if (!row || !H.has(s, row.takes)) return null;
            if (cond === 2 && s.session.actor.fetchLevel() < 38) return H.page(s, 'Return to Parman at level 38.');
            if (cond === 1 && s.session.activeNpcTalk.selfId === 7104 && s.session.actor.fetchLevel() < 38) {
                row.next = 2; row.gives = [[3268, 1]];
            }
            const finish = cond === 6;
            const takes = finish ? quest.questItems.map(id => [id, H.count(s, id)]) : row.takes;
            // Registered recipes consume their scroll; retire remaining copies and reagents too.
            if (cond === 5) takes.push(...[3023, 3273, 3274, 3275].map(id => [id, H.count(s, id)]));
            await H.step(s, row.next, { ...row, takes, ...(finish ? { status: 'completed', exp: 12969, sp: 1000, removeRecipes: [314] } : {}) });
        } else return null;
        return quest.onTalk(s, { fetchSelfId: () => s.session.activeNpcTalk.selfId });
    },
    async onKill(s, npc) {
        const cond = s.getInt('cond');
        const ring = H.count(s, 3239) ? 1 : H.count(s, 3240) ? 5 : 0;
        const row = DROPS.find(row => row[0] === ring && row[1] === npc.fetchSelfId());
        if (!row || Math.random() >= row[4]) return;
        const amount = invoke('GameServer/Quest/QuestService').questDropAmount(1, row[3], H.count(s, row[2]));
        if (amount) await H.step(s, cond, { gives: [[row[2], amount]] });
    },
    onAbort: H.abort
};
module.exports = quest;
