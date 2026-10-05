namespace MEditService.LoadOrder;

/// <summary>A plugin's identity (ADR-0012); PluginName is the name-only filter
/// counterpart.</summary>
public readonly record struct PluginAddress(string Name, string Origin)
{
    /// <summary>Matches every other keyed lookup on this identity.</summary>
    public static readonly IEqualityComparer<PluginAddress> Comparer = new CaseInsensitiveComparer();

    private sealed class CaseInsensitiveComparer : IEqualityComparer<PluginAddress>
    {
        public bool Equals(PluginAddress x, PluginAddress y) =>
            string.Equals(x.Name, y.Name, StringComparison.OrdinalIgnoreCase)
            && string.Equals(x.Origin, y.Origin, StringComparison.OrdinalIgnoreCase);

        public int GetHashCode(PluginAddress key) => HashCode.Combine(
            StringComparer.OrdinalIgnoreCase.GetHashCode(key.Name),
            StringComparer.OrdinalIgnoreCase.GetHashCode(key.Origin));
    }
}

/// <summary>A record and the plugin holding it (ADR-0012).</summary>
public readonly record struct RecordAt(PluginAddress Plugin, string FormKey);
