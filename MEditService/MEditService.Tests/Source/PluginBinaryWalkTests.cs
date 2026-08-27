using System.Buffers.Binary;
using System.IO.Compression;
using System.Text;
using MEditService.Core.Source;

namespace MEditService.Tests.Source;

/// <summary>
/// #514: the promoted, Mutagen-free byte walker (<see cref="PluginBinaryWalk"/>) and its own
/// tripwire (<see cref="PluginBinaryWalk.DroppedSignatures"/>/<see cref="PluginBinaryWalk.FindFirstSubrecordLoss"/>),
/// tested directly against hand-built bytes — no Mutagen, no session, no Track. The real-fixture,
/// end-to-end case (<c>LitR - TrueStorms.esp</c> refused by name through <see cref="MEditService.Core.Source.TrackService"/>)
/// lives in <c>MEditService.Tests.RealData.SubrecordInventoryRoundTripGateTests</c> instead — this
/// file is the comparator's own unit contract.
/// </summary>
public sealed class PluginBinaryWalkTests
{
    [Fact]
    public void WalkRecords_DescendsIntoAGrupAndReadsEachRecordHeader()
    {
        var grup = BuildGrupHeader("WEAP", groupSize: 24 + 24 + 4);
        var record = BuildRecordHeader("WEAP", 0x00123456, flags: 0, subrecordBytes: [1, 2, 3, 4]);
        var bytes = Concat(grup, record);

        var spans = PluginBinaryWalk.WalkRecords(bytes);

        Assert.Equal(2, spans.Count);
        Assert.True(spans[0].IsGrup);
        Assert.False(spans[1].IsGrup);
        Assert.Equal("WEAP", spans[1].Type);
        Assert.Equal(0x00123456u, spans[1].FormId);
        Assert.Equal(4, spans[1].DataLen);
    }

    [Fact]
    public void WalkSubrecords_AnXxxxMarkerSuppliesTheFollowingSubrecordsRealLength()
    {
        // The declared 2-byte length on the real subrecord is deliberately wrong (3) — only the
        // XXXX marker's own 4-byte value (10) is the real length, proving the walk reads that one.
        var payload = new byte[10];
        for (var i = 0; i < payload.Length; i++) payload[i] = (byte)(i + 1);
        var xxxxMarker = BuildSubrecordHeader("XXXX", declaredLen: 4).Concat(BitConvert(payload.Length)).ToArray();
        var oversizedSubrecord = BuildSubrecordHeader("BIG ", declaredLen: 3).Concat(payload).ToArray();
        var data = Concat(xxxxMarker, oversizedSubrecord);

        var subrecords = PluginBinaryWalk.WalkSubrecords(data);

        var big = Assert.Single(subrecords);
        Assert.Equal("BIG ", big.Sig);
        Assert.Equal(6 + payload.Length, big.Len);
    }

    [Fact]
    public void DroppedSignatures_ASignatureWithFewerOccurrencesInTheRewrite_IsReported()
    {
        var original = Concat(Sub("RDAT", [1]), Sub("RDAT", [2]), Sub("RDMP", [3]));
        var rewritten = Concat(Sub("RDAT", [1]));

        var dropped = PluginBinaryWalk.DroppedSignatures(original, rewritten);

        Assert.Equal(["RDAT", "RDMP"], dropped);
    }

    /// <summary>
    /// Guard test: a plausible wrong implementation compares the two *sets* of signatures present
    /// (symmetric difference) rather than counts, which would misreport a subrecord the rewrite has
    /// *more* of as "dropped" too. Verified failing against that rival before trusting the real
    /// count-based implementation: swapping <see cref="PluginBinaryWalk.DroppedSignatures"/>'s body for
    /// a set-symmetric-difference (<c>originalSet.Union(rewrittenSet).Where(sig =>
    /// originalSet.Contains(sig) != rewrittenSet.Contains(sig))</c>) and rerunning this exact test
    /// produced <c>Assert.Empty() Failure: Collection was not empty\nCollection: ["FNAM", "MNAM"]</c> —
    /// both canonical marker insertions flagged as a loss. Reverted; the shipped implementation (this
    /// test asserts) reports nothing for an increase.
    /// </summary>
    [Fact]
    public void DroppedSignatures_ASignatureWithMoreOccurrencesInTheRewrite_IsNotReported()
    {
        var original = Concat(Sub("EDID", "Furniture"u8.ToArray()));
        var rewritten = Concat(Sub("EDID", "Furniture"u8.ToArray()), Sub("FNAM", [0, 0]), Sub("MNAM", [0, 0]));

        var dropped = PluginBinaryWalk.DroppedSignatures(original, rewritten);

        Assert.Empty(dropped);
    }

    /// <summary>
    /// Guard test: a plausible wrong implementation compares raw bytes (order and content) rather than
    /// per-signature counts, which would misreport a pure reorder — or a same-count content change — as
    /// a loss. Verified failing against that rival before trusting the real implementation: swapping
    /// <see cref="PluginBinaryWalk.DroppedSignatures"/>'s body for a byte-sequence comparison
    /// (<c>originalData.AsSpan().SequenceEqual(rewrittenData) ? [] : ["order-or-content-changed"]</c>)
    /// and rerunning the reordered case above produced <c>Assert.Empty() Failure: Collection was not
    /// empty\nCollection: ["order-or-content-changed"]</c>; the recolored case below produces the same
    /// failure independently. Reverted; the shipped count-based implementation (this test asserts)
    /// reports nothing for either.
    /// </summary>
    [Fact]
    public void DroppedSignatures_AReorderOrASameCountContentChange_IsNotReported()
    {
        var reorderedOriginal = Concat(Sub("EDID", [1]), Sub("RCLR", [2]));
        var reorderedRewritten = Concat(Sub("RCLR", [2]), Sub("EDID", [1]));
        Assert.Empty(PluginBinaryWalk.DroppedSignatures(reorderedOriginal, reorderedRewritten));

        var recoloredOriginal = Concat(Sub("RCLR", [0x0A, 0x0F, 0xC8, 0x00]));
        var recoloredRewritten = Concat(Sub("RCLR", [0xFF, 0x00, 0x00, 0x00]));
        Assert.Empty(PluginBinaryWalk.DroppedSignatures(recoloredOriginal, recoloredRewritten));
    }

    [Fact]
    public void FindFirstSubrecordLoss_NamesTheFirstRecordWhoseInventoryShrank_NotAnEarlierUnchangedOne()
    {
        var untouchedRecord = BuildRecordHeader("WEAP", 0x00000001, flags: 0,
            subrecordBytes: Concat(Sub("EDID", "Gun"u8.ToArray())));
        var originalLossyRecord = BuildRecordHeader("REGN", 0x001D2AF4, flags: 0,
            subrecordBytes: Concat(Sub("EDID", "Region"u8.ToArray()), Sub("RDMP", [1]), Sub("RDMO", [2])));
        var rewrittenLossyRecord = BuildRecordHeader("REGN", 0x001D2AF4, flags: 0,
            subrecordBytes: Concat(Sub("EDID", "Region"u8.ToArray())));

        var original = Concat(untouchedRecord, originalLossyRecord);
        var rewritten = Concat(untouchedRecord, rewrittenLossyRecord);

        var loss = PluginBinaryWalk.FindFirstSubrecordLoss(original, rewritten);

        Assert.NotNull(loss);
        Assert.Equal("REGN", loss!.Value.RecordType);
        Assert.Equal(0x001D2AF4u, loss.Value.FormId);
        Assert.Equal(["RDMP", "RDMO"], loss.Value.Signatures);
    }

    [Fact]
    public void FindFirstSubrecordLoss_NoDropAnywhere_ReturnsNull()
    {
        var record = BuildRecordHeader("WEAP", 0x00000001, flags: 0,
            subrecordBytes: Concat(Sub("EDID", "Gun"u8.ToArray())));

        Assert.Null(PluginBinaryWalk.FindFirstSubrecordLoss(Concat(record), Concat(record)));
    }

    [Fact]
    public void FindFirstSubrecordLoss_DecompressesACompressedRecordBeforeComparing()
    {
        const uint compressedFlag = 0x00040000;
        var originalPayload = Concat(Sub("EDID", "Compressed"u8.ToArray()), Sub("RDMP", [1]));
        var rewrittenPayload = Concat(Sub("EDID", "Compressed"u8.ToArray()));

        var originalRecord = BuildRecordHeader("REGN", 0x00000042, compressedFlag, CompressedData(originalPayload));
        var rewrittenRecord = BuildRecordHeader("REGN", 0x00000042, compressedFlag, CompressedData(rewrittenPayload));

        var loss = PluginBinaryWalk.FindFirstSubrecordLoss(Concat(originalRecord), Concat(rewrittenRecord));

        Assert.NotNull(loss);
        Assert.Equal(["RDMP"], loss!.Value.Signatures);
    }

    /// <summary>A different record type or FormID at the same position is a different plugin
    /// structurally, not a subrecord loss — that divergence belongs to the model-identity gate this
    /// check runs beside, not this one. Also covers the sibling case (a compression-flag mismatch at
    /// the same position) via the second assertion, since both share the same "return null, don't
    /// misdiagnose" outcome in <see cref="PluginBinaryWalk.FindFirstSubrecordLoss"/>.</summary>
    [Fact]
    public void FindFirstSubrecordLoss_AStructuralDivergence_ReturnsNullRatherThanMisdiagnosing()
    {
        var originalWeap = BuildRecordHeader("WEAP", 0x00000001, flags: 0,
            subrecordBytes: Concat(Sub("EDID", "Gun"u8.ToArray()), Sub("FULL", "Name"u8.ToArray())));
        var rewrittenArmo = BuildRecordHeader("ARMO", 0x00000001, flags: 0,
            subrecordBytes: Concat(Sub("EDID", "Gun"u8.ToArray())));

        Assert.Null(PluginBinaryWalk.FindFirstSubrecordLoss(Concat(originalWeap), Concat(rewrittenArmo)));

        var uncompressed = BuildRecordHeader("REGN", 0x00000042, flags: 0,
            subrecordBytes: Concat(Sub("EDID", "Region"u8.ToArray()), Sub("RDMP", [1])));
        var compressedSamePayloadMinusRdmp = BuildRecordHeader("REGN", 0x00000042, flags: 0x00040000,
            subrecordBytes: CompressedData(Concat(Sub("EDID", "Region"u8.ToArray()))));

        Assert.Null(PluginBinaryWalk.FindFirstSubrecordLoss(Concat(uncompressed), Concat(compressedSamePayloadMinusRdmp)));
    }

    /// <summary>A compressed record whose declared payload isn't actually a valid zlib stream — real
    /// corruption, or a compression-flag set on data that was never deflated — is not this check's job
    /// to diagnose; <see cref="PluginBinaryWalk.FindFirstSubrecordLoss"/> skips the record rather than
    /// letting <see cref="System.IO.InvalidDataException"/> propagate out of a diagnostic that is
    /// supposed to be side-effect-free even when it can't answer. Verified failing without the
    /// production <c>catch (InvalidDataException)</c>: removing it and rerunning this exact test threw
    /// <c>System.IO.InvalidDataException: The archive entry was compressed using an unsupported
    /// compression method.</c> straight out of <see cref="PluginBinaryWalk.Inflate"/>, uncaught.
    /// Reverted; the shipped implementation (this test asserts) returns <see langword="null"/> instead.</summary>
    [Fact]
    public void FindFirstSubrecordLoss_AnUnreadableCompressedRecord_IsSkippedRatherThanThrowing()
    {
        const uint compressedFlag = 0x00040000;
        byte[] notActuallyZlib = [0xDE, 0xAD, 0xBE, 0xEF, 0x00, 0x01, 0x02, 0x03];
        var garbageRecord = BuildRecordHeader("REGN", 0x00000042, compressedFlag, notActuallyZlib);

        var loss = PluginBinaryWalk.FindFirstSubrecordLoss(Concat(garbageRecord), Concat(garbageRecord));

        Assert.Null(loss);
    }

    // ---- byte builders --------------------------------------------------------------------

    private static byte[] BuildGrupHeader(string label, int groupSize)
    {
        var b = new byte[24];
        Encoding.ASCII.GetBytes("GRUP").CopyTo(b, 0);
        BinaryPrimitives.WriteUInt32LittleEndian(b.AsSpan(4), (uint)groupSize);
        Encoding.ASCII.GetBytes(label).CopyTo(b, 8);
        return b;
    }

    private static byte[] BuildRecordHeader(string type, uint formId, uint flags, byte[] subrecordBytes)
    {
        var header = new byte[24];
        Encoding.ASCII.GetBytes(type).CopyTo(header, 0);
        BinaryPrimitives.WriteUInt32LittleEndian(header.AsSpan(4), (uint)subrecordBytes.Length);
        BinaryPrimitives.WriteUInt32LittleEndian(header.AsSpan(8), flags);
        BinaryPrimitives.WriteUInt32LittleEndian(header.AsSpan(12), formId);
        return Concat(header, subrecordBytes);
    }

    private static byte[] BuildSubrecordHeader(string sig, int declaredLen)
    {
        var header = new byte[6];
        Encoding.ASCII.GetBytes(sig).CopyTo(header, 0);
        BinaryPrimitives.WriteUInt16LittleEndian(header.AsSpan(4), (ushort)declaredLen);
        return header;
    }

    private static byte[] Sub(string sig, byte[] payload) => Concat(BuildSubrecordHeader(sig, payload.Length), payload);

    private static byte[] BitConvert(int value)
    {
        var b = new byte[4];
        BinaryPrimitives.WriteUInt32LittleEndian(b, (uint)value);
        return b;
    }

    /// <summary>A compressed record's own data shape: little-endian uint32 decompressed length, then a
    /// zlib stream — the inverse of <see cref="PluginBinaryWalk.Inflate"/>.</summary>
    private static byte[] CompressedData(byte[] decompressed)
    {
        using var output = new MemoryStream();
        output.Write(BitConvert(decompressed.Length));
        using (var z = new ZLibStream(output, CompressionMode.Compress, leaveOpen: true))
            z.Write(decompressed);
        return output.ToArray();
    }

    private static byte[] Concat(params byte[][] parts) => parts.SelectMany(p => p).ToArray();
}
