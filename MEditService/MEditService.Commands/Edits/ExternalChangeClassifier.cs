using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.SourceRepo;

namespace MEditService.Commands.Edits;

/// <summary>Shared by the live watcher, the load-time hash check and the write gate: a mod changed
/// externally when a plugin's bytes differ from Modbench's own write, or a tracked file differs
/// from source control.</summary>
internal static class ExternalChangeClassifier
{
    /// <summary>Null for an untracked mod folder, and null when neither half of the rule found
    /// anything — meta.ini alone included, since it is neither a tracked file nor a plugin's
    /// bytes.</summary>
    public static ExternalChangeClassification? ClassifyMod(
        string modFolder, IReadOnlyList<(string PluginName, byte[] ObservedBytes)> plugins)
    {
        if (!SourceRepository.IsTracked(modFolder)) return null;

        // A marker means Modbench's own interrupted compile, routed to repair, never this dialog.
        if (CompileJournal.UnfinishedBatch(modFolder) != null)
            return new ExternalChangeClassification.CrashRecovery();

        var changedPlugins = plugins
            .Where(p => !SourceRepository.MatchesParkedCompileBinary(modFolder, p.PluginName, p.ObservedBytes))
            .Select(p => p.PluginName)
            .ToList();

        var trackedFileChanges = SourceRepository.ChangedTrackedFilesOutsideSource(modFolder);
        if (changedPlugins.Count == 0 && trackedFileChanges.Count == 0) return null;

        // Mod-wide, so any tracked plugin's name resolves the same trailers off refs/heads/main.
        var representative = plugins.Count > 0 ? plugins[0].PluginName : "";
        var baseline = SourceRepository.LatestBaselineTrailers(modFolder, representative);
        var meta = SourceRepository.MetaFactsIn(modFolder);

        // Trailers inform the dialog's default, never act: unchanged or absent both mean false.
        var metaChanged = baseline?.MetaSha256 != null && meta.MetaSha256 != null
            && !string.Equals(baseline.MetaSha256, meta.MetaSha256, StringComparison.OrdinalIgnoreCase);

        return new ExternalChangeClassification.ExternalChange(
            changedPlugins, [.. trackedFileChanges.Select(c => c.RelativePath)], metaChanged, baseline?.UpstreamVersion, meta.UpstreamVersion);
    }

    /// <summary>Every plugin the load order holds in <paramref name="modFolder"/>, read fresh off
    /// disk, or null when one cannot be read — a partial set would classify the rest as the whole
    /// mod.</summary>
    public static List<(string PluginName, byte[] ObservedBytes)>? PluginBytesIn(
        LoadOrderSnapshot loadOrder, string modFolder)
    {
        var plugins = new List<(string, byte[])>();
        foreach (var copy in loadOrder.Copies)
        {
            if (!string.Equals(LoadOrderSnapshot.ModFolderOf(copy.Origin, copy.Path), modFolder, StringComparison.Ordinal))
                continue;
            if (PluginBinaryHash.BytesOfFile(copy.Path) is not { } bytes) return null;
            plugins.Add((copy.Name, bytes));
        }
        return plugins;
    }
}

/// <summary>What classification answers. Never both a crash and an external change for one
/// settle.</summary>
internal abstract record ExternalChangeClassification
{
    /// <summary>An interrupted compile: routes to the repair offer, never this dialog.</summary>
    public sealed record CrashRecovery : ExternalChangeClassification;

    /// <summary>A genuine external change. Plugins names every plugin whose bytes changed;
    /// TrackedFiles names every changed tracked path outside source/ — either, or both.</summary>
    public sealed record ExternalChange(
        IReadOnlyList<string> Plugins, IReadOnlyList<string> TrackedFiles,
        bool MetaChanged, string? OldVersion, string? NewVersion) : ExternalChangeClassification;

    private ExternalChangeClassification()
    {
    }
}
