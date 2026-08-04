const MIN_PREFIX_LENGTH = 4;

const VOCATIVE_PREFIXES = new Set(['hey', 'hi', 'yo', 'ok', 'okay', 'please']);

function textTokens(text) {
    const source = String(text || '');
    const tokens = [];
    const expression = /[A-Za-z0-9_]+/g;
    let match;
    while ((match = expression.exec(source)) !== null) {
        tokens.push({
            value: match[0].toLowerCase(),
            start: match.index,
            end: match.index + match[0].length
        });
    }
    return tokens;
}

function nameVariants(name) {
    const full = String(name || '').trim().toLowerCase();
    if (!full) return [];

    const variants = [full];
    const withoutBotPrefix = full.replace(/^bot_/, '');
    if (withoutBotPrefix && withoutBotPrefix !== full) variants.push(withoutBotPrefix);
    return [...new Set(variants)];
}

function candidateName(candidate) {
    if (candidate?.name) return String(candidate.name);
    const actor = candidate?.session?.actor || candidate?.actor;
    return typeof actor?.fetchName === 'function' ? actor.fetchName() : '';
}

function candidateId(candidate) {
    if (candidate?.id !== undefined && candidate?.id !== null) return candidate.id;
    const actor = candidate?.session?.actor || candidate?.actor;
    return typeof actor?.fetchId === 'function' ? actor.fetchId() : candidateName(candidate);
}

function hasExactVariant(tokens, variantTokens) {
    if (variantTokens.length === 0) return false;
    for (let index = 0; index <= tokens.length - variantTokens.length; index += 1) {
        if (variantTokens.every((value, offset) => tokens[index + offset].value === value)) return true;
    }
    return false;
}

function isVocativeToken(tokens, index, source) {
    if (index === 0) return true;
    const previous = tokens[index - 1]?.value;
    if (VOCATIVE_PREFIXES.has(previous)) return true;

    const token = tokens[index];
    const after = source.slice(token.end);
    return /^[\s]*[,!:]/.test(after);
}

function editDistanceAtMostOne(left, right) {
    if (left === right) return true;
    if (Math.abs(left.length - right.length) > 1) return false;

    let leftIndex = 0;
    let rightIndex = 0;
    let edits = 0;
    while (leftIndex < left.length && rightIndex < right.length) {
        if (left[leftIndex] === right[rightIndex]) {
            leftIndex += 1;
            rightIndex += 1;
            continue;
        }
        edits += 1;
        if (edits > 1) return false;
        if (left.length > right.length) leftIndex += 1;
        else if (right.length > left.length) rightIndex += 1;
        else {
            leftIndex += 1;
            rightIndex += 1;
        }
    }
    if (leftIndex < left.length || rightIndex < right.length) edits += 1;
    return edits <= 1;
}

function resolve(text, candidates = [], options = {}) {
    const source = String(text || '');
    const tokens = textTokens(source);
    const normalizedCandidates = candidates
        .map((candidate) => ({
            candidate,
            id: candidateId(candidate),
            name: candidateName(candidate),
            variants: nameVariants(candidateName(candidate))
        }))
        .filter((entry) => entry.variants.length > 0);

    const exactMatches = normalizedCandidates.filter((entry) => (
        entry.variants.some((variant) => hasExactVariant(tokens, variant.split(/\s+/g)))
    ));
    if (exactMatches.length === 1) {
        return {
            status: 'matched',
            candidate: exactMatches[0].candidate,
            matches: [exactMatches[0].candidate],
            alias: exactMatches[0].name,
            matchType: 'full_name'
        };
    }
    if (exactMatches.length > 1) {
        return {
            status: 'ambiguous',
            candidate: null,
            matches: exactMatches.map((entry) => entry.candidate),
            alias: null,
            matchType: 'full_name'
        };
    }

    const minPrefixLength = Math.max(
        MIN_PREFIX_LENGTH,
        Number(options.minPrefixLength || MIN_PREFIX_LENGTH)
    );
    const prefixMatches = [];
    tokens.forEach((token, index) => {
        if (token.value.length < minPrefixLength || !isVocativeToken(tokens, index, source)) return;
        normalizedCandidates.forEach((entry) => {
            if (entry.variants.some((variant) => {
                const variantToken = variant.split(/\s+/g)[0];
                return variantToken.length > token.value.length && variantToken.startsWith(token.value);
            })) {
                if (!prefixMatches.some((match) => match.id === entry.id)) prefixMatches.push(entry);
            }
        });
    });

    if (prefixMatches.length === 1) {
        return {
            status: 'matched',
            candidate: prefixMatches[0].candidate,
            matches: [prefixMatches[0].candidate],
            alias: prefixMatches[0].name,
            matchType: 'unique_prefix'
        };
    }
    if (prefixMatches.length > 1) {
        return {
            status: 'ambiguous',
            candidate: null,
            matches: prefixMatches.map((entry) => entry.candidate),
            alias: null,
            matchType: 'ambiguous_prefix'
        };
    }

    // Party chat commonly contains a one-character typo in a name. Only accept
    // it in a vocative position and only when it identifies one roster member;
    // ordinary words elsewhere in the sentence must never become addresses.
    const fuzzyMatches = [];
    tokens.forEach((token, index) => {
        if (token.value.length < minPrefixLength || !isVocativeToken(tokens, index, source)) return;
        normalizedCandidates.forEach((entry) => {
            if (entry.variants.some((variant) => editDistanceAtMostOne(token.value, variant.split(/\s+/g)[0]))) {
                if (!fuzzyMatches.some((match) => match.id === entry.id)) fuzzyMatches.push(entry);
            }
        });
    });
    if (fuzzyMatches.length === 1) {
        return {
            status: 'matched',
            candidate: fuzzyMatches[0].candidate,
            matches: [fuzzyMatches[0].candidate],
            alias: fuzzyMatches[0].name,
            matchType: 'fuzzy_name'
        };
    }
    if (fuzzyMatches.length > 1) {
        return {
            status: 'ambiguous',
            candidate: null,
            matches: fuzzyMatches.map((entry) => entry.candidate),
            alias: null,
            matchType: 'ambiguous_fuzzy_name'
        };
    }

    return { status: 'none', candidate: null, matches: [], alias: null, matchType: null };
}

module.exports = {
    MIN_PREFIX_LENGTH,
    editDistanceAtMostOne,
    nameVariants,
    resolve
};
