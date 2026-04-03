@echo off
chcp 65001 >nul
title Arc Manager Pro
echo ====================================
echo   Arc Raiders 仓库管理系统 启动中...
echo ====================================
echo.

:: 检查是否打包版本（exe 同目录）
if exist "%~dp0ArcManagerPro.exe" (
    start "" "http://localhost:5000"
    "%~dp0ArcManagerPro.exe"
    goto :end
)

:: 源码版本 — 检查虚拟环境，没有则自动安装
if not exist "%~dp0venv\Scripts\activate.bat" (
    echo 首次运行，需要安装环境...
    echo.
    call "%~dp0install.bat"
    if not exist "%~dp0venv\Scripts\activate.bat" (
        echo [错误] 安装失败，请检查上方错误信息
        pause
        exit /b 1
    )
)

:: 激活虚拟环境并启动
call "%~dp0venv\Scripts\activate.bat"
echo 浏览器打开: http://localhost:5000
start "" "http://localhost:5000"
python "%~dp0app.py"

:end
pause
