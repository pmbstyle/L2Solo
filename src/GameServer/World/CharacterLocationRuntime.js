'use strict';

const CharacterLocationIndex = require('./CharacterLocationIndex');
const index = new CharacterLocationIndex({ legacyStateCache: true });
let current = null;

function bindWorld(user) {
    if (user != null && (typeof user !== 'object' && typeof user !== 'function')) {
        throw new TypeError('invalid_character_world_source');
    }
    if (current?.source === user) return current;
    if (!current && user == null) return null;
    index.clearSourceView('actor');
    current = user == null ? null : Object.freeze({ source: user, token: Symbol('character-world') });
    return current;
}

function isCurrentWorld(user, binding) {
    return !!binding && binding === current && binding.source === user;
}

module.exports = Object.freeze({ index, bindWorld, isCurrentWorld });
