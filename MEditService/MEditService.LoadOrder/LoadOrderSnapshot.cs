using Mutagen.Bethesda;

namespace MEditService.LoadOrder;

/// <summary>One plugin file in the instance (ADR-0013).</summary>
public sealed record RegisteredPlugin(string Name, string Origin, string Path, PluginProvider Provider)
{
    public PluginAddress Key => new(Name, Origin);
}

/// <summary>ADR-0013's snapshot. Immutable: nothing here opens, holds or disposes a
/// plugin file.</summary>
public sealed class LoadOrderSnapshot : IEquatable<LoadOrderSnapshot>
{
    /// <summary>No snapshot has arrived.</summary>
    public static readonly LoadOrderSnapshot Empty = new(string.Empty, null, default, [], [], []);

    private readonly Dictionary<PluginAddress, int> _loadOrderIndex;

    public string DataFolderPath { get; }

    /// <summary>One index file per instance, inside the instance root (ADR-0010).</summary>
    public string? InstanceRoot { get; }

    public GameRelease GameRelease { get; }

    /// <summary>Every plugin file in the instance, in the order it was given.</summary>
    public IReadOnlyList<RegisteredPlugin> Plugins { get; }

    /// <summary>The active plugins, in load order (ADR-0013).</summary>
    public IReadOnlyList<RegisteredPlugin> Active { get; }

    /// <summary>The plugins Mod Management loads with no line: the game's own, a DLC's or a Creation
    /// Club plugin.</summary>
    public IReadOnlyList<RegisteredPlugin> LoadedWithNoLine { get; }

    public LoadOrderSnapshot(
        string dataFolderPath, string? instanceRoot, GameRelease gameRelease, IReadOnlyList<RegisteredPlugin> plugins,
        IReadOnlyList<PluginAddress> active, IReadOnlyList<PluginAddress> loadedWithNoLine)
    {
        if (RefusalOf(plugins, active, loadedWithNoLine) is { } refusal) throw new ArgumentException(refusal);
        DataFolderPath = dataFolderPath;
        InstanceRoot = instanceRoot;
        GameRelease = gameRelease;
        // Copied, not aliased: a caller keeping its list would otherwise mutate this value.
        Plugins = [.. plugins];
        _loadOrderIndex = active.Select((address, index) => (address, index))
            .ToDictionary(a => a.address, a => a.index, PluginAddress.Comparer);
        Active = [.. active.Select(PluginRefusalOfVouchesFor)];
        LoadedWithNoLine = [.. loadedWithNoLine.Select(PluginRefusalOfVouchesFor)];
    }

    private RegisteredPlugin PluginRefusalOfVouchesFor(PluginAddress address) => Plugin(address)
        ?? throw new InvalidOperationException($"Expected RefusalOf to have refused {address.Name} from {address.Origin}.");

    /// <summary>Why these plugins and active plugins make no snapshot, or null when they do. The
    /// game loads one file per name, and a FormID or a winner is read by filename.</summary>
    public static string? RefusalOf(
        IReadOnlyList<RegisteredPlugin> plugins, IReadOnlyList<PluginAddress> active, IReadOnlyList<PluginAddress> loadedWithNoLine)
    {
        var sent = plugins.Select(p => p.Key).ToHashSet(PluginAddress.Comparer);
        string? StrayIn(IReadOnlyList<PluginAddress> named) =>
            named.Where(a => !sent.Contains(a)).Select(a => $"{a.Name} from {a.Origin}").FirstOrDefault();
        if (StrayIn(active) is { } stray) return $"The active plugin {stray} is not a plugin in the snapshot.";
        if (StrayIn(loadedWithNoLine) is { } unlined)
            return $"The plugin loaded with no line {unlined} is not a plugin in the snapshot.";

        var contested = active
            .GroupBy(a => a.Name, StringComparer.OrdinalIgnoreCase)
            .FirstOrDefault(g => g.Count() > 1);
        return contested is null
            ? null
            : $"The snapshot names more than one active {contested.Key}: " +
              $"{string.Join(", ", contested.Select(a => a.Origin))}. The game loads one file per name.";
    }

    public bool IsActive(PluginAddress address) => _loadOrderIndex.ContainsKey(address);

    /// <summary>The plugin's place among the active plugins, or null when it is not active.</summary>
    public int? LoadOrderIndex(PluginAddress address) =>
        _loadOrderIndex.TryGetValue(address, out var index) ? index : null;

    public Registration RegistrationOf(PluginAddress address) => new(LoadOrderIndex(address));

    /// <summary>Records that cannot be edited: a plugin the game does not load (ADR-0012)
    /// and one the game provides (editor.md's read-only status).</summary>
    public bool IsImmutable(PluginAddress address) => !IsActive(address) || ProviderOf(address) == PluginProvider.Game;

    /// <summary>What provides the plugin, or null for a plugin none registered here names.</summary>
    public PluginProvider? ProviderOf(PluginAddress plugin) => Plugin(plugin)?.Provider;

    /// <summary>The folder holding the plugin's file, every origin alike, Data and
    /// Overwrite included.</summary>
    public static string? FileFolderOf(string pluginPath) => Path.GetDirectoryName(pluginPath);

    /// <summary>By identity, origin and filename together (ADR-0012).</summary>
    public RegisteredPlugin? Plugin(PluginAddress address) =>
        Plugins.FirstOrDefault(c => PluginAddress.Comparer.Equals(c.Key, address));

    // Structural, not a record's default: the lists are interface-typed, and their reference
    // equality would make two values built from one snapshot unequal.
    public bool Equals(LoadOrderSnapshot? other) =>
        other is not null
        && GameRelease == other.GameRelease
        && string.Equals(DataFolderPath, other.DataFolderPath, StringComparison.OrdinalIgnoreCase)
        && string.Equals(InstanceRoot, other.InstanceRoot, StringComparison.OrdinalIgnoreCase)
        && Plugins.SequenceEqual(other.Plugins)
        && Active.SequenceEqual(other.Active)
        && LoadedWithNoLine.SequenceEqual(other.LoadedWithNoLine);

    public override bool Equals(object? obj) => Equals(obj as LoadOrderSnapshot);

    // The same comparer Equals uses for each half, or two equal values could hash apart.
    public override int GetHashCode() => HashCode.Combine(
        StringComparer.OrdinalIgnoreCase.GetHashCode(DataFolderPath),
        InstanceRoot is null ? 0 : StringComparer.OrdinalIgnoreCase.GetHashCode(InstanceRoot),
        GameRelease,
        Plugins.Count,
        Active.Count);
}
