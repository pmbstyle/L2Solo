// Q364 Jovial Accordion. Source: MOBIUS_C4 6674a607 Q00364_JovialAccordion.
//
// NPC ids are L2Solo native datapack ids (reference id - 23000).
//
// Barbado sends you to Swan, who hands over two chest keys. Each key opens its
// chest exactly once and finds the stolen goods only half the time, so the
// errand can end with two, one or nothing recovered. Returning the goods to
// their owners is what counts: Swan pays a hundred adena only for both, and a
// player who comes back empty-handed with no keys left has simply failed.
const BARBADO = 7959;
const SWAN = 7957;
const SABRIN = 7060;
const XABER = 7075;
const CLOTH_CHEST = 7961;
const BEER_CHEST = 7960;

const CLOTH_KEY = 4323;
const BEER_KEY = 4324;
const STOLEN_BEER = 4321;
const STOLEN_CLOTHES = 4322;
const ECHO = 4421;

const MIN_LEVEL = 15;
const BOTH_RECOVERED_ADENA = 100;
const CHEST_CHANCE = 0.5;

const step = (state, options) => require('../QuestStep').apply(state, options);
const count = (state, selfId) => state.session.actor.backpack.fetchItems()
    .filter((item) => item.fetchSelfId() === selfId)
    .reduce((sum, item) => sum + item.fetchAmount(), 0);
const adena = (amount) => [[57, Math.floor(amount * invoke('GameServer/ProgressionRates').profile().questAdena)]];
const page = (who, text, action = '') => `<html><body>${who}:<br>${text}<br><br>${action}</body></html>`;
const link = (event, label) => `<a action="bypass -h quest 364 ${event}">${label}</a>`;

// Each chest names the key it needs and the prize it may hold.
const CHESTS = {
    beer: { npc: BEER_CHEST, key: BEER_KEY, loot: STOLEN_BEER, who: 'Beer Chest' },
    cloth: { npc: CLOTH_CHEST, key: CLOTH_KEY, loot: STOLEN_CLOTHES, who: 'Cloth Chest' }
};
// Each owner takes back exactly one stolen article.
const OWNERS = { [SABRIN]: { loot: STOLEN_BEER, who: 'Sabrin' }, [XABER]: { loot: STOLEN_CLOTHES, who: 'Xaber' } };

module.exports = {
    id: 364,
    name: 'Jovial Accordion',
    npcs: [BARBADO, SWAN, SABRIN, XABER, CLOTH_CHEST, BEER_CHEST],
    startNpcs: [BARBADO],
    eventNpc: (event) => (event === 'start' ? BARBADO : event === 'keys' ? SWAN : CHESTS[event]?.npc ?? null),
    canTalk: () => true,

    async onEvent(state, event) {
        if (event === 'start') {
            if (state.isStarted() || state.isCompleted()) return null;
            if (Number(state.session.actor.fetchLevel()) < MIN_LEVEL) return null;
            await step(state, { variables: { ...state.variables, cond: '1', items: '0' } });
            state.playSound('ItemSound.quest_accept');
            return page('Barbado', 'Swan knows who took the festival supplies. Go and ask him.');
        }
        if (!state.isStarted()) return null;
        const cond = state.getInt('cond');

        if (event === 'keys') {
            if (cond !== 1) return null;
            await step(state, {
                gives: [[CLOTH_KEY, 1], [BEER_KEY, 1]],
                variables: { ...state.variables, cond: '2' }
            });
            state.playSound('ItemSound.quest_middle');
            return page('Swan', 'Two keys, two chests. Return whatever you find to its owner.');
        }

        const chest = CHESTS[event];
        if (!chest || cond !== 2 || !count(state, chest.key)) return null;
        // The key is spent whether or not the chest holds anything, and it is
        // spent in the same transaction that hands over the loot.
        const found = Math.random() < CHEST_CHANCE;
        await step(state, {
            takes: [[chest.key, 1]], gives: found ? [[chest.loot, 1]] : [],
            variables: { ...state.variables }
        });
        if (found) state.playSound('ItemSound.quest_itemget');
        return page(chest.who, found ? 'The stolen goods are here.' : 'The chest is empty.');
    },

    async onTalk(state, npc) {
        const id = Number(npc.fetchSelfId());
        if (!this.npcs.includes(id)) return null;
        if (state.isCompleted()) return page('Barbado', 'You have already helped with the festival.');
        if (!state.isStarted()) {
            if (id !== BARBADO) return null;
            if (Number(state.session.actor.fetchLevel()) < MIN_LEVEL) {
                return page('Barbado', `Come back when you have reached level ${MIN_LEVEL}.`);
            }
            return page('Barbado', 'Someone has robbed the festival stores.',
                link('start', 'Offer to look into it.'));
        }
        const cond = state.getInt('cond');

        if (id === BARBADO) {
            if (cond !== 3) return page('Barbado', 'Swan is the one to ask.');
            await step(state, { gives: [[ECHO, 1]], status: 'created', variables: {} });
            state.playSound('ItemSound.quest_finish');
            return page('Barbado', 'The festival is saved. Take this score with my thanks.');
        }

        const owner = OWNERS[id];
        if (owner) {
            // Possession is the whole gate in the reference: the stolen article
            // only exists between opening a chest and returning it.
            if (!count(state, owner.loot)) return page(owner.who, 'I am missing nothing now.');
            await step(state, {
                takes: [[owner.loot, 1]],
                variables: { ...state.variables, items: String(state.getInt('items') + 1) }
            });
            state.playSound('ItemSound.quest_itemget');
            return page(owner.who, 'That is mine. Thank you for bringing it back.');
        }

        if (id === SWAN) {
            if (cond === 1) {
                return page('Swan', 'I know where the goods went.', link('keys', 'Ask for the keys.'));
            }
            if (cond === 3) return page('Swan', 'Barbado will want to hear about this.');
            const recovered = state.getInt('items');
            if (recovered > 0) {
                await step(state, {
                    gives: recovered === 2 ? adena(BOTH_RECOVERED_ADENA) : [],
                    variables: { ...state.variables, cond: '3' }
                });
                state.playSound('ItemSound.quest_middle');
                return page('Swan', recovered === 2
                    ? 'Everything is back where it belongs. Take this for your trouble.'
                    : 'Not everything, but better than nothing. Tell Barbado.');
            }
            if (count(state, CLOTH_KEY) || count(state, BEER_KEY)) {
                return page('Swan', 'You still have a key. The chests are waiting.');
            }
            // Both keys spent, nothing recovered: the errand is simply over, and
            // the reference releases it so it can be attempted again.
            await step(state, { status: 'created', variables: {} });
            state.playSound('ItemSound.quest_giveup');
            return page('Swan', 'Both chests are shut for good and we have nothing. That is that.');
        }

        // The two chests.
        const chest = Object.values(CHESTS).find((entry) => entry.npc === id);
        if (cond !== 2 || !count(state, chest.key)) return page(chest.who, 'The chest is locked.');
        return page(chest.who, 'Your key fits this chest.', link(
            chest === CHESTS.beer ? 'beer' : 'cloth', 'Open it.'));
    }
};
