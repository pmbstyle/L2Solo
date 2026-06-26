// Client HTML is not browser HTML. Keep payloads small, prefer links for navigation,
// and use bitmap buttons only for short primary actions near the top of a page.
const HtmlKit = {
    WIDTH: 270,
    COLOR: {
        title: 'LEVEL',
        link: '99CCFF',
        ok: '00FF00',
        warn: 'FFCC00',
        danger: 'FF5555',
        muted: '777777',
        panel: '222222',
        row: '333333',
        weapon: 'FF9900',
        armor: '99CCFF'
    },
    TEXTURE: {
        line: 'L2UI.SquareWhite',
        blank: 'L2UI.SquareBlank',
        defaultButton: 'L2UI_ch3.Btn1_normal',
        defaultButtonDown: 'L2UI_ch3.Btn1_normalOn',
        legacyButton: 'L2UI.DefaultButton',
        legacyButtonDown: 'L2UI.DefaultButton_click'
    }
};

function attrs(values) {
    return Object.keys(values || {})
        .filter((key) => values[key] !== undefined && values[key] !== null && values[key] !== false)
        .map((key) => `${key}=${values[key]}`)
        .join(' ');
}

function esc(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function action(command, hide = true) {
    return `${hide ? 'bypass -h' : 'bypass'} ${esc(command)}`;
}

HtmlKit.esc = esc;

HtmlKit.font = function(value, color = HtmlKit.COLOR.muted) {
    return `<font color="${color}">${esc(value)}</font>`;
};

HtmlKit.br = function(kind = 'br1') {
    return `<${kind}>`;
};

HtmlKit.line = function(texture = HtmlKit.TEXTURE.line, width = HtmlKit.WIDTH, height = 1) {
    return `<img src="${texture}" width=${width} height=${height}><br1>`;
};

HtmlKit.spacer = function(height = 4, width = HtmlKit.WIDTH) {
    return `<img src="${HtmlKit.TEXTURE.blank}" width=${width} height=${height}><br1>`;
};

HtmlKit.img = function(src, width, height) {
    return `<img src="${esc(src)}" width=${width} height=${height}>`;
};

HtmlKit.link = function(label, command, options = {}) {
    const color = options.color || HtmlKit.COLOR.link;
    return `<a action="${action(command, options.hide !== false)}"><font color="${color}">${esc(label)}</font></a>`;
};

HtmlKit.button = function(label, command, options = {}) {
    const width = options.width || 86;
    const height = options.height || 21;
    const fore = options.fore || HtmlKit.TEXTURE.defaultButton;
    const back = options.back || HtmlKit.TEXTURE.defaultButtonDown;
    return `<button value="${esc(label)}" action="${action(command, options.hide !== false)}" width=${width} height=${height} back="${back}" fore="${fore}">`;
};

HtmlKit.cell = function(content, options = {}) {
    const width = options.width ? ` width=${options.width}` : '';
    const align = options.align ? ` align=${options.align}` : '';
    return `<td${width}${align}>${content}</td>`;
};

HtmlKit.row = function(cells) {
    return `<tr>${cells.join('')}</tr>`;
};

HtmlKit.table = function(rows, options = {}) {
    const tableAttrs = attrs({
        width: options.width || HtmlKit.WIDTH,
        bgcolor: options.bgcolor,
        background: options.background
    });
    return `<table ${tableAttrs}>${rows.join('')}</table>`;
};

HtmlKit.columns = function(cells, options = {}) {
    return HtmlKit.table([HtmlKit.row(cells)], options);
};

HtmlKit.section = function(title, body, options = {}) {
    const header = HtmlKit.table([
        HtmlKit.row([
            HtmlKit.cell(HtmlKit.font(title, HtmlKit.COLOR.title))
        ])
    ], {
        width: options.width || HtmlKit.WIDTH,
        bgcolor: options.bgcolor || HtmlKit.COLOR.panel
    });
    return `<br>${header}<br1>${body}`;
};

HtmlKit.keyValueRows = function(rows, options = {}) {
    return HtmlKit.table(rows.map(([label, value]) => HtmlKit.row([
        HtmlKit.cell(esc(label), { width: options.labelWidth || 90 }),
        HtmlKit.cell(value)
    ])), { width: options.width || HtmlKit.WIDTH, bgcolor: options.bgcolor });
};

HtmlKit.statusRow = function(label, value, options = {}) {
    return HtmlKit.row([
        HtmlKit.cell(HtmlKit.font(label, options.labelColor || HtmlKit.COLOR.title), { width: options.labelWidth || 80 }),
        HtmlKit.cell(value, { width: options.valueWidth || 190 })
    ]);
};

HtmlKit.statusTable = function(rows, options = {}) {
    return HtmlKit.table(rows.map(([label, value]) => HtmlKit.statusRow(label, value, options)), {
        width: options.width || HtmlKit.WIDTH,
        bgcolor: options.bgcolor
    });
};

HtmlKit.tabs = function(tabs, active, commandPrefix, options = {}) {
    return HtmlKit.table([
        HtmlKit.row(tabs.map(([id, label]) => {
            const color = id === active ? HtmlKit.COLOR.title : HtmlKit.COLOR.link;
            return HtmlKit.cell(HtmlKit.link(label, `${commandPrefix} ${id}`, { color }), { align: 'center' });
        }))
    ], { width: options.width || HtmlKit.WIDTH });
};

HtmlKit.toggle = function(label, enabled, command, options = {}) {
    const color = enabled ? HtmlKit.COLOR.ok : HtmlKit.COLOR.muted;
    const text = enabled ? (options.onText || 'ON') : (options.offText || 'OFF');
    return HtmlKit.columns([
        HtmlKit.cell(HtmlKit.button(text, command, { width: options.buttonWidth || 75 }), { width: options.labelWidth || 92 }),
        HtmlKit.cell(HtmlKit.link(label || (enabled ? 'Enabled' : 'Disabled'), command, { color, hide: options.hide !== false }))
    ]);
};

HtmlKit.actionFooter = function(actions, options = {}) {
    return HtmlKit.columns(actions.map((item) => HtmlKit.cell(
        HtmlKit.link(item.label, item.command, {
            color: item.color || HtmlKit.COLOR.link,
            hide: item.hide !== false
        }),
        { align: item.align || 'center', width: item.width }
    )), { width: options.width || HtmlKit.WIDTH });
};

HtmlKit.emptyState = function(title, message, actions = []) {
    let body = `${HtmlKit.font(title, HtmlKit.COLOR.title)}<br>`;
    body += `${HtmlKit.font(message, HtmlKit.COLOR.muted)}<br>`;
    if (actions.length > 0) {
        body += '<br1>' + HtmlKit.actionFooter(actions);
    }
    return body;
};

HtmlKit.botCard = function(options = {}) {
    let body = HtmlKit.table([
        HtmlKit.row([
            HtmlKit.cell(HtmlKit.font(options.name || 'Unknown', options.nameColor || HtmlKit.COLOR.ok)),
            HtmlKit.cell(options.badge || '', { align: 'right', width: options.badgeWidth || 75 })
        ])
    ], { width: options.width || HtmlKit.WIDTH, bgcolor: options.bgcolor || HtmlKit.COLOR.row });

    if (options.subtitle) {
        body += HtmlKit.font(options.subtitle, HtmlKit.COLOR.muted) + '<br1>';
    }
    if (options.status) {
        body += options.status + '<br1>';
    }
    if (options.actions && options.actions.length > 0) {
        body += HtmlKit.actionFooter(options.actions);
    }
    return body;
};

HtmlKit.sizeFooter = function(html) {
    return HtmlKit.font(`chars: ${html.length} / ucs2: ${Buffer.byteLength(html, 'ucs2')}`, HtmlKit.COLOR.muted);
};

HtmlKit.page = function(body, options = {}) {
    const width = options.width || HtmlKit.WIDTH;
    const chrome = (footer) => [
        '<html><body>',
        options.title ? `<title>${esc(options.title)}</title>` : '',
        '<center>',
        options.tabs || '',
        HtmlKit.line(HtmlKit.TEXTURE.line, width),
        body,
        '<br>',
        HtmlKit.line(HtmlKit.TEXTURE.line, width),
        footer || '',
        '</center></body></html>'
    ].join('');

    if (options.showSize !== true) {
        return chrome(options.footer || '');
    }

    let html = chrome(HtmlKit.font('chars: ? / ucs2: ?', HtmlKit.COLOR.muted));
    for (let i = 0; i < 2; i++) {
        html = chrome(HtmlKit.sizeFooter(html));
    }
    return html;
};

module.exports = HtmlKit;
