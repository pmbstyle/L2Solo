const assert = require('node:assert/strict');
require('../src/Global');

const Knowledge = invoke('GameServer/Bot/AI/BotDialogueKnowledge');
const Trade = invoke('GameServer/Bot/Economy/BotAfkTradeChat');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Negotiation = invoke('GameServer/Bot/Economy/BotNegotiationService');
const DataCache = invoke('GameServer/DataCache');
const Clans = invoke('GameServer/Clan/ClanService');
const Memory = invoke('GameServer/Social/InteractionMemoryRuntime');
const Policy = invoke('GameServer/Social/InteractionMemoryPolicy');
const Database = invoke('Database');
const Protocol = invoke('GameServer/Bot/AI/BotDialogueProtocol');

async function main() {
    const saved = { projection: Afk.findOwnerProjection, active: Negotiation.activeSummary,
        items: DataCache.items, clan: Clans.clanOfMember, findClan: Clans.findById, sql: Database.execute };
    let active = null, side = Afk.SELL;
    try {
        DataCache.items = [
            { selfId: 181, etc: { rank: 'd' } }, { selfId: 25, etc: { rank: 'none' } }
        ];
        Afk.findOwnerProjection = () => ({ session: {}, actor: { fetchPrivateStore: () => ({
            ownerId: 71002, botOwned: true, storeType: side, town: 'Giran',
            items: [{ selfId: 181, name: 'Mace of Miracle', count: 1, price: 500 },
                { selfId: 25, name: 'Piece Bone Breastplate', count: 1, price: 100 }]
        }) } });
        Negotiation.activeSummary = () => active;
        const state = { characterId: 71002, inventory: {
            167: { selfId: 167, name: 'Scalpel', rank: 'd', kind: 'Weapon.Blunt', amount: 2,
                instances: [{ id: 77, equipped: true, slot: 7, amount: 1, enchant: 0 },
                    { id: 78, equipped: false, slot: 0, amount: 1, enchant: 3 }] },
            348: { selfId: 348, name: 'Scale Mail', rank: 'd', kind: 'Armor.Chain', amount: 1,
                equipped: true, slot: 10 }
        } };
        for (side of [Afk.SELL, Afk.BUY]) {
            for (const message of ["I'm good, looking for friends. Where you got back from?",
                'Thanks for your help', 'What are you looking for?', 'I agree, friendship is good',
                'No, I prefer hunting', 'I want to buy better gear someday',
                'Can I ask you about your Mace of Miracle?']) {
                assert.equal(Trade.parse(state, message), null, message);
            }
        }
        side = Afk.SELL;
        assert.equal(Trade.parse(state, 'offer 500 Adena for Mace of Miracle x1').action, 'quote');
        assert.equal(Trade.parse(state, 'Mace of Miracle for 500 Adena').itemId, 181);
        assert.equal(Trade.parse(state, 'buy Mace of Miracle').action, 'help');
        active = { playerName: 'Player' };
        const playerSession = { actor: { fetchId: () => 71001, fetchName: () => 'Player' } };
        for (const message of ['Agree, but I am talking about your clan', 'Yes, but that price is too high']) {
            assert.equal(Trade.parse(state, message, playerSession), null, 'qualified speech must not accept a price');
        }
        assert.equal(Trade.parse(state, 'yes', playerSession).action, 'accept');
        active.quantity = 1;
        assert.equal(Trade.parse(state, 'yes, for one', playerSession).action, 'accept');
        assert.equal(Trade.parse(state, 'okay for 1!', playerSession).action, 'accept');
        assert.equal(Trade.parse(state, 'yes, for 2', playerSession), null,
            'a different quantity must not accept the current offer');
        assert.equal(Trade.parse(state, 'yes, for one', { actor: { fetchName: () => 'OtherPlayer' } }), null,
            'another player cannot accept the active offer');
        active.quantity = 2;
        assert.equal(Trade.parse(state, 'yes, for one', playerSession), null);
        assert.equal(Trade.parse(state, 'yes, for 2', playerSession).action, 'accept');
        assert.equal(Trade.parse(state, 'cancel', playerSession).action, 'decline');
        assert.equal(Trade.parse(state, 'refresh your shop', playerSession).action, 'status',
            'refreshing a listing must not accept a pending price');
        assert.equal(Trade.context(state, playerSession).items[1].grade, 'none');
        assert.equal(Trade.context(state, playerSession).purpose, 'shop_listings_not_equipped_items');

        for (const query of ['', 'gear', 'my equipment']) {
            const gear = await Knowledge.inspect({ topic: 'equipment', query }, { session: state });
            assert.equal(gear.total, 2, query);
            assert.equal(gear.rows[0].name, 'Scalpel');
            assert.equal(gear.rows[0].slot, 7);
            assert(!gear.rows.some(row => row.objectId === 78), 'an unequipped copy is not worn gear');
        }
        assert.equal((await Knowledge.inspect({ topic: 'equipment', query: 'weapon' }, { session: state })).total, 1);
        assert.equal((await Knowledge.inspect({ topic: 'equipment', query: 'Nonexistent Sword' }, { session: state })).total, 0);
        Clans.clanOfMember = () => null;
        Clans.findById = () => ({ id: 44, name: 'UnrelatedClan' });
        assert.equal((await Knowledge.selfContext({ ...state, stats: { clanId: 44 } }, 'hello', {})).clan.id, 0,
            'stale life stats must not invent membership in an unrelated clan');
        const ordinary = await Knowledge.selfContext(state, 'hello', {});
        assert.equal(ordinary.clan.id, 0, 'no clan is an explicit fact independent of party membership');
        assert.equal(ordinary.equipment, undefined, 'ordinary chat must not carry inventory');
        const equipment = await Knowledge.selfContext(state, 'are you in clan and what is your gear?', {});
        assert.deepEqual(equipment.equipment.rows.map(row => row.name), ['Scalpel', 'Scale Mail']);
        const bounded = Protocol.fitContext({ bot: { ...equipment, inventory: { rows: ['irrelevant '.repeat(2000)] } } }, 800);
        assert.equal(bounded.bot.equipment.rows[0].name, 'Scalpel', 'context trimming preserves small authoritative worn gear');
        const followup = await Knowledge.selfContext(state, 'is it D grade?', { recentTurns: [
            { role: 'player', text: 'What is your gear?' },
            { role: 'bot', text: 'A Mace of Miracle and Piece Bone Breastplate.' }
        ] });
        assert.equal(followup.equipment.rows[0].name, 'Scalpel', 'follow-up uses actual equipment, not prior model claims');
        Clans.clanOfMember = () => ({ id: 44, name: 'ActualClan' });
        assert.equal((await Knowledge.selfContext({ ...state, party: null }, 'hello', {})).clan.name, 'ActualClan');

        const at = Date.now();
        const snapshot = Policy.empty(state.characterId);
        snapshot.revision = 1;
        snapshot.relations = [{ kind: 'character', targetId: 71003, at, affinity: -6, trust: -5,
            hostility: 9, fear: 2, familiarity: 2, reasons: [{ type: 'attacked', at }] },
        { kind: 'character', targetId: 71004, at, affinity: 6, trust: 7,
            hostility: 0, fear: 0, familiarity: 3, reasons: [{ type: 'helped_in_combat', at }] }];
        Memory.accept(snapshot);
        Database.execute = async ([sql, ids]) => {
            assert.match(sql, /^SELECT id, name FROM characters WHERE id IN/);
            return [{ id: 71003, name: 'Vane' }, { id: 71004, name: 'Ally' }].filter(row => ids.includes(row.id));
        };
        const circle = await Knowledge.inspect({ topic: 'relationships' }, { session: state, playerSession });
        assert.equal(circle.source, 'personal_relationship_memory');
        assert(circle.rows.some(row => row.name === 'Vane' && row.relationship === 'hostile'
            && row.reasons.some(reason => reason.type === 'attacked')));
        assert(circle.rows.some(row => row.name === 'Ally' && row.relationship === 'friendly'));
        assert.equal(circle.completeHistory, false);
        const social = await Knowledge.selfContext(state, 'Do you have friends or enemies?', {});
        assert(social.relationships.rows.some(row => row.name === 'Vane'));
        assert.equal((await Knowledge.inspect({ topic: 'relationships' }, { session: state, publicChat: true })).reason, 'private_memory');
        Memory.forget(state.characterId);
        console.log('Dialogue grounding regressions passed');
    } finally {
        Afk.findOwnerProjection = saved.projection; Negotiation.activeSummary = saved.active;
        DataCache.items = saved.items; Clans.clanOfMember = saved.clan; Clans.findById = saved.findClan; Database.execute = saved.sql;
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
