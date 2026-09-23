using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;

namespace MEditService.Commands.Tests.Edits;

// Origin-scoped (ADR-0003): the repo, not any one plugin inside it, is the unit of baselines and
// rebase, and the load order is where the write side asks which folder that is.
public sealed class RebaseHandlerTests : IDisposable
{
    private readonly SourceEditFixture _mod = SourceEditFixture.Tracked();
    private readonly LoadOrderHolder _holder = new();

    public RebaseHandlerTests() => _holder.Apply(_mod.LoadOrder);

    public void Dispose() => _mod.Dispose();

    [Fact]
    public void RebaseEditBranch_ResolvesTheRepository_FromTheOriginAlone()
    {
        var result = TestEditService.RebaseHandler(_holder).RebaseEditBranch(SourceEditFixture.ModFolderOrigin);

        Assert.Equal(RebaseOutcome.Clean, result.Require().Outcome);
    }

    // Which outcome a continue reports is SourceRepositoryRebaseTests' subject; that it reaches the
    // repository at all is this handler's.
    [Fact]
    public void ContinueRebase_ResolvesTheRepository_FromTheOriginAlone()
    {
        var result = TestEditService.ContinueRebaseHandler(_holder).ContinueRebase(SourceEditFixture.ModFolderOrigin);

        Assert.NotNull(result);
    }

    [Fact]
    public void RebaseEditBranch_UnknownOrigin_IsNull()
    {
        Assert.Null(TestEditService.RebaseHandler(_holder).RebaseEditBranch("NoSuchOrigin"));
    }

    [Fact]
    public void ContinueRebase_UnknownOrigin_IsNull()
    {
        Assert.Null(TestEditService.ContinueRebaseHandler(_holder).ContinueRebase("NoSuchOrigin"));
    }

    // The game's own Data directory is nobody's mod folder, so a copy loaded from it names no
    // repository to rebase.
    [Fact]
    public void RebaseEditBranch_DataDirectoryOrigin_IsNull()
    {
        var holder = new LoadOrderHolder();
        holder.Apply(_mod.LoadOrder.With(new RegisteredCopy(
            SourceEditFixture.PluginName, PluginOrigin.DataDirectory,
            Path.Combine(_mod.GameDirectory, SourceEditFixture.PluginName), Slot: 1, Enabled: true, Winning: true)));

        Assert.Null(TestEditService.RebaseHandler(holder).RebaseEditBranch(PluginOrigin.DataDirectory));
    }
}
