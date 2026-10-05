using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceTransactionTests : IDisposable
{
    private const GameRelease Release = GameRelease.Fallout4;
    private const string PluginName = "Fixture.esp";
    private const int ActsInTheSequence = 5;
    private static readonly PluginAddress Plugin = new(PluginName, "FixtureMod");

    public static TheoryData<int> EveryActPosition => [.. Enumerable.Range(0, ActsInTheSequence)];

    private readonly ScratchDirectory _root = new("medit-swt-");

    private SourceRepository Repo => SourceRepository.Over(TestMod.In(_root), Release);

    public void Dispose() => _root.Dispose();

    private static string Fk(string hex) => $"{hex}:{PluginName}";

    private static readonly IReadOnlyDictionary<string, RecordTableSchema> Schemas =
        SharedSchemaReflector.Instance.GetSchemas(Release);

    private static readonly DocumentRekey RewritesTheKey = new(
        (document, newFormKey) => document.Body.Replace(document.FormKey, newFormKey, StringComparison.Ordinal),
        (_, _, _) => null);

    private void Rekey(SourceTransaction transaction, string recordType, string editorId, string from, string to) =>
        transaction.Rekey(Repo, Plugin, new RecordIdentity(Fk(from), recordType, editorId), Fk(to), Schemas, RewritesTheKey);

    private static string Body(string formKey, string editorId) =>
        $"{{\n  \"FormKey\": \"{formKey}\",\n  \"EditorID\": \"{editorId}\"\n}}";

    private void Seed(string formKey, string recordType, string editorId) =>
        Repo.Put(Plugin, new SourceDocument(formKey, recordType, editorId, Body(formKey, editorId)));

    private static string FlatFile(string root, string formKey, string recordType, string editorId) =>
        SourceDocumentPath.Of(root, PluginName, recordType, formKey, editorId, Release);

    private string FlatFile(string formKey, string recordType, string editorId) =>
        FlatFile(_root, formKey, recordType, editorId);

    private string ContainerDirectory(string formKey, string recordType, string editorId)
    {
        var documentPath = SourceDocumentPath.Of(_root, PluginName, recordType, formKey, editorId, Release);
        return Path.GetDirectoryName(documentPath)
            ?? throw new InvalidOperationException($"Expected '{documentPath}' to have a parent directory.");
    }

    private static void BlockTheWriteThenRenameWithADirectoryAtTheDestinationsTmpName(string path) => Directory.CreateDirectory(path + ".tmp");

    [Fact]
    public void Rollback_PutsBackADocumentMovedToTheLeafNameItsNewEditorIdGivesIt()
    {
        Seed(Fk("000800"), "npc_", "OldName");
        var before = TreeSnapshot.Of(_root);

        var transaction = new SourceTransaction();
        transaction.Put(Repo, Plugin, new SourceDocument(Fk("000800"), "npc_", "NewName", Body(Fk("000800"), "NewName")));

        Assert.True(File.Exists(FlatFile(Fk("000800"), "npc_", "NewName")));
        Assert.Empty(transaction.Undo(Repo));
        Assert.Equal(before, TreeSnapshot.Of(_root));
    }

    [Fact]
    public void Rollback_PutsBackAFileSomethingElseRenamed_ThatThePutMovedToItsLayoutName()
    {
        Seed(Fk("000800"), "npc_", "Npc");
        var group = Directory.GetFiles(_root, "*.json", SearchOption.AllDirectories).Single();
        File.Move(group, Path.Combine(Path.GetDirectoryName(group) ?? _root, $"RenamedOutside - 000800_{PluginName}.json"));
        var before = TreeSnapshot.Of(_root);

        var transaction = new SourceTransaction();
        transaction.Put(Repo, Plugin, new SourceDocument(Fk("000800"), "npc_", "Npc", Body(Fk("000800"), "Rewritten")));

        Assert.True(File.Exists(FlatFile(Fk("000800"), "npc_", "Npc")));
        Assert.Empty(transaction.Undo(Repo));
        Assert.Equal(before, TreeSnapshot.Of(_root));
    }

    [Fact]
    public void Rollback_PutsBackAnOverwrite_ACreate_ARemove_AndAMovedContainer()
    {
        Seed(Fk("000800"), "npc_", "ExistingNpc");
        Seed(Fk("000801"), "npc_", "DoomedNpc");
        Seed(Fk("000900"), "wrld", "Home");
        const string emptyDirectoryThatTravelsWithTheMoveAndNoGitBasedOracleWouldSee = "Empty";
        Directory.CreateDirectory(Path.Combine(
            ContainerDirectory(Fk("000900"), "wrld", "Home"), emptyDirectoryThatTravelsWithTheMoveAndNoGitBasedOracleWouldSee));
        var before = TreeSnapshot.Of(_root);

        var transaction = new SourceTransaction();
        transaction.Put(
            Repo, Plugin, new SourceDocument(Fk("000800"), "npc_", "ExistingNpc", Body(Fk("000800"), "Rewritten")));
        transaction.Put(
            Repo, Plugin, new SourceDocument(Fk("000802"), "npc_", "NewNpc", Body(Fk("000802"), "NewNpc")));
        Rekey(transaction, "npc_", "DoomedNpc", "000801", "000803");
        Rekey(transaction, "wrld", "Home", "000900", "000901");

        Assert.NotEqual(before, TreeSnapshot.Of(_root));
        Assert.Empty(transaction.Undo(Repo));
        Assert.Equal(before, TreeSnapshot.Of(_root));
    }

    [Fact]
    public void Rollback_TakesBackThePluginRootAndGroupFolderAndFileMintedInOnePut_NotJustTheFile()
    {
        var before = TreeSnapshot.Of(_root);

        var transaction = new SourceTransaction();
        transaction.Put(Repo, Plugin, new SourceDocument(Fk("000800"), "npc_", "FreshNpc", Body(Fk("000800"), "FreshNpc")));

        Assert.True(Directory.Exists(Path.Combine(_root, "plugin-source", PluginName, "Npcs")));
        Assert.Empty(transaction.Undo(Repo));
        Assert.Equal(before, TreeSnapshot.Of(_root));
    }

    [Fact]
    public void Rollback_TakesBackANewExteriorCell_AndTheBlockLevelsItsPutMinted()
    {
        Seed(Fk("000900"), "wrld", "Home");
        var before = TreeSnapshot.Of(_root);

        var transaction = new SourceTransaction();
        const string body = "{\n  \"FormKey\": \"000910:Fixture.esp\",\n  \"EditorID\": \"Out\",\n  \"Grid\": {\n    \"Point\": \"9, -9\"\n  }\n}";
        transaction.PutInWorldspace(Repo, Plugin, new SourceDocument(Fk("000910"), "cell", "Out", body), Fk("000900"));

        Assert.Equal(Fk("000910"), Repo.GetCellAt(Plugin, Fk("000900"), 9, -9, Schemas)?.FormKey);
        Assert.Empty(transaction.Undo(Repo));
        Assert.Equal(before, TreeSnapshot.Of(_root));
    }

    [Fact]
    public void Rollback_LeavesAMintedDirectoryAThirdPartyHasSinceFilled()
    {
        var transaction = new SourceTransaction();
        transaction.Put(Repo, Plugin, new SourceDocument(Fk("000800"), "npc_", "FreshNpc", Body(Fk("000800"), "FreshNpc")));

        var pluginRoot = Path.Combine(_root, "plugin-source", PluginName);
        File.WriteAllText(Path.Combine(pluginRoot, "theirs.json"), "another tool's");

        Assert.Empty(transaction.Undo(Repo));
        Assert.True(File.Exists(Path.Combine(pluginRoot, "theirs.json")));
        Assert.False(Directory.Exists(Path.Combine(pluginRoot, "Npcs")));
    }

    [Fact]
    public void Rollback_UndoesTwoContainerMovesWhereTheSecondLandsWhereTheFirstVacated_InReverse_SoNeitherLandsOnTheOther()
    {
        Seed(Fk("000900"), "wrld", "Shared");
        Seed(Fk("000901"), "wrld", "Shared");
        var before = TreeSnapshot.Of(_root);

        var transaction = new SourceTransaction();
        Rekey(transaction, "wrld", "Shared", "000900", "000902");
        Rekey(transaction, "wrld", "Shared", "000901", "000900");

        Assert.NotEqual(before, TreeSnapshot.Of(_root));
        Assert.Empty(transaction.Undo(Repo));
        Assert.Equal(before, TreeSnapshot.Of(_root));
    }

    [Fact]
    public void Rollback_KeepsAThirdPartysBytes_RestoresEverythingElse_AndNamesOnlyThatFile()
    {
        Seed(Fk("000800"), "npc_", "Contested");
        Seed(Fk("000801"), "npc_", "Quiet");

        var transaction = new SourceTransaction();
        transaction.Put(Repo, Plugin, new SourceDocument(Fk("000800"), "npc_", "Contested", Body(Fk("000800"), "Ours")));
        transaction.Put(Repo, Plugin, new SourceDocument(Fk("000801"), "npc_", "Quiet", Body(Fk("000801"), "OursToo")));

        var contestedFile = FlatFile(Fk("000800"), "npc_", "Contested");
        File.WriteAllText(contestedFile, "someone else's work");

        var unrestored = transaction.Undo(Repo);

        var only = Assert.Single(unrestored);
        Assert.Equal(UnrestoredReason.ChangedByAnother, only.Reason);
        Assert.Equal(
            "plugin-source/Fixture.esp/Npcs/Contested - 000800_Fixture.esp.json", only.RelativePath.Replace('\\', '/'));
        Assert.Equal("someone else's work", File.ReadAllText(contestedFile));
        Assert.Equal(Body(Fk("000801"), "Quiet"), File.ReadAllText(FlatFile(Fk("000801"), "npc_", "Quiet")));
    }

    [Fact]
    public void Rollback_DoesNotResurrectAnOverwrittenFileAThirdPartyDeleted_AndNamesIt()
    {
        Seed(Fk("000800"), "npc_", "Doomed");

        var transaction = new SourceTransaction();
        transaction.Put(Repo, Plugin, new SourceDocument(Fk("000800"), "npc_", "Doomed", Body(Fk("000800"), "Ours")));
        var file = FlatFile(Fk("000800"), "npc_", "Doomed");
        File.Delete(file);

        var only = Assert.Single(transaction.Undo(Repo));
        Assert.Equal(UnrestoredReason.RemovedByAnother, only.Reason);
        Assert.False(File.Exists(file));
    }

    [Fact]
    public void Rollback_NamesACreatedFileAThirdPartyRemoved_RatherThanClaimingItUndidIt()
    {
        var transaction = new SourceTransaction();
        transaction.Put(Repo, Plugin, new SourceDocument(Fk("000800"), "npc_", "Fresh", Body(Fk("000800"), "Ours")));
        File.Delete(FlatFile(Fk("000800"), "npc_", "Fresh"));

        var only = Assert.Single(transaction.Undo(Repo));
        Assert.Equal(UnrestoredReason.RemovedByAnother, only.Reason);
    }

    [Fact]
    public void Rollback_SaysNothingAboutAPutThatChangedNothing()
    {
        Seed(Fk("000800"), "npc_", "Untouched");
        var file = FlatFile(Fk("000800"), "npc_", "Untouched");
        BlockTheWriteThenRenameWithADirectoryAtTheDestinationsTmpName(file);

        var transaction = new SourceTransaction();
        Assert.ThrowsAny<Exception>(() => transaction.Put(
            Repo, Plugin, new SourceDocument(Fk("000800"), "npc_", "Untouched", Body(Fk("000800"), "Rewritten"))));

        Assert.Empty(transaction.Undo(Repo));
        Assert.Equal(Body(Fk("000800"), "Untouched"), File.ReadAllText(file));
    }

    [Fact]
    public void Rollback_ReportsAMoveItCouldNotPutBack_AndStillRestoresTheRest()
    {
        Seed(Fk("000800"), "npc_", "First");
        Seed(Fk("000801"), "npc_", "Second");

        var transaction = new SourceTransaction();
        transaction.Put(Repo, Plugin, new SourceDocument(Fk("000800"), "npc_", "First", Body(Fk("000800"), "Ours")));
        Rekey(transaction, "npc_", "Second", "000801", "000802");

        var movedFrom = FlatFile(Fk("000801"), "npc_", "Second");
        Directory.CreateDirectory(movedFrom);

        var only = Assert.Single(transaction.Undo(Repo));
        Assert.Equal(UnrestoredReason.OccupiedByAnother, only.Reason);
        Assert.Equal(Path.GetRelativePath(_root, movedFrom), only.RelativePath);
        Assert.Equal(Body(Fk("000800"), "First"), File.ReadAllText(FlatFile(Fk("000800"), "npc_", "First")));
    }

    [Fact]
    public void Rollback_ReportsAMoveTheFileSystemRefusedToPutBack_WithItsWords()
    {
        Seed(Fk("000800"), "npc_", "Moved");
        var from = Path.GetRelativePath(_root, FlatFile(Fk("000800"), "npc_", "Moved"));
        var to = Path.Combine("Elsewhere", Path.GetFileName(from));
        Directory.CreateDirectory(Path.Combine(_root, "Elsewhere"));

        var transaction = new SourceTransaction();
        transaction.Apply(Repo, new SourceChanges([new SourceMove(from, to)], []));
        var folderItLeft = Path.GetDirectoryName(Path.Combine(_root, from)).Require();
        Directory.Delete(folderItLeft);

        var only = Assert.Single(transaction.Undo(Repo));
        Assert.Equal(UnrestoredReason.RestoreFailed, only.Reason);
        Assert.Equal(from, only.RelativePath);
        Assert.NotNull(only.Error);
        Assert.True(File.Exists(Path.Combine(_root, to)));
    }

    [Fact]
    public void Rollback_PutsBackAContainerWhoseRekeyFailedAfterItsMove()
    {
        Seed(Fk("000900"), "wrld", "Home");
        BlockTheWriteThenRenameWithADirectoryAtTheDestinationsTmpName(
            Path.Combine(ContainerDirectory(Fk("000900"), "wrld", "Home"), "RecordData.json"));
        var before = TreeSnapshot.Of(_root);

        var transaction = new SourceTransaction();
        Assert.ThrowsAny<Exception>(() => Rekey(transaction, "wrld", "Home", "000900", "000901"));

        Assert.Empty(transaction.Undo(Repo));
        Assert.Equal(before, TreeSnapshot.Of(_root));
    }

    [Fact]
    public void TheSequenceHoldsExactlyTheActsTheFailAtAnActTheoryCovers()
    {
        SeedTree();

        Assert.Equal(ActsInTheSequence, RunSequence(new SourceTransaction(), failAt: int.MaxValue));
    }

    [Theory]
    [MemberData(nameof(EveryActPosition))]
    public void FailingTheSequenceAtAnAct_LeavesTheTreeUnchanged(int failAt)
    {
        SeedTree();
        var before = TreeSnapshot.Of(_root);

        var transaction = new SourceTransaction();
        Assert.ThrowsAny<Exception>(() => RunSequence(transaction, failAt));
        Assert.Empty(transaction.Undo(Repo));
        Assert.Equal(before, TreeSnapshot.Of(_root));
    }

    private void SeedTree()
    {
        Seed(Fk("000800"), "npc_", "NpcA");
        Seed(Fk("000801"), "npc_", "NpcB");
        Seed(Fk("000900"), "wrld", "Home");
        Directory.CreateDirectory(Path.Combine(ContainerDirectory(Fk("000900"), "wrld", "Home"), "Empty"));
        Seed(Fk("000A00"), "race", "DoomedRace");
        Seed(Fk("000902"), "wrld", "Other");
    }

    private int RunSequence(SourceTransaction transaction, int failAt)
    {
        var act = 0;
        void At(int position, Action perform)
        {
            if (act++ == position) throw new IOException($"injected failure at act {position}");
            perform();
        }

        At(failAt, () => transaction.Put(
            Repo, Plugin, new SourceDocument(Fk("000800"), "npc_", "NpcA", Body(Fk("000800"), "NpcA rewritten"))));
        At(failAt, () => transaction.Put(
            Repo, Plugin, new SourceDocument(Fk("000801"), "npc_", "NpcB", Body(Fk("000801"), "NpcB rewritten"))));
        At(failAt, () => Rekey(transaction, "wrld", "Home", "000900", "000901"));
        At(failAt, () => Rekey(transaction, "race", "DoomedRace", "000A00", "000A01"));
        At(failAt, () => Rekey(transaction, "wrld", "Other", "000902", "000903"));
        return act;
    }
}
