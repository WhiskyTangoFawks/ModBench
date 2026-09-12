using MEditService.Index;
using Mutagen.Bethesda;

namespace MEditService.Tests;

/// <summary>A store that refuses to open, and remembers whether it was asked: how a test makes a
/// projection fail, or observes that one never started, from outside the projector.</summary>
internal sealed class RefusingIndexFactory : IRecordIndexFactory
{
    internal const string Reason = "the reconcile failed";

    internal bool Asked { get; private set; }

    public IRecordIndex Create(GameRelease gameRelease, string? instanceRoot = null)
    {
        Asked = true;
        throw new InvalidOperationException(Reason);
    }

    public IRecordIndex Rebuild(GameRelease gameRelease, string instanceRoot, long atLeastSequence) =>
        throw new NotSupportedException();
}
