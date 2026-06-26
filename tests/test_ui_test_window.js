const assert = require('assert');

require('../src/Global');

const NpcTalkResponse = invoke('GameServer/World/Generics/NpcTalkResponse');
const UiTest = invoke('GameServer/World/Generics/NpcBypasses/UiTest');
const Speak = invoke('GameServer/Network/Request/Speak');
const SendPacket = invoke('Packet/Send');

function actor(id = 2000001) {
    return {
        fetchId: () => id,
        fetchName: () => 'UiTester'
    };
}

function session() {
    return {
        actor: actor(),
        packets: [],
        dataSendToMe(packet) {
            this.packets.push(packet);
        }
    };
}

function htmlFromNpcPacket(packet) {
    assert.strictEqual(packet[0], 0x0f, 'UI lab should render through NpcHtmlMessage');
    const start = 5;
    for (let i = start; i + 1 < packet.length; i += 2) {
        if (packet[i] === 0x00 && packet[i + 1] === 0x00) {
            return packet.toString('ucs2', start, i);
        }
    }
    throw new Error('NpcHtmlMessage did not contain a terminated UTF-16 html string');
}

function sendChat(targetSession, text) {
    const packet = new SendPacket(0x38);
    packet
        .writeS(text)
        .writeD(0);
    Speak(targetSession, packet.fetchBuffer());
}

const directSession = session();
UiTest.render(directSession);
let html = htmlFromNpcPacket(directSession.packets.pop());

assert.ok(html.includes('Custom HTML UI Lab'), 'overview should identify the test window');
assert.ok(html.includes('ui-test page buttons'), 'overview should expose tab bypasses');
assert.ok(html.includes('CH3 buttons render cleaner'), 'overview should document the observed button texture winner');
assert.ok(html.includes('outer frame title as Chat'), 'overview should document the fixed client title');
assert.ok(html.includes('chars:'), 'overview should show payload size diagnostics');

NpcTalkResponse(directSession, { link: 'ui-test page inputs' });
html = htmlFromNpcPacket(directSession.packets.pop());
assert.ok(html.includes('<edit var="ui_name"'), 'inputs tab should render an edit field');
assert.ok(html.includes('<combobox var="ui_choice"'), 'inputs tab should render a combobox');
assert.ok(html.includes('ui-test submit $ui_name $ui_amount $ui_choice'), 'inputs tab should submit client variables');

NpcTalkResponse(directSession, { link: 'ui-test submit Slava 42 Party' });
html = htmlFromNpcPacket(directSession.packets.pop());
assert.ok(html.includes('Bypass Result'), 'submit should echo the bypass result');
assert.ok(html.includes('Slava'), 'submit should preserve the first submitted argument');
assert.ok(html.includes('42'), 'submit should preserve the second submitted argument');
assert.ok(html.includes('Party'), 'submit should preserve the combobox argument');

NpcTalkResponse(directSession, { link: 'ui-test toggle-checkbox' });
html = htmlFromNpcPacket(directSession.packets.pop());
assert.ok(html.includes('Checkbox Texture Probe'), 'toggle should return to the buttons tab');
assert.ok(html.includes('ON'), 'toggle should store visible state in the session');

NpcTalkResponse(directSession, { link: 'ui-test stress 60' });
html = htmlFromNpcPacket(directSession.packets.pop());
assert.ok(html.includes('#25'), 'stress tab should allow the capped edge row');
assert.ok(!html.includes('#26'), 'stress tab should cap dangerous legacy-client payloads');

const chatSession = session();
sendChat(chatSession, '.uitest');
html = htmlFromNpcPacket(chatSession.packets.pop());
assert.ok(html.includes('Custom HTML UI Lab'), '.uitest chat command should open the UI lab');

const adminHtml = utils.parseRawFile('data/Html/Admin/main.html');
assert.ok(adminHtml.includes('bypass -h ui-test'), 'admin panel should link to the UI lab');

console.log('UI test window checks passed');
