// Q327 Reclaim The Land. Source: l2j-lisvus fdc7e33 327_ReclaimTheLand.
//
// Peter the farmer (7597) pays per Turek token on sight; Sorceress Iris (7034)
// buys the altar fragments and relics for experience; Trader Ashley (7313)
// reassembles five fragments into a relic with an eighty percent chance of
// success. Every kill of a Turek patrol hands over one token, plus a possible
// fragment of one of the four burned altars.
const PETER = 7597;
const IRIS = 7034;
const ASHLEY = 7313;

const DOGTAG = 1846;
const MEDALLION = 1847;
const URN_FRAGMENT = 1848;
const BRASS_PIECE = 1849;
const MIRROR_PIECE = 1850;
const JADE_BEAD = 1851;
const ANCIENT_URN = 1852;
const ANCIENT_TIARA = 1853;
const ANCIENT_MIRROR = 1854;
const ANCIENT_NECKLACE = 1855;

const FRAGMENTS = [URN_FRAGMENT, BRASS_PIECE, MIRROR_PIECE, JADE_BEAD];
const RELICS = [ANCIENT_URN, ANCIENT_TIARA, ANCIENT_MIRROR, ANCIENT_NECKLACE];
// What the reference registers for removal on exit; the relics stay.
const QUEST_ITEMS = [DOGTAG, MEDALLION, ...FRAGMENTS];
// npcId: [token, percent chance that a fragment also falls]
const DROPLIST = { 500: [DOGTAG, 7], 499: [DOGTAG, 8], 498: [DOGTAG, 10], 496: [DOGTAG, 9],
    501: [MEDALLION, 12], 497: [MEDALLION, 11], 495: [MEDALLION, 13] };
// Iris pays experience per piece, the reference's addExpAndSp(n * value, 0).
const FRAGMENT_EXP = { 1848: 152, 1849: 182, 1850: 182, 1851: 182 };
const RELIC_EXP = { 1852: 913, 1853: 1065, 1854: 1065, 1855: 1294 };

const step = (state, options) => require('../QuestStep').apply(state, options);
const count = (state, selfId) => state.session.actor.backpack.fetchItems()
    .filter((item) => item.fetchSelfId() === selfId)
    .reduce((sum, item) => sum + item.fetchAmount(), 0);
const adena = (amount) => Math.floor(amount * invoke('GameServer/ProgressionRates').profile().questAdena);
const page = (name, text, action = '') => `<html><body>${name}:<br>${text}<br><br>${action}</body></html>`;
const link = (event, label) => `<a action="bypass -h quest 327 ${event}">${label}</a>`;

module.exports = {
    id: 327,
    questItems: QUEST_ITEMS,
    name: 'Reclaim The Land',
    npcs: [PETER, IRIS, ASHLEY],
    startNpcs: [PETER],
    killNpcs: [495, 496, 497, 498, 499, 500, 501],
    eventNpc: (event) => (['accept', 'giveUp', 'sellTokens'] .includes(event) ? PETER
        : event.startsWith('assemble') ? ASHLEY : IRIS),
    canTalk: () => true,

    async onTalk(state, npc) {
        const npcId = Number(npc.fetchSelfId());
        if (npcId === PETER) {
            if (!state.isStarted()) {
                if (Number(state.session.actor.fetchLevel()) < 25) {
                    return page('Peter', 'My farm is overrun with Turek Orcs, but you are not ready yet.');
                }
                return page('Peter', 'Turek Orcs are ravaging my land. Take the tokens from the dead and I will pay: 40 gold a dogtag, 50 a medallion. Their altars lie broken across the land.',
                    `${link('accept', 'Accept.')}`);
            }
            const tokens = count(state, DOGTAG) + count(state, MEDALLION);
            if (!tokens) return page('Peter', 'No tokens, no pay. Bring me the proofs of dead Tureks.');
            return page('Peter', 'Let me see the tokens on your corpse-pile.',
                `${link('sellTokens', 'Hand over the tokens.')}<br>${link('giveUp', 'Give up this task.')}`);
        }
        if (npcId === IRIS) {
            if (!state.isStarted()) return page('Sorceress Iris', 'The altars of the forest gods lie burned. Bring their fragments to me and I will reward you with knowledge.');
            return page('Sorceress Iris', 'I can read wisdom even from broken altar stones.',
                `${link('sellUrn', 'Sell urn fragments.')}<br>${link('sellBrass', 'Sell brass trinket pieces.')}`
                + `<br>${link('sellMirror', 'Sell bronze mirror pieces.')}<br>${link('sellJade', 'Sell jade necklace beads.')}`
                + `<br>${link('sellRelics', 'Sell all assembled relics.')}`);
        }
        if (npcId === ASHLEY) {
            if (!state.isStarted()) return page('Trader Ashley', 'Pieces of old altars? I collect such things.');
            return page('Trader Ashley', 'Five pieces of one altar may yet make a whole relic - though old stone crumbles under my hands.',
                `${link('assembleUrn', 'Assemble urn fragments.')}<br>${link('assembleBrass', 'Assemble brass trinket pieces.')}`
                + `<br>${link('assembleMirror', 'Assemble bronze mirror pieces.')}<br>${link('assembleJade', 'Assemble jade necklace beads.')}`);
        }
        return null;
    },

    async onEvent(state, event) {
        if (event === 'accept') {
            if (state.isStarted() || state.isCompleted()) return null;
            if (Number(state.session.actor.fetchLevel()) < 25) return null;
            await step(state, { variables: { ...state.variables, cond: '1' } });
            state.playSound('ItemSound.quest_accept');
            return page('Peter', 'Go clean my land of the Turek Orcs.');
        }
        if (!state.isStarted()) return null;

        if (event === 'sellTokens') {
            const dogs = count(state, DOGTAG);
            const medallions = count(state, MEDALLION);
            if (!dogs && !medallions) return null;
            await step(state, {
                takes: [[DOGTAG, dogs], [MEDALLION, medallions]].filter(([, n]) => n > 0),
                gives: [[57, adena(40 * dogs + 50 * medallions)]],
                variables: { ...state.variables }
            });
            return page('Peter', 'Here is your payment - 40 a dogtag, 50 a medallion.');
        }
        if (event.startsWith('assemble')) {
            const index = ['Urn', 'Brass', 'Mirror', 'Jade'].indexOf(event.slice(8));
            if (index < 0) return null;
            const fragment = FRAGMENTS[index];
            const relic = RELICS[index];
            if (count(state, fragment) < 5) return page('Trader Ashley', 'You need five pieces of one altar.');
            const success = Math.floor(Math.random() * 100) < 80;
            await step(state, {
                takes: [[fragment, 5]],
                ...(success ? { gives: [[relic, 1]] } : {}),
                variables: { ...state.variables }
            });
            state.playSound(success ? 'ItemSound.quest_itemget' : 'ItemSound.quest_failed');
            return page('Trader Ashley', success
                ? 'A whole relic at last. The joints show, but it is beautiful.'
                : 'The old stone just crumbled in my hands... I am sorry.');
        }
        const sellers = { sellUrn: URN_FRAGMENT, sellBrass: BRASS_PIECE, sellMirror: MIRROR_PIECE, sellJade: JADE_BEAD };
        if (event in sellers) {
            const id = sellers[event];
            const held = count(state, id);
            if (!held) return page('Sorceress Iris', 'You have none of those to sell.');
            await step(state, {
                takes: [[id, held]], exp: held * FRAGMENT_EXP[id],
                variables: { ...state.variables }
            });
            state.playSound('ItemSound.quest_itemget');
            return page('Sorceress Iris', `The wisdom of ${held} pieces flows into you.`);
        }
        if (event === 'sellRelics') {
            const takes = RELICS.map((id) => [id, count(state, id)]).filter(([, n]) => n > 0);
            if (!takes.length) return page('Sorceress Iris', 'You carry no assembled relic.');
            const exp = takes.reduce((sum, [id, n]) => sum + n * RELIC_EXP[id], 0);
            await step(state, { takes, exp, variables: { ...state.variables } });
            state.playSound('ItemSound.quest_itemget');
            return page('Sorceress Iris', 'Ancient relics hold ancient knowledge. I have taught you well.');
        }
        if (event === 'giveUp') {
            // The reference's exitQuest(1): every quest-owned token is surrendered.
            await require('../QuestStep').abandon(state, QUEST_ITEMS);
            state.playSound('ItemSound.quest_finish');
            return page('Peter', 'Leaving already? Return the proofs of battle, then.');
        }
        return null;
    },

    async onKill(state, npc) {
        if (!state.isStarted()) return;
        const drop = DROPLIST[Number(npc.fetchSelfId())];
        if (!drop) return;
        const [token, chance] = drop;
        const gives = [[token, 1]];
        if (Math.floor(Math.random() * 100) < chance) {
            gives.push([FRAGMENTS[Math.floor(Math.random() * 4)], 1]);
        }
        await step(state, { gives, variables: { ...state.variables } });
        state.playSound('ItemSound.quest_itemget');
    }
};
