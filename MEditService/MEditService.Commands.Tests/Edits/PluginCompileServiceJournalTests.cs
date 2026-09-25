using MEditService.Commands.Edits;
using MEditService.SourceAdapter;
using MEditService.TestSupport;

namespace MEditService.Commands.Tests.Edits;

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

    // The crash is injected at the real door a production caller uses: the mod folder (not .git, which
    // keeps separate permissions) is read-only so PluginWriter's temp write throws, and writable
    // again before CompileFixture.Dispose().
    [Fact]
    public async Task Compile_CrashedDuringTheWrite_LeavesAMarkerUnfinishedBatchReads_NamingWhatDidNotLand()
    {
        FileModes.Set(_mod.ModFolder, "500");
        try
        {
            await Assert.ThrowsAnyAsync<Exception>(async () => await CompileService().CompileAsync(_mod.Plugin, new CompileSource.WorkingTree()));
        }
        finally
        {
            FileModes.Set(_mod.ModFolder, "700");
        }

        var recovery = CompileJournal.UnfinishedBatch(_mod.ModFolder);
        Assert.NotNull(recovery);
        Assert.Equal([CompileFixture.PluginName], recovery.Plugins);
        Assert.Empty(recovery.Landed);
    }
}
