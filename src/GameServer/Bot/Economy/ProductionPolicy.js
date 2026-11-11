'use strict';

// Configured shot merchants are a priced reserve alongside public crafters.
// The optional disable switch removes that reserve and NPC graded shots;
// ordinary NPC non-shot stock remains available. Purchases and prices read
// the same policy through MarketOpportunity.botCanBuy and
// StaticMerchantPricing.cheapestPurchase with forBot.
const NO_GRADE_SHOTS = new Set([1835, 2509, 3947]);
const GRADED_SHOTS = new Set([1463, 1464, 1465, 1466, 1467, 2510, 2511, 2512, 2513, 2514, 3948, 3949, 3950, 3951, 3952]);
const config = () => invoke('GameServer/Bot/Population/PopulationConfig');
function buyersDisabled() { return config().staticBuyersDisabled === true; }
function shotsDisabled() { return config().staticShotsDisabled === true; }
function allowsFixedShot(id) { return !shotsDisabled() && (NO_GRADE_SHOTS.has(Number(id)) || GRADED_SHOTS.has(Number(id))); }
function allowsNpcShot(id) { return !shotsDisabled() || !GRADED_SHOTS.has(Number(id)); }
module.exports = { buyersDisabled, shotsDisabled, allowsFixedShot, allowsNpcShot, NO_GRADE_SHOTS, GRADED_SHOTS };
