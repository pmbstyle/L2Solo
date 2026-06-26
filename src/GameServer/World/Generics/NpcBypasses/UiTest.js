const ServerResponse = invoke('GameServer/Network/Response');
const Html = invoke('GameServer/World/Generics/HtmlKit');

const WIDTH = Html.WIDTH;
const TABS = [
    ['overview', 'Overview'],
    ['buttons', 'Buttons'],
    ['inputs', 'Inputs'],
    ['images', 'Images'],
    ['layout', 'Layout'],
    ['title', 'Title'],
    ['stress', 'Size']
];

function clampPage(value) {
    return TABS.some(([id]) => id === value) ? value : 'overview';
}

function resultBlock(state) {
    if (!state || !state.lastAction) return '';

    const values = state.values || [];
    let rows = `${Html.font('Last action:', Html.COLOR.link)} ${Html.esc(state.lastAction)}<br1>`;
    values.forEach((value, index) => {
        rows += `${Html.font(`arg${index + 1}:`, Html.COLOR.muted)} ${Html.esc(value || '<empty>')}<br1>`;
    });

    return Html.section('Bypass Result', rows);
}

function overview() {
    return [
        `${Html.font('Custom HTML UI Lab', Html.COLOR.title)}<br1>`,
        `${Html.font('Opened by .uitest. Use tabs to probe client-safe controls.', Html.COLOR.muted)}<br>`,
        Html.line(),
        Html.keyValueRows([
            ['Packet', 'NpcHtmlMessage 0x0f'],
            ['Target', 'Legacy-safe NPC dialog subset'],
            ['Width', '270 px test baseline']
        ]),
        Html.section('Quick Probes', Html.columns([
            Html.cell(Html.button('Buttons', 'ui-test page buttons')),
            Html.cell(Html.button('Inputs', 'ui-test page inputs')),
            Html.cell(Html.button('Images', 'ui-test page images'))
        ])),
        Html.section('Observed Client Notes',
            `${Html.font('OK:', Html.COLOR.ok)} tables, links, edit, combobox, multiedit, common item/skill icons.<br1>` +
            `${Html.font('OK:', Html.COLOR.ok)} CH3 buttons render cleaner than the legacy default texture.<br1>` +
            `${Html.font('Fixed:', Html.COLOR.warn)} NpcHtmlMessage keeps the outer frame title as Chat.<br1>` +
            `${Html.font('UX:', Html.COLOR.warn)} server redraw after deep clicks scrolls the window upward.<br1>` +
            `${Html.font('Crash:', Html.COLOR.danger)} 60-row payload crashed this client; size probes now stop at 25.`
        )
    ].join('');
}

function buttons(state) {
    const checked = state?.checkbox === true;
    const checkText = checked ? 'ON' : 'OFF';
    const checkColor = checked ? Html.COLOR.ok : Html.COLOR.muted;
    const checkTexture = checked ? 'L2UI.CheckBox_checked' : 'L2UI.CheckBox';
    const closeLinkCount = state?.closeLinkCount || 0;
    const stayLinkCount = state?.stayLinkCount || 0;

    return [
        `${Html.font('Button Texture Matrix', Html.COLOR.title)}<br1>`,
        `${Html.font('Use compact labels; legacy button text rendering is fixed and cramped.', Html.COLOR.muted)}<br>`,
        Html.section('Current Kit Default', Html.table([
            Html.row([
                Html.cell(Html.button('Small', 'ui-test press kit-small', { width: 75 })),
                Html.cell(Html.button('Medium', 'ui-test press kit-medium', { width: 90 })),
                Html.cell(Html.button('Wide', 'ui-test press kit-wide', { width: 120 }))
            ])
        ])),
        Html.section('Legacy Candidates', Html.table([
            Html.row([
                Html.cell(Html.button('Old', 'ui-test press default', { width: 75, fore: Html.TEXTURE.legacyButton, back: Html.TEXTURE.legacyButtonDown })),
                Html.cell(Html.button('CH3', 'ui-test press ch3', { width: 75, fore: 'L2UI_ch3.Btn1_normal', back: 'L2UI_ch3.Btn1_normalOn' })),
                Html.cell(Html.button('Big', 'ui-test press big', { width: 90, fore: 'L2UI_ch3.BigButton3', back: 'L2UI_ch3.BigButton3_over' }))
            ])
        ])),
        Html.section('Maybe Missing On Legacy Clients', Html.table([
            Html.row([
                Html.cell(Html.button('CT1', 'ui-test press ct1', { width: 75, fore: 'L2UI_CT1.Button_DF', back: 'L2UI_CT1.Button_DF_Down' })),
                Html.cell(Html.button('', 'ui-test press checkbox-on', { width: 18, height: 18, fore: 'L2UI.CheckBox_checked', back: 'L2UI.CheckBox_checked' })),
                Html.cell(Html.button('', 'ui-test press checkbox-off', { width: 18, height: 18, fore: 'L2UI.CheckBox', back: 'L2UI.CheckBox' }))
            ])
        ])),
        Html.section('Checkbox Texture Probe',
            Html.table([
                Html.row([
                    Html.cell(Html.button('', 'ui-test toggle-checkbox', { width: 14, height: 14, fore: checkTexture, back: checkTexture }), { width: 26 }),
                    Html.cell(Html.button('', 'ui-test toggle-checkbox', { width: 18, height: 18, fore: checkTexture, back: checkTexture }), { width: 26 }),
                    Html.cell(`${Html.font(checkText, checkColor)} ${Html.font('small texture fits best', Html.COLOR.muted)}`)
                ])
            ]) +
            '<br1>' +
            `${Html.font('Click works, but redraw can jump scroll. Do not use deep in long pages.', Html.COLOR.muted)}`
        ),
        Html.section('Recommended Toggle',
            Html.table([
                Html.row([
                    Html.cell(Html.button(checked ? 'ON' : 'OFF', 'ui-test toggle-checkbox', { width: 75 }), { width: 92 }),
                    Html.cell(Html.link(checked ? 'Enabled' : 'Disabled', 'ui-test toggle-checkbox', { color: checkColor, hide: false }))
                ])
            ]) +
            '<br1>' +
            `${Html.font('Use near the top of a page, or redraw a short page to avoid scroll jumps.', Html.COLOR.muted)}`
        ),
        Html.section('Link Fallback',
            `${Html.link('Plain colored link', 'ui-test press plain-link', { color: Html.COLOR.ok })} ` +
            `${Html.link('hide-on-click link', 'ui-test press hide-link')}`
        ),
        Html.section('Hide / No-Hide Probe',
            Html.table([
                Html.row([
                    Html.cell(Html.link('no -h redraw', 'ui-test stay-link', { hide: false }), { width: 135 }),
                    Html.cell(Html.link('-h close only', 'ui-test close-link', { color: Html.COLOR.warn }), { width: 135 })
                ])
            ]) +
            `${Html.font(`no -h clicks: ${stayLinkCount} / close-only clicks: ${closeLinkCount}`, Html.COLOR.muted)}<br1>` +
            Html.table([
                Html.row([
                    Html.cell(Html.button('No-hide btn', 'ui-test stay-link', { width: 105, hide: false }), { align: 'center' }),
                    Html.cell(Html.button('Close btn', 'ui-test close-link', { width: 105 }), { align: 'center' })
                ])
            ]) +
            '<br1>' +
            `${Html.font('Close button confirmed: -h without redraw closes the window.', Html.COLOR.muted)}`
        )
    ].join('');
}

function inputs() {
    return [
        `${Html.font('Input Return Test', Html.COLOR.title)}<br1>`,
        `${Html.font('The server receives values through $variables in bypass.', Html.COLOR.muted)}<br>`,
        Html.section('Edit + Combobox',
            Html.table([
                Html.row([
                    Html.cell('Name', { width: 70 }),
                    Html.cell('<edit var="ui_name" width=130 height=15 length=16>')
                ]),
                Html.row([
                    Html.cell('Amount'),
                    Html.cell('<edit var="ui_amount" width=70 height=15 length=8>')
                ]),
                Html.row([
                    Html.cell('Choice'),
                    Html.cell('<combobox var="ui_choice" width=120 height=17 list="Player;Pet;Party;VeryLongValueProbe">')
                ])
            ]) +
            '<br1>' +
            Html.button('Submit', 'ui-test submit $ui_name $ui_amount $ui_choice', { width: 120 })
        ),
        Html.section('Multiedit Probe',
            '<multiedit var="ui_note" width=220 height=40><br1>' +
            Html.button('Send Note', 'ui-test note $ui_note', { width: 120 })
        )
    ].join('');
}

function images() {
    return [
        `${Html.font('Image And Texture Probe', Html.COLOR.title)}<br1>`,
        `${Html.font('These names depend on client texture packages.', Html.COLOR.muted)}<br>`,
        Html.section('Common Lines',
            Html.line('L2UI.SquareWhite') +
            Html.line('L2UI.SquareGray') +
            Html.line('L2UI.SquareBlank', WIDTH, 6) +
            Html.line('L2UI_CH3.hegaerectangle')
        ),
        Html.section('Icons', Html.table([
            Html.row([
                Html.cell(`${Html.img('icon.skill0001', 32, 32)}<br1>skill0001`, { align: 'center' }),
                Html.cell(`${Html.img('icon.skill1077', 32, 32)}<br1>skill1077`, { align: 'center' }),
                Html.cell(`${Html.img('icon.etc_adena_i00', 32, 32)}<br1>adena`, { align: 'center' })
            ])
        ])),
        Html.section('Risky/Newer Textures', Html.table([
            Html.row([
                Html.cell(`${Html.img('L2UI_CT1.Icon_DF_MenuWnd_Skill', 32, 32)}<br1>CT1`, { align: 'center' }),
                Html.cell(`${Html.img('L2UI_CH3.shortcut_next_down', 16, 16)}<br1>CH3`, { align: 'center' }),
                Html.cell(`${Html.img('SSQ_dungeon_T.SSQ_fire1_e013', 80, 20)}<br1>SSQ`, { align: 'center' })
            ])
        ]))
    ].join('');
}

function layout() {
    return [
        `${Html.font('Layout Probe', Html.COLOR.title)}<br1>`,
        `${Html.font('Tables are our main layout primitive.', Html.COLOR.muted)}<br>`,
        Html.section('Fixed Columns', Html.table([
            Html.row([
                Html.cell('Mode', { width: 90 }),
                Html.cell('Intent', { width: 90, align: 'center' }),
                Html.cell('HP', { width: 90, align: 'right' })
            ]),
            Html.row([
                Html.cell(Html.font('hunt', Html.COLOR.title)),
                Html.cell('assist', { align: 'center' }),
                Html.cell(Html.font('92%', Html.COLOR.ok), { align: 'right' })
            ]),
            Html.row([
                Html.cell(Html.font('rest', Html.COLOR.title)),
                Html.cell('recover', { align: 'center' }),
                Html.cell(Html.font('41%', Html.COLOR.warn), { align: 'right' })
            ])
        ], { bgcolor: Html.COLOR.row })),
        Html.section('Background Attribute',
            Html.table([
                Html.row([
                    Html.cell(Html.font('background texture test', Html.COLOR.title), { align: 'center' })
                ])
            ], { background: 'L2UI_CH3.hegaerectangle' }) +
            '<br1>' +
            Html.table([
                Html.row([Html.cell('bgcolor test', { align: 'center' })])
            ], { bgcolor: '444444' })
        ),
        Html.section('Inline Gauges',
            `${Html.font('HP', Html.COLOR.muted)}<br1>${Html.img('L2UI.SquareWhite', 205, 4)}${Html.img('L2UI.SquareBlank', 65, 4)}<br1>` +
            `${Html.font('MP', Html.COLOR.muted)}<br1>${Html.img('L2UI.SquareWhite', 120, 4)}${Html.img('L2UI.SquareBlank', 150, 4)}<br1>`
        )
    ].join('');
}

function titleProbe(state) {
    const titleMode = Object.prototype.hasOwnProperty.call(state || {}, 'titleMode')
        ? state.titleMode
        : 'UI Test';

    return [
        `${Html.font('Window Title Probe', Html.COLOR.title)}<br1>`,
        `${Html.font('Confirmed: NpcHtmlMessage does not expose an outer title field in this client.', Html.COLOR.muted)}<br>`,
        Html.keyValueRows([
            ['HTML title', Html.font(titleMode || '<empty>', Html.COLOR.link)],
            ['Frame title', 'Client-owned Chat']
        ]),
        Html.section('Title Variants', Html.columns([
            Html.cell(Html.link('Bot Party', 'ui-test title Bot_Party', { color: Html.COLOR.link })),
            Html.cell(Html.link('UI Test', 'ui-test title UI_Test', { color: Html.COLOR.link })),
            Html.cell(Html.link('Empty', 'ui-test title none', { color: Html.COLOR.warn }))
        ])),
        Html.section('Body Title Fallback',
            `${Html.font(titleMode || 'Untitled Window', Html.COLOR.title)}<br1>` +
            `${Html.font('This is the reliable title we can style inside the page body.', Html.COLOR.muted)}`
        )
    ].join('');
}

function stress(parts) {
    const requested = parseInt(parts[2], 10);
    const rows = Number.isFinite(requested) ? Math.max(10, Math.min(requested, 25)) : 10;
    let body = `${Html.font('Payload Size Probe', Html.COLOR.title)}<br1>`;
    body += `${Html.font('60 rows crashed a legacy client. This page now caps at 25.', Html.COLOR.muted)}<br>`;
    body += Html.columns([
        Html.cell(Html.button('10 rows', 'ui-test stress 10', { width: 75 })),
        Html.cell(Html.button('18 rows', 'ui-test stress 18', { width: 75 })),
        Html.cell(Html.button('25 edge', 'ui-test stress 25', { width: 75 }))
    ]) + '<br1>';

    for (let i = 1; i <= rows; i++) {
        body += Html.table([
            Html.row([
                Html.cell(`#${i}`, { width: 40 }),
                Html.cell('Long row probe with icon'),
                Html.cell(Html.img('icon.skill0001', 16, 16), { align: 'right' })
            ])
        ]);
    }

    return body;
}

function pageBody(page, parts, state) {
    if (page === 'buttons') return buttons(state);
    if (page === 'inputs') return inputs();
    if (page === 'images') return images();
    if (page === 'layout') return layout();
    if (page === 'title') return titleProbe(state);
    if (page === 'stress') return stress(parts);
    return overview() + resultBlock(state);
}

function buildHtml(page, parts, state) {
    const title = Object.prototype.hasOwnProperty.call(state || {}, 'titleMode')
        ? state.titleMode
        : 'UI Test';

    return Html.page(pageBody(page, parts, state), {
        title,
        tabs: Html.tabs(TABS, page, 'ui-test page'),
        showSize: true
    });
}

function render(session, page = 'overview', parts = ['ui-test']) {
    const actor = session.actor;
    if (!actor) return;

    const state = session.uiTestState || null;
    const html = buildHtml(clampPage(page), parts, state);
    session.dataSendToMe(ServerResponse.npcHtml(actor.fetchId(), html));
}

function uiTest(session, parts) {
    const action = parts[1];
    session.uiTestState = session.uiTestState || {};

    if (action === 'page') {
        render(session, parts[2], parts);
        return;
    }

    if (action === 'toggle-checkbox') {
        session.uiTestState.checkbox = session.uiTestState.checkbox !== true;
        session.uiTestState.lastAction = 'toggle-checkbox';
        session.uiTestState.values = [session.uiTestState.checkbox ? 'ON' : 'OFF'];
        render(session, 'buttons', parts);
        return;
    }

    if (action === 'stay-link') {
        session.uiTestState.stayLinkCount = (session.uiTestState.stayLinkCount || 0) + 1;
        session.uiTestState.lastAction = 'stay-link';
        session.uiTestState.values = ['redraws without -h'];
        render(session, 'buttons', parts);
        return;
    }

    if (action === 'title') {
        session.uiTestState.titleMode = parts[2] === 'none'
            ? ''
            : String(parts[2] || 'UI_Test').replace(/_/g, ' ');
        session.uiTestState.lastAction = 'title';
        session.uiTestState.values = [session.uiTestState.titleMode || '<empty>'];
        render(session, 'title', parts);
        return;
    }

    if (action === 'close-link') {
        session.uiTestState.closeLinkCount = (session.uiTestState.closeLinkCount || 0) + 1;
        session.uiTestState.lastAction = 'close-link';
        session.uiTestState.values = ['sent no replacement html'];
        return;
    }

    if (action === 'press') {
        session.uiTestState.lastAction = parts[2] || 'press';
        session.uiTestState.values = [];
        render(session, 'overview', parts);
        return;
    }

    if (action === 'submit' || action === 'note') {
        session.uiTestState.lastAction = action;
        session.uiTestState.values = parts.slice(2);
        render(session, 'overview', parts);
        return;
    }

    if (action === 'stress') {
        render(session, 'stress', parts);
        return;
    }

    render(session, 'overview', parts);
}

uiTest.render = render;

module.exports = uiTest;
