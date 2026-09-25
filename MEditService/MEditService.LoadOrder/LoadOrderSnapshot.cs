using Mutagen.Bethesda;

namespace MEditService.LoadOrder;

/// <summary>One registered plugin (ADR-0013): a plugin file in the instance, its <c>plugins.txt</c> slot —
/// null when no line names it — and the booleans Mod Management resolves for it. IsForced: loaded
/// regardless of that list.</summary>
public sealed record RegisteredPlugin(
    string Name, string Origin, string Path, int? Slot, bool Enabled, bool Winning, bool IsForced = false)
{
    public PluginAddress Key => new(Name, Origin);

    public Registration Registration => new(Slot, Enabled, Winning);

    /// <summary>Read-only for editing: a forced master (ADR-0012 — the game's own files are never
    /// a write target), or a plugin the load order does not name, where editing changes nothing.
    /// </summary>
    public bool IsImmutable => IsForced || !Registration.InLoadOrder;

    public static RegisteredPlugin Of(LoadOrderEntry entry, int slotOffset = 0) =>
        new(entry.Name, entry.Origin, entry.Path,
            entry.Slot is { } slot ? slotOffset + slot : null, entry.Enabled, entry.Winning);

    /// <summary>A plugin the install loads with no list line of its own (ADR-0013 invariant 2): in
    /// the game's own Data directory, enabled, winning and forced, at the slot the game gives it.
    /// </summary>
    public static RegisteredPlugin Forced(string dataFolder, string name, int slot) =>
        new(name, PluginOrigin.DataDirectory, System.IO.Path.Combine(dataFolder, name), slot, Enabled: true, Winning: true, IsForced: true);
}

/// <summary>ADR-0013 invariant 4: the load order is state, sent by Mod Management, held in the
/// shared kernel with ADR-0013's rules, read by both sides. Immutable — nothing here opens, holds or
/// disposes a plugin file.</summary>
public sealed class LoadOrderSnapshot : IEquatable<LoadOrderSnapshot>
{
    /// <summary>No snapshot has arrived.</summary>
    public static readonly LoadOrderSnapshot Empty = new(string.Empty, null, default, []);

    public string DataFolderPath { get; }

    /// <summary>ADR-0009: the MO2 instance root the index file is keyed on, because <c>origin</c> is
    /// a mod folder name and so is unique only within one instance.</summary>
    public string? InstanceRoot { get; }

    public GameRelease GameRelease { get; }

    /// <summary>Every plugin file in the instance, in the order it was given (ADR-0013: overridden
    /// and unlisted plugins are registered like any other).</summary>
    public IReadOnlyList<RegisteredPlugin> Plugins { get; }

    public LoadOrderSnapshot(
        string dataFolderPath, string? instanceRoot, GameRelease gameRelease, IReadOnlyList<RegisteredPlugin> plugins)
    {
        DataFolderPath = dataFolderPath;
        InstanceRoot = instanceRoot;
        GameRelease = gameRelease;
        // Copied, not aliased: a caller keeping its list would otherwise mutate this value.
        Plugins = [.. plugins];
    }

    /// <summary>ADR-0013: participation is derived, never stored — enabled, winning, and named by a
    /// <c>plugins.txt</c> line. Only a participating plugin competes for winner or counts in a
    /// conflict.</summary>
    public bool Participates(PluginAddress address) => Plugin(address)?.Registration.Participates ?? false;

    /// <summary>The plugin the Mod override order resolves <paramref name="name"/> to, or null when no
    /// registered plugin of that name wins.</summary>
    public RegisteredPlugin? WinningPlugin(PluginName name) =>
        Plugins.FirstOrDefault(c => c.Winning && c.Name.Equals(name.Name, StringComparison.OrdinalIgnoreCase));

    /// <summary>The participating plugins in slot order — the load order the game actually has.</summary>
    public IReadOnlyList<RegisteredPlugin> Participating =>
        [.. Plugins.Where(c => c.Registration.Participates).OrderBy(c => c.Slot
            ?? throw new InvalidOperationException(
                $"Expected participating plugin '{c.Name}' from '{c.Origin}' to carry a load-order slot."))];

    /// <summary>The three facts one plugin is registered with, or null when it is not registered.</summary>
    public Registration? Registration(PluginAddress address) => Plugin(address)?.Registration;

    /// <summary>This load order with one more registered plugin, replacing any plugin already
    /// registered under the same identity (ADR-0007: a created plugin is a member at once).</summary>
    public LoadOrderSnapshot With(RegisteredPlugin plugin) =>
        new(DataFolderPath, InstanceRoot, GameRelease, [.. Plugins.Where(c => !SameAddress(c, plugin.Key)), plugin]);

    /// <summary>This load order without the plugin registered under <paramref name="address"/>, unchanged
    /// when none is (ADR-0007: a create that could not write its file takes its registration back).
    /// </summary>
    public LoadOrderSnapshot Without(PluginAddress address) =>
        new(DataFolderPath, InstanceRoot, GameRelease, [.. Plugins.Where(c => !SameAddress(c, address))]);

    /// <summary>The folder holding the plugin's file, or null for a master resolved from the game's
    /// own Data directory (Track does not apply there) or a plugin none registered here names.</summary>
    public string? ModFolderOf(PluginAddress plugin) =>
        Plugin(plugin) is { } registered ? ModFolderOf(registered.Origin, registered.Path) : null;

    /// <summary>The same rule for a caller already holding a plugin's origin and path.</summary>
    public static string? ModFolderOf(string origin, string pluginPath) =>
        string.Equals(origin, PluginOrigin.DataDirectory, StringComparison.OrdinalIgnoreCase)
            ? null
            : Path.GetDirectoryName(pluginPath);

    /// <summary>The folder every plugin under one origin shares, for a gesture the mod folder is the
    /// unit of. Null when no registered plugin carries the origin.</summary>
    public string? ModFolderOfOrigin(string origin) =>
        Plugins.FirstOrDefault(c => c.Origin.Equals(origin, StringComparison.OrdinalIgnoreCase)) is { } plugin
            ? ModFolderOf(plugin.Origin, plugin.Path)
            : null;

    /// <summary>Every plugin the mod holds, for a gesture the mod is the unit of — Absorb and
    /// Keep.</summary>
    public IReadOnlyList<RegisteredPlugin> PluginsOfOrigin(string origin) =>
        [.. Plugins.Where(c => c.Origin.Equals(origin, StringComparison.OrdinalIgnoreCase))];

    /// <summary>ADR-0012: origin is required, not optional — the load order can register two plugins
    /// that share a filename, so the filename alone does not say which.</summary>
    public RegisteredPlugin? Plugin(PluginAddress address) => Plugins.FirstOrDefault(c => SameAddress(c, address));

    private static bool SameAddress(RegisteredPlugin plugin, PluginAddress address) =>
        plugin.Name.Equals(address.Name, StringComparison.OrdinalIgnoreCase)
        && plugin.Origin.Equals(address.Origin, StringComparison.OrdinalIgnoreCase);

    // Structural, not a record's default: Plugins is interface-typed, and its reference equality would
    // make two values built from one snapshot unequal.
    public bool Equals(LoadOrderSnapshot? other) =>
        other is not null
        && GameRelease == other.GameRelease
        && string.Equals(DataFolderPath, other.DataFolderPath, StringComparison.OrdinalIgnoreCase)
        && string.Equals(InstanceRoot, other.InstanceRoot, StringComparison.OrdinalIgnoreCase)
        && Plugins.SequenceEqual(other.Plugins);

    public override bool Equals(object? obj) => Equals(obj as LoadOrderSnapshot);

    // The same comparer Equals uses for each half, or two equal values could hash apart.
    public override int GetHashCode() => HashCode.Combine(
        StringComparer.OrdinalIgnoreCase.GetHashCode(DataFolderPath),
        InstanceRoot is null ? 0 : StringComparer.OrdinalIgnoreCase.GetHashCode(InstanceRoot),
        GameRelease,
        Plugins.Count);
}
