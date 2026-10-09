using System.Buffers.Binary;
using System.IO.Compression;
using System.Text;
using MEditService.TestSupport;

namespace MEditService.PluginAdapter.Tests.PluginAdapter;

public sealed class SubrecordLossTests : IDisposable
{
    private static readonly IPluginAdapter Adapter = TestAdapters.Mutagen();

    private readonly ScratchDirectory _folder = new("subrecord-loss");

    public void Dispose() => _folder.Dispose();

    private async Task<PluginBinaryWalk.SubrecordLoss?> LossAsync(byte[] original, byte[] rewritten)
    {
        var originalPath = Path.Combine(_folder.Path, "original.esp");
        var rewrittenPath = Path.Combine(_folder.Path, "rewritten.esp");
        File.WriteAllBytes(originalPath, original);
        File.WriteAllBytes(rewrittenPath, rewritten);
        return (await Adapter.CompareBytesAsync(originalPath, rewrittenPath)).Loss;
    }

    [Fact]
    public async Task ARecordInsideAGrup_IsComparedByItsOwnHeader()
    {
        var grup = BuildGrupHeader("WEAP", groupSize: 24 + 24 + 4);
        var original = Concat(grup, BuildRecordHeader("WEAP", 0x00123456, 0, Concat(Sub("EDID", [1]), Sub("RDMP", [2]))));
        var rewritten = Concat(grup, BuildRecordHeader("WEAP", 0x00123456, 0, Concat(Sub("EDID", [1]))));

        var loss = await LossAsync(original, rewritten);

        Assert.NotNull(loss);
        Assert.Equal("WEAP", loss.Value.RecordType);
        Assert.Equal(0x00123456u, loss.Value.FormId);
    }

    [Fact]
    public async Task AnXxxxMarker_SuppliesTheFollowingSubrecordsRealLength()
    {
        const int DeliberatelyWrongDeclaredLengthSoOnlyTheXxxxMarkersOwnValueIsTheRealLength = 3;
        var payload = new byte[10];
        for (var i = 0; i < payload.Length; i++) payload[i] = (byte)(i + 1);
        var xxxxMarker = BuildSubrecordHeader("XXXX", declaredLen: 4).Concat(BitConvert(payload.Length)).ToArray();
        var oversizedSubrecord = BuildSubrecordHeader("BIG ", declaredLen: DeliberatelyWrongDeclaredLengthSoOnlyTheXxxxMarkersOwnValueIsTheRealLength).Concat(payload).ToArray();
        var original = BuildRecordHeader("WEAP", 1, 0, Concat(xxxxMarker, oversizedSubrecord, Sub("RDMP", [1])));
        var rewritten = BuildRecordHeader("WEAP", 1, 0, Concat(xxxxMarker, oversizedSubrecord));

        var loss = await LossAsync(original, rewritten);

        Assert.NotNull(loss);
        Assert.Equal(["RDMP"], loss.Value.Signatures);
    }

    [Fact]
    public async Task ASignatureWithFewerOccurrencesInTheRewrite_IsReported()
    {
        var original = BuildRecordHeader("WEAP", 1, 0, Concat(Sub("RDAT", [1]), Sub("RDAT", [2]), Sub("RDMP", [3])));
        var rewritten = BuildRecordHeader("WEAP", 1, 0, Concat(Sub("RDAT", [1])));

        var loss = await LossAsync(original, rewritten);

        Assert.Equal(["RDAT", "RDMP"], loss?.Signatures);
    }

    [Fact]
    public async Task ASignatureWithMoreOccurrencesInTheRewrite_IsNotLoss()
    {
        var original = BuildRecordHeader("FURN", 1, 0, Concat(Sub("EDID", "Furniture"u8.ToArray())));
        var rewritten = BuildRecordHeader("FURN", 1, 0, Concat(Sub("EDID", "Furniture"u8.ToArray()), Sub("FNAM", [0, 0]), Sub("MNAM", [0, 0])));

        Assert.Null(await LossAsync(original, rewritten));
    }

    [Fact]
    public async Task AReorderOrASameCountContentChange_IsNotLoss()
    {
        var reorderedOriginal = BuildRecordHeader("WEAP", 1, 0, Concat(Sub("EDID", [1]), Sub("RCLR", [2])));
        var reorderedRewritten = BuildRecordHeader("WEAP", 1, 0, Concat(Sub("RCLR", [2]), Sub("EDID", [1])));
        Assert.Null(await LossAsync(reorderedOriginal, reorderedRewritten));

        var recoloredOriginal = BuildRecordHeader("WEAP", 1, 0, Concat(Sub("RCLR", [0x0A, 0x0F, 0xC8, 0x00])));
        var recoloredRewritten = BuildRecordHeader("WEAP", 1, 0, Concat(Sub("RCLR", [0xFF, 0x00, 0x00, 0x00])));
        Assert.Null(await LossAsync(recoloredOriginal, recoloredRewritten));
    }

    [Fact]
    public async Task NamesTheFirstRecordWhoseInventoryShrank_NotAnEarlierUnchangedOne()
    {
        var untouchedRecord = BuildRecordHeader("WEAP", 0x00000001, flags: 0,
            subrecordBytes: Concat(Sub("EDID", "Gun"u8.ToArray())));
        var originalLossyRecord = BuildRecordHeader("REGN", 0x00ABCDEF, flags: 0,
            subrecordBytes: Concat(Sub("EDID", "Region"u8.ToArray()), Sub("RDMP", [1]), Sub("RDMO", [2])));
        var rewrittenLossyRecord = BuildRecordHeader("REGN", 0x00ABCDEF, flags: 0,
            subrecordBytes: Concat(Sub("EDID", "Region"u8.ToArray())));

        var original = Concat(untouchedRecord, originalLossyRecord);
        var rewritten = Concat(untouchedRecord, rewrittenLossyRecord);

        var loss = await LossAsync(original, rewritten);

        Assert.NotNull(loss);
        Assert.Equal("REGN", loss.Value.RecordType);
        Assert.Equal(0x00ABCDEFu, loss.Value.FormId);
        Assert.Equal(["RDMP", "RDMO"], loss.Value.Signatures);
    }

    [Fact]
    public async Task WhenTheRewriteOrdersRecordsDifferently_StillNamesTheLossyRecord_PairedByTypeAndFormIdBecauseARewriteFromTheTreeCarriesNoGroupOrder()
    {
        var untouchedRecord = BuildRecordHeader("WEAP", 0x00000001, flags: 0,
            subrecordBytes: Concat(Sub("EDID", "Gun"u8.ToArray())));
        var originalLossyRecord = BuildRecordHeader("REGN", 0x00ABCDEF, flags: 0,
            subrecordBytes: Concat(Sub("EDID", "Region"u8.ToArray()), Sub("RDMP", [1]), Sub("RDMO", [2])));
        var rewrittenLossyRecord = BuildRecordHeader("REGN", 0x00ABCDEF, flags: 0,
            subrecordBytes: Concat(Sub("EDID", "Region"u8.ToArray())));

        var original = Concat(untouchedRecord, originalLossyRecord);
        var rewritten = Concat(rewrittenLossyRecord, untouchedRecord);

        var loss = await LossAsync(original, rewritten);

        Assert.NotNull(loss);
        Assert.Equal("REGN", loss.Value.RecordType);
        Assert.Equal(["RDMP", "RDMO"], loss.Value.Signatures);
    }

    [Fact]
    public async Task DecompressesACompressedRecordBeforeComparing()
    {
        const uint compressedFlag = 0x00040000;
        var originalPayload = Concat(Sub("EDID", "Compressed"u8.ToArray()), Sub("RDMP", [1]));
        var rewrittenPayload = Concat(Sub("EDID", "Compressed"u8.ToArray()));

        var originalRecord = BuildRecordHeader("REGN", 0x00000042, compressedFlag, CompressedData(originalPayload));
        var rewrittenRecord = BuildRecordHeader("REGN", 0x00000042, compressedFlag, CompressedData(rewrittenPayload));

        var loss = await LossAsync(Concat(originalRecord), Concat(rewrittenRecord));

        Assert.NotNull(loss);
        Assert.Equal(["RDMP"], loss.Value.Signatures);
    }

    [Fact]
    public async Task AStructuralDivergence_ReturnsNullRatherThanMisdiagnosing()
    {
        var originalWeap = BuildRecordHeader("WEAP", 0x00000001, flags: 0,
            subrecordBytes: Concat(Sub("EDID", "Gun"u8.ToArray()), Sub("FULL", "Name"u8.ToArray())));
        var rewrittenArmo = BuildRecordHeader("ARMO", 0x00000001, flags: 0,
            subrecordBytes: Concat(Sub("EDID", "Gun"u8.ToArray())));

        Assert.Null(await LossAsync(Concat(originalWeap), Concat(rewrittenArmo)));

        var uncompressed = BuildRecordHeader("REGN", 0x00000042, flags: 0,
            subrecordBytes: Concat(Sub("EDID", "Region"u8.ToArray()), Sub("RDMP", [1])));
        var compressedSamePayloadMinusRdmp = BuildRecordHeader("REGN", 0x00000042, flags: 0x00040000,
            subrecordBytes: CompressedData(Concat(Sub("EDID", "Region"u8.ToArray()))));

        Assert.Null(await LossAsync(Concat(uncompressed), Concat(compressedSamePayloadMinusRdmp)));
    }

    [Fact]
    public async Task AnUnreadableCompressedRecord_IsSkippedRatherThanThrowing()
    {
        const uint compressedFlag = 0x00040000;
        byte[] notActuallyZlib = [0xDE, 0xAD, 0xBE, 0xEF, 0x00, 0x01, 0x02, 0x03];
        byte[] otherGarbage = [0xDE, 0xAD, 0xBE, 0xEF, 0x00, 0x01, 0x02, 0x04];
        var garbageRecord = BuildRecordHeader("REGN", 0x00000042, compressedFlag, notActuallyZlib);
        var otherGarbageRecord = BuildRecordHeader("REGN", 0x00000042, compressedFlag, otherGarbage);

        var loss = await LossAsync(garbageRecord, otherGarbageRecord);

        Assert.Null(loss);
    }

    [Fact]
    public async Task ATes4MastAndDataDropOnly_IsNotReported()
    {
        var originalHeader = BuildRecordHeader("TES4", 0, flags: 0,
            subrecordBytes: Concat(Sub("HEDR", [1, 2, 3, 4]), Sub("MAST", "Fallout4.esm\0"u8.ToArray()), Sub("DATA", new byte[8])));
        var rewrittenHeader = BuildRecordHeader("TES4", 0, flags: 0,
            subrecordBytes: Concat(Sub("HEDR", [1, 2, 3, 4])));

        var loss = await LossAsync(Concat(originalHeader), Concat(rewrittenHeader));

        Assert.Null(loss);
    }

    [Fact]
    public async Task ATes4NonMasterSubrecordDrop_IsStillReported()
    {
        var originalHeader = BuildRecordHeader("TES4", 0, flags: 0,
            subrecordBytes: Concat(Sub("HEDR", [1, 2, 3, 4]), Sub("MAST", "Fallout4.esm\0"u8.ToArray()), Sub("DATA", new byte[8]), Sub("SNAM", "desc"u8.ToArray())));
        var rewrittenHeader = BuildRecordHeader("TES4", 0, flags: 0,
            subrecordBytes: Concat(Sub("HEDR", [1, 2, 3, 4]), Sub("MAST", "Fallout4.esm\0"u8.ToArray()), Sub("DATA", new byte[8])));

        var loss = await LossAsync(Concat(originalHeader), Concat(rewrittenHeader));

        Assert.NotNull(loss);
        Assert.Equal("TES4", loss.Value.RecordType);
        Assert.Equal(["SNAM"], loss.Value.Signatures);
    }

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
