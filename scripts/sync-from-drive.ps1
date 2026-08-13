# Google Drive(H:)의 소스를 로컬 빌드 폴더(C:)로 가져온다.
# 사용: powershell -ExecutionPolicy Bypass -File scripts\sync-from-drive.ps1
$drive = "H:\내 드라이브\c_works\markdown_viewer"
$local = "C:\Users\gusta\c_works\markdown_viewer"

robocopy $drive $local /E /XD node_modules dist release .git /XF *.log /NFL /NDL /NJH /NP
if ($LASTEXITCODE -lt 8) {
    Write-Host "동기화 완료: $drive -> $local" -ForegroundColor Green
    exit 0
} else {
    Write-Host "robocopy 오류 (exit $LASTEXITCODE)" -ForegroundColor Red
    exit $LASTEXITCODE
}
