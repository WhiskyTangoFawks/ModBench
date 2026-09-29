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

    // The adapter's own scratch prefix, spelled here as a leak watcher sees it on disk.
    private const string ScratchPrefix = "medit-readtree-";

    // Other sessions share the temp folder, so a test asserts only on the folders its own read added.
    private static HashSet<string> ScratchFolders() =>
        [.. Directory.GetDirectories(Path.GetTempPath(), $"{ScratchPrefix}*")];

    // A folder named with the prefix is found by the glob, so the leak checks cannot pass on a
    // pattern that matches nothing.
    [Fact]
    public void TheScratchGlob_FindsAFolderNamedWithThePrefix()
    {
        var canary = Directory.CreateTempSubdirectory($"{ScratchPrefix}canary-").FullName;
        try
        {
            Assert.Contains(canary, ScratchFolders());
        }
        finally
        {
            Directory.Delete(canary);
        }
    }

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
