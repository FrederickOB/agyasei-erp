/**
 * Parse docs/source-of-truth/outlets.csv — tenant #1's 25 locations.
 *
 * Locations are ONBOARDING INPUT, not template content (01-tenancy §1.6:
 * "another company's 25 outlets are not a starting point for anyone" —
 * location TYPES are template data; locations are entered at onboarding).
 * This module therefore feeds applyTenant1Locations(), a tenant-#1
 * onboarding helper, not the template applier.
 *
 * Import trap (04 §4.15): outlets.csv row 21, "Initial Fleet + HQ/ERP
 * Systems", is a CAPEX LINE in the financial model, not an outlet. Importing
 * it creates a phantom location that accumulates mis-tapped stock movements.
 * 26 rows in, 25 locations out.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseCsv } from './csv.js';

export const OUTLETS_CSV_PATH = fileURLToPath(
  new URL('../../../../docs/source-of-truth/outlets.csv', import.meta.url),
);

export interface OutletRow {
  outletId: number;
  name: string;
  region: string;
  /** Tenant vocabulary — becomes a location_type reference, never platform logic. */
  tier: 'FLAGSHIP' | 'RDC' | 'MICRO';
  fyOpened: number;
}

export interface OutletPlan {
  outlets: OutletRow[];
  regions: string[];
  /** Rows excluded from import, with the reason — surfaced, not silent. */
  excluded: { outletId: number; name: string; reason: string }[];
}

export async function parseOutlets(csvPath: string = OUTLETS_CSV_PATH): Promise<OutletPlan> {
  const raw = parseCsv(await readFile(csvPath, 'utf8'));
  const outlets: OutletRow[] = [];
  const excluded: OutletPlan['excluded'] = [];

  for (const r of raw) {
    const tier = r['tier'] ?? '';
    const outletId = Number(r['outlet_id']);
    const name = r['outlet_name'] ?? '';
    if (tier !== 'FLAGSHIP' && tier !== 'RDC' && tier !== 'MICRO') {
      excluded.push({
        outletId,
        name,
        reason: `tier ${JSON.stringify(tier)} is not an outlet (capex/financial-model line; 04 §4.15)`,
      });
      continue;
    }
    outlets.push({
      outletId,
      name,
      region: r['region'] ?? '',
      tier,
      fyOpened: Number(r['fy_opened']),
    });
  }

  if (outlets.length !== 25) {
    throw new Error(`outlets.csv: expected 25 importable outlets, got ${outlets.length}`);
  }

  const regions = [...new Set(outlets.map((o) => o.region))].sort();
  return { outlets, regions, excluded };
}
