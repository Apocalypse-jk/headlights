import { chromium } from "@playwright/test";
import { execFile } from "node:child_process";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const config = {
  baseUrl: env("BENCH_BASE_URL", "http://localhost:3000"),
  composeFile: env("BENCH_COMPOSE_FILE", "bbmri-sample-locator/compose.local.yaml"),
  composeProfile: env("BENCH_COMPOSE_PROFILE", "opa"),
  architecture: env("BENCH_ARCHITECTURE", "opa-policy-proxy"),
  iterations: nonNegativeIntEnv("BENCH_ITERATIONS", 10),
  warmupIterations: nonNegativeIntEnv("BENCH_WARMUP_ITERATIONS", 3),
  concurrency: intEnv("BENCH_CONCURRENCY", 1),
  timeoutMs: intEnv("BENCH_TIMEOUT_MS", 180_000),
  statsIntervalMs: intEnv("BENCH_STATS_INTERVAL_MS", 1_000),
  outputRoot: env("BENCH_OUTPUT_ROOT", "policy-engine/benchmarks/runs"),
  policyLogService: optionalEnv("BENCH_POLICY_LOG_SERVICE", "policy-proxy2"),
  scenarioSelection: optionalEnv("BENCH_SCENARIOS", ""),
};

const scenarios = [
  {
    name: "01_empty",
    queryType: "leer",
    minPatientCount: 1,
    query: undefined,
  },
  {
    name: "02_no_result_gender_other",
    queryType: "ohne_ergebnis",
    minPatientCount: 0,
    query: [[{
      id: "2f01c70e-a112-4a9c-8787-1b8a695a6172",
      key: "gender",
      name: "Gender",
      type: "EQUALS",
      values: [{ name: "other", value: "other", queryBindId: "a087cadf-9d3c-44d2-8e06-5ce040344aa0" }],
    }]],
  },
  {
    name: "03_gender_male",
    queryType: "einfacher_filter",
    minPatientCount: 1,
    query: [[{
      id: "d35d3138-d438-468c-8db3-9871172a7d1a",
      key: "gender",
      name: "Gender",
      type: "EQUALS",
      values: [{ name: "male", value: "male", queryBindId: "e97389c7-b5ba-43a8-804a-38c426df9a39" }],
    }]],
  },
  {
    name: "04_gender_male_donor_age_30_50",
    queryType: "zwei_filter",
    minPatientCount: 1,
    query: [[
      {
        id: "d35d3138-d438-468c-8db3-9871172a7d1a",
        key: "gender",
        name: "Gender",
        type: "EQUALS",
        values: [{ name: "male", value: "male", queryBindId: "e97389c7-b5ba-43a8-804a-38c426df9a39" }],
      },
      {
        id: "a82e1b88-4587-485d-9880-eb7d6bb63b09",
        key: "donor_age",
        name: "Donor Age",
        type: "BETWEEN",
        values: [{ name: "30 - 50", value: { min: 30, max: 50 }, queryBindId: "f355c3bf-9a69-4576-b511-92b6ef58139a" }],
      },
    ]],
  },
  {
    name: "05_gender_female_donor_age_20_40_sample_plasma",
    queryType: "drei_filter",
    minPatientCount: 1,
    query: [[
      {
        id: "c56cfa89-c6ce-47d3-a361-f898b62bbb67",
        key: "gender",
        name: "Gender",
        type: "EQUALS",
        values: [{ name: "female", value: "female", queryBindId: "a6c4032d-9bda-4ed2-b3dd-42af6502293a" }],
      },
      {
        id: "618354ca-df16-4690-80ef-1213d56068c8",
        key: "donor_age",
        name: "Donor Age",
        type: "BETWEEN",
        values: [{ name: "20 - 40", value: { min: 20, max: 40 }, queryBindId: "7f6a87a2-3bb8-46e4-bf63-4d78f66afeb1" }],
      },
      {
        id: "d5333862-ef00-43fb-99fb-43e24bf539d5",
        key: "sample_kind",
        name: "Sample type",
        type: "EQUALS",
        values: [{ name: "Plasma", value: "blood-plasma", queryBindId: "bdaf66ea-c985-41fc-96a7-fe054291ef67" }],
      },
    ]],
  },
  {
    name: "06_gender_male_donor_age_40_60_sample_serum_or_plasma",
    queryType: "vier_filter",
    minPatientCount: 1,
    query: [[
      {
        id: "d35d3138-d438-468c-8db3-9871172a7d1a",
        key: "gender",
        name: "Gender",
        type: "EQUALS",
        values: [{ name: "male", value: "male", queryBindId: "e97389c7-b5ba-43a8-804a-38c426df9a39" }],
      },
      {
        id: "0231b752-62b5-467d-9bc5-eeab79a36108",
        key: "donor_age",
        name: "Donor Age",
        type: "BETWEEN",
        values: [{ name: "40 - 60", value: { min: 40, max: 60 }, queryBindId: "0ed16479-d539-4168-9d8d-0edcbd1f5d1d" }],
      },
      {
        id: "29d9c87f-7a81-4bdb-aa1b-3f5a272dfd86",
        key: "sample_kind",
        name: "Sample type",
        type: "EQUALS",
        values: [
          { name: "Serum", value: "blood-serum", queryBindId: "75c04077-0312-4fd2-a74f-bf3766f7459c" },
          { name: "Plasma", value: "blood-plasma", queryBindId: "60b9b71b-91e3-47fa-9d7c-9bf041263652" },
        ],
      },
    ]],
  },
];

const runId = new Date().toISOString().replace(/[:.]/g, "-");
const outputDir = join(config.outputRoot, `${runId}-${config.architecture}`);
const csvPath = join(outputDir, "measurements.csv");
const statsPath = join(outputDir, "docker-stats.csv");
const reportPath = join(outputDir, "summary.html");
const selectedScenarios = selectScenarios(scenarios, config.scenarioSelection);

const allRows = [];
const allStats = [];
const totalRequests = selectedScenarios.length * (config.warmupIterations + config.iterations);
let completedRequests = 0;

const measurementHeaders = [
  "timestamp",
  "architecture",
  "phase",
  "scenario",
  "query_type",
  "concurrency",
  "run",
  "start_time",
  "end_time",
  "duration_ms",
  "status",
  "patient_count",
  "policy_decision",
  "policy_status",
  "policy_task_id",
  "policy_evaluation_ms",
  "error",
];

const dockerStatsHeaders = [
  "timestamp",
  "architecture",
  "scenario",
  "phase",
  "concurrency",
  "batch_start_run",
  "container",
  "cpu_percent",
  "memory_usage_mib",
  "memory_raw",
  "net_io",
  "block_io",
];

async function main() {
  await mkdir(outputDir, { recursive: true });
  await verifyBenchmarkEnvironment();
  await initializeCsv(csvPath, measurementHeaders);
  await initializeCsv(statsPath, dockerStatsHeaders);

  console.log(`Total benchmark requests: ${totalRequests}`);
  console.log(`Measurements are written incrementally to: ${csvPath}`);
  console.log(`Docker stats are written incrementally to:  ${statsPath}`);

  const browser = await chromium.launch({ headless: true });

  try {
    for (const scenario of selectedScenarios) {
      await runScenario(browser, scenario, true);
    }

    for (const scenario of selectedScenarios) {
      await runScenario(browser, scenario, false);
    }
  } finally {
    await browser.close();
  }

  await writeFile(reportPath, renderHtmlReport(allRows, config), "utf8");

  console.log(`Benchmark complete.`);
  console.log(`Measurements: ${csvPath}`);
  console.log(`Docker stats:  ${statsPath}`);
  console.log(`Report:        ${reportPath}`);
}

async function verifyBenchmarkEnvironment() {
  console.log(`Benchmark architecture: ${config.architecture}`);
  console.log(`Base URL: ${config.baseUrl}`);
  console.log(`Compose file: ${config.composeFile}`);
  console.log(`Policy log service: ${config.policyLogService ?? "disabled"}`);

  try {
    await fetch(config.baseUrl, { signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    throw new Error(
      `The benchmark web app is not reachable at ${config.baseUrl}. Start the Docker stack first. ` +
      `Original error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    await execFileAsync("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 10_000 });
  } catch (error) {
    throw new Error(
      `Docker is not reachable from this shell. Start Docker Desktop and retry. ` +
      `Original error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function runScenario(browserInstance, scenario, warmup) {
  const total = warmup ? config.warmupIterations : config.iterations;
  const phase = warmup ? "warmup" : "measurement";

  for (let offset = 0; offset < total; offset += config.concurrency) {
    const batchSize = Math.min(config.concurrency, total - offset);
    const sampler = new DockerStatsSampler(config.statsIntervalMs);
    await sampler.start();

    const promises = Array.from({ length: batchSize }, async (_, batchIndex) => {
      const row = await runSingle(browserInstance, scenario, phase, offset + batchIndex + 1);
      allRows.push(row);
      await appendCsvRows(csvPath, [row], measurementHeaders);

      completedRequests += 1;
      console.log(
        `[${completedRequests}/${totalRequests}] phase=${phase} scenario=${scenario.name} ` +
        `run=${row.run} status=${row.status} duration=${row.duration_ms}ms patients=${row.patient_count || "n/a"}`,
      );

      return row;
    });

    await Promise.all(promises);
    const stats = await sampler.stop();
    const statsRows = stats.map((entry) => ({
      ...entry,
      architecture: config.architecture,
      scenario: scenario.name,
      phase,
      concurrency: config.concurrency,
      batch_start_run: offset + 1,
    }));

    allStats.push(...statsRows);
    await appendCsvRows(statsPath, statsRows, dockerStatsHeaders);
  }
}

async function runSingle(browserInstance, scenario, phase, runNumber) {
  const context = await browserInstance.newContext();
  const page = await context.newPage();
  const debugMessages = [];
  const startTime = new Date();
  const startMs = performance.now();

  let status = "timeout";
  let patientCount = "";
  let errorMessage = "";

  try {
    attachBrowserDiagnostics(page, debugMessages);

    await page.goto(scenarioUrl(scenario), {
      waitUntil: "domcontentloaded",
      timeout: config.timeoutMs,
    });

    await waitForSearchCompletion(page, config.timeoutMs, scenario, phase, runNumber, debugMessages);
    const bodyText = await readSearchText(page);

    status = inferStatus(bodyText);
    patientCount = parsePatientCount(bodyText);
  } catch (error) {
    errorMessage = addDebugContext(error instanceof Error ? error.message : String(error), debugMessages);
    status = /timed out|timeout/i.test(errorMessage) ? "timeout" : "failed";
    await writeDebugArtifacts(page, scenario, phase, runNumber, status, debugMessages);
  } finally {
    await context.close();
  }

  const endTime = new Date();
  const durationMs = Math.round(performance.now() - startMs);
  const policy = await readPolicyDecisionSince(startTime);

  return {
    timestamp: new Date().toISOString(),
    architecture: config.architecture,
    phase,
    scenario: scenario.name,
    query_type: scenario.queryType,
    concurrency: config.concurrency,
    run: runNumber,
    start_time: startTime.toISOString(),
    end_time: endTime.toISOString(),
    duration_ms: durationMs,
    status,
    patient_count: patientCount,
    policy_decision: policy.decision,
    policy_status: policy.status,
    policy_task_id: policy.task_id,
    policy_evaluation_ms: policy.evaluation_ms,
    error: errorMessage,
  };
}

function scenarioUrl(scenario) {
  if (!scenario.query) {
    return `${config.baseUrl}/search`;
  }

  return `${config.baseUrl}/search?query=${encodeURIComponent(JSON.stringify(scenario.query))}`;
}

function attachBrowserDiagnostics(page, debugMessages) {
  page.on("console", (message) => {
    debugMessages.push({
      timestamp: new Date().toISOString(),
      type: "console",
      level: message.type(),
      text: message.text(),
    });
  });

  page.on("pageerror", (error) => {
    debugMessages.push({
      timestamp: new Date().toISOString(),
      type: "pageerror",
      text: error.message,
    });
  });

  page.on("requestfailed", (request) => {
    debugMessages.push({
      timestamp: new Date().toISOString(),
      type: "requestfailed",
      method: request.method(),
      url: request.url(),
      failure: request.failure()?.errorText ?? "",
    });
  });

  page.on("response", (response) => {
    if (response.status() >= 400) {
      debugMessages.push({
        timestamp: new Date().toISOString(),
        type: "response",
        status: response.status(),
        url: response.url(),
      });
    }
  });
}

async function waitForSearchCompletion(page, timeoutMs, scenario, phase, runNumber, debugMessages) {
  const startedAt = performance.now();
  let lastText = "";

  while (performance.now() - startedAt < timeoutMs) {
    const state = await readSearchState(page);

    lastText = state.tableText || state.lensText || state.bodyText;

    const visibleText = [state.bodyText, state.tableText, state.lensText].join("\n");
    const hasFailure = /permfailed|tempfailed|timeout|failed|error|fehler|wait_expired/i.test(visibleText);
    const hasTableNumber = /\d/.test(state.tableText);
    const hasLensResultNumber = /\d/.test(state.lensText);
    const patientCount = state.patientCount || parsePatientCount(visibleText);
    const patientCountNumber = Number.parseFloat(patientCount);
    const hasPatientCount =
      patientCount !== "" &&
      Number.isFinite(patientCountNumber) &&
      patientCountNumber >= scenario.minPatientCount;
    const hasFinishedLoading = !state.isLoading;
    const hasResultTable = state.tableCount > 0 && hasTableNumber;
    const hasLensResult = state.lensResultCount > 0 && hasLensResultNumber;
    const hasLikelyResultNumber = /\d/.test(state.bodyText) && !/loading|lädt|wird geladen/i.test(state.bodyText);

    if (hasFailure || (hasFinishedLoading && hasPatientCount)) {
      return;
    }

    await page.waitForTimeout(100);
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for search completion. ` +
    `Last visible text: ${lastText.slice(0, 500).replace(/\s+/g, " ")}`,
  );
}

function addDebugContext(message, debugMessages) {
  const recentDiagnostics = debugMessages
    .slice(-8)
    .map((entry) => {
      if (entry.type === "response") {
        return `${entry.type} ${entry.status} ${entry.url}`;
      }
      if (entry.type === "requestfailed") {
        return `${entry.type} ${entry.method} ${entry.url} ${entry.failure}`;
      }
      return `${entry.type} ${entry.level ?? ""} ${entry.text}`.trim();
    })
    .join(" | ");

  return recentDiagnostics ? `${message} Recent browser diagnostics: ${recentDiagnostics}` : message;
}

async function readSearchText(page) {
  const state = await readSearchState(page);
  return [
    state.bodyText,
    state.tableText,
    state.lensText,
    state.patientCount ? `Patients ${state.patientCount}` : "",
    state.specimenCount ? `Specimens ${state.specimenCount}` : "",
  ].join("\n");
}

async function readSearchState(page) {
  return page.evaluate(() => {
    function normalizeNumberFromCell(text) {
      const match = text.replace(/\s+/g, " ").match(/\b\d[\d.,]*\b/);
      return match?.[0]?.replace(/\./g, "").replace(",", ".") ?? "";
    }

    function readResultTableValues(tableElements) {
      for (const table of tableElements) {
        const rows = [...table.querySelectorAll("tr")];
        if (rows.length < 2) {
          continue;
        }

        const headerCells = [...rows[0].querySelectorAll("th, td")]
          .map((cell) => cell.textContent?.trim().toLowerCase() ?? "");
        const patientIndex = headerCells.findIndex((text) => text.includes("patients") || text.includes("patienten"));
        const specimenIndex = headerCells.findIndex((text) => text.includes("specimens") || text.includes("proben"));
        if (patientIndex < 0) {
          continue;
        }

        for (const row of rows.slice(1)) {
          const cells = [...row.querySelectorAll("td, th")];
          const patientText = cells[patientIndex]?.textContent?.trim() ?? "";
          const specimenText = specimenIndex >= 0 ? cells[specimenIndex]?.textContent?.trim() ?? "" : "";
          const patientCount = normalizeNumberFromCell(patientText);

          if (patientCount !== "") {
            return {
              patientCount,
              specimenCount: normalizeNumberFromCell(specimenText),
            };
          }
        }
      }

      return {
        patientCount: "",
        specimenCount: "",
      };
    }

    const bodyText = document.body.innerText ?? "";
    const tableElements = [...document.querySelectorAll("table, [role='table']")];
    const lensElements = [...document.querySelectorAll("lens-result-summary, lens-result-table")];
    const tableText = tableElements
      .map((table) => table.innerText ?? table.textContent ?? "")
      .join("\n");
    const lensText = lensElements
      .map((element) => [
        element.textContent ?? "",
        element.shadowRoot?.textContent ?? "",
      ].join("\n"))
      .join("\n");
    const resultValues = readResultTableValues(tableElements);

    return {
      bodyText,
      tableText,
      lensText,
      patientCount: resultValues.patientCount,
      specimenCount: resultValues.specimenCount,
      isLoading: /loading|lädt|wird geladen/i.test([bodyText, tableText, lensText].join("\n")),
      tableCount: tableElements.length,
      lensResultCount: lensElements.length,
    };
  });
}

function inferStatus(text) {
  if (/permfailed/i.test(text)) {
    return "permfailed";
  }
  if (/tempfailed/i.test(text)) {
    return "tempfailed";
  }
  if (/timeout/i.test(text)) {
    return "timeout";
  }
  if (/failed|error|fehler/i.test(text)) {
    return "failed";
  }
  return "succeeded";
}

function parsePatientCount(text) {
  const normalized = text.replace(/\s+/g, " ");
  const patientMatch = normalized.match(/(?:patients?|patienten)\D{0,40}([\d.,]+)/i);
  if (patientMatch?.[1]) {
    return normalizeNumber(patientMatch[1]);
  }

  const leadingPatientMatch = normalized.match(/([\d.,]+)\D{0,40}(?:patients?|patienten)/i);
  if (leadingPatientMatch?.[1]) {
    return normalizeNumber(leadingPatientMatch[1]);
  }

  return "";
}

function normalizeNumber(value) {
  return value.replace(/\./g, "").replace(",", ".");
}

function selectScenarios(availableScenarios, selection) {
  if (!selection) {
    return availableScenarios;
  }

  const requestedNames = selection
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);

  const selected = availableScenarios.filter((scenario) => requestedNames.includes(scenario.name));
  if (selected.length === 0) {
    throw new Error(
      `BENCH_SCENARIOS did not match any scenario. Requested: ${requestedNames.join(", ")}`,
    );
  }

  return selected;
}

async function writeDebugArtifacts(page, scenario, phase, runNumber, suffix, debugMessages) {
  const safeName = `${phase}-${scenario.name}-run-${runNumber}`;

  try {
    await page.screenshot({
      path: join(outputDir, `${safeName}-${suffix}.png`),
      fullPage: true,
    });
  } catch {
    // Debug artifacts are useful, but benchmark recording should continue.
  }

  try {
    await writeFile(join(outputDir, `${safeName}-${suffix}.html`), await page.content(), "utf8");
  } catch {
    // Debug artifacts are useful, but benchmark recording should continue.
  }

  try {
    const bodyText = await page.locator("body").innerText({ timeout: 2_000 }).catch(() => "");
    const title = await page.title().catch(() => "");
    await writeFile(
      join(outputDir, `${safeName}-${suffix}.debug.json`),
      JSON.stringify({
        timestamp: new Date().toISOString(),
        url: page.url(),
        title,
        bodyText: bodyText.slice(0, 5_000),
        browserDiagnostics: debugMessages,
      }, null, 2),
      "utf8",
    );
  } catch {
    // Debug artifacts are useful, but benchmark recording should continue.
  }
}

async function readPolicyDecisionSince(since) {
  if (!config.policyLogService) {
    return {
      decision: "not_applicable",
      status: "not_applicable",
      task_id: "",
      evaluation_ms: "",
    };
  }

  try {
    const args = composeArgs([
      "logs",
      "--since",
      since.toISOString(),
      "--tail",
      "300",
      config.policyLogService,
    ]);
    const { stdout } = await execFileAsync("docker", args, { timeout: 30_000 });
    const entries = parseAuditEntries(stdout)
      .filter((entry) => entry.event === "output_policy_decision")
      .filter((entry) => entry.status === "succeeded" || entry.status === "permfailed");

    const entry = entries.at(-1);
    if (!entry) {
      return { decision: "", status: "", task_id: "", evaluation_ms: "" };
    }

    return {
      decision: entry.decision ?? "",
      status: entry.status ?? "",
      task_id: entry.task_id ?? "",
      evaluation_ms: entry.details?.policy_evaluation_ms ?? "",
    };
  } catch {
    return { decision: "", status: "", task_id: "", evaluation_ms: "" };
  }
}

function parseAuditEntries(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.match(/\[policy-proxy\]\[audit\]\s+(\{.*\})/)?.[1])
    .filter(Boolean)
    .map((json) => {
      try {
        return JSON.parse(json);
      } catch {
        return undefined;
      }
    })
    .filter(Boolean);
}

class DockerStatsSampler {
  constructor(intervalMs) {
    this.intervalMs = intervalMs;
    this.rows = [];
    this.timer = undefined;
  }

  async start() {
    await this.sample();
    this.timer = setInterval(() => {
      void this.sample();
    }, this.intervalMs);
  }

  async stop() {
    if (this.timer) {
      clearInterval(this.timer);
    }
    await this.sample();
    return this.rows;
  }

  async sample() {
    try {
      const { stdout } = await execFileAsync("docker", [
        "stats",
        "--no-stream",
        "--format",
        "{{json .}}",
      ], { timeout: 20_000 });

      for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
        const raw = JSON.parse(line);
        this.rows.push({
          timestamp: new Date().toISOString(),
          container: raw.Name,
          cpu_percent: parsePercent(raw.CPUPerc),
          memory_usage_mib: parseMemoryUsageMiB(raw.MemUsage),
          memory_raw: raw.MemUsage,
          net_io: raw.NetIO,
          block_io: raw.BlockIO,
        });
      }
    } catch {
      // Docker stats are helpful but should not abort the benchmark run.
    }
  }
}

function composeArgs(args) {
  const result = ["compose", "-f", config.composeFile];
  if (config.composeProfile) {
    result.push("--profile", config.composeProfile);
  }
  result.push(...args);
  return result;
}

function parsePercent(value) {
  return value ? Number.parseFloat(value.replace("%", "").replace(",", ".")) : "";
}

function parseMemoryUsageMiB(value) {
  if (!value) {
    return "";
  }

  const used = value.split("/")[0]?.trim();
  const match = used?.match(/^([\d.,]+)\s*([KMGT]?i?B)$/i);
  if (!match?.[1] || !match[2]) {
    return "";
  }

  const number = Number.parseFloat(match[1].replace(",", "."));
  const unit = match[2].toLowerCase();
  const factor = {
    b: 1 / 1024 / 1024,
    kb: 1 / 1024,
    kib: 1 / 1024,
    mb: 1,
    mib: 1,
    gb: 1024,
    gib: 1024,
    tb: 1024 * 1024,
    tib: 1024 * 1024,
  }[unit];

  return factor === undefined ? "" : Math.round(number * factor * 100) / 100;
}

function toCsv(rows) {
  if (rows.length === 0) {
    return "";
  }

  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(",")),
  ].join("\n");
}

async function initializeCsv(path, headers) {
  await writeFile(path, `${headers.join(",")}\n`, "utf8");
}

async function appendCsvRows(path, rows, headers) {
  if (rows.length === 0) {
    return;
  }

  const lines = rows.map((row) => headers.map((header) => csvCell(row[header])).join(","));
  await appendFile(path, `${lines.join("\n")}\n`, "utf8");
}

function csvCell(value) {
  if (value === undefined || value === null) {
    return "";
  }

  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function renderHtmlReport(rows, reportConfig) {
  const measured = rows.filter((row) => row.phase === "measurement");
  const grouped = groupBy(measured, (row) => row.scenario);
  const summaries = [...grouped.entries()].map(([scenario, scenarioRows]) => ({
    scenario,
    count: scenarioRows.length,
    median: percentile(scenarioRows.map((row) => Number(row.duration_ms)), 50),
    p90: percentile(scenarioRows.map((row) => Number(row.duration_ms)), 90),
    p95: percentile(scenarioRows.map((row) => Number(row.duration_ms)), 95),
    failures: scenarioRows.filter((row) => row.status !== "succeeded").length,
  }));
  const maxP95 = Math.max(1, ...summaries.map((summary) => summary.p95));

  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>Policy Proxy Benchmark ${escapeHtml(reportConfig.architecture)}</title>
<style>
body { font-family: system-ui, sans-serif; margin: 32px; color: #1f2933; }
table { border-collapse: collapse; width: 100%; margin-top: 24px; }
th, td { border-bottom: 1px solid #d9e2ec; padding: 8px; text-align: left; }
.bar { height: 18px; background: #4f46e5; border-radius: 4px; }
.muted { color: #52606d; }
</style>
<h1>Policy Proxy Benchmark</h1>
<p class="muted">Architecture: ${escapeHtml(reportConfig.architecture)} | Concurrency: ${reportConfig.concurrency}</p>
<table>
  <thead>
    <tr><th>Scenario</th><th>Runs</th><th>Median ms</th><th>P90 ms</th><th>P95 ms</th><th>Failures</th><th>P95 Plot</th></tr>
  </thead>
  <tbody>
    ${summaries.map((summary) => `
    <tr>
      <td>${escapeHtml(summary.scenario)}</td>
      <td>${summary.count}</td>
      <td>${Math.round(summary.median)}</td>
      <td>${Math.round(summary.p90)}</td>
      <td>${Math.round(summary.p95)}</td>
      <td>${summary.failures}</td>
      <td><div class="bar" style="width:${Math.max(2, (summary.p95 / maxP95) * 100)}%"></div></td>
    </tr>`).join("")}
  </tbody>
</table>
</html>`;
}

function groupBy(values, keyFn) {
  const result = new Map();
  for (const value of values) {
    const key = keyFn(value);
    result.set(key, [...(result.get(key) ?? []), value]);
  }
  return result;
}

function percentile(values, percentileValue) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) {
    return 0;
  }
  const index = (percentileValue / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) {
    return sorted[lower];
  }
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function env(name, fallback) {
  return process.env[name] || fallback;
}

function optionalEnv(name, fallback) {
  if (!(name in process.env)) {
    return fallback;
  }

  const value = process.env[name]?.trim();
  if (!value || ["disabled", "none", "off", "false"].includes(value.toLowerCase())) {
    return undefined;
  }

  return value;
}

function intEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || String(fallback), 10);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeIntEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

await main();
