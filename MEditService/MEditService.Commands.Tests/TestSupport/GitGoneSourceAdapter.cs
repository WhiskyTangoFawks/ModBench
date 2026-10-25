using MEditService.SourceAdapter;
using MEditService.TestSupport;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>The git source adapter, but asked whether git can run it answers no, as when git leaves the PATH after
/// the verb that last ran it.</summary>
internal sealed class GitGoneSourceAdapter : DelegatingSourceAdapter
{
    private readonly SourceFailure _gitMissing;

    internal GitGoneSourceAdapter()
        : this(TestAdapters.Source())
    {
    }

    private GitGoneSourceAdapter(ISourceAdapter inner)
        : base(inner) =>
        _gitMissing = GitOffPath.While(inner.WhyGitCannotRun) ?? throw new InvalidOperationException("Expected git to be missing with no PATH.");

    public override SourceFailure? WhyGitCannotRun() => _gitMissing;
}
