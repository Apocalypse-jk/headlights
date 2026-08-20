# opa with toxiproxy
docker compose `
  -f .\bbmri-sample-locator\compose.local.yaml `
  -f .\policy-engine\compose.toxiproxy.yaml `
  --profile opa `
  --profile toxiproxy `
  up -d --build

# baseline with toxiproxy
docker compose `
  -f .\bbmri-sample-locator\compose.local.yaml `
  -f .\policy-engine\compose.toxiproxy.baseline.yaml `
  --profile toxiproxy `
  up -d --build

# casbin with toxiproxy
docker compose `
  -f .\bbmri-sample-locator\compose.local.yaml `
  -f .\policy-engine\compose.toxiproxy.yaml `
  --profile casbin `
  --profile toxiproxy `
  up -d --build

# opa with mock-blaze und toxiproxy
docker compose `
  -f .\bbmri-sample-locator\compose.local.yaml `
  -f .\policy-engine\compose.mock-blaze.yaml `
  -f .\policy-engine\compose.toxiproxy.yaml `
  --profile opa `
  --profile toxiproxy `
  up -d --build

# baseline with mock-blaze und toxiproxy
docker compose `
  -f .\bbmri-sample-locator\compose.local.yaml `
  -f .\policy-engine\compose.mock-blaze.yaml `
  -f .\policy-engine\compose.toxiproxy.baseline.yaml `
  --profile toxiproxy `
  up -d --build

# baseline with mock-blaze und toxiproxy
docker compose `
  -f .\bbmri-sample-locator\compose.local.yaml `
  -f .\policy-engine\compose.mock-blaze.yaml `
  -f .\policy-engine\compose.toxiproxy.yaml `
  --profile casbin `
  --profile toxiproxy `
  up -d --build

# run benchmark for opa
.\policy-engine\benchmarks\curl\run-realistic-curl.ps1 `
  -WarmupIterations 5 `
  -Iterations 30 `
  -Concurrency 1

# run benchmark for casbin
.\policy-engine\benchmarks\curl\run-realistic-curl.ps1 `
  -Architecture casbin ` 
  -WarmupIterations 5 `
  -Iterations 30 `
  -Concurrency 1

# run benchmark for baseline
.\policy-engine\benchmarks\curl\run-realistic-curl.ps1 `
  -Architecture baseline-curl `
  -WarmupIterations 5 `
  -Iterations 30 `
  -Concurrency 1

