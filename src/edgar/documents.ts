import { edgarGet, edgarGetJson } from "./http.js";
import type { FilingRef } from "./submissions.js";

// Size caps (PLAN.md §7.6): the bundle has a hard token budget. Press releases
// are small and go in near-whole; 10-Q/10-K contribute extracted sections only.
const PRESS_RELEASE_MAX_CHARS = 30_000;
const MDA_MAX_CHARS = 60_000;

export interface FetchedDocument {
  accession: string;
  form: string;
  filedAt: string;
  items: string[];
  file: string;
  kind: "press-release" | "primary" | "mda-section";
  text: string;
  truncated: boolean;
  url: string;
}

const accnNoDashes = (accession: string) => accession.replace(/-/g, "");

interface DirIndex {
  directory: { item: { name: string }[] };
}

async function listFilingFiles(cik: number, accession: string): Promise<string[]> {
  const dir = accnNoDashes(accession);
  const idx = await edgarGetJson<DirIndex>(
    `https://www.sec.gov/Archives/edgar/data/${cik}/${dir}/index.json`,
    { cacheKey: `index-${dir}.json` }, // immutable — cached forever
  );
  return idx.directory.item.map((i) => i.name);
}

async function fetchFilingFile(cik: number, accession: string, file: string): Promise<string> {
  const dir = accnNoDashes(accession);
  return edgarGet(`https://www.sec.gov/Archives/edgar/data/${cik}/${dir}/${file}`, {
    cacheKey: `doc-${dir}-${file}`, // immutable — cached forever
  });
}

/**
 * For an 8-K: the EX-99.x press release exhibit is where guidance lives
 * (PLAN.md §4.1). Heuristic: exhibit filenames contain "ex99" / "ex-99".
 * Fall back to the primary document when no exhibit is found.
 */
export async function fetch8KPressRelease(cik: number, filing: FilingRef): Promise<FetchedDocument | null> {
  try {
    const files = await listFilingFiles(cik, filing.accession);
    // Real-world exhibit names: a8-kex991…, exhibit_99-1, exhibit991-…, a991…earningsrelease…
    const exhibitRe = /(ex(hibit)?[\W_]*99|press|earnings\w*release|(^|[^\d])99[-_.]?1)/i;
    const exhibit = files.find(
      (f) => exhibitRe.test(f) && /\.html?$/i.test(f) && !/index/i.test(f),
    );
    const target = exhibit ?? filing.primaryDocument;
    if (!target) return null;
    const html = await fetchFilingFile(cik, filing.accession, target);
    const text = htmlToText(html);
    return {
      accession: filing.accession,
      form: filing.form,
      filedAt: filing.filedAt,
      items: filing.items,
      file: target,
      kind: exhibit ? "press-release" : "primary",
      text: text.slice(0, PRESS_RELEASE_MAX_CHARS),
      truncated: text.length > PRESS_RELEASE_MAX_CHARS,
      url: `https://www.sec.gov/Archives/edgar/data/${cik}/${accnNoDashes(filing.accession)}/${target}`,
    };
  } catch (err) {
    console.warn(`  8-K fetch failed for ${filing.accession}: ${(err as Error).message}`);
    return null;
  }
}

/** For a 10-Q/10-K: extract the MD&A section from the primary document. */
export async function fetchMdaSection(cik: number, filing: FilingRef): Promise<FetchedDocument | null> {
  try {
    if (!filing.primaryDocument) return null;
    const html = await fetchFilingFile(cik, filing.accession, filing.primaryDocument);
    const text = htmlToText(html);
    const mda = extractMda(text);
    return {
      accession: filing.accession,
      form: filing.form,
      filedAt: filing.filedAt,
      items: filing.items,
      file: filing.primaryDocument,
      kind: "mda-section",
      text: mda.text.slice(0, MDA_MAX_CHARS),
      truncated: mda.text.length > MDA_MAX_CHARS || !mda.found,
      url: `https://www.sec.gov/Archives/edgar/data/${cik}/${accnNoDashes(filing.accession)}/${filing.primaryDocument}`,
    };
  } catch (err) {
    console.warn(`  ${filing.form} fetch failed for ${filing.accession}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * MD&A boundaries. The first occurrence of the heading is usually the table
 * of contents — take the LAST occurrence that has substantial text after it,
 * and stop at the following standard section heading.
 */
export function extractMda(text: string): { text: string; found: boolean } {
  const startRe = /management['’]s\s+discussion\s+and\s+analysis/gi;
  const endRe = /quantitative\s+and\s+qualitative\s+disclosures|controls\s+and\s+procedures/i;
  let start = -1;
  for (const m of text.matchAll(startRe)) {
    if (text.length - m.index > 5000) start = m.index;
  }
  if (start === -1) {
    // Fallback: no heading found — return the middle of the document, flagged.
    return { text: text.slice(0, MDA_MAX_CHARS), found: false };
  }
  const rest = text.slice(start + 40);
  const endMatch = rest.search(endRe);
  const body = endMatch > 1000 ? rest.slice(0, endMatch) : rest;
  return { text: text.slice(start, start + 40) + body, found: true };
}

/** Dependency-free HTML → text: good enough for EDGAR filings' simple markup. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|\/p|\/div|\/tr|\/h[1-6]|\/li)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
