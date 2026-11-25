@echo off
title ERA - Owner Voice Enrollment
echo ============================================================
echo           ERA VOICE IDENTITY - OWNER ENROLLMENT
echo ============================================================
echo You will be prompted to speak 3 to 4 natural sample phrases.
echo Please speak naturally into your microphone in a quiet room.
echo ============================================================
echo.
cd /d "d:\era_agent"
d:\era_agent\.venv\Scripts\python.exe -m era_voice_identity enroll --samples 3 --seconds 6
echo.
echo ============================================================
echo Enrollment complete! ERA will now verify every command.
echo ============================================================
pause
