require('../src/Global');
const assert = require('assert');
const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');

const cases = [
    ['Talking Island', -84108, 244604, '17_25'],
    ['Gludin', -80752, 149776, '17_22'],
    ['Gludio', -12736, 122816, '19_21'],
    ['Dion', 15631, 142885, '20_22'],
    ['Oren', 82960, 53177, '22_19'],
    ['Giran', 113845, 144186, '23_22'],
    ['Aden', 147450, 26741, '24_18'],
    ['Dwarven Village', 116226, -178529, '23_12'],
    ['Antharas', 185708, 114298, '25_21']
];

for (const [name, x, y, expected] of cases) {
    assert.strictEqual(GeodataEngine.getRegionKey(x, y), expected, name);
}

console.log('Geodata region mapping checks passed');
