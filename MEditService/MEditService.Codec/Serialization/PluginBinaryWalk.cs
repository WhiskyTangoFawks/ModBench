using System.Buffers.Binary;
using System.IO.Compression;
using System.Text;

namespace MEditService.Codec.Serialization;

/// <summary>Mutagen-free byte-level walker over a plugin's record/GRUP/subrecord structure, shared by
/// Track's tripwire and the Repair surface. Mutagen-free by requirement (ADR-0006): its model is
/// where the data goes missing.</summary>
public static class PluginBinaryWalk
{
    private const uint CompressedFlag = 0x00040000;

    /// <summary>One top-level record or GRUP header. For a GRUP only <c>Start</c>/<c>DataStart</c> are
    /// meaningful (its header carries no FormID); for a record the data span bounds its subrecord stream.</summary>
    public readonly record struct RecordSpan(string Type, uint FormId, uint Flags, int Start, int DataStart, int DataLen, bool IsGrup);

    /// <summary>One subrecord, relative to the record-data buffer. <c>Len</c> already accounts for an
    /// <c>XXXX</c> marker preceding it, which is not returned as its own entry.</summary>
    public readonly record struct SubrecordSpan(string Sig, int Start, int Len);

    /// <summary>A record whose rewrite has fewer occurrences of some subrecord signatures than the
    /// original. <c>FormId</c> is the raw stored FormID, unresolved — this walker has no link cache and
    /// callers name records the way the bytes do.</summary>
    public readonly record struct SubrecordLoss(string RecordType, uint FormId, IReadOnlyList<string> Signatures);

    /// <summary>Flat, document-order walk. A GRUP's children follow immediately after its 24-byte header —
    /// the format nests by adjacency, not by a length prefix — so the walk descends by construction.</summary>
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

    /// <summary>A single record's subrecord stream, already decompressed by the caller. An <c>XXXX</c>
    /// marker's 4-byte payload replaces the following subrecord's 2-byte length — the escape for a
    /// length past <c>ushort</c>.</summary>
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

    /// <summary>Signatures the rewrite has fewer of than the original, in first-seen order. Order and
    /// content are model identity's concern; a signature the rewrite has more of (a canonical marker
    /// insertion) is not loss.</summary>
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

    /// <summary>The first record whose subrecord inventory shows a drop, or null. Paired by type and
    /// FormID, never by position: a rewrite carries no group order. TES4's MAST/DATA are exempt
    /// (ADR-0008 re-derives the master list).</summary>
    public static SubrecordLoss? FindFirstSubrecordLoss(byte[] originalPluginBytes, byte[] rewrittenPluginBytes)
    {
        var rewrittenByIdentity = new Dictionary<(string Type, uint FormId), RecordSpan>();
        foreach (var record in WalkRecords(rewrittenPluginBytes).Where(r => !r.IsGrup))
            rewrittenByIdentity.TryAdd((record.Type, record.FormId), record);

        foreach (var original in WalkRecords(originalPluginBytes).Where(r => !r.IsGrup))
        {
            if (!rewrittenByIdentity.TryGetValue((original.Type, original.FormId), out var rewritten))
                continue;

            var originalCompressed = (original.Flags & CompressedFlag) != 0;
            var rewrittenCompressed = (rewritten.Flags & CompressedFlag) != 0;
            if (originalCompressed != rewrittenCompressed)
                continue;

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
            if (original.Type == "TES4")
                dropped = dropped.Where(sig => sig is not ("MAST" or "DATA")).ToList();
            if (dropped.Count > 0)
                return new SubrecordLoss(original.Type, original.FormId, dropped);
        }

        return null;
    }

    private static byte[] Slice(byte[] data, RecordSpan record) =>
        data.AsSpan(record.DataStart, Math.Min(record.DataLen, data.Length - record.DataStart)).ToArray();
}
