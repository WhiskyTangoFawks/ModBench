using MEditService.Core.Source;
using MEditService.Tests.TestSupport;

namespace MEditService.Tests.Source;

/// <summary>
/// #678's restore mechanism, driven directly with a synthetic write sequence rather than only through
/// a full renumber cascade. Every rule the conditional guarantee is made of — restore in reverse
/// order, restore only what the action itself still owns, report what was left standing — is a
/// property of this class alone, and provable here in a scratch directory with no index, no load
/// order and no plugin in sight.
///
/// <para><b>The third-party writes here are real.</b> Nothing is mocked or injected: the test process
/// writes and deletes the files itself, between the transaction's write and its rollback, which is
/// exactly the sequence another tool or the author produces.</para>
/// </summary>
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

    /// <summary>
    /// The whole shape in one sequence: an existing file overwritten, a new file created, an existing
    /// file deleted, and a whole directory relocated. Rolled back, the tree is byte-identical — path
    /// set, content and directory list, empty directories included.
    /// </summary>
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

    /// <summary>
    /// Undoing in reverse is the whole reason a restore cannot collide, and this is the sequence a
    /// renumber actually makes: write the new leaf at the next free slot, delete the old one, then
    /// close the gap the delete left by renaming the new leaf down into it. Every act after the first
    /// has moved the first act's own file out from under the path it was written at.
    ///
    /// <para>Undone forwards this comes apart: the create is asked about a path the rename has since
    /// vacated, reads it as "removed by something else", leaves the renamed file standing, and reports
    /// damage that is really its own doing. Reverse order vacates each name before anything is asked
    /// to move back into it.</para>
    /// </summary>
    [Fact]
    public void Rollback_UndoesActsInReverse_SoARestoreNeverCollidesWithARenamedSibling()
    {
        Seed("Races/old.json", "old");
        var before = TreeSnapshot.Of(_root);

        // The moved file lands on exactly the name the deleted sibling just vacated — which is what
        // makes reverse order load-bearing: restoring the delete before undoing the move would put
        // old.json back on top of a file still sitting there.
        var transaction = new SourceWriteTransaction();
        WriteThrough(transaction, "Races/new.json", "new");
        transaction.Delete(_root, Path_("Races/old.json"));
        transaction.Move(_root, Path_("Races/new.json"), Path_("Races/old.json"));

        Assert.Empty(transaction.Rollback());
        Assert.Equal(before, TreeSnapshot.Of(_root));
    }

    /// <summary>
    /// A third party overwrites one of the written files before the rollback runs. Its bytes are the
    /// third party's and stay that way; every other file goes back; and the report names that file
    /// and only that file.
    /// </summary>
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

    /// <summary>A third party deletes a file the action wrote. Not resurrected — whatever removed it
    /// meant to — and named, so the author is told rather than left to notice.</summary>
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

    /// <summary>A file the action created and a third party then deleted is <i>also</i> the state the
    /// rollback wanted — but it is still named, because the rule is one rule: the file no longer holds
    /// what this action left there, so this action does not touch it and says so.</summary>
    [Fact]
    public void Rollback_NamesAFileItCreatedAndAThirdPartyRemoved_RatherThanClaimingItUndidIt()
    {
        var transaction = new SourceWriteTransaction();
        WriteThrough(transaction, "Npcs/created.json", "ours");
        File.Delete(Path_("Npcs/created.json"));

        var only = Assert.Single(transaction.Rollback());
        Assert.Equal(UnrestoredReason.RemovedByAnother, only.Reason);
    }

    /// <summary>A write that threw before it changed anything is not damage and is not named. The
    /// report is the author's list of things to look at; a path this action left exactly as it found
    /// it does not belong on it, however much of it the action attempted.</summary>
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

    /// <summary>
    /// A rollback that itself cannot complete reports which paths were not restored rather than
    /// failing silently — and does not abandon the rest of the pass: the file it could not put back
    /// was recorded last and is therefore restored first, and the write before it still goes back.
    ///
    /// <para>The obstruction is real and needs no permission bits: another tool put a <i>directory</i>
    /// where the deleted file stood. Nothing can write a file there, on any platform.</para>
    /// </summary>
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

    /// <summary>
    /// The direct-mechanism half of #678's sweep: fail the sequence at each of its positions in turn
    /// and assert the tree is unchanged every time. The position count is what one clean run of
    /// <see cref="RunSequence"/> reports having done — derived from the sequence, so adding an act to
    /// it extends the sweep rather than silently escaping it.
    /// </summary>
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

    /// <summary>The same act sequence a renumber makes, in miniature: referencing files rewritten, a
    /// subtree relocated, a new leaf written, the old one deleted, the ordering prefixes closed up.
    /// <paramref name="failAt"/> throws instead of performing the act at that position. Returns how
    /// many acts it got through, which is what the sweep counts its positions off.</summary>
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
