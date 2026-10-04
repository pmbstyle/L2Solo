// Lisvus C4 fdc7e33a, 233_TestOfWarspirit. Four independent ancestral trials.
const H = require('../SecondProfessionQuest');
const TONAR = [2889, 2890, 2891, 2892, 2893], HERMODT = [2897, 2898, 2899, 2900], KIRUNA = [2905, 2906, 2907, 2908, 2909];
const REMAINS = [2887, 2894, 2901, 2910], FINAL = [2882, 2911, 2912, 2913, 2914];
const STEPS = [
    ['Orim', 1, 7630, 2, [], [[2883, 1]]],
    ['Orim', 5, 7630, 6, [[2883, 1], [2884, 10], [2885, 10], [2886, 10]], [[2887, 1]]],
    ['Perkiron', 1, 7682, 2, [], [[2888, 1]]],
    ['Perkiron', 7, 7682, 8, [[2888, 1], ...TONAR.map(i => [i, 1])], [[2894, 1]]],
    ['Manakia', 1, 7515, 2, [], [[2895, 1]]],
    ['Manakia', 6, 7515, 7, [[2895, 1], [2896, 1], ...HERMODT.map(i => [i, 1])], [[2901, 1]]],
    ['Racoy', 1, 7507, 2, [], [[2902, 1]]],
    ['Racoy', 2, 7030, 3, [], [[2903, 1]]],
    ['Racoy', 3, 7436, 4, [[2903, 1]], [[2904, 1]]],
    ['Racoy', 10, 7507, 11, [[2902, 1], [2904, 1], ...KIRUNA.map(i => [i, 1])], [[2910, 1]]]
];
const eligible = s => s.session.actor.fetchClassId() === 50 && s.session.actor.fetchRace() === 3 && s.session.actor.fetchLevel() >= 39;
const l = (e, label) => H.link(233, e, label);
const positions = center => [[0, 0], [-40, -40], [40, -40], [-40, 40], [40, 40]].map(([x, y]) => [center[0] + x, center[1] + y, center[2]]);
function recover(s) {
    if (s.get('encounter') && H.count(s, 2895) && H.count(s, 2896) && !H.has(s, HERMODT.map(i => [i, 1]))) {
        H.spawnGroup(s, 158, positions(JSON.parse(s.get('encounter'))), 5);
    }
}
function clearEncounter(s, saved = s.get('encounter')) {
    H.clearSpawns(s, 158);
    if (saved) for (const point of positions(JSON.parse(saved))) s.removeRadar(...point);
}
const quest = {
    id: 233, name: 'Test of the War Spirit', startNpcs: [7510], npcs: [7030, 7436, 7507, 7510, 7515, 7630, 7649, 7682],
    killNpcs: [213, 214, 215, 601, 602, 5108, 581, 582, 158, 89, 90], questSpawns: [158],
    questItems: Array.from({ length: 35 }, (_, n) => 2880 + n),
    eventNpc: e => e === 'start' ? 7510 : e === 'handin' ? quest.npcs : e === 'recover' ? 7515 : null,
    canTalk: s => s.isStarted() || s.isCompleted() || eligible(s),
    async onTalk(s, npc) {
        if (s.isCompleted()) return H.page(s, 'You have earned the Mark of Warspirit.');
        if (!s.isStarted()) return H.page(s, 'Seer Somak in Dion sends you to Orim, Pekiron, Manakia and Racoy to recover four heroes\' remains.', l('start', 'Accept the test'));
        const cond = s.getInt('cond'), id = npc.fetchSelfId(), actions = [];
        let text;
        if (cond <= 2) {
            text = 'Orim: Porta, Excuro and Mordeo in Cruma Tower.<br>Pekiron: Leto Lizardman Shamans and Overlords near Oren.<br>'
                + 'Manakia: Medusas and Stenoa Gorgon Queen near Giran.<br>Racoy: speak to Vivyan and Sarien, then hunt Noble Ants in the Wasteland.<br>'
                + REMAINS.map(i => `${H.itemName(i)}: ${H.count(s, i)}/1`).join('<br>');
            const row = STEPS.find(r => r[2] === id && s.getInt(r[0]) === r[1]);
            if (row) {
                text += '<br>Bring:<br>' + (row[4].map(([i, n]) => `${H.itemName(i)}: ${H.count(s, i)}/${n}`).join('<br>') || 'Speak to receive your instructions.');
                if (H.has(s, row[4])) actions.push(l('handin', 'Speak and continue this hero\'s trial'));
            }
            const hunts = { 7630: [[2884, 10], [2885, 10], [2886, 10]], 7682: TONAR.map(i => [i, 1]),
                7515: [[2896, 1], ...HERMODT.map(i => [i, 1])], 7507: KIRUNA.map(i => [i, 1]) };
            if (hunts[id]) text += '<br>' + hunts[id].map(([i, n]) => `${H.itemName(i)}: ${H.count(s, i)}/${n}`).join('<br>');
            if (id === 7510 && cond === 2) actions.push(l('handin', 'Bring all four heroes\' remains to Somak'));
            if (id === 7515 && s.get('encounter') && H.count(s, 2895) && H.count(s, 2896) && !H.has(s, HERMODT.map(i => [i, 1]))) actions.push(l('recover', 'Locate the queen\'s Medusas again'));
        } else if (cond <= 4) {
            text = `Hunt Tamlin Orcs near Hunters Village. Bring thirteen heads to Somak (${H.count(s, 2881)}/13).`;
            if (id === 7510 && cond === 4) actions.push(l('handin', 'Prepare the Warspirit Totem'));
        } else {
            text = 'Bring the Warspirit Totem and the four purified remains to Martankus in the Cave of Trials.';
            if (id === 7649 && H.has(s, FINAL.map(i => [i, 1]))) actions.push(l('handin', 'Receive the Mark of Warspirit'));
        }
        return H.page(s, text, actions.join('<br>'));
    },
    async onEvent(s, e) {
        const cond = s.getInt('cond'), id = s.session.activeNpcTalk.selfId;
        if (e === 'start') {
            if (s.isStarted() || s.isCompleted() || !eligible(s)) return null;
            await H.step(s, 1, { variables: { progress: 'PART1', step: '1', Orim: '1', Perkiron: '1', Manakia: '1', Manakia_Queen: '1', Racoy: '1' } });
        } else {
            if (!s.isStarted()) return null;
            if (e === 'recover' && cond <= 2 && s.get('encounter') && H.count(s, 2895) && H.count(s, 2896) && !H.has(s, HERMODT.map(i => [i, 1]))) recover(s);
            else if (e === 'handin' && cond <= 2) {
                if (id === 7510 && cond === 2 && H.has(s, REMAINS.map(i => [i, 1]))) {
                    await H.step(s, 3, { takes: REMAINS.map(i => [i, 1]), gives: [[2880, 1]], variables: { progress: 'PART2' } });
                    clearEncounter(s);
                } else {
                    const row = STEPS.find(r => r[2] === id && r[1] === s.getInt(r[0]));
                    if (!row || !H.has(s, row[4])) return null;
                    const done = row[5].some(([i]) => REMAINS.includes(i)) && REMAINS.every(i => row[5].some(([given]) => given === i) || H.count(s, i));
                    await H.step(s, done ? 2 : 1, { takes: row[4], gives: row[5], variables: { [row[0]]: String(row[3]),
                        ...(row[0] === 'Manakia' && row[1] === 1 ? { Manakia_Queen: '2' } : {}) } });
                    if (row[0] === 'Manakia' && row[3] === 7) clearEncounter(s);
                }
            } else if (e === 'handin' && cond === 4 && id === 7510 && H.has(s, [[2880, 1], [2881, 13]])) {
                await H.step(s, 5, { takes: [[2880, 1], [2881, 13]], gives: FINAL.map(i => [i, 1]), variables: { step: '3' } });
            } else if (e === 'handin' && cond === 5 && id === 7649 && H.has(s, FINAL.map(i => [i, 1]))) {
                await H.step(s, 0, { status: 'completed', takes: quest.questItems.map(i => [i, H.count(s, i)]), gives: [[2879, 1]], exp: 63483, sp: 17500 });
                clearEncounter(s); H.clearRadars(s);
            } else return null;
        }
        return quest.onTalk(s, { fetchSelfId: () => id });
    },
    async onKill(s, npc) {
        const id = npc.fetchSelfId(), cond = s.getInt('cond');
        if ([3, 4].includes(cond) && [601, 602].includes(id) && H.count(s, 2880) && H.count(s, 2881) < 13 && Math.floor(Math.random() * 100) < 50) {
            await H.step(s, H.count(s, 2881) === 12 ? 4 : 3, { gives: [[2881, 1]], variables: H.count(s, 2881) === 12 ? { step: '2' } : {} });
            return;
        }
        if (cond > 2) return;
        if ([213, 214, 215].includes(id) && [2, 3, 4].includes(s.getInt('Orim')) && H.count(s, 2883)) {
            const item = { 213: 2884, 214: 2885, 215: 2886 }[id], current = H.count(s, item);
            // Executable C4 source awards five scales/talons, one Porta eye.
            const amount = Math.min(id === 213 ? 1 : 5, 10 - current);
            if (amount > 0) await H.step(s, 1, { gives: [[item, amount]], variables: current + amount === 10 ? { Orim: String(s.getInt('Orim') + 1) } : {} });
        } else if ([581, 582].includes(id) && s.getInt('Perkiron') >= 2 && s.getInt('Perkiron') <= 6 && H.count(s, 2888) && Math.floor(Math.random() * 100) < 50) {
            const missing = TONAR.filter(i => !H.count(s, i));
            if (missing.length) await H.step(s, 1, { gives: missing.map(i => [i, 1]), variables: { Perkiron: '7' } });
        } else if (id === 158 && s.getInt('Manakia') >= 2 && s.getInt('Manakia') <= 5 && H.count(s, 2895) && Math.floor(Math.random() * 100) < 50) {
            const missing = HERMODT.filter(i => !H.count(s, i));
            if (missing.length) { await H.step(s, 1, { gives: missing.map(i => [i, 1]), variables: { Manakia: '6' } }); clearEncounter(s); }
        } else if (id === 5108 && s.getInt('Manakia_Queen') === 2 && H.count(s, 2895) && !H.count(s, 2896)) {
            const center = H.coords(npc, [s.session.actor.locX || 0, s.session.actor.locY || 0, s.session.actor.locZ || 0]);
            await H.step(s, 1, { gives: [[2896, 1]], variables: { Manakia_Queen: '3', encounter: JSON.stringify(center) } });
            H.spawnGroup(s, 158, positions(center), 5);
        } else if ([89, 90].includes(id) && s.getInt('Racoy') >= 4 && s.getInt('Racoy') <= 9 && H.has(s, [[2902, 1], [2904, 1]])) {
            const groups = [[[2909, 2908], 70, 6], [[2907, 2906], 40, 8], [[2905], 10, 10]];
            const group = groups.find(([items]) => items.some(i => !H.count(s, i)));
            if (group && Math.floor(Math.random() * 100) <= group[1]) await H.step(s, 1, { gives: group[0].filter(i => !H.count(s, i)).map(i => [i, 1]), variables: { Racoy: String(group[2]) } });
        }
    },
    async onAbort(s) { const saved = s.get('encounter'); await H.abort(s); clearEncounter(s, saved); }
};
module.exports = quest;
