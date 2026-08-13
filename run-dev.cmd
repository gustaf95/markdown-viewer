@echo off
rem 개발 모드 실행: Node.js portable을 PATH에 추가하고 빌드 후 앱 실행
setlocal
set "PATH=C:\Users\gusta\AppData\Local\Programs\node-lts;%PATH%"
cd /d "C:\Users\gusta\c_works\markdown_viewer"
call npm start
endlocal
