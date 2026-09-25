using MEditService.Codec.Serialization;
using MEditService.Commands;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Ports;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Edits;

/// <summary>The Track gesture end to end: deep-parses each plugin of the selection (the load order's
/// overlay is not always structurally faithful), serializes through the whole-mod door, and
/// commits. A designated door (ADR-0007).</summary>
public sealed class TrackService(
    ILogger<TrackService> logger, IPluginAdapter adapter, INotificationPublisher? notifications = null)
{
    // Read concurrently while a track is in flight. Snapshots are replaced wholesale, never
    // mutated, so Volatile.Read/Write suffices and no lock is needed.
    private TrackProgress _progress = TrackProgress.Idle;
    public TrackProgress Progress => Volatile.Read(ref _progress);
    // ADR-0014: null in every test that does not care, and nothing is published when it is.
    private readonly INotificationPublisher? _notifications = notifications;

    // Asked of the Plugin adapter, never the Index (ADR-0015 invariant 1): a plugin whose file
    // cannot be read has no bytes to deep-parse, so Track refuses that plugin and goes on with the
    // rest.
    private bool Readable(RegisteredPlugin plugin) => adapter.CanRead(plugin);

    /// <summary>Each plugin of the selection lands or is refused on its own (commands.md, "A selection
    /// is one gesture"). git missing refuses the whole selection once, before any write.</summary>
    public async Task<TrackSelectionResult> TrackAsync(
        LoadOrderSnapshot loadOrder,
        IReadOnlyList<PluginAddress> plugins,
        SourcePreset preset,
        CancellationToken cancel = default)
    {
        try
        {
            SourceRepository.EnsureTrackable();
        }
        catch (GitUnavailableException ex)
        {
            return TrackSelectionResult.WholeSelectionRefused(TrackRefusal.GitUnavailable, ex.Message);
        }

        var selection = plugins.Distinct(PluginAddress.Comparer).ToList();
        var refused = new List<TrackRefused>();
        var verified = new List<VerifiedPlugin>();
        try
        {
            for (var done = 0; done < selection.Count; done++)
            {
                cancel.ThrowIfCancellationRequested();
                var plugin = selection[done];
                SetProgress(plugin.Origin, TrackPhase.Parsing, done, selection.Count);
                var outcome = await VerifyAsync(
                    loadOrder, plugin, onParsed: () => SetProgress(plugin.Origin, TrackPhase.Serializing, done, selection.Count), cancel);
                if (outcome.Verified is { } passed) verified.Add(passed);
                if (outcome.Refused is { } refusal) refused.Add(refusal);
                SetProgress(plugin.Origin, TrackPhase.Serializing, done + 1, selection.Count);
            }

            SetProgress(verified.FirstOrDefault()?.Plugin.Origin, TrackPhase.Committing, selection.Count, selection.Count);
            var landed = new List<PluginAddress>();
            foreach (var mod in verified.GroupBy(v => v.ModFolder, StringComparer.Ordinal))
                Commit(mod.Key, preset, [.. mod], landed, refused);

            return TrackSelectionResult.PerPlugin(InSelectionOrder(landed, p => p), InSelectionOrder(refused, r => r.Plugin));
        }
        finally
        {
            // Idle at rest, success or failure alike — a poller must never keep reporting a track that has
            // finished.
            SetProgress(null, TrackPhase.Idle, 0, 0);
        }

        List<T> InSelectionOrder<T>(IEnumerable<T> items, Func<T, PluginAddress> keyOf) =>
            [.. items.OrderBy(item => selection.FindIndex(p => PluginAddress.Comparer.Equals(p, keyOf(item))))];
    }

    private sealed record VerifiedPlugin(PluginAddress Plugin, string ModFolder, IReadOnlyList<TreeFile> Files, string BinarySha256);

    private sealed record Verification(VerifiedPlugin? Verified, TrackRefused? Refused);

    // One repository per mod folder: the plugins that passed their gate, committed one at a time.
    private void Commit(
        string modFolder, SourcePreset preset, IReadOnlyList<VerifiedPlugin> plugins,
        List<PluginAddress> landed, List<TrackRefused> refused)
    {
        var meta = SourceRepository.MetaFactsIn(modFolder);
        IReadOnlyList<(IReadOnlyList<TreeFile> Files, BaselineTrailers Trailers)> baselines =
        [
            .. plugins.Select(v => (v.Files, new BaselineTrailers(v.Plugin.Name, meta.UpstreamVersion, meta.MetaSha256, v.BinarySha256))),
        ];
        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation("Tracking {PluginCount} plugin(s) into {ModFolder}: {FileCount} source files",
                plugins.Count, modFolder, plugins.Sum(v => v.Files.Count));
        }

        IReadOnlyList<(string Plugin, string Reason)> failed;
        try
        {
            failed = SourceRepository.Track(modFolder, preset, baselines);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidOperationException)
        {
            // Creating the repository or checking out its edit branch failed; a baseline already on
            // main landed all the same (decompile-plugin, The command, step 9).
            logger.LogError(ex, "Could not finish tracking into {ModFolder}", modFolder);
            failed = [.. plugins
                .Where(v => !SourceRepository.IsPluginTracked(modFolder, v.Plugin.Name))
                .Select(v => (v.Plugin.Name, ex.Message))];
        }

        foreach (var plugin in plugins.Select(v => v.Plugin))
        {
            if (failed.FirstOrDefault(f => string.Equals(f.Plugin, plugin.Name, StringComparison.OrdinalIgnoreCase)) is { Reason: { } reason })
            {
                logger.LogWarning("Refused to track {Plugin} ({Origin}): its baseline commit failed — {Reason}", plugin.Name, plugin.Origin, reason);
                refused.Add(new TrackRefused(
                    plugin, TrackRefusal.CommitFailed, $"{plugin.Name}'s baseline could not be committed: {reason}"));
            }
            else
            {
                landed.Add(plugin);
            }
        }
    }

    // Nothing of the plugin is written here: every refusal comes before its commit (ADR-0006 decision 2).
    private async Task<Verification> VerifyAsync(
        LoadOrderSnapshot loadOrder, PluginAddress key, Action onParsed, CancellationToken cancel)
    {
        Verification Refuse(TrackRefusal refusal, string message) => new(null, new TrackRefused(key, refusal, message));

        if (loadOrder.Plugin(key) is not { } plugin)
        {
            return Refuse(TrackRefusal.PluginNotLoaded,
                $"{key.Name} from '{key.Origin}' is not in the load order, so there is nothing to track.");
        }

        // The load order is the one rule for a plugin's mod folder: null for the game's own Data
        // directory (PluginOrigin.DataDirectory), where Track must not git-init.
        if (LoadOrderSnapshot.ModFolderOf(plugin.Origin, plugin.Path) is not { } modFolder)
        {
            return Refuse(TrackRefusal.DataDirectoryOrigin,
                $"{plugin.Name} is a base-game plugin loaded from the game's own Data folder, " +
                "and the game's own plugins cannot be tracked in place. Author a patch plugin and track that instead.");
        }

        if (SourceRepository.IsPluginTracked(modFolder, plugin.Name))
            return Refuse(TrackRefusal.AlreadyTracked, $"{plugin.Name} is already tracked in '{modFolder}'.");

        // ADR-0003: a repository with history but no main is someone else's, never written to.
        if (SourceRepository.HoldsAnotherRepository(modFolder))
            return Refuse(TrackRefusal.AlreadyTracked, $"'{modFolder}' is already tracked.");

        if (WriteTargets.BlockingQuestion(loadOrder, modFolder) is { } question)
            return Refuse(TrackRefusal.ExternalChangeUnanswered, question);

        if (!Readable(plugin))
        {
            return Refuse(TrackRefusal.RoundTripFailed,
                $"{plugin.Name} cannot be read from its own binary. Close whatever holds the file, then track again.");
        }

        // Naming where the strings are: "pass nothing" is not neutral for a Localized plugin.
        var strings = new PluginStrings(modFolder, loadOrder.DataFolderPath);

        // A fresh deep parse, not the load order's own overlay, whose lifetime Track does not control.
        (IReadOnlyList<TreeFile> Files, string? MissingStringsFile) tree;
        try
        {
            tree = await adapter.ReadSourceOfAsync(plugin, loadOrder.GameRelease, strings, cancel);
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            // A raw parse exception's Message carries no located identity; the diagnosis walks the tree for
            // the innermost RecordException.
            var diagnosis = PluginDiagnosis.FromParseException(ex);
            logger.LogWarning(ex, "Refused to track {Plugin}: its own binary could not be deep-parsed", plugin.Name);
            return Refuse(TrackRefusal.RoundTripFailed,
                $"{plugin.Name} could not be parsed from its own binary: {diagnosis.Describe()}");
        }

        if (tree.MissingStringsFile is { } missingFile)
        {
            return Refuse(TrackRefusal.MissingLocalizationStrings,
                $"{plugin.Name} is a localized plugin but its strings file '{missingFile}' was not found " +
                $"in {strings.Folder}. Restore the file, then track again.");
        }

        // Where the door's tree lands in the mod folder is the repository's answer, and the round-trip
        // gate below reads the same files the commit will hold.
        onParsed();
        var pristineFiles = SourceRepository.PristineFilesOf(plugin.Name, tree.Files);
        if (await VerifyRoundTrip(plugin.Name, plugin.Path, pristineFiles, loadOrder.GameRelease, strings, cancel) is { } refusal)
            return Refuse(TrackRefusal.RoundTripFailed, refusal);

        return new Verification(
            new VerifiedPlugin(key, modFolder, pristineFiles, PluginBinaryHash.TrailerFormOfFile(plugin.Path)), null);
    }

    // ADR-0006 decision 2's gate: the tree is read back, recompiled and reparsed; refuses unless every
    // record is model-identical. Reparse, not the pre-write object: only written bytes show what the
    // writer does.
    private async Task<string?> VerifyRoundTrip(
        string pluginName,
        string originalPluginPath,
        IReadOnlyList<TreeFile> pristineFilesForThisPlugin,
        GameRelease gameRelease,
        PluginStrings strings,
        CancellationToken cancel)
    {
        using var scratch = SourceRepository.ScratchFor(pluginName);
        var recompiledPath = scratch.PluginPath;
        try
        {
            await adapter.WriteFromTreeAsync(pristineFilesForThisPlugin, recompiledPath, cancel);
        }
        catch (Exception ex) when (PluginDiagnosis.HasUnmappableFormID(ex))
        {
            // ADR-0008's content-derived master pass prunes a master this write still needs when the only
            // reference lives in a VMAD struct-list property Mutagen never walks (upstream issue 688). Never
            // widen this catch.
            var diagnosis = PluginDiagnosis.FromWriteException(ex);
            logger.LogWarning(ex, "Refused to track {Plugin}: its round-trip write dropped a needed master", pluginName);
            return $"{pluginName} does not round-trip through its own tracked source: {diagnosis.Describe()}";
        }

        var originalBytes = await PluginBinaryHash.ExactBytesOfFileAsync(originalPluginPath, cancel);
        var recompiledBytes = await PluginBinaryHash.ExactBytesOfFileAsync(recompiledPath, cancel);
        if (originalBytes.AsSpan().SequenceEqual(recompiledBytes))
            return null;

        if (PluginBinaryWalk.FindFirstSubrecordLoss(originalBytes, recompiledBytes) is { } loss)
        {
            // A Kind B diagnosis on the record names the cause ahead of the drop it produced.
            var kindB = MalformedPluginScan.Scan(originalBytes).FirstOrDefault(d =>
                d.Anchor?.StartsWith($"{loss.RecordType} {loss.FormId:X8}", StringComparison.Ordinal) == true);
            return $"{pluginName} does not round-trip through its own tracked source: " + (kindB != null
                ? $"{kindB.Describe()} — parsing the malformed subrecord dropped " +
                  $"{string.Join(", ", loss.Signatures)} before Track ever wrote its source."
                : $"{loss.RecordType} {loss.FormId:X8} is missing {string.Join(", ", loss.Signatures)} " +
                  "present in the original — dropped during parsing, before Track ever wrote its source.");
        }

        if (adapter.DivergenceFrom(
                pluginName, originalPluginPath, recompiledPath, gameRelease, strings) is { } divergence)
        {
            return $"{pluginName} does not round-trip through its own tracked source: {divergence}";
        }

        // Model-identical but not byte-identical: an encoding-only difference ADR-0006 decision 2
        // documents rather than gates. Reported, never a refusal.
        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "{Plugin} is model-identical to its own tracked source but not byte-identical — " +
                "Save & Compile will not reproduce this plugin's exact bytes (ADR-0006 decision 2).",
                pluginName);
        }

        return null;
    }


    private void SetProgress(string? origin, TrackPhase phase, int pluginsDone, int pluginsTotal)
    {
        var progress = new TrackProgress(origin, phase, pluginsDone, pluginsTotal);
        Volatile.Write(ref _progress, progress);
        _notifications?.Publish(new TrackProgressNotification(progress));
    }
}
