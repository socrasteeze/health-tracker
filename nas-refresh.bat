@echo off
REM One-command deploy trigger: SSHes into the NAS and runs nas-update.sh.
REM Usage:
REM   nas-refresh.bat                          (uses defaults below)
REM   nas-refresh.bat ~/other-app/nas-update.sh (override the remote script path)

setlocal
set NAS_HOST=lucyford@EAGLE-424
set NAS_PATH=~/health-log/nas-update.sh

set SCRIPT=%NAS_PATH%
if not "%~1"=="" set SCRIPT=%~1

echo Running %SCRIPT% on %NAS_HOST% ...
ssh %NAS_HOST% "sh %SCRIPT%"

endlocal
