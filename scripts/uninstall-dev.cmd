@echo off
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall-dev.ps1"
if errorlevel 1 (
  echo.
  echo 卸载失败，请把上面的报错发给我。
)
echo.
pause
