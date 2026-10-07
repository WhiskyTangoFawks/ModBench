using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceRepositoryMintingTests : IDisposable
{
    private static readonly PluginAddress Plugin = new("Minting.esp", "MintingMod");

    private readonly ScratchDirectory _modFolder = new("medit-minting-");

    public void Dispose() => _modFolder.Dispose();

    private SourceRepository Tracked()
    {
        PluginBaselines.Track(
            _modFolder,
            [new TreeFile("plugin-source/Other.esp/Npcs/Other - 000001_Other.esp.json", "{}"u8.ToArray())]);
        return SourceRepository.Open(TestMod.In(_modFolder), GameRelease.Fallout4)
            ?? throw new InvalidOperationException($"Expected '{_modFolder}' to be tracked.");
    }

    [Fact]
    public void APutThatSucceeds_MintsThePluginRootAndGroupFolder_WhichTheFailingPutBelowLeavesNoneOf()
    {
        var repository = Tracked();

        repository.Put(Plugin, new SourceDocument("000800:Minting.esp", "npc_", "Fits", "{\"FormKey\": \"000800:Minting.esp\"}"));

        Assert.True(Directory.Exists(Path.Combine(PluginSourceRoot.In(_modFolder, Plugin.Name), "Npcs")));
    }

    [Theory]
    [InlineData("qust", "Quests")]
    [InlineData("wrld", "Worldspaces")]
    [InlineData("cell", "Cells")]
    public void APutOfATypeHoldingChildren_LandsUnderItsGroupFolder(string recordType, string groupFolder)
    {
        var repository = Tracked();

        repository.Put(Plugin, new SourceDocument("000800:Minting.esp", recordType, "Holder", "{\"FormKey\": \"000800:Minting.esp\"}"));

        var root = PluginSourceRoot.In(_modFolder, Plugin.Name);
        var files = Directory.EnumerateFiles(root, "*.json", SearchOption.AllDirectories).ToList();
        Assert.NotEmpty(files);
        Assert.All(files, file => Assert.Equal(groupFolder, Path.GetRelativePath(root, file).Split(Path.DirectorySeparatorChar)[0]));
    }

    [Fact]
    public void APutWhoseWriteFailsAfterTheDirectoriesAboveItWereMinted_LeavesNoneOfThem()
    {
        var repository = Tracked();
        var originWhoseFileNameNoFilesystemTakesAsALeaf = new string('a', 300) + ".esp";
        var formKey = $"000800:{originWhoseFileNameNoFilesystemTakesAsALeaf}";

        Assert.ThrowsAny<IOException>(() => repository.Put(
            Plugin, new SourceDocument(formKey, "npc_", "Overlong", $"{{\"FormKey\": \"{formKey}\"}}")));

        Assert.False(Directory.Exists(PluginSourceRoot.In(_modFolder, Plugin.Name)));
    }
}
