@echo off
REM Opens TCP 4400 in Windows Firewall so other devices on your network can reach Omni Agent.
REM Asks for administrator rights once (UAC), then adds/refreshes the rule.
setlocal
set "PORT=%~1"
if "%PORT%"=="" set "PORT=4400"
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Requesting administrator rights to add the firewall rule for port %PORT%...
  powershell -NoProfile -Command "Start-Process -Verb RunAs -FilePath '%~f0' -ArgumentList '%PORT%'"
  exit /b
)
netsh advfirewall firewall delete rule name="Omni Agent" >nul 2>&1
netsh advfirewall firewall add rule name="Omni Agent" dir=in action=allow protocol=TCP localport=%PORT% profile=private,domain
echo.
echo Firewall rule "Omni Agent" added for TCP %PORT% on private/domain networks.
echo If your Wi-Fi is set to "Public", change it to "Private" in Windows network settings, or rerun with: netsh advfirewall firewall set rule name="Omni Agent" new profile=any
pause
