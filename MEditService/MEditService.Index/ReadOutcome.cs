using MEditService.PluginAdapter;
using MEditService.SourceAdapter;

namespace MEditService.Index;

/// <summary>How one read of a plugin ended: whether its own truth served, what stopped its tree when
/// the read went on without it, and the binary's failure when nothing was read.</summary>
internal sealed record ReadOutcome(bool Served, Exception? StoppedBy = null, PluginFailure? Failure = null, SourceFailure? TreeStopped = null)
{
    public static readonly ReadOutcome Read = new(true);

    public static ReadOutcome StoppedAt(Exception stoppedBy) => new(Served: false, stoppedBy);

    public static ReadOutcome StoppedAt(SourceFailure treeStopped) => new(Served: false, TreeStopped: treeStopped);

    public static ReadOutcome Failed(PluginFailure failure) => new(Served: false, Failure: failure);
}
