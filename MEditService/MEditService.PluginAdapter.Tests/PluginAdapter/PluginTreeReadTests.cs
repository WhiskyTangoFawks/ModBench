using System.Text;
using MEditService.Codec.Serialization;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Serialization.Exceptions;

namespace MEditService.PluginAdapter.Tests.PluginAdapter;

public sealed class PluginTreeReadTests
{
    private static readonly IPluginAdapter Adapter = TestAdapters.Mutagen();

    private static readonly RecordTextCodec Codec = new(NullLogger<RecordTextCodec>.Instance);

    private const string TheAdaptersOwnScratchPrefix = "medit-readtree-";

    [Fact]
    public async Task ReadTree_OfAFileItCannotWrite_Throws_AndLeavesNoScratchFolderBehind()
    {
        using var scratchRoot = new ScratchDirectory("readtree-scratch-root-");
        var unwritable = new TreeFile(Path.Combine("Tree.esp", new string('n', 300) + ".json"), "{}"u8.ToArray());

        await Assert.ThrowsAnyAsync<IOException>(
            () => MutagenPluginAdapter.ReadTreeAsync([unwritable], Codec, GameRelease.Fallout4, scratchRoot));

        Assert.Empty(Directory.GetDirectories(scratchRoot));
    }

    [Fact]
    public async Task ReadTree_OfASourceItCannotRead_AnswersTheDiagnosis_AndLeavesNoScratchFolderBehind()
    {
        using var scratchRoot = new ScratchDirectory("readtree-scratch-root-");
        var unreadable = new TreeFile(Path.Combine("Tree.esp", "RecordData.json"), "{ not json"u8.ToArray());

        var (tree, diagnosis, _) =
            await MutagenPluginAdapter.ReadTreeAsync([unreadable], Codec, GameRelease.Fallout4, scratchRoot);

        Assert.Null(tree);
        Assert.NotNull(diagnosis);
        Assert.Empty(Directory.GetDirectories(scratchRoot));
    }

    [Fact]
    public async Task ReadTree_OfAMalformedFormKey_ReadsInAScratchFolder_AndRemovesIt()
    {
        var race = string.Empty;
        using var data = new PluginFixtureBuilder("readtree-scratch")
            .WithPlugin("Tree.esp", mod =>
            {
                var treeRace = mod.Races.AddNew("TreeRace");
                race = treeRace.FormKey.ToString();
                mod.Npcs.AddNew("TreeNpc").Race.SetTo(treeRace);
            })
            .Build();
        var pluginPath = Path.Combine(data.DataFolder, "Tree.esp");
        var files = await Adapter.ReadPristineFilesAsync(
            new ModPath(pluginPath), GameRelease.Fallout4, PluginStrings.In(data.DataFolder));
        var corrupt = files.Select(file => new TreeFile(file.RelativePath,
            Encoding.UTF8.GetBytes(Encoding.UTF8.GetString(file.Content).Replace(race, "NOT-A-FORMKEY", StringComparison.Ordinal))));

        var (_, _, error) = await Adapter.ReadTreeAsync([.. corrupt], Codec, GameRelease.Fallout4);

        var absolutePathTheErrorNamesItsFileBy = Assert.IsType<FilePathedException>(error).Path;
        var scratch = Path.GetRelativePath(Path.GetTempPath(), absolutePathTheErrorNamesItsFileBy).Split(Path.DirectorySeparatorChar)[0];
        Assert.StartsWith(TheAdaptersOwnScratchPrefix, scratch, StringComparison.Ordinal);
        Assert.False(Directory.Exists(Path.GetFullPath(scratch, Path.GetTempPath())));
    }
}
