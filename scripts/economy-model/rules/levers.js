'use strict';

// The decision layer's registry of situations and levers (economy design):
// each id is a row of the model's specification (SPEC, beside engine.js), and the ids here are
// held equal to that file's situation and lever rows marked built
// (tests/test_economy_model_spec.js). Each situation points at the test the
// plane raises its fact with, each lever at the function that does it.
const Plane = require('../design/plane');

const SITUATIONS = Object.freeze({
    'SIT.BORN': Plane.FACTS.born,
    'SIT.OUT': Plane.FACTS.out,
    'SIT.BAG': Plane.FACTS.bag,
    'SIT.TOWN': Plane.FACTS.town,
    'SIT.DIED': Plane.FACTS.died
});

const LEVERS = Object.freeze({
    'LEV.BUY': Plane.EXECUTORS.buy,
    'LEV.SELL': Plane.EXECUTORS.sell,
    'LEV.STAY': Plane.EXECUTORS.stay
});

module.exports = { SITUATIONS, LEVERS };
