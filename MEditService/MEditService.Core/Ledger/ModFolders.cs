using MEditService.Core.Records;
using MEditService.Core.Session;

namespace MEditService.Core.Ledger;

/// <summary>
/// Where a plugin's ledger would live — the one place the "which folder is this plugin's mod folder"
/// rule is written down, shared by the edit path and by read-time freshness so the two can never
/// disagree about whether a given plugin is editable.
///
/// Nothing is cached. Tracked *is* the presence of <c>.git</c> (ADR-0041), and a mod folder can be
/// created, destroyed or replaced outside Modbench between any two calls — MO2's Replace install
/// shell-deletes the whole folder — so the answer is re-derived every time it is asked.
/// </summary>
internal static class ModFolders
{
    /// <summary>
    /// The folder holding <paramref name="plugin"/>'s physical file, or null when the plugin has no
    /// mod folder at all: a vanilla or DLC master resolved from the game's own Data directory, where
    /// Track does not apply and the blessed path is a patch plugin instead. Also null when the
    /// session does not know this plugin.
    /// </summary>
    internal static string? Of(IGameSession? session, PluginKey plugin)
    {
        var metadata = session?.Plugins.FirstOrDefault(p =>
            p.Name.Equals(plugin.Name, StringComparison.OrdinalIgnoreCase)
            && p.Origin.Equals(plugin.Origin, StringComparison.OrdinalIgnoreCase));

        return metadata is null ? null : Of(metadata.Origin, metadata.Path);
    }

    /// <summary>The same rule stated over the two facts it actually needs, for callers that already
    /// hold a plugin's own metadata and have no reason to look it up again by name.</summary>
    internal static string? Of(string origin, string pluginPath)
    {
        if (string.Equals(origin, PluginOrigin.DataDirectory, StringComparison.OrdinalIgnoreCase))
            return null;

        return Path.GetDirectoryName(pluginPath);
    }

    /// <summary>Whether this plugin's records can be edited at all: it has a mod folder, and that
    /// folder is tracked. The single fact the editing surfaces gate on — "editing requires
    /// tracking; viewing never does" (ADR-0041).</summary>
    internal static bool IsEditable(string origin, string pluginPath) =>
        Of(origin, pluginPath) is { } modFolder && LedgerRepository.IsTracked(modFolder);

    /// <summary>The mod folder only when it is actually tracked — the single condition under which a
    /// plugin has ledger text to read or write at all.</summary>
    internal static string? TrackedOf(IGameSession? session, PluginKey plugin) =>
        Of(session, plugin) is { } modFolder && LedgerRepository.IsTracked(modFolder) ? modFolder : null;
}
