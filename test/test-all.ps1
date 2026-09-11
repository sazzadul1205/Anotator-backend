# test-all.ps1

$BASE = "http://localhost:5000/api"
$ErrorActionPreference = "Continue"

function Step($msg) {
  Write-Host "`n=== $msg ===" -ForegroundColor Cyan
}

function Show($obj) {
  $obj | ConvertTo-Json -Depth 6
}

# ---------- 1. Bootstrap status (before admin) ----------
Step "1. Bootstrap status (before admin)"
Show (Invoke-RestMethod -Uri "$BASE/auth/bootstrap-status" -Method Get)

# ---------- 2. Create first admin ----------
Step "2. Create first admin"
try {
  Show (Invoke-RestMethod -Uri "$BASE/auth/bootstrap" -Method Post `
    -ContentType "application/json" `
    -Body (@{
      name            = "Root Admin"
      email           = "admin@test.com"
      password        = "admin123"
      confirmPassword = "admin123"
    } | ConvertTo-Json))
} catch { $_.ErrorDetails.Message }

# ---------- 3. Bootstrap status (after admin) ----------
Step "3. Bootstrap status (after admin)"
Show (Invoke-RestMethod -Uri "$BASE/auth/bootstrap-status" -Method Get)

# ---------- 4. Bootstrap again (must fail) ----------
Step "4. Bootstrap again (must fail)"
try {
  Show (Invoke-RestMethod -Uri "$BASE/auth/bootstrap" -Method Post `
    -ContentType "application/json" `
    -Body (@{
      name            = "Second"
      email           = "x@test.com"
      password        = "x12345"
      confirmPassword = "x12345"
    } | ConvertTo-Json))
} catch { $_.ErrorDetails.Message }

# ---------- 5. Login as admin ----------
Step "5. Login as admin"
$login = Invoke-RestMethod -Uri "$BASE/auth/login" -Method Post `
  -ContentType "application/json" `
  -Body (@{ email="admin@test.com"; password="admin123" } | ConvertTo-Json)
Show $login

$TOKEN = $login.token
$headers = @{ Authorization = "Bearer $TOKEN" }
Write-Host "Token saved: $($TOKEN.Substring(0,25))..." -ForegroundColor Green

# ---------- 6. /auth/me ----------
Step "6. /auth/me"
Show (Invoke-RestMethod -Uri "$BASE/auth/me" -Headers $headers)

# ---------- 7. Login wrong password ----------
Step "7. Login wrong password (must fail)"
try {
  Show (Invoke-RestMethod -Uri "$BASE/auth/login" -Method Post `
    -ContentType "application/json" `
    -Body (@{ email="admin@test.com"; password="wrong" } | ConvertTo-Json))
} catch { $_.ErrorDetails.Message }

# ---------- 8. Logout ----------
Step "8. Logout"
Show (Invoke-RestMethod -Uri "$BASE/auth/logout" -Method Post -Headers $headers)

# ---------- 9. List users ----------
Step "9. List users"
Show (Invoke-RestMethod -Uri "$BASE/users" -Headers $headers)

# ---------- 10. Create annotator ----------
Step "10. Create annotator"
Show (Invoke-RestMethod -Uri "$BASE/users" -Method Post -Headers $headers `
  -ContentType "application/json" `
  -Body (@{
    name     = "Anno One"
    email    = "anno@test.com"
    password = "anno123"
    role     = "annotator"
  } | ConvertTo-Json))

# Save annotator id
$ANNO_ID = (Invoke-RestMethod -Uri "$BASE/users" -Headers $headers).users |
  Where-Object { $_.role -eq "annotator" } | Select-Object -First 1 -ExpandProperty _id
Write-Host "Annotator ID: $ANNO_ID"

# ---------- 11. Get annotator ----------
Step "11. Get annotator"
Show (Invoke-RestMethod -Uri "$BASE/users/$ANNO_ID" -Headers $headers)

# ---------- 12. Update annotator name ----------
Step "12. Update annotator name"
Show (Invoke-RestMethod -Uri "$BASE/users/$ANNO_ID" -Method Patch -Headers $headers `
  -ContentType "application/json" `
  -Body (@{ name="Anno One Updated" } | ConvertTo-Json))

# ---------- 13. Reset annotator password ----------
Step "13. Reset annotator password"
Show (Invoke-RestMethod -Uri "$BASE/users/$ANNO_ID/reset-password" -Method Post `
  -Headers $headers -ContentType "application/json" `
  -Body (@{
    newPassword     = "newpass123"
    confirmPassword = "newpass123"
  } | ConvertTo-Json))

# ---------- 14. Deactivate annotator ----------
Step "14. Deactivate annotator"
Show (Invoke-RestMethod -Uri "$BASE/users/$ANNO_ID/status" -Method Patch -Headers $headers)

# ---------- 15. Login as deactivated (must fail) ----------
Step "15. Login deactivated (must fail)"
try {
  Show (Invoke-RestMethod -Uri "$BASE/auth/login" -Method Post `
    -ContentType "application/json" `
    -Body (@{ email="anno@test.com"; password="newpass123" } | ConvertTo-Json))
} catch { $_.ErrorDetails.Message }

# ---------- 16. Reactivate annotator ----------
Step "16. Reactivate annotator"
Show (Invoke-RestMethod -Uri "$BASE/users/$ANNO_ID/status" -Method Patch -Headers $headers)

# ---------- 17. Login as annotator (should work) ----------
Step "17. Login annotator (should work)"
try {
  Show (Invoke-RestMethod -Uri "$BASE/auth/login" -Method Post `
    -ContentType "application/json" `
    -Body (@{ email="anno@test.com"; password="newpass123" } | ConvertTo-Json))
} catch { $_.ErrorDetails.Message }

# ---------- 18. Self-deactivate admin (must fail) ----------
Step "18. Self-deactivate admin (must fail)"
$ADMIN_ID = (Invoke-RestMethod -Uri "$BASE/auth/me" -Headers $headers).user.userId
try {
  Show (Invoke-RestMethod -Uri "$BASE/users/$ADMIN_ID/status" -Method Patch -Headers $headers)
} catch { $_.ErrorDetails.Message }

# ---------- 19. Import dataset ----------
Step "19. Import dataset"
$filePath = "H:\senti_cmt (1).xlsx"
if (-not (Test-Path $filePath)) {
  Write-Host "File not found: $filePath - skipping import" -ForegroundColor Yellow
} else {
  $import = curl.exe -s -X POST "$BASE/datasets/import" `
    -H "Authorization: Bearer $TOKEN" `
    -F "file=@$filePath" `
    -F "name=Sample Comments"
  $importObj = $import | ConvertFrom-Json
  Show $importObj
  $DATASET_ID = $importObj.datasetId
  Write-Host "Dataset ID: $DATASET_ID"

  # ---------- 20. Poll until completed ----------
  Step "20. Poll until completed"
  for ($i=1; $i -le 15; $i++) {
    $status = (Invoke-RestMethod -Uri "$BASE/datasets/$DATASET_ID" -Headers $headers).dataset.status
    Write-Host "  attempt $i : $status"
    if ($status -in @("completed","failed")) { break }
    Start-Sleep -Seconds 1
  }

  # ---------- 21. Dataset details ----------
  Step "21. Dataset details"
  Show (Invoke-RestMethod -Uri "$BASE/datasets/$DATASET_ID" -Headers $headers)

  # ---------- 22. List datasets ----------
  Step "22. List datasets"
  Show (Invoke-RestMethod -Uri "$BASE/datasets" -Headers $headers)

  # ---------- 23. Rename dataset ----------
  Step "23. Rename dataset"
  Show (Invoke-RestMethod -Uri "$BASE/datasets/$DATASET_ID" -Method Patch -Headers $headers `
    -ContentType "application/json" `
    -Body (@{ name="Renamed Dataset" } | ConvertTo-Json))

  # ---------- 24. List comments ----------
  Step "24. List first 5 comments"
  $comments = Invoke-RestMethod -Uri "$BASE/comments?datasetId=$DATASET_ID&limit=5" -Headers $headers
  Show $comments

  $COMMENT_ID = (Invoke-RestMethod -Uri "$BASE/comments?datasetId=$DATASET_ID&limit=1" -Headers $headers).comments[0]._id
  Write-Host "Comment ID: $COMMENT_ID"

  # ---------- 25. Get comment ----------
  Step "25. Get comment"
  Show (Invoke-RestMethod -Uri "$BASE/comments/$COMMENT_ID" -Headers $headers)

  # ---------- 26. Annotate positive/english ----------
  Step "26. Annotate positive + english"
  Show (Invoke-RestMethod -Uri "$BASE/comments/$COMMENT_ID/annotation" -Method Patch -Headers $headers `
    -ContentType "application/json" `
    -Body (@{ sentiment="positive"; type="english" } | ConvertTo-Json))

  # ---------- 27. Re-annotate neutral/banglish ----------
  Step "27. Re-annotate neutral + banglish"
  Show (Invoke-RestMethod -Uri "$BASE/comments/$COMMENT_ID/annotation" -Method Patch -Headers $headers `
    -ContentType "application/json" `
    -Body (@{ sentiment="neutral"; type="banglish" } | ConvertTo-Json))

  # ---------- 28. Update text ----------
  Step "28. Update commentText"
  Show (Invoke-RestMethod -Uri "$BASE/comments/$COMMENT_ID" -Method Patch -Headers $headers `
    -ContentType "application/json" `
    -Body (@{ commentText="Edited comment text" } | ConvertTo-Json))

  # ---------- 29. Version history ----------
  Step "29. Version history"
  Show (Invoke-RestMethod -Uri "$BASE/comments/$COMMENT_ID/versions" -Headers $headers)

  # ---------- 30. Restore v1 ----------
  Step "30. Restore version 1"
  Show (Invoke-RestMethod -Uri "$BASE/comments/$COMMENT_ID/restore/1" -Method Post -Headers $headers)

  # ---------- 31. Create manual comment ----------
  Step "31. Create manual comment"
  $manual = Invoke-RestMethod -Uri "$BASE/comments" -Method Post -Headers $headers `
    -ContentType "application/json" `
    -Body (@{
      datasetId   = $DATASET_ID
      sourceId    = "99999"
      commentText = "Manually added comment"
    } | ConvertTo-Json)
  Show $manual

  # ---------- 32. Duplicate sourceId (must fail) ----------
  Step "32. Duplicate sourceId (must fail)"
  try {
    Show (Invoke-RestMethod -Uri "$BASE/comments" -Method Post -Headers $headers `
      -ContentType "application/json" `
      -Body (@{
        datasetId   = $DATASET_ID
        sourceId    = "99999"
        commentText = "Duplicate"
      } | ConvertTo-Json))
  } catch { $_.ErrorDetails.Message }

  # ---------- 33. Delete manual comment ----------
  Step "33. Delete manual comment"
  $MANUAL_ID = (Invoke-RestMethod -Uri "$BASE/comments?datasetId=$DATASET_ID&search=Manually" -Headers $headers).comments[0]._id
  Show (Invoke-RestMethod -Uri "$BASE/comments/$MANUAL_ID" -Method Delete -Headers $headers)

  # ---------- 34. Export CSV ----------
  Step "34. Export CSV"
  curl.exe -s -L "$BASE/comments/export?format=csv&datasetId=$DATASET_ID" `
    -H "Authorization: Bearer $TOKEN" -o comments.csv
  Get-Content comments.csv -TotalCount 4

  # ---------- 35. Export XLSX ----------
  Step "35. Export XLSX (annotated only)"
  curl.exe -s -L "$BASE/comments/export?format=xlsx&datasetId=$DATASET_ID&status=annotated" `
    -H "Authorization: Bearer $TOKEN" -o comments-annotated.xlsx
  Get-Item comments-annotated.xlsx | Select-Object Name, Length

  # ---------- 36. Invalid export format (must fail) ----------
  Step "36. Invalid format (must fail)"
  try {
    Show (Invoke-RestMethod -Uri "$BASE/comments/export?format=pdf" -Headers $headers)
  } catch { $_.ErrorDetails.Message }

  # ---------- 37. Delete dataset (cascade) ----------
  Step "37. Delete dataset"
  Show (Invoke-RestMethod -Uri "$BASE/datasets/$DATASET_ID" -Method Delete -Headers $headers)
}

# ---------- 38. Delete annotator ----------
Step "38. Delete annotator"
Show (Invoke-RestMethod -Uri "$BASE/users/$ANNO_ID" -Method Delete -Headers $headers)

Write-Host "`n=== ALL TESTS DONE ===" -ForegroundColor Green