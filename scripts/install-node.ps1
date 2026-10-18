# Installs the latest official Node.js LTS release for Windows.
$ErrorActionPreference = 'Stop'
try {
    $arch = $env:PROCESSOR_ARCHITECTURE
    if ($env:PROCESSOR_ARCHITEW6432) { $arch = $env:PROCESSOR_ARCHITEW6432 }
    switch -Regex ($arch) {
        '^ARM64$' { $nodeArch = 'arm64'; break }
        '^AMD64$' { $nodeArch = 'x64'; break }
        default { $nodeArch = 'x86' }
    }

    Write-Host 'Finding the latest official Node.js LTS installer...'
    $releases = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json'
    $release = $releases | Where-Object { $_.lts -and [int](($_.version -replace '^v','').Split('.')[0]) -ge 20 } | Select-Object -First 1
    if (-not $release) { throw 'Could not find a supported Node.js LTS release.' }

    $version = $release.version
    $file = "node-$version-$nodeArch.msi"
    $url = "https://nodejs.org/dist/$version/$file"
    $installer = Join-Path $env:TEMP $file

    Write-Host "Downloading Node.js $version ($nodeArch)..."
    Invoke-WebRequest -Uri $url -OutFile $installer
    Write-Host 'Installing Node.js. Windows may ask for administrator permission...'
    $process = Start-Process -FilePath 'msiexec.exe' -ArgumentList ('/i "{0}" /passive /norestart' -f $installer) -Wait -PassThru
    if ($process.ExitCode -ne 0 -and $process.ExitCode -ne 3010) {
        throw "Node.js installer failed with exit code $($process.ExitCode)."
    }
    Remove-Item $installer -Force -ErrorAction SilentlyContinue
    Write-Host 'Node.js installation finished.'
    exit 0
}
catch {
    Write-Host "Automatic Node.js installation failed: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'Check your internet connection and Windows permissions, then try again.'
    exit 1
}