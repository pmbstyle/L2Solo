'use strict';

// What a bot may buy where (Group F, our rule until the 3.6 production chain):
// an NPC shop sells it what it lists, graded shots only while static shots are
// on (allowsNpcShot); a configured city store sells it only shots, while they
// are on (allowsFixedShot). Every bot purchase and its price read these
// (MarketOpportunity.botCanBuy, StaticMerchantPricing.cheapestPurchase forBot).
const NO_GRADE_SHOTS = new Set([1835, 2509, 3947]);
const GRADED_SHOTS = new Set([1463, 1464, 1465, 1466, 1467, 2510, 2511, 2512, 2513, 2514, 3948, 3949, 3950, 3951, 3952]);
const config = () => invoke('GameServer/Bot/Population/PopulationConfig');
function buyersDisabled() { return config().staticBuyersDisabled === true; }
function shotsDisabled() { return config().staticShotsDisabled === true; }
function allowsFixedShot(id) { return !shotsDisabled() && (NO_GRADE_SHOTS.has(Number(id)) || GRADED_SHOTS.has(Number(id))); }
function allowsNpcShot(id) { return !shotsDisabled() || !GRADED_SHOTS.has(Number(id)); }
module.exports = { buyersDisabled, shotsDisabled, allowsFixedShot, allowsNpcShot, NO_GRADE_SHOTS, GRADED_SHOTS };
