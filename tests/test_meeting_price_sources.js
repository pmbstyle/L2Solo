'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
invoke('GameServer/DataCache').init();
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
const Refusals = require('../src/GameServer/Bot/Economy/MeetingPriceRefusals');
const Production = require('../src/GameServer/Bot/Economy/ProductionPolicy');
const board = new BoardIndex({ groupOf: invoke('GameServer/Bot/Economy/MarketCounters').counterOf });
const put = (revision, price, selfId = 1459) => board.put({ id: 10, ownerId: 20,
    storeType: 1, custodyPolicy: 0, kind: 'shop', town: 'Giran', revision,
    lines: [{ lineId: 11, selfId, count: 100, price }] });
put(1, 100);
const purchase = { selfId: 1459, enchant: 0, units: 50, cost: 10000 };
const group = invoke('GameServer/Bot/Economy/MarketCounters').counterOf(purchase.selfId);
let market = 1, workshop = '1:2:3';
const readers = { meetingRevisionOf: () => market, workshopDigest: () => workshop };
const base = { purchase, scopes: [group], npcAllowed: Production.allowsNpcShot(purchase.selfId) };
const proof = exact => ({ ...base, ...(exact ? { items: [purchase.selfId] } : {}),
    source: Refusals.fingerprint(exact
        ? [[[purchase.selfId, board.itemFingerprint(purchase.selfId)]], [[group, market, workshop]]]
        : [[group, board.groupFingerprint(group), market, workshop]]) });
for (const exact of [false, true]) {
    const current = () => Refusals.sourceCheck(board, proof(exact), readers);
    let check = current(); assert(check());
    market++; assert(!check(), 'a changed trade counter reopens the fill');
    check = current(); workshop = '2:3:4'; assert(!check(), 'changed workshop supply reopens the fill');
    check = current(); put(2, 110); assert(!check(), 'a changed board source reopens the fill');
    check = current(); put(3, 120, 1458);
    assert(!check(), 'removing the witnessed item invalidates the proof');
    put(1, 100); market = 1; workshop = '1:2:3';
}
const offers = [[10, 11, 1, 50, 100]];
const evidence = { ...base, scopes: [], offers, fundingDominance: true };
const backed = Refusals.sourceCheck(board, evidence, readers);
assert(backed());
offers[0][3] = 101;
assert(backed(), 'retained proof rows are independent of the preparation-owned arrays');
put(2, 100);
assert(!backed(), 'changed backed stock invalidates a dominance proof');
const npcOnly = Refusals.sourceCheck(board, { ...evidence, offers: [] }, readers);
assert(npcOnly(), 'an NPC-only dominance proof survives unrelated board changes');
const allowsNpcShot = Production.allowsNpcShot;
try {
    Production.allowsNpcShot = () => !base.npcAllowed;
    assert(!npcOnly(), 'the NPC supply policy still invalidates the retained proof');
} finally { Production.allowsNpcShot = allowsNpcShot; }
assert(!Refusals.sourceCheck(board, { ...evidence, offers: [], fundingDominance: false }, readers)());
const admission = 'recipe-production:0';
const admissionProof = { ...proof(true), admissionScope: admission,
    admission: Refusals.admissionFingerprint(board, admission) };
assert(Refusals.sourceCheck(board, admissionProof, readers)());
assert(!Refusals.sourceCheck(board, { ...admissionProof, admission: 'obsolete' }, readers)(),
    'the production admission fingerprint remains part of the proof');
console.log('PASS compact meeting refusal sources preserve exact, category, backed, NPC and admission invalidation');
