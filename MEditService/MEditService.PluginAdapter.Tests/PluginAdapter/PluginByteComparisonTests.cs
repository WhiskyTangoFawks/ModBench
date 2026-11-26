using System.IO.Compression;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
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

    private static readonly byte[] Kept = Record("MISC", 3, Subrecord("DATA", [1]));

    private static UnverifiedRecord Misc(UnverifiedReason reason, string formKey) => new(reason, "MISC", FormKey.Factory(formKey));

    public static TheoryData<string, byte[], byte[], UnverifiedRecord?> Pairings => new()
    {
        { "a rewrite lacking a record", [.. Kept, .. Record("MISC", 4, Subrecord("DATA", [1]))], Kept, Misc(UnverifiedReason.AbsentFromRewrite, "000004:a.esp") },
        { "two original records of one identity and one rewritten", [.. Kept, .. Kept], Kept, Misc(UnverifiedReason.AbsentFromRewrite, "000003:a.esp") },
        {
            "a pair whose compression differs",
            [.. Tes4(), .. Kept], [.. Tes4(), .. DeflatedRecord("MISC", 3, CompressionLevel.Optimal, Subrecord("DATA", [1]))],
            Misc(UnverifiedReason.NotComparable, "000003:a.esp")
        },
        {
            "a pair both compressed and read",
            [.. Tes4(), .. DeflatedRecord("MISC", 3, CompressionLevel.Optimal, Subrecord("DATA", [1]))],
            [.. Tes4(), .. DeflatedRecord("MISC", 3, CompressionLevel.Optimal, Subrecord("DATA", [1]))],
            null
        },
        { "a plugin header whose rewrite prunes a master", Tes4(masters: ["A.esm", "B.esm"]), Tes4(masters: ["B.esm"]), null },
    };

    [Theory]
    [MemberData(nameof(Pairings))]
    public async Task ARecordTheRewriteDoesNotHoldIntact_IsNamedWithWhy(string _, byte[] original, byte[] rewritten, UnverifiedRecord? unverified)
    {
        Assert.Equal(unverified, await UnverifiedAsync(original, rewritten));
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
