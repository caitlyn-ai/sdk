# Checks install.ps1's minisign verifier (the cli:install-ps1 job, in PowerShell 7 on Linux): its inline C# is
# minisign-verify.cs, and it verifies exactly what minisign makes (testdata/minisign, from a real minisign: the
# default "ED" prehashed signature, and a legacy "Ed" one) and refuses a changed file, a changed trusted comment and
# another key.
#   pwsh -NoProfile -File cli/scripts/test-install-ps1.ps1
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$d = Join-Path $here 'testdata/minisign'
$installer = Join-Path $here 'install.ps1'

$text = Get-Content -Raw $installer
$start = $text.IndexOf("@'`n") + 3
$end = $text.IndexOf("`n'@", $start)
$inline = $text.Substring($start, $end - $start).TrimEnd("`n")
$file = (Get-Content -Raw (Join-Path $here 'minisign-verify.cs')).TrimEnd("`n")
if ($inline -ne $file) { throw 'install.ps1''s inline C# isn''t minisign-verify.cs: copy the file into it' }

if (Get-Command minisign -ErrorAction SilentlyContinue) { throw 'minisign is installed here, so the C# verifier would not be the one tested' }

function Pub($name) { (Get-Content (Join-Path $d "$name.pub"))[1].Trim() }
$cases = @(
  @{ Name = 'minisign''s own signature (ED, prehashed)'; Key = 'release'; File = 'manifest.json'; Want = 0 },
  @{ Name = 'a legacy signature (Ed)'; Key = 'legacy'; File = 'legacy.json'; Want = 0 },
  @{ Name = 'a changed manifest'; Key = 'release'; File = 'tampered.json'; Want = 1 },
  @{ Name = 'a changed trusted comment'; Key = 'release'; File = 'comment.json'; Want = 1 },
  @{ Name = 'another key'; Key = 'other'; File = 'manifest.json'; Want = 1 }
)
$failed = 0
foreach ($c in $cases) {
  $f = Join-Path $d $c.File
  pwsh -NoProfile -File $installer -VerifySignature (Pub $c.Key) -SignedFile $f -SignatureFile "$f.minisig" | Out-Null
  if ($LASTEXITCODE -ne $c.Want) { Write-Host "FAIL $($c.Name): exit $LASTEXITCODE, want $($c.Want)"; $failed++ } else { Write-Host "ok   $($c.Name)" }
}

# Run as `irm ... | iex`, the installer leaves the session as it found it: no StrictMode, no ErrorActionPreference
# and none of its variables (round 7, L8). A bad channel stops it early, before anything is downloaded.
$leak = pwsh -NoProfile -Command {
  param($installer)
  $ErrorActionPreference = 'Continue'
  $env:CAITLYN_CHANNEL = 'nope'
  try { Get-Content -Raw $installer | Invoke-Expression } catch { }
  $undefined = try { $null -eq $notDefinedAnywhere } catch { $false }
  "$ErrorActionPreference $undefined $(Test-Path variable:base) $(Test-Path variable:channel)"
} -args $installer
if ($leak -ne 'Continue True False False') { Write-Host "FAIL the installer leaks into the session: $leak"; $failed++ } else { Write-Host 'ok   the session is left as it was' }
if ($failed) { exit 1 }
