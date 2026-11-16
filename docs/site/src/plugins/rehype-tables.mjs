// Tables that read at any width (src/styles/components.css):
//   - every cell carries its column's header as data-label, so a narrow screen can stack each row with its labels;
//   - a table with four or more columns is marked caitlyn-table-wide, which sets column proportions on wide screens
//     and stacks below a narrow container width;
//   - a cell holding only code spans separated by commas (an error's codes, for example) becomes a list of them,
//     one per line, instead of a comma-joined run that wraps mid-name;
//   - a long path or URL in code (`/settings/documentation/api`, `https://app.example.com/callback`) may break
//     before a slash and nowhere else: each segment is a span that never breaks, with a break opportunity between
//     them, so a path wraps at its separators and every other code in a table stays on one line;
//   - a table laid out as a table (not the wide tables' entries) sits in a scrolling wrapper, so the table itself can
//     be full width, its rows' hairlines flush with its strong rule, and still scroll when it cannot fit.
// The Markdown copies are untouched: this only shapes the HTML.
import { SKIP, visit } from 'unist-util-visit';

// The API reference's member, event and error tables ("Member | Type | Sent in | Description", "Event | Data |
// Description", "Status | Error | Codes | When") become compact rows of two cells. The left cell is the member (or
// status, or event), a "Required" label above it when the description cell said "(required)", and the short columns
// on one muted line beneath ("string · path", or the error class). The right cell is the codes, if any, then the
// description. The header keeps the two columns' names.
const ROW_TABLES = [
  { first: 'Member', last: 'Description' },
  { first: 'Event', last: 'Description' },
  { first: 'Status', last: 'When' },
];
const el = (tagName, className, children) => ({ type: 'element', tagName, properties: className ? { className: [className] } : {}, children });
const REQUIRED = /\s*\(required\)\s*$/;

function toRows(table, rows, header) {
  const right = header.map((h) => h === 'Codes');
  for (const row of rows.slice(1)) {
    const cells = row.children.filter((c) => c.type === 'element' && c.tagName === 'td');
    if (cells.length !== header.length) return;
  }
  for (const [n, row] of rows.entries()) {
    const cells = row.children.filter((c) => c.type === 'element' && (c.tagName === 'td' || c.tagName === 'th'));
    const [first, ...rest] = cells;
    const last = rest.pop();
    if (n === 0) {
      row.children = [first, last];
      continue;
    }
    const meta = [];
    const lead = [];
    rest.forEach((cell, i) => {
      if (right[i + 1]) lead.push(el('div', 'caitlyn-row-codes', cell.children));
      else if (cell.children.length) meta.push(cell.children);
    });
    const tail = first.children.at(-1);
    let required = false;
    if (tail?.type === 'text' && REQUIRED.test(tail.value)) {
      required = true;
      tail.value = tail.value.replace(REQUIRED, '');
    }
    first.children = [
      ...(required ? [el('span', 'caitlyn-row-required', [{ type: 'text', value: 'Required' }])] : []),
      el('span', 'caitlyn-row-name', first.children),
      ...(meta.length ? [el('span', 'caitlyn-row-meta', meta.flatMap((m, i) => (i ? [{ type: 'text', value: ' \u00b7 ' }, ...m] : m)))] : []),
    ];
    if (lead.length) last.children = [...lead, el('div', 'caitlyn-row-description', last.children)];
    row.children = [first, last];
  }
  table.properties.className = [...(table.properties.className ?? []).filter((c) => c !== 'caitlyn-table-wide'), 'caitlyn-table-rows'];
  delete table.properties.dataColumns;
}

// A slash that starts a path segment: not the second of `//`, and not straight after a scheme's colon
const SEGMENT = /(?<![:/])(?=\/)/;
/** A code element in a table cell whose text is a long path or URL, made breakable before each segment's slash */
function breakablePath(code) {
  if (code.children.length !== 1 || code.children[0].type !== 'text') return;
  const value = code.children[0].value;
  const parts = value.split(SEGMENT);
  if (value.length < 24 || parts.length < 3) return;
  code.properties.className = [...(code.properties.className ?? []), 'caitlyn-code-path'];
  code.children = parts.flatMap((part, i) => [...(i ? [{ type: 'element', tagName: 'wbr', properties: {}, children: [] }] : []), { type: 'element', tagName: 'span', properties: {}, children: [{ type: 'text', value: part }] }]);
}

const text = (node) => (node.type === 'text' ? node.value : (node.children ?? []).map(text).join(''));
const isCode = (n) => n.type === 'element' && (n.tagName === 'code' || (n.tagName === 'a' && n.children?.length === 1 && n.children[0].tagName === 'code'));

export default function rehypeTables() {
  return (tree) => {
    visit(tree, 'element', (table, index, parent) => {
      if (table.tagName !== 'table') return;
      const rows = [];
      visit(table, 'element', (n) => {
        if (n.tagName === 'tr') rows.push(n);
      });
      const header = rows[0]?.children.filter((c) => c.type === 'element' && c.tagName === 'th').map((th) => text(th).trim()) ?? [];
      if (header.length && header.every((h) => !h)) {
        // A table with an empty header row (a reference page's summary, an error page's facts) shows no header
        table.properties.className = [...(table.properties.className ?? []), 'caitlyn-table-headless'];
      }
      if (header.length >= 4) {
        table.properties.className = [...(table.properties.className ?? []), 'caitlyn-table-wide'];
        table.properties.dataColumns = String(header.length);
      }
      for (const row of rows.slice(1)) {
        row.children
          .filter((c) => c.type === 'element' && c.tagName === 'td')
          .forEach((td, i) => {
            if (header[i]) td.properties.dataLabel = header[i];
            visit(td, 'element', (n) => {
              if (n.tagName === 'code') breakablePath(n);
            });
            const parts = td.children.filter((c) => !(c.type === 'text' && /^[\s,]*$/.test(c.value)));
            const commas = td.children.filter((c) => c.type === 'text' && c.value.trim() === ',').length;
            if (parts.length > 1 && commas === parts.length - 1 && parts.every(isCode)) {
              td.properties.className = [...(td.properties.className ?? []), 'caitlyn-code-list'];
              td.children = [{ type: 'element', tagName: 'ul', properties: {}, children: parts.map((p) => ({ type: 'element', tagName: 'li', properties: {}, children: [p] })) }];
            }
          });
      }
      if (ROW_TABLES.some((t) => header[0] === t.first && header.at(-1) === t.last && header.length >= 3)) toRows(table, rows, header);
      if (parent && index !== undefined && !table.properties.className?.includes('caitlyn-table-wide')) {
        parent.children[index] = el('div', 'caitlyn-table-scroll', [table]);
        return [SKIP, index + 1];
      }
    });
  };
}
