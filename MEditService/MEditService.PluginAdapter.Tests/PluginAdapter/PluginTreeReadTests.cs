using MEditService.Codec.Serialization;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;

namespace MEditService.PluginAdapter.Tests.PluginAdapter;

/// <summary>Every compile reads its source tree through a scratch folder of the door's own, which never
/// outlives the read, however the read ends.</summary>
public sealed class PluginTreeReadTests
{
    private static readonly IPluginAdapter Adapter = TestAdapters.Mutagen();

    private static readonly RecordTextCodec Codec = new(NullLogger<RecordTextCodec>.Instance);

    private static HashSet<string> ScratchFolders() =>
        [.. Directory.GetDirectories(Path.GetTempPath(), $"{MutagenPluginAdapter.ReadScratchPrefix}*")];

    [Fact]
    public async Task ReadTree_OfAFileItCannotWrite_Throws_AndLeavesNoScratchFolderBehind()
    {
        var before = ScratchFolders();
        var unwritable = new TreeFile(Path.Combine("Tree.esp", new string('n', 300) + ".json"), "{}"u8.ToArray());

        await Assert.ThrowsAnyAsync<IOException>(() => Adapter.ReadTreeAsync([unwritable], Codec, GameRelease.Fallout4));

        Assert.Empty(ScratchFolders().Except(before));
    }

    [Fact]
    public async Task ReadTree_OfASourceItCannotRead_AnswersTheDiagnosis_AndLeavesNoScratchFolderBehind()
    {
        var before = ScratchFolders();
        var unreadable = new TreeFile(Path.Combine("Tree.esp", "RecordData.json"), "{ not json"u8.ToArray());

        var (tree, diagnosis, _) = await Adapter.ReadTreeAsync([unreadable], Codec, GameRelease.Fallout4);

        Assert.Null(tree);
        Assert.NotNull(diagnosis);
        Assert.Empty(ScratchFolders().Except(before));
    }
}
