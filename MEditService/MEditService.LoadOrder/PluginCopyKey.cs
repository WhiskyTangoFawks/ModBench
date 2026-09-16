namespace MEditService.LoadOrder;

/// <summary>Filename plus providing mod folder (ADR-0012): two copies can share a filename. The
/// identity every row, lookup and command uses; PluginName is the name-only filter counterpart.
/// </summary>
public readonly record struct PluginCopyKey(string Name, string Origin)
{
    /// <summary>Both halves compared OrdinalIgnoreCase, the way every other keyed lookup on this
    /// identity compares them; the record's own equality is case-sensitive.</summary>
    public static readonly IEqualityComparer<PluginCopyKey> Comparer = new CaseInsensitiveComparer();

    private sealed class CaseInsensitiveComparer : IEqualityComparer<PluginCopyKey>
    {
        public bool Equals(PluginCopyKey x, PluginCopyKey y) =>
            string.Equals(x.Name, y.Name, StringComparison.OrdinalIgnoreCase)
            && string.Equals(x.Origin, y.Origin, StringComparison.OrdinalIgnoreCase);

        public int GetHashCode(PluginCopyKey key) => HashCode.Combine(
            StringComparer.OrdinalIgnoreCase.GetHashCode(key.Name),
            StringComparer.OrdinalIgnoreCase.GetHashCode(key.Origin));
    }
}
