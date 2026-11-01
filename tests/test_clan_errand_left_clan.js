'use strict';
// A clan errand whose buyer left the clan must not spend the treasury credit it
// carries: it is dropped on arrival and the credit goes back to the clan.

const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('clan-errand-left');
require('../src/Global');
fixture.assertConfigured(options.default);
const { DatabaseSync } = require('node:sqlite');
const Database = invoke('Database'), Data = invoke('GameServer/DataCache');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Market = invoke('GameServer/Bot/Economy/ColdMarketService');
const Offers = invoke('GameServer/Bot/Economy/MarketOpportunity');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Errands = require('../src/GameServer/Bot/Population/CombinedErrandPolicy');
const GoalState = invoke('GameServer/Bot/Goals/GoalState');
const GIRAN = { locX: 83396, locY: 147904, locZ: -3400 };
const WALLET = 1000000, CLAN = 42, PACKET = [77000, 3e-5, 15000, 1200000];
let nextId = 719300;

async function stateFor(clanId, errand, packet = PACKET) {
    const id = nextId++;
    await Database.setItem(id, { selfId: 57, name: 'Adena', amount: WALLET, slot: 0 });
    return Life.upsertState({ characterId: id, accountName: 'bot_clan_errand', name: `Errand${id}`,
        phase: 'cold', activity: 'shopping', level: 30, exp: Number(Data.experience[29]),
        adena: WALLET, currentRegion: 'Giran', loc: GIRAN,
        vitals: { hp: 187, maxHp: 187, mp: 74, maxMp: 74 }, timing: {},
        inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
        stats: { classId: 0, money: [...packet], ...(clanId ? { clanId } : {}),
            marketErrand: errand, marketErrands: [errand] } }, 'clan_errand_fixture');
}
const stock = async (id, itemId) => (await Database.fetchItems(id)).filter(row => Number(row.selfId) === Number(itemId))
    .reduce((sum, row) => sum + Number(row.amount), 0);
const wallet = id => stock(id, 57);
const errandGoal = async state => {
    const errand = Errands.pending(state)[0];
    assert(await GoalState.set(state.characterId, { type: 'market_errand', status: 'active', priority: 80,
        target: { itemId: errand.selfId, amount: errand.amount },
        plan: { purpose: errand.purpose, marketTown: errand.town } }), 'goal set');
};
const goalStatus = id => GoalState.snapshot(id)?.current?.status;

(async () => {
    Data.init();
    const npc = [1, 2, 3, 4, 5, 6, 7, 10, 14, 34, 40, 110, 2508]
        .flatMap(itemId => Offers.npcOffers(itemId, 'Giran'))
        .filter(row => row.price > 0 && row.price < WALLET).sort((left, right) => left.price - right.price)[0];
    assert(npc, 'the fixture uses an actual C4 Giran NPC quote');
    const errandOf = (purpose, tag) => ({ selfId: npc.selfId, amount: 1, town: 'Giran', money: npc.price, maxPrice: npc.price,
        purpose, ...(tag ? { tag } : {}), at: Date.now() });
    const seed = new DatabaseSync(fixture.world);
    seed.exec(fs.readFileSync(path.resolve(__dirname, '../database/sql/sqlite.sql'), 'utf8'));
    seed.exec("INSERT INTO accounts(username,password) VALUES('bot_clan_errand','fixture')");
    const character = seed.prepare(`INSERT INTO characters(id,username,name,classId,race,level,exp,sp,maxHp,maxMp,hp,mp,
        sex,face,hair,hairColor,locX,locY,locZ,newbie,newbieShotsReceived)
        VALUES(?,'bot_clan_errand',?,0,0,30,?,0,187,74,187,74,0,0,0,0,83396,147904,-3400,-1,0)`);
    for (let id = nextId; id < nextId + 20; id++) character.run(id, `Errand${id}`, Number(Data.experience[29]));
    seed.close();
    await Database.init();
    const originalPay = Database.payClanMember;
    const payments = [];
    let payResult = { ok: true };
    Database.payClanMember = async payment => { payments.push(payment); return payResult.ok ? { ok: true, row: null } : payResult; };
    try {
        await Life.init();
        invoke('GameServer/World/World').user = { sessions: [], revision: 0 };
        const clanErrand = () => errandOf('clan', { clanId: CLAN, clanPart: npc.price });

        // Current member: the purchase is made as before and nothing is refunded.
        const member = await stateFor(CLAN, clanErrand());
        const bought = await Market.tryPurchase(member, { type: 'market_errand' });
        assert.equal(bought.purchased, true, 'a current member still buys');
        assert.equal(await stock(member.characterId, npc.selfId), 1);
        assert.equal(await wallet(member.characterId), WALLET - npc.price);
        assert.deepEqual(payments, []);

        // Ex-member (clanId 0): no purchase, errand gone, the clan credit refunded.
        const left = await stateFor(0, clanErrand());
        await errandGoal(left);
        const dropped = await Market.tryPurchase(left, { type: 'market_errand' });
        assert.equal(dropped.purchased, false);
        assert.equal(Errands.pending(dropped.state).length, 0, 'the errand is gone');
        assert.equal(await stock(left.characterId, npc.selfId), 0, 'nothing bought');
        assert.equal(await wallet(left.characterId), WALLET);
        assert.deepEqual(payments.map(p => [p.clanId, p.characterId, p.amount]), [[CLAN, left.characterId, -npc.price]]);
        assert.equal(Errands.pending(Life.cachedState(left.characterId) || dropped.state).length, 0);
        assert.equal(goalStatus(left.characterId), 'completed', 'the dropped errand ends its market_errand goal');

        // Member of another clan: also not the errand's clan.
        payments.length = 0;
        const other = await stateFor(CLAN + 1, clanErrand());
        const otherResult = await Market.tryPurchase(other, { type: 'market_errand' });
        assert.equal(Errands.pending(otherResult.state).length, 0);
        assert.equal(await stock(other.characterId, npc.selfId), 0);
        assert.equal(payments.length, 1);

        // The town-visit path (finishTownErrands) buys through buyErrand, so it drops it too.
        payments.length = 0;
        const visiting = await stateFor(0, clanErrand());
        const visited = await Market.finishTownErrands(visiting);
        assert.equal(Errands.pending(visited).length, 0);
        assert.equal(await stock(visiting.characterId, npc.selfId), 0);
        assert.deepEqual(payments.map(p => p.amount), [-npc.price]);

        // A failed refund (member_funds_short) does not keep the errand; the credit is not restored.
        payments.length = 0; payResult = { ok: false, code: 'member_funds_short' };
        const broke = await stateFor(0, clanErrand());
        const brokeResult = await Market.tryPurchase(broke, { type: 'market_errand' });
        assert.equal(Errands.pending(brokeResult.state).length, 0, 'the errand is dropped even when the refund fails');
        assert.equal(await stock(broke.characterId, npc.selfId), 0);
        assert.equal(payments.length, 1);
        payResult = { ok: true };

        // A personal (non-clan) errand of a member without a clan is untouched.
        payments.length = 0;
        const personal = await stateFor(0, { ...errandOf('craft_input'), money: 985000, r: 2e-5 }, [77000, 1.3e-5, 15000, 0]);
        const personalResult = await Market.tryPurchase(personal, { type: 'market_errand' });
        assert.equal(personalResult.purchased, true);
        assert.equal(await stock(personal.characterId, npc.selfId), 1);
        assert.deepEqual(payments, []);
        console.log(JSON.stringify({ native: true, npcPrice: npc.price, cases: ['member', 'ex-member', 'other clan', 'town visit', 'refund fails', 'personal'] }));
    } finally {
        Database.payClanMember = originalPay;
        Afk._resetForTests();
        await Database.close();
        fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
