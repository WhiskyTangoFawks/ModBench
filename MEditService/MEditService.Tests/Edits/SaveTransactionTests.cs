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
}
