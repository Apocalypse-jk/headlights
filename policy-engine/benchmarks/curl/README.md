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

