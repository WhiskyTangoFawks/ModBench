using System.Text;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda;

namespace MEditService.PluginAdapter;

/// <summary>Kind B detectors (ADR-0006, a plugin malformed by another tool): byte-level
/// scans of the plugin's original bytes, with no Mutagen. Expected values come from vanilla
/// binaries, not a reference's comments.</summary>
internal static class MalformedPluginScan
{
    private const string Lossless = "repairable (lossless)";

    // xEdit's names for a perk entry point's function, the same in every game it defines.
    private static readonly Dictionary<byte, string> PerkFunctionNames = new()
    {
        [1] = "Set Value",
        [2] = "Add Value",
        [3] = "Multiply Value",
        [5] = "Add Actor Value Mult",
        [6] = "Absolute Value",
        [7] = "Negative Absolute Value",
        [9] = "Add Activate Choice",
        [10] = "Select Spell",
        [11] = "Select Text",
        [12] = "Set to Actor Value Mult",
        [13] = "Multiply Actor Value Mult",
        [14] = "Multiply 1 + Actor Value Mult",
        [15] = "Set Text",
    };

    /// <summary>Every Kind B diagnosis the plugin's own bytes prove, in record order. A record
    /// whose compressed payload cannot be inflated is skipped — an unreadable stream is a
    /// different failure than the classes this scan names.</summary>
    internal static List<PluginDiagnosis> Scan(byte[] pluginBytes, GameRelease gameRelease)
    {
        var shapes = GameCodecs.For(gameRelease).CreationKitShapes;
        var diagnoses = new List<PluginDiagnosis>();
        foreach (var record in PluginBinaryWalk.WalkRecords(pluginBytes))
        {
            if (record.IsGrup || !HasDetector(shapes, record.Type)) continue;

            byte[] data;
            try
            {
                data = pluginBytes.AsSpan(record.DataStart, Math.Min(record.DataLen, pluginBytes.Length - record.DataStart)).ToArray();
                if ((record.Flags & CompressedFlag.Bit) != 0) data = PluginBinaryWalk.Inflate(data);
            }
            catch (InvalidDataException)
            {
                continue;
            }

            var subrecords = PluginBinaryWalk.WalkSubrecords(data);
            var anchor = Anchor(record, data, subrecords);
            DetectFixedSize(shapes, record, subrecords, anchor, diagnoses);
            DetectFixedCount(shapes, record, subrecords, anchor, diagnoses);
            DetectCounterEntries(shapes, record, data, subrecords, anchor, diagnoses);
            DetectTemplateOrder(shapes, record, subrecords, anchor, diagnoses);
            DetectEntryPointShape(shapes.EntryPoints, record, data, subrecords, anchor, diagnoses);
        }
        return diagnoses;
    }

    private static bool HasDetector(CreationKitShapes shapes, string recordType) =>
        shapes.SubrecordSizes.Keys.Any(k => k.RecordType == recordType)
        || shapes.SubrecordCounts.Keys.Any(k => k.RecordType == recordType)
        || shapes.CountedEntries.Keys.Any(k => k.RecordType == recordType)
        || shapes.TemplateCombinations.Contains(recordType)
        || recordType == "PERK";

    private static void DetectFixedSize(
        CreationKitShapes shapes, PluginBinaryWalk.RecordSpan record, List<PluginBinaryWalk.SubrecordSpan> subrecords,
        string anchor, List<PluginDiagnosis> diagnoses)
    {
        foreach (var sub in subrecords)
        {
            if (!shapes.SubrecordSizes.TryGetValue((record.Type, sub.Sig), out var expected)) continue;
            var payload = sub.Len - 6;
            if (payload < expected)
            {
                diagnoses.Add(new PluginDiagnosis(anchor, "fixed-size-subrecord-short", Lossless,
                    $"{sub.Sig} is {payload} bytes; a {record.Type} {sub.Sig} is always {expected}"));
            }
        }
    }

    private static void DetectFixedCount(
        CreationKitShapes shapes, PluginBinaryWalk.RecordSpan record, List<PluginBinaryWalk.SubrecordSpan> subrecords,
        string anchor, List<PluginDiagnosis> diagnoses)
    {
        foreach (var ((recordType, sig), expected) in shapes.SubrecordCounts)
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
        CreationKitShapes shapes, PluginBinaryWalk.RecordSpan record, byte[] data, List<PluginBinaryWalk.SubrecordSpan> subrecords,
        string anchor, List<PluginDiagnosis> diagnoses)
    {
        for (var i = 0; i < subrecords.Count; i++)
        {
            if (!shapes.CountedEntries.TryGetValue((record.Type, subrecords[i].Sig), out var entrySig)) continue;
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

    // R1: combinations are written OBTF, FULL, OBTS after an optional bare leading OBTS; a trailing
    // OBTF/FULL with no closing OBTS is the defect.
    private static void DetectTemplateOrder(
        CreationKitShapes shapes, PluginBinaryWalk.RecordSpan record, List<PluginBinaryWalk.SubrecordSpan> subrecords,
        string anchor, List<PluginDiagnosis> diagnoses)
    {
        if (!shapes.TemplateCombinations.Contains(record.Type)) return;
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
        PerkEntryPointShapes shapes, PluginBinaryWalk.RecordSpan record, byte[] data, List<PluginBinaryWalk.SubrecordSpan> subrecords,
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
                // The drop operation removes the whole parameter block — EPFT, EPFB and EPFD — so
                // all three count toward the tail's byte cost.
                if (s.Sig is "EPFD" or "EPFB") parameterBytes += s.Len;
                if (s.Sig == "EPF3") hasEpf3 = true;
            }
            i = j;
            if (function == null) continue;
            var fn = function.Value;
            var name = PerkFunctionNames.GetValueOrDefault(fn, "Unknown");

            if (shapes.FunctionsWithoutParameters.Contains(fn) && epft != null)
            {
                diagnoses.Add(new PluginDiagnosis(anchor, "entry-point-parameter-shape",
                    $"repairable (drops {parameterBytes} bytes)",
                    $"entry point {entryIndex} (function {fn}, {name}) has EPFT {epft}; vanilla writes no parameters"));
            }
            else if (shapes.FunctionsCarryingEpf3.Contains(fn) && shapes.EpftByFunction.TryGetValue(fn, out var carrying)
                     && epft == carrying && !hasEpf3)
            {
                diagnoses.Add(new PluginDiagnosis(anchor, "entry-point-parameter-shape", Lossless,
                    $"entry point {entryIndex} (function {fn}, {name}) is missing EPF3; vanilla always writes it"));
            }
            else if (shapes.EpftByFunction.TryGetValue(fn, out var expected) && epft != null && epft != expected)
            {
                // Diagnose only — no repair tail: converting the parameter's
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
