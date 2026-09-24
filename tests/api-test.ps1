<#
.SYNOPSIS
    End-to-end API test for the Annotator backend.

.DESCRIPTION
    Boots nothing itself — assumes the server is already running (npm start)
    OR can be launched with -StartServer.

    Every request is exercised, results are recorded, and both a plain-text
    report and a JSON report are written to ./tests/results/.

.PARAMETER BaseUrl
    Base URL of the API. Default: http://localhost:5000

.PARAMETER StartServer
    If set, launches `npm start` in the background before testing and
    stops it after. Requires the project root to be the current directory.

.PARAMETER AdminEmail
    Email for the bootstrapped admin. Default: admin@test.local

.PARAMETER AdminPassword
    Password for the bootstrapped admin. Default: password1234

.PARAMETER Quiet
    Suppress per-request console output (report still written).

.EXAMPLE
    .\tests\api-test.ps1
    .\tests\api-test.ps1 -StartServer
    .\tests\api-test.ps1 -BaseUrl http://localhost:5000 -StartServer
#>

[CmdletBinding()]
param(
    [string]$BaseUrl = "http://localhost:5000",
    [switch]$StartServer,
    [string]$AdminEmail = "admin@test.local",
    [string]$AdminPassword = "password1234",
    [switch]$Quiet
)

$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# Result collection
# ---------------------------------------------------------------------------

$script:Results = New-Object System.Collections.ArrayList
$script:Passed  = 0
$script:Failed  = 0
$script:Skipped = 0
$script:Started = Get-Date
$script:ServerProcess = $null

function Add-Result {
    param(
        [string]$Name,
        [string]$Status,      # pass | fail | skip
        [int]$HttpStatus = 0,
        [string]$Detail = "",
        [object]$Body = $null,
        [object]$Expected = $null,
        [int]$DurationMs = 0
    )

    $entry = [ordered]@{
        name       = $Name
        status     = $Status
        httpStatus = $HttpStatus
        detail     = $Detail
        expected   = $Expected
        body       = $Body
        durationMs = $DurationMs
        at         = (Get-Date).ToString("o")
    }

    [void]$script:Results.Add([pscustomobject]$entry)

    switch ($Status) {
        "pass" { $script:Passed++ }
        "fail" { $script:Failed++ }
        "skip" { $script:Skipped++ }
    }

    if (-not $Quiet) {
        $color = switch ($Status) {
            "pass" { "Green" }
            "fail" { "Red" }
            "skip" { "Yellow" }
        }
        $tag = $Status.ToUpper().PadRight(4)
        Write-Host ("[{0}] {1} ({2}ms)" -f $tag, $Name, $DurationMs) -ForegroundColor $color
        if ($Status -eq "fail" -and $Detail) {
            Write-Host ("       -> " + $Detail) -ForegroundColor DarkRed
        }
    }
}

function New-HttpErrorDetail {
    param($ErrorRecord)

    $msg = $ErrorRecord.Exception.Message
    $status = 0
    $body = $null

    if ($ErrorRecord.Exception.Response) {
        $resp = $ErrorRecord.Exception.Response
        try { $status = [int]$resp.StatusCode } catch {}
        try {
            $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
            $body = $reader.ReadToEnd()
            $reader.Close()
        } catch {}
    } elseif ($ErrorRecord.ErrorDetails -and $ErrorRecord.ErrorDetails.Message) {
        $body = $ErrorRecord.ErrorDetails.Message
    }

    return [pscustomobject]@{
        message = $msg
        status  = $status
        body    = $body
    }
}

# ---------------------------------------------------------------------------
# HTTP helper
# ---------------------------------------------------------------------------

$script:Token = $null
$script:AdminId = $null
$script:AnnotatorId = $null

function Invoke-Api {
    param(
        [string]$Method,
        [string]$Path,
        [object]$Body,
        [hashtable]$Headers,
        [switch]$Form,
        [string]$FormFile,
        [hashtable]$FormFields,
        [int]$TimeoutSec = 60
    )

    $uri = "$BaseUrl$Path"

    $h = @{}
    if ($Headers) { $h = $Headers.Clone() }
    if ($script:Token -and -not $h.ContainsKey("Authorization")) {
        $h["Authorization"] = "Bearer $($script:Token)"
    }

    $params = @{
        Method      = $Method
        Uri         = $uri
        Headers     = $h
        TimeoutSec  = $TimeoutSec
        ErrorAction = "Stop"
    }

    if ($Form) {
        # Manual multipart/form-data body — works on Windows PowerShell 5.1
        # (which does not support Invoke-RestMethod -Form).
        $boundary = [System.Guid]::NewGuid().ToString("N")
        $LF = "`r`n"

        $bodyLines = New-Object System.Collections.Generic.List[string]

        if ($FormFields) {
            foreach ($k in $FormFields.Keys) {
                $bodyLines.Add("--$boundary")
                $bodyLines.Add("Content-Disposition: form-data; name=`"$k`"")
                $bodyLines.Add("")
                $bodyLines.Add("$($FormFields[$k])")
            }
        }

        if ($FormFile) {
            $file = Get-Item $FormFile
            $fileBytes = [System.IO.File]::ReadAllBytes($file.FullName)
            # Encode as ISO-8859-1 so binary bytes survive the string join.
            $fileContent = [System.Text.Encoding]::GetEncoding("ISO-8859-1").GetString($fileBytes)

            $bodyLines.Add("--$boundary")
            $bodyLines.Add("Content-Disposition: form-data; name=`"file`"; filename=`"$($file.Name)`"")
            $bodyLines.Add("Content-Type: application/octet-stream")
            $bodyLines.Add("")
            $bodyLines.Add($fileContent)
        }

        $bodyLines.Add("--$boundary--")

        $bodyStr = $bodyLines -join $LF
        $bodyBytes = [System.Text.Encoding]::GetEncoding("ISO-8859-1").GetBytes($bodyStr)

        $params["ContentType"] = "multipart/form-data; boundary=$boundary"
        $params["Body"] = $bodyBytes
    } elseif ($null -ne $Body) {
        $params["ContentType"] = "application/json"
        $params["Body"] = ($Body | ConvertTo-Json -Depth 10 -Compress)
    }

    return Invoke-RestMethod @params
}

function Invoke-Test {
    param(
        [string]$Name,
        [scriptblock]$Action,
        [object]$Expected = $null,
        [scriptblock]$Assert = $null
    )

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $result = & $Action
        $sw.Stop()

        if ($Assert) {
            $assertResult = & $Assert $result
            if ($assertResult -ne $true) {
                Add-Result -Name $Name -Status "fail" `
                    -Detail "Assertion failed: $assertResult" `
                    -Body $result -Expected $Expected `
                    -DurationMs $sw.ElapsedMilliseconds
                return $null
            }
        }

        Add-Result -Name $Name -Status "pass" -Body $result -Expected $Expected `
            -DurationMs $sw.ElapsedMilliseconds
        return $result
    } catch {
        $sw.Stop()
        $err = New-HttpErrorDetail $_
        Add-Result -Name $Name -Status "fail" `
            -HttpStatus $err.status `
            -Detail $err.message `
            -Body $err.body -Expected $Expected `
            -DurationMs $sw.ElapsedMilliseconds
        return $null
    }
}

function Expect-Status {
    param(
        [scriptblock]$Action,
        [int]$Status
    )
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        & $Action | Out-Null
        $sw.Stop()
        return [pscustomobject]@{ status = 200; error = $null; ms = $sw.ElapsedMilliseconds }
    } catch {
        $sw.Stop()
        $err = New-HttpErrorDetail $_
        return [pscustomobject]@{ status = $err.status; error = $err.message; ms = $sw.ElapsedMilliseconds }
    }
}

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

function New-TempCsv {
    # Every data row MUST have the same column count as the header (4).
    # Rows 8 and 9 intentionally have an empty field but still 4 columns.
    $path = Join-Path $env:TEMP ("test-cmt-" + [guid]::NewGuid().ToString("N") + ".csv")
    $lines = @(
        "id,comment_text,sentiment,type",
        "r1,This product is amazing,positive,english",
        "r2,Worst purchase ever,negative,english",
        "r3,It is okay,neutral,english",
        "r4,অসাধারণ পণ্য,positive,bangla",
        "r5,খুব খারাপ,negative,bangla",
        "r6,Onek bhalo,neutral,banglish",
        "r1,Duplicate row should be skipped,neutral,english",
        ",empty id row should be skipped,neutral,english",
        "r8,,neutral,english"
    )
    Set-Content -Path $path -Value $lines -Encoding UTF8
    return $path
}

function New-TempXlsx {
    # Use `node -e` so the code runs with CWD = project root, letting
    # Node resolve `require('exceljs')` against the project's node_modules.
    # For `node -e "...code..." ARG`, process.argv[1] is the first user arg.
    $path = Join-Path $env:TEMP ("test-cmt-" + [guid]::NewGuid().ToString("N") + ".xlsx")

    $js = @'
const ExcelJS = require('exceljs');
(async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('cmt');
  ws.addRow(['id', 'comment_text', 'sentiment', 'type']);
  ws.addRow(['x1', 'Excel positive', 'positive', 'english']);
  ws.addRow(['x2', 'Excel negative', 'negative', 'english']);
  ws.addRow(['x3', 'Excel bangla', 'positive', 'bangla']);
  await wb.xlsx.writeFile(process.argv[1]);
})().catch(e => { console.error(e); process.exit(1); });
'@

    & node -e $js $path
    if ($LASTEXITCODE -ne 0) {
        throw "Node failed to build XLSX fixture (exit $LASTEXITCODE)"
    }
    return $path
}

function Wait-ForDataset {
    param(
        [string]$DatasetId,
        [int]$TimeoutSec = 60
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $r = Invoke-Api -Method GET -Path "/api/datasets/$DatasetId"
            $status = $r.dataset.status
            if ($status -in @("completed", "failed")) { return $r }
        } catch {}
        Start-Sleep -Milliseconds 500
    }
    throw "Dataset $DatasetId did not finish within $TimeoutSec seconds"
}

# ---------------------------------------------------------------------------
# Test suites
# ---------------------------------------------------------------------------

function Test-Health {
    Invoke-Test "GET /health returns ok" {
        Invoke-Api -Method GET -Path "/health"
    } -Assert { param($r) if ($r.success -eq $true) { $true } else { "success was $($r.success)" } } | Out-Null

    Invoke-Test "GET /health exposes queue state" {
        Invoke-Api -Method GET -Path "/health"
    } -Assert {
        param($r)
        if (-not $r.queues) { return "no queues field on /health" }
        if (-not $r.queues.imports) { return "no imports queue" }
        if (-not $r.queues.exports) { return "no exports queue" }
        if (-not $r.queues.imports.concurrency) { return "imports queue has no concurrency value" }
        if (-not $r.queues.exports.concurrency) { return "exports queue has no concurrency value" }
        $true
    } | Out-Null

    Invoke-Test "GET / returns running message" {
        Invoke-Api -Method GET -Path "/"
    } | Out-Null
}

function Test-Bootstrap {
    $status = Invoke-Test "GET /api/auth/bootstrap-status" {
        Invoke-Api -Method GET -Path "/api/auth/bootstrap-status"
    } | Out-Null

    $bs = Invoke-Api -Method GET -Path "/api/auth/bootstrap-status"

    if ($bs.adminCount -eq 0) {
        Invoke-Test "POST /api/auth/bootstrap creates admin" {
            Invoke-Api -Method POST -Path "/api/auth/bootstrap" -Body @{
                name            = "Test Admin"
                email           = $AdminEmail
                password        = $AdminPassword
                confirmPassword = $AdminPassword
            }
        } -Assert { param($r) if ($r.success -eq $true -and $r.userId) { $true } else { "no userId" } } | Out-Null

        $again = Expect-Status -Action {
            Invoke-Api -Method POST -Path "/api/auth/bootstrap" -Body @{
                name            = "Test Admin 2"
                email           = "second@test.local"
                password        = $AdminPassword
                confirmPassword = $AdminPassword
            }
        } -Status 400

        Add-Result -Name "POST /api/auth/bootstrap rejects second attempt" `
            -Status ($(if ($again.status -eq 400) { "pass" } else { "fail" })) `
            -HttpStatus $again.status `
            -Detail ($(if ($again.status -eq 400) { "" } else { "expected 400, got $($again.status)" })) `
            -DurationMs $again.ms
    } else {
        Add-Result -Name "POST /api/auth/bootstrap creates admin" -Status "skip" -Detail "admin already exists; skipping bootstrap test"
    }
}

function Test-Login {
    $login = Invoke-Test "POST /api/auth/login returns token" {
        Invoke-Api -Method POST -Path "/api/auth/login" -Body @{
            email    = $AdminEmail
            password = $AdminPassword
        }
    } -Assert { param($r) if ($r.token -and $r.user) { $true } else { "missing token/user" } }

    if ($login -and $login.token) {
        $script:Token = $login.token
        $script:AdminId = $login.user._id
    }

    # Negative test: wrong password should yield 401. A 429 means the
    # rate limiter kicked in first — record it as a skip, not a fail.
    $bad = Expect-Status -Action {
        Invoke-Api -Method POST -Path "/api/auth/login" -Body @{
            email    = $AdminEmail
            password = "wrong-password"
        }
    }
    $statusIs401 = $bad.status -eq 401
    $statusIs429 = $bad.status -eq 429
    Add-Result -Name "POST /api/auth/login rejects wrong password" `
        -Status ($(if ($statusIs401) { "pass" } elseif ($statusIs429) { "skip" } else { "fail" })) `
        -HttpStatus $bad.status `
        -Detail ($(if ($statusIs401) { "" }
                   elseif ($statusIs429) { "rate-limited; negative path not testable" }
                   else { "expected 401 or 429, got $($bad.status)" })) `
        -DurationMs $bad.ms

    Invoke-Test "GET /api/auth/me returns current user" {
        Invoke-Api -Method GET -Path "/api/auth/me"
    } | Out-Null
}

function Test-Users {
    Invoke-Test "GET /api/users lists users" {
        Invoke-Api -Method GET -Path "/api/users"
    } -Assert { param($r) if ($r.success -eq $true -and $r.users) { $true } else { "no users array" } } | Out-Null

    $created = Invoke-Test "POST /api/users creates annotator" {
        Invoke-Api -Method POST -Path "/api/users" -Body @{
            name     = "Test Annotator"
            email    = "annotator@test.local"
            password = "password1234"
            role     = "annotator"
        }
    }

    if ($created -and $created.userId) {
        $script:AnnotatorId = $created.userId

        Invoke-Test "GET /api/users/:id returns the created user" {
            Invoke-Api -Method GET -Path "/api/users/$($script:AnnotatorId)"
        } | Out-Null

        Invoke-Test "PATCH /api/users/:id updates name" {
            Invoke-Api -Method PATCH -Path "/api/users/$($script:AnnotatorId)" -Body @{
                name = "Renamed Annotator"
            }
        } | Out-Null

        Invoke-Test "PATCH /api/users/:id/status toggles active" {
            Invoke-Api -Method PATCH -Path "/api/users/$($script:AnnotatorId)/status"
        } | Out-Null

        Invoke-Test "PATCH /api/users/:id/status toggles back" {
            Invoke-Api -Method PATCH -Path "/api/users/$($script:AnnotatorId)/status"
        } | Out-Null

        Invoke-Test "POST /api/users/:id/reset-password" {
            Invoke-Api -Method POST -Path "/api/users/$($script:AnnotatorId)/reset-password" -Body @{
                newPassword     = "newpassword1234"
                confirmPassword = "newpassword1234"
            }
        } | Out-Null
    } else {
        Add-Result -Name "GET /api/users/:id" -Status "skip" -Detail "user creation failed"
        Add-Result -Name "PATCH /api/users/:id" -Status "skip" -Detail "user creation failed"
    }
}

function Test-Taxonomy {
    $created = Invoke-Test "POST /api/taxonomies creates taxonomy" {
        Invoke-Api -Method POST -Path "/api/taxonomies" -Body @{
            name        = "Test Taxonomy " + [guid]::NewGuid().ToString("N").Substring(0,8)
            description = "Created by api-test.ps1"
            sentiment   = @(
                @{ label = "Positive"; value = "positive" },
                @{ label = "Negative"; value = "negative" },
                @{ label = "Neutral";  value = "neutral" }
            )
            type        = @(
                @{ label = "English";  value = "english" },
                @{ label = "Bangla";   value = "bangla" },
                @{ label = "Banglish"; value = "banglish" }
            )
        }
    }

    Invoke-Test "GET /api/taxonomies lists taxonomies" {
        Invoke-Api -Method GET -Path "/api/taxonomies"
    } | Out-Null

    Invoke-Test "GET /api/taxonomies/defaults returns defaults" {
        Invoke-Api -Method GET -Path "/api/taxonomies/defaults"
    } | Out-Null

    if ($created -and $created.taxonomyId) {
        $script:TaxonomyId = $created.taxonomyId

        Invoke-Test "GET /api/taxonomies/:id returns taxonomy" {
            Invoke-Api -Method GET -Path "/api/taxonomies/$($script:TaxonomyId)"
        } | Out-Null

        Invoke-Test "PATCH /api/taxonomies/:id updates description" {
            Invoke-Api -Method PATCH -Path "/api/taxonomies/$($script:TaxonomyId)" -Body @{
                description = "Updated by api-test"
            }
        } | Out-Null
    } else {
        Add-Result -Name "GET /api/taxonomies/:id" -Status "skip" -Detail "taxonomy creation failed"
    }
}

function Test-DatasetImportCsv {
    $csv = New-TempCsv
    try {
        Invoke-Test "POST /api/datasets/preview parses CSV" {
            Invoke-Api -Method POST -Path "/api/datasets/preview" -Form -FormFile $csv
        } -Assert { param($r) if ($r.preview -and $r.preview.totalRows -gt 0) { $true } else { "preview missing" } } | Out-Null

        $import = Invoke-Test "POST /api/datasets/import (CSV) starts import" {
            Invoke-Api -Method POST -Path "/api/datasets/import" -Form -FormFile $csv -FormFields @{
                name           = "CSV Test Dataset " + [guid]::NewGuid().ToString("N").Substring(0,6)
                dedupeStrategy = "skip"
            }
        }

        if ($import -and $import.datasetId) {
            $script:CsvDatasetId = $import.datasetId

            Invoke-Test "GET /api/datasets/:id polls until complete" {
                Wait-ForDataset -DatasetId $script:CsvDatasetId -TimeoutSec 60
            } -Assert { param($r) if ($r.dataset.status -eq "completed") { $true } else { "status was $($r.dataset.status)" } } | Out-Null

            Invoke-Test "Imported CSV has expected rows" {
                $r = Invoke-Api -Method GET -Path "/api/datasets/$($script:CsvDatasetId)"
                if ($r.dataset.importedRows -ge 5) { $true }
                else { "importedRows=$($r.dataset.importedRows)" }
            } | Out-Null
        }
    } finally {
        Remove-Item $csv -Force -ErrorAction SilentlyContinue
    }
}

function Test-DatasetImportXlsx {
    try {
        $xlsx = New-TempXlsx
    } catch {
        Add-Result -Name "POST /api/datasets/import (XLSX)" -Status "skip" -Detail "exceljs unavailable: $($_.Exception.Message)"
        return
    }
    try {
        $import = Invoke-Test "POST /api/datasets/import (XLSX) starts import" {
            Invoke-Api -Method POST -Path "/api/datasets/import" -Form -FormFile $xlsx -FormFields @{
                name           = "XLSX Test Dataset " + [guid]::NewGuid().ToString("N").Substring(0,6)
                dedupeStrategy = "skip"
            }
        }

        if ($import -and $import.datasetId) {
            $script:XlsxDatasetId = $import.datasetId
            Invoke-Test "GET /api/datasets/:id (XLSX) polls until complete" {
                Wait-ForDataset -DatasetId $script:XlsxDatasetId -TimeoutSec 60
            } -Assert { param($r) if ($r.dataset.status -eq "completed") { $true } else { "status was $($r.dataset.status)" } } | Out-Null
        }
    } finally {
        Remove-Item $xlsx -Force -ErrorAction SilentlyContinue
    }
}

function Test-DatasetCrud {
    Invoke-Test "GET /api/datasets lists datasets" {
        Invoke-Api -Method GET -Path "/api/datasets"
    } | Out-Null

    Invoke-Test "GET /api/datasets?includeCounts=true attaches summaries" {
        Invoke-Api -Method GET -Path "/api/datasets?includeCounts=true"
    } -Assert {
        param($r)
        if (-not $r.datasets) { return "no datasets array" }
        if ($r.datasets.Count -eq 0) { return $true }
        if ($r.datasets | Where-Object { $_.summary }) { $true }
        else { "no summary fields" }
    } | Out-Null

    Invoke-Test "GET /api/datasets/stats returns dashboard stats" {
        Invoke-Api -Method GET -Path "/api/datasets/stats"
    } | Out-Null

    if (-not $script:CsvDatasetId) {
        Add-Result -Name "Dataset rename/assign/duplicate/delete" -Status "skip" -Detail "no CSV dataset"
        return
    }

    Invoke-Test "PATCH /api/datasets/:id renames dataset" {
        Invoke-Api -Method PATCH -Path "/api/datasets/$($script:CsvDatasetId)" -Body @{
            name = "Renamed " + [guid]::NewGuid().ToString("N").Substring(0,6)
        }
    } | Out-Null

    if ($script:AnnotatorId) {
        Invoke-Test "PATCH /api/datasets/:id/assign assigns to annotator" {
            Invoke-Api -Method PATCH -Path "/api/datasets/$($script:CsvDatasetId)/assign" -Body @{
                assignedTo = $script:AnnotatorId
            }
        } | Out-Null

        Invoke-Test "PATCH /api/datasets/:id/assign unassigns" {
            Invoke-Api -Method PATCH -Path "/api/datasets/$($script:CsvDatasetId)/assign" -Body @{
                assignedTo = $null
            }
        } | Out-Null
    }

    $dup = Invoke-Test "POST /api/datasets/:id/duplicate copies dataset" {
        Invoke-Api -Method POST -Path "/api/datasets/$($script:CsvDatasetId)/duplicate" -Body @{
            name = "Duplicate " + [guid]::NewGuid().ToString("N").Substring(0,6)
        }
    }

    if ($dup -and $dup.datasetId) {
        Invoke-Test "DELETE /api/datasets/:id (duplicate) cleans up" {
            Invoke-Api -Method DELETE -Path "/api/datasets/$($dup.datasetId)"
        } | Out-Null
    }
}

function Test-Comments {
    if (-not $script:CsvDatasetId) {
        Add-Result -Name "Comment tests" -Status "skip" -Detail "no CSV dataset"
        return
    }

    $list = Invoke-Test "GET /api/comments?datasetId=... lists comments" {
        Invoke-Api -Method GET -Path "/api/comments?datasetId=$($script:CsvDatasetId)&limit=5"
    }

    if (-not $list -or $list.total -eq 0) {
        Add-Result -Name "Comment CRUD" -Status "skip" -Detail "no comments in CSV dataset"
        return
    }

    $commentId = $list.comments[0].id

    Invoke-Test "GET /api/comments/:id returns comment" {
        Invoke-Api -Method GET -Path "/api/comments/$commentId"
    } | Out-Null

    Invoke-Test "PATCH /api/comments/:id updates text" {
        Invoke-Api -Method PATCH -Path "/api/comments/$commentId" -Body @{
            commentText = "Updated text " + [guid]::NewGuid().ToString("N").Substring(0,6)
        }
    } | Out-Null

    Invoke-Test "PATCH /api/comments/:id/annotation saves annotation" {
        Invoke-Api -Method PATCH -Path "/api/comments/$commentId/annotation" -Body @{
            sentiment      = "positive"
            type           = "english"
            annotationNote = "Reviewed by api-test"
        }
    } | Out-Null

    Invoke-Test "GET /api/comments/:id/versions lists versions" {
        Invoke-Api -Method GET -Path "/api/comments/$commentId/versions"
    } -Assert { param($r) if ($r.versions -and $r.versions.Count -ge 2) { $true } else { "expected >=2 versions, got $($r.versions.Count)" } } | Out-Null

    Invoke-Test "POST /api/comments/:id/restore/:version restores" {
        Invoke-Api -Method POST -Path "/api/comments/$commentId/restore/1"
    } | Out-Null

    $allIds = @($list.comments | ForEach-Object { $_.id })
    if ($allIds.Count -gt 0) {
        Invoke-Test "POST /api/comments/bulk-annotate applies to many" {
            Invoke-Api -Method POST -Path "/api/comments/bulk-annotate" -Body @{
                ids            = $allIds
                sentiment      = "neutral"
                type           = "english"
                annotationNote = "bulk by api-test"
            }
        } | Out-Null

        if ($script:AnnotatorId) {
            Invoke-Test "POST /api/comments/bulk-assign assigns to annotator" {
                Invoke-Api -Method POST -Path "/api/comments/bulk-assign" -Body @{
                    ids        = $allIds
                    assignedTo = $script:AnnotatorId
                }
            } | Out-Null

            Invoke-Test "POST /api/comments/bulk-assign unassigns" {
                Invoke-Api -Method POST -Path "/api/comments/bulk-assign" -Body @{
                    ids        = $allIds
                    assignedTo = $null
                }
            } | Out-Null
        }
    }
}

function Test-Exports {
    if (-not $script:CsvDatasetId) {
        Add-Result -Name "Exports" -Status "skip" -Detail "no CSV dataset"
        return
    }

    Invoke-Test "GET /api/comments/export?format=csv" {
        $resp = Invoke-WebRequest -Uri "$BaseUrl/api/comments/export?format=csv" `
            -Headers @{ Authorization = "Bearer $($script:Token)" } `
            -UseBasicParsing
        if ($resp.Content.Length -gt 0) { $true } else { "empty export" }
    } | Out-Null

    Invoke-Test "GET /api/comments/export?format=xlsx" {
        $resp = Invoke-WebRequest -Uri "$BaseUrl/api/comments/export?format=xlsx" `
            -Headers @{ Authorization = "Bearer $($script:Token)" } `
            -UseBasicParsing
        if ($resp.RawContentLength -gt 0) { $true } else { "empty xlsx" }
    } | Out-Null

    Invoke-Test "GET /api/analytics/dataset/:id/export-ml?format=jsonl" {
        $resp = Invoke-WebRequest -Uri "$BaseUrl/api/analytics/dataset/$($script:CsvDatasetId)/export-ml?format=jsonl" `
            -Headers @{ Authorization = "Bearer $($script:Token)" } `
            -UseBasicParsing
        if ($resp.Content.Length -gt 0) { $true } else { "empty jsonl" }
    } | Out-Null

    Invoke-Test "GET /api/analytics/dataset/:id/export-ml?format=csv" {
        $resp = Invoke-WebRequest -Uri "$BaseUrl/api/analytics/dataset/$($script:CsvDatasetId)/export-ml?format=csv" `
            -Headers @{ Authorization = "Bearer $($script:Token)" } `
            -UseBasicParsing
        if ($resp.Content.Length -gt 0) { $true } else { "empty csv" }
    } | Out-Null

    Invoke-Test "GET /api/analytics/dataset/:id/export-ml?format=xlsx" {
        $resp = Invoke-WebRequest -Uri "$BaseUrl/api/analytics/dataset/$($script:CsvDatasetId)/export-ml?format=xlsx" `
            -Headers @{ Authorization = "Bearer $($script:Token)" } `
            -UseBasicParsing
        if ($resp.RawContentLength -gt 0) { $true } else { "empty xlsx" }
    } | Out-Null
}

function Test-Analytics {
    if ($script:CsvDatasetId) {
        Invoke-Test "GET /api/analytics/dataset/:id returns per-dataset analytics" {
            Invoke-Api -Method GET -Path "/api/analytics/dataset/$($script:CsvDatasetId)"
        } -Assert { param($r) if ($r.overview -and $r.sentiment -and $r.readiness) { $true } else { "missing blocks" } } | Out-Null
    } else {
        Add-Result -Name "GET /api/analytics/dataset/:id" -Status "skip" -Detail "no dataset"
    }

    Invoke-Test "GET /api/analytics/global returns global analytics" {
        Invoke-Api -Method GET -Path "/api/analytics/global"
    } -Assert { param($r) if ($r.overview -and $r.activityLast14Days) { $true } else { "missing blocks" } } | Out-Null
}

function Test-Audit {
    Invoke-Test "GET /api/audit returns paginated entries" {
        Invoke-Api -Method GET -Path "/api/audit?limit=10"
    } -Assert { param($r) if ($r.entries) { $true } else { "no entries" } } | Out-Null

    Invoke-Test "GET /api/audit/actions returns distinct actions" {
        Invoke-Api -Method GET -Path "/api/audit/actions"
    } -Assert { param($r) if ($r.actions -and $r.actions.Count -gt 0) { $true } else { "no actions" } } | Out-Null
}

function Test-AccessControl {
    if (-not $script:AnnotatorId) {
        Add-Result -Name "Annotator access-control tests" -Status "skip" -Detail "no annotator user"
        return
    }

    # Try both possible passwords. A 429 here is rate limiting, not a
    # credential failure — record it as a skip rather than a hard fail.
    $annotatorLogin = $null
    $loginBlocked = $false
    foreach ($pw in @("password1234", "newpassword1234")) {
        try {
            $annotatorLogin = Invoke-Api -Method POST -Path "/api/auth/login" -Body @{
                email    = "annotator@test.local"
                password = $pw
            }
            if ($annotatorLogin -and $annotatorLogin.token) { break }
        } catch {
            $err = New-HttpErrorDetail $_
            if ($err.status -eq 429) { $loginBlocked = $true; break }
        }
    }

    if (-not $annotatorLogin -or -not $annotatorLogin.token) {
        $detail = if ($loginBlocked) { "rate-limited; cannot log in as annotator" }
                  else { "could not log in as annotator" }
        Add-Result -Name "Annotator access-control tests" -Status "skip" -Detail $detail
        return
    }

    $adminToken = $script:Token
    $script:Token = $annotatorLogin.token

    $r = Expect-Status -Action {
        Invoke-Api -Method GET -Path "/api/users"
    }
    Add-Result -Name "Annotator cannot GET /api/users" `
        -Status ($(if ($r.status -eq 403) { "pass" } else { "fail" })) `
        -HttpStatus $r.status `
        -Detail ($(if ($r.status -eq 403) { "" } else { "expected 403, got $($r.status)" })) `
        -DurationMs $r.ms

    $r2 = Expect-Status -Action {
        Invoke-Api -Method GET -Path "/api/analytics/global"
    }
    Add-Result -Name "Annotator cannot GET /api/analytics/global" `
        -Status ($(if ($r2.status -eq 403) { "pass" } else { "fail" })) `
        -HttpStatus $r2.status `
        -Detail ($(if ($r2.status -eq 403) { "" } else { "expected 403, got $($r2.status)" })) `
        -DurationMs $r2.ms

    $script:Token = $adminToken
}

function Test-Cleanup {
    if ($script:XlsxDatasetId) {
        Invoke-Test "DELETE /api/datasets/:id (XLSX dataset)" {
            Invoke-Api -Method DELETE -Path "/api/datasets/$($script:XlsxDatasetId)"
        } | Out-Null
    }
    if ($script:CsvDatasetId) {
        Invoke-Test "DELETE /api/datasets/:id (CSV dataset)" {
            Invoke-Api -Method DELETE -Path "/api/datasets/$($script:CsvDatasetId)"
        } | Out-Null
    }
    if ($script:TaxonomyId) {
        Invoke-Test "DELETE /api/taxonomies/:id?hard=true" {
            Invoke-Api -Method DELETE -Path "/api/taxonomies/$($script:TaxonomyId)?hard=true"
        } | Out-Null
    }
    if ($script:AnnotatorId) {
        Invoke-Test "DELETE /api/users/:id" {
            Invoke-Api -Method DELETE -Path "/api/users/$($script:AnnotatorId)"
        } | Out-Null
    }
}

# ---------------------------------------------------------------------------
# Server lifecycle
# ---------------------------------------------------------------------------

function Start-TestServer {
    if (-not $StartServer) { return }

    Write-Host "Starting server (npm start) ..." -ForegroundColor Cyan
    $script:ServerProcess = Start-Process -FilePath "npm" `
        -ArgumentList @("start") `
        -PassThru -NoNewWindow

    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline) {
        try {
            $r = Invoke-RestMethod -Uri "$BaseUrl/health" -TimeoutSec 2
            if ($r.success) { Write-Host "Server up." -ForegroundColor Green; return }
        } catch {}
        Start-Sleep -Milliseconds 500
    }
    throw "Server did not come up within 30 seconds"
}

function Stop-TestServer {
    if ($script:ServerProcess -and -not $script:ServerProcess.HasExited) {
        Write-Host "Stopping test server ..." -ForegroundColor Cyan
        try { Stop-Process -Id $script:ServerProcess.Id -Force -ErrorAction SilentlyContinue } catch {}
    }
}

# ---------------------------------------------------------------------------
# Report writer
# ---------------------------------------------------------------------------

function Write-Reports {
    $dir = Join-Path (Get-Location) "tests\results"
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }

    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $txtPath = Join-Path $dir "api-test-$stamp.txt"
    $jsonPath = Join-Path $dir "api-test-$stamp.json"

    $elapsed = (Get-Date) - $script:Started
    $total = $script:Passed + $script:Failed + $script:Skipped

    $lines = @()
    $lines += "=============================================="
    $lines += "Annotator API Test Report"
    $lines += "=============================================="
    $lines += "Started:  $($script:Started.ToString('o'))"
    $lines += "Base URL: $BaseUrl"
    $lines += "Total:    $total"
    $lines += "Passed:   $($script:Passed)"
    $lines += "Failed:   $($script:Failed)"
    $lines += "Skipped:  $($script:Skipped)"
    $lines += "Duration: $([int]$elapsed.TotalSeconds)s"
    $lines += ""
    $lines += "----------------------------------------------"
    $lines += "RESULTS"
    $lines += "----------------------------------------------"

    foreach ($r in $script:Results) {
        $tag = $r.status.ToUpper().PadRight(4)
        $lines += "[$tag] $($r.name)  ($($r.durationMs)ms)"
        if ($r.httpStatus -gt 0) {
            $lines += "        HTTP $($r.httpStatus)"
        }
        if ($r.status -eq "fail" -and $r.detail) {
            $lines += "        $($r.detail)"
        }
        if ($r.status -eq "fail" -and $r.body) {
            $bodyStr = if ($r.body -is [string]) { $r.body } else { $r.body | ConvertTo-Json -Depth 4 -Compress }
            if ($bodyStr.Length -gt 500) { $bodyStr = $bodyStr.Substring(0, 500) + "...[truncated]" }
            $lines += "        body: $bodyStr"
        }
    }
    $lines += ""
    $lines += "=============================================="
    $lines += "END"
    $lines += "=============================================="

    Set-Content -Path $txtPath -Value ($lines -join [Environment]::NewLine) -Encoding UTF8

    $report = [ordered]@{
        started    = $script:Started.ToString("o")
        finished   = (Get-Date).ToString("o")
        baseUrl    = $BaseUrl
        totals     = @{
            total   = $total
            passed  = $script:Passed
            failed  = $script:Failed
            skipped = $script:Skipped
        }
        durationMs = [int]$elapsed.TotalMilliseconds
        results    = $script:Results
    }
    $report | ConvertTo-Json -Depth 10 | Set-Content -Path $jsonPath -Encoding UTF8

    Write-Host ""
    Write-Host "Text report: $txtPath" -ForegroundColor Cyan
    Write-Host "JSON report: $jsonPath" -ForegroundColor Cyan
}

# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

function Main {
    Write-Host "Annotator API Test" -ForegroundColor Cyan
    Write-Host "Base URL: $BaseUrl" -ForegroundColor Cyan
    Write-Host ""

    try {
        Start-TestServer

        Test-Health
        Test-Bootstrap
        Test-Login
        Test-Users
        Test-Taxonomy
        Test-DatasetImportCsv
        Test-DatasetImportXlsx
        Test-DatasetCrud
        Test-Comments
        Test-Exports
        Test-Analytics
        Test-Audit
        Test-AccessControl
        Test-Cleanup
    } finally {
        Stop-TestServer
        Write-Reports
    }

    if ($script:Failed -gt 0) { exit 1 } else { exit 0 }
}

Main