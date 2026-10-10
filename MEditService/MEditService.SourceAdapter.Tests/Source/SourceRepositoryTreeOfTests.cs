using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceRepositoryTreeOfTests : IDisposable
{
    private const string PluginName = "TreeOf.esp";
    private const string NpcFormKey = "000800:TreeOf.esp";
    private const string NpcEditorId = "FixtureNpc";
    private const string NpcBody = "{\n  \"FormKey\": \"000800:TreeOf.esp\",\n  \"EditorID\": \"FixtureNpc\"\n}";

    private static readonly PluginAddress Plugin = new(PluginName, TestMod.Name);
    private static readonly RecordIdentity Npc = new(NpcFormKey, "npc_", NpcEditorId);

    private readonly ScratchDirectory _modFolder = new("medit-treeof-");

    public SourceRepositoryTreeOfTests()
    {
        PluginBaselines.Track(
            _modFolder,
            [new TreeFile(PluginSourceRoot.HeaderDocument(PluginName), "{\"MasterReferences\": []}"u8.ToArray())]);
        Repository.Put(Plugin, new SourceDocument(NpcFormKey, "npc_", NpcEditorId, NpcBody)).Wrote();
        CommitSoBothRefsHoldTheTree();
    }

    private void CommitSoBothRefsHoldTheTree()
    {
        Git("add", "-A");
        Git("commit", "-q", "-m", "the fixture's npc");
    }

    public void Dispose() => _modFolder.Dispose();

    private string Git(params string[] args) =>
        GitProbe.Run(Path.Combine(_modFolder, ".git"), _modFolder, args);

    private ISourceRepository Repository =>
        TestAdapters.Source().Open(TestMod.In(_modFolder), GameRelease.Fallout4)
            ?? throw new InvalidOperationException($"Expected '{_modFolder}' to already be tracked.");

    private string NpcRelativePath =>
        Repository.RelativePathOf(Plugin, Npc).Value()
            ?? throw new InvalidOperationException($"Expected the tree to hold {NpcFormKey}.");

    private string NpcFullPath => Path.Combine(_modFolder, NpcRelativePath);

    [Fact]
    public void TreeOf_AnswersEveryFileUnderThePluginsSourceRoot_AsTheDoorNamesIt_WithItsOwnBytes()
    {
        var files = Repository.TreeOf(Plugin).Value().Files;

        var npcDoorPath = Path.Combine("Npcs", "FixtureNpc - 000800_TreeOf.esp.json");
        Assert.Equal([npcDoorPath, "RecordData.json"], [.. files.Select(f => f.RelativePath).Order(StringComparer.Ordinal)]);
        Assert.Equal(File.ReadAllBytes(NpcFullPath), files.Single(f => f.RelativePath == npcDoorPath).Content);
    }

    [Fact]
    public void TreeOf_AfterAPutThroughTheSameSession_AnswersTheTreeAsItNowStands_NotFromAMemoOfBeforeTheWrite()
    {
        var session = TestAdapters.Source().WriteSessionOver(TestMod.In(_modFolder), GameRelease.Fallout4, []);
        var repository = session.Repository;
        var before = repository.TreeOf(Plugin).Value().Files.Count;

        session.Atomically(() => session.Apply(repository.ChangesToPut(
            Plugin,
            new SourceDocument(
                "000950:TreeOf.esp", "npc_", "MemoNpc",
                "{\n  \"FormKey\": \"000950:TreeOf.esp\",\n  \"EditorID\": \"MemoNpc\"\n}")))).Wrote();

        Assert.Equal(before + 1, repository.TreeOf(Plugin).Value().Files.Count);
    }

    [Fact]
    public void TreeOf_WhenAFileCannotBeRead_NamesThatFile_AndAnswersNoFiles_NotHalfATreeACallerTakesForASmallerOne()
    {
        var npcRelativePath = NpcRelativePath;
        using var held = new FileStream(NpcFullPath, FileMode.Open, FileAccess.Read, FileShare.None);

        var files = Repository.TreeOf(Plugin).Value();

        Assert.Equal(npcRelativePath, files.Unreadable);
        Assert.Empty(files.Files);
    }

    [Fact]
    public void TreeOf_ForAPluginTheTreeHoldsNoSourceFor_IsEmpty()
    {
        var stranger = new PluginAddress("Stranger.esp", Plugin.Origin);

        Assert.Empty(Repository.TreeOf(stranger).Value().Files);
    }
}
