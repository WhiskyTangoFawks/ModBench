using MEditService.Core.Plugins;

namespace MEditService.Core.Source;

/// <summary>The one place the mod-folder rule for a plugin lives. Nothing is cached: tracked is the
/// presence of <c>.git</c> (ADR-0007), re-derived every call because MO2 can replace the folder at
/// any time.</summary>
public static class ModFolders
{
    /// <summary>The folder holding the plugin's file, or null for a vanilla/DLC master resolved from the
    /// game's own Data directory (Track does not apply there) or a plugin the load order does not
    /// know.</summary>
    public static string? Of(LoadOrder loadOrder, PluginKey plugin) =>
        loadOrder.Copy(plugin) is { } copy ? Of(copy.Origin, copy.Path) : null;

    /// <summary>The same rule for callers already holding a plugin's metadata.</summary>
    public static string? Of(string origin, string pluginPath)
    {
        if (string.Equals(origin, PluginOrigin.DataDirectory, StringComparison.OrdinalIgnoreCase))
            return null;

        return Path.GetDirectoryName(pluginPath);
    }

    /// <summary>The folder every copy under one origin shares, for a gesture the repository is the
    /// unit of — rebase. Null when no registered copy carries the origin.</summary>
    public static string? OfOrigin(LoadOrder loadOrder, string origin) =>
        loadOrder.Copies.FirstOrDefault(c => c.Origin.Equals(origin, StringComparison.OrdinalIgnoreCase))
            is { } copy
            ? Of(copy.Origin, copy.Path)
            : null;

    /// <summary>Every plugin the mod holds, for a gesture the mod is the unit of — Absorb and
    /// Keep.</summary>
    public static IReadOnlyList<RegisteredCopy> PluginsOfOrigin(LoadOrder loadOrder, string origin) =>
        [.. loadOrder.Copies.Where(c => c.Origin.Equals(origin, StringComparison.OrdinalIgnoreCase))];

    /// <summary>"Editing requires tracking; viewing never does" (ADR-0007).</summary>
    public static bool IsEditable(string origin, string pluginPath) =>
        Of(origin, pluginPath) is { } modFolder && SourceRepository.IsTracked(modFolder);

    /// <summary>The mod folder only when it is tracked — the single condition under which a plugin has
    /// source text at all.</summary>
    public static string? TrackedOf(LoadOrder loadOrder, PluginKey plugin) =>
        Tracked(Of(loadOrder, plugin));

    private static string? Tracked(string? modFolder) =>
        modFolder is not null && SourceRepository.IsTracked(modFolder) ? modFolder : null;
}
