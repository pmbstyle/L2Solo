const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
require('../src/Global');
const Database = invoke('Database');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Clan = invoke('GameServer/Clan/ClanService');
const World = invoke('GameServer/World/World');
const Response = invoke('GameServer/Network/Response');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const Seeder = invoke('GameServer/Bot/Population/GeneratedColdSeeder');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-name-migration-'));
options.default.Database.path = path.join(directory, 'world.sqlite');
const query = (sql, args = []) => Database.execute([sql, args]);
const originals = { user: World.user, userInfo: Response.userInfo, charInfo: Response.charInfo };
function session(id, clanId, name) {
    const model = { name };
    return { packets: [], broadcasts: [], name,
        actor: { model, fetchId: () => id, fetchClanId: () => clanId, fetchName: () => model.name,
            fetchLevel: () => 40, fetchClassId: () => 4, fetchIsOnline: () => true },
        dataSendToMe(packet) { this.packets.push(packet); },
        dataSendToOthers(packet) { this.broadcasts.push(packet); }
    };
}
(async () => {
    Database.init();
    await query("INSERT INTO accounts(username,password) VALUES ('bot_pop_names','test-only')");
    for (const [id, name] of [[1, 'OldBotName'], [2, 'PlayerLeader'], [3, 'MissingState']]) {
        await query(`INSERT INTO characters(id,username,name,clanId,classId,race,level,maxHp,maxMp,sex,face,hair,hairColor,locX,locY,locZ)
            VALUES (?,'bot_pop_names',?,7,4,0,40,500,250,0,0,0,0,100,100,0)`, [id, name]);
    }
    await query("INSERT INTO clans(id,name,leaderId) VALUES (7,'Legion',2)");
    const stats = { generatedCold: true, generatedIndex: 100, nameGeneratorVersion: 2, clanId: 7, classId: 4,
        marketStore: { storeType: 1, town: 'Giran', expiresAt: Date.now() + 600000,
            items: [{ selfId: 1864, count: 10, price: 50 }] } };
    await query(`INSERT INTO bot_life_state(characterId,accountName,characterName,level,activity,phase,statsJson,inventorySummary,updatedAt)
        VALUES (1,'bot_pop_names','OldBotName',40,'merchant','cold',?,'{}',1)`, [JSON.stringify(stats)]);
    const [row] = await query('SELECT * FROM bot_life_state WHERE characterId=1');
    Life.acceptLifecycleRow(row);
    await Clan.reload();
    const player = session(2, 7, 'PlayerLeader'), outsider = session(9, 8, 'Outsider');
    World.user = { sessions: [player, outsider] };
    AfkTrade.refreshRecord({ id: 1, ownerId: 1, ownerName: 'OldBotName', ownerAccount: 'bot_pop_names', kind: 'sell_ad',
        storeType: 1, status: 'active', town: 'Giran', title: '', revision: 1, expiresAt: 0, locX: 0, locY: 0, locZ: 0,
        lines: [{ id: 1, selfId: 1864, name: 'Stem', count: 10, price: 50 }] });
    const boardName = () => AfkTrade.offers(1864, AfkTrade.SELL, { town: 'Giran' })[0].sourceName;
    assert.strictEqual(boardName(), 'OldBotName');
    const migrated = await Life.acceptNameMetadata(1, 'NewBotName', 3);
    assert.strictEqual(Clan.findById(7).members.find(member => member.id === 1).name, 'NewBotName');
    assert.deepStrictEqual(player.packets.map(packet => packet[0]), [0x82, 0x53]);
    const packet = player.packets[1];
    assert(packet.includes(Buffer.from('NewBotName\0', 'utf16le')));
    assert(!packet.includes(Buffer.from('OldBotName\0', 'utf16le')), 'full roster must discard the old name');
    assert.strictEqual(outsider.packets.length, 0);
    assert.strictEqual(Clan.liveMember({ id: 1, name: 'StaleClanCache' }).name, 'NewBotName');
    assert.strictEqual(boardName(), 'NewBotName');
    assert.strictEqual(await Seeder.migratePopulationNames([migrated]), 0, 'repeated migration must leave new names alone');
    const [stored] = await query('SELECT characterName,statsJson FROM bot_life_state WHERE characterId=1');
    assert.strictEqual(stored.characterName, 'NewBotName');
    assert.deepStrictEqual(JSON.parse(stored.statsJson), { ...stats, nameGeneratorVersion: 3 });
    assert.strictEqual((await query('SELECT name FROM characters WHERE id=1'))[0].name, 'NewBotName');
    await assert.rejects(Database.updateGeneratedBotName(3, 'MustRollBack', 3), /target missing/);
    assert.strictEqual((await query('SELECT name FROM characters WHERE id=3'))[0].name, 'MissingState');

    const hot = session(1, 7, 'NewBotName');
    hot.coldLifeState = migrated;
    hot.coldMarketState = migrated;
    World.user.sessions.push(hot);
    Response.userInfo = actor => Buffer.from(`self:${actor.fetchName()}`);
    Response.charInfo = actor => Buffer.from(`world:${actor.fetchName()}`);
    await Life.acceptNameMetadata(1, 'HotBotName', 4);
    assert.strictEqual(hot.actor.fetchName(), 'HotBotName');
    assert.strictEqual(hot.name, 'HotBotName');
    assert.strictEqual(hot.coldLifeState.name, 'HotBotName');
    assert.strictEqual(hot.coldMarketState.stats.nameGeneratorVersion, 4);
    assert(hot.packets.some(p => p.toString() === 'self:HotBotName'));
    assert(hot.broadcasts.some(p => p.toString() === 'world:HotBotName'));
    assert.strictEqual(Clan.membersForDisplay(Clan.findById(7)).find(member => member.id === 1).name, 'HotBotName');
    assert.strictEqual(boardName(), 'HotBotName');
    console.log('Bot name migration: atomic storage, C4 clan roster, hot sessions, cold display and board identity passed');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    World.user = originals.user;
    Response.userInfo = originals.userInfo;
    Response.charInfo = originals.charInfo;
    await Database.close();
    fs.rmSync(directory, { recursive: true, force: true });
});
