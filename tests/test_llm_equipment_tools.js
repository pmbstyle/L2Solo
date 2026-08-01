const assert = require('assert');
require('../src/Global');

const BotManager = invoke('GameServer/Bot/BotManager');
const BotAgentTools = invoke('GameServer/Bot/AI/BotAgentTools');
const Item = invoke('GameServer/Item/Item');

function wearable(id, data) {
    return new Item(id, {
        selfId: data.selfId || id,
        name: data.name || `item_${id}`,
        kind: data.kind,
        price: data.price ?? 100,
        rank: data.rank || 'none',
        pAtk: data.pAtk || 0,
        mAtk: data.mAtk || 0,
        pDef: data.pDef || 0,
        mDef: data.mDef || 0,
        equipped: data.equipped || false,
        slot: data.slot
    });
}

const oldSword = wearable(801, { kind: 'Weapon.Sword', slot: 7, pAtk: 8, equipped: true });
const newSword = wearable(802, { kind: 'Weapon.Sword', slot: 7, pAtk: 20 });
const questItem = wearable(803, { kind: 'Other.Quest', slot: 0, price: 1000 });
const items = [oldSword, newSword, questItem];
const backpack = {
    fetchItems: () => items,
    fetchEquippedWeapon: () => oldSword,
    fetchPaperdollId: (slot) => Number(slot) === 7 ? 801 : 0,
    fetchItemRaw: (id) => items.find((item) => item.fetchId() === id)
};
const leader = { accountId: 'player_gear_leader', actor: { fetchId: () => 720, fetchName: () => 'GearLeader', fetchIsOnline: () => true } };
const bot = {
    accountId: 'bot_gear_tools',
    plan: 'following',
    partyCompanion: true,
    followPlayerSession: leader,
    actor: {
        fetchId: () => 721,
        fetchName: () => 'GearCompanion',
        fetchLevel: () => 10,
        fetchClassId: () => 0,
        isDead: () => false,
        state: { fetchHits: () => false, fetchCasts: () => false, fetchTowards: () => false },
        backpack
    }
};
BotManager.sessions = [bot];

function decision(action, turnId, extra = {}) {
    return {
        action,
        confidence: 0.99,
        reply: '',
        targetPlayerName: '',
        spotId: '',
        buffType: '',
        reason: 'equipment tool test',
        turnId,
        ...extra
    };
}

try {
    const context = (turnId) => ({ playerSession: leader, conversationTurn: { turnId } });
    const listed = BotAgentTools.execute(bot, decision('list_safe_loadouts', 'gear-1'), [], context('gear-1'));
    assert.strictEqual(listed.applied, true);
    assert(listed.loadouts.some((entry) => entry.itemId === 802), 'safe loadout should expose a strict weapon upgrade');
    assert(!listed.loadouts.some((entry) => entry.itemId === 803), 'quest items must never be exposed as loadouts');

    const rejected = BotAgentTools.execute(bot, decision('equip_candidate', 'gear-2', { itemId: 803 }), [], context('gear-2'));
    assert.deepStrictEqual(rejected, { applied: false, reason: 'incompatible_item' });
    console.log('LLM equipment tool checks passed');
} finally {
    // no persistent world state is changed by this fixture
}
