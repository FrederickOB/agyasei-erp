#!/usr/bin/env node
/**
 * PAYROLL BOUNDARY LINT — CLAUDE.md §2.4, made enforceable.
 *
 * §2.4 is categorical: this system records hours, roles, gross pay and
 * commissions and produces a register. It must not contain PAYE brackets,
 * social-security rates, or any statutory withholding logic, IN ANY
 * JURISDICTION. Net pay is entered, not calculated.
 *
 * A rule nothing checks is a rule that survives exactly as long as everybody
 * who read it. This lint is what makes the boundary a build failure. It
 * enforces three things:
 *
 *   1. NOTHING COMPUTES A BUREAU FIGURE. Any assignment of a `bureau_*` /
 *      `bureau*` value from an expression containing an operator, a rate, a
 *      percentage or another column fails. `05 §5.8.1`: "If a reviewer sees
 *      `bureau_employee_tax_minor = gross * something`, the build fails."
 *
 *   2. NOTHING WRITES A BUREAU FIGURE OUTSIDE THE IMPORT MODULE. The import is
 *      the single door those numbers come through, and the database trigger
 *      (`PR0003`) enforces the same rule at runtime. Two mechanisms, because a
 *      lint can be bypassed by cleverness and a trigger cannot, while a
 *      trigger cannot read intent and a lint can.
 *
 *   3. NO STATUTORY WITHHOLDING VOCABULARY ANYWHERE. No PAYE band, no SSNIT
 *      rate, no withholding table, in code or in SQL. Someone will eventually
 *      propose an effective-dated PAYE band table by analogy with the tax pack
 *      (ADR-0002); §2.4 prohibits statutory payroll calculation categorically,
 *      not merely in hard-coded form, and this is where that argument ends.
 *
 * Coarse by design, like `lint-money.mjs`. It exists to be loud.
 *
 * Escape hatch: `// lint-payroll-ignore — reason`, on the offending line or
 * the line above it. Deliberately requires a written reason, and should
 * essentially never be used on rule 1 or 3. Its legitimate use is a line that
 * NAMES the banned vocabulary in order to assert that nothing uses it.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** The one module allowed to write a bureau figure. */
const IMPORT_MODULE = /payroll[/\\]import\.ts$/;
/** Tests may construct bureau figures; they are not the product. */
const TEST_FILE = /(\.test\.tsx?|[/\\]test[/\\]|[/\\]tests[/\\])/;
/** Migrations and their mirrors DECLARE these columns; declaring is not writing. */
const SCHEMA_FILE = /(migrations[/\\].*\.sql$|src[/\\]schema\.ts$)/;

/**
 * Statutory withholding vocabulary. A hit is a conversation, not a nit.
 * `SOCIAL_SECURITY` alone is permitted — the EMPLOYER contribution is a real
 * company expense with a real account, and §2.4's prohibition is on computing
 * the figure, not on booking it. What is banned is a RATE or a BAND for one.
 */
const STATUTORY = [
  /\bPAYE\b/i,
  /\bSSNIT\b/i,
  /withholding[_ ]?(table|rate|band|bracket|schedule)/i,
  /tax[_ ]?(band|bracket)\b/i,
  /(social[_ ]?security|pension)[_ ]?(rate|percent|bracket|band)/i,
  /\bpaye[_ ]?(rate|band|bracket|threshold)/i,
];

/** An assignment whose right-hand side does arithmetic or reads a rate. */
const COMPUTED = /[-+*/%]|\brate\b|\bpercent|\bbps\b|\bbracket\b|\bband\b/i;

const roots = ["packages", "apps", "infra", "tools"];
const offences = [];

function walk(dir) {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "dist" || e.startsWith(".")) continue;
    const p = join(dir, e);
    const s = statSync(p);
    if (s.isDirectory()) walk(p);
    else if (/\.(ts|tsx|sql|mjs|js)$/.test(e)) check(p);
  }
}

function check(p) {
  // This file names every banned pattern in order to ban it.
  if (/lint-payroll\.mjs$/.test(p)) return;
  const isImport = IMPORT_MODULE.test(p);
  const isTest = TEST_FILE.test(p);
  const isSchema = SCHEMA_FILE.test(p);
  const lines = readFileSync(p, "utf8").split("\n");

  lines.forEach((line, i) => {
    // The marker is honoured on the line itself OR on the line above, so a
    // reason can be written out in full rather than crammed into a trailing
    // comment. Requiring a written reason is the point of the hatch.
    if (/lint-payroll-ignore/.test(line)) return;
    if (i > 0 && /lint-payroll-ignore/.test(lines[i - 1])) return;
    const at = `${p}:${i + 1}`;

    // 3 — statutory vocabulary, everywhere including comments and SQL.
    // Comments are deliberately in scope: a commented-out PAYE table is a
    // PAYE table somebody will uncomment.
    for (const re of STATUTORY) {
      if (re.test(line)) {
        // A line that is explicitly PROHIBITING the thing is not the thing.
        // Word boundaries matter here and their absence was a real bug: `ban`
        // matched inside `band`, so the line "PAYE band table" exempted
        // itself. A lint whose exemption is broader than its rule is worse
        // than no lint, because it reports clean.
        if (/\b(no|not|never|prohibits?|forbids?|bans?|rejects?|refuses?|absent)\b|§2\.4/i.test(line)) continue;
        offences.push(`${at}  statutory withholding vocabulary: ${line.trim().slice(0, 90)}`);
        break;
      }
    }

    // 1 and 2 — writes to a bureau figure.
    // Tests are exempt from the WRITE rules (1 and 2) and only from those.
    // A test that constructs `bureau_x = gross * rate` as a string, in order
    // to prove this lint stops on it, is not a breach — and the database
    // trigger (PR0003) is the backstop for a test that tried to write one for
    // real. Rule 3 still applies to tests, with the documented hatch.
    const assign = line.match(/\b(bureau_[a-z_]+|bureau[A-Z]\w*)\s*(?::=|=(?!=))\s*(.+)$/);
    if (assign && !isSchema && !isTest) {
      const [, field, rhs] = assign;
      if (COMPUTED.test(rhs)) {
        offences.push(`${at}  '${field}' assigned a COMPUTED expression — §2.4 forbids deriving it: ${rhs.trim().slice(0, 60)}`);
      } else if (!isImport) {
        offences.push(`${at}  '${field}' written outside payroll/import.ts`);
      }
    }
  });
}

for (const r of roots) {
  try {
    walk(r);
  } catch {
    /* a root that does not exist is not an offence */
  }
}

if (offences.length) {
  console.error("PAYROLL BOUNDARY VIOLATIONS (CLAUDE.md §2.4):");
  for (const o of offences) console.error("  " + o);
  console.error("");
  console.error("This system records payroll figures; it does not compute them.");
  console.error("capture -> export -> the bureau computes -> re-import -> net pay is ENTERED.");
  process.exit(1);
}
console.log("payroll lint: clean");
