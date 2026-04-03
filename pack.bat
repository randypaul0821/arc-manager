@echo off
chcp 65001 >nul
title Arc Manager Pro - 打包交付
echo ========================================
echo   Arc Manager Pro - 生成交付包
echo ========================================
echo.

:: 设置输出路径
set "OUT_DIR=%~dp0release"
set "APP_DIR=%OUT_DIR%\ArcManagerPro"

:: 清理旧的交付目录
if exist "%OUT_DIR%" (
    echo 清理旧的交付目录...
    rmdir /s /q "%OUT_DIR%"
)
mkdir "%APP_DIR%"

:: 复制项目文件
echo 正在复制项目文件...

:: 核心 Python 文件
copy "%~dp0app.py"          "%APP_DIR%\" >nul
copy "%~dp0config.py"       "%APP_DIR%\" >nul
copy "%~dp0database.py"     "%APP_DIR%\" >nul
copy "%~dp0requirements.txt" "%APP_DIR%\" >nul

:: 数据库
copy "%~dp0arc_manager.db"  "%APP_DIR%\" >nul

:: 脚本
copy "%~dp0install.bat"     "%APP_DIR%\" >nul
copy "%~dp0start.bat"       "%APP_DIR%\" >nul

:: 目录
xcopy "%~dp0routes"              "%APP_DIR%\routes\"              /s /e /q >nul
xcopy "%~dp0services"            "%APP_DIR%\services\"            /s /e /q >nul
xcopy "%~dp0templates"           "%APP_DIR%\templates\"           /s /e /q >nul
xcopy "%~dp0static"              "%APP_DIR%\static\"              /s /e /q >nul
xcopy "%~dp0arcraiders-data-main" "%APP_DIR%\arcraiders-data-main\" /s /e /q >nul
xcopy "%~dp0custom_images"       "%APP_DIR%\custom_images\"       /s /e /q >nul
xcopy "%~dp0arctracker-extension" "%APP_DIR%\arctracker-extension\" /s /e /q >nul

echo.

:: 生成 zip
echo 正在压缩...
powershell -Command "Compress-Archive -Path '%APP_DIR%' -DestinationPath '%OUT_DIR%\ArcManagerPro.zip' -Force"
if errorlevel 1 (
    echo [错误] 压缩失败
    pause
    exit /b 1
)

:: 显示结果
echo.
echo ========================================
echo   交付包生成完成！
echo.
echo   ZIP 位置: release\ArcManagerPro.zip
echo.
echo   客户使用方式:
echo     1. 解压到任意位置
echo     2. 双击 install.bat（一键安装）
echo     3. 双击 start.bat（启动程序）
echo ========================================
echo.

:: 打开输出目录
explorer "%OUT_DIR%"
pause
