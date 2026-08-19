/*
 * csv.js — a CSV parser that handles the cases a split(",") does not.
 *
 * Real exports contain quoted fields with embedded commas, escaped quotes
 * ("" inside a quoted field), newlines inside quotes, CRLF line endings, a
 * UTF-8 BOM from Excel, and semicolon delimiters from European locales. Every
 * one of those silently corrupts a naive parser, usually by shifting every
 * column after the offending row.
 *
 * This is a character-scanning state machine rather than a regex, because the
 * quoted-newline case cannot be handled by splitting on lines first.
 */

const QUOTE = 34;      // "
const CR = 13;
const LF = 10;

/** Guess the delimiter by which candidate yields the most consistent field
 *  count across the first few lines. Counting occurrences alone is fooled by
 *  prose columns full of commas. */
export function detectDelimiter(text, candidates = [",", ";", "\t", "|"]) {
  const sample = text.slice(0, 64 * 1024);
  let best = ",", bestScore = -1;

  for (const delim of candidates) {
    const rows = parse(sample, { delimiter: delim, maxRows: 20 }).rows;
    if (rows.length < 2) continue;
    const counts = rows.map((r) => r.length);
    const modal = counts[0];
    if (modal < 2) continue;
    // Reward consistency first, then width — a delimiter that splits every row
    // into the same number of fields is almost certainly the right one.
    const consistent = counts.filter((c) => c === modal).length / counts.length;
    const score = consistent * 100 + modal;
    if (score > bestScore) { bestScore = score; best = delim; }
  }
  return best;
}

/**
 * Parse CSV text into rows of strings.
 *
 * @param {string} text
 * @param {{delimiter?: string, maxRows?: number}} options
 * @returns {{rows: string[][], truncated: boolean}}
 */
export function parse(text, { delimiter = ",", maxRows = Infinity } = {}) {
  // Excel writes a UTF-8 BOM; left in place it becomes part of the first
  // header name, so "id" silently becomes "﻿id" and lookups miss.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const delim = delimiter.charCodeAt(0);
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const len = text.length;
  let truncated = false;

  const endField = () => { row.push(field); field = ""; };
  const endRow = () => {
    endField();
    // Skip the blank row a trailing newline produces.
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
  };

  while (i < len) {
    const c = text.charCodeAt(i);

    if (inQuotes) {
      if (c === QUOTE) {
        if (text.charCodeAt(i + 1) === QUOTE) {
          field += '"';        // "" is a literal quote
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += text[i++];
      continue;
    }

    if (c === QUOTE && field === "") { inQuotes = true; i++; continue; }
    if (c === delim) { endField(); i++; continue; }
    if (c === CR) {
      endRow();
      // Consume CRLF as one terminator, not two.
      i += text.charCodeAt(i + 1) === LF ? 2 : 1;
      if (rows.length >= maxRows) { truncated = true; break; }
      continue;
    }
    if (c === LF) {
      endRow();
      i++;
      if (rows.length >= maxRows) { truncated = true; break; }
      continue;
    }
    field += text[i++];
  }

  // A final row with no trailing newline still counts.
  if (field !== "" || row.length) endRow();

  return { rows, truncated };
}

/** Parse into { columns, rows } with the first row treated as a header. */
export function parseTable(text, options = {}) {
  const delimiter = options.delimiter ?? detectDelimiter(text);
  const { rows } = parse(text, { ...options, delimiter });
  if (!rows.length) return { columns: [], rows: [], delimiter };

  const header = rows[0].map((h, i) => {
    const name = h.trim();
    return name === "" ? `column_${i + 1}` : name;
  });

  // Duplicate header names would make column lookup ambiguous downstream.
  const seen = new Map();
  const columns = header.map((name) => {
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    return count === 0 ? name : `${name}_${count + 1}`;
  });

  const body = rows.slice(1).map((r) => {
    // Ragged rows are common in hand-edited files; pad rather than drop, so a
    // single malformed line does not lose the data around it.
    if (r.length === columns.length) return r;
    const out = r.slice(0, columns.length);
    while (out.length < columns.length) out.push("");
    return out;
  });

  return { columns, rows: body, delimiter };
}

/* ── Type inference and column statistics ─────────────────── */

const NUMERIC_RE = /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
const DATE_RE = /^\d{4}[-/]\d{1,2}[-/]\d{1,2}([ T]\d{1,2}:\d{2}(:\d{2})?)?/;
const INT_RE = /^-?\d+$/;

export function inferType(values) {
  let numeric = 0, integer = 0, date = 0, boolish = 0, nonEmpty = 0;
  const truthy = new Set(["true", "false", "yes", "no", "y", "n", "0", "1", "t", "f"]);

  for (const raw of values) {
    const v = raw?.trim();
    if (!v) continue;
    nonEmpty++;
    if (NUMERIC_RE.test(v)) { numeric++; if (INT_RE.test(v)) integer++; }
    if (DATE_RE.test(v)) date++;
    if (truthy.has(v.toLowerCase())) boolish++;
  }
  if (nonEmpty === 0) return "empty";
  const frac = (n) => n / nonEmpty;
  // A column only earns a type if nearly every value fits it — one stray
  // "N/A" should not stop a numeric column being numeric, but 30% text should.
  if (frac(date) > 0.9) return "date";
  if (frac(boolish) > 0.95 && new Set(values.map((v) => v?.trim().toLowerCase())).size <= 3) return "boolean";
  if (frac(numeric) > 0.9) return frac(integer) === 1 ? "integer" : "number";
  return "text";
}

export function columnStats(values, type) {
  const nonEmpty = values.filter((v) => v !== null && v !== undefined && v.trim() !== "");
  const missing = values.length - nonEmpty.length;
  const unique = new Set(nonEmpty).size;
  const base = { count: values.length, missing, unique, type,
                 missingPct: values.length ? (100 * missing) / values.length : 0 };

  if (type === "number" || type === "integer") {
    const nums = nonEmpty.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    if (!nums.length) return base;
    const q = (p) => {
      const idx = (nums.length - 1) * p;
      const lo = Math.floor(idx), hi = Math.ceil(idx);
      return nums[lo] + (nums[hi] - nums[lo]) * (idx - lo);
    };
    const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
    const variance = nums.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(nums.length - 1, 1);
    const q1 = q(0.25), q3 = q(0.75), iqr = q3 - q1;
    return {
      ...base, min: nums[0], max: nums[nums.length - 1], mean,
      sd: Math.sqrt(variance), median: q(0.5), q1, q3,
      outliers: nums.filter((n) => n < q1 - 1.5 * iqr || n > q3 + 1.5 * iqr).length,
      values: nums,
    };
  }

  const freq = new Map();
  for (const v of nonEmpty) freq.set(v, (freq.get(v) ?? 0) + 1);
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  return { ...base, top };
}
