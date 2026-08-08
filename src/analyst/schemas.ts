// Gemini responseSchema definitions (OpenAPI subset, uppercase type names).
// The schema IS part of the prompt contract — bump config.llm.promptVersion
// on any change here (PLAN.md §6.2).

const CAUSE_ENUM = ["mechanical", "sentiment", "thesis_breaking", "insufficient_evidence"];

export const CLASSIFICATION_SCHEMA = {
  type: "OBJECT",
  properties: {
    primary: { type: "STRING", enum: CAUSE_ENUM },
    secondary: { type: "STRING", enum: [...CAUSE_ENUM, "none"] },
    rationale: { type: "STRING", description: "One or two sentences, grounded in cited sources only" },
    sources: { type: "ARRAY", items: { type: "STRING" }, description: "Accession numbers or concept keys from CITABLE SOURCES" },
  },
  required: ["primary", "secondary", "rationale", "sources"],
} as const;

export interface Classification {
  primary: string;
  secondary: string;
  rationale: string;
  sources: string[];
}

export const VERDICT_SCHEMA = {
  type: "OBJECT",
  properties: {
    insufficientEvidence: {
      type: "BOOLEAN",
      description: "true when the bundle does not explain the drop — expected and honest, not a failure",
    },
    dropCause: {
      type: "OBJECT",
      properties: {
        primary: { type: "STRING", enum: CAUSE_ENUM },
        secondary: { type: "STRING", enum: [...CAUSE_ENUM, "none"] },
        rationale: { type: "STRING" },
        sources: { type: "ARRAY", items: { type: "STRING" } },
      },
      required: ["primary", "secondary", "rationale", "sources"],
    },
    oneLineThesis: { type: "STRING", description: "One clause, for the digest line" },
    changeSincePrior: {
      type: "STRING",
      description: "What changed vs the most recent prior analysis (new filing, fired falsifier, reclassification); 'first look' when there is no prior",
    },
    moat: {
      type: "OBJECT",
      description: "Durable competitive advantage, judged from the business economics visible in the bundle",
      properties: {
        assessment: { type: "STRING", enum: ["wide", "narrow", "none", "unclear"] },
        rationale: { type: "STRING", description: "One sentence; ground in margins/pricing power/switching costs evident in the data" },
      },
      required: ["assessment", "rationale"],
    },
    keyFacts: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          fact: { type: "STRING" },
          source: { type: "STRING", description: "One accession number or concept key" },
        },
        required: ["fact", "source"],
      },
    },
    managementLanguage: {
      type: "OBJECT",
      description: "Hedging, blame-shifting, and what management conspicuously stopped mentioning",
      properties: {
        observations: { type: "ARRAY", items: { type: "STRING" } },
        sources: { type: "ARRAY", items: { type: "STRING" } },
      },
      required: ["observations", "sources"],
    },
    guidanceRead: {
      type: "OBJECT",
      properties: {
        change: { type: "STRING", enum: ["raised", "maintained", "lowered", "withdrawn", "unclear", "none_given"] },
        timingVsDemand: { type: "STRING", enum: ["timing", "demand", "unclear", "not_applicable"] },
        evidence: { type: "STRING", description: "Verbatim guidance language if present" },
        source: { type: "STRING" },
      },
      required: ["change", "timingVsDemand", "evidence", "source"],
    },
    reconciliation: {
      type: "ARRAY",
      description: "Possible narrative-vs-numbers discrepancies — glance list, NOT findings",
      items: {
        type: "OBJECT",
        properties: {
          discrepancy: { type: "STRING" },
          factSource: { type: "STRING", description: "Concept key or accession for the number side" },
          managementQuote: { type: "STRING", description: "Verbatim sentence from a document in the bundle" },
          quoteSource: { type: "STRING", description: "Accession of the document quoted" },
        },
        required: ["discrepancy", "factSource", "managementQuote", "quoteSource"],
      },
    },
    anomalies: {
      type: "ARRAY",
      items: { type: "STRING" },
      description: "Genuinely surprising disagreements worth leading with; empty is normal",
    },
    scenarios: {
      type: "ARRAY",
      description: "bear/base/bull at 1y and 3y — exactly 6 entries",
      items: {
        type: "OBJECT",
        properties: {
          horizonYears: { type: "STRING", enum: ["1", "3"] },
          scenarioCase: { type: "STRING", enum: ["bear", "base", "bull"] },
          narrativeWeight: { type: "NUMBER", description: "0-1; a narrative weight, NOT a calibrated probability" },
          drivers: { type: "ARRAY", items: { type: "STRING" }, description: "2-3 things that would have to be true" },
          valuationAnchor: {
            type: "OBJECT",
            description:
              "Assumptions only — code computes the implied price. Never compute a price yourself.",
            properties: {
              metric: { type: "STRING", enum: ["EV/EBITDA", "EV/Sales", "P/E", "P/S", "P/FCF", "P/B", "none"] },
              multiple: { type: "NUMBER", description: "The multiple applied in this scenario" },
              assumedMetricValueUsd: {
                type: "NUMBER",
                description: "Assumed absolute USD value of the metric in this scenario at this horizon (e.g. EBITDA 1200000000)",
              },
              rationale: { type: "STRING", description: "Why this multiple and this assumed value" },
              regimeShiftJustification: {
                type: "STRING",
                description:
                  "ONLY when going below the historical multiple band: name the structural break (lost patent, secular decline, downgrade) grounded in the filings. Empty string otherwise.",
              },
            },
            required: ["metric", "multiple", "assumedMetricValueUsd", "rationale"],
          },
          falsifier: {
            type: "STRING",
            description: "A concrete observable within 90 days that would kill this scenario — a checkable event, never a vibe",
          },
        },
        required: ["horizonYears", "scenarioCase", "narrativeWeight", "drivers", "valuationAnchor", "falsifier"],
      },
    },
  },
  required: [
    "insufficientEvidence",
    "dropCause",
    "oneLineThesis",
    "changeSincePrior",
    "moat",
    "keyFacts",
    "managementLanguage",
    "guidanceRead",
    "reconciliation",
    "anomalies",
    "scenarios",
  ],
} as const;

export interface Verdict {
  insufficientEvidence: boolean;
  dropCause: { primary: string; secondary: string; rationale: string; sources: string[] };
  oneLineThesis: string;
  changeSincePrior: string;
  moat: { assessment: "wide" | "narrow" | "none" | "unclear"; rationale: string };
  keyFacts: { fact: string; source: string }[];
  managementLanguage: { observations: string[]; sources: string[] };
  guidanceRead: { change: string; timingVsDemand: string; evidence: string; source: string };
  reconciliation: { discrepancy: string; factSource: string; managementQuote: string; quoteSource: string }[];
  anomalies: string[];
  scenarios: {
    horizonYears: "1" | "3";
    scenarioCase: string;
    narrativeWeight: number;
    drivers: string[];
    valuationAnchor: {
      metric: "EV/EBITDA" | "EV/Sales" | "P/E" | "P/S" | "P/FCF" | "P/B" | "none";
      multiple: number;
      assumedMetricValueUsd: number;
      rationale: string;
      regimeShiftJustification?: string;
    };
    falsifier: string;
  }[];
}

export const RANKING_SCHEMA = {
  type: "OBJECT",
  properties: {
    ranked: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          ticker: { type: "STRING" },
          justification: { type: "STRING", description: "One clause on why this rank" },
        },
        required: ["ticker", "justification"],
      },
    },
    notes: { type: "STRING", description: "Cross-candidate observations, if any" },
  },
  required: ["ranked", "notes"],
} as const;

export interface Ranking {
  ranked: { ticker: string; justification: string }[];
  notes: string;
}
