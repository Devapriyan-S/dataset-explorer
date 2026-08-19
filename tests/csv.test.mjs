/* The CSV cases that break a split(",") parser. */
import { parse, parseTable, detectDelimiter, inferType, columnStats } from "../web/js/csv.js";

let pass = 0, fail = 0;

function eq(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  [ok  ] ${label}`); }
  else { fail++; console.log(`  [FAIL] ${label}\n         got  ${g}\n         want ${w}`); }
}

console.log("\nParsing edge cases\n");

eq("plain rows",
  parseTable("a,b\n1,2\n3,4").rows, [["1", "2"], ["3", "4"]]);

eq("quoted field containing a comma",
  parseTable('name,city\n"Smith, John",Chennai').rows, [["Smith, John", "Chennai"]]);

eq("escaped quotes inside a quoted field",
  parseTable('q\n"She said ""hi"""').rows, [['She said "hi"']]);

eq("newline inside a quoted field",
  parseTable('note,id\n"line one\nline two",7').rows, [["line one\nline two", "7"]]);

eq("CRLF line endings",
  parseTable("a,b\r\n1,2\r\n3,4").rows, [["1", "2"], ["3", "4"]]);

eq("UTF-8 BOM is stripped from the first header",
  parseTable("﻿id,name\n1,x").columns, ["id", "name"]);

eq("empty trailing field is preserved",
  parseTable("a,b,c\n1,,3").rows, [["1", "", "3"]]);

eq("trailing newline does not add a blank row",
  parseTable("a,b\n1,2\n").rows, [["1", "2"]]);

eq("row with no trailing newline is kept",
  parseTable("a,b\n1,2").rows, [["1", "2"]]);

eq("short row is padded, not dropped",
  parseTable("a,b,c\n1,2").rows, [["1", "2", ""]]);

eq("long row is truncated to the header width",
  parseTable("a,b\n1,2,3,4").rows, [["1", "2"]]);

eq("blank header names are given positional names",
  parseTable("a,,c\n1,2,3").columns, ["a", "column_2", "c"]);

eq("duplicate header names are disambiguated",
  parseTable("id,id,id\n1,2,3").columns, ["id", "id_2", "id_3"]);

eq("semicolon delimiter is detected",
  parseTable("a;b;c\n1;2;3").rows, [["1", "2", "3"]]);

eq("tab delimiter is detected",
  parseTable("a\tb\n1\t2").rows, [["1", "2"]]);

eq("comma wins over a prose column full of commas",
  detectDelimiter('id,note\n1,"a, b, c, d, e"\n2,"f, g, h, i, j"'), ",");

eq("quoted empty string",
  parseTable('a,b\n"",x').rows, [["", "x"]]);

eq("field with only whitespace is preserved",
  parseTable("a,b\n  ,x").rows, [["  ", "x"]]);

console.log("\nType inference\n");

eq("integers",        inferType(["1", "2", "3", "-4"]), "integer");
eq("decimals",        inferType(["1.5", "2.25", "3"]), "number");
eq("scientific",      inferType(["1e5", "2.5E-3"]), "number");
eq("one stray N/A still numeric", inferType(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10",
                                             "11", "12", "13", "14", "15", "16", "17", "18",
                                             "19", "N/A"]), "number");
eq("mostly text is text", inferType(["1", "2", "apple", "banana", "cherry"]), "text");
eq("ISO dates",       inferType(["2024-01-01", "2024-06-15"]), "date");
eq("slash dates",     inferType(["2024/01/01", "2024/06/15"]), "date");
eq("booleans",        inferType(["true", "false", "true"]), "boolean");
eq("yes/no",          inferType(["yes", "no", "yes"]), "boolean");
eq("all empty",       inferType(["", "  ", ""]), "empty");
eq("bare year is not a date", inferType(["2019", "2020", "2021"]), "integer");

console.log("\nColumn statistics\n");

const s = columnStats(["1", "2", "3", "4", "5", "", "100"], "number");
eq("count includes blanks",  s.count, 7);
eq("missing counted",        s.missing, 1);
eq("min",                    s.min, 1);
eq("max",                    s.max, 100);
eq("median (even count interpolates)", s.median, 3.5);
eq("outlier detected",       s.outliers, 1);

const t = columnStats(["a", "b", "a", "a", "c"], "text");
eq("unique count",           t.unique, 3);
eq("most frequent value",    t.top[0], ["a", 3]);

console.log("\nLarge input\n");
const big = "id,value\n" + Array.from({ length: 200000 }, (_, i) => `${i},${i * 2}`).join("\n");
const t0 = Date.now();
const parsed = parseTable(big);
const ms = Date.now() - t0;
eq("200k rows parsed", parsed.rows.length, 200000);
console.log(`  [info] parsed 200,000 rows in ${ms}ms (${(big.length / 1024 / 1024).toFixed(1)} MB)`);

console.log("\n" + "=".repeat(56));
console.log(fail ? `${fail} FAILED, ${pass} passed` : `All ${pass} checks passed.`);
process.exit(fail ? 1 : 0);
