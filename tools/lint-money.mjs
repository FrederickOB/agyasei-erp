#!/usr/bin/env node
/**
 * Money-type lint (ADR-0004): fails if monetary-looking identifiers are typed as
 * `number` in TypeScript, or float/numeric types appear on money columns in SQL.
 * Coarse by design — it exists to make violations loud, not to be clever.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const MONEY_WORDS = /(amount|price|total|balance|fee|cost|pesewa|minor|debit|credit|gross|net_pay|subtotal|tax_)/i;
const roots = ["packages", "apps"];
const offences = [];

function walk(dir) {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "dist" || e.startsWith(".")) continue;
    const p = join(dir, e);
    const s = statSync(p);
    if (s.isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(e)) checkTs(p);
    else if (/\.sql$/.test(e)) checkSql(p);
  }
}
function checkTs(p) {
  const lines = readFileSync(p, "utf8").split("\n");
  lines.forEach((l, i) => {
    if (/lint-money-ignore/.test(l)) return;
    // `foo_amount: number` or `price?: number`
    const m = l.match(/(\w+)\??\s*:\s*number\b/);
    if (m && MONEY_WORDS.test(m[1])) offences.push(`${p}:${i + 1}  '${m[1]}' typed as number`);
  });
}
function checkSql(p) {
  const lines = readFileSync(p, "utf8").split("\n");
  lines.forEach((l, i) => {
    if (/lint-money-ignore/.test(l)) return;
    const m = l.match(/(\w+)\s+(float8?|double precision|real|numeric|money)\b/i);
    if (m && MONEY_WORDS.test(m[1])) offences.push(`${p}:${i + 1}  column '${m[1]}' uses ${m[2]}`);
  });
}
for (const r of roots) { try { walk(r); } catch {} }
if (offences.length) {
  console.error("MONEY TYPE VIOLATIONS (ADR-0004):");
  for (const o of offences) console.error("  " + o);
  process.exit(1);
}
console.log("money lint: clean");
