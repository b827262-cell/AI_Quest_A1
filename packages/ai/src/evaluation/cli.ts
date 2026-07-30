import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEvaluationDataset } from "./dataset-parser";
import { parseEvaluationFixtures } from "./fixture-parser";
import { runEvaluation } from "./runner";
import { toEvaluationJson, toEvaluationMarkdown } from "./reports";
import { parseEvaluationBaseline } from "./baseline-parser";
import type { EvaluationExecutionMode } from "./evaluation-types";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(name: string): boolean { return process.argv.includes(name); }
function numericOption(name: string): number | undefined {
  const value = option(name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number`);
  return parsed;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function main(): Promise<void> {
  const mode = (option("--mode") ?? "fixture") as EvaluationExecutionMode;
  if (!["fixture", "mock_orchestrator", "live"].includes(mode)) throw new Error("--mode must be fixture, mock_orchestrator, or live");
  if (mode === "live") {
    if (!hasFlag("--allow-live") || process.env.AI_EVAL_ALLOW_LIVE !== "true") throw new Error("live mode requires --allow-live and AI_EVAL_ALLOW_LIVE=true");
    if (numericOption("--max-cases") === undefined || numericOption("--max-token-budget") === undefined) throw new Error("live mode requires bounded --max-cases and --max-token-budget");
    throw new Error("live mode has no provider adapter in this phase");
  }
  const datasetPath = resolve(process.cwd(), option("--dataset") ?? "evals/datasets/phase-4a-core.json");
  const fixturePath = resolve(process.cwd(), "evals/fixtures/phase-4a-core.json");
  const dataset = parseEvaluationDataset(await readJson(datasetPath));
  const fixtures = parseEvaluationFixtures(await readJson(fixturePath));
  const baselinePath = option("--baseline");
  const baseline = baselinePath ? parseEvaluationBaseline(await readJson(resolve(process.cwd(), baselinePath))) : undefined;
  const output = await runEvaluation(dataset, { mode, fixtures, maxCases: numericOption("--max-cases"), category: option("--category") as never, difficulty: option("--difficulty") as never, baseline });
  const format = option("--format") ?? "markdown";
  if (format !== "json" && format !== "markdown") throw new Error("--format must be json or markdown");
  const rendered = format === "json" ? toEvaluationJson(output.report) : toEvaluationMarkdown(output.report, dataset.cases);
  const outputPath = option("--output");
  if (outputPath) await writeFile(resolve(process.cwd(), outputPath), rendered, "utf8");
  else process.stdout.write(rendered);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "evaluation_failed"}\n`);
  process.exitCode = 1;
});
