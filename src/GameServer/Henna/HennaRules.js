'use strict';
const symbols = require('../../../data/Henna/c4-henna.json').symbols;
const trees = require('../../../data/Henna/c4-henna-trees.json').trees;
const ClassProgression = require('../ClassProgression');
const STAT_KEYS = ['STR','DEX','CON','INT','WIT','MEN'];
const byId = new Map(symbols.map(row => [row.id, row]));
function availableForClass(classId) { return (trees[Number(classId)] || []).map(id => byId.get(id)).filter(Boolean); }
function slotsForClass(classId) { return Math.min(3, ClassProgression.lineage(classId).length); }
function totals(slots = []) { return Object.fromEntries(STAT_KEYS.map(stat => [stat,
    Math.min(5, slots.reduce((sum, id) => sum + Number(byId.get(Number(id))?.[stat] || 0), 0))])); }
module.exports = { STAT_KEYS, availableForClass, slotsForClass, totals, symbol: id => byId.get(Number(id)) || null };
