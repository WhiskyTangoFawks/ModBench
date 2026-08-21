using MEditService.Core.Edits;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Tests.Edits;

/// <summary>
/// #416 review: every compile — including this single-plugin Save & Compile — runs through
/// <see cref="CompileJournal"/>, batch of one, through the real <see cref="PluginCompileService.Compile"/>
/// door rather than only through <c>CompileJournal.RunBatch</c> directly (that door's own tests,
/// <c>CompileJournalTests</c>, cover the primitive in isolation; this covers it wired in).
/// </summary>
public sealed class PluginCompileServiceJournalTests : IDisposable
{
    private readonly TrackedModFixture _mod = TrackedModFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private PluginCompileService CompileService() =>
        new(_mod.Sessions, new PluginWriter(NullLogger<PluginWriter>.Instance), NullLogger<PluginCompileService>.Instance);

    [Fact]
    public void Compile_ThatSucceeds_LeavesNoJournalMarkerBehind()
    {
        var result = CompileService().Compile(_mod.Plugin, new CompileSource.WorkingTree());

        Assert.True(result.Succeeded, result.RefusalReason);
        Assert.Null(CompileJournal.PendingRecovery(_mod.ModFolder));
    }

    // Not RunBatch driven by hand: the crash is injected at the real door a production caller
    // actually uses, so this is honest about what PluginCompileService.Compile itself leaves behind
    // on disk, not just what the journal primitive can be made to do in isolation. The mod folder
    // itself (not .git, which keeps its own, separate permissions) is made unwritable so
    // PluginWriter's backup-then-write sequence throws partway through — the same observable state a
    // genuine crash between the journal's marker write and its clear would leave.
    [Fact]
    public void Compile_CrashedDuringTheWrite_LeavesAMarkerPendingRecoveryReads_NamingWhatDidNotLand()
    {
        Chmod(_mod.ModFolder, "500"); // read+execute only — a new file (the backup) can't be created
        try
        {
            Assert.ThrowsAny<Exception>(() => CompileService().Compile(_mod.Plugin, new CompileSource.WorkingTree()));
        }
        finally
        {
            Chmod(_mod.ModFolder, "700"); // restored before TrackedModFixture.Dispose() needs to clean up
        }

        var recovery = CompileJournal.PendingRecovery(_mod.ModFolder);
        Assert.NotNull(recovery);
        Assert.Equal([TrackedModFixture.PluginName], recovery.Plugins);
        Assert.Empty(recovery.Landed);
    }

    // Process-shelled rather than File.Set/GetUnixFileMode: this project's runtime is Linux-only
    // (root CLAUDE.md), but that .NET API is flagged platform-unsafe (CA1416) regardless, and
    // suppressing an analyzer warning is not this test's call to make on its own.
    private static void Chmod(string path, string mode)
    {
        using var process = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(
            "chmod", [mode, path])
        { RedirectStandardError = true })!;
        process.WaitForExit();
        if (process.ExitCode != 0)
            throw new InvalidOperationException($"chmod {mode} {path} failed: {process.StandardError.ReadToEnd()}");
    }
}
