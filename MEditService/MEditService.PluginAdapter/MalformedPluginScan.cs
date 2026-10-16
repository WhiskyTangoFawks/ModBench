using System.Buffers.Binary;
using System.Text;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Binary.Headers;

namespace MEditService.PluginAdapter;

/// <summary>Kind B detectors (ADR-0006, a plugin malformed by another tool): scans of the
/// plugin's original subrecords, free of Mutagen's typed parse. Expected values come from vanilla
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

    /// <summary>Every Kind B diagnosis the plugin's own bytes prove, in record order.</summary>
    internal static List<PluginDiagnosis> Scan(byte[] pluginBytes, GameRelease gameRelease)
    {
        var shapes = GameCodecs.For(gameRelease).CreationKitShapes;
        var diagnoses = new List<PluginDiagnosis>();
        foreach (var record in PluginBinaryWalk.Records(pluginBytes, gameRelease))
        {
            var type = record.RecordType.Type;
            if (!HasDetector(shapes, type) || PluginBinaryWalk.Subrecords(record) is not { } subrecords) continue;

            var anchor = Anchor(type, record.FormID.Raw, subrecords);
            DetectFixedSize(shapes, type, subrecords, anchor, diagnoses);
            DetectFixedCount(shapes, type, subrecords, anchor, diagnoses);
            DetectCounterEntries(shapes, type, subrecords, anchor, diagnoses);
            DetectTemplateOrder(shapes, type, subrecords, anchor, diagnoses);
            DetectEntryPointShape(shapes.EntryPoints, type, subrecords, anchor, diagnoses);
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
        CreationKitShapes shapes, string recordType, List<SubrecordPinFrame> subrecords,
        string anchor, List<PluginDiagnosis> diagnoses)
    {
        foreach (var sub in subrecords)
        {
            var sig = sub.RecordType.Type;
            if (!shapes.SubrecordSizes.TryGetValue((recordType, sig), out var expected)) continue;
            if (sub.ContentLength < expected)
            {
                diagnoses.Add(new PluginDiagnosis(anchor, "fixed-size-subrecord-short", Lossless,
                    $"{sig} is {sub.ContentLength} bytes; a {recordType} {sig} is always {expected}"));
            }
        }
    }

    private static void DetectFixedCount(
        CreationKitShapes shapes, string recordType, List<SubrecordPinFrame> subrecords,
        string anchor, List<PluginDiagnosis> diagnoses)
    {
        foreach (var ((type, sig), expected) in shapes.SubrecordCounts)
        {
            if (type != recordType) continue;
            var count = subrecords.Count(s => s.RecordType.Type == sig);
            if (count > 0 && count != expected)
            {
                diagnoses.Add(new PluginDiagnosis(anchor, "fixed-count-list-wrong-count", Lossless,
                    $"{sig} appears {count} times; the Creation Kit always writes {expected}"));
            }
        }
    }

    private static void DetectCounterEntries(
        CreationKitShapes shapes, string recordType, List<SubrecordPinFrame> subrecords,
        string anchor, List<PluginDiagnosis> diagnoses)
    {
        for (var i = 0; i < subrecords.Count; i++)
        {
            var counter = subrecords[i];
            if (!shapes.CountedEntries.TryGetValue((recordType, counter.RecordType.Type), out var entrySig)) continue;
            if (counter.ContentLength < 4) continue; // a short counter is the fixed-size class's finding, not a count disagreement
            var declared = BinaryPrimitives.ReadUInt32LittleEndian(counter.Content.Span);
            var actual = 0;
            for (var j = i + 1; j < subrecords.Count && subrecords[j].RecordType.Type == entrySig; j++) actual++;
            if (actual != declared)
            {
                diagnoses.Add(new PluginDiagnosis(anchor, "counter-entries-mismatch", Lossless,
                    $"{counter.RecordType.Type} counts {declared}; {actual} {entrySig} entries follow"));
            }
        }
    }

    // R1: combinations are written OBTF, FULL, OBTS after an optional bare leading OBTS; a trailing
    // OBTF/FULL with no closing OBTS is the defect.
    private static void DetectTemplateOrder(
        CreationKitShapes shapes, string recordType, List<SubrecordPinFrame> subrecords,
        string anchor, List<PluginDiagnosis> diagnoses)
    {
        if (!shapes.TemplateCombinations.Contains(recordType)) return;
        var signatures = subrecords.Select(s => s.RecordType.Type).ToList();
        var start = signatures.IndexOf("OBTE");
        if (start < 0) return;
        var end = signatures.IndexOf("STOP", start);
        if (end < 0) end = signatures.Count;
        var template = signatures[(start + 1)..end];

        var lastObts = template.LastIndexOf("OBTS");
        var lastDress = Math.Max(template.LastIndexOf("OBTF"), template.LastIndexOf("FULL"));
        if (lastDress >= 0 && lastDress > lastObts)
        {
            var closedGroups = CountClosedGroups(template);
            diagnoses.Add(new PluginDiagnosis(anchor, "subrecord-out-of-ck-order", Lossless,
                $"template combination {closedGroups}'s OBTS precedes its OBTF/FULL; the Creation Kit writes OBTF, FULL, OBTS"));
        }
    }

    // The record index the dangling combination would have taken.
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
        PerkEntryPointShapes shapes, string recordType, List<SubrecordPinFrame> subrecords,
        string anchor, List<PluginDiagnosis> diagnoses)
    {
        if (recordType != "PERK") return;
        var entryIndex = -1;
        var i = 0;
        while (i < subrecords.Count)
        {
            if (subrecords[i].RecordType.Type != "PRKE" || subrecords[i].ContentLength < 1 || subrecords[i].Content.Span[0] != 2)
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
            for (; j < subrecords.Count && subrecords[j].RecordType.Type is not ("PRKF" or "PRKE"); j++)
            {
                var s = subrecords[j];
                var sig = s.RecordType.Type;
                if (sig == "DATA" && function == null && s.ContentLength >= 2) function = s.Content.Span[1];
                if (sig == "EPFT" && s.ContentLength >= 1) { epft = s.Content.Span[0]; parameterBytes += s.TotalLength; }
                // The drop operation removes the whole parameter block — EPFT, EPFB and EPFD — so
                // all three count toward the tail's byte cost.
                if (sig is "EPFD" or "EPFB") parameterBytes += s.TotalLength;
                if (sig == "EPF3") hasEpf3 = true;
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

    private static string Anchor(string recordType, uint formId, List<SubrecordPinFrame> subrecords)
    {
        var edid = subrecords.FindIndex(s => s.RecordType.Type == "EDID");
        var name = edid >= 0 && subrecords[edid].ContentLength > 0
            ? Encoding.UTF8.GetString(subrecords[edid].Content.Span).TrimEnd('\0')
            : null;
        return $"{recordType} {formId:X8}{(name != null ? $" ({name})" : "")}";
    }
}
