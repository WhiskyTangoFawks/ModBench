using MEditService.Core.Edits;

namespace MEditService.Tests.Edits;

public sealed class SaveTransactionTests
{
    private static SaveResult EmptySaveResult(string backupPath = "") => new(backupPath, [], [], [], []);

    private sealed record TempPlugin(string FinalPath, string TmpPath, string TmpDir) : IDisposable
    {
        public void Dispose()
        {
            if (Directory.Exists(TmpDir)) Directory.Delete(TmpDir, recursive: true);
            if (File.Exists(FinalPath)) File.Delete(FinalPath);
            if (File.Exists(FinalPath + ".medit-rollback")) File.Delete(FinalPath + ".medit-rollback");
        }
    }

    private static TempPlugin MakeTempPlugin(string originalContent, string newContent)
    {
        var finalPath = Path.GetTempFileName();
        File.WriteAllText(finalPath, originalContent);

        var tmpDir = Path.Combine(Path.GetTempPath(), ".medit_tmp_" + Path.GetRandomFileName());
        Directory.CreateDirectory(tmpDir);
        var tmpPath = Path.Combine(tmpDir, Path.GetFileName(finalPath));
        File.WriteAllText(tmpPath, newContent);

        return new TempPlugin(finalPath, tmpPath, tmpDir);
    }

    // S1 — RED: proves the bug is fixed. Files already moved (first half succeeded);
    // caller's second commit (DB) fails; Rollback() must restore every file's original bytes.
    [Fact]
    public void Rollback_AfterSuccessfulCommitFiles_RestoresOriginalContentForAll()
    {
        using var pluginA = MakeTempPlugin("original-A", "new-A");
        using var pluginB = MakeTempPlugin("original-B", "new-B");

        var items = new List<(string Plugin, PreparedPluginSave Prepared)>
        {
            ("A.esp", new PreparedPluginSave(pluginA.TmpPath, pluginA.FinalPath, EmptySaveResult())),
            ("B.esp", new PreparedPluginSave(pluginB.TmpPath, pluginB.FinalPath, EmptySaveResult())),
        };
        var saveTxn = new SaveTransaction(items);

        saveTxn.CommitFiles();
        Assert.Equal("new-A", File.ReadAllText(pluginA.FinalPath));
        Assert.Equal("new-B", File.ReadAllText(pluginB.FinalPath));

        saveTxn.Rollback();

        Assert.Equal("original-A", File.ReadAllText(pluginA.FinalPath));
        Assert.Equal("original-B", File.ReadAllText(pluginB.FinalPath));
    }

    // S2 — partial CommitFiles() failure: 2nd item's Commit() throws (bogus tmp path).
    // Exception propagates; caller's Rollback() must still restore the 1st item, which
    // already succeeded, back to its original content.
    [Fact]
    public void CommitFiles_PartialFailure_ThenRollback_RestoresAlreadyCommittedItem()
    {
        using var pluginA = MakeTempPlugin("original-A", "new-A");
        var finalB = Path.GetTempFileName();
        File.WriteAllText(finalB, "original-B");
        var bogusTmpPath = Path.Combine(Path.GetTempPath(), ".medit_tmp_" + Path.GetRandomFileName(), "missing.esp");

        var items = new List<(string Plugin, PreparedPluginSave Prepared)>
        {
            ("A.esp", new PreparedPluginSave(pluginA.TmpPath, pluginA.FinalPath, EmptySaveResult())),
            ("B.esp", new PreparedPluginSave(bogusTmpPath, finalB, EmptySaveResult())),
        };
        var saveTxn = new SaveTransaction(items);

        try
        {
            Assert.Throws<FileNotFoundException>(() => saveTxn.CommitFiles());
            saveTxn.Rollback();

            Assert.Equal("original-A", File.ReadAllText(pluginA.FinalPath));
            Assert.Equal("original-B", File.ReadAllText(finalB));
        }
        finally
        {
            File.Delete(finalB);
        }
    }

    // S3 — success path: CommitFiles() then Dispose() leaves new content in place and
    // cleans up the transient rollback backup files.
    [Fact]
    public void CommitFiles_ThenDispose_LeavesNewContentAndCleansUpBackups()
    {
        using var pluginA = MakeTempPlugin("original-A", "new-A");

        var items = new List<(string Plugin, PreparedPluginSave Prepared)>
        {
            ("A.esp", new PreparedPluginSave(pluginA.TmpPath, pluginA.FinalPath, EmptySaveResult())),
        };
        var saveTxn = new SaveTransaction(items);

        var results = saveTxn.CommitFiles();
        saveTxn.Dispose();

        Assert.Equal("new-A", File.ReadAllText(pluginA.FinalPath));
        Assert.False(File.Exists(pluginA.FinalPath + ".medit-rollback"));
        Assert.True(results.ContainsKey("A.esp"));
    }

    // S4 — crash recovery: a stale .medit-rollback left behind by a prior crash must not
    // permanently block future saves of this plugin.
    [Fact]
    public void Commit_WhenStaleRollbackBackupExists_OverwritesItAndSucceeds()
    {
        using var pluginA = MakeTempPlugin("original-A", "new-A");
        var staleBackupPath = pluginA.FinalPath + ".medit-rollback";
        File.WriteAllText(staleBackupPath, "stale-crash-leftover");

        var prepared = new PreparedPluginSave(pluginA.TmpPath, pluginA.FinalPath, EmptySaveResult());
        prepared.Commit();

        Assert.Equal("new-A", File.ReadAllText(pluginA.FinalPath));
        Assert.Equal("original-A", File.ReadAllText(staleBackupPath));
    }

    // S5 — an item whose Commit() was never attempted (CommitFiles() threw on an earlier
    // item first) must be a safe no-op under Rollback(), not touched or thrown from.
    [Fact]
    public void Rollback_WithNeverAttemptedItem_LeavesItUntouchedAndDoesNotThrow()
    {
        using var pluginA = MakeTempPlugin("original-A", "new-A");
        using var pluginC = MakeTempPlugin("original-C", "new-C");
        var finalB = Path.GetTempFileName();
        File.WriteAllText(finalB, "original-B");
        var bogusTmpPath = Path.Combine(Path.GetTempPath(), ".medit_tmp_" + Path.GetRandomFileName(), "missing.esp");

        var items = new List<(string Plugin, PreparedPluginSave Prepared)>
        {
            ("A.esp", new PreparedPluginSave(pluginA.TmpPath, pluginA.FinalPath, EmptySaveResult())),
            ("B.esp", new PreparedPluginSave(bogusTmpPath, finalB, EmptySaveResult())),
            ("C.esp", new PreparedPluginSave(pluginC.TmpPath, pluginC.FinalPath, EmptySaveResult())),
        };
        var saveTxn = new SaveTransaction(items);

        try
        {
            Assert.Throws<FileNotFoundException>(() => saveTxn.CommitFiles());
            saveTxn.Rollback();

            Assert.Equal("original-A", File.ReadAllText(pluginA.FinalPath));
            Assert.Equal("original-C", File.ReadAllText(pluginC.FinalPath)); // never attempted, untouched
        }
        finally
        {
            File.Delete(finalB);
        }
    }

    // S6 — Rollback() must also drop the phantom user-facing .bak PrepareAsync already
    // created for this now-abandoned save attempt, not just restore plugin content.
    [Fact]
    public void Rollback_DeletesPhantomUserFacingBackup()
    {
        using var pluginA = MakeTempPlugin("original-A", "new-A");
        var phantomBakPath = Path.GetTempFileName();
        File.WriteAllText(phantomBakPath, "user-facing-backup-copy");

        try
        {
            var prepared = new PreparedPluginSave(pluginA.TmpPath, pluginA.FinalPath, EmptySaveResult(phantomBakPath));
            prepared.Commit();
            prepared.Rollback();

            Assert.False(File.Exists(phantomBakPath));
        }
        finally
        {
            if (File.Exists(phantomBakPath)) File.Delete(phantomBakPath);
        }
    }
}
