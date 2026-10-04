using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceRepositoryDivergenceTests : IDisposable
{
    private const string PluginName = "Diverge.esp";
    private const string NpcFormKey = "000800:Diverge.esp";
    private const string NpcBody = "{\n  \"FormKey\": \"000800:Diverge.esp\",\n  \"EditorID\": \"FixtureNpc\"\n}";

    private static readonly PluginAddress Plugin = new(PluginName, "DivergeMod");

    private readonly ScratchDirectory _modFolder = new("medit-diverge-");

    public SourceRepositoryDivergenceTests()
    {
        PluginBaselines.Track(
            _modFolder,
            SourcePreset.Edits,
            [new TreeFile(SourceRepository.HeaderDocumentFor(PluginName), "{\"MasterReferences\": []}"u8.ToArray())]);
        Repository.Put(Plugin, new SourceDocument(NpcFormKey, "npc_", "FixtureNpc", NpcBody));
    }

    public void Dispose() => _modFolder.Dispose();

    private SourceRepository Repository =>
        SourceRepository.Open(_modFolder, GameRelease.Fallout4)
            ?? throw new InvalidOperationException($"Expected '{_modFolder}' to already be tracked.");

    private List<TreeFile> SerializedAsTheDoorWritesIt() =>
    [
        .. Repository.FilesOf(Plugin).Files.Select(file => new TreeFile(
            Path.GetRelativePath(SourceRepository.RootFor(PluginName), file.RelativePath), file.Content)),
    ];

    [Fact]
    public void DivergenceFrom_ASerializationOfTheSameTree_IsNone()
    {
        Assert.Null(Repository.DivergenceFrom(Plugin, SerializedAsTheDoorWritesIt()));
    }

    [Fact]
    public void DivergenceFrom_ADocumentTheSerializationSpellsDifferently_IsChanged_AtThatDocument()
    {
        var serialized = SerializedAsTheDoorWritesIt();
        var npc = serialized.Single(file => file.RelativePath != "RecordData.json");
        serialized[serialized.IndexOf(npc)] = npc with { Content = "{}"u8.ToArray() };

        var divergence = Repository.DivergenceFrom(Plugin, serialized);

        Assert.Equal(
            new SourceDivergence(
                SourceDivergenceKind.Changed, SourceRepository.RootFor(PluginName) + Path.DirectorySeparatorChar + npc.RelativePath,
                IsHeader: false),
            divergence);
    }

    [Fact]
    public void DivergenceFrom_TheHeaderSpelledDifferently_IsChanged_AndSaysItIsTheHeader()
    {
        var serialized = SerializedAsTheDoorWritesIt();
        var header = serialized.Single(file => file.RelativePath == "RecordData.json");
        serialized[serialized.IndexOf(header)] = header with { Content = "{}"u8.ToArray() };

        var divergence = Repository.DivergenceFrom(Plugin, serialized);

        Assert.Equal(SourceDivergenceKind.Changed, divergence?.Kind);
        Assert.True(divergence?.IsHeader);
    }

    [Fact]
    public void DivergenceFrom_ADocumentOnDiskTheSerializationDoesNotProduce_IsUnproduced_AtThatDocument()
    {
        var serialized = SerializedAsTheDoorWritesIt();
        var npc = serialized.Single(file => file.RelativePath != "RecordData.json");
        serialized.Remove(npc);

        var divergence = Repository.DivergenceFrom(Plugin, serialized);

        Assert.Equal(SourceDivergenceKind.Unproduced, divergence?.Kind);
        Assert.Equal(
            SourceRepository.RootFor(PluginName) + Path.DirectorySeparatorChar + npc.RelativePath, divergence?.Path);
    }
}
