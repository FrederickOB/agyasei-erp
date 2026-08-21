/**
 * Drill result collection and the markdown report
 * (docs/sync-drill-report.md). Assertions here are HARD: a failed check
 * records a failure and the runner exits non-zero — a drill is never
 * weakened to pass.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

export class DrillResult {
  readonly id: string;
  readonly title: string;
  readonly checks: CheckResult[] = [];
  readonly measurements: string[] = [];
  error: string | null = null;

  constructor(id: string, title: string) {
    this.id = id;
    this.title = title;
  }

  check(name: string, pass: boolean, detail: string): void {
    this.checks.push({ name, pass, detail });
    const mark = pass ? 'PASS' : 'FAIL';
    console.log(`  [${mark}] ${name} — ${detail}`);
  }

  assertEq(name: string, actual: unknown, expected: unknown): void {
    const a = typeof actual === 'bigint' ? actual.toString() : JSON.stringify(actual);
    const e = typeof expected === 'bigint' ? expected.toString() : JSON.stringify(expected);
    this.check(name, a === e, `actual=${a} expected=${e}`);
  }

  measure(line: string): void {
    this.measurements.push(line);
    console.log(`  [measure] ${line}`);
  }

  get pass(): boolean {
    return this.error === null && this.checks.length > 0 && this.checks.every((c) => c.pass);
  }
}

/** Nearest-rank p95. */
export function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(0.95 * sorted.length));
  return sorted[rank - 1] ?? Number.NaN;
}

export function writeReport(results: DrillResult[], environment: string[]): string {
  const path = fileURLToPath(new URL('../../../docs/sync-drill-report.md', import.meta.url));
  const now = new Date().toISOString();
  const lines: string[] = [];
  lines.push('# Sync drill report — Phase 1 acceptance demonstrations');
  lines.push('');
  lines.push(`**Generated:** ${now} by \`pnpm --filter @erp/sync-drills drill\``);
  lines.push('**Nothing mocked:** real Postgres 16 (docker, :5433), real self-hosted PowerSync service (:8080), real API (:3001); each device is an `@powersync/node` client with its own sqlite file and its own tokens.');
  lines.push('');
  const allPass = results.every((r) => r.pass);
  lines.push(`**Overall: ${allPass ? 'PASS' : 'FAIL'}** — ${results.filter((r) => r.pass).length}/${results.length} drills passed.`);
  lines.push('');
  lines.push('| Drill | Result |');
  lines.push('|---|---|');
  for (const r of results) lines.push(`| ${r.id} — ${r.title} | ${r.pass ? 'PASS' : '**FAIL**'} |`);
  lines.push('');

  for (const r of results) {
    lines.push(`## ${r.id} — ${r.title}: ${r.pass ? 'PASS' : 'FAIL'}`);
    lines.push('');
    if (r.measurements.length > 0) {
      lines.push('**Measured:**');
      for (const m of r.measurements) lines.push(`- ${m}`);
      lines.push('');
    }
    if (r.checks.length > 0) {
      lines.push('**Assertions:**');
      lines.push('');
      lines.push('| Check | Result | Detail |');
      lines.push('|---|---|---|');
      for (const c of r.checks) {
        lines.push(`| ${c.name} | ${c.pass ? 'PASS' : '**FAIL**'} | ${c.detail.replaceAll('|', '\\|')} |`);
      }
      lines.push('');
    }
    if (r.error) {
      lines.push(`**Aborted with error:** \`${r.error}\``);
      lines.push('');
    }
  }

  lines.push('## Environment');
  lines.push('');
  for (const e of environment) lines.push(`- ${e}`);
  lines.push('');
  writeFileSync(path, lines.join('\n'));
  return path;
}
