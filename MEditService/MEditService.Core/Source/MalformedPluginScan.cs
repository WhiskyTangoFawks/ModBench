using System.Text;

namespace MEditService.Core.Source;

/// <summary>
/// The Kind B per-class detectors (#569, ADR-0043): byte-level scans that name a Malformed
/// plugin's defect class — subrecords the Creation Kit would never have written that way — from
/// the plugin's <b>original bytes alone</b>. No Mutagen (the model is where the data goes missing;
/// ADR-0043's Mutagen-free requirement) and no recompiled counterpart (unlike
/// <see cref="PluginBinaryWalk.FindFirstSubrecordLoss"/>'s two-sided inventory diff), which is what
/// lets the session-load surface (#570) run this over every plugin without a Track.
///
/// <para>Each detector is a row in a per-game data table of proven defect classes
/// (<c>docs/specs/medit-repair.md</c>); the tables here are Fallout 4's, each row proven by a real
/// defective plugin committed as a fixture and — for the canonical-form claims ("the CK always
/// writes…") — by the <c>MEDIT_SMOKE</c>-gated vanilla scan, which asserts the shipped game trips
/// none of them. Expected values come from the vanilla binaries, not from a reference's comments:
/// xEdit's own PERK table annotates fn 14 as <c>EPFT=2</c> where vanilla plugins carry
/// <c>EPFT=8</c>.</para>
/// </summary>
public static class MalformedPluginScan
{
    private const uint CompressedFlag = 0x00040000;

    /// <summary>(record type, subrecord) → the payload size the CK always writes. A shorter
    /// payload is repairable by zero-padding to size — lossless.</summary>
    private static readonly Dictionary<(string RecordType, string Sig), int> FixedSizeTable = new()
    {
        [("REGN", "RDAT")] = 8, // Type u32, Override u8, Priority u8, unused ×2
    };

    /// <summary>(record type, subrecord) → the occurrence count the CK always writes when it
    /// writes any. Zero occurrences stays clean — absence of the whole list is not the defect
    /// this row proves (Lunar-UniqueCreatures.esp's RACEs carry 31 and 30 of 32).</summary>
    private static readonly Dictionary<(string RecordType, string Sig), int> FixedCountTable = new()
    {
        [("RACE", "NAME")] = 32, // Biped Object Names — one per FO4 biped slot
    };

    /// <summary>(record type, counter subrecord) → the entry subrecord the counter's own u32
    /// counts. Entries follow their counter contiguously; a disagreement is repairable by
    /// rewriting the counter to the real count — lossless.</summary>
    private static readonly Dictionary<(string RecordType, string Counter), string> CounterTable = new()
    {
        [("REFR", "XWPG")] = "XWPN", // power-grid connections
    };

    private const string Lossless = "repairable (lossless)";

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
        }
        return diagnoses;
    }

    private static bool HasDetector(string recordType) =>
        FixedSizeTable.Keys.Any(k => k.RecordType == recordType)
        || FixedCountTable.Keys.Any(k => k.RecordType == recordType)
        || CounterTable.Keys.Any(k => k.RecordType == recordType)
        || recordType == "WEAP";

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

    /// <summary>GaussRevolver.esp's proven rotation: within the WEAP object template
    /// (<c>OBTE … STOP</c>), the CK writes each combination as <c>OBTF, FULL, OBTS</c> — every
    /// <c>OBTS</c> in the defective plugin instead sits one combination early, so the very first
    /// template subrecord after <c>OBTE</c> is an <c>OBTS</c> while <c>OBTF</c>/<c>FULL</c>
    /// follow later. A bare trailing combination (an <c>OBTS</c> with no <c>OBTF</c>/<c>FULL</c>
    /// of its own, after dressed ones) is not the rotation and stays clean.</summary>
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
        if (template.Count > 0 && template[0] == "OBTS"
            && template.Skip(1).Any(sig => sig is "OBTF" or "FULL"))
        {
            diagnoses.Add(new PluginDiagnosis(anchor, "subrecord-out-of-ck-order", Lossless,
                "template combination 0's OBTS precedes its OBTF/FULL; the Creation Kit writes OBTF, FULL, OBTS"));
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
