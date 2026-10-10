const assert = require('assert');

require('../src/Global');

// E197: developer telemetry counts gatekeeper fares paid and short per path
// (cold state, hot backpack); a short fare is refused as before.
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const Diagnostics = invoke('GameServer/Bot/Economy/EconomyDiagnostics');
const TripPayment = invoke('GameServer/Bot/Travel/TripPayment');

Config.developerDiagnostics = true;
Diagnostics.stop();

const state = adena => ({ adena, inventory: { 57: { selfId: 57, amount: adena }, 736: { amount: 1 } } });

assert.strictEqual(TripPayment.payCold(state(1000), { scroll: true, fee: 2900 }), null, 'a short cold fare is refused');
const paid = TripPayment.payCold(state(5000), { scroll: true, fee: 2900 });
assert.strictEqual(paid.adena, 2100);
assert.strictEqual(paid.inventory['736'].amount, 0);
assert.ok(TripPayment.payCold(state(5000), { scroll: true, fee: 0 }), 'a scroll-only trip pays no fare');
assert.strictEqual(TripPayment.fareShort('hot', 2900, 1000), true);
assert.strictEqual(TripPayment.fareShort('hot', 2900, 2900), false);

assert.deepStrictEqual(Diagnostics.metrics().counts, {
    'trip_fare:short:cold': 1, 'trip_fare:covered:cold': 1, 'trip_fare:short:hot': 1, 'trip_fare:covered:hot': 1
});

Config.developerDiagnostics = false;
Diagnostics.stop();
assert.strictEqual(TripPayment.fareShort('hot', 2900, 1000), true, 'off: the rule is unchanged');
assert.deepStrictEqual(Diagnostics.metrics(), { enabled: false });

console.log('test_trip_fare_diagnostics: ok');
