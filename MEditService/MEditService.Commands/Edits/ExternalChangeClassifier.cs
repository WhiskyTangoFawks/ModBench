using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.SourceAdapter;

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

        // An untracked plugin has no source to lose, so it is no part of the question.
        var trackedPlugins = plugins.Where(p => SourceRepository.IsPluginTracked(modFolder, p.PluginName)).ToList();
        var changedPlugins = trackedPlugins
            .Where(p => !SourceRepository.MatchesParkedCompileBinary(modFolder, p.PluginName, p.ObservedBytes))
            .Select(p => p.PluginName)
            .ToList();

        var trackedFileChanges = SourceRepository.ChangedTrackedFilesOutsideSource(modFolder);
        if (changedPlugins.Count == 0 && trackedFileChanges.Count == 0) return null;

        // Each plugin's own baseline carries the meta.ini it was taken with, and plugins sharing a
        // repository are taken at different times: the changed plugins' baselines are the ones asked.
        IReadOnlyList<string> asked = changedPlugins.Count > 0 ? changedPlugins : [.. trackedPlugins.Select(p => p.PluginName)];
        var baselines = asked
            .Select(plugin => SourceRepository.LatestBaselineTrailers(modFolder, plugin))
            .OfType<BaselineTrailers>()
            .ToList();
        var meta = SourceRepository.MetaFactsIn(modFolder);

        // Trailers inform the dialog's default, never act: unchanged or absent both mean false.
        var metaChanged = meta.MetaSha256 != null && baselines.Any(baseline => baseline.MetaSha256 != null
            && !string.Equals(baseline.MetaSha256, meta.MetaSha256, StringComparison.OrdinalIgnoreCase));

        return new ExternalChangeClassification.ExternalChange(
            changedPlugins, [.. trackedFileChanges.Select(c => c.RelativePath)], metaChanged,
            baselines.FirstOrDefault()?.UpstreamVersion, meta.UpstreamVersion);
    }

    /// <summary>The mod's unanswered question while its change still stands, or null. The marker caches
    /// the last verdict (ADR-0003): present means classify again, and a verdict of nothing drops
    /// it.</summary>
    public static string? BlockingQuestion(LoadOrderSnapshot loadOrder, string modFolder)
    {
        if (SourceRepository.UnansweredExternalChange(modFolder) is not { } question) return null;

        // A plugin caught mid-write is no verdict, and no verdict keeps the question open.
        if (PluginBytesIn(loadOrder, modFolder) is not { } plugins) return question;

        switch (ClassifyMod(modFolder, plugins))
        {
            case ExternalChangeClassification.ExternalChange:
                return question;
            case null:
                SourceRepository.ClearExternalChangeQuestion(modFolder);
                return null;
            default:
                // An interrupted compile is the repair offer's state, not this question's; the marker
                // waits for a verdict either way.
                return null;
        }
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
