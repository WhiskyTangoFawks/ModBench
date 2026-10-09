using System.Buffers.Binary;
using System.Text;
using MEditService.TestSupport;

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

        var comparison = (await Adapter.CompareBytesAsync(Write("a.esp", record), Write("b.esp", record))).Answered();

        Assert.True(comparison.Identical);
        Assert.Null(comparison.Loss);
        Assert.Null(comparison.LossCause);
    }

    [Fact]
    public async Task ARewriteThatDroppedASubrecord_NamesTheRecordAndItsSignatures()
    {
        var original = Record("WEAP", 0x10, Sub("EDID", "Gun\0"u8.ToArray()), Sub("RDMP", [1]));
        var rewritten = Record("WEAP", 0x10, Sub("EDID", "Gun\0"u8.ToArray()));

        var comparison = (await Adapter.CompareBytesAsync(Write("a.esp", original), Write("b.esp", rewritten))).Answered();

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

        var comparison = (await Adapter.CompareBytesAsync(Write("a.esp", original), Write("b.esp", rewritten))).Answered();

        Assert.Equal("fixed-size-subrecord-short", comparison.LossCause?.DefectClass);
        Assert.StartsWith("REGN 00000020", comparison.LossCause?.Anchor);
    }

    [Fact]
    public async Task ADifferenceThatDroppedNothing_IsNeitherIdenticalNorALoss()
    {
        var original = Record("MISC", 3, Sub("DATA", [1]));
        var rewritten = Record("MISC", 3, Sub("DATA", [2]));

        var comparison = (await Adapter.CompareBytesAsync(Write("a.esp", original), Write("b.esp", rewritten))).Answered();

        Assert.False(comparison.Identical);
        Assert.Null(comparison.Loss);
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
