param(
  [string]$Architecture = "opa-policy-proxy",
  [int]$Iterations = 30,
  [int]$WarmupIterations = 5,
  [int]$Concurrency = 1,
  [int]$TimeoutMs = 600000,
  [string]$BaseUrl = "http://localhost:3000",
  [string]$ComposeFile = "bbmri-sample-locator/compose.local.yaml",
  [string]$ComposeProfile = "opa",
  [string]$PolicyLogService = "policy-proxy2",
  [string]$Scenarios = ""
)

$ErrorActionPreference = "Stop"

$env:BENCH_ARCHITECTURE = $Architecture
$env:BENCH_ITERATIONS = "$Iterations"
$env:BENCH_WARMUP_ITERATIONS = "$WarmupIterations"
$env:BENCH_CONCURRENCY = "$Concurrency"
$env:BENCH_TIMEOUT_MS = "$TimeoutMs"
$env:BENCH_BASE_URL = $BaseUrl
$env:BENCH_COMPOSE_FILE = $ComposeFile
$env:BENCH_COMPOSE_PROFILE = if ($ComposeProfile -eq "") { "disabled" } else { $ComposeProfile }
$env:BENCH_POLICY_LOG_SERVICE = if ($PolicyLogService -eq "") { "disabled" } else { $PolicyLogService }
$env:BENCH_SCENARIOS = if ($Scenarios -eq "") { "disabled" } else { $Scenarios }

node policy-engine/benchmarks/run-benchmark.mjs
