using MEditService.SourceAdapter;
using MEditService.TestSupport;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>The git source adapter, but asked whether git can run it answers no, as when git leaves the PATH after
/// the verb that last ran it. Construction empties the PATH, so its caller holds the process environment.</summary>
internal sealed class GitGoneSourceAdapter() : DelegatingSourceAdapter(TestAdapters.Source())
{
    private readonly SourceFailure _gitMissing = GitOffPath.While(TestAdapters.Source().WhyGitCannotRun)
        ?? throw new InvalidOperationException("Expected git to be missing with no PATH.");

    public override SourceFailure? WhyGitCannotRun() => _gitMissing;
}
