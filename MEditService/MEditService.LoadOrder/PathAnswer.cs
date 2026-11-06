namespace MEditService.LoadOrder;

/// <summary>What the adapter that owns a changed path answers for it (ADR-0015).</summary>
public abstract record PathAnswer
{
    private PathAnswer()
    {
    }

    public sealed record Touches(IReadOnlyList<RegisteredPlugin> Plugins) : PathAnswer;

    /// <summary>The record index reads the path for plugins the adapter cannot name.</summary>
    public sealed record Unnamed : PathAnswer;

    /// <summary>The path is not the adapter's, or the record index reads nothing of it.</summary>
    public sealed record Untouched : PathAnswer;

    public static PathAnswer Of(IReadOnlyList<RegisteredPlugin> plugins) => plugins.Count > 0 ? new Touches(plugins) : new Untouched();
}
