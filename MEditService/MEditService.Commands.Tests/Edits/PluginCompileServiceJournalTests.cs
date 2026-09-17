using MEditService.Commands.Edits;
using MEditService.SourceRepo;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Tests.Edits;

/// <summary>The journal wired in through the real <see cref="PluginCompileService.CompileAsync"/> door;
/// <c>CompileJournalTests</c> covers the primitive in isolation.</summary>
public sealed class PluginCompileServiceJournalTests : IDisposable
{
    private readonly CompileFixture _mod = new();

    public void Dispose() => _mod.Dispose();

    private PluginCompileService CompileService() =>
        _mod.CompileService();

    [Fact]
    public async Task Compile_ThatSucceeds_LeavesNoJournalMarkerBehind()
    {
        var result = await CompileService().CompileAsync(_mod.Plugin, new CompileSource.WorkingTree());

        Assert.True(result.Succeeded, result.RefusalReason);
        Assert.Null(CompileJournal.UnfinishedBatch(_mod.ModFolder));
    }

    // The crash is injected at the real door a production caller uses. The mod folder (not .git, which
    // keeps separate permissions) is made unwritable so PluginWriter's backup-then-write sequence
    // throws partway through.
    [Fact]
    public async Task Compile_CrashedDuringTheWrite_LeavesAMarkerUnfinishedBatchReads_NamingWhatDidNotLand()
    {
        Chmod(_mod.ModFolder, "500"); // read+execute only — a new file (the backup) can't be created
        try
        {
            await Assert.ThrowsAnyAsync<Exception>(async () => await CompileService().CompileAsync(_mod.Plugin, new CompileSource.WorkingTree()));
        }
        finally
        {
            Chmod(_mod.ModFolder, "700"); // restored before CompileFixture.Dispose() needs to clean up
        }

        var recovery = CompileJournal.UnfinishedBatch(_mod.ModFolder);
        Assert.NotNull(recovery);
        Assert.Equal([CompileFixture.PluginName], recovery.Plugins);
        Assert.Empty(recovery.Landed);
    }

    // Process-shelled because File.SetUnixFileMode is flagged platform-unsafe (CA1416) even on a
    // Linux-only runtime, and suppressing an analyzer warning is not this test's call to make.
    private static void Chmod(string path, string mode)
    {
        using var process = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(
            "chmod", [mode, path])
        { RedirectStandardError = true }).Require();
        process.WaitForExit();
        if (process.ExitCode != 0)
            throw new InvalidOperationException($"chmod {mode} {path} failed: {process.StandardError.ReadToEnd()}");
    }
}
