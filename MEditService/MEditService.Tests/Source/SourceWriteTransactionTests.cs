using MEditService.Core.Source;
using MEditService.Tests.TestSupport;

namespace MEditService.Tests.Source;

/// <summary>The third-party writes here are real: the test process writes and deletes files itself
/// between the transaction's write and its rollback, the sequence another tool produces.</summary>
public sealed class SourceWriteTransactionTests : IDisposable
{
    private readonly string _root = Directory.CreateTempSubdirectory("medit-swt-").FullName;

    public void Dispose()
    {
        try { Directory.Delete(_root, recursive: true); }
        catch (DirectoryNotFoundException) { /* the sweep tears its own scratch tree down */ }
        catch (IOException) { /* scratch directory, best effort */ }
        catch (UnauthorizedAccessException) { /* ditto */ }
    }

    private string Path_(string relative) => Path.Combine(_root, relative.Replace('/', Path.DirectorySeparatorChar));

    private void Seed(string relative, string content)
    {
        var path = Path_(relative);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, content);
    }

    private void WriteThrough(SourceWriteTransaction transaction, string relative, string content) =>
        transaction.Write(_root, Path_(relative), () => File.WriteAllText(Path_(relative), content));

    [Fact]
    public void Rollback_PutsBackAnOverwrite_ACreate_ADelete_AndARelocatedSubtree()
    {
        Seed("Npcs/existing.json", "original");
        Seed("Races/doomed.json", "doomed");
        Seed("Cells/Home/RecordData.json", "cell");
        // An empty directory in the tree from the start: it must still be there afterwards, and it is
        // the entry no git-based oracle would see either way.
        Directory.CreateDirectory(Path_("Cells/Home/Empty"));
        var before = TreeSnapshot.Of(_root);

        var transaction = new SourceWriteTransaction();
        WriteThrough(transaction, "Npcs/existing.json", "rewritten");
        WriteThrough(transaction, "Npcs/created.json", "brand new");
        transaction.Delete(_root, Path_("Races/doomed.json"));
        transaction.Move(_root, Path_("Cells/Home"), Path_("Cells/Moved"));

        Assert.NotEqual(before, TreeSnapshot.Of(_root));
        Assert.Empty(transaction.Rollback());
        Assert.Equal(before, TreeSnapshot.Of(_root));
    }

    [Fact]
    public void Rollback_UndoesActsInReverse_SoARestoreNeverCollidesWithARenamedSibling()
    {
        Seed("Races/old.json", "old");
        var before = TreeSnapshot.Of(_root);

        // The moved file lands on exactly the name the deleted sibling vacated, which is what makes
        // reverse order load-bearing: restoring the delete first would put old.json on top of a live
        // file.
        var transaction = new SourceWriteTransaction();
        WriteThrough(transaction, "Races/new.json", "new");
        transaction.Delete(_root, Path_("Races/old.json"));
        transaction.Move(_root, Path_("Races/new.json"), Path_("Races/old.json"));

        Assert.Empty(transaction.Rollback());
        Assert.Equal(before, TreeSnapshot.Of(_root));
    }

    [Fact]
    public void Rollback_KeepsAThirdPartysBytes_RestoresEverythingElse_AndNamesOnlyThatFile()
    {
        Seed("Npcs/contested.json", "original");
        Seed("Npcs/quiet.json", "quiet original");

        var transaction = new SourceWriteTransaction();
        WriteThrough(transaction, "Npcs/contested.json", "ours");
        WriteThrough(transaction, "Npcs/quiet.json", "ours too");

        File.WriteAllText(Path_("Npcs/contested.json"), "someone else's work");

        var unrestored = transaction.Rollback();

        var only = Assert.Single(unrestored);
        Assert.Equal(UnrestoredReason.ChangedByAnother, only.Reason);
        Assert.Equal("Npcs/contested.json", only.RelativePath.Replace('\\', '/'));
        Assert.Equal("someone else's work", File.ReadAllText(Path_("Npcs/contested.json")));
        Assert.Equal("quiet original", File.ReadAllText(Path_("Npcs/quiet.json")));
    }

    [Fact]
    public void Rollback_DoesNotResurrectAFileAThirdPartyDeleted_AndNamesIt()
    {
        Seed("Npcs/doomed.json", "original");

        var transaction = new SourceWriteTransaction();
        WriteThrough(transaction, "Npcs/doomed.json", "ours");
        File.Delete(Path_("Npcs/doomed.json"));

        var only = Assert.Single(transaction.Rollback());
        Assert.Equal(UnrestoredReason.RemovedByAnother, only.Reason);
        Assert.Equal("Npcs/doomed.json", only.RelativePath.Replace('\\', '/'));
        Assert.False(File.Exists(Path_("Npcs/doomed.json")));
    }

    [Fact]
    public void Rollback_NamesAFileItCreatedAndAThirdPartyRemoved_RatherThanClaimingItUndidIt()
    {
        var transaction = new SourceWriteTransaction();
        WriteThrough(transaction, "Npcs/created.json", "ours");
        File.Delete(Path_("Npcs/created.json"));

        var only = Assert.Single(transaction.Rollback());
        Assert.Equal(UnrestoredReason.RemovedByAnother, only.Reason);
    }

    [Fact]
    public void Rollback_SaysNothingAboutAWriteThatChangedNothing()
    {
        Seed("Npcs/untouched.json", "original");

        var transaction = new SourceWriteTransaction();
        Assert.ThrowsAny<Exception>(() =>
            transaction.Write(_root, Path_("Npcs/untouched.json"), () => throw new IOException("disk went away")));

        Assert.Empty(transaction.Rollback());
        Assert.Equal("original", File.ReadAllText(Path_("Npcs/untouched.json")));
    }

    [Fact]
    public void Rollback_ReportsAPathItCouldNotRestore_AndStillRestoresTheRest()
    {
        Seed("Npcs/first.json", "first original");
        Seed("Races/second.json", "second original");

        var transaction = new SourceWriteTransaction();
        WriteThrough(transaction, "Npcs/first.json", "ours");
        transaction.Delete(_root, Path_("Races/second.json"));

        Directory.CreateDirectory(Path_("Races/second.json"));

        var only = Assert.Single(transaction.Rollback());
        Assert.Equal(UnrestoredReason.RestoreFailed, only.Reason);
        Assert.Equal("Races/second.json", only.RelativePath.Replace('\\', '/'));
        Assert.NotNull(only.Error);

        // The pass carried on past the failure: the earlier write, undone after it, went back.
        Assert.Equal("first original", File.ReadAllText(Path_("Npcs/first.json")));
    }

    [Fact]
    public void FailingTheSequenceAtEachPositionInTurn_LeavesTheTreeUnchangedEveryTime()
    {
        int positions;
        {
            var probe = new SourceWriteTransaction();
            SeedTree();
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

            var transaction = new SourceWriteTransaction();
            Assert.ThrowsAny<Exception>(() => RunSequence(transaction, failAt));
            Assert.Empty(transaction.Rollback());
            Assert.Equal(before, TreeSnapshot.Of(_root));

            Directory.Delete(_root, recursive: true);
        }
    }

    private void SeedTree()
    {
        Seed("Npcs/a.json", "a original");
        Seed("Npcs/b.json", "b original");
        Seed("Races/r.json", "r original");
        Seed("Cells/Home/RecordData.json", "cell original");
        Directory.CreateDirectory(Path_("Cells/Home/Empty"));
    }

    private int RunSequence(SourceWriteTransaction transaction, int failAt)
    {
        var act = 0;
        void At(int position, Action perform)
        {
            if (act++ == position) throw new IOException($"injected failure at act {position}");
            perform();
        }

        At(failAt, () => WriteThrough(transaction, "Npcs/a.json", "a rewritten"));
        At(failAt, () => WriteThrough(transaction, "Npcs/b.json", "b rewritten"));
        At(failAt, () => transaction.Move(_root, Path_("Cells/Home"), Path_("Cells/Moved")));
        At(failAt, () => WriteThrough(transaction, "Cells/Moved/RecordData.json", "cell rewritten"));
        At(failAt, () => WriteThrough(transaction, "Races/r2-moved.json", "r2 new"));
        At(failAt, () => transaction.Delete(_root, Path_("Races/r.json")));
        At(failAt, () => transaction.Move(_root, Path_("Races/r2-moved.json"), Path_("Races/r2.json")));
        return act;
    }
}
