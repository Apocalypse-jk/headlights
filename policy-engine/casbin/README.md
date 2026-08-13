# Casbin Policy Engine Adapter

This service exposes OPA-compatible policy endpoints so the existing policy
proxy can switch from OPA to Casbin without changing its HTTP integration.

Endpoints:

- `GET /health`
- `POST /v1/data/input/allow_access`
- `POST /v1/data/output/allow_output`

Both policy endpoints accept the same request shape as OPA:

```json
{
  "input": {}
}
```

and return:

```json
{
  "result": {
    "allow": true,
    "reason": "optional explanation"
  }
}
```

## Mapping from Rego to Casbin

The input policy from `search.rego` is represented directly in `policy.csv`:

```csv
p, input, spot.proxy1.broker, focus.proxy2.broker, search, allow
```

The output policy combines Casbin checks with adapter-side facts. Casbin handles
the subject/status permission:

```csv
p, output, focus.proxy2.broker, result, claimed, allow
p, output, focus.proxy2.broker, result, succeeded, allow
```

The adapter then evaluates the content-aware privacy checks that are awkward to
model as plain Casbin policy rows:

- patient count threshold
- diagnosis count threshold
- gender k-anonymity
- donor age k-anonymity
- sample kind k-anonymity
- `project:superuser` metadata exception from the original request context

This keeps the benchmark architecture comparable while making the difference
between OPA's declarative data policies and Casbin's access-control model
explicit.
