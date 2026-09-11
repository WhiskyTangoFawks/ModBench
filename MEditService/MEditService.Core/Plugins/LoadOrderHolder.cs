namespace MEditService.Core.Plugins;

/// <summary>Where the shared kernel keeps the current load order. The load-order and create-plugin
/// endpoints are the only callers of <see cref="Apply"/> (ADR-0013: one arrival); everything else
/// reads Current.</summary>
public sealed class LoadOrderHolder
{
    // Replaced wholesale, never mutated, so a reader mid-Apply sees the previous value whole rather
    // than a half-applied one.
    private LoadOrder _current = LoadOrder.Empty;

    public LoadOrder Current => Volatile.Read(ref _current);

    public void Apply(LoadOrder snapshot) => Volatile.Write(ref _current, snapshot);

    /// <summary>The value a read must have. The one place a read refuses for want of a load order:
    /// no snapshot has a data folder to name, so an empty one means none has arrived.</summary>
    public LoadOrder Require() =>
        Current is { DataFolderPath.Length: > 0 } current ? current : throw new NoLoadOrderException();
}
