namespace MEditService.LoadOrder;

/// <summary>Filename plus providing mod folder (ADR-0012): two loaded copies can share a filename.
/// A null <see cref="Origin"/> matches no row where a key names one; in a filter position it means
/// any origin.</summary>
public readonly record struct PluginKey(string Name, string? Origin = null)
{
    public static implicit operator PluginKey(string name) => new(name);

    /// <summary>Both halves compared OrdinalIgnoreCase, the way every other keyed lookup on this
    /// identity compares them; the record's own equality is case-sensitive.</summary>
    public static readonly IEqualityComparer<PluginKey> Comparer = new CaseInsensitiveComparer();

    private sealed class CaseInsensitiveComparer : IEqualityComparer<PluginKey>
    {
        public bool Equals(PluginKey x, PluginKey y) =>
            string.Equals(x.Name, y.Name, StringComparison.OrdinalIgnoreCase)
            && string.Equals(x.Origin, y.Origin, StringComparison.OrdinalIgnoreCase);

        public int GetHashCode(PluginKey key) => HashCode.Combine(
            StringComparer.OrdinalIgnoreCase.GetHashCode(key.Name),
            key.Origin is null ? 0 : StringComparer.OrdinalIgnoreCase.GetHashCode(key.Origin));
    }
}
