const assert = require('assert');
const fs = require('fs');
const os = require('os');
const nodePath = require('path');
require('../src/Global');

const Database = invoke('Database');
const SavedLocations = invoke('GameServer/World/Generics/NpcBypasses/AdminSavedLocations');
const Generics = invoke(path.actor);
const originalTeleport = Generics.teleportTo;
const directory = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'saved-locations-'));
options.default.Database.path = nodePath.join(directory, 'test.sqlite');

function character(name) {
    return { name, race: 0, classId: 0, maxHp: 100, maxMp: 100, sex: 0, face: 0,
        hair: 0, hairColor: 0, locX: 10, locY: 20, locZ: -30 };
}

function session(id) {
    return {
        actor: { fetchId: () => id, fetchLocX: () => 101.4, fetchLocY: () => -202.4,
            fetchLocZ: () => -303, fetchHead: () => 1234 },
        packets: [],
        dataSendToMe(packet) { this.packets.push(packet); }
    };
}

function html(client) {
    const packet = client.packets.filter((entry) => entry[0] === 0x0f).at(-1);
    assert.ok(packet, 'the menu sends NpcHtml');
    return packet.subarray(5).toString('utf16le').split('\0')[0];
}

(async () => {
    Database.init();
    await Database.createAccount('saved_locations', 'test');
    const ownerId = (await Database.createCharacter('saved_locations', character('Owner'))).insertId;
    const otherId = (await Database.createCharacter('saved_locations', character('Other'))).insertId;
    const owner = session(ownerId);
    const other = session(otherId);
    assert.ok(utils.parseRawFile('data/Html/Admin/teleport.html').includes('admin-saved-locations'));
    await SavedLocations(owner, ['admin-saved-locations']);
    assert.ok(html(owner).includes('No saved locations yet.'));
    assert.ok(html(owner).includes('<edit var="location_name" width=240 height=15 length=40>'),
        'C4 input fields need explicit dimensions');
    assert.ok(/<button\b[^>]*action="bypass -h admin-saved-locations save \$location_name"/.test(html(owner)),
        'submit edit variables using a C4 form button');
    await SavedLocations(owner, ['admin-saved-locations', 'save', 'My', '<camp>', '&', '"home"']);
    const [saved] = await Database.fetchSavedLocations(ownerId);
    assert.strictEqual(saved.name, 'My <camp> & "home"');
    assert.deepStrictEqual([saved.locX, saved.locY, saved.locZ, saved.head], [101, -202, -303, 1234]);
    assert.ok(html(owner).includes('My &lt;camp&gt; &amp; &quot;home&quot;'));

    let destination;
    Generics.teleportTo = (client, actor, coords) => {
        assert.strictEqual(client, owner);
        assert.strictEqual(actor, owner.actor);
        destination = coords;
        return true;
    };
    await SavedLocations(other, ['admin-saved-locations', 'go', String(saved.id)]);
    assert.strictEqual(destination, undefined, 'another character cannot use the saved id');
    await SavedLocations(other, ['admin-saved-locations', 'delete', String(saved.id)]);
    assert.strictEqual((await Database.fetchSavedLocations(ownerId)).length, 1);
    await SavedLocations(owner, ['admin-saved-locations', 'go', String(saved.id)]);
    assert.deepStrictEqual(destination, { locX: 101, locY: -202, locZ: -303, head: 1234 });
    Generics.teleportTo = () => false;
    await SavedLocations(owner, ['admin-saved-locations', 'go', String(saved.id)]);
    assert.ok(html(owner).includes('Cannot teleport right now.'));

    for (let i = 0; i < 8; i++) await SavedLocations(owner, ['admin-saved-locations', 'save']);
    assert.ok(html(owner).includes('Page 1 / 2'));
    assert.strictEqual((html(owner).match(/>Teleport<\/a>/g) || []).length, 8);
    await SavedLocations(owner, ['admin-saved-locations', 'page', '1']);
    assert.ok(html(owner).includes('Page 2 / 2'));
    assert.strictEqual((html(owner).match(/>Teleport<\/a>/g) || []).length, 1);
    assert.ok(html(owner).length < 8192);

    await Database.close();
    Database.init();
    assert.strictEqual((await Database.fetchSavedLocations(ownerId)).length, 9, 'locations survive reopening SQLite');
    const reconnected = session(ownerId);
    await SavedLocations(reconnected, ['admin-saved-locations', 'page', '1']);
    assert.ok(html(reconnected).includes('My &lt;camp&gt;'));
    await SavedLocations(reconnected, ['admin-saved-locations', 'delete', String(saved.id), '1']);
    assert.strictEqual((await Database.fetchSavedLocations(ownerId)).length, 8);
    assert.ok(html(reconnected).includes('Page 1 / 1'), 'deleting the last row on a page clamps navigation');
    await SavedLocations(reconnected, ['admin-saved-locations', 'go', String(saved.id)]);
    assert.ok(html(reconnected).includes('Location no longer exists.'));
    await SavedLocations(reconnected, ['admin-saved-locations', 'delete', '1 OR 1=1']);
    assert.strictEqual((await Database.fetchSavedLocations(ownerId)).length, 8);
    owner.actor.fetchLocX = () => NaN;
    await SavedLocations(owner, ['admin-saved-locations', 'save', 'Invalid']);
    assert.strictEqual((await Database.fetchSavedLocations(ownerId)).length, 8);
    await Database.deleteCharacter('saved_locations', 'Owner');
    assert.deepStrictEqual(await Database.fetchSavedLocations(ownerId), [], 'character deletion clears saved locations');
    console.log('Saved location persistence, ownership, teleport and menu checks passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(async () => {
    Generics.teleportTo = originalTeleport;
    await Database.close();
    fs.rmSync(directory, { recursive: true, force: true });
});
