#!/usr/bin/env node
/**
 * A-01 coverage aggregator.
 *
 * Reads a sanitized relay.verify JSON-Lines summary and reports:
 *   - natural vs synthetic valid counts (per site);
 *   - pathClass x method counts;
 *   - Student valid >= 300 / Admin valid >= 100 (natural only);
 *   - each applicable non-GET path x verb >= 30 (synthetic only supplements);
 *   - zero-tolerance counts (result=invalid; result=none with identityPresent);
 *   - the coverage equation as an explicit PROPOSAL.
 *
 * It never reads or writes raw log lines, PII or secrets — only aggregates.
 *
 * Usage:
 *   node scripts/a01-coverage/aggregate.mjs --input summary.jsonl
 *   node scripts/a01-coverage/aggregate.mjs --input summary.jsonl --equation eq.json
 *   cat summary.jsonl | node scripts/a01-coverage/aggregate.mjs --input -
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseJsonLines } from "./parse.mjs";
import { computeCounts } from "./counts.mjs";
import { computeEquation, EQUATION_LABEL } from "./equation.mjs";

function parseArgs(argv) {
  const args = { input: null, equation: null, out: null, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case "--input": args.input = next(); break;
      case "--equation": args.equation = next(); break;
      case "--out": args.out = next(); break;
      case "--json": args.json = true; break;
      case "--help": case "-h": args.help = true; break;
      default: throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function readInput(input) {
  if (input === "-") return readStdin();
  return readFile(input, "utf8");
}

/**
 * Build the full report from raw JSON-Lines text (pure; testable).
 * @param {string} text
 * @param {{equation?:object, thresholds?:object, applicable?:object[]}} [options]
 */
export function buildReport(text, options = {}) {
  const parsed = parseJsonLines(text);
  const counts = computeCounts(parsed.events, {
    thresholds: options.thresholds,
    applicable: options.applicable,
  });
  return {
    source: {
      total_lines: parsed.totalLines,
      blank_lines: parsed.blankLines,
      non_relay_lines: parsed.nonRelayLines,
      parsed_events: parsed.events.length,
      parse_errors: parsed.parseErrors.length,
      // Include the first few error line numbers (no content) so failures are
      // visible but nothing raw is retained.
      parse_error_lines: parsed.parseErrors.slice(0, 20).map((e) => e.line),
    },
    counts,
    equation: options.equation ? computeEquation(options.equation) : null,
  };
}

function humanSummary(report) {
  const c = report.counts;
  const lines = [];
  lines.push(`parsed events: ${report.source.parsed_events} (lines=${report.source.total_lines}, parse_errors=${report.source.parse_errors})`);
  lines.push(`valid natural:  student=${c.valid.student.natural}  admin=${c.valid.admin.natural}`);
  lines.push(`valid synthetic: student=${c.valid.student.synthetic}  admin=${c.valid.admin.synthetic}`);
  lines.push(`thresholds: student>=${c.thresholds.student_valid.required} ${c.thresholds.student_valid.met ? "MET" : "NOT MET"} (natural=${c.thresholds.student_valid.natural})`);
  lines.push(`            admin>=${c.thresholds.admin_valid.required} ${c.thresholds.admin_valid.met ? "MET" : "NOT MET"} (natural=${c.thresholds.admin_valid.natural})`);
  lines.push(`per-path>=${c.thresholds.per_path_verb.required}: ${c.thresholds.per_path_verb.status}`);
  if (c.thresholds.per_path_verb.status === "evaluated") {
    for (const row of c.thresholds.per_path_verb.rows) {
      lines.push(`  ${row.met ? "OK " : "MISS"} ${row.method} ${row.route} natural=${row.natural} synthetic=${row.synthetic} total=${row.total}`);
    }
  } else {
    lines.push(`  (${c.thresholds.per_path_verb.reason})`);
  }
  lines.push(`zero-tolerance: invalid=${c.zero_tolerance.invalid} none_with_identity=${c.zero_tolerance.none_with_identity} ${c.zero_tolerance.ok ? "OK" : "VIOLATION"}`);
  if (report.equation) {
    lines.push(`coverage equation [${report.equation.label}]: ingress=${report.equation.ingress_total} sum=${report.equation.sum} diff=${report.equation.difference} ${report.equation.ok ? "OK" : "MISMATCH"}`);
  } else {
    lines.push(`coverage equation: not provided (${EQUATION_LABEL})`);
  }
  return lines.join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help || !args.input) {
    console.log(
      "A-01 coverage aggregator.\n" +
      "  --input FILE   sanitized relay.verify JSON Lines ('-' for stdin)\n" +
      "  --equation F   optional JSON { ingressTotal, buckets:{...} } (proposal)\n" +
      "  --out FILE     write the JSON report to FILE\n" +
      "  --json         print the JSON report to stdout\n",
    );
    return args.help ? 0 : 1;
  }

  const text = await readInput(args.input);
  const equation = args.equation ? JSON.parse(await readFile(args.equation, "utf8")) : undefined;
  const report = buildReport(text, { equation });
  const json = `${JSON.stringify(report, null, 2)}\n`;

  if (args.out) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(args.out, json, "utf8");
  }
  if (args.json) process.stdout.write(json);
  else console.log(humanSummary(report));

  // Exit non-zero when a hard gate fails so callers can branch on it.
  const failed =
    report.source.parse_errors > 0 ||
    report.counts.zero_tolerance.ok === false ||
    (report.equation && report.equation.ok === false);
  return failed ? 2 : 0;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`coverage aggregator error: ${error?.name}: ${error?.message}`);
    process.exitCode = 1;
  });
}
