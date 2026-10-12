@echo off
setlocal EnableExtensions
title CRAFTSYSTEM 1.0

fltmc >nul 2>&1
if errorlevel 1 (
    echo ERRO: execute este arquivo como Administrador.
    pause
    exit /b 1
)

:menu
cls
echo.
echo     .=============================================================.
echo     ^|                       CRAFTSYSTEM 1.0                     ^|
echo     ^|                 CONFIGURACAO DE FIREWALL IPv4             ^|
echo     '============================================================='
echo.
echo                    ==== CRAFTSYSTEM ==== 
echo.
echo     .=============================================================.
echo     ^|                     SELECIONE A OPCAO                   ^|
echo     '============================================================='
echo.
echo [1] Configuracao expressa
echo [2] Configuracao avancada
echo.
set /p "ESCOLHA=Digite a opcao desejada (1 ou 2): "

if "%ESCOLHA%"=="1" (
    set "IP_PERMITIDO=25.0.16.248"
    goto :configurar
)

if "%ESCOLHA%"=="2" (
    set /p "IP_PERMITIDO=Digite o IPv4 para liberar: "
    call :validar_ipv4 "%IP_PERMITIDO%"
    if errorlevel 1 (
        echo ERRO: IPv4 invalido: "%IP_PERMITIDO%"
        echo Tente novamente.
        pause
        goto :menu
    )
    goto :configurar
)

echo Opcao invalida.
goto :menu

:configurar
echo.
echo Liberando TCP para %IP_PERMITIDO% nas portas 80, 25565, 23333 e 24444...

for %%P in (80 25565 23333 24444) do (
    netsh advfirewall firewall delete rule name="Permitir IPv4 %IP_PERMITIDO% - %%P" >nul 2>&1
    netsh advfirewall firewall add rule name="Permitir IPv4 %IP_PERMITIDO% - %%P" dir=in action=allow protocol=TCP localport=%%P remoteip=%IP_PERMITIDO% profile=any
    if errorlevel 1 (
        echo ERRO ao liberar a porta %%P.
    ) else (
        echo Porta %%P liberada.
    )
)

echo.
echo Regras especificas criadas para %IP_PERMITIDO%.
pause
exit /b 0

:validar_ipv4
set "IP_PARA_VALIDAR=%~1"
powershell.exe -NoProfile -Command "$v=$env:IP_PARA_VALIDAR; $p=$null; if ($v -match '^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$' -and [Net.IPAddress]::TryParse($v,[ref]$p) -and $p.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetwork) { exit 0 } else { exit 1 }" >nul 2>&1
exit /b %errorlevel%
