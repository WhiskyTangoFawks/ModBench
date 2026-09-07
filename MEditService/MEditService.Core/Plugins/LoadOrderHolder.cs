namespace MEditService.Core.Plugins;

/// <summary>Where the shared kernel keeps the current load order. The load-order endpoint is the
/// only caller of <see cref="Apply"/> (ADR-0044: one arrival); everything else reads Current.</summary>
public sealed class LoadOrderHolder
{
    // Replaced wholesale, never mutated, so a reader mid-Apply sees the previous value whole rather
    // than a half-applied one.
    private LoadOrder _current = LoadOrder.Empty;

    public LoadOrder Current => Volatile.Read(ref _current);

    public void Apply(LoadOrder snapshot) => Volatile.Write(ref _current, snapshot);

    /// <summary>ADR-0041: a created plugin is a registered copy at once, before plugins.txt names
    /// it; the next snapshot corrects its slot. The plugin endpoint is its only caller.</summary>
    public void Register(RegisteredCopy copy) => Apply(Current.With(copy));
}
