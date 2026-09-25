using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.SourceAdapter.Tests.Source;

/// <summary>Rollback's own mechanics — reverse order, minted directories, third-party interference —
/// proved at the seam every caller crosses: put, remove and move by identity, over one
/// repository.</summary>
public sealed class SourceTransactionTests : IDisposable
{
    private const GameRelease Release = GameRelease.Fallout4;
    private const string PluginName = "Fixture.esp";
    private static readonly PluginAddress Plugin = new(PluginName, "FixtureMod");

    private readonly string _root = Directory.CreateTempSubdirectory("medit-swt-").FullName;

    // Constructed fresh per call rather than held: several tests delete and recreate _root at the
    // same path, and a held instance would answer from a listing cache the recreate invalidated.
    private SourceRepository Repo => SourceRepository.Over(_root, Release);

    public void Dispose()
    {
        try { Directory.Delete(_root, recursive: true); }
        catch (DirectoryNotFoundException) { /* the sweep tears its own tree down */ }
        catch (IOException) { /* scratch directory, best effort */ }
        catch (UnauthorizedAccessException) { /* ditto */ }
    }

    private static string Fk(string hex) => $"{hex}:{PluginName}";

    private static string Body(string formKey, string editorId) =>
        $"{{\n  \"FormKey\": \"{formKey}\",\n  \"EditorID\": \"{editorId}\"\n}}";

    private void Seed(string formKey, string recordType, string editorId) =>
        Repo.Put(Plugin, new SourceDocument(formKey, recordType, editorId, Body(formKey, editorId)));

    // Asked of the tree through the same door a caller uses (Locate), never computed: these records
    // already exist by the time either helper runs.
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

    // A directory at the destination's own ".tmp" name blocks the write-then-rename that lands
    // there, before it ever reaches the real path.
    private static void Block(string path) => Directory.CreateDirectory(path + ".tmp");

    [Fact]
    public void Rollback_PutsBackAnOverwrite_ACreate_ARemove_AndAMovedContainer()
    {
        Seed(Fk("000800"), "npc_", "ExistingNpc");
        Seed(Fk("000801"), "npc_", "DoomedNpc");
        Seed(Fk("000900"), "wrld", "Home");
        // An empty directory inside the container from the start: it has to travel with the move
        // and be there afterwards, and it is the one entry no git-based oracle would see either way.
        Directory.CreateDirectory(Path.Combine(ContainerDirectory(Fk("000900"), "wrld", "Home"), "Empty"));
        var before = TreeSnapshot.Of(_root);

        var transaction = new SourceRepository.SourceTransaction();
        transaction.Put(
            Repo, Plugin, new SourceDocument(Fk("000800"), "npc_", "ExistingNpc", Body(Fk("000800"), "Rewritten")));
        transaction.Put(
            Repo, Plugin, new SourceDocument(Fk("000802"), "npc_", "NewNpc", Body(Fk("000802"), "NewNpc")));
        transaction.Remove(Repo, Plugin, new RecordIdentity(Fk("000801"), "npc_", "DoomedNpc"));
        transaction.Move(Repo, Plugin, new RecordIdentity(Fk("000900"), "wrld", "Home"), Fk("000901"));

        Assert.NotEqual(before, TreeSnapshot.Of(_root));
        Assert.Empty(transaction.Rollback());
        Assert.Equal(before, TreeSnapshot.Of(_root));
    }

    [Fact]
    public void Rollback_TakesBackEveryDirectoryTheBatchMinted_NotJustTheFile()
    {
        // Nothing under source/ yet: the plugin's own root, its group folder and the file are all
        // minted in one put.
        var before = TreeSnapshot.Of(_root);

        var transaction = new SourceRepository.SourceTransaction();
        transaction.Put(Repo, Plugin, new SourceDocument(Fk("000800"), "npc_", "FreshNpc", Body(Fk("000800"), "FreshNpc")));

        Assert.True(Directory.Exists(Path.Combine(_root, "source", PluginName, "Npcs")));
        Assert.Empty(transaction.Rollback());
        Assert.Equal(before, TreeSnapshot.Of(_root));
    }

    [Fact]
    public void Rollback_LeavesAMintedDirectoryAThirdPartyHasSinceFilled()
    {
        var transaction = new SourceRepository.SourceTransaction();
        transaction.Put(Repo, Plugin, new SourceDocument(Fk("000800"), "npc_", "FreshNpc", Body(Fk("000800"), "FreshNpc")));

        var pluginRoot = Path.Combine(_root, "source", PluginName);
        File.WriteAllText(Path.Combine(pluginRoot, "theirs.json"), "another tool's");

        Assert.Empty(transaction.Rollback());
        Assert.True(File.Exists(Path.Combine(pluginRoot, "theirs.json")));
        Assert.False(Directory.Exists(Path.Combine(pluginRoot, "Npcs")));
    }

    // The second move's destination is where the first vacated: undone out of order, the first
    // move's restore would find the second still sitting there.
    [Fact]
    public void Rollback_UndoesTwoDependentContainerMoves_SoNeitherLandsOnTheOther()
    {
        Seed(Fk("000900"), "wrld", "Shared");
        Seed(Fk("000901"), "wrld", "Shared");
        var before = TreeSnapshot.Of(_root);

        var transaction = new SourceRepository.SourceTransaction();
        transaction.Move(Repo, Plugin, new RecordIdentity(Fk("000900"), "wrld", "Shared"), Fk("000902"));
        transaction.Move(Repo, Plugin, new RecordIdentity(Fk("000901"), "wrld", "Shared"), Fk("000900"));

        Assert.NotEqual(before, TreeSnapshot.Of(_root));
        Assert.Empty(transaction.Rollback());
        Assert.Equal(before, TreeSnapshot.Of(_root));
    }

    [Fact]
    public void Rollback_KeepsAThirdPartysBytes_RestoresEverythingElse_AndNamesOnlyThatFile()
    {
        Seed(Fk("000800"), "npc_", "Contested");
        Seed(Fk("000801"), "npc_", "Quiet");

        var transaction = new SourceRepository.SourceTransaction();
        transaction.Put(Repo, Plugin, new SourceDocument(Fk("000800"), "npc_", "Contested", Body(Fk("000800"), "Ours")));
        transaction.Put(Repo, Plugin, new SourceDocument(Fk("000801"), "npc_", "Quiet", Body(Fk("000801"), "OursToo")));

        var contestedFile = FlatFile(Fk("000800"), "npc_", "Contested");
        File.WriteAllText(contestedFile, "someone else's work");

        var unrestored = transaction.Rollback();

        var only = Assert.Single(unrestored);
        Assert.Equal(UnrestoredReason.ChangedByAnother, only.Reason);
        Assert.Equal(
            "source/Fixture.esp/Npcs/Contested - 000800_Fixture.esp.json", only.RelativePath.Replace('\\', '/'));
        Assert.Equal("someone else's work", File.ReadAllText(contestedFile));
        Assert.Equal(Body(Fk("000801"), "Quiet"), File.ReadAllText(FlatFile(Fk("000801"), "npc_", "Quiet")));
    }

    [Fact]
    public void Rollback_DoesNotResurrectAnOverwrittenFileAThirdPartyDeleted_AndNamesIt()
    {
        Seed(Fk("000800"), "npc_", "Doomed");

        var transaction = new SourceRepository.SourceTransaction();
        transaction.Put(Repo, Plugin, new SourceDocument(Fk("000800"), "npc_", "Doomed", Body(Fk("000800"), "Ours")));
        var file = FlatFile(Fk("000800"), "npc_", "Doomed");
        File.Delete(file);

        var only = Assert.Single(transaction.Rollback());
        Assert.Equal(UnrestoredReason.RemovedByAnother, only.Reason);
        Assert.False(File.Exists(file));
    }

    [Fact]
    public void Rollback_NamesACreatedFileAThirdPartyRemoved_RatherThanClaimingItUndidIt()
    {
        var transaction = new SourceRepository.SourceTransaction();
        transaction.Put(Repo, Plugin, new SourceDocument(Fk("000800"), "npc_", "Fresh", Body(Fk("000800"), "Ours")));
        File.Delete(FlatFile(Fk("000800"), "npc_", "Fresh"));

        var only = Assert.Single(transaction.Rollback());
        Assert.Equal(UnrestoredReason.RemovedByAnother, only.Reason);
    }

    [Fact]
    public void Rollback_SaysNothingAboutAPutThatChangedNothing()
    {
        Seed(Fk("000800"), "npc_", "Untouched");
        var file = FlatFile(Fk("000800"), "npc_", "Untouched");
        Block(file);

        var transaction = new SourceRepository.SourceTransaction();
        Assert.ThrowsAny<Exception>(() => transaction.Put(
            Repo, Plugin, new SourceDocument(Fk("000800"), "npc_", "Untouched", Body(Fk("000800"), "Rewritten"))));

        Assert.Empty(transaction.Rollback());
        Assert.Equal(Body(Fk("000800"), "Untouched"), File.ReadAllText(file));
    }

    [Fact]
    public void Rollback_ReportsAPathItCouldNotRestore_AndStillRestoresTheRest()
    {
        Seed(Fk("000800"), "npc_", "First");
        Seed(Fk("000801"), "npc_", "Second");

        var transaction = new SourceRepository.SourceTransaction();
        transaction.Put(Repo, Plugin, new SourceDocument(Fk("000800"), "npc_", "First", Body(Fk("000800"), "Ours")));
        transaction.Remove(Repo, Plugin, new RecordIdentity(Fk("000801"), "npc_", "Second"));

        // A directory where the removed file stood: real, unwritable on every platform, and needing
        // no permission bits a privileged test runner would sail through.
        Directory.CreateDirectory(FlatFile(Fk("000801"), "npc_", "Second"));

        var only = Assert.Single(transaction.Rollback());
        Assert.Equal(UnrestoredReason.RestoreFailed, only.Reason);
        Assert.NotNull(only.Error);

        // The pass carried on past the failure: the earlier put, undone after it, went back.
        Assert.Equal(Body(Fk("000800"), "First"), File.ReadAllText(FlatFile(Fk("000800"), "npc_", "First")));
    }

    [Fact]
    public void FailingTheSequenceAtEachPositionInTurn_LeavesTheTreeUnchangedEveryTime()
    {
        int positions;
        {
            SeedTree();
            var probe = new SourceRepository.SourceTransaction();
            positions = RunSequence(probe, failAt: int.MaxValue);
            probe.Rollback();
            Directory.Delete(_root, recursive: true);
        }

        Assert.True(positions > 3, $"the sweep is only worth running over several acts; got {positions}");

        for (var failAt = 0; failAt < positions; failAt++)
        {
            Directory.CreateDirectory(_root);
            SeedTree();
            var before = TreeSnapshot.Of(_root);

            var transaction = new SourceRepository.SourceTransaction();
            Assert.ThrowsAny<Exception>(() => RunSequence(transaction, failAt));
            Assert.Empty(transaction.Rollback());
            Assert.Equal(before, TreeSnapshot.Of(_root));

            Directory.Delete(_root, recursive: true);
        }
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

    private int RunSequence(SourceRepository.SourceTransaction transaction, int failAt)
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
        At(failAt, () => transaction.Move(Repo, Plugin, new RecordIdentity(Fk("000900"), "wrld", "Home"), Fk("000901")));
        At(failAt, () => transaction.Put(
            Repo, Plugin, new SourceDocument(Fk("000901"), "wrld", "Home", Body(Fk("000901"), "Home rewritten"))));
        At(failAt, () => transaction.Remove(Repo, Plugin, new RecordIdentity(Fk("000A00"), "race", "DoomedRace")));
        At(failAt, () => transaction.Move(Repo, Plugin, new RecordIdentity(Fk("000902"), "wrld", "Other"), Fk("000903")));
        return act;
    }
}
