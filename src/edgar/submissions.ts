import { cik10, edgarGetJson } from "./http.js";

export interface FilingRef {
  accession: string; // with dashes, e.g. 0001234567-26-000123
  form: string;
  filedAt: string; // YYYY-MM-DD
  primaryDocument: string;
  items: string[]; // 8-K item codes, e.g. ["2.02", "9.01"]
}

export interface CompanyProfile {
  cik: number;
  name: string;
  sic: string;
  sicDescription: string;
  isDomesticFiler: boolean;
  filings: FilingRef[]; // newest first, as EDGAR returns them
}

interface RawSubmissions {
  name: string;
  sic: string;
  sicDescription: string;
  filings: {
    recent: {
      accessionNumber: string[];
      form: string[];
      filingDate: string[];
      primaryDocument: string[];
      items: string[];
    };
  };
}

export async function getSubmissions(cik: number): Promise<CompanyProfile> {
  const id = cik10(cik);
  const raw = await edgarGetJson<RawSubmissions>(
    `https://data.sec.gov/submissions/CIK${id}.json`,
    { cacheKey: `submissions-${id}.json`, ttlHours: 12 },
  );
  const r = raw.filings.recent;
  const filings: FilingRef[] = r.accessionNumber.map((accession, i) => ({
    accession,
    form: r.form[i] ?? "",
    filedAt: r.filingDate[i] ?? "",
    primaryDocument: r.primaryDocument[i] ?? "",
    items: (r.items[i] ?? "").split(",").filter(Boolean),
  }));

  const forms = new Set(filings.map((f) => f.form));
  // Domestic filer = files 10-K/10-Q; foreign private issuers file 20-F/6-K (PLAN.md §5).
  const isDomesticFiler =
    (forms.has("10-K") || forms.has("10-Q")) && !forms.has("20-F") && !forms.has("6-K");

  return {
    cik,
    name: raw.name,
    sic: raw.sic,
    sicDescription: raw.sicDescription,
    isDomesticFiler,
    filings,
  };
}

/** Latest filing of the given form, optionally filed on/after `since` (YYYY-MM-DD). */
export function latestFiling(profile: CompanyProfile, form: string, since?: string): FilingRef | null {
  for (const f of profile.filings) {
    if (f.form !== form) continue;
    if (since && f.filedAt < since) continue;
    return f;
  }
  return null;
}

/** All filings of a form filed on/after `since`, newest first. */
export function filingsSince(profile: CompanyProfile, form: string, since: string): FilingRef[] {
  return profile.filings.filter((f) => f.form === form && f.filedAt >= since);
}
