using Mutagen.Bethesda;

namespace MEditService.LoadOrder;

/// <summary>One plugin file in the instance (ADR-0013 invariant 2): origin, filename and path.</summary>
public sealed record RegisteredPlugin(string Name, string Origin, string Path)
{
    public PluginAddress Key => new(Name, Origin);
}

/// <summary>ADR-0013 invariant 4: the load order is state, sent by Mod Management, held in the
/// shared kernel, read by both sides. Immutable — nothing here opens, holds or disposes a plugin
/// file.</summary>
public sealed class LoadOrderSnapshot : IEquatable<LoadOrderSnapshot>
{
    /// <summary>No snapshot has arrived.</summary>
    public static readonly LoadOrderSnapshot Empty = new(string.Empty, null, default, [], []);

    private readonly Dictionary<PluginAddress, int> _loadOrderIndex;

    public string DataFolderPath { get; }

    /// <summary>ADR-0009: the MO2 instance root the index file is keyed on, because <c>origin</c> is
    /// a mod folder name and so is unique only within one instance.</summary>
    public string? InstanceRoot { get; }

    public GameRelease GameRelease { get; }

    /// <summary>Every plugin file in the instance, in the order it was given.</summary>
    public IReadOnlyList<RegisteredPlugin> Plugins { get; }

    /// <summary>ADR-0013 invariant 3: the active plugins, in load order, as Mod Management decided
    /// them. A plugin's place here is its load index.</summary>
    public IReadOnlyList<RegisteredPlugin> Active { get; }

    public LoadOrderSnapshot(
        string dataFolderPath, string? instanceRoot, GameRelease gameRelease,
        IReadOnlyList<RegisteredPlugin> plugins, IReadOnlyList<PluginAddress> active)
    {
        DataFolderPath = dataFolderPath;
        InstanceRoot = instanceRoot;
        GameRelease = gameRelease;
        // Copied, not aliased: a caller keeping its list would otherwise mutate this value.
        Plugins = [.. plugins];
        Active = [.. active.Select(address => Plugin(address) ?? throw new ArgumentException(
            $"The active plugin {address.Name} from {address.Origin} is not a plugin in the instance."))];
        _loadOrderIndex = new Dictionary<PluginAddress, int>(PluginAddress.Comparer);
        foreach (var (plugin, index) in Active.Select((plugin, index) => (plugin, index)))
            _loadOrderIndex.TryAdd(plugin.Key, index);
    }

    public bool IsActive(PluginAddress address) => _loadOrderIndex.ContainsKey(address);

    /// <summary>The plugin's place among the active plugins, or null when it is not active.</summary>
    public int? LoadOrderIndex(PluginAddress address) =>
        _loadOrderIndex.TryGetValue(address, out var index) ? index : null;

    public Registration RegistrationOf(PluginAddress address) => new(LoadOrderIndex(address));

    /// <summary>Records that cannot be edited: a plugin the game does not load (ADR-0012 invariant 5)
    /// and a plugin in the game folder, the game's own.</summary>
    public bool IsImmutable(PluginAddress address) =>
        !IsActive(address) || PluginOrigin.IsDataDirectory(address.Origin);

    /// <summary>The folder holding the plugin's file, or null for the game's own Data directory or
    /// Overwrite — origins, not mods (ADR-0012 invariant 2) — or a plugin none registered here
    /// names.</summary>
    public string? ModFolderOf(PluginAddress plugin) =>
        Plugin(plugin) is { } registered ? ModFolderOf(registered.Origin, registered.Path) : null;

    /// <summary>The same rule for a caller already holding a plugin's origin and path.</summary>
    public static string? ModFolderOf(string origin, string pluginPath) =>
        PluginOrigin.IsDataDirectory(origin) || PluginOrigin.IsOverwrite(origin)
            ? null
            : Path.GetDirectoryName(pluginPath);

    /// <summary>The folder holding the plugin's file, every origin alike: unlike ModFolderOf, Data
    /// and Overwrite answer their own folder rather than null.</summary>
    public static string? FileFolderOf(string pluginPath) => Path.GetDirectoryName(pluginPath);

    /// <summary>ADR-0012: origin is required, not optional — the instance can hold two plugins that
    /// share a filename, so the filename alone does not say which.</summary>
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
        && Active.SequenceEqual(other.Active);

    public override bool Equals(object? obj) => Equals(obj as LoadOrderSnapshot);

    // The same comparer Equals uses for each half, or two equal values could hash apart.
    public override int GetHashCode() => HashCode.Combine(
        StringComparer.OrdinalIgnoreCase.GetHashCode(DataFolderPath),
        InstanceRoot is null ? 0 : StringComparer.OrdinalIgnoreCase.GetHashCode(InstanceRoot),
        GameRelease,
        Plugins.Count,
        Active.Count);
}
