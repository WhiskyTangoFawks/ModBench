using System.Buffers.Binary;
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
        Assert.Null(comparison.LossCause);
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
        Assert.Null(comparison.LossCause);
    }

    [Fact]
    public async Task ADropOnARecordTheOriginalMalformed_CarriesThatRecordsDiagnosis()
    {
        var original = Record("REGN", 0x20, Sub("EDID", "Region\0"u8.ToArray()), Sub("RDAT", new byte[6]));
        var rewritten = Record("REGN", 0x20, Sub("EDID", "Region\0"u8.ToArray()));

        var comparison = (await Adapter.CompareBytesAsync(Write("a.esp", original), Write("b.esp", rewritten), EmptyLoadOrder.Of(GameRelease.Fallout4))).Answered();

        Assert.Equal("fixed-size-subrecord-short", comparison.LossCause?.DefectClass);
        Assert.StartsWith("REGN 00000020", comparison.LossCause?.Anchor);
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
    public async Task ARewriteLackingARecord_NamesItAsUnverified()
    {
        var kept = Record("MISC", 3, Sub("DATA", [1]));
        var lost = Record("MISC", 4, Sub("DATA", [1]));

        var comparison = (await Adapter.CompareBytesAsync(Write("a.esp", [.. kept, .. lost]), Write("b.esp", kept), EmptyLoadOrder.Of(GameRelease.Fallout4))).Answered();

        Assert.Equal("MISC 000004:a.esp is absent from the rewrite", comparison.Unverified);
    }

    [Fact]
    public async Task APairWhoseCompressionDiffers_IsUnverified()
    {
        var original = Record("MISC", 3, Sub("DATA", [1]));
        var rewritten = Record("MISC", 3, Sub("DATA", [1]));
        BinaryPrimitives.WriteUInt32LittleEndian(rewritten.AsSpan(8), 0x00040000);

        var comparison = (await Adapter.CompareBytesAsync(Write("a.esp", original), Write("b.esp", rewritten), EmptyLoadOrder.Of(GameRelease.Fallout4))).Answered();

        Assert.Equal("MISC 000003:a.esp could not be compared with its rewrite", comparison.Unverified);
    }

    [Fact]
    public async Task EveryRecordPairedAndRead_LeavesNothingUnverified()
    {
        var comparison = (await Adapter.CompareBytesAsync(
            Write("a.esp", Record("MISC", 3, Sub("DATA", [1]))), Write("b.esp", Record("MISC", 3, Sub("DATA", [2]))),
            EmptyLoadOrder.Of(GameRelease.Fallout4))).Answered();

        Assert.Null(comparison.Unverified);
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
