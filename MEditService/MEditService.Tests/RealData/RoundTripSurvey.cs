using System.Buffers.Binary;
using System.Globalization;
using System.IO.Compression;
using System.Text;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Binary.Parameters;

namespace MEditService.Tests.RealData;

/// <summary>
/// #511 survey (2026-08-27): how far does a real, mixed-tool plugin population sit from
/// <c>write(parse(plugin)) == plugin</c>, and why? Deep-parses every mod-root plugin under
/// <c>MEDIT_SURVEY_MODS</c>, writes it back with the #506 header options, then walks both
/// binaries' record structures in parallel and classifies each differing record:
/// <c>header</c> (TES4 subrecord), <c>compressed-only</c> (decompressed payloads equal),
/// <c>negzero</c> (only -0.0 → +0.0 word changes), <c>grup-size</c> (derived group sizes), or
/// <c>other:TYPE/SIG</c> — the bucket that answers "what else is out there". Report: CSV per
/// plugin plus a category tally, at <c>MEDIT_SURVEY_OUT</c>. Gated like
/// <see cref="RealInstallSmokeTests"/>: never part of a normal run.
/// </summary>
public sealed class RoundTripSurvey
{
    private sealed class SurveyFactAttribute : FactAttribute
    {
        public SurveyFactAttribute()
        {
            if (Environment.GetEnvironmentVariable("MEDIT_SURVEY_MODS") == null)
                Skip = "Set MEDIT_SURVEY_MODS=<mods dir> (and MEDIT_SURVEY_OUT=<report path>) to run the round-trip survey.";
        }
    }

    [SurveyFact]
    public async Task SurveyEveryPluginInTheInstance()
    {
        var modsDir = Environment.GetEnvironmentVariable("MEDIT_SURVEY_MODS")!;
        var outPath = Environment.GetEnvironmentVariable("MEDIT_SURVEY_OUT") ?? "/tmp/medit-roundtrip-survey.csv";
        var plugins = Directory.EnumerateDirectories(modsDir)
            .SelectMany(d => Directory.EnumerateFiles(d, "*.es?", SearchOption.TopDirectoryOnly))
            .Where(f => f.EndsWith(".esp", StringComparison.OrdinalIgnoreCase) || f.EndsWith(".esm", StringComparison.OrdinalIgnoreCase) || f.EndsWith(".esl", StringComparison.OrdinalIgnoreCase))
            .OrderBy(f => new FileInfo(f).Length)
            .ToList();

        var rows = new List<string> { "plugin,mod,bytes,records,result,model,categories,detail" };
        var dumpPrefixes = (Environment.GetEnvironmentVariable("MEDIT_SURVEY_DUMP") ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries).ToList();
        var dumped = new HashSet<string>(StringComparer.Ordinal);
        var dump = new StringBuilder();
        var tally = new SortedDictionary<string, int>(StringComparer.Ordinal);
        var scratch = Directory.CreateTempSubdirectory("medit-survey-").FullName;
        var sw = System.Diagnostics.Stopwatch.StartNew();
        try
        {
            foreach (var path in plugins)
            {
                var name = Path.GetFileName(path);
                var mod = Path.GetFileName(Path.GetDirectoryName(path)!);
                var size = new FileInfo(path).Length;
                string result, categories = "", detail = "", model = "";
                int records = 0;
                try
                {
                    var original = await File.ReadAllBytesAsync(path);
                    var outFile = Path.Combine(scratch, name);
                    var parsed = Fallout4Mod.CreateFromBinary(new ModPath(ModKey.FromFileName(name), path), Fallout4Release.Fallout4);
                    records = parsed.EnumerateMajorRecords().Count();
                    await parsed.BeginWrite.ToPath(outFile)
                        .WithLoadOrderFromHeaderMasters()
                        .WithNoDataFolder()
                        .NoNextFormIDProcessing()
                        .WithRecordCount(RecordCountOption.NoCheck)
                        .WriteAsync();
                    var rewritten = await File.ReadAllBytesAsync(outFile);
                    // model identity: parse the rewrite and deep-compare every record (Mutagen's generated Equals)
                    try
                    {
                        var reparsed = Fallout4Mod.CreateFromBinary(new ModPath(ModKey.FromFileName(name), outFile), Fallout4Release.Fallout4);
                        var byKey = reparsed.EnumerateMajorRecords().ToDictionary(r => r.FormKey);
                        var unequalRecords = parsed.EnumerateMajorRecords()
                            .Where(r => !byKey.TryGetValue(r.FormKey, out var q) || !r.Equals(q)).ToList();
                        foreach (var r in unequalRecords)
                        {
                            var tn = r.GetType().Name;
                            if (!dumped.Add("model:" + tn) || !byKey.TryGetValue(r.FormKey, out var q)) continue;
                            dump.AppendLine(CultureInfo.InvariantCulture, $"===== MODEL {tn} :: {name} ({mod}) :: {r.FormKey}");
                            dump.AppendLine("  " + EqualsMaskFailures(r, q));
                        }
                        var unequal = unequalRecords.Select(r => r.GetType().Name).GroupBy(t => t).Select(g => $"{g.Key}x{g.Count()}").ToList();
                        model = unequal.Count == 0 ? "model-equal" : "model-differs:" + string.Join("+", unequal);
                        if (unequal.Count > 0) foreach (var u in unequal) tally["model-differs:" + u.Split('x')[0]] = tally.GetValueOrDefault("model-differs:" + u.Split('x')[0]) + 1;
                        tally[unequal.Count == 0 ? "_model-equal" : "_model-differs"] = tally.GetValueOrDefault(unequal.Count == 0 ? "_model-equal" : "_model-differs") + 1;
                    }
                    catch (Exception ex) { model = "model-reparse-error:" + ex.GetType().Name; tally["_model-reparse-error"] = tally.GetValueOrDefault("_model-reparse-error") + 1; }
                    File.Delete(outFile);

                    if (original.AsSpan().SequenceEqual(rewritten))
                    {
                        result = "identical";
                    }
                    else
                    {
                        var cats = Classify(original, rewritten);
                        foreach (var pfx in dumpPrefixes)
                        {
                            var hit = cats.Keys.FirstOrDefault(k => k.StartsWith(pfx, StringComparison.Ordinal));
                            if (hit == null || !dumped.Add(pfx)) continue;
                            dump.AppendLine(CultureInfo.InvariantCulture, $"===== {pfx} :: {name} ({mod}) :: {hit}");
                            DumpFirst(original, rewritten, hit, dump);
                        }
                        result = "differs";
                        categories = string.Join(";", cats.Select(kv => $"{kv.Key}={kv.Value}"));
                        detail = cats.Keys.FirstOrDefault(k => k.StartsWith("other:", StringComparison.Ordinal)) ?? "";
                        foreach (var k in cats.Keys) tally[k] = tally.GetValueOrDefault(k) + 1;
                    }
                }
                catch (Exception ex)
                {
                    result = "error";
                    detail = ex.GetType().Name + ": " + ex.Message.Split('\n')[0];
                    dump.AppendLine(CultureInfo.InvariantCulture, $"===== ERROR :: {name} ({mod})");
                    for (Exception? e = ex; e != null; e = e.InnerException) dump.AppendLine("  " + e.GetType().Name + ": " + e.Message.Replace('\n', ' '));
                    if (ex is AggregateException agg) foreach (var ie in agg.Flatten().InnerExceptions) dump.AppendLine("  * " + ie.GetType().Name + ": " + ie.Message.Replace('\n', ' '));
                    tally["error"] = tally.GetValueOrDefault("error") + 1;
                }
                tally[result == "differs" ? "_differs" : "_" + result] = tally.GetValueOrDefault(result == "differs" ? "_differs" : "_" + result) + 1;
                rows.Add(string.Join(",", Csv(name), Csv(mod), size.ToString(CultureInfo.InvariantCulture), records.ToString(CultureInfo.InvariantCulture), result, model, Csv(categories), Csv(detail)));
            }
        }
        finally
        {
            Directory.Delete(scratch, recursive: true);
        }

        rows.Add("");
        rows.Add($"# {plugins.Count} plugins in {sw.Elapsed:mm\\:ss}");
        foreach (var (k, v) in tally) rows.Add($"# {k},{v}");
        await File.WriteAllLinesAsync(outPath, rows);
        if (dump.Length > 0) await File.WriteAllTextAsync(outPath + ".dump.txt", dump.ToString());
    }

    /// <summary>Finds the first record whose classification matches <paramref name="category"/> and prints its differing
    /// subrecords as hex, original vs rewritten, both walked in parallel by signature.</summary>
    private static void DumpFirst(byte[] a, byte[] b, string category, StringBuilder o)
    {
        var ra = Walk(a); var rb = Walk(b);
        var n = Math.Min(ra.Count, rb.Count);
        var wantType = category.Contains(':') ? category.Split(':')[1].Split('/')[0].Split('(')[0] : "";
        for (int i = 0; i < n; i++)
        {
            var x = ra[i]; var y = rb[i];
            if (x.IsGrup || y.IsGrup) continue;
            if (x.Type != y.Type || x.FormId != y.FormId) { o.AppendLine(CultureInfo.InvariantCulture, $"  structure diverges at #{i}: {x.Type}:{x.FormId:X8} vs {y.Type}:{y.FormId:X8}"); return; }
            if (wantType.Length > 0 && x.Type != wantType) continue;
            var da = a.AsSpan(x.DataStart, Math.Min(x.DataLen, a.Length - x.DataStart)).ToArray();
            var db = b.AsSpan(y.DataStart, Math.Min(y.DataLen, b.Length - y.DataStart)).ToArray();
            var hdrEq = a.AsSpan(x.Start, 24).SequenceEqual(b.AsSpan(y.Start, 24));
            if (hdrEq && da.AsSpan().SequenceEqual(db)) continue;
            if ((x.Flags & CompressedFlag) != 0) { try { da = Inflate(da); db = Inflate(db); } catch (Exception) { o.AppendLine("  inflate failed"); return; } }
            o.AppendLine(CultureInfo.InvariantCulture, $"  {x.Type} {x.FormId:X8} flags {x.Flags:X8}->{y.Flags:X8}  hdr {Convert.ToHexString(a, x.Start, 24)} / {Convert.ToHexString(b, y.Start, 24)}");
            var sa = Subrecords(da); var sb = Subrecords(db);
            o.AppendLine(CultureInfo.InvariantCulture, $"  original order : {string.Join(" ", sa.Select(t => t.Sig))}");
            o.AppendLine(CultureInfo.InvariantCulture, $"  rewritten order: {string.Join(" ", sb.Select(t => t.Sig))}");
            var bySigA = sa.GroupBy(t => t.Sig).ToDictionary(g => g.Key, g => g.Select(t => da.AsSpan(t.Start, t.Len).ToArray()).ToList());
            var bySigB = sb.GroupBy(t => t.Sig).ToDictionary(g => g.Key, g => g.Select(t => db.AsSpan(t.Start, t.Len).ToArray()).ToList());
            foreach (var sig in bySigA.Keys.Union(bySigB.Keys))
            {
                var la = bySigA.GetValueOrDefault(sig) ?? []; var lb = bySigB.GetValueOrDefault(sig) ?? [];
                for (int k = 0; k < Math.Max(la.Count, lb.Count); k++)
                {
                    var ba = k < la.Count ? la[k] : null; var bb = k < lb.Count ? lb[k] : null;
                    if (ba != null && bb != null && ba.AsSpan().SequenceEqual(bb)) continue;
                    o.AppendLine(CultureInfo.InvariantCulture, $"    {sig}[{k}] orig: {(ba == null ? "<absent>" : Convert.ToHexString(ba, 0, Math.Min(ba.Length, 72)))}{(ba?.Length > 72 ? "…" : "")}");
                    o.AppendLine(CultureInfo.InvariantCulture, $"    {sig}[{k}] new : {(bb == null ? "<absent>" : Convert.ToHexString(bb, 0, Math.Min(bb.Length, 72)))}{(bb?.Length > 72 ? "…" : "")}");
                }
            }
            return;
        }
    }

    /// <summary>Mutagen's generated GetEqualsMask(rhs, Include.OnlyFailures), found by reflection on the record's
    /// getter interface, printed — names exactly which fields the generated Equals disagrees on.</summary>
    private static string EqualsMaskFailures(object lhs, object rhs)
    {
        try
        {
            // generated as an extension: <Type>MixIn.GetEqualsMask(this I<Type>Getter item, I<Type>Getter rhs, EqualsMaskHelper.Include include)
            var m = lhs.GetType().Assembly.GetTypes()
                .Where(t => t.IsAbstract && t.IsSealed && t.Name.EndsWith("MixIn", StringComparison.Ordinal))
                .SelectMany(t => t.GetMethods(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static))
                .Where(mi => mi.Name == "GetEqualsMask" && mi.GetParameters().Length == 3 && mi.GetParameters()[0].ParameterType.IsAssignableFrom(lhs.GetType()))
                .OrderByDescending(mi => mi.GetParameters()[0].ParameterType.GetInterfaces().Length)
                .FirstOrDefault();
            if (m == null) return "(no GetEqualsMask)";
            var include = Enum.Parse(m.GetParameters()[2].ParameterType, "OnlyFailures");
            var mask = m.Invoke(null, [lhs, rhs, include]);
            var lines = (mask?.ToString() ?? "(null mask)").Split('\n').Select(l => l.Trim()).Where(l => l.Contains("False", StringComparison.Ordinal)).ToList();
            var text = lines.Count == 0 ? "(no False entries in mask)" : string.Join(" | ", lines);
            return text.Length > 600 ? text[..600] + "…" : text;
        }
        catch (Exception ex) { return "(mask failed: " + ex.GetType().Name + ")"; }
    }

    private static string Csv(string s) => "\"" + s.Replace("\"", "\"\"") + "\"";

    // ---- structure walk -------------------------------------------------------------------

    private readonly record struct Rec(string Type, uint FormId, uint Flags, int Start, int DataStart, int DataLen, bool IsGrup);

    private const uint CompressedFlag = 0x00040000;

    private static List<Rec> Walk(byte[] b)
    {
        var list = new List<Rec>();
        int pos = 0;
        while (pos + 24 <= b.Length)
        {
            var type = Encoding.ASCII.GetString(b, pos, 4);
            var size = BinaryPrimitives.ReadUInt32LittleEndian(b.AsSpan(pos + 4));
            if (type == "GRUP")
            {
                list.Add(new Rec("GRUP", 0, 0, pos, pos + 24, 0, true));
                pos += 24; // descend: children follow inline
                continue;
            }
            var flags = BinaryPrimitives.ReadUInt32LittleEndian(b.AsSpan(pos + 8));
            var formId = BinaryPrimitives.ReadUInt32LittleEndian(b.AsSpan(pos + 12));
            list.Add(new Rec(type, formId, flags, pos, pos + 24, (int)size, false));
            pos += 24 + (int)size;
        }
        return list;
    }

    private static Dictionary<string, int> Classify(byte[] a, byte[] b)
    {
        var cats = new Dictionary<string, int>(StringComparer.Ordinal);
        void Add(string k) => cats[k] = cats.GetValueOrDefault(k) + 1;

        var ra = Walk(a);
        var rb = Walk(b);
        bool mastersPruned = false;
        if (ra.Count != rb.Count)
        {
            Add($"other:structure(records {ra.Count} vs {rb.Count})");
        }
        var n = Math.Min(ra.Count, rb.Count);
        for (int i = 0; i < n; i++)
        {
            var x = ra[i];
            var y = rb[i];
            if (x.IsGrup || y.IsGrup)
            {
                if (x.IsGrup != y.IsGrup) { Add("other:structure(grup misalign)"); break; }
                if (!a.AsSpan(x.Start, 24).SequenceEqual(b.AsSpan(y.Start, 24)))
                {
                    // size field (4..8) is derived from children; anything else is real
                    var hdrA = a.AsSpan(x.Start, 24).ToArray(); var hdrB = b.AsSpan(y.Start, 24).ToArray();
                    Array.Clear(hdrA, 4, 4); Array.Clear(hdrB, 4, 4);
                    Add(hdrA.AsSpan().SequenceEqual(hdrB) ? "grup-size" : "other:GRUP/header");
                }
                continue;
            }
            if (x.Type != y.Type || x.FormId != y.FormId)
            {
                Add(mastersPruned ? "formids-remapped(after masters-pruned; rest of plugin not compared)" : $"other:structure({x.Type}:{x.FormId:X8} vs {y.Type}:{y.FormId:X8})");
                break;
            }

            var hdrEq = a.AsSpan(x.Start, 24).SequenceEqual(b.AsSpan(y.Start, 24));
            var dataA = a.AsSpan(x.DataStart, Math.Min(x.DataLen, a.Length - x.DataStart));
            var dataB = b.AsSpan(y.DataStart, Math.Min(y.DataLen, b.Length - y.DataStart));
            if (hdrEq && dataA.SequenceEqual(dataB)) continue;

            if (x.Type == "TES4")
            {
                var rawA = dataA.ToArray(); var rawB = dataB.ToArray();
                var ha = Subrecords(rawA).Select(t => (t.Sig, Bytes: rawA.AsSpan(t.Start, t.Len).ToArray())).ToList();
                var hb = Subrecords(rawB).Select(t => (t.Sig, Bytes: rawB.AsSpan(t.Start, t.Len).ToArray())).ToList();
                var mastersA = ha.Count(t => t.Sig == "MAST"); var mastersB = hb.Count(t => t.Sig == "MAST");
                if (mastersA != mastersB) { Add($"header:masters-pruned({mastersA}->{mastersB})"); mastersPruned = true; }
                var removed = ha.Select(t => t.Sig).Except(hb.Select(t => t.Sig)).Where(sg => sg != "MAST" && sg != "DATA").ToList();
                if (removed.Count > 0) Add($"header:dropped-{string.Join("+", removed)}");
                var added = hb.Select(t => t.Sig).Except(ha.Select(t => t.Sig)).ToList();
                if (added.Count > 0) Add($"header:added-{string.Join("+", added)}");
                var changed = ha.Select(t => t.Sig).Intersect(hb.Select(t => t.Sig)).Where(sg => sg != "MAST" && sg != "DATA")
                    .Where(sg => !ha.Where(t => t.Sig == sg).Select(t => t.Bytes).SequenceEqual(hb.Where(t => t.Sig == sg).Select(t => t.Bytes), ByteArrayEq.Instance)).ToList();
                foreach (var sg in changed) Add($"header:{sg}");
                continue;
            }

            bool compA = (x.Flags & CompressedFlag) != 0, compB = (y.Flags & CompressedFlag) != 0;
            if (compA || compB)
            {
                if (compA != compB) { Add($"other:{x.Type}/compressed-flag"); continue; }
                byte[] pa, pb;
                try { pa = Inflate(dataA); pb = Inflate(dataB); }
                catch (Exception) { Add($"other:{x.Type}/inflate-failed"); continue; }
                if (pa.AsSpan().SequenceEqual(pb))
                {
                    // header may differ only in dataSize (bytes 4..8) — derived from the stream
                    var hdrA = a.AsSpan(x.Start, 24).ToArray(); var hdrB = b.AsSpan(y.Start, 24).ToArray();
                    Array.Clear(hdrA, 4, 4); Array.Clear(hdrB, 4, 4);
                    Add(hdrA.AsSpan().SequenceEqual(hdrB) ? "compressed-only" : $"other:{x.Type}/header+compressed");
                }
                else
                {
                    var sigs = DifferingSubrecords(pa, pb);
                    if (OnlyNegZero(pa, pb)) Add($"negzero:{x.Type}(compressed)");
                    else if (SameSubrecordsAnyOrder(pa, pb, out var od)) Add(od == null ? $"subrecord-order:{x.Type}(compressed)" : $"subrecord-order+content:{x.Type}/{od}(compressed)");
                    else Add($"other:{x.Type}/{string.Join("+", sigs)}(compressed)");
                }
                continue;
            }

            if (!hdrEq)
            {
                var ha24 = a.AsSpan(x.Start, 24); var hb24 = b.AsSpan(y.Start, 24);
                var fields = new List<string>();
                if (!ha24.Slice(4, 4).SequenceEqual(hb24.Slice(4, 4))) fields.Add("size");
                if (!ha24.Slice(8, 4).SequenceEqual(hb24.Slice(8, 4))) fields.Add($"flags({BinaryPrimitives.ReadUInt32LittleEndian(ha24.Slice(8)):X8}->{BinaryPrimitives.ReadUInt32LittleEndian(hb24.Slice(8)):X8})");
                if (!ha24.Slice(16, 4).SequenceEqual(hb24.Slice(16, 4))) fields.Add("vc-info");
                if (!ha24.Slice(20, 2).SequenceEqual(hb24.Slice(20, 2))) fields.Add($"form-version({BinaryPrimitives.ReadUInt16LittleEndian(ha24.Slice(20))}->{BinaryPrimitives.ReadUInt16LittleEndian(hb24.Slice(20))})");
                if (!ha24.Slice(22, 2).SequenceEqual(hb24.Slice(22, 2))) fields.Add("unknown2");
                Add(fields.Count == 1 && fields[0] == "size" ? $"record-size-only:{x.Type}" : $"other:{x.Type}/record-header[{string.Join("+", fields)}]");
            }
            if (!dataA.SequenceEqual(dataB))
            {
                var da = dataA.ToArray(); var db = dataB.ToArray();
                var sigs = DifferingSubrecords(da, db);
                if (dataA.Length == dataB.Length && OnlyNegZero(da, db))
                    Add($"negzero:{x.Type}/{string.Join("+", sigs)}");
                else if (SameSubrecordsAnyOrder(da, db, out var orderedDiff))
                    Add(orderedDiff == null ? $"subrecord-order:{x.Type}" : $"subrecord-order+content:{x.Type}/{orderedDiff}");
                else
                    Add($"other:{x.Type}/{string.Join("+", sigs)}");
            }
        }
        return cats;
    }

    private sealed class ByteArrayEq : IEqualityComparer<byte[]>
    {
        public static readonly ByteArrayEq Instance = new();
        public bool Equals(byte[]? x, byte[]? y) => x != null && y != null && x.AsSpan().SequenceEqual(y);
        public int GetHashCode(byte[] obj) => obj.Length;
    }

    /// <summary>True when both payloads hold the same subrecord signatures with the same multiplicity; <paramref name="contentDiff"/>
    /// is null when the (sig, bytes) multisets are identical too (pure reordering), else names the signatures whose bytes differ.</summary>
    private static bool SameSubrecordsAnyOrder(byte[] a, byte[] b, out string? contentDiff)
    {
        var sa = Subrecords(a).Select(t => (t.Sig, Bytes: a.AsSpan(t.Start, t.Len).ToArray())).OrderBy(t => t.Sig, StringComparer.Ordinal).ToList();
        var sb = Subrecords(b).Select(t => (t.Sig, Bytes: b.AsSpan(t.Start, t.Len).ToArray())).OrderBy(t => t.Sig, StringComparer.Ordinal).ToList();
        contentDiff = null;
        if (!sa.Select(t => t.Sig).SequenceEqual(sb.Select(t => t.Sig))) return false;
        var diff = sa.Zip(sb).Where(p => !p.First.Bytes.AsSpan().SequenceEqual(p.Second.Bytes)).Select(p => p.First.Sig).Distinct().ToList();
        if (diff.Count > 0) contentDiff = string.Join("+", diff);
        return true;
    }

    private static byte[] Inflate(ReadOnlySpan<byte> data)
    {
        // compressed record data = uint32 decompressed length + zlib stream
        using var input = new MemoryStream(data.Slice(4).ToArray());
        using var z = new ZLibStream(input, CompressionMode.Decompress);
        using var output = new MemoryStream();
        z.CopyTo(output);
        return output.ToArray();
    }

    /// <summary>Every differing 4-byte-aligned word is 0x80000000 in <paramref name="a"/> and 0 in <paramref name="b"/>.</summary>
    private static bool OnlyNegZero(byte[] a, byte[] b)
    {
        if (a.Length != b.Length) return false;
        int i = 0;
        while (i < a.Length)
        {
            if (a[i] == b[i]) { i++; continue; }
            // find the word: only pattern accepted is [00 00 00 80] -> [00 00 00 00], so the diff byte is the 4th
            if (i < 3 || a[i] != 0x80 || b[i] != 0x00) return false;
            if (!(a[i - 1] == 0 && a[i - 2] == 0 && a[i - 3] == 0 && b[i - 1] == 0 && b[i - 2] == 0 && b[i - 3] == 0)) return false;
            i++;
        }
        return true;
    }

    /// <summary>Signatures of subrecords whose bytes differ, walking both payloads in parallel; falls back
    /// to a positional label if the subrecord streams desynchronise.</summary>
    private static List<string> DifferingSubrecords(byte[] a, byte[] b)
    {
        var sa = Subrecords(a); var sb = Subrecords(b);
        var sigs = new List<string>();
        if (sa.Count != sb.Count) sigs.Add($"count{sa.Count}v{sb.Count}");
        var n = Math.Min(sa.Count, sb.Count);
        for (int i = 0; i < n; i++)
        {
            var (sigA, sA, lA) = sa[i]; var (sigB, sB, lB) = sb[i];
            if (sigA != sigB) { sigs.Add($"{sigA}v{sigB}"); break; }
            if (lA != lB || !a.AsSpan(sA, lA).SequenceEqual(b.AsSpan(sB, lB))) sigs.Add(sigA);
        }
        return sigs.Distinct().ToList();
    }

    private static List<(string Sig, int Start, int Len)> Subrecords(byte[] d)
    {
        var list = new List<(string, int, int)>();
        int pos = 0; int xxxx = -1;
        while (pos + 6 <= d.Length)
        {
            var sig = Encoding.ASCII.GetString(d, pos, 4);
            int len = BinaryPrimitives.ReadUInt16LittleEndian(d.AsSpan(pos + 4));
            if (sig == "XXXX") { xxxx = (int)BinaryPrimitives.ReadUInt32LittleEndian(d.AsSpan(pos + 6)); pos += 10; continue; }
            if (xxxx >= 0) { len = xxxx; xxxx = -1; }
            list.Add((sig, pos, Math.Min(6 + len, d.Length - pos)));
            pos += 6 + len;
        }
        return list;
    }
}
