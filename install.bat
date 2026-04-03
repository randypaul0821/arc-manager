@echo off
chcp 65001 >nul
title Arc Manager Pro - 环境安装
echo ========================================
echo   Arc Manager Pro - 一键安装
echo ========================================
echo.

:: ─── 检查 Python ───
python --version >nul 2>&1
if errorlevel 1 goto :install_python
goto :python_ok

:install_python
echo 未检测到 Python，将自动下载安装...
echo.

:: 下载 Python 安装包
set "PY_INSTALLER=%~dp0python-installer.exe"
echo 正在下载 Python 3.12.9, 约 25MB...
powershell -Command "try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://www.python.org/ftp/python/3.12.9/python-3.12.9-amd64.exe' -OutFile '%PY_INSTALLER%' -UseBasicParsing } catch { exit 1 }"
if errorlevel 1 (
    echo [错误] Python 下载失败，请检查网络连接
    echo 也可以手动下载安装: https://www.python.org/downloads/
    if exist "%PY_INSTALLER%" del "%PY_INSTALLER%"
    pause
    exit /b 1
)
echo       下载完成
echo.

:: 静默安装 Python（安装到用户目录，不需要管理员权限）
echo 正在安装 Python, 会显示安装进度...
"%PY_INSTALLER%" /passive PrependPath=1 Include_pip=1 Include_launcher=1
if errorlevel 1 (
    echo [错误] Python 安装失败
    del "%PY_INSTALLER%"
    pause
    exit /b 1
)
del "%PY_INSTALLER%"
echo       Python 安装成功
echo.

:: 刷新当前会话的 PATH（安装后 PATH 不会在当前窗口生效）
echo 刷新环境变量...
for /f "tokens=2*" %%a in ('reg query "HKCU\Environment" /v Path 2^>nul') do set "USERPATH=%%b"
for /f "tokens=2*" %%a in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul') do set "SYSPATH=%%b"
set "PATH=%SYSPATH%;%USERPATH%"

:: 验证 Python 可用
python --version >nul 2>&1
if errorlevel 1 (
    echo [错误] Python 已安装但当前窗口无法识别
    echo       请关闭此窗口，重新双击 install.bat
    pause
    exit /b 1
)

:python_ok
for /f "tokens=*" %%v in ('python --version 2^>^&1') do echo 检测到 %%v
echo.

:: ─── 创建虚拟环境 ───
if not exist "%~dp0venv\Scripts\activate.bat" (
    echo [1/3] 创建虚拟环境...
    python -m venv "%~dp0venv"
    if errorlevel 1 (
        echo [错误] 虚拟环境创建失败
        pause
        exit /b 1
    )
    echo       虚拟环境创建成功
) else (
    echo [1/3] 虚拟环境已存在，跳过
)
echo.

:: ─── 安装 Python 依赖 ───
echo [2/3] 安装 Python 依赖: flask, requests, playwright, jieba...
call "%~dp0venv\Scripts\activate.bat"
pip install -r "%~dp0requirements.txt" -q
if errorlevel 1 (
    echo [错误] 依赖安装失败，请检查网络连接
    pause
    exit /b 1
)
echo       Python 依赖安装成功
echo.

:: ─── 安装 Playwright 浏览器 ───
set "PW_DEST=%LOCALAPPDATA%\ms-playwright"

:: 检查是否已安装
for /d %%d in ("%PW_DEST%\chromium-*") do goto :pw_done
:: 未安装，检查离线包
for /d %%d in ("%~dp0playwright-browsers\chromium-*") do goto :pw_offline
:: 无离线包，在线下载
goto :pw_online

:pw_offline
echo [3/3] 从离线包安装 Playwright 浏览器...
if not exist "%PW_DEST%" mkdir "%PW_DEST%"
for /d %%d in ("%~dp0playwright-browsers\chromium-*") do xcopy "%%d" "%PW_DEST%\%%~nxd\" /s /e /q >nul
for /d %%d in ("%~dp0playwright-browsers\chromium_headless_shell-*") do xcopy "%%d" "%PW_DEST%\%%~nxd\" /s /e /q >nul
echo       Playwright 浏览器安装成功
echo.
goto :pw_done

:pw_online
echo [3/3] 下载 Playwright Chromium 浏览器...
playwright install chromium
echo.
goto :pw_done

:pw_done
echo [3/3] Playwright 浏览器已就绪
echo.

:: ─── 完成 ───
echo ========================================
echo   安装完成！
echo.
echo   启动方式：双击 start.bat
echo ========================================
echo.
pause
