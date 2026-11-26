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
