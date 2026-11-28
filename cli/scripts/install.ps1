# Installs the Caitlyn CLI on Windows (the CLI design, 8.4).
#
#   irm https://build.caitlyn.ai/releases/cli/install.ps1 | iex
#
# It reads the channel's pointer and the release manifest from build.caitlyn.ai/releases/cli, checks the manifest's minisign
# signature with Caitlyn's release key (with minisign when it is installed, else with the verifier below, which
# needs nothing installed), downloads the archive for this machine, checks its size and SHA-256 against the manifest, installs
# caitlyn.exe, adds its folder to your PATH, and writes %USERPROFILE%\.caitlyn\install.json so `caitlyn update` knows
# it may update itself.
#
# Settings, all optional: CAITLYN_INSTALL_VERSION, CAITLYN_CHANNEL (stable or beta), CAITLYN_INSTALL_DIR (default
# %LOCALAPPDATA%\Programs\caitlyn), CAITLYN_CONFIG_DIR (default %USERPROFILE%\.caitlyn), CAITLYN_BASE_URL, and
# CAITLYN_REQUIRE_SIGNATURE=1 to stop when the signature can't be checked rather than rely on the checksum.
param([string] $VerifySignature, [string] $SignedFile, [string] $SignatureFile)
# Everything runs in a script block of its own, so StrictMode, ErrorActionPreference and the variables below don't
# outlive the install in the session that ran `irm ... | iex`.
& {
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3

# minisign-verify.cs, verbatim (the cli:install-ps1 job checks it is): Ed25519 and BLAKE2b-512 for minisign's signatures
$minisignVerifySource = @'
// Minisign signature verification in C#, for install.ps1 on a machine without minisign: Windows has no Ed25519 or
// BLAKE2b of its own before .NET 10, so both are here, written for C# 5 so Windows PowerShell 5.1's
// Add-Type compiles it as PowerShell 7's does. install.ps1 carries this file's text inline; the SDK repository's
// cli:install-ps1 job checks the two are the same and runs both against real minisign signatures.
//
// Verify(publicKey, file, signatureFile) checks a signature as `minisign -V` does: the key IDs match; the signature is
// Ed25519 over the file ("Ed", legacy) or over its BLAKE2b-512 hash ("ED", what minisign makes by default); and the
// global signature covers the signature and the trusted comment.
using System;
using System.IO;
using System.Linq;
using System.Numerics;
using System.Security.Cryptography;
using System.Text;

public static class CaitlynMinisign
{
    public static bool Verify(string publicKeyBase64, string file, string signatureFile)
    {
        byte[] pk = Convert.FromBase64String(publicKeyBase64.Trim());
        string[] lines = File.ReadAllText(signatureFile).Replace("\r", "").Split('\n');
        if (lines.Length < 4 || !lines[2].StartsWith("trusted comment: ")) return false;
        byte[] sig = Convert.FromBase64String(lines[1].Trim());
        byte[] global = Convert.FromBase64String(lines[3].Trim());
        if (pk.Length != 42 || sig.Length != 74 || global.Length != 64) return false;
        if (pk[0] != (byte)'E' || pk[1] != (byte)'d') return false;
        for (int i = 2; i < 10; i++) if (pk[i] != sig[i]) return false;
        byte[] key = pk.Skip(10).ToArray();
        byte[] ed = sig.Skip(10).ToArray();
        byte[] message = File.ReadAllBytes(file);
        if (sig[0] == (byte)'E' && sig[1] == (byte)'D') message = Blake2b512(message);
        else if (!(sig[0] == (byte)'E' && sig[1] == (byte)'d')) return false;
        if (!Ed25519Verify(key, message, ed)) return false;
        byte[] comment = Encoding.UTF8.GetBytes(lines[2].Substring("trusted comment: ".Length));
        return Ed25519Verify(key, ed.Concat(comment).ToArray(), global);
    }

    // ---- BLAKE2b-512 (RFC 7693), unkeyed ----

    static readonly ulong[] IV = {
        0x6a09e667f3bcc908UL, 0xbb67ae8584caa73bUL, 0x3c6ef372fe94f82bUL, 0xa54ff53a5f1d36f1UL,
        0x510e527fade682d1UL, 0x9b05688c2b3e6c1fUL, 0x1f83d9abfb41bd6bUL, 0x5be0cd19137e2179UL };
    static readonly int[,] Sigma = {
        { 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15 }, { 14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3 },
        { 11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4 }, { 7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8 },
        { 9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13 }, { 2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9 },
        { 12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11 }, { 13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10 },
        { 6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5 }, { 10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0 } };

    static ulong Rotr(ulong x, int n) { return (x >> n) | (x << (64 - n)); }

    static void G(ulong[] v, int a, int b, int c, int d, ulong x, ulong y)
    {
        v[a] = v[a] + v[b] + x; v[d] = Rotr(v[d] ^ v[a], 32);
        v[c] = v[c] + v[d]; v[b] = Rotr(v[b] ^ v[c], 24);
        v[a] = v[a] + v[b] + y; v[d] = Rotr(v[d] ^ v[a], 16);
        v[c] = v[c] + v[d]; v[b] = Rotr(v[b] ^ v[c], 63);
    }

    static void Compress(ulong[] h, byte[] block, ulong t, bool last)
    {
        ulong[] m = new ulong[16];
        for (int i = 0; i < 16; i++) m[i] = BitConverter.ToUInt64(block, i * 8);
        ulong[] v = new ulong[16];
        for (int i = 0; i < 8; i++) { v[i] = h[i]; v[i + 8] = IV[i]; }
        v[12] ^= t;
        if (last) v[14] = ~v[14];
        for (int r = 0; r < 12; r++)
        {
            int s = r % 10;
            G(v, 0, 4, 8, 12, m[Sigma[s, 0]], m[Sigma[s, 1]]);
            G(v, 1, 5, 9, 13, m[Sigma[s, 2]], m[Sigma[s, 3]]);
            G(v, 2, 6, 10, 14, m[Sigma[s, 4]], m[Sigma[s, 5]]);
            G(v, 3, 7, 11, 15, m[Sigma[s, 6]], m[Sigma[s, 7]]);
            G(v, 0, 5, 10, 15, m[Sigma[s, 8]], m[Sigma[s, 9]]);
            G(v, 1, 6, 11, 12, m[Sigma[s, 10]], m[Sigma[s, 11]]);
            G(v, 2, 7, 8, 13, m[Sigma[s, 12]], m[Sigma[s, 13]]);
            G(v, 3, 4, 9, 14, m[Sigma[s, 14]], m[Sigma[s, 15]]);
        }
        for (int i = 0; i < 8; i++) h[i] ^= v[i] ^ v[i + 8];
    }

    public static byte[] Blake2b512(byte[] data)
    {
        if (!BitConverter.IsLittleEndian) throw new PlatformNotSupportedException();
        ulong[] h = (ulong[])IV.Clone();
        h[0] ^= 0x01010000UL ^ 64UL;
        int offset = 0;
        ulong t = 0;
        while (data.Length - offset > 128)
        {
            byte[] block = new byte[128];
            Array.Copy(data, offset, block, 0, 128);
            t += 128;
            Compress(h, block, t, false);
            offset += 128;
        }
        byte[] lastBlock = new byte[128];
        Array.Copy(data, offset, lastBlock, 0, data.Length - offset);
        t += (ulong)(data.Length - offset);
        Compress(h, lastBlock, t, true);
        byte[] output = new byte[64];
        for (int i = 0; i < 8; i++) Array.Copy(BitConverter.GetBytes(h[i]), 0, output, i * 8, 8);
        return output;
    }

    // ---- Ed25519 verification (RFC 8032), on affine points: slow, and only ever given public data ----

    static readonly BigInteger P = BigInteger.Pow(2, 255) - 19;
    static readonly BigInteger L = BigInteger.Pow(2, 252) + BigInteger.Parse("27742317777372353535851937790883648493");
    static readonly BigInteger D = Mod(-121665 * Inv(121666));
    static readonly BigInteger I = BigInteger.ModPow(2, (P - 1) / 4, P);

    static BigInteger Mod(BigInteger x) { BigInteger r = x % P; return r < 0 ? r + P : r; }
    static BigInteger Inv(BigInteger x) { return BigInteger.ModPow(Mod(x), P - 2, P); }

    static BigInteger[] Add(BigInteger[] a, BigInteger[] b)
    {
        BigInteger t = Mod(D * a[0] * b[0] * a[1] * b[1]);
        BigInteger x = Mod((a[0] * b[1] + a[1] * b[0]) * Inv(1 + t));
        BigInteger y = Mod((a[1] * b[1] + a[0] * b[0]) * Inv(1 - t));
        return new BigInteger[] { x, y };
    }

    static BigInteger[] Mul(BigInteger[] point, BigInteger n)
    {
        BigInteger[] result = new BigInteger[] { 0, 1 };
        BigInteger[] add = point;
        while (n > 0)
        {
            if (!n.IsEven) result = Add(result, add);
            add = Add(add, add);
            n >>= 1;
        }
        return result;
    }

    static BigInteger FromLittleEndian(byte[] b)
    {
        byte[] unsigned = new byte[b.Length + 1];
        Array.Copy(b, unsigned, b.Length);
        return new BigInteger(unsigned);
    }

    static byte[] Encode(BigInteger[] point)
    {
        byte[] y = point[1].ToByteArray();
        byte[] out32 = new byte[32];
        Array.Copy(y, out32, Math.Min(y.Length, 32));
        if (!point[0].IsEven) out32[31] |= 0x80;
        return out32;
    }

    static BigInteger[] Decode(byte[] s)
    {
        if (s.Length != 32) return null;
        byte[] copy = (byte[])s.Clone();
        bool sign = (copy[31] & 0x80) != 0;
        copy[31] &= 0x7f;
        BigInteger y = FromLittleEndian(copy);
        if (y >= P) return null;
        BigInteger y2 = Mod(y * y);
        BigInteger x2 = Mod((y2 - 1) * Inv(D * y2 + 1));
        BigInteger x = BigInteger.ModPow(x2, (P + 3) / 8, P);
        if (Mod(x * x - x2) != 0) x = Mod(x * I);
        if (Mod(x * x - x2) != 0) return null;
        if (x == 0 && sign) return null;
        if ((!x.IsEven) != sign) x = P - x;
        return new BigInteger[] { x, y };
    }

    static readonly BigInteger[] B = Decode(BaseEncoding());

    static byte[] BaseEncoding()
    {
        // The base point: y = 4/5, x even
        BigInteger y = Mod(4 * BigInteger.ModPow(5, P - 2, P));
        byte[] yb = y.ToByteArray();
        byte[] out32 = new byte[32];
        Array.Copy(yb, out32, Math.Min(yb.Length, 32));
        return out32;
    }

    public static bool Ed25519Verify(byte[] publicKey, byte[] message, byte[] signature)
    {
        if (publicKey.Length != 32 || signature.Length != 64) return false;
        BigInteger[] a = Decode(publicKey);
        if (a == null) return false;
        byte[] r = signature.Take(32).ToArray();
        BigInteger s = FromLittleEndian(signature.Skip(32).ToArray());
        if (s >= L) return false;
        byte[] hash;
        using (SHA512 sha = SHA512.Create()) hash = sha.ComputeHash(r.Concat(publicKey).Concat(message).ToArray());
        BigInteger h = FromLittleEndian(hash) % L;
        // [s]B = R + [h]A, checked as the encoding of [s]B - [h]A against R
        BigInteger[] ha = Mul(a, h);
        BigInteger[] minusHa = new BigInteger[] { Mod(-ha[0]), ha[1] };
        return Encode(Add(Mul(B, s), minusHa)).SequenceEqual(r);
    }
}
'@

# Test-Minisign checks a minisign signature as `minisign -V` does, with minisign when it is here, else with the C#
# above. $true verified; $false refused.
function Test-Minisign([string] $PublicKey, [string] $File, [string] $Signature) {
  $minisign = Get-Command minisign -ErrorAction SilentlyContinue
  if ($minisign) {
    & $minisign.Source -Vqm $File -x $Signature -P $PublicKey | Out-Null
    return ($LASTEXITCODE -eq 0)
  }
  if (-not ('CaitlynMinisign' -as [type])) {
    $refs = if ($PSVersionTable.PSEdition -eq 'Core') { @('System.Runtime.Numerics', 'System.Security.Cryptography', 'System.Linq', 'System.Text.Encoding.Extensions') } else { @('System.Numerics', 'System.Core') }
    Add-Type -TypeDefinition $minisignVerifySource -Language CSharp -ReferencedAssemblies $refs
  }
  try { return [CaitlynMinisign]::Verify($PublicKey, $File, $Signature) } catch { return $false }
}

# For tests: check a signature and say so, without installing anything
# (install.ps1 -VerifySignature <public key> -SignedFile <file> -SignatureFile <file.minisig>)
if ($VerifySignature) {
  if (Test-Minisign $VerifySignature $SignedFile $SignatureFile) { 'verified'; exit 0 } else { 'not verified'; exit 1 }
}

$base = if ($env:CAITLYN_BASE_URL) { $env:CAITLYN_BASE_URL } else { 'https://build.caitlyn.ai/releases/cli/' }
if (-not $base.EndsWith('/')) { $base += '/' }
$channel = if ($env:CAITLYN_CHANNEL) { $env:CAITLYN_CHANNEL } else { 'stable' }
$dir = if ($env:CAITLYN_INSTALL_DIR) { $env:CAITLYN_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\caitlyn' }
$config = if ($env:CAITLYN_CONFIG_DIR) { $env:CAITLYN_CONFIG_DIR } else { Join-Path $HOME '.caitlyn' }
# The manifest signing key's public half, filled in when the release job publishes this script.
$pubkey = '__MINISIGN_PUBLIC_KEY__'

function Fail($message) { throw "caitlyn install: $message" }

if ($channel -notin @('stable', 'beta')) { Fail "CAITLYN_CHANNEL must be stable or beta, not $channel" }
$arch = switch ($env:PROCESSOR_ARCHITECTURE) {
  'AMD64' { 'amd64' }
  'ARM64' { 'arm64' }
  default { Fail "there is no build for $($env:PROCESSOR_ARCHITECTURE)" }
}
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("caitlyn-install-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  if ($env:CAITLYN_INSTALL_VERSION) {
    $version = $env:CAITLYN_INSTALL_VERSION.TrimStart('v')
    $manifestPath = "$version/manifest.json"
  } else {
    $pointer = Invoke-RestMethod -UseBasicParsing "$($base)channels/$channel.json"
    $version = $pointer.version
    $manifestPath = if ($pointer.PSObject.Properties['manifest'] -and $pointer.manifest) { $pointer.manifest } else { "$version/manifest.json" }
    # The stable channel never points at a prerelease
    if ($channel -eq 'stable' -and "$version".Contains('-')) { Fail "the stable channel points at $version, a prerelease" }
  }
  if (-not $version -or $version -notmatch '^[0-9A-Za-z.+-]+$' -or $version.StartsWith('.') -or $version.Contains('..')) { Fail "the $channel channel names no valid version" }
  # The manifest is the version's own, at <version>/manifest.json: never a path elsewhere on the host
  if ($manifestPath -ne "$version/manifest.json") { Fail "the $channel channel names $manifestPath, not $version's manifest" }
  # A release's own channel: a prerelease is beta, anything else stable
  $releaseChannel = if ($version.Contains('-')) { 'beta' } else { 'stable' }

  $manifestFile = Join-Path $tmp 'manifest.json'
  Invoke-WebRequest -UseBasicParsing "$base$manifestPath" -OutFile $manifestFile

  # The signature, then the checksum below.
  # (The placeholder is spelt in two parts here, so the publisher's substitution leaves this comparison alone.)
  if ($pubkey -eq ('__MINISIGN_' + 'PUBLIC_KEY__')) {
    $why = 'this installer carries no release key (it wasn''t published by a release)'
    if ($env:CAITLYN_REQUIRE_SIGNATURE -eq '1') { Fail "$why, and CAITLYN_REQUIRE_SIGNATURE=1: nothing was installed" }
    Write-Warning "$why, so only its SHA-256 and HTTPS protect this download."
  } else {
    $sig = Join-Path $tmp 'manifest.json.minisig'
    Invoke-WebRequest -UseBasicParsing "$base$manifestPath.minisig" -OutFile $sig
    if (-not (Test-Minisign $pubkey $manifestFile $sig)) { Fail "the manifest's signature doesn't match Caitlyn's key: nothing was installed" }
    Write-Host 'Verified the release''s signature.'
  }

  $manifest = Get-Content -Raw $manifestFile | ConvertFrom-Json
  # The signed manifest is the release asked for: a validly signed manifest of another version or channel is refused
  if ($manifest.version -ne $version) { Fail "the manifest is for $($manifest.version), not $($version): nothing was installed" }
  if ($manifest.channel -ne $releaseChannel) { Fail "the manifest is for the $($manifest.channel) channel, but $version is a $releaseChannel release: nothing was installed" }
  $platform = $manifest.platforms | Where-Object { $_.os -eq 'windows' -and $_.arch -eq $arch } | Select-Object -First 1
  if (-not $platform) { Fail "release $version has no build for windows/$arch" }
  $url = $platform.url
  if ($url -notmatch '^https://') {
    if ($url -match '[/\\]|\.\.') { Fail "the manifest's archive name $url isn't one" }
    $url = "$($base)$version/$url"
  }

  Write-Host "Downloading caitlyn $version for windows/$arch..."
  $zip = Join-Path $tmp 'caitlyn.zip'
  Invoke-WebRequest -UseBasicParsing $url -OutFile $zip
  $size = (Get-Item $zip).Length
  if ($size -ne [int64]$platform.size) { Fail "the archive is $size bytes, but the manifest says $($platform.size): nothing was installed" }
  $hash = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLowerInvariant()
  if ($hash -ne $platform.sha256.ToLowerInvariant()) { Fail "the archive's SHA-256 doesn't match the manifest: nothing was installed" }

  $unpacked = Join-Path $tmp 'unpacked'
  Expand-Archive -Path $zip -DestinationPath $unpacked
  $exe = Join-Path $unpacked 'caitlyn.exe'
  if (-not (Test-Path $exe)) { Fail 'the archive has no caitlyn.exe' }
  # It must start here; its version --json also says how mature the CLI is (preview, or stable)
  $info = & $exe version --json
  if ($LASTEXITCODE -ne 0) { Fail 'the downloaded binary doesn''t start on this machine' }
  $stability = ''
  try { $stability = [string](($info | Out-String) | ConvertFrom-Json).stability } catch { $stability = '' }

  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $target = Join-Path $dir 'caitlyn.exe'
  if (Test-Path $target) {
    # A running caitlyn.exe can't be replaced, but it can be renamed; caitlyn deletes the .old file on its next run.
    Copy-Item -Force $target (Join-Path $dir 'caitlyn.previous.exe')
    Move-Item -Force $target "$target.old"
  }
  Move-Item -Force $exe $target

  New-Item -ItemType Directory -Force -Path $config | Out-Null
  $receipt = [ordered]@{ method = 'script'; path = $target; channel = $channel; version = $version; installed = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') }
  $receipt | ConvertTo-Json -Compress | Set-Content -Encoding UTF8 (Join-Path $config 'install.json')

  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not $userPath) { $userPath = '' }
  if (($userPath -split ';') -notcontains $dir) {
    [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ";$dir").TrimStart(';'), 'User')
    $env:Path += ";$dir"
    Write-Host "Added $dir to your PATH; open a new terminal to use it."
  }
  Write-Host "Installed caitlyn $version to $target."
  if ($stability -and $stability -ne 'stable') { Write-Host "The Caitlyn CLI is in ${stability}: its commands, flags and output may still change." }
  Write-Host 'Get started: caitlyn auth login'
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
}
