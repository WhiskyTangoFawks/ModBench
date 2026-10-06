namespace MEditService.Index;

/// <summary>How one read of a plugin ended: whether its own truth served, and the exception that
/// stopped it when one did and the read went on without it.</summary>
internal sealed record ReadOutcome(bool Served, Exception? StoppedBy = null)
{
    public static readonly ReadOutcome Read = new(true);

    public static readonly ReadOutcome Unread = new(false);
}
