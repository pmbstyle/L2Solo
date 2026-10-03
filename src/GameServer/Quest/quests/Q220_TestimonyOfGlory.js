// Lisvus C4 fdc7e33a / historical C4 37a3ec95, 220_TestimonyOfGlory.
const H = require('../SecondProfessionQuest');
const INITIAL = [[192, 3206], [193, 3206], [550, 3207], [563, 3205]];
const PUNISHMENT = [
    ...[583, 584, 585, 586, 587, 588].map((id, i) => [id, 3219, 50 + i * 10]),
    [601, 3218, 50], [602, 3218, 60]
];
const CHIEFS = [
    { key: 'breka', guide: 7515, npc: 7615, letter: 3228, scepter: 3211, glove: 3223,
        coords: [80100, 119991, -2289], trophies: [[3221, 1], [3222, 1]],
        groups: [[5080, 3221, [[80117, 120039, -2259]]], [5081, 3222, [[80058, 120038, -2259]]]] },
    { key: 'enku', guide: 7515, npc: 7616, letter: 3229, scepter: 3212, glove: 3225,
        coords: [17744, 189834, -3506], trophies: [[3224, 4]],
        groups: [[5082, 3224, [[17710, 189813, -3581], [17674, 189798, -3581], [17770, 189852, -3581], [17803, 189873, -3581]]]] },
    { key: 'vuku', guide: 7501, npc: 7619, letter: 3230, contract: 3233, scepter: 3213,
        coords: [-2150, 124443, -3649], trophies: [[3234, 30]], groups: [] },
    { key: 'turek', guide: 7501, npc: 7617, letter: 3231, scepter: 3214, glove: 3227,
        coords: [-94294, 110818, -3488], trophies: [[3226, 2]],
        groups: [[5083, 3226, [[-94292, 110781, -3701], [-94293, 110861, -3701]]]] },
    { key: 'tunath', guide: 7501, npc: 7618, letter: 3232, scepter: 3215,
        coords: [-55217, 200628, -3649], trophies: [], groups: [] }
];
const NPCS = [7514, 7642, 7515, 7501, ...CHIEFS.map(row => row.npc), 7571, 7565];
const TANTOS = [11839, -106261, -3550];
const SCEPTERS = CHIEFS.map(row => [row.scepter, 1]);
const FIRST_TROPHIES = [[3205, 10], [3206, 10], [3207, 10]];
const eligible = state => state.session.actor.fetchRace() === 3 && state.session.actor.fetchLevel() >= 37
    && [45, 47, 50].includes(state.session.actor.fetchClassId());
const l = (event, label) => H.link(220, event, label);
const quantities = (state, items) => items.map(([id, n]) => `${H.itemName(id)}: ${H.count(state, id)}/${n}`).join('<br>');
function recoverChief(state, chief) {
    for (const [npc, item, positions] of chief.groups) {
        H.spawnGroup(state, npc, positions, positions.length - H.count(state, item));
    }
}

const quest = {
    id: 220, name: 'Testimony of Glory', startNpcs: [7514], npcs: NPCS,
    killNpcs: [...INITIAL.map(row => row[0]), 234, 5080, 5081, 5082, 5083,
        ...PUNISHMENT.map(row => row[0]), 778, 779, 5086],
    questSpawns: [5080, 5081, 5082, 5083, 5086],
    questItems: Array.from({ length: 34 }, (_, n) => 3204 + n),
    radarPoints: [...CHIEFS.map(row => row.coords), ...CHIEFS.flatMap(row => row.groups.flatMap(group => group[2])), TANTOS],
    eventNpc: event => event === 'start' ? 7514 : event === 'handin' ? NPCS
        : event === 'chief' ? CHIEFS.map(row => row.npc) : event === 'recover' ? 7571
            : CHIEFS.find(row => row.key === event)?.guide,
    canTalk: state => state.isStarted() || state.isCompleted() || eligible(state),
    async onTalk(state, npc) {
        if (state.isCompleted()) return H.page(state, 'You have earned the Mark of Glory.');
        if (!state.isStarted()) return H.page(state,
            'Prefect Vokian in Giran asks for ten Manashen Shards, Tyrant Talons and Guardian Basilisk Fangs.', l('start', 'Accept the testimony'));
        const cond = state.getInt('cond'), id = npc.fetchSelfId();
        const actions = [];
        let text;
        if ([1, 2].includes(cond)) {
            text = 'Hunt Manashen Gargoyles near the Ivory Tower, Tyrants in the Wasteland and Guardian Basilisks near the Death Pass. Return to Vokian.<br>'
                + quantities(state, FIRST_TROPHIES);
            if (id === 7514 && cond === 2) actions.push(l('handin', 'Report to Vokian'));
        } else if (cond === 3) {
            text = 'Visit Gandi Chief Chianta in Dion with Vokian\'s second order and the Necklace of Authority.';
            if (id === 7642) actions.push(l('handin', 'Speak with Chianta'));
        } else if (cond === 4) {
            text = 'Obtain five tribal scepters. Seer Manakia in Giran introduces Breka and Enku; Prefect Kasman in Gludin introduces Vuku, Turek and Tunath.<br>'
                + quantities(state, SCEPTERS);
            for (const row of CHIEFS.filter(row => row.guide === id && !H.count(state, row.scepter))) actions.push(l(row.key, `Ask about ${H.npcName(row.npc)}`));
            const chief = CHIEFS.find(row => row.npc === id && !H.count(state, row.scepter));
            if (chief) {
                text += '<br>' + (chief.key === 'vuku' ? 'Hunt Stakato Drones in the Cruma Marshlands.<br>' : '') + quantities(state, chief.trophies);
                if (H.count(state, chief.letter) || (chief.glove && H.count(state, chief.glove))) actions.push(l('chief', chief.glove ? 'Begin or resume the challenge' : 'Speak with the chief'));
                if (chief.trophies.length && H.has(state, chief.trophies)) actions.push(l('handin', 'Claim the tribal scepter'));
            }
        } else if (cond === 5) {
            text = 'Return to Chianta in Dion with all five tribal scepters. You must reach level 38 before punishing the betrayers.';
            if (id === 7642) actions.push(l('handin', 'Report to Chianta'));
        } else if ([6, 7].includes(cond)) {
            text = 'Hunt Timak Orcs near Oren and Tamlin Orcs near the Town of Aden, then return to Chianta.<br>'
                + quantities(state, [[3219, 20], [3218, 20]]);
            if (id === 7642 && cond === 7) actions.push(l('handin', 'Report the punishment'));
        } else if (cond === 8) {
            text = 'Take the Scepter Box to Seer Tanapi in the Orc Village.';
            if (id === 7571) actions.push(l('handin', 'Give Tanapi the box'));
        } else if (cond === 9) {
            text = 'Hunt Ragna Orc Overlords or Seers on the Immortal Plateau to summon the Revenant of Tantos Chief. Defeat it and return to Tanapi.';
            if (id === 7571 && state.get('encounter')) actions.push(l('recover', 'Locate the Revenant again'));
        } else if (cond === 10) {
            text = 'Return the Scepter of Tantos to Tanapi in the Orc Village.';
            if (id === 7571) actions.push(l('handin', 'Return the scepter'));
        } else if (cond === 11) {
            text = 'Bring the Ritual Box to Flame Lord Kakai in the Orc Village.';
            if (id === 7565) actions.push(l('handin', 'Receive the Mark of Glory'));
        }
        return H.page(state, text, actions.join('<br>'));
    },
    async onEvent(state, event) {
        const cond = state.getInt('cond'), npc = state.session.activeNpcTalk.selfId;
        if (event === 'start') {
            if (state.isStarted() || state.isCompleted() || !eligible(state)) return null;
            await H.step(state, 1, { gives: [[3204, 1]] });
        } else {
            if (!state.isStarted()) return null;
            const introduction = CHIEFS.find(row => row.key === event);
            if (introduction && cond === 4 && H.has(state, [[3209, 1], [3210, 1]]) && !H.count(state, introduction.scepter)) {
                if (!H.count(state, introduction.letter) && !H.count(state, introduction.glove || introduction.contract)
                    && !H.has(state, introduction.trophies.length ? introduction.trophies : [[introduction.scepter, 1]])) {
                    await H.step(state, 4, { gives: [[introduction.letter, 1]] });
                }
                state.addRadar(...introduction.coords);
            } else if (event === 'chief' && cond === 4 && H.has(state, [[3209, 1], [3210, 1]])) {
                const chief = CHIEFS.find(row => row.npc === npc);
                if (!chief || H.count(state, chief.scepter)) return null;
                if (H.count(state, chief.letter)) {
                    const gives = [[chief.glove || chief.contract || chief.scepter, 1]];
                    const complete = !chief.trophies.length && CHIEFS.every(row => row === chief || H.count(state, row.scepter));
                    await H.step(state, complete ? 5 : 4, { takes: [[chief.letter, 1]], gives });
                } else if (!chief.glove || !H.count(state, chief.glove)) return null;
                recoverChief(state, chief);
            } else if (event === 'recover' && cond === 9 && H.count(state, 3235) && state.get('encounter')) {
                H.spawn(state, 5086, TANTOS, 300000);
            } else if (event === 'handin') {
                if (cond === 2 && npc === 7514 && H.has(state, [[3204, 1], ...FIRST_TROPHIES])) {
                    await H.step(state, 3, { takes: [[3204, 1], ...FIRST_TROPHIES], gives: [[3208, 1], [3209, 1]] });
                } else if (cond === 3 && npc === 7642 && H.has(state, [[3208, 1], [3209, 1]])) {
                    await H.step(state, 4, { takes: [[3208, 1]], gives: [[3210, 1]] });
                } else if (cond === 4 && H.has(state, [[3209, 1], [3210, 1]])) {
                    const chief = CHIEFS.find(row => row.npc === npc && row.trophies.length);
                    if (!chief || H.count(state, chief.scepter) || !H.has(state, chief.trophies)
                        || (chief.contract && !H.count(state, chief.contract))) return null;
                    const complete = CHIEFS.every(row => row === chief || H.count(state, row.scepter));
                    await H.step(state, complete ? 5 : 4, { takes: [...chief.trophies,
                        ...(chief.contract ? [[chief.contract, 1]] : [])], gives: [[chief.scepter, 1]] });
                    for (const [id] of chief.groups) H.clearSpawns(state, id);
                    state.removeRadar(...chief.coords);
                } else if (cond === 5 && npc === 7642 && H.count(state, 3209)) {
                    const waiting = H.count(state, 3216);
                    if (!waiting && !H.has(state, [[3210, 1], ...SCEPTERS])) return null;
                    if (state.session.actor.fetchLevel() < 38) {
                        if (!waiting) await H.step(state, 5, { takes: [[3210, 1], ...SCEPTERS], gives: [[3216, 1]] });
                        return H.page(state, 'Chianta will give you the next order at level 38.');
                    }
                    await H.step(state, 6, { takes: waiting ? [[3216, 1]] : [[3210, 1], ...SCEPTERS], gives: [[3217, 1]] });
                    H.clearRadars(state);
                } else if (cond === 7 && npc === 7642 && H.has(state, [[3209, 1], [3217, 1], [3218, 20], [3219, 20]])) {
                    await H.step(state, 8, { takes: [[3209, 1], [3217, 1], [3218, 20], [3219, 20]], gives: [[3220, 1]] });
                } else if (cond === 8 && npc === 7571 && H.count(state, 3220)) {
                    await H.step(state, 9, { takes: [[3220, 1]], gives: [[3235, 1]] });
                } else if (cond === 10 && npc === 7571 && H.has(state, [[3235, 1], [3236, 1]])) {
                    await H.step(state, 11, { takes: [[3235, 1], [3236, 1]], gives: [[3237, 1]] });
                } else if (cond === 11 && npc === 7565 && H.count(state, 3237)) {
                    await H.step(state, 0, { status: 'completed', takes: quest.questItems.map(id => [id, H.count(state, id)]),
                        gives: [[3203, 1], [7562, 16]], exp: 91457, sp: 2500 });
                    H.clearSpawns(state); H.clearRadars(state);
                } else return null;
            } else return null;
        }
        return quest.onTalk(state, { fetchSelfId: () => npc });
    },
    async onKill(state, npc) {
        const cond = state.getInt('cond'), id = npc.fetchSelfId();
        if (cond === 9 && H.count(state, 3235) && !H.count(state, 3236)) {
            if ([778, 779].includes(id)) {
                if (!state.get('encounter')) await H.step(state, 9, { variables: { encounter: JSON.stringify(TANTOS) } });
                H.spawn(state, 5086, TANTOS, 300000);
            } else if (id === 5086 && H.owns(state, npc)) {
                await H.step(state, 10, { gives: [[3236, 1]] });
                H.clearSpawns(state, 5086);
            }
            return;
        }
        let item, limit, chance = 100, takes = [], next = cond;
        if (cond === 1 && H.count(state, 3204)) {
            item = INITIAL.find(row => row[0] === id)?.[1]; limit = 10;
            if (item && FIRST_TROPHIES.every(([other, n]) => other === item || H.count(state, other) >= n)) next = 2;
        } else if (cond === 4 && id === 234 && H.count(state, 3233)) {
            item = 3234; limit = 30; chance = 75;
        } else if (cond === 4 && H.owns(state, npc)) {
            const chief = CHIEFS.find(row => row.glove && H.count(state, row.glove) && row.groups.some(group => group[0] === id));
            if (!chief) return;
            const group = chief.groups.find(group => group[0] === id);
            item = group[1]; limit = group[2].length;
            if (chief.trophies.every(([other, n]) => other === item || H.count(state, other) >= n)) takes = [[chief.glove, 1]];
        } else if (cond === 6 && H.count(state, 3217)) {
            const drop = PUNISHMENT.find(row => row[0] === id);
            if (drop) { item = drop[1]; chance = drop[2]; limit = 20; }
            if (item && H.count(state, item === 3218 ? 3219 : 3218) >= 20) next = 7;
        }
        if (!item || H.count(state, item) >= limit || Math.random() * 100 >= chance) return;
        const amount = invoke('GameServer/Quest/QuestService').questDropAmount(1, limit, H.count(state, item));
        if (!amount) return;
        const complete = H.count(state, item) + amount >= limit;
        await H.step(state, complete ? next : cond, { takes: complete ? takes : [], gives: [[item, amount]] });
        if (complete && takes.length) {
            const chief = CHIEFS.find(row => row.glove === takes[0][0]);
            for (const [id] of chief.groups) H.clearSpawns(state, id);
        }
    },
    onAbort: H.abort
};
module.exports = quest;
