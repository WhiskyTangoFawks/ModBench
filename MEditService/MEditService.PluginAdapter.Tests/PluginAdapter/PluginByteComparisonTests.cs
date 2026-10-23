using System.Buffers.Binary;
using System.IO.Compression;
using System.Text;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.PluginAdapter.Tests.PluginAdapter;

public sealed class PluginByteComparisonTests : IDisposable
{
    private static readonly IPluginAdapter Adapter = TestAdapters.Mutagen();

    private readonly ScratchDirectory _folder = new("plugin-byte-comparison");

    public void Dispose() => _folder.Dispose();

    [Fact]
    public async Task TwoFilesWithTheSameBytes_AreIdentical()
    {
        var record = Record("WEAP", 1, Sub("EDID", "Gun\0"u8.ToArray()));

        var comparison = (await Adapter.CompareBytesAsync(Write("a.esp", record), Write("b.esp", record), EmptyLoadOrder.Of(GameRelease.Fallout4))).Answered();

        Assert.True(comparison.Identical);
        Assert.Null(comparison.Loss);
        Assert.Null(comparison.LossCauses);
    }

    [Fact]
    public async Task ARewriteThatDroppedASubrecord_NamesTheRecordAndItsSignatures()
    {
        var original = Record("WEAP", 0x10, Sub("EDID", "Gun\0"u8.ToArray()), Sub("RDMP", [1]));
        var rewritten = Record("WEAP", 0x10, Sub("EDID", "Gun\0"u8.ToArray()));

        var comparison = (await Adapter.CompareBytesAsync(Write("a.esp", original), Write("b.esp", rewritten), EmptyLoadOrder.Of(GameRelease.Fallout4))).Answered();

        Assert.False(comparison.Identical);
        Assert.NotNull(comparison.Loss);
        Assert.Equal("WEAP", comparison.Loss.Value.RecordType);
        Assert.Equal(0x10u, comparison.Loss.Value.FormId);
        Assert.Equal(["RDMP"], comparison.Loss.Value.Signatures);
        Assert.Null(comparison.LossCauses);
    }

    [Fact]
    public async Task ADropOnARecordTheOriginalMalformed_CarriesThatRecordsDiagnosis()
    {
        var original = Record("REGN", 0x20, Sub("EDID", "Region\0"u8.ToArray()), Sub("RDAT", new byte[6]));
        var rewritten = Record("REGN", 0x20, Sub("EDID", "Region\0"u8.ToArray()));

        var comparison = (await Adapter.CompareBytesAsync(Write("a.esp", original), Write("b.esp", rewritten), EmptyLoadOrder.Of(GameRelease.Fallout4))).Answered();

        Assert.Equal("fixed-size-subrecord-short", comparison.LossCauses?.Single().Diagnosis.DefectClass);
        Assert.StartsWith("REGN 00000020", comparison.LossCauses?.Single().Diagnosis.Anchor);
    }

    [Fact]
    public async Task ADifferenceThatDroppedNothing_IsNeitherIdenticalNorALoss()
    {
        var original = Record("MISC", 3, Sub("DATA", [1]));
        var rewritten = Record("MISC", 3, Sub("DATA", [2]));

        var comparison = (await Adapter.CompareBytesAsync(Write("a.esp", original), Write("b.esp", rewritten), EmptyLoadOrder.Of(GameRelease.Fallout4))).Answered();

        Assert.False(comparison.Identical);
        Assert.Null(comparison.Loss);
    }

    [Fact]
    public async Task ARewriteLackingARecord_NamesItAsAbsent()
    {
        var kept = Record("MISC", 3, Sub("DATA", [1]));
        var lost = Record("MISC", 4, Sub("DATA", [1]));

        var unverified = await UnverifiedAsync([.. kept, .. lost], kept);

        Assert.Equal(("MISC", "000004:a.esp", UnverifiedReason.AbsentFromRewrite),
            (unverified?.RecordType, unverified?.FormKey.ToString(), unverified?.Reason));
    }

    [Fact]
    public async Task TwoOriginalRecordsOfOneIdentity_NeedTwoInTheRewrite()
    {
        var record = Record("MISC", 3, Sub("DATA", [1]));

        var unverified = await UnverifiedAsync([.. record, .. record], record);

        Assert.Equal(UnverifiedReason.AbsentFromRewrite, unverified?.Reason);
    }

    [Fact]
    public async Task APairWhoseCompressionDiffers_IsNotComparable()
    {
        var payload = Sub("DATA", [1]);

        var unverified = await UnverifiedAsync([.. Tes4(), .. Record("MISC", 3, payload)], [.. Tes4(), .. CompressedRecord("MISC", 3, payload)]);

        Assert.Equal(("MISC", UnverifiedReason.NotComparable), (unverified?.RecordType, unverified?.Reason));
    }

    [Fact]
    public async Task APairBothCompressedAndRead_IsVerified()
    {
        var payload = Sub("DATA", [1]);

        Assert.Null(await UnverifiedAsync([.. Tes4(), .. CompressedRecord("MISC", 3, payload)], [.. Tes4(), .. CompressedRecord("MISC", 3, payload)]));
    }

    [Fact]
    public async Task WhenTheRewritePrunesAMaster_ThePluginHeaderStillPairs()
    {
        var unverified = await UnverifiedAsync(Tes4("A.esm", "B.esm"), Tes4("B.esm"));

        Assert.Null(unverified);
    }

    private async Task<UnverifiedRecord?> UnverifiedAsync(byte[] original, byte[] rewritten) =>
        (await Adapter.CompareBytesAsync(Write("a.esp", original), Write("b.esp", rewritten), EmptyLoadOrder.Of(GameRelease.Fallout4)))
        .Answered().Unverified;

    private static byte[] Tes4(params string[] masters) =>
        Record("TES4", 0, [Sub("HEDR", new byte[12]), .. masters.SelectMany(master => new[]
            { Sub("MAST", Encoding.ASCII.GetBytes(master + "\0")), Sub("DATA", new byte[8]) })]);

    private static byte[] CompressedRecord(string type, uint formId, params byte[][] subrecords)
    {
        var payload = subrecords.SelectMany(s => s).ToArray();
        using var stream = new MemoryStream();
        stream.Write(BitConverter.GetBytes(payload.Length));
        using (var zlib = new ZLibStream(stream, CompressionLevel.Optimal, leaveOpen: true))
            zlib.Write(payload);
        var record = Record(type, formId);
        var data = stream.ToArray();
        BinaryPrimitives.WriteUInt32LittleEndian(record.AsSpan(4), (uint)data.Length);
        BinaryPrimitives.WriteUInt32LittleEndian(record.AsSpan(8), 0x00040000);
        return [.. record, .. data];
    }

    private string Write(string name, byte[] bytes)
    {
        var path = Path.Combine(_folder.Path, name);
        File.WriteAllBytes(path, bytes);
        return path;
    }

    private static byte[] Record(string type, uint formId, params byte[][] subrecords)
    {
        var data = subrecords.SelectMany(s => s).ToArray();
        var header = new byte[24];
        Encoding.ASCII.GetBytes(type).CopyTo(header, 0);
        BinaryPrimitives.WriteUInt32LittleEndian(header.AsSpan(4), (uint)data.Length);
        BinaryPrimitives.WriteUInt32LittleEndian(header.AsSpan(12), formId);
        return [.. header, .. data];
    }

    private static byte[] Sub(string sig, byte[] payload)
    {
        var header = new byte[6];
        Encoding.ASCII.GetBytes(sig).CopyTo(header, 0);
        BinaryPrimitives.WriteUInt16LittleEndian(header.AsSpan(4), (ushort)payload.Length);
        return [.. header, .. payload];
    }
}
