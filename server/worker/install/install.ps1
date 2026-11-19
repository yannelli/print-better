# Print Better installer for Windows: $env:PB_TOKEN='pbe_...'; irm <origin>/install.ps1 | iex
# Also reads PB_NAME and PB_VERSION. Re-running upgrades in place and keeps the existing pairing.
& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $origin = '__PB_ORIGIN__'
  $token = $env:PB_TOKEN
  $name = $env:PB_NAME
  $version = $env:PB_VERSION

  $isArm = $env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64'
  if (-not [Environment]::Is64BitOperatingSystem) { throw 'Print Better needs 64-bit Windows.' }
  $platform = if ($isArm) { 'windows-aarch64' } else { 'windows-x86_64' }

  $manifestUrl = if ($version) { "$origin/dl/$version/manifest.json" } else { "$origin/dl/latest.json" }
  $manifest = Invoke-RestMethod -Uri $manifestUrl -UseBasicParsing
  $entry = $manifest.files.$platform
  if (-not $entry) { throw "This release has no build for $platform." }
  if ($entry.name -notmatch '^[A-Za-z0-9._-]+$' -or $entry.sha256 -notmatch '^[0-9a-fA-F]{64}$') { throw 'The release manifest is malformed.' }

  $dir = Join-Path $env:LOCALAPPDATA 'Print Better'
  $exe = Join-Path $dir 'printbetter.exe'
  $download = Join-Path $dir 'printbetter.download'
  New-Item -ItemType Directory -Force -Path $dir | Out-Null

  Write-Host "Downloading Print Better $($manifest.version) for $platform..."
  Invoke-WebRequest -Uri "$origin/dl/$($manifest.version)/$($entry.name)" -OutFile $download -UseBasicParsing
  $hash = (Get-FileHash -Algorithm SHA256 -Path $download).Hash
  if ($hash -ne $entry.sha256.ToUpperInvariant()) {
    Remove-Item -Force $download
    throw 'Download failed verification (SHA-256 mismatch).'
  }

  # The exe uses the GUI subsystem, so PowerShell would not wait for it or see its exit code without Start-Process.
  function Invoke-PrintBetter([string[]]$Arguments) {
    $quoted = $Arguments | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }
    $process = Start-Process -FilePath $exe -ArgumentList ($quoted -join ' ') -Wait -NoNewWindow -PassThru
    return $process.ExitCode
  }

  if (Test-Path $exe) {
    Invoke-PrintBetter @('service', 'stop') | Out-Null
    Get-Process -Name printbetter -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
  }
  Move-Item -Force -Path $download -Destination $exe
  Write-Host "Installed $exe"

  # pair succeeds when already paired with this server, so a failure is real: finish the install, then report it.
  $paired = $true
  if ($token) {
    $pairArgs = @('pair', '--server', $origin, '--token', $token)
    if ($name) { $pairArgs += @('--name', $name) }
    $paired = (Invoke-PrintBetter $pairArgs) -eq 0
  }

  if ((Invoke-PrintBetter @('service', 'install')) -ne 0) { throw 'Could not install the background service.' }
  if ((Invoke-PrintBetter @('service', 'start')) -ne 0) { throw 'Could not start the background service.' }
  if (-not $paired) { throw "Print Better $($manifest.version) is running but not paired (see the error above); re-run this command, or run: printbetter pair --server $origin" }
  Write-Host "Done: Print Better $($manifest.version) is running."
}
