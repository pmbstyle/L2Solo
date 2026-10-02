// Q333 Black Lion Hunt. Source: l2j-lisvus fdc7e33 333_BlackLionHunt.
//
// Mercenary Sophia (7735) hires holders of the black lion mark (1369, granted
// by Q326) onto one of four fronts; proofs (undead ash 3848, bloody-axe
// insignias 3849, delu fangs 3850, stakato talons 3851) pay 35 per proof with
// lion claws at 20/50/100. Redfoot (7736) opens cargo boxes for 650 adena and
// trades four pieces of useful information. Blacksmith Rupio (7471) restores
// statue and tablet sets at even odds; the Abyssal Celebrant Undrias (7130) and
// the First Elder Lockirin (7531) buy the completed statue resp. tablet for
// 30000; Morgan (7737) accepts cargo boxes for guild coins.
const SOPHIA = 7735;
const REDFOOT = 7736;
const RUPIO = 7471;
const UNDIRAS = 7130;
const LOCKIRIN = 7531;
const MORGAN = 7737;

const MARK = 1369;
const ADENA = 57;
const CARGO_BOX = 3440;
const GUILD_COIN = 3677;
const CLAW = 3675;
const EYE = 3676;
const OPEN_BOX_PRICE = 650;
const PART_ITEMS = { 1: 3848, 2: 3849, 3: 3850, 4: 3851 };
const LETTERS = { 1: 3671, 2: 3672, 3: 3673, 4: 3674 };
const STATUE_PIECES = [3457, 3458, 3459, 3460];
const TABLET_PIECES = [3462, 3463, 3464, 3465];
const COMPLETE_STATUE = 3461;
const COMPLETE_TABLET = 3466;
// npcId: [part, allowDrop, proof percent, box percent, proof item] - reference DROPLIST.
const DROPLIST = {
    160: [1, 1, 67, 29, 3848], 171: [1, 1, 76, 31, 3848], 197: [1, 1, 89, 25, 3848],
    200: [1, 1, 60, 28, 3848], 201: [1, 1, 70, 29, 3848], 202: [1, 0, 60, 24, 3848],
    198: [1, 1, 60, 35, 3848],
    207: [2, 1, 69, 29, 3849], 208: [2, 1, 67, 32, 3849], 209: [2, 1, 62, 33, 3849],
    210: [2, 1, 78, 23, 3849], 211: [2, 1, 71, 22, 3849],
    251: [3, 1, 70, 30, 3850], 252: [3, 1, 67, 28, 3850], 253: [3, 1, 65, 26, 3850],
    781: [3, 0, 69, 31, 3850],
    157: [4, 1, 66, 32, 3851], 230: [4, 1, 68, 26, 3851], 232: [4, 1, 67, 28, 3851],
    234: [4, 1, 69, 32, 3851]
};
// f_give bands over getRandom(162): cargo box contents (reference lines 338-404).
const BOX_TABLE = [[21, 3444], [41, 3445], [61, 3446], [74, 3447], [86, 3448], [98, 3449],
    [99, 3450], [109, 3451], [119, 3452], [123, 3453], [127, 3454], [131, 3455], [132, 3456]];
// The four prize items handed out per exchanged eye, in reference draw order.
const PRIZE = { ALACRITY: 735, SOULSHOT: 1463, SCROLL: 736, SPIRITSHOT: 2510, POTION: 1061 };
// Redfoot's information pool (reference f_rnd_list, 20 items).
const NEWS = [
    'Dwarven first elders are searching for scrolls covered in giant hieroglyphs - some secret of giant engineering.',
    'The Dark Elves worship Shilen, and the Abyssal Celebrants gather fragments of her statue from everywhere.',
    'A pet handler called Cooper is said to know how to raise a hatchling as a companion.',
    'Sir Kristof von Ilten in Giran and Sir Tet Nathani in Oren support small clans - for a price.',
    'A society of ancient coin collectors pays dearly for rare coins; ask the dwarf Beo about it.',
    'A fake alchemist near the Ivory Tower sells wishes that sometimes even come true.',
    'A gem called the imperial diamond was stolen from a cargo wagon between Giran and Dion.',
    'Antharas has awakened. A woman called Marquise Antonette is gathering an army that cannot possibly win.',
    'A young chef called Jonas is gathering exotic ingredients for a culinary competition.',
    'Belton, a guard in Giran, makes revenge arrows against Antharas and pays for raw materials.',
    'Grocer Pico in Floran and Grocer Rona in the Dark Forest trade with outlaws.',
    'Farmer Peter in northern Gludio hires mercenaries against Turek Orcs, and old relics surface on his land.',
    'The Aden Trading Guild copies the dwarven trade halls, but the guilds keep losing cargo to raiders.',
    'The Dark Elves worship Shilen, and her stolen temple statues fetch a high price.',
    'Cooper is said to raise hatchlings - baby dragons make fine pets.',
    'Sir Kristof and Sir Tet Nathani back small clans for their own reasons.',
    'The ancient coin collectors want Beo introduced to anyone with a rare coin.',
    'The Ivory Tower alchemist grants wishes - very, very rarely real ones.',
    'Redfoot himself, at your service.',
    'Antharas walks in rumour only, for now. Keep your steel close.'
];

const step = (state, options) => require('../QuestStep').apply(state, options);
const count = (state, selfId) => state.session.actor.backpack.fetchItems()
    .filter((item) => item.fetchSelfId() === selfId)
    .reduce((sum, item) => sum + item.fetchAmount(), 0);
const adena = (amount) => Math.floor(amount * invoke('GameServer/ProgressionRates').profile().questAdena);
const page = (name, text, action = '') => `<html><body>${name}:<br>${text}<br><br>${action}</body></html>`;
const link = (event, label) => `<a action="bypass -h quest 333 ${event}">${label}</a>`;
const part = (state) => state.getInt('part');
const anyHeld = (state, ids) => ids.some((id) => count(state, id) > 0);

module.exports = {
    id: 333,
    name: 'Black Lion Hunt',
    npcs: [SOPHIA, REDFOOT, RUPIO, UNDIRAS, LOCKIRIN, MORGAN],
    startNpcs: [SOPHIA],
    killNpcs: Object.keys(DROPLIST).map(Number),
    eventNpc: (event) => {
        if (['start', 'p1t', 'p2t', 'p3t', 'p4t', 'continue', 'leave', 'exit'].includes(event)) return SOPHIA;
        if (['openBox', 'moreHelp', 'news'].includes(event)) return REDFOOT;
        if (['assembleStatue', 'assembleTablet'].includes(event)) return RUPIO;
        if (event === 'giveStatue') return UNDIRAS;
        if (event === 'giveTablet') return LOCKIRIN;
        if (event === 'giveBox') return MORGAN;
        return null;
    },
    canTalk: () => true,

    async onTalk(state, npc) {
        const npcId = Number(npc.fetchSelfId());
        if (!state.isStarted()) {
            if (npcId !== SOPHIA) return null;
            if (count(state, MARK)) {
                if (Number(state.session.actor.fetchLevel()) <= 24) {
                    return page('Sophia', 'The Black Lion Hunt needs seasoned fighters. Level 25 and the mark of the troop.');
                }
                return page('Sophia', 'A brother of the black lions! Our mission is to drive the evil spirits from this area, and our ranks are thin. Fight with us.',
                    link('start', 'Join the fight.'));
            }
            return page('Sophia', 'Mercenary work begins with a test. See Castellan Marcius in Gludin and bring back the mark of the black lions.');
        }
        if (npcId === SOPHIA) {
            const p = part(state);
            if (!p) {
                return page('Sophia', 'The war with the evil spirits has already started!',
                    `${link('p1t', 'Clean out the undead at the Execution Ground.')}`
                    + `<br>${link('p2t', 'Drive the ol mahum from the Partisan Hideaway.')}`
                    + `<br>${link('p3t', 'Break the delu lizardmen on the southern shore.')}`
                    + `<br>${link('p4t', 'Smash the marsh stakato in the Cruma Marshlands.')}`
                    + `<br>${link('exit', 'Leave the mercenaries.')}`);
            }
            const proof = PART_ITEMS[p];
            const held = count(state, proof);
            const boxes = count(state, CARGO_BOX);
            let body = '';
            const gives = [];
            const takes = [];
            if (held > 0) {
                const claws = held >= 100 ? 3 : held >= 50 ? 2 : held >= 20 ? 1 : 0;
                gives.push([ADENA, adena(35 * held)]);
                takes.push([proof, held]);
                if (claws) gives.push([CLAW, claws]);
                body = `Sophia pays ${35 * held} gold for your proofs${claws ? ` and counts you ${claws} lion claw(s)` : ''}.`;
            } else if (boxes) {
                body = 'A cargo box? The trading companies would rather not see it again. Redfoot opens boxes, quietly.';
            } else {
                body = 'Back already, without proofs of victory? The battlefield is that way.';
            }
            if (takes.length || gives.length) await step(state, { takes, gives, variables: { ...state.variables } });
            return page('Sophia', body,
                `${link('p1t', 'Execution Ground.')}<br>${link('p2t', 'Partisan Hideaway.')}`
                + `<br>${link('p3t', 'Southern shore.')}<br>${link('p4t', 'Cruma Marshlands.')}`
                + `<br>${link('continue', 'Exchange claws for lion eyes.')}`
                + `<br>${link('leave', 'Step down from this mission.')}`
                + `<br>${link('exit', 'Leave the mercenaries.')}`);
        }
        if (npcId === REDFOOT) {
            if (count(state, CARGO_BOX)) {
                return page('Redfoot', `A trading company cargo box - ${OPEN_BOX_PRICE} gold to open it and keep my mouth shut.`,
                    `${link('openBox', 'Open a cargo box.')}`);
            }
            return page('Redfoot', 'On active duty, are we? I have information, for friends of the troop.',
                `${link('news', 'Any useful information?')}`);
        }
        if (npcId === RUPIO) {
            if (anyHeld(state, STATUE_PIECES) || anyHeld(state, TABLET_PIECES)) {
                return page('Blacksmith Rupio', 'Relic restoration is my hobby - but a missing piece spoils everything.',
                    `${link('assembleStatue', 'Restore the statue pieces.')}`
                    + `<br>${link('assembleTablet', 'Restore the tablet fragments.')}`);
            }
            return page('Blacksmith Rupio', 'Weapon work keeps my forge busy. Relics are a different trade.');
        }
        if (npcId === UNDIRAS) {
            if (count(state, COMPLETE_STATUE)) {
                return page('Abyssal Celebrant Undrias', 'A statue of Shilen! The temple lost so many. Surrender it and receive a great reward.',
                    `${link('giveStatue', 'Hand over the statue.')}`);
            }
            if (anyHeld(state, STATUE_PIECES)) {
                return page('Abyssal Celebrant Undrias', 'That piece came from a stolen temple statue. Gather the rest and return it complete.');
            }
            return page('Abyssal Celebrant Undrias', 'Human hands robbed our goddess. Restored statues are rewarded handsomely.');
        }
        if (npcId === LOCKIRIN) {
            if (count(state, COMPLETE_TABLET)) {
                return page('First Elder Lockirin', 'Titan writing! I will pay any price - the guild federation thanks you.',
                    `${link('giveTablet', 'Hand over the tablet.')}`);
            }
            if (anyHeld(state, TABLET_PIECES)) {
                return page('First Elder Lockirin', 'A single fragment of a titan tablet! Assemble all four and I will thank you greatly.');
            }
            return page('First Elder Lockirin', 'Ancient clay tablets are found in the Dion wilds. Bring me one and name no price.');
        }
        if (npcId === MORGAN) {
            if (count(state, CARGO_BOX)) {
                return page('Guild Member Morgan', 'A cargo box from our caravans! The trading company rewards its defenders.',
                    `${link('giveBox', 'Hand over the cargo box.')}`);
            }
            return page('Guild Member Morgan', 'Our wagons are raided constantly. Recovered cargo is rewarded, with guild coins on top.');
        }
        return null;
    },

    async onEvent(state, event) {
        if (event === 'start') {
            if (state.isStarted() || state.isCompleted()) return null;
            if (!count(state, MARK) || Number(state.session.actor.fetchLevel()) <= 24) return null;
            // The reference takes and re-issues the mark so the item survives
            // exitQuest(1); the repo simply keeps the item in place.
            await step(state, { variables: { ...state.variables, cond: '1' } });
            state.playSound('ItemSound.quest_accept');
            return page('Sophia', 'Four fronts: choose your battlefield.');
        }
        if (!state.isStarted()) return null;
        const p = part(state);
        const roll = (n) => Math.floor(Math.random() * n);
        if (['p1t', 'p2t', 'p3t', 'p4t'].includes(event)) {
            const wanted = Number(event[1]);
            if (p && p !== wanted) {
                return page('Sophia', 'Finish the mission in hand before taking another.');
            }
            const letter = LETTERS[wanted];
            const hasLetter = count(state, letter) > 0;
            await step(state, {
                ...(hasLetter ? {} : { gives: [[letter, 1]] }),
                variables: { ...state.variables, part: String(wanted) }
            });
            return page('Sophia', 'The order is written down. Bring back the proofs of victory and they will be paid per piece.');
        }
        if (event === 'continue') {
            const clawSets = Math.floor(count(state, CLAW) / 10);
            if (!clawSets) return page('Sophia', 'Ten lion claws make one lion eye. Bring me ten.');
            const eyesBefore = count(state, EYE);
            const eyes = eyesBefore + clawSets;
            const tier = eyes > 9 ? { [PRIZE.ALACRITY]: 4, [PRIZE.SOULSHOT]: 400, [PRIZE.SCROLL]: 30, [PRIZE.SPIRITSHOT]: 200, [PRIZE.POTION]: 50 }
                : eyes > 4 ? { [PRIZE.ALACRITY]: 3, [PRIZE.SOULSHOT]: 200, [PRIZE.SCROLL]: 20, [PRIZE.SPIRITSHOT]: 100, [PRIZE.POTION]: 25 }
                    : { [PRIZE.ALACRITY]: 3, [PRIZE.SOULSHOT]: 100, [PRIZE.SCROLL]: 20, [PRIZE.SPIRITSHOT]: 50, [PRIZE.POTION]: 20 };
            // Each exchanged eye draws one of the five supply items at random.
            const prizeIds = [PRIZE.ALACRITY, PRIZE.SOULSHOT, PRIZE.SCROLL, PRIZE.SPIRITSHOT, PRIZE.POTION];
            const tally = {};
            for (let i = 0; i < clawSets; i++) {
                const id = prizeIds[roll(5)];
                tally[id] = (tally[id] || 0) + tier[id];
            }
            await step(state, {
                takes: [[CLAW, clawSets * 10]],
                gives: [[EYE, clawSets], ...Object.entries(tally).map(([id, n]) => [Number(id), n])],
                variables: { ...state.variables }
            });
            state.playSound('ItemSound.quest_itemget');
            return page('Sophia', eyesBefore
                ? `The mark of the lion's eye - ${clawSets} exchanged, and new supplies issued.`
                : `The mark of the lion's eye is awarded to you. New supplies have been issued.`);
        }
        if (event === 'leave') {
            const letter = LETTERS[p];
            const takes = [];
            if (letter && count(state, letter)) takes.push([letter, 1]);
            await step(state, { takes, variables: { ...state.variables, part: '0' } });
            return page('Sophia', 'Even a lion needs a break. Rest, or take up a fresh mission.');
        }
        if (event === 'exit') {
            const takes = [];
            if (count(state, MARK)) takes.push([MARK, 1]);
            const claws = count(state, CLAW);
            const eyes = count(state, EYE);
            if (claws) takes.push([CLAW, claws]);
            if (eyes) takes.push([EYE, eyes]);
            await step(state, { takes, status: 'created', variables: {} });
            state.playSound('ItemSound.quest_finish');
            return page('Sophia', 'So the black lions lose a brother. Take discharge pay... no, merely our regards. The mark stays with the troop.');
        }
        if (event === 'news') {
            const told = Number(state.get('newsTold') || 0);
            if (told >= 4) return page('Redfoot', 'No news today. Come by later.');
            await step(state, { variables: { ...state.variables, newsTold: String(told + 1) } });
            return page('Redfoot', NEWS[roll(NEWS.length)]);
        }
        if (event === 'openBox') {
            if (!count(state, CARGO_BOX)) return page('Redfoot', 'You do not even have a cargo box.');
            const held = state.session.actor.backpack.fetchItems()
                .filter((item) => item.fetchSelfId() === ADENA)
                .reduce((sum, item) => sum + item.fetchAmount(), 0);
            if (held < adena(OPEN_BOX_PRICE)) {
                return page('Redfoot', 'That is not enough money! Opening boxes and keeping quiet both cost.');
            }
            const random = roll(162);
            let gives = [];
            const band = BOX_TABLE.find(([edge]) => random < edge);
            if (band) gives = [[band[1], 1]];
            else if (random < 147) gives = [[STATUE_PIECES[roll(4)], 1]];
            else gives = [[TABLET_PIECES[roll(4)], 1]];
            await step(state, { takes: [[CARGO_BOX, 1], [ADENA, adena(OPEN_BOX_PRICE)]], gives,
                variables: { ...state.variables } });
            state.playSound('ItemSound.quest_itemget');
            return page('Redfoot', gives[0][0] === 3450 ? 'Hmm. Alexandrite - the cat\'s eye glitters.'
                : 'The box is open - the contents are yours.');
        }
        if (event === 'assembleStatue' || event === 'assembleTablet') {
            const pieces = event === 'assembleStatue' ? STATUE_PIECES : TABLET_PIECES;
            const result = event === 'assembleStatue' ? COMPLETE_STATUE : COMPLETE_TABLET;
            const held = pieces.filter((id) => count(state, id) > 0).length;
            if (!held) return page('Blacksmith Rupio', 'You bring me nothing to restore.');
            if (held < 4) return page('Blacksmith Rupio', 'Not a single piece may be missing.');
            const success = roll(2) === 1;
            await step(state, {
                takes: pieces.map((id) => [id, 1]),
                ...(success ? { gives: [[result, 1]] } : {}),
                variables: { ...state.variables } });
            state.playSound(success ? 'ItemSound.quest_itemget' : 'ItemSound.quest_failed');
            return page('Blacksmith Rupio', success
                ? 'It is finished! The joints still show, but it is a beauty.'
                : 'The old relic just crumbled in my hands... forgive me.');
        }
        if (event === 'giveStatue') {
            if (!count(state, COMPLETE_STATUE)) return null;
            await step(state, { takes: [[COMPLETE_STATUE, 1]], gives: [[ADENA, adena(30000)]],
                variables: { ...state.variables } });
            return page('Abyssal Celebrant Undrias', 'The goddess comes home. Here is the promised reward.');
        }
        if (event === 'giveTablet') {
            if (!count(state, COMPLETE_TABLET)) return null;
            await step(state, { takes: [[COMPLETE_TABLET, 1]], gives: [[ADENA, adena(30000)]],
                variables: { ...state.variables } });
            return page('First Elder Lockirin', 'Titan script at last! The guild federation is in your debt.');
        }
        if (event === 'giveBox') {
            if (!count(state, CARGO_BOX)) return null;
            const coins = count(state, GUILD_COIN);
            const bonus = Math.min(2, Math.floor(coins / 40));
            await step(state, {
                takes: [[CARGO_BOX, 1]],
                gives: [[GUILD_COIN, 1], [ADENA, adena((1 + bonus) * 100)]],
                variables: { ...state.variables } });
            state.playSound('ItemSound.quest_itemget');
            return page('Guild Member Morgan', 'Recovered cargo, and a guild coin for your trouble. Keep the good work up.');
        }
        return null;
    },

    async onKill(state, npc) {
        if (!state.isStarted()) return;
        const npcId = Number(npc.fetchSelfId());
        const drop = DROPLIST[npcId];
        if (!drop) return;
        const [wanted, allow, proofChance, boxChance] = drop;
        if (!allow || part(state) !== wanted) return;
        const mobLevel = Number(npc.fetchLevel?.() ?? 0);
        const playerLevel = Number(state.session.actor.fetchLevel());
        // A character eight levels above the trophy kills it sloppily: proofs and
        // boxes fall at a third of the rate.
        const scale = playerLevel - mobLevel > 8 ? 1 / 3 : 1;
        const roll1 = Math.floor(Math.random() * 101);
        const roll2 = Math.floor(Math.random() * 101);
        const proof = roll1 < proofChance * scale ? drop[4] : null;
        const box = roll2 < boxChance * scale ? 1 : 0;
        const gives = [];
        if (proof) gives.push([proof, 1]);
        if (box) gives.push([CARGO_BOX, 1]);
        if (!gives.length) return;
        await step(state, { gives, variables: { ...state.variables } });
        state.playSound('ItemSound.quest_itemget');
    }
};
