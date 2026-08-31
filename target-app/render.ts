import { Variant } from './variants.js';

/**
 * Randomized element ids/classes on every render. Real legacy apps ship
 * server-generated ids (`ctl00_grdMain_ctl07_txt`) that shift when the page
 * changes; randomizing them here makes id/CSS-based locators provably useless
 * and forces the automation to target controls the way a human reads them.
 */
export const rid = (): string => 'ctl' + Math.random().toString(36).slice(2, 10);
export const rcls = (): string => 'x' + Math.random().toString(36).slice(2, 7);

export const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const CSS = `
body{font-family:Verdana,Geneva,sans-serif;font-size:11px;background:#d4d0c8;margin:0;color:#000}
table{border-collapse:collapse}
.hdr{background:#000080;color:#fff;font-weight:bold;padding:3px 6px}
.bar{background:#808080;color:#fff;padding:2px 6px}
td{padding:2px 4px;vertical-align:middle}
input[type=text],input[type=password],select{border:2px inset #fff;background:#fff;font-family:"Courier New",monospace;font-size:11px;padding:1px}
input[type=submit],button{font-family:Verdana;font-size:11px;border:2px outset #fff;background:#d4d0c8;padding:1px 8px}
.err{background:#ffff99;border:1px solid #800000;color:#800000;font-weight:bold;padding:4px 8px}
.grid td{border:1px solid #808080}
.grid th{border:1px solid #808080;background:#c0c0c0;font-size:11px;padding:2px 4px}
`;

/** Legacy chrome: nested tables, <font> tags, cryptic uppercase field captions. */
export function page(v: Variant, title: string, body: string): string {
  return `<html><head><title>${esc(title)}</title><style>${CSS}</style></head>
<body class="${rcls()}">
<table width="100%" cellspacing="0" cellpadding="0"><tr><td class="hdr" id="${rid()}">
<font size="2">${esc(v.brand)}</font></td></tr>
<tr><td class="bar" id="${rid()}">${esc(v.tenantLabel)} &nbsp;|&nbsp; ${esc(title)}</td></tr></table>
<table width="100%" cellpadding="6"><tr><td id="${rid()}">
${body}
</td></tr></table>
</body></html>`;
}

/**
 * A form row in the legacy idiom: caption in one <td>, bare <input> in the next.
 * No <label for>, no aria-label, no test id, randomized id. The control's
 * accessible name is therefore EMPTY — the perception layer has to infer the
 * caption from table geometry, exactly as a human does.
 */
export function fieldRow(caption: string, inputHtml: string): string {
  return `<tr><td align="right" id="${rid()}"><font color="#000080"><b>${esc(caption)}:</b></font></td>
<td id="${rid()}">${inputHtml}</td></tr>`;
}

export function textInput(name: string, size = 12, value = ''): string {
  return `<input type="text" name="${name}" id="${rid()}" class="${rcls()}" size="${size}" value="${esc(value)}" maxlength="40">`;
}

export function submitBtn(label: string, name = 'act'): string {
  return `<input type="submit" name="${name}" id="${rid()}" value="${esc(label)}">`;
}
