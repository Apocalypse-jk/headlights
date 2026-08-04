# Policy Proxy Benchmarks

This folder contains a small benchmark runner for the local BBMRI Sample Locator
setup. It drives the Lens web app through Playwright, records end-to-end request
latency, collects Docker CPU/RAM samples, and writes CSV files plus a small HTML
summary.

## Requirements

- The local stack is already running.
- The root `node_modules` folder exists (`npm install` in the repository root).
- Docker is available from PowerShell.

## Run

From the repository root:

```powershell
.\policy-engine\benchmarks\playwright\run-benchmark.ps1 `
  -Architecture opa-policy-proxy `
  -WarmupIterations 5 `
  -Iterations 30 `
  -Concurrency 1
```

For parallel requests:

```powershell
.\policy-engine\benchmarks\playwright\run-benchmark.ps1 `
  -Architecture opa-policy-proxy `
  -WarmupIterations 5 `
  -Iterations 30 `
  -Concurrency 10
```

```powershell
.\policy-engine\benchmarks\playwright\run-benchmark.ps1 `
  -Architecture opa-policy-proxy `
  -WarmupIterations 5 `
  -Iterations 30 `
  -Concurrency 30
```

## Scenarios

The benchmark currently executes these predefined search scenarios:

| Scenario | Query type | Query |
| --- | --- | --- |
| `01_empty` | `leer` | no filter |
| `02_no_result_gender_other` | `ohne_ergebnis` | `gender = other` |
| `03_gender_male` | `einfacher_filter` | `gender = male` |
| `04_gender_male_donor_age_30_50` | `zwei_filter` | `gender = male`, `donor_age = 30-50` |
| `05_gender_female_donor_age_20_40_sample_plasma` | `drei_filter` | `gender = female`, `donor_age = 20-40`, `sample_kind = blood-plasma` |
| `06_gender_male_donor_age_40_60_sample_serum_or_plasma` | `vier_filter` | `gender = male`, `donor_age = 40-60`, `sample_kind = blood-serum OR blood-plasma` |

In scenario 6, both sample kinds are encoded as two values of the same
`sample_kind` filter. This mirrors a multi-select filter and avoids turning the
query into `sample_kind = serum AND sample_kind = plasma`.

## Baseline vs Policy Proxy

For the baseline run, start the stack with Focus connected directly to `proxy2`
instead of `policy-proxy2`:

```yaml
BEAM_PROXY_URL: http://proxy2:4002
```

Then run:

```powershell
docker compose -f bbmri-sample-locator/compose.local.yaml up -d `
  vault pki-setup broker proxy1 proxy2 lens spot blaze test-data-loader
```

```powershell
docker compose -f bbmri-sample-locator/compose.local.yaml up -d --no-deps focus
```

```powershell
.\policy-engine\benchmarks\playwright\run-benchmark.ps1 `
  -Architecture baseline `
  -WarmupIterations 5 `
  -Iterations 30 `
  -Concurrency 1 `
  -ComposeProfile "" `
  -PolicyLogService ""
```

For the OPA policy-proxy run, use:

```yaml
BEAM_PROXY_URL: http://policy-proxy2:4002
```

Then run:

```powershell
docker compose `  -f bbmri-sample-locator/compose.local.yaml `  --profile opa `  up -d --build 
```

```powershell
.\policy-engine\benchmarks\playwright\run-benchmark.ps1 `
  -Architecture opa-policy-proxy `
  -WarmupIterations 5 `
  -Iterations 30 `
  -Concurrency 1 `
  -ComposeProfile opa `
  -PolicyLogService policy-proxy2
```

## Output

Each run creates a timestamped folder under:

```text
policy-engine/benchmarks/playwright/runs/
```

Files:

- `measurements.csv`: one row per benchmark request
- `docker-stats.csv`: sampled CPU/RAM data from `docker stats`
- `summary.html`: quick visual check of median, p90 and p95 latency

`measurements.csv` and `docker-stats.csv` are written incrementally while the
benchmark is running. The terminal prints progress after each request, for
example:

```text
[120/420] phase=measurement scenario=03_gender_male run=30 status=succeeded duration=12345ms patients=120
```

If a long benchmark is interrupted, the CSV files still contain the rows that
were completed before the interruption. `summary.html` is written only after the
full benchmark finished.

The measurement CSV contains:

- start timestamp
- end timestamp
- duration in milliseconds
- status
- query type
- patient count parsed from the web app
- policy decision if available from the policy-proxy audit log
- Docker resource samples are stored separately in `docker-stats.csv`

Warmup rows are kept in the CSV with `phase=warmup`. Exclude them from final
analysis and use only `phase=measurement`.

For baseline runs without the policy proxy, set `-PolicyLogService ""`. The CSV
will still contain all end-to-end timings and Docker stats. Policy-related
columns are filled with `not_applicable` because there is no policy decision in
that architecture.
