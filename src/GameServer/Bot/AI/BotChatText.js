const DEFAULT_LINE_LIMIT = 120;
const DEFAULT_MAX_LINES = 3;

function normalize(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
}

function splitLine(text, limit) {
    if (text.length <= limit) return [text, ''];

    const window = text.slice(0, limit + 1);
    const comma = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '));
    const sentence = Math.max(window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '));
    const space = window.lastIndexOf(' ');
    const punctuation = Math.max(comma, sentence);
    const preferredMinimum = Math.floor(limit * 0.45);
    const splitAt = punctuation > preferredMinimum ? punctuation : space;

    if (splitAt > Math.floor(limit * 0.55)) {
        return [text.slice(0, splitAt + 1).trim(), text.slice(splitAt + 1).trim()];
    }

    return [text.slice(0, limit).trim(), text.slice(limit).trim()];
}

function splitForTell(text, options = {}) {
    const limit = Number(options.limit || DEFAULT_LINE_LIMIT);
    const maxLines = Number(options.maxLines || DEFAULT_MAX_LINES);
    const lines = [];
    let rest = normalize(text);

    while (rest && lines.length < maxLines) {
        const [line, next] = splitLine(rest, limit);
        if (!line) break;

        if (next && lines.length === maxLines - 1) {
            const suffix = '...';
            const shortened = line.length + suffix.length > limit
                ? line.slice(0, limit - suffix.length).trimEnd()
                : line;
            lines.push(`${shortened}${suffix}`);
            return lines;
        }

        lines.push(line);
        rest = next;
    }

    return lines;
}

module.exports = {
    DEFAULT_LINE_LIMIT,
    DEFAULT_MAX_LINES,
    normalize,
    splitForTell
};
