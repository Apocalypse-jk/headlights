# Policy Proxy

The policy proxy exposes the Beam.Proxy endpoints used by Focus and forwards
requests to the real local Beam proxy. It intercepts two operations:

- `GET /v1/tasks`: evaluates the input policy before tasks reach Focus.
- `PUT /v1/tasks/{task_id}/results/{app_id}`: evaluates the output policy before
  results reach Beam.

Denied input tasks are completed with a `permfailed` result. Denied output
results are replaced by a non-sensitive `permfailed` result. The original
result body is never forwarded to Beam when the output policy denies it.

## Environment variables

- `UPSTREAM_BEAM_PROXY_URL` (required)
- `POLICY_ENGINE_URL` (required)
- `BEAM_APP_ID` (required)
- `INPUT_POLICY_PATH` (default `/v1/data/input/allow_access`)
- `OUTPUT_POLICY_PATH` (default `/v1/data/output/allow_output`)
- `POLICY_FAIL_MODE` (`closed` or `open`, default `closed`)
- `POLICY_TIMEOUT_MS` (default `5000`)
- `UPSTREAM_TIMEOUT_MS` (default `30000`)
- `MAX_BODY_BYTES` (default 11 MiB)

Start the CCP environment with OPA using:

```bash
docker compose -f ccp-explorer/compose.local.yaml --profile opa up --build
```
