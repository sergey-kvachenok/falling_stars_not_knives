import { generateJson } from "../analyst/provider.js";
import { buildAnalystPrompt } from "../analyst/prompts.js";
import type { TickerBundle } from "../bundle/build.js";
import type { FalsifierGrade, Prediction } from "./predictions.js";

// Falsifier grading at 90 days (PLAN.md §10.1) — the only feedback fast
// enough to steer prompt iteration. The judge sees the CURRENT bundle
// (fresh filings + metrics) and each scenario's falsifier, and decides
// fired / survived / uncheckable strictly from that evidence.

const GRADE_SCHEMA = {
  type: "OBJECT",
  properties: {
    grades: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          scenario: { type: "STRING", description: "Echo the scenario label exactly as given" },
          status: { type: "STRING", enum: ["fired", "survived", "uncheckable"] },
          evidence: { type: "STRING", description: "What in the bundle decided it; for uncheckable, why" },
        },
        required: ["scenario", "status", "evidence"],
      },
    },
  },
  required: ["grades"],
} as const;

interface GradeResponse {
  grades: { scenario: string; status: FalsifierGrade["status"]; evidence: string }[];
}

export async function gradeFalsifiers(
  prediction: Prediction,
  currentBundle: TickerBundle,
): Promise<FalsifierGrade[]> {
  const { prompt: bundleContext } = buildAnalystPrompt(currentBundle);
  const list = prediction.scenarios
    .map((s) => `- [${s.horizonYears}y ${s.scenarioCase}] ${s.falsifier}`)
    .join("\n");
  const prompt = `${bundleContext}

TASK: ${prediction.runDate} scenarios for this company each named a falsifier — an observable
that would kill the scenario within ~90 days. Today, using ONLY the bundle above (fresh filings
and computed metrics), grade each falsifier:
- "fired": the bundle shows the named event happened
- "survived": the bundle shows it clearly did not happen
- "uncheckable": the bundle cannot decide it (that is a defect in how the falsifier was written —
  say what evidence would have been needed)
Echo each scenario label exactly. Falsifiers to grade:
${list}`;

  const res = await generateJson<GradeResponse>(prompt, GRADE_SCHEMA, { temperature: 0.2 });
  const byLabel = new Map(res.grades.map((g) => [g.scenario.replace(/[[\]]/g, "").trim(), g]));
  return prediction.scenarios.map((s) => {
    const label = `${s.horizonYears}y ${s.scenarioCase}`;
    const g = byLabel.get(label);
    return {
      scenario: label,
      falsifier: s.falsifier,
      status: g?.status ?? "uncheckable",
      evidence: g?.evidence ?? "judge did not return this scenario",
    };
  });
}
