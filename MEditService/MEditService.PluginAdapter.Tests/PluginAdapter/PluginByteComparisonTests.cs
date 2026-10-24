using System.IO.Compression;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using static MEditService.TestSupport.RawPlugin;

namespace MEditService.PluginAdapter.Tests.PluginAdapter;

public sealed class PluginByteComparisonTests : IDisposable
{
    private static readonly IPluginAdapter Adapter = TestAdapters.Mutagen();

    private readonly ScratchDirectory _folder = new("plugin-byte-comparison");

    public void Dispose() => _folder.Dispose();

    [Fact]
    public async Task TwoFilesWithTheSameBytes_AreIdentical()
    {
        var record = Record("WEAP", 1, Subrecord("EDID", "Gun\0"u8.ToArray()));

        var comparison = (await Adapter.CompareBytesAsync(Write("a.esp", record), Write("b.esp", record), EmptyLoadOrder.Of(GameRelease.Fallout4))).Answered();

        Assert.True(comparison.Identical);
        Assert.Null(comparison.Loss);
        Assert.Null(comparison.LossCauses);
    }

    [Fact]
    public async Task ARewriteThatDroppedASubrecordOfAWellFormedRecord_IsNotIdentical_AndNamesNoCause()
    {
        var original = Record("WEAP", 0x10, Subrecord("EDID", "Gun\0"u8.ToArray()), Subrecord("RDMP", [1]));
        var rewritten = Record("WEAP", 0x10, Subrecord("EDID", "Gun\0"u8.ToArray()));

        var comparison = (await Adapter.CompareBytesAsync(Write("a.esp", original), Write("b.esp", rewritten), EmptyLoadOrder.Of(GameRelease.Fallout4))).Answered();

        Assert.False(comparison.Identical);
        Assert.Null(comparison.LossCauses);
    }

    [Fact]
    public async Task ADropOnARecordTheOriginalMalformed_CarriesThatRecordsDiagnosis()
    {
        var original = Record("REGN", 0x20, Subrecord("EDID", "Region\0"u8.ToArray()), Subrecord("RDAT", new byte[6]));
        var rewritten = Record("REGN", 0x20, Subrecord("EDID", "Region\0"u8.ToArray()));

        var comparison = (await Adapter.CompareBytesAsync(Write("a.esp", original), Write("b.esp", rewritten), EmptyLoadOrder.Of(GameRelease.Fallout4))).Answered();

        Assert.Equal("fixed-size-subrecord-short", comparison.LossCauses?.Single().Diagnosis.DefectClass);
        Assert.StartsWith("REGN 00000020", comparison.LossCauses?.Single().Diagnosis.Anchor);
    }

    [Fact]
    public async Task ARewriteLackingARecord_NamesItAsAbsent()
    {
        var kept = Record("MISC", 3, Subrecord("DATA", [1]));
        var lost = Record("MISC", 4, Subrecord("DATA", [1]));

        var unverified = await UnverifiedAsync([.. kept, .. lost], kept);

        Assert.Equal(("MISC", "000004:a.esp", UnverifiedReason.AbsentFromRewrite),
            (unverified?.RecordType, unverified?.FormKey.ToString(), unverified?.Reason));
    }

    [Fact]
    public async Task TwoOriginalRecordsOfOneIdentity_NeedTwoInTheRewrite()
    {
        var record = Record("MISC", 3, Subrecord("DATA", [1]));

        var unverified = await UnverifiedAsync([.. record, .. record], record);

        Assert.Equal(UnverifiedReason.AbsentFromRewrite, unverified?.Reason);
    }

    [Fact]
    public async Task APairWhoseCompressionDiffers_IsNotComparable()
    {
        var payload = Subrecord("DATA", [1]);

        var unverified = await UnverifiedAsync([.. Tes4(), .. Record("MISC", 3, payload)], [.. Tes4(), .. DeflatedRecord("MISC", 3, CompressionLevel.Optimal, payload)]);

        Assert.Equal(("MISC", UnverifiedReason.NotComparable), (unverified?.RecordType, unverified?.Reason));
    }

    [Fact]
    public async Task APairBothCompressedAndRead_IsVerified()
    {
        var payload = Subrecord("DATA", [1]);

        Assert.Null(await UnverifiedAsync([.. Tes4(), .. DeflatedRecord("MISC", 3, CompressionLevel.Optimal, payload)], [.. Tes4(), .. DeflatedRecord("MISC", 3, CompressionLevel.Optimal, payload)]));
    }

    [Fact]
    public async Task WhenTheRewritePrunesAMaster_ThePluginHeaderStillPairs()
    {
        var unverified = await UnverifiedAsync(Tes4(masters: ["A.esm", "B.esm"]), Tes4(masters: ["B.esm"]));

        Assert.Null(unverified);
    }

    private async Task<UnverifiedRecord?> UnverifiedAsync(byte[] original, byte[] rewritten) =>
        (await Adapter.CompareBytesAsync(Write("a.esp", original), Write("b.esp", rewritten), EmptyLoadOrder.Of(GameRelease.Fallout4)))
        .Answered().Unverified;

    private string Write(string name, byte[] bytes)
    {
        var path = Path.Combine(_folder.Path, name);
        File.WriteAllBytes(path, bytes);
        return path;
    }
}
