using System.Text;

namespace MEditService.Codec.Serialization;

/// <summary>Kind B detectors (ADR-0006): byte-level scans naming a defect class from the plugin's
/// original bytes alone, with no Mutagen. Expected values come from vanilla binaries, not a
/// reference's comments.</summary>
public static class MalformedPluginScan
{
    private const uint CompressedFlag = 0x00040000;

    // (record type, subrecord) → the payload size the CK always writes; a shorter one is zero-padded, losslessly.
    private static readonly Dictionary<(string RecordType, string Sig), int> FixedSizeTable = new()
    {
        [("REGN", "RDAT")] = 8, // Type u32, Override u8, Priority u8, unused ×2
    };

    // (record type, subrecord) → the count the CK writes when it writes any; zero occurrences stays clean.
    private static readonly Dictionary<(string RecordType, string Sig), int> FixedCountTable = new()
    {
        [("RACE", "NAME")] = 32, // Biped Object Names — one per FO4 biped slot
    };

    // (record type, counter) → the entry subrecord its u32 counts; entries follow contiguously.
    private static readonly Dictionary<(string RecordType, string Counter), string> CounterTable = new()
    {
        [("REFR", "XWPG")] = "XWPN", // power-grid connections
    };

    private const string Lossless = "repairable (lossless)";

    // PERK entry-point function → the EPFT vanilla writes, proven over all 823 shipped entry-point
    // effects. Functions vanilla never exercises are absent; fn 6 writes no parameter block; fn 9 always
    // carries EPF3.
    private static readonly Dictionary<byte, byte> EpftByPerkFunction = new()
    {
        [1] = 1,
        [2] = 1,
        [3] = 1,
        [5] = 8,
        [9] = 4,
        [10] = 5,
        [12] = 8,
        [13] = 8,
        [14] = 8,
    };

    private static readonly Dictionary<byte, string> PerkFunctionNames = new()
    {
        [1] = "Set Value",
        [2] = "Add Value",
        [3] = "Multiply Value",
        [5] = "Add Actor Value Mult",
        [6] = "Absolute Value",
        [9] = "Add Activate Choice",
        [10] = "Select Spell",
        [12] = "Set to Actor Value Mult",
        [13] = "Multiply Actor Value Mult",
        [14] = "Multiply 1 + Actor Value Mult",
    };

    /// <summary>Every Kind B diagnosis the plugin's own bytes prove, in record order. A record
    /// whose compressed payload cannot be inflated is skipped — an unreadable stream is a
    /// different failure than the classes this scan names.</summary>
    public static List<PluginDiagnosis> Scan(byte[] pluginBytes)
    {
        var diagnoses = new List<PluginDiagnosis>();
        foreach (var record in PluginBinaryWalk.WalkRecords(pluginBytes))
        {
            if (record.IsGrup || !HasDetector(record.Type)) continue;

            byte[] data;
            try
            {
                data = pluginBytes.AsSpan(record.DataStart, Math.Min(record.DataLen, pluginBytes.Length - record.DataStart)).ToArray();
                if ((record.Flags & CompressedFlag) != 0) data = PluginBinaryWalk.Inflate(data);
            }
            catch (InvalidDataException)
            {
                continue;
            }

            var subrecords = PluginBinaryWalk.WalkSubrecords(data);
            var anchor = Anchor(record, data, subrecords);
            DetectFixedSize(record, subrecords, anchor, diagnoses);
            DetectFixedCount(record, subrecords, anchor, diagnoses);
            DetectCounterEntries(record, data, subrecords, anchor, diagnoses);
            DetectTemplateOrder(record, subrecords, anchor, diagnoses);
            DetectEntryPointShape(record, data, subrecords, anchor, diagnoses);
        }
        return diagnoses;
    }

    private static bool HasDetector(string recordType) =>
        FixedSizeTable.Keys.Any(k => k.RecordType == recordType)
        || FixedCountTable.Keys.Any(k => k.RecordType == recordType)
        || CounterTable.Keys.Any(k => k.RecordType == recordType)
        || recordType is "WEAP" or "PERK";

    private static void DetectFixedSize(
        PluginBinaryWalk.RecordSpan record, List<PluginBinaryWalk.SubrecordSpan> subrecords,
        string anchor, List<PluginDiagnosis> diagnoses)
    {
        foreach (var sub in subrecords)
        {
            if (!FixedSizeTable.TryGetValue((record.Type, sub.Sig), out var expected)) continue;
            var payload = sub.Len - 6;
            if (payload < expected)
            {
                diagnoses.Add(new PluginDiagnosis(anchor, "fixed-size-subrecord-short", Lossless,
                    $"{sub.Sig} is {payload} bytes; a {record.Type} {sub.Sig} is always {expected}"));
            }
        }
    }

    private static void DetectFixedCount(
        PluginBinaryWalk.RecordSpan record, List<PluginBinaryWalk.SubrecordSpan> subrecords,
        string anchor, List<PluginDiagnosis> diagnoses)
    {
        foreach (var ((recordType, sig), expected) in FixedCountTable)
        {
            if (recordType != record.Type) continue;
            var count = subrecords.Count(s => s.Sig == sig);
            if (count > 0 && count != expected)
            {
                diagnoses.Add(new PluginDiagnosis(anchor, "fixed-count-list-wrong-count", Lossless,
                    $"{sig} appears {count} times; the Creation Kit always writes {expected}"));
            }
        }
    }

    private static void DetectCounterEntries(
        PluginBinaryWalk.RecordSpan record, byte[] data, List<PluginBinaryWalk.SubrecordSpan> subrecords,
        string anchor, List<PluginDiagnosis> diagnoses)
    {
        for (var i = 0; i < subrecords.Count; i++)
        {
            if (!CounterTable.TryGetValue((record.Type, subrecords[i].Sig), out var entrySig)) continue;
            if (subrecords[i].Len - 6 < 4) continue; // a short counter is the fixed-size class's finding, not a count disagreement
            var declared = System.Buffers.Binary.BinaryPrimitives.ReadUInt32LittleEndian(
                data.AsSpan(subrecords[i].Start + 6, 4));
            var actual = 0;
            for (var j = i + 1; j < subrecords.Count && subrecords[j].Sig == entrySig; j++) actual++;
            if (actual != declared)
            {
                diagnoses.Add(new PluginDiagnosis(anchor, "counter-entries-mismatch", Lossless,
                    $"{subrecords[i].Sig} counts {declared}; {actual} {entrySig} entries follow"));
            }
        }
    }

    // R1: every vanilla WEAP template (1,031/1,031) writes combinations as OBTF, FULL, OBTS after an
    // optional bare leading OBTS; a trailing OBTF/FULL with no closing OBTS is the defect.
    private static void DetectTemplateOrder(
        PluginBinaryWalk.RecordSpan record, List<PluginBinaryWalk.SubrecordSpan> subrecords,
        string anchor, List<PluginDiagnosis> diagnoses)
    {
        if (record.Type != "WEAP") return;
        var start = subrecords.FindIndex(s => s.Sig == "OBTE");
        if (start < 0) return;
        var end = subrecords.FindIndex(start, s => s.Sig == "STOP");
        if (end < 0) end = subrecords.Count;
        var template = subrecords.Skip(start + 1).Take(end - start - 1).Select(s => s.Sig).ToList();

        var lastObts = template.LastIndexOf("OBTS");
        var lastDress = Math.Max(template.LastIndexOf("OBTF"), template.LastIndexOf("FULL"));
        if (lastDress >= 0 && lastDress > lastObts)
        {
            var closedGroups = CountClosedGroups(template);
            diagnoses.Add(new PluginDiagnosis(anchor, "subrecord-out-of-ck-order", Lossless,
                $"template combination {closedGroups}'s OBTS precedes its OBTF/FULL; the Creation Kit writes OBTF, FULL, OBTS"));
        }
    }

    // The index the dangling combination would have taken.
    private static int CountClosedGroups(List<string> template)
    {
        var closed = 0;
        var open = false;
        foreach (var sig in template)
        {
            if (sig is "OBTF" or "FULL") open = true;
            else if (sig == "OBTS" && open) { closed++; open = false; }
        }
        return closed;
    }

    // R5-R7: a PRKE with type byte 2 carries its function in the next DATA's second byte; the parameter
    // block until PRKF must match the vanilla-proven shape.
    private static void DetectEntryPointShape(
        PluginBinaryWalk.RecordSpan record, byte[] data, List<PluginBinaryWalk.SubrecordSpan> subrecords,
        string anchor, List<PluginDiagnosis> diagnoses)
    {
        if (record.Type != "PERK") return;
        var entryIndex = -1;
        var i = 0;
        while (i < subrecords.Count)
        {
            if (subrecords[i].Sig != "PRKE" || subrecords[i].Len < 7 || data[subrecords[i].Start + 6] != 2)
            {
                i++;
                continue;
            }
            entryIndex++;

            byte? function = null;
            byte? epft = null;
            var hasEpf3 = false;
            var parameterBytes = 0;
            var j = i + 1;
            for (; j < subrecords.Count && subrecords[j].Sig is not ("PRKF" or "PRKE"); j++)
            {
                var s = subrecords[j];
                if (s.Sig == "DATA" && function == null && s.Len >= 8) function = data[s.Start + 7];
                if (s.Sig == "EPFT" && s.Len >= 7) { epft = data[s.Start + 6]; parameterBytes += s.Len; }
                // The drop operation removes the whole parameter block — EPFT, EPFB and EPFD
                // (medit-repair.md R6), so all three count toward the tail's byte cost.
                if (s.Sig is "EPFD" or "EPFB") parameterBytes += s.Len;
                if (s.Sig == "EPF3") hasEpf3 = true;
            }
            i = j;
            if (function == null) continue;
            var fn = function.Value;
            var name = PerkFunctionNames.GetValueOrDefault(fn, "Unknown");

            if (fn == 6 && epft != null)
            {
                diagnoses.Add(new PluginDiagnosis(anchor, "entry-point-parameter-shape",
                    $"repairable (drops {parameterBytes} bytes)",
                    $"entry point {entryIndex} (function {fn}, {name}) has EPFT {epft}; vanilla writes no parameters"));
            }
            else if (fn == 9 && epft == 4 && !hasEpf3)
            {
                diagnoses.Add(new PluginDiagnosis(anchor, "entry-point-parameter-shape", Lossless,
                    $"entry point {entryIndex} (function {fn}, {name}) is missing EPF3; vanilla always writes it"));
            }
            else if (EpftByPerkFunction.TryGetValue(fn, out var expected) && epft != null && epft != expected)
            {
                // Diagnose only — no repair tail (medit-repair.md R7): converting the parameter's
                // value between EPFT encodings (an AV index to an AVIF FormKey) is a semantic
                // mapping, not one of the engine's byte operations.
                diagnoses.Add(new PluginDiagnosis(anchor, "entry-point-parameter-shape", Tail: null,
                    $"entry point {entryIndex} (function {fn}, {name}) has EPFT {epft}; vanilla writes EPFT {expected}"));
            }
        }
    }

    private static string Anchor(PluginBinaryWalk.RecordSpan record, byte[] data, List<PluginBinaryWalk.SubrecordSpan> subrecords)
    {
        var edid = subrecords.FirstOrDefault(s => s.Sig == "EDID");
        var name = edid.Sig == "EDID" && edid.Len > 6
            ? Encoding.UTF8.GetString(data, edid.Start + 6, edid.Len - 6).TrimEnd('\0')
            : null;
        return $"{record.Type} {record.FormId:X8}{(name != null ? $" ({name})" : "")}";
    }
}
