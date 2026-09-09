@echo off
REM Opens Omni Agent as a desktop window (no console). Optional first argument: the working directory for pi.
REM For a shortcut with no console flash at all, point the shortcut directly at:
REM   pythonw.exe "<this folder>\desktop\omni_desktop.pyw"
start "" pythonw "%~dp0desktop\omni_desktop.pyw" %*
