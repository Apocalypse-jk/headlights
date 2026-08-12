# start Stack with toxiproxy
docker compose `
  -f .\bbmri-sample-locator\compose.local.yaml `
  -f .\policy-engine\compose.toxiproxy.yaml `
  --profile opa `
  --profile toxiproxy `
  up -d --build

# run benchmark
.\policy-engine\benchmarks\curl\run-realistic-curl.ps1 `
  -WarmupIterations 3 `
  -Iterations 10 `
  -Concurrency 1

# create plots
python .\policy-engine\benchmarks\curl\plot_curl_profiles.py


# opa mit mock-blaze und toxiproxy
docker compose `
  -f .\bbmri-sample-locator\compose.local.yaml `
  -f .\policy-engine\compose.mock-blaze.yaml `
  -f .\policy-engine\compose.toxiproxy.yaml `
  --profile opa `
  --profile toxiproxy `
  up -d --build

# baseline mit mock-blaze und toxiproxy
docker compose `
  -f .\bbmri-sample-locator\compose.local.yaml `
  -f .\policy-engine\compose.mock-blaze.yaml `
  -f .\policy-engine\compose.toxiproxy.baseline.yaml `
  --profile toxiproxy `
  up -d --build