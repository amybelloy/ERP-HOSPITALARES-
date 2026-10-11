'use strict';
/** Gera CSV (separador ;, compatível com Excel pt-BR) com proteção contra injeção de fórmulas. */
function escapeCell(v) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // CSV injection
  if (/[;"\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCSV(columns, rows) {
  const header = columns.map((c) => escapeCell(c.label)).join(';');
  const lines = rows.map((r) => columns.map((c) => escapeCell(typeof c.value === 'function' ? c.value(r) : r[c.key])).join(';'));
  return '﻿' + [header, ...lines].join('\r\n');
}

/** Parser simples de CSV com ; ou , (aspas suportadas). */
function parseCSV(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const sep = lines[0].includes(';') ? ';' : ',';
  const parseLine = (line) => {
    const out = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === sep) { out.push(cur); cur = ''; } else cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };
  const header = parseLine(lines[0]).map((h) => h.toLowerCase());
  return lines.slice(1).map((l) => {
    const cells = parseLine(l);
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? '']));
  });
}

module.exports = { toCSV, parseCSV };
