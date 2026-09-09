using System.Security.Cryptography;

namespace MEditService.Core.Source;

/// <summary>Shared by the live watcher and the load-time hash check: a mod changed externally when a
/// plugin's bytes differ from Modbench's own write, or a tracked file differs from source
/// control's view.</summary>
public static class ExternalChangeClassifier
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

        var changedPlugins = new List<string>();
        foreach (var (name, bytes) in plugins)
        {
            var observedSha256 = Convert.ToHexStringLower(SHA256.HashData(bytes));
            var parkedSha256 = SourceRepository.ParkedCompileBinarySha256(modFolder, name);

            // A missing parked ref is never a match — degrade to reporting a change, never guess
            // self-echo from an absent ref.
            if (parkedSha256 != null && string.Equals(observedSha256, parkedSha256, StringComparison.OrdinalIgnoreCase))
                continue;

            changedPlugins.Add(name);
        }

        var trackedFileChanges = SourceRepository.ChangedTrackedFilesOutsideSource(modFolder);
        if (changedPlugins.Count == 0 && trackedFileChanges.Count == 0) return null;

        // Mod-wide, so any tracked plugin's name resolves the same trailers off refs/heads/main.
        var representative = plugins.Count > 0 ? plugins[0].PluginName : "";
        var baseline = SourceRepository.LatestBaselineTrailers(modFolder, representative);
        var newVersion = MetaIni.ReadVersion(modFolder);
        var newMetaSha256 = MetaIni.ComputeSha256(modFolder);

        // Trailers inform the dialog's default, never act: unchanged or absent both mean false.
        var metaChanged = baseline?.MetaSha256 != null && newMetaSha256 != null
            && !string.Equals(baseline.MetaSha256, newMetaSha256, StringComparison.OrdinalIgnoreCase);

        return new ExternalChangeClassification.ExternalChange(
            changedPlugins, [.. trackedFileChanges.Select(c => c.RelativePath)], metaChanged, baseline?.UpstreamVersion, newVersion);
    }
}

/// <summary>What classification answers. Never both a crash and an external change for one
/// settle.</summary>
public abstract record ExternalChangeClassification
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
