using System.Buffers.Binary;
using System.IO.Compression;
using System.Text;

namespace MEditService.Core.Source;

/// <summary>
/// Mutagen-free byte-level walker over a plugin's own record/GRUP/subrecord structure — record
/// header, GRUP header, subrecord header (including <c>XXXX</c>-extended length), and
/// zlib-compressed record payloads. Promoted from the #511 survey harness
/// (<c>RoundTripSurvey.Walk</c>/<c>Subrecords</c>/<c>Inflate</c>,
/// <c>MEditService.Tests/RealData</c>) for #514's Track subrecord-inventory tripwire, and named
/// as the shared engine <c>docs/specs/medit-repair.md</c> already forward-references for the
/// Repair surface (#519/#525): "one walker" for both. That is also why it references no Mutagen
/// type — a repair/diagnosis engine built on Mutagen's own object model couldn't see the exact
/// class of defect this ticket exists to catch, since that model is where the data went missing
/// in the first place (ADR-0043's own "Mutagen-free engine" requirement).
/// </summary>
public static class PluginBinaryWalk
{
    private const uint CompressedFlag = 0x00040000;

    /// <summary>One top-level record or GRUP header, as found by <see cref="WalkRecords"/>. For a
    /// GRUP, only <see cref="Start"/>/<see cref="DataStart"/> are meaningful (its own header carries
    /// no FormID); for a record, <see cref="DataStart"/>/<see cref="DataLen"/> bound its subrecord
    /// stream, the span <see cref="WalkSubrecords"/> and <see cref="DroppedSignatures"/> operate on.</summary>
    public readonly record struct RecordSpan(string Type, uint FormId, uint Flags, int Start, int DataStart, int DataLen, bool IsGrup);

    /// <summary>One subrecord, as found by <see cref="WalkSubrecords"/>. <see cref="Start"/>/<see cref="Len"/>
    /// are relative to the record-data buffer passed in, and <see cref="Len"/> already accounts for an
    /// <c>XXXX</c> marker preceding it (the marker itself is not returned as its own entry).</summary>
    public readonly record struct SubrecordSpan(string Sig, int Start, int Len);

    /// <summary>A record whose rewrite has fewer occurrences of one or more subrecord signatures than
    /// the original — <see cref="FindFirstSubrecordLoss"/>'s result. <see cref="FormId"/> is the raw
    /// stored FormID exactly as the binary carries it (relative to that plugin's own master list, no
    /// resolution) — this walker has no link cache to resolve one, and none is needed: this ticket's
    /// callers name the record the same way the plugin's own bytes do. <see cref="Signatures"/> is the
    /// same list <see cref="DroppedSignatures"/> would return for this one record.</summary>
    public readonly record struct SubrecordLoss(string RecordType, uint FormId, IReadOnlyList<string> Signatures);

    /// <summary>Flat, document-order walk of every top-level record and GRUP header in <paramref name="data"/>
    /// (a whole plugin's bytes). A GRUP's own children follow immediately after its 24-byte header — the
    /// format nests by mere adjacency, not by a length prefix pointing past them — so this walk descends
    /// into every GRUP by construction rather than by recursion.</summary>
    public static List<RecordSpan> WalkRecords(byte[] data)
    {
        var list = new List<RecordSpan>();
        int pos = 0;
        while (pos + 24 <= data.Length)
        {
            var type = Encoding.ASCII.GetString(data, pos, 4);
            var size = BinaryPrimitives.ReadUInt32LittleEndian(data.AsSpan(pos + 4));
            if (type == "GRUP")
            {
                list.Add(new RecordSpan("GRUP", 0, 0, pos, pos + 24, 0, IsGrup: true));
                pos += 24; // descend: children follow inline, not skipped by the group's own size
                continue;
            }
            var flags = BinaryPrimitives.ReadUInt32LittleEndian(data.AsSpan(pos + 8));
            var formId = BinaryPrimitives.ReadUInt32LittleEndian(data.AsSpan(pos + 12));
            list.Add(new RecordSpan(type, formId, flags, pos, pos + 24, (int)size, IsGrup: false));
            pos += 24 + (int)size;
        }
        return list;
    }

    /// <summary>Walk of a single record's own subrecord stream (its <see cref="RecordSpan.DataStart"/>/
    /// <see cref="RecordSpan.DataLen"/> span, already decompressed by the caller if the record carries
    /// <see cref="CompressedFlag"/>). An <c>XXXX</c> marker's own 4-byte payload replaces the following
    /// subrecord's 2-byte declared length — the extended-length escape every other subrecord type can
    /// use once its natural length exceeds a <c>ushort</c>.</summary>
    public static List<SubrecordSpan> WalkSubrecords(byte[] data)
    {
        var list = new List<SubrecordSpan>();
        int pos = 0;
        int xxxx = -1;
        while (pos + 6 <= data.Length)
        {
            var sig = Encoding.ASCII.GetString(data, pos, 4);
            int len = BinaryPrimitives.ReadUInt16LittleEndian(data.AsSpan(pos + 4));
            if (sig == "XXXX")
            {
                xxxx = (int)BinaryPrimitives.ReadUInt32LittleEndian(data.AsSpan(pos + 6));
                pos += 10;
                continue;
            }
            if (xxxx >= 0) { len = xxxx; xxxx = -1; }
            list.Add(new SubrecordSpan(sig, pos, Math.Min(6 + len, data.Length - pos)));
            pos += 6 + len;
        }
        return list;
    }

    /// <summary>A compressed record's data is a little-endian uint32 decompressed length followed by a
    /// zlib stream — decompresses it to the subrecord bytes <see cref="WalkSubrecords"/> expects.</summary>
    public static byte[] Inflate(ReadOnlySpan<byte> compressedRecordData)
    {
        using var input = new MemoryStream(compressedRecordData[4..].ToArray());
        using var z = new ZLibStream(input, CompressionMode.Decompress);
        using var output = new MemoryStream();
        z.CopyTo(output);
        return output.ToArray();
    }

    /// <summary>
    /// #514's tripwire itself: every subrecord signature <paramref name="originalData"/> holds more
    /// occurrences of than <paramref name="rewrittenData"/> does — a signature the rewrite silently
    /// dropped one or more instances of. Subrecord <b>order</b> and <b>content</b> are deliberately not
    /// this check's concern (that is model identity's job — <c>ModelIdentity.FindFirst</c>
    /// — and encoding-class differences' — a same-multiset reorder or a byte-for-byte content change to
    /// an unchanged-count signature reports nothing here. A signature the rewrite has <i>more</i> of — a
    /// canonical marker insertion (<c>FURN FNAM/MNAM</c>, <c>WRLD ONAM/DATA</c>, <c>INNR KSIZ</c>,
    /// observed harmless in the #511 survey) — reports nothing either: only a decrease is loss.
    /// </summary>
    /// <returns>Dropped signatures in first-seen order within <paramref name="originalData"/>, for a
    /// stable, reproducible message; empty when nothing was dropped.</returns>
    public static List<string> DroppedSignatures(byte[] originalData, byte[] rewrittenData)
    {
        var originalSubrecords = WalkSubrecords(originalData);
        var originalCounts = CountBySignature(originalSubrecords);
        var rewrittenCounts = CountBySignature(WalkSubrecords(rewrittenData));

        return originalSubrecords
            .Select(sub => sub.Sig)
            .Distinct(StringComparer.Ordinal)
            .Where(sig => rewrittenCounts.GetValueOrDefault(sig) < originalCounts[sig])
            .ToList();
    }

    private static Dictionary<string, int> CountBySignature(List<SubrecordSpan> subrecords) =>
        subrecords
            .GroupBy(sub => sub.Sig, StringComparer.Ordinal)
            .ToDictionary(g => g.Key, g => g.Count(), StringComparer.Ordinal);

    /// <summary>
    /// Walks <paramref name="originalPluginBytes"/> and <paramref name="rewrittenPluginBytes"/> in
    /// parallel (mirroring <c>RoundTripSurvey.Classify</c>'s own positional walk) and returns the first
    /// record — in the original's own GRUP order — whose subrecord inventory shows a genuine drop.
    /// <c>TES4</c> is not special-cased here: a caller whose write pipeline can legitimately add or prune
    /// a header subrecord (e.g. re-deriving the master list) must exclude it itself, the way
    /// <see cref="TrackService.VerifyRoundTrip"/>'s own <c>WithLoadOrderFromHeaderMasters</c> write option
    /// keeps the header's master list — and therefore its subrecord counts — identical to the original by
    /// construction, needing no such exclusion.
    ///
    /// <para>Returns <see langword="null"/> both when nothing was dropped and when the two plugins'
    /// records structurally diverge (different type/FormID at the same position, or a compression-flag
    /// mismatch) — that divergence is a different failure than this check exists to name, left to the
    /// model-identity gate that already reports it.</para>
    /// </summary>
    public static SubrecordLoss? FindFirstSubrecordLoss(byte[] originalPluginBytes, byte[] rewrittenPluginBytes)
    {
        var originalRecords = WalkRecords(originalPluginBytes).Where(r => !r.IsGrup).ToList();
        var rewrittenRecords = WalkRecords(rewrittenPluginBytes).Where(r => !r.IsGrup).ToList();
        var n = Math.Min(originalRecords.Count, rewrittenRecords.Count);

        for (int i = 0; i < n; i++)
        {
            var original = originalRecords[i];
            var rewritten = rewrittenRecords[i];
            if (original.Type != rewritten.Type || original.FormId != rewritten.FormId)
                return null;

            var originalCompressed = (original.Flags & CompressedFlag) != 0;
            var rewrittenCompressed = (rewritten.Flags & CompressedFlag) != 0;
            if (originalCompressed != rewrittenCompressed)
                return null;

            byte[] originalData, rewrittenData;
            try
            {
                originalData = Slice(originalPluginBytes, original);
                rewrittenData = Slice(rewrittenPluginBytes, rewritten);
                if (originalCompressed)
                {
                    originalData = Inflate(originalData);
                    rewrittenData = Inflate(rewrittenData);
                }
            }
            catch (InvalidDataException)
            {
                // Not this check's job to diagnose an unreadable compressed stream.
                continue;
            }

            var dropped = DroppedSignatures(originalData, rewrittenData);
            if (dropped.Count > 0)
                return new SubrecordLoss(original.Type, original.FormId, dropped);
        }

        return null;
    }

    private static byte[] Slice(byte[] data, RecordSpan record) =>
        data.AsSpan(record.DataStart, Math.Min(record.DataLen, data.Length - record.DataStart)).ToArray();
}
