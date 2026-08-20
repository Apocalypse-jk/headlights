# Headlights Policy Engine Evaluation

This repository is a research-oriented fork of
[Samply.Headlights](https://github.com/samply/headlights). It extends the local
BBMRI Sample Locator setup with configurable input and output authorization and
with reproducible benchmark variants for comparing policy architectures.

The currently implemented policy frameworks are:

- [Open Policy Agent (OPA)](https://www.openpolicyagent.org/) with Rego policies
- [Apache Casbin](https://casbin.org/) through an OPA-compatible adapter

The repository was developed for evaluating access-control policies in a
distributed medical search system. It is a local research and development
environment, not a production-ready deployment.

## Goals

- Keep Focus, Blaze and the Beam components unchanged.
- Separate application logic from authorization logic.
- Evaluate both incoming search tasks and outgoing query results.
- Preserve the original search context for result-dependent policies.
- Allow OPA, Casbin and a policy-free baseline to use the same application flow.
- Measure end-to-end latency under different concurrency and network conditions.
- Record policy-proxy decisions in a structured, hash-linked audit log.

## Architecture

The web application submits a search through Spot and Beam. Focus does not
receive tasks through an active push. It polls its configured Beam endpoint for
new tasks instead. In the policy variants, the Policy Proxy exposes the Beam
endpoints expected by Focus and forwards requests to the real local Beam proxy.

```text
Lens / BBMRI web application
          |
          v
        Spot -> proxy1 -> Beam Broker <- proxy2
                                        ^
                                        |
Focus -> Policy Proxy ------------------+
  |
  v
Blaze
```

The relevant sequence is:

1. Focus requests tasks from `GET /v1/tasks` on the Policy Proxy.
2. The Policy Proxy retrieves decrypted tasks from the real `proxy2`.
3. The input policy decides which tasks may reach Focus.
4. Focus executes allowed searches against Blaze.
5. Focus sends `claimed` and terminal results through the Policy Proxy.
6. The output policy evaluates the result together with the stored request context.
7. Allowed results are forwarded to Beam; denied results are replaced with a
   non-sensitive `permfailed` result.

The baseline override bypasses the Policy Proxy and connects Focus directly to
`proxy2`.

## Repository layout

```text
.
|-- bbmri-sample-locator/       Local web application, Focus and Blaze setup
|-- compose.localbeam.yaml      Beam Broker, Beam proxies and Policy Proxy
|-- pki-setup.sh                Local Vault/Beam PKI initialization
`-- policy-engine/
    |-- compose.policy-engine.yaml
    |-- compose.baseline.yaml
    |-- compose.toxiproxy.yaml
    |-- compose.toxiproxy.baseline.yaml
    |-- compose.mock-blaze.yaml
    |-- policy-proxy/           Beam-compatible TypeScript authorization proxy
    |-- opa/policies/           Input and output policies written in Rego
    |-- casbin/                 Casbin model, policy and HTTP adapter
    |-- mock-blaze/             Deterministic Blaze replacement
    `-- benchmarks/curl/        End-to-end benchmark and plotting scripts
```

## Prerequisites

- Docker Desktop or another Docker installation with Docker Compose v2
- Git
- PowerShell for the curl benchmark script
- Python 3 with `pandas` and `matplotlib` for plot generation
- Sufficient memory and disk space for Blaze and the generated test data

All commands below are intended to be executed from the repository root. The
local Compose configuration currently loads 100,000 test patients. The first
startup can therefore take several minutes.

## Quick start

Start the complete local setup with OPA:

```powershell
docker compose `
  -f .\bbmri-sample-locator\compose.local.yaml `
  --profile opa `
  up -d --build
```

Inspect the service state:

```powershell
docker compose `
  -f .\bbmri-sample-locator\compose.local.yaml `
  --profile opa `
  ps
```

Open the Sample Locator at <http://localhost:3000/search/>. A one-shot service
such as `pki-setup` or `test-data-loader` ending with `Exited (0)` is expected.

## Core start variants

Only one policy framework profile should be active at a time. OPA and Casbin
both use the internal Docker alias `policy-engine`; starting both profiles in
the same stack makes policy-engine resolution ambiguous.

### Baseline without a policy component

```powershell
docker compose `
  -f .\bbmri-sample-locator\compose.local.yaml `
  -f .\policy-engine\compose.baseline.yaml `
  up -d --build
```

### OPA

```powershell
docker compose `
  -f .\bbmri-sample-locator\compose.local.yaml `
  --profile opa `
  up -d --build
```

### Casbin

```powershell
docker compose `
  -f .\bbmri-sample-locator\compose.local.yaml `
  --profile casbin `
  up -d --build
```

`bbmri-sample-locator/compose.local.yaml` includes
`policy-engine/compose.policy-engine.yaml`, so no additional policy-engine
Compose file is required for OPA or Casbin.

## Optional benchmark components

### Toxiproxy

Toxiproxy introduces controlled network conditions between Focus and the
Policy Proxy. In the baseline variant it is placed between Focus and `proxy2`.
The benchmark runner configures these profiles in both directions:

| Profile | Latency | Jitter | Bandwidth |
| --- | ---: | ---: | ---: |
| `lan` | 0 ms | 0 ms | unlimited |
| `wan-typical` | 25 ms | 5 ms | 12,500 KB/s |
| `intercontinental` | 150 ms | 10 ms | 6,250 KB/s |

Start the baseline with Toxiproxy:

```powershell
docker compose `
  -f .\bbmri-sample-locator\compose.local.yaml `
  -f .\policy-engine\compose.toxiproxy.baseline.yaml `
  --profile toxiproxy `
  up -d --build
```

Start OPA with Toxiproxy:

```powershell
docker compose `
  -f .\bbmri-sample-locator\compose.local.yaml `
  -f .\policy-engine\compose.toxiproxy.yaml `
  --profile opa `
  --profile toxiproxy `
  up -d --build
```

For Casbin, use the same command with `--profile casbin` instead of
`--profile opa`.

### Mock Blaze

`compose.mock-blaze.yaml` replaces Blaze with a deterministic HTTP service. It
immediately returns the same predefined response for every supported request.
This removes Blaze database queries and FHIR processing as variable benchmark
factors, but does not represent the runtime of a real Blaze search.

The default mock result contains a total count of 15,050 and a diagnosis count
of 1,000 so that it can pass the current output policies.

Baseline with Mock Blaze and without Toxiproxy:

```powershell
docker compose `
  -f .\bbmri-sample-locator\compose.local.yaml `
  -f .\policy-engine\compose.mock-blaze.yaml `
  -f .\policy-engine\compose.baseline.yaml `
  up -d --build
```

OPA with Mock Blaze and Toxiproxy:

```powershell
docker compose `
  -f .\bbmri-sample-locator\compose.local.yaml `
  -f .\policy-engine\compose.mock-blaze.yaml `
  -f .\policy-engine\compose.toxiproxy.yaml `
  --profile opa `
  --profile toxiproxy `
  up -d --build
```

Casbin uses the same command with `--profile casbin`. For a baseline with both
Mock Blaze and Toxiproxy, replace `compose.toxiproxy.yaml` with
`compose.toxiproxy.baseline.yaml` and omit the policy profile.

## Current policy behavior

The OPA input policy is located at
`policy-engine/opa/policies/search.rego`. It currently permits search tasks
from `spot.proxy1.broker` when `focus.proxy2.broker` is a target.

The output policy in `policy-engine/opa/policies/result.rego`:

- permits the `claimed` task status;
- requires successful results to originate from `focus.proxy2.broker`;
- requires the original request context to be available;
- requires at least 50 patients and 50 diagnoses;
- accepts gender, donor-age and sample-kind buckets only when their count is
  zero or at least ten;
- permits a metadata value of `project:superuser` as an explicit exception.

OPA loads the mounted Rego files with `--watch`, so valid saved policy changes
are reloaded automatically. Check the OPA logs when a change prevents the
service from starting or being healthy.

The Casbin input and coarse output permissions are stored in
`policy-engine/casbin/policy.csv` and use the model in `model.conf`. The
content-aware output checks are implemented in the Casbin TypeScript adapter.
Changes to the Casbin model, policy or adapter require rebuilding the Casbin
service.

## Policy Proxy

The Policy Proxy exposes the Beam endpoints used by Focus and keeps the actual
Beam proxy responsible for broker communication, certificates, encryption and
Beam authentication. It performs fail-closed authorization by default.

Important environment variables are configured in `compose.localbeam.yaml`:

| Variable | Purpose |
| --- | --- |
| `UPSTREAM_BEAM_PROXY_URL` | Address of the real local Beam proxy |
| `POLICY_ENGINE_URL` | Shared address of the selected policy engine |
| `INPUT_POLICY_PATH` | Endpoint used for incoming task decisions |
| `OUTPUT_POLICY_PATH` | Endpoint used for outgoing result decisions |
| `POLICY_FAIL_MODE` | `closed` denies requests when evaluation fails |
| `POLICY_TIMEOUT_MS` | Timeout for one policy-engine request |
| `UPSTREAM_TIMEOUT_MS` | Timeout for one Beam upstream request |
| `TASK_CONTEXT_TTL_MS` | Lifetime of stored request context; default one hour |
| `AUDIT_LOG_PATH` | JSONL audit-log path inside the container |

Original task contexts are stored in an in-memory map keyed by task ID. This
allows output policies to match concurrent results to their original search
requests. The state is not shared between multiple Policy Proxy instances and
is lost when the container restarts.

## Audit log

The Policy Proxy records health checks, task retrieval, policy decisions,
forwarding steps, errors and task-context lifecycle events. Entries are written
as JSON Lines with an ISO timestamp, sequence number, SHA-256 entry hash and a
link to the previous entry hash.

View recent audit entries in the container:

```powershell
docker compose `
  -f .\bbmri-sample-locator\compose.local.yaml `
  exec policy-proxy2 sh -c "tail -n 20 /audit/policy-proxy2-audit.jsonl"
```

The log is stored in the `policy-proxy2-audit` Docker volume and therefore
survives normal container recreation. The hash chain makes unnoticed changes
detectable, but it is not tamper-proof when an attacker can rewrite the entire
file and all hashes. Production use would require protected or external log
storage.

## Curl end-to-end benchmarks

The PowerShell benchmark submits the realistic query stored in
`policy-engine/benchmarks/curl/curls.txt` to Spot, follows the returned SSE
stream until a terminal Beam result, and records every request immediately in
`measurements.csv`. Warmups run before measurement iterations.

Example for OPA:

```powershell
.\policy-engine\benchmarks\curl\run-realistic-curl.ps1 `
  -Architecture opa `
  -WarmupIterations 5 `
  -Iterations 30 `
  -Concurrency 10
```

Use `-Architecture casbin` or `-Architecture baseline` for the other variants.
The default network profiles are `lan`, `wan-typical` and `intercontinental`,
so a Toxiproxy stack must be running before this benchmark is started.

Measurements include timestamps, end-to-end duration, terminal status,
patient count, HTTP status, response size, task ID and timing markers for the
submission, first SSE event, `claimed` event and terminal result. New runs are
initially written below `policy-engine/benchmarks/curl/runs/`.

Plot scripts are separated by data source:

- `policy-engine/benchmarks/curl/blaze-scripts/`
- `policy-engine/benchmarks/curl/mock-blaze-scripts/`

They expect measurements grouped below `runs/blaze/` or `runs/mock-blaze/` by
architecture, repeated run and measurement name. Run a script with `--help` to
see its optional input and output arguments.

## Useful operations

Follow the main OPA data path:

```powershell
docker compose `
  -f .\bbmri-sample-locator\compose.local.yaml `
  --profile opa `
  logs -f --tail=100 focus policy-proxy2 proxy2 opa
```

Check the Policy Proxy health endpoint:

```powershell
curl.exe http://localhost:4002/v1/health
```

Stop a stack by repeating the same Compose files and profiles used to start it
and replacing `up -d --build` with `down`. Stop the previous stack before
switching between OPA, Casbin and baseline so inactive containers do not consume
resources or affect benchmark measurements.

## Known limitations

- The Compose files contain development credentials and must not be used as a
  production security configuration.
- Request context is held in one Policy Proxy process and is not horizontally
  shared or persisted.
- Casbin's content-aware privacy rules are partly implemented in its adapter,
  so benchmark results compare complete integrations rather than isolated
  policy-language execution.
- The benchmark environment is not resource-isolated; other host processes can
  influence measured latency and container resource usage.
- Mock-Blaze measurements isolate the rest of the architecture but do not model
  real database and FHIR-processing costs.
