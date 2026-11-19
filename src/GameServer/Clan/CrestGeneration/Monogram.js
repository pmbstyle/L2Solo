const MONOGRAM_COLORS = {
    gold: [253, 217, 112],
    silver: [222, 232, 244],
    red: [252, 122, 118],
    green: [136, 229, 126],
    blue: [124, 186, 253],
    violet: [209, 157, 246]
};

const GLYPHS = {
    A: '..##.. .####. ##..## ##..## ###### ##..## ##..## ##..##',
    B: '#####. ##..## ##..## #####. #####. ##..## ##..## #####.',
    C: '.##### ##.... ##.... ##.... ##.... ##.... ##.... .#####',
    D: '#####. ##..## ##..## ##..## ##..## ##..## ##..## #####.',
    E: '###### ##.... ##.... #####. #####. ##.... ##.... ######',
    F: '###### ##.... ##.... #####. #####. ##.... ##.... ##....',
    G: '.##### ##.... ##.... ##.... ##.### ##..## ##..## .#####',
    H: '##..## ##..## ##..## ###### ###### ##..## ##..## ##..##',
    I: '###### ..##.. ..##.. ..##.. ..##.. ..##.. ..##.. ######',
    J: '..#### ....## ....## ....## ....## ##..## ##..## .####.',
    K: '##..## ##..## ##.##. ####.. ####.. ##.##. ##..## ##..##',
    L: '####.... .##..... .##..... .##..... .##..... .##....# .####### ########',
    M: '##....## ###..### ######## ##.##.## ##....## ##....## ##....## ##....##',
    N: '##...## ###..## ###..## ####.## ##.#### ##..### ##..### ##...##',
    O: '.####. ##..## ##..## ##..## ##..## ##..## ##..## .####.',
    P: '#####. ##..## ##..## #####. #####. ##.... ##.... ##....',
    Q: '.#####. ##...## ##...## ##...## ##...## ##.#.## .#####. .....##',
    R: '#####. ##..## ##..## #####. ####.. ##.##. ##..## ##..##',
    S: '.##### ##.... ##.... .####. .####. ....## ....## #####.',
    T: '###### ###### ..##.. ..##.. ..##.. ..##.. ..##.. ..##..',
    U: '##..## ##..## ##..## ##..## ##..## ##..## ##..## .####.',
    V: '##....## ##....## ##....## .##..##. .##..##. ..####.. ..####.. ...##...',
    W: '##....## ##....## ##....## ##.##.## ##.##.## ######## .##..##. .##..##.',
    X: '##....## .##..##. ..####.. ...##... ...##... ..####.. .##..##. ##....##',
    Y: '##....## .##..##. ..####.. ...##... ...##... ...##... ...##... ...##...',
    Z: '###### ###### ...##. ..##.. .##... ##.... ###### ######'
};

function normalizeMonogram(value) {
    if (value === undefined) return '';
    if (typeof value !== 'string') return null;
    const letter = value.trim();
    if (!letter) return '';
    return /^[a-z]$/i.test(letter) ? letter.toUpperCase() : null;
}

function normalizeMonogramColor(value) {
    if (value === undefined || value === '') return 'gold';
    return typeof value === 'string' && Object.hasOwn(MONOGRAM_COLORS, value) ? value : null;
}

function nearestToken(palette, color) {
    let token = 0;
    let nearest = Infinity;
    for (const [index, rgb] of palette.entries()) {
        const distance = rgb.reduce((total, channel, i) => total + (channel - color[i]) ** 2, 0);
        if (distance < nearest) {
            token = index;
            nearest = distance;
        }
    }
    return BigInt(token);
}

function monogramTokens(letter, palette, width, height, color = 'gold') {
    const tokens = new Map();
    if (!letter) return tokens;

    const rows = GLYPHS[letter].split(' ');
    const left = Math.floor((width - rows[0].length) / 2);
    const top = Math.floor((height - rows.length) / 2);
    const fill = nearestToken(palette, MONOGRAM_COLORS[color]);
    const dark = nearestToken(palette, [25, 12, 21]);
    const glyph = [];
    for (const [y, row] of rows.entries()) {
        for (const [x, mark] of Array.from(row).entries()) {
            if (mark === '#') glyph.push((top + y) * width + left + x);
        }
    }
    // Centering the glyph leaves room for a dark pixel on all eight sides of every stroke.
    for (const pixel of glyph) {
        for (const dy of [-1, 0, 1]) {
            for (const dx of [-1, 0, 1]) tokens.set(pixel + dy * width + dx, dark);
        }
    }
    for (const pixel of glyph) tokens.set(pixel, fill);
    return tokens;
}

module.exports = { monogramColors: Object.keys(MONOGRAM_COLORS), normalizeMonogram, normalizeMonogramColor, monogramTokens };
