# 로컬 빌드 폴더(C:)의 소스와 빌드 결과물(exe)을 Google Drive(H:)로 백업한다.
# 사용: powershell -ExecutionPolicy Bypass -File scripts\sync-to-drive.ps1 [-WithRelease]
param([switch]$WithRelease)

$drive = "H:\내 드라이브\c_works\markdown_viewer"
$local = "C:\Users\gusta\c_works\markdown_viewer"

robocopy $local $drive /E /XD node_modules dist release .git /XF *.log /NFL /NDL /NJH /NP
$code = $LASTEXITCODE

if ($WithRelease -and (Test-Path "$local\release")) {
    # 설치/포터블 exe만 복사 (unpacked 폴더 제외)
    New-Item -ItemType Directory -Force "$drive\release" | Out-Null
    Copy-Item "$local\release\*.exe" "$drive\release\" -Force -ErrorAction SilentlyContinue
}

if ($code -lt 8) {
    Write-Host "동기화 완료: $local -> $drive" -ForegroundColor Green
    exit 0
} else {
    Write-Host "robocopy 오류 (exit $code)" -ForegroundColor Red
    exit $code
}
