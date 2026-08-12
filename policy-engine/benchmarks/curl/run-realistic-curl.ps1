param(
  [int]$WarmupIterations = 3,
  [int]$Iterations = 10,
  [int]$Concurrency = 1,
  [int]$TimeoutSec = 300,
  [string]$Architecture = "opa-policy-proxy-curl",
  [string]$SpotBeamUrl = "http://localhost:8055/beam",
  [string]$ToxiproxyAdminUrl = "http://127.0.0.1:8474",
  [string]$ToxiproxyName = "focus_policy_proxy",
  [string]$OutputDir = "policy-engine/benchmarks/curl/runs",
  [string]$CurlFile = "policy-engine/benchmarks/curl/curls.txt",
  [string[]]$Profiles = @("lan", "wan-typical", "intercontinental")
)

$ErrorActionPreference = "Stop"

$Scenarios = @(
  @{
    Name = "realistic_curl_payload"
    QueryType = "realistic_payload"
    QueryBase64 = $null
  }
)

function Format-DurationSeconds {
  param([double]$DurationMs)

  return "{0:N2}s" -f ($DurationMs / 1000)
}

$ProfileDefinitions = @{
  "lan" = @()
  "wan-typical" = @(
    @{
      name = "wan_typical_latency_upstream"
      type = "latency"
      stream = "upstream"
      toxicity = 1.0
      attributes = @{
        latency = 25
        jitter = 5
      }
    },
    @{
      name = "wan_typical_latency_downstream"
      type = "latency"
      stream = "downstream"
      toxicity = 1.0
      attributes = @{
        latency = 25
        jitter = 5
      }
    },
    @{
      name = "wan_typical_bandwidth_upstream"
      type = "bandwidth"
      stream = "upstream"
      toxicity = 1.0
      attributes = @{
        rate = 12500
      }
    },
    @{
      name = "wan_typical_bandwidth_downstream"
      type = "bandwidth"
      stream = "downstream"
      toxicity = 1.0
      attributes = @{
        rate = 12500
      }
    }
  )
  "wan-poor" = @(
    @{
      name = "wan_poor_latency_upstream"
      type = "latency"
      stream = "upstream"
      toxicity = 1.0
      attributes = @{
        latency = 75
        jitter = 20
      }
    },
    @{
      name = "wan_poor_latency_downstream"
      type = "latency"
      stream = "downstream"
      toxicity = 1.0
      attributes = @{
        latency = 75
        jitter = 20
      }
    },
    @{
      name = "wan_poor_bandwidth_upstream"
      type = "bandwidth"
      stream = "upstream"
      toxicity = 1.0
      attributes = @{
        rate = 1250
      }
    },
    @{
      name = "wan_poor_bandwidth_downstream"
      type = "bandwidth"
      stream = "downstream"
      toxicity = 1.0
      attributes = @{
        rate = 1250
      }
    }
  )
  "intercontinental" = @(
    @{
      name = "intercontinental_latency_upstream"
      type = "latency"
      stream = "upstream"
      toxicity = 1.0
      attributes = @{
        latency = 150
        jitter = 10
      }
    },
    @{
      name = "intercontinental_latency_downstream"
      type = "latency"
      stream = "downstream"
      toxicity = 1.0
      attributes = @{
        latency = 150
        jitter = 10
      }
    },
    @{
      name = "intercontinental_bandwidth_upstream"
      type = "bandwidth"
      stream = "upstream"
      toxicity = 1.0
      attributes = @{
        rate = 6250
      }
    },
    @{
      name = "intercontinental_bandwidth_downstream"
      type = "bandwidth"
      stream = "downstream"
      toxicity = 1.0
      attributes = @{
        rate = 6250
      }
    }
  )
}

$RunId = Get-Date -Format "yyyy-MM-ddTHH-mm-ss"
$RunDir = Join-Path $OutputDir $RunId
$CsvPath = Join-Path $RunDir "measurements.csv"
New-Item -ItemType Directory -Force -Path $RunDir | Out-Null

$Headers = @(
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
  "profile",
  "http_status",
  "response_bytes",
  "task_id",
  "post_duration_ms",
  "time_to_first_event_ms",
  "time_to_claimed_ms",
  "time_to_terminal_ms",
  "claimed_to_terminal_ms"
)
Set-Content -Path $CsvPath -Value ($Headers -join ",") -Encoding UTF8

function ConvertTo-Base64Utf8 {
  param([string]$Value)
  return [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Value))
}

function Get-CurlQueryBase64 {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    throw "Curl file not found: $Path"
  }

  $Text = Get-Content -LiteralPath $Path -Raw

  $Patterns = @(
    'query\\\^\\\\\\\^":\\\^\\\\\\\^"([^\\\^]+)',
    'query\^\\\^":\^\\\^"([^\^]+)',
    '"query"\s*:\s*"([^"]+)"'
  )

  foreach ($Pattern in $Patterns) {
    $Match = [regex]::Match($Text, $Pattern)
    if ($Match.Success) {
      return $Match.Groups[1].Value
    }
  }

  throw "Could not find a query field in curl file: $Path"
}

function Show-DecodedCurlQuery {
  param([string]$QueryBase64)

  try {
    $InnerJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($QueryBase64))
    $Inner = $InnerJson | ConvertFrom-Json
    $PayloadJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Inner.payload))
    Write-Host "Using query payload from curls.txt: $PayloadJson"
  } catch {
    Write-Warning "Could not decode query payload from curls.txt for preview: $($_.Exception.Message)"
  }
}

function New-LensBeamBody {
  param([hashtable]$Scenario)

  if ($Scenario.QueryBase64) {
    $QueryBase64 = $Scenario.QueryBase64
  } else {
    $queryJson = $Scenario.Query | ConvertTo-Json -Depth 50 -Compress
    $inner = @{
      lang = "ast"
      payload = ConvertTo-Base64Utf8 $queryJson
    } | ConvertTo-Json -Depth 20 -Compress
    $QueryBase64 = ConvertTo-Base64Utf8 $inner
  }

  $body = @{
    id = [guid]::NewGuid().ToString()
    query = $QueryBase64
  } | ConvertTo-Json -Depth 20 -Compress

  return $body
}

function ConvertTo-CsvCell {
  param($Value)

  if ($null -eq $Value) {
    return ""
  }

  $Text = [string]$Value
  if ($Text -match '[,"\r\n]') {
    return '"' + ($Text -replace '"', '""') + '"'
  }

  return $Text
}

function Find-PatientCountInObject {
  param($Value)

  if ($null -eq $Value) {
    return ""
  }

  if ($Value -is [System.Array]) {
    foreach ($Item in $Value) {
      $Found = Find-PatientCountInObject $Item
      if ($Found -ne "") {
        return $Found
      }
    }

    return ""
  }

  if ($Value -is [pscustomobject]) {
    if ($Value.PSObject.Properties.Name -contains "totals") {
      $Totals = $Value.totals
      if ($Totals.PSObject.Properties.Name -contains "patient" -and $Totals.patient -match "^\d+(\.\d+)?$") {
        return [string]$Totals.patient
      }

      if ($Totals.PSObject.Properties.Name -contains "result" -and $Totals.result -match "^\d+(\.\d+)?$") {
        return [string]$Totals.result
      }
    }

    foreach ($Name in @("patient_count", "patientCount", "patients", "patient")) {
      if ($Value.PSObject.Properties.Name -contains $Name -and $Value.$Name -match "^\d+(\.\d+)?$") {
        return [string]$Value.$Name
      }
    }

    if ($Value.PSObject.Properties.Name -contains "resourceType" -and $Value.resourceType -eq "MeasureReport") {
      foreach ($Group in @($Value.group)) {
        foreach ($Population in @($Group.population)) {
          if (
            $null -ne $Population `
            -and $Population.PSObject.Properties.Name -contains "count" `
            -and $Population.count -match "^\d+(\.\d+)?$"
          ) {
            return [string]$Population.count
          }
        }
      }
    }

    foreach ($Property in $Value.PSObject.Properties) {
      $Found = Find-PatientCountInObject $Property.Value
      if ($Found -ne "") {
        return $Found
      }
    }
  }

  return ""
}

function Parse-PatientCount {
  param([string]$Content)

  if ([string]::IsNullOrWhiteSpace($Content)) {
    return ""
  }

  try {
    $Json = $Content | ConvertFrom-Json
    $Found = Find-PatientCountInObject $Json
    if ($Found -ne "") {
      return $Found
    }
  } catch {
    # Response bodies can also be event-stream or plain text. Regex fallback below.
  }

  foreach ($Pattern in @(
    '"patient"\s*:\s*(\d+(?:\.\d+)?)',
    '"patients"\s*:\s*(\d+(?:\.\d+)?)',
    '"patient_count"\s*:\s*(\d+(?:\.\d+)?)',
    '"patientCount"\s*:\s*(\d+(?:\.\d+)?)',
    '"totals"\s*:\s*\{[^}]*"result"\s*:\s*(\d+(?:\.\d+)?)',
    'Patients?\D{0,40}(\d+(?:[\.,]\d+)?)',
    'Patienten\D{0,40}(\d+(?:[\.,]\d+)?)'
  )) {
    $Match = [regex]::Match($Content, $Pattern, [Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if ($Match.Success) {
      return ($Match.Groups[1].Value -replace "\.", "" -replace ",", ".")
    }
  }

  return ""
}

function Append-Measurement {
  param([hashtable]$Row)

  $Line = ($Headers | ForEach-Object { ConvertTo-CsvCell $Row[$_] }) -join ","
  Add-Content -Path $CsvPath -Value $Line -Encoding UTF8
}

function Reset-Toxiproxy {
  try {
    $ProxyJson = & curl.exe -fsS "$ToxiproxyAdminUrl/proxies/$ToxiproxyName"
    if ($LASTEXITCODE -ne 0) {
      throw "curl.exe failed while reading proxy '$ToxiproxyName'"
    }

    $Proxy = $ProxyJson | ConvertFrom-Json

    $ToxicNames = @()
    if ($Proxy.toxics) {
      $ToxicNames = @($Proxy.toxics) | ForEach-Object { $_.name } | Where-Object { $_ }
    }

    foreach ($ToxicName in $ToxicNames) {
      & curl.exe -fsS -X DELETE "$ToxiproxyAdminUrl/proxies/$ToxiproxyName/toxics/$ToxicName" | Out-Null
      if ($LASTEXITCODE -ne 0) {
        throw "curl.exe failed while deleting toxic '$ToxicName'"
      }
    }
  } catch {
    throw "Could not reset Toxiproxy proxy '$ToxiproxyName'. Is it running at ${ToxiproxyAdminUrl}? $($_.Exception.Message)"
  }
}

function Get-ToxiproxyToxicSummary {
  try {
    $ProxyJson = & curl.exe -fsS "$ToxiproxyAdminUrl/proxies/$ToxiproxyName"
    if ($LASTEXITCODE -ne 0) {
      return "unavailable"
    }

    $Proxy = $ProxyJson | ConvertFrom-Json
    $Toxics = @()
    if ($Proxy.toxics) {
      $Toxics = @($Proxy.toxics)
    }

    if ($Toxics.Count -eq 0) {
      return "none"
    }

    return ($Toxics | ForEach-Object {
      $Attributes = if ($_.attributes) {
        ($_.attributes.PSObject.Properties | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ";"
      } else {
        ""
      }

      if ($Attributes) {
        "$($_.name)[$($_.type)/$($_.stream):$Attributes]"
      } else {
        "$($_.name)[$($_.type)/$($_.stream)]"
      }
    }) -join ", "
  } catch {
    return "unavailable: $($_.Exception.Message)"
  }
}

function Invoke-CurlJsonPost {
  param(
    [string]$Uri,
    [string]$Json
  )

  $TempFile = New-TemporaryFile
  try {
    [System.IO.File]::WriteAllText(
      $TempFile,
      $Json,
      [System.Text.UTF8Encoding]::new($false)
    )
    $Response = & curl.exe `
      -fsS `
      -X POST `
      -H "Content-Type: application/json" `
      --data-binary "@$TempFile" `
      $Uri

    if ($LASTEXITCODE -ne 0) {
      throw "curl.exe failed with exit code $LASTEXITCODE. Response: $Response"
    }

    return $Response
  } finally {
    Remove-Item -LiteralPath $TempFile -Force -ErrorAction SilentlyContinue
  }
}

function Apply-ToxiproxyProfile {
  param([string]$Profile)

  if (-not $ProfileDefinitions.ContainsKey($Profile)) {
    throw "Unknown profile '$Profile'. Known profiles: $($ProfileDefinitions.Keys -join ', ')"
  }

  Reset-Toxiproxy

  foreach ($Toxic in $ProfileDefinitions[$Profile]) {
    $Json = $Toxic | ConvertTo-Json -Depth 20 -Compress
    try {
      Invoke-CurlJsonPost -Uri "$ToxiproxyAdminUrl/proxies/$ToxiproxyName/toxics" -Json $Json | Out-Null
    } catch {
      throw "Could not add toxic '$($Toxic.name)' to Toxiproxy proxy '$ToxiproxyName'. $($_.Exception.Message)"
    }
  }

}

function Invoke-RealisticRequest {
  param(
    [string]$Phase,
    [string]$Profile,
    [hashtable]$Scenario,
    [int]$Run
  )

  $Start = Get-Date
  $Stopwatch = [Diagnostics.Stopwatch]::StartNew()
  $Status = "timeout"
  $HttpStatus = ""
  $ResponseBytes = ""
  $PatientCount = ""
  $ErrorMessage = ""

  try {
    $Body = New-LensBeamBody $Scenario
    $Response = Invoke-WebRequest `
      -Method Post `
      -Uri $SpotBeamUrl `
      -UseBasicParsing `
      -ContentType "application/json" `
      -Headers @{
        Accept = "*/*"
        Origin = "http://localhost:3000"
        Referer = "http://localhost:3000/"
      } `
      -Body $Body `
      -TimeoutSec $TimeoutSec

    $HttpStatus = $Response.StatusCode
    $ResponseBytes = [Text.Encoding]::UTF8.GetByteCount($Response.Content)
    $PatientCount = Parse-PatientCount $Response.Content
    $Status = if ($Response.StatusCode -ge 200 -and $Response.StatusCode -lt 300) { "succeeded" } else { "failed" }
  } catch {
    $ErrorMessage = $_.Exception.Message
    if ($ErrorMessage -notmatch "timed out|timeout") {
      $Status = "failed"
    }
  } finally {
    $Stopwatch.Stop()
  }

  $End = Get-Date
  $Row = @{
    timestamp = (Get-Date).ToUniversalTime().ToString("o")
    architecture = $Architecture
    phase = $Phase
    scenario = $Scenario.Name
    query_type = $Scenario.QueryType
    concurrency = $Concurrency
    run = $Run
    start_time = $Start.ToUniversalTime().ToString("o")
    end_time = $End.ToUniversalTime().ToString("o")
    duration_ms = [math]::Round($Stopwatch.Elapsed.TotalMilliseconds)
    status = $Status
    patient_count = $PatientCount
    policy_decision = ""
    policy_status = ""
    policy_task_id = ""
    policy_evaluation_ms = ""
    error = $ErrorMessage
    profile = $Profile
    http_status = $HttpStatus
    response_bytes = $ResponseBytes
    task_id = ""
    post_duration_ms = ""
    time_to_first_event_ms = ""
    time_to_claimed_ms = ""
    time_to_terminal_ms = ""
    claimed_to_terminal_ms = ""
  }

  Append-Measurement $Row
  Write-Host "[$Phase] profile=$Profile scenario=$($Scenario.Name) run=$Run status=$Status duration=$(Format-DurationSeconds $Row.duration_ms) patients=$($PatientCount -as [string]) bytes=$($ResponseBytes -as [string])"
}

function Invoke-Batch {
  param(
    [string]$Phase,
    [string]$Profile,
    [hashtable]$Scenario,
    [int]$StartRun,
    [int]$BatchSize
  )

  $Jobs = for ($Index = 0; $Index -lt $BatchSize; $Index++) {
    $Run = $StartRun + $Index
    Start-Job -ScriptBlock {
      param($Phase, $Profile, $Scenario, $Run, $SpotBeamUrl, $TimeoutSec, $ConcurrencyValue, $ArchitectureValue)

      Add-Type -AssemblyName System.Net.Http

      $Start = Get-Date
      $Stopwatch = [Diagnostics.Stopwatch]::StartNew()
      $Status = "timeout"
      $HttpStatus = ""
      $ResponseBytes = ""
      $PatientCount = ""
      $ErrorMessage = ""
      $TaskId = ""
      $PostDurationMs = ""
      $TimeToFirstEventMs = ""
      $TimeToClaimedMs = ""
      $TimeToTerminalMs = ""
      $ClaimedToTerminalMs = ""

      function Find-PatientCountInObject {
        param($Value)

        if ($null -eq $Value) {
          return ""
        }

        if ($Value -is [System.Array]) {
          foreach ($Item in $Value) {
            $Found = Find-PatientCountInObject $Item
            if ($Found -ne "") {
              return $Found
            }
          }

          return ""
        }

        if ($Value -is [pscustomobject]) {
          if ($Value.PSObject.Properties.Name -contains "totals") {
            $Totals = $Value.totals
            if ($Totals.PSObject.Properties.Name -contains "patient" -and $Totals.patient -match "^\d+(\.\d+)?$") {
              return [string]$Totals.patient
            }

            if ($Totals.PSObject.Properties.Name -contains "result" -and $Totals.result -match "^\d+(\.\d+)?$") {
              return [string]$Totals.result
            }
          }

          foreach ($Name in @("patient_count", "patientCount", "patients", "patient")) {
            if ($Value.PSObject.Properties.Name -contains $Name -and $Value.$Name -match "^\d+(\.\d+)?$") {
              return [string]$Value.$Name
            }
          }

          if ($Value.PSObject.Properties.Name -contains "resourceType" -and $Value.resourceType -eq "MeasureReport") {
            foreach ($Group in @($Value.group)) {
              foreach ($Population in @($Group.population)) {
                if (
                  $null -ne $Population `
                  -and $Population.PSObject.Properties.Name -contains "count" `
                  -and $Population.count -match "^\d+(\.\d+)?$"
                ) {
                  return [string]$Population.count
                }
              }
            }
          }

          foreach ($Property in $Value.PSObject.Properties) {
            $Found = Find-PatientCountInObject $Property.Value
            if ($Found -ne "") {
              return $Found
            }
          }
        }

        return ""
      }

      function Parse-PatientCount {
        param([string]$Content)

        if ([string]::IsNullOrWhiteSpace($Content)) {
          return ""
        }

        try {
          $Json = $Content | ConvertFrom-Json
          $Found = Find-PatientCountInObject $Json
          if ($Found -ne "") {
            return $Found
          }
        } catch {
        }

        foreach ($Pattern in @(
          '"patient"\s*:\s*(\d+(?:\.\d+)?)',
          '"patients"\s*:\s*(\d+(?:\.\d+)?)',
          '"patient_count"\s*:\s*(\d+(?:\.\d+)?)',
          '"patientCount"\s*:\s*(\d+(?:\.\d+)?)',
          '"totals"\s*:\s*\{[^}]*"result"\s*:\s*(\d+(?:\.\d+)?)',
          'Patients?\D{0,40}(\d+(?:[\.,]\d+)?)',
          'Patienten\D{0,40}(\d+(?:[\.,]\d+)?)'
        )) {
          $Match = [regex]::Match($Content, $Pattern, [Text.RegularExpressions.RegexOptions]::IgnoreCase)
          if ($Match.Success) {
            return ($Match.Groups[1].Value -replace "\.", "" -replace ",", ".")
          }
        }

        return ""
      }

      function ConvertFrom-Base64Utf8 {
        param([string]$Value)

        if ([string]::IsNullOrWhiteSpace($Value)) {
          return ""
        }

        try {
          return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Value))
        } catch {
          return ""
        }
      }

      function Read-SpotBeamResultStream {
        param(
          [string]$SpotBeamUrl,
          [string]$TaskId,
          [int]$TimeoutSec
        )

        $ResultUrl = "$SpotBeamUrl/$TaskId"
        $Client = [System.Net.Http.HttpClient]::new()
        $Client.Timeout = [System.Threading.Timeout]::InfiniteTimeSpan
        $Request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get, $ResultUrl)
        $Request.Headers.TryAddWithoutValidation("Accept", "text/event-stream") | Out-Null
        $Request.Headers.TryAddWithoutValidation("Origin", "http://localhost:3000") | Out-Null
        $Request.Headers.TryAddWithoutValidation("Referer", "http://localhost:3000/") | Out-Null

        $Deadline = (Get-Date).AddSeconds($TimeoutSec)
        $Response = $null
        $Reader = $null
        $Bytes = 0
        $LastEvent = ""
        $LastStatus = ""
        $LastContent = ""
        $StreamStopwatch = [Diagnostics.Stopwatch]::StartNew()
        $FirstEventMs = ""
        $ClaimedMs = ""

        try {
          $Response = $Client.SendAsync(
            $Request,
            [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead
          ).GetAwaiter().GetResult()

          $Stream = $Response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
          $Reader = [System.IO.StreamReader]::new($Stream, [Text.Encoding]::UTF8)

          while ((Get-Date) -lt $Deadline) {
            $RemainingMs = [int][Math]::Max(1, ($Deadline - (Get-Date)).TotalMilliseconds)
            $ReadTask = $Reader.ReadLineAsync()

            if (-not $ReadTask.Wait($RemainingMs)) {
              throw "Timed out waiting for final SSE result"
            }

            $Line = $ReadTask.Result
            if ($null -eq $Line) {
              break
            }

            $Bytes += [Text.Encoding]::UTF8.GetByteCount($Line + "`n")

            if ($Line.StartsWith("event:")) {
              $LastEvent = $Line.Substring(6).Trim()
              continue
            }

            if (-not $Line.StartsWith("data:")) {
              continue
            }

            $Data = $Line.Substring(5).Trim()
            $LastContent = $Data
            if ($FirstEventMs -eq "") {
              $FirstEventMs = [math]::Round($StreamStopwatch.Elapsed.TotalMilliseconds)
            }

            if ($LastEvent -eq "wait_expired") {
              return @{
                HttpStatus = [int]$Response.StatusCode
                Status = "timeout"
                Content = $Data
                Bytes = $Bytes
                FirstEventMs = $FirstEventMs
                ClaimedMs = $ClaimedMs
                TerminalMs = [math]::Round($StreamStopwatch.Elapsed.TotalMilliseconds)
              }
            }

            try {
              $Result = $Data | ConvertFrom-Json
            } catch {
              continue
            }

            if ($Result.PSObject.Properties.Name -contains "status") {
              $LastStatus = [string]$Result.status
              if ($LastStatus -eq "claimed" -and $ClaimedMs -eq "") {
                $ClaimedMs = [math]::Round($StreamStopwatch.Elapsed.TotalMilliseconds)
              }
            }

            if ($LastStatus -in @("succeeded", "permfailed", "tempfailed")) {
              $DecodedBody = ""
              if ($Result.PSObject.Properties.Name -contains "body" -and $Result.body -is [string]) {
                $DecodedBody = ConvertFrom-Base64Utf8 $Result.body
              }

              $ContentForParsing = if ($DecodedBody -ne "") {
                $DecodedBody
              } else {
                $Result | ConvertTo-Json -Depth 80 -Compress
              }

              return @{
                HttpStatus = [int]$Response.StatusCode
                Status = $LastStatus
                Content = $ContentForParsing
                Bytes = $Bytes + [Text.Encoding]::UTF8.GetByteCount($ContentForParsing)
                FirstEventMs = $FirstEventMs
                ClaimedMs = $ClaimedMs
                TerminalMs = [math]::Round($StreamStopwatch.Elapsed.TotalMilliseconds)
              }
            }
          }

          throw "SSE stream ended before a terminal result. Last event=$LastEvent last status=$LastStatus last content=$LastContent"
        } finally {
          if ($Reader) {
            $Reader.Dispose()
          }
          if ($Response) {
            $Response.Dispose()
          }
          $Request.Dispose()
          $Client.Dispose()
        }
      }

      try {
        $TaskId = [guid]::NewGuid().ToString()
        $body = @{
          id = $TaskId
          query = $Scenario.QueryBase64
        } | ConvertTo-Json -Depth 20 -Compress

        $PostStopwatch = [Diagnostics.Stopwatch]::StartNew()
        $Response = Invoke-WebRequest `
          -Method Post `
          -Uri $SpotBeamUrl `
          -UseBasicParsing `
          -ContentType "application/json" `
          -Headers @{
            Accept = "*/*"
            Origin = "http://localhost:3000"
            Referer = "http://localhost:3000/"
          } `
          -Body $body `
          -TimeoutSec $TimeoutSec
        $PostStopwatch.Stop()
        $PostDurationMs = [math]::Round($PostStopwatch.Elapsed.TotalMilliseconds)

        $PostStatus = $Response.StatusCode
        if ($PostStatus -lt 200 -or $PostStatus -ge 300) {
          $HttpStatus = $PostStatus
          $ResponseBytes = [Text.Encoding]::UTF8.GetByteCount($Response.Content)
          $Status = "failed"
        } else {
          $SseStartMs = [math]::Round($Stopwatch.Elapsed.TotalMilliseconds)
          $FinalResult = Read-SpotBeamResultStream -SpotBeamUrl $SpotBeamUrl -TaskId $TaskId -TimeoutSec $TimeoutSec
          $HttpStatus = "$PostStatus/$($FinalResult.HttpStatus)"
          $ResponseBytes = $FinalResult.Bytes
          $PatientCount = Parse-PatientCount $FinalResult.Content
          $Status = $FinalResult.Status
          $TimeToFirstEventMs = if ($FinalResult.FirstEventMs -ne "") { $SseStartMs + [int]$FinalResult.FirstEventMs } else { "" }
          $TimeToClaimedMs = if ($FinalResult.ClaimedMs -ne "") { $SseStartMs + [int]$FinalResult.ClaimedMs } else { "" }
          $TimeToTerminalMs = if ($FinalResult.TerminalMs -ne "") { $SseStartMs + [int]$FinalResult.TerminalMs } else { "" }
          $ClaimedToTerminalMs = if ($FinalResult.ClaimedMs -ne "" -and $FinalResult.TerminalMs -ne "") {
            [int]$FinalResult.TerminalMs - [int]$FinalResult.ClaimedMs
          } else {
            ""
          }
        }
      } catch {
        $ErrorMessage = $_.Exception.Message
        if ($ErrorMessage -notmatch "timed out|timeout") {
          $Status = "failed"
        }
      } finally {
        $Stopwatch.Stop()
      }

      $End = Get-Date
      return @{
        timestamp = (Get-Date).ToUniversalTime().ToString("o")
        architecture = $ArchitectureValue
        phase = $Phase
        scenario = $Scenario.Name
        query_type = $Scenario.QueryType
        concurrency = $ConcurrencyValue
        run = $Run
        start_time = $Start.ToUniversalTime().ToString("o")
        end_time = $End.ToUniversalTime().ToString("o")
        duration_ms = [math]::Round($Stopwatch.Elapsed.TotalMilliseconds)
        status = $Status
        patient_count = $PatientCount
        policy_decision = ""
        policy_status = ""
        policy_task_id = ""
        policy_evaluation_ms = ""
        error = $ErrorMessage
        profile = $Profile
        http_status = $HttpStatus
        response_bytes = $ResponseBytes
        task_id = $TaskId
        post_duration_ms = $PostDurationMs
        time_to_first_event_ms = $TimeToFirstEventMs
        time_to_claimed_ms = $TimeToClaimedMs
        time_to_terminal_ms = $TimeToTerminalMs
        claimed_to_terminal_ms = $ClaimedToTerminalMs
      }
    } -ArgumentList $Phase, $Profile, $Scenario, $Run, $SpotBeamUrl, $TimeoutSec, $Concurrency, $Architecture
  }

  foreach ($Job in $Jobs) {
    $Row = Receive-Job -Job $Job -Wait
    Remove-Job -Job $Job
    Append-Measurement $Row
    Write-Host "[$Phase] profile=$Profile scenario=$($Scenario.Name) run=$($Row.run) status=$($Row.status) duration=$(Format-DurationSeconds $Row.duration_ms) patients=$($Row.patient_count) bytes=$($Row.response_bytes)"
  }
}

$QueryBase64 = Get-CurlQueryBase64 $CurlFile
foreach ($Scenario in $Scenarios) {
  $Scenario.QueryBase64 = $QueryBase64
}

Show-DecodedCurlQuery $QueryBase64
Write-Host "Writing measurements to $CsvPath"

Write-Host "Running warmup iterations for all profiles first, interleaved by run."
for ($Run = 1; $Run -le $WarmupIterations; $Run += $Concurrency) {
  foreach ($Profile in $Profiles) {
    Apply-ToxiproxyProfile $Profile

    foreach ($Scenario in $Scenarios) {
      $BatchSize = [math]::Min($Concurrency, $WarmupIterations - $Run + 1)
      Invoke-Batch -Phase "warmup" -Profile $Profile -Scenario $Scenario -StartRun $Run -BatchSize $BatchSize
    }
  }
}

Write-Host "Running measurement iterations for all profiles, interleaved by run."
for ($Run = 1; $Run -le $Iterations; $Run += $Concurrency) {
  foreach ($Profile in $Profiles) {
    Apply-ToxiproxyProfile $Profile

    foreach ($Scenario in $Scenarios) {
      $BatchSize = [math]::Min($Concurrency, $Iterations - $Run + 1)
      Invoke-Batch -Phase "measurement" -Profile $Profile -Scenario $Scenario -StartRun $Run -BatchSize $BatchSize
    }
  }
}

Write-Host "done"
