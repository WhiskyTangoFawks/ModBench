using System.Security.Cryptography;
using MEditService.Core.Commands;
using MEditService.Core.Notifications;
using MEditService.Core.PluginAdapter;
using MEditService.Core.Plugins;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Core.Source;

/// <summary>The Track gesture end to end: deep-parses each plugin under one origin (the load order's
/// overlay is not always structurally faithful), serializes through the whole-mod door, and
/// commits. A designated door (ADR-0041).</summary>
public sealed class TrackService(ILogger<TrackService> logger, INotificationPublisher? notifications = null)
{
    // Read concurrently while a track is in flight. Snapshots are replaced wholesale, never
    // mutated, so Volatile.Read/Write suffices and no lock is needed.
    private TrackProgress _progress = TrackProgress.Idle;
    public TrackProgress Progress => Volatile.Read(ref _progress);
    // ADR-0046: null in every test that does not care, and nothing is published when it is.
    private readonly INotificationPublisher? _notifications = notifications;

    /// <summary>ADR-0046: raised with the mod folder and origin of a repository that now exists, so
    /// the Source watcher starts on a tracked mod with no restart.</summary>
    public Action<string, string>? RepositoryCreated { get; set; }

    private static bool Held(IReadOnlyCollection<PluginKey> heldCopies, RegisteredCopy copy) =>
        heldCopies.Any(k =>
            k.Name.Equals(copy.Name, StringComparison.OrdinalIgnoreCase)
            && string.Equals(k.Origin, copy.Origin, StringComparison.OrdinalIgnoreCase));

    public Task<TrackResult> TrackAsync(
        LoadOrder loadOrder, IReadOnlyCollection<PluginKey> heldCopies, string origin, SourcePreset preset,
        CancellationToken cancel = default) =>
        TrackAsync(loadOrder, heldCopies, origin, preset, deserializeForVerification: null, cancel);

    /// <summary>Same gesture with one extra seam: how the round-trip gate reads the tree back. Null gets
    /// the real whole-mod door. Only a negative test overrides it: no known codec defect can trigger
    /// the gate for real.</summary>
    internal async Task<TrackResult> TrackAsync(
        LoadOrder loadOrder,
        IReadOnlyCollection<PluginKey> heldCopies,
        string origin,
        SourcePreset preset,
        TreeDeserializer? deserializeForVerification,
        CancellationToken cancel = default)
    {
        // A copy the Index could not open has no bytes to deep-parse, so Track passes over it
        // rather than failing the whole origin on it.
        var plugins = loadOrder.Copies
            .Where(p => p.Origin.Equals(origin, StringComparison.OrdinalIgnoreCase) && Held(heldCopies, p))
            .ToList();
        if (plugins.Count == 0)
            return TrackResult.Refused(TrackRefusal.NoPluginWithOrigin, $"No loaded plugin has origin '{origin}' to track.");

        // ModFolders is the one rule for a plugin's mod folder: null for the game's own Data
        // directory (PluginOrigin.DataDirectory), where Track must not git-init.
        if (ModFolders.OfOrigin(loadOrder, origin) is not { } modFolder)
        {
            return TrackResult.Refused(
                TrackRefusal.DataDirectoryOrigin,
                $"{plugins[0].Name} is a base-game plugin loaded from the game's own Data folder, " +
                "and the game's own plugins cannot be tracked in place. Author a patch plugin and track that instead.");
        }

        // Both checks are cheap and both make the whole parse loop pointless if they fail, so they run first.
        if (SourceRepository.IsTracked(modFolder))
            return TrackResult.Refused(TrackRefusal.AlreadyTracked, $"'{modFolder}' is already tracked.");

        try
        {
            GitCli.EnsureOnPath();

            var pristineFiles = new List<PristineFile>();
            var binaryHashesByPlugin = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

            var strings = new PluginStrings(modFolder, loadOrder.DataFolderPath);

            SetProgress(origin, TrackPhase.Parsing, 0, plugins.Count);
            var parsedDone = 0;
            foreach (var plugin in plugins)
            {
                cancel.ThrowIfCancellationRequested();

                // A fresh deep parse, not the load order's own overlay, whose lifetime Track does not control.
                // Naming where the strings are: "pass nothing" is not neutral for a Localized plugin.
                PluginTrees.PluginTree tree;
                try
                {
                    tree = await PluginTrees.ReadAsync(plugin.Name, plugin.Path, loadOrder.GameRelease, strings, cancel);
                }
                catch (Exception ex)
                {
                    // A raw parse exception's Message carries no located identity; the diagnosis walks the tree for
                    // the innermost RecordException.
                    var diagnosis = PluginDiagnosis.FromParseException(ex);
                    logger.LogWarning(ex, "Refused to track {Plugin}: its own binary could not be deep-parsed", plugin.Name);
                    return TrackResult.Refused(
                        TrackRefusal.RoundTripFailed,
                        $"{plugin.Name} could not be parsed from its own binary: {diagnosis.Describe()}");
                }

                if (tree.MissingStringsFile is { } missingFile)
                {
                    return TrackResult.Refused(
                        TrackRefusal.MissingLocalizationStrings,
                        $"{plugin.Name} is a localized plugin but its strings file '{missingFile}' was not found " +
                        $"in {strings.Folder}. Restore the file, then track again.");
                }

                parsedDone++;
                SetProgress(origin, TrackPhase.Parsing, parsedDone, plugins.Count);

                SetProgress(origin, TrackPhase.Serializing, parsedDone - 1, plugins.Count);
                var pluginPristineFiles = tree.Files;

                // ADR-0042 decision 2: the gate refuses before a single byte of any plugin in this Track is
                // committed, leaving the folder exactly as untracked as it was. Same Serializing phase — no new
                // TrackPhase.
                if (await VerifyRoundTrip(
                        plugin.Name, plugin.Path, pluginPristineFiles, loadOrder.GameRelease, strings,
                        deserializeForVerification, logger, cancel) is { } refusal)
                    return TrackResult.Refused(TrackRefusal.RoundTripFailed, refusal);

                pristineFiles.AddRange(pluginPristineFiles);

                binaryHashesByPlugin[plugin.Name] = ComputeSha256(plugin.Path);
                SetProgress(origin, TrackPhase.Serializing, parsedDone, plugins.Count);
            }

            SetProgress(origin, TrackPhase.Committing, plugins.Count, plugins.Count);
            var trailers = new TrackProvenance(MetaIni.ReadVersion(modFolder), MetaIni.ComputeSha256(modFolder), binaryHashesByPlugin);

            if (logger.IsEnabled(LogLevel.Information))
            {
                logger.LogInformation("Tracking {Origin}: {FileCount} source files across {PluginCount} plugin(s)", origin, pristineFiles.Count, plugins.Count);
            }
            SourceRepository.Track(modFolder, preset, pristineFiles, trailers);

            // After the tree is written and committed, never before: a watch over a half-written tree
            // validates a plugin whose documents are still arriving, and re-derives it from them.
            RepositoryCreated?.Invoke(modFolder, origin);
            return TrackResult.Success();
        }
        catch (GitUnavailableException ex)
        {
            return TrackResult.Refused(TrackRefusal.GitUnavailable, ex.Message);
        }
        catch (SourceAlreadyTrackedException ex)
        {
            // The folder was tracked between this gesture's own check and the commit: nothing here
            // owns the mod folder exclusively.
            return TrackResult.Refused(TrackRefusal.AlreadyTracked, ex.Message);
        }
        finally
        {
            // Idle at rest, success or failure alike — a poller must never keep reporting a track that has
            // finished.
            SetProgress(null, TrackPhase.Idle, 0, 0);
        }
    }

    // ADR-0042 decision 2's gate: the tree is read back, recompiled and reparsed; refuses unless every
    // record is model-identical. Reparse, not the pre-write object: only written bytes show what the
    // writer does.
    private static async Task<string?> VerifyRoundTrip(
        string pluginName,
        string originalPluginPath,
        IReadOnlyList<PristineFile> pristineFilesForThisPlugin,
        GameRelease gameRelease,
        PluginStrings strings,
        TreeDeserializer? deserialize,
        ILogger logger,
        CancellationToken cancel)
    {
        var scratchDir = Directory.CreateTempSubdirectory("medit-trackverify-").FullName;
        try
        {
            await PristineFileWriter.WriteAllAsync(pristineFilesForThisPlugin, scratchDir, cancel);

            var treeRoot = Path.Combine(scratchDir, SourceRepository.RootFor(pluginName));
            var recompiledPath = Path.Combine(scratchDir, pluginName);
            try
            {
                await PluginTrees.WriteFromTreeAsync(treeRoot, recompiledPath, deserialize, cancel);
            }
            catch (Exception ex) when (PluginDiagnosis.HasUnmappableFormID(ex))
            {
                // ADR-0038's content-derived master pass prunes a master this write still needs when the only
                // reference lives in a VMAD struct-list property Mutagen never walks (upstream issue 688). Never
                // widen this catch.
                var diagnosis = PluginDiagnosis.FromWriteException(ex);
                logger.LogWarning(ex, "Refused to track {Plugin}: its round-trip write dropped a needed master", pluginName);
                return $"{pluginName} does not round-trip through its own tracked source: {diagnosis.Describe()}";
            }

            var originalBytes = await File.ReadAllBytesAsync(originalPluginPath, cancel);
            var recompiledBytes = await File.ReadAllBytesAsync(recompiledPath, cancel);
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

            if (PluginTrees.DivergenceBetween(pluginName, originalPluginPath, recompiledPath, gameRelease, strings)
                is { } divergence)
            {
                return $"{pluginName} does not round-trip through its own tracked source: {divergence.Describe()}";
            }

            // Model-identical but not byte-identical: an encoding-only difference ADR-0042 decision 2
            // documents rather than gates. Reported, never a refusal.
            if (logger.IsEnabled(LogLevel.Information))
            {
                logger.LogInformation(
                    "{Plugin} is model-identical to its own tracked source but not byte-identical — " +
                    "Save & Compile will not reproduce this plugin's exact bytes (ADR-0042 decision 2).",
                    pluginName);
            }
        }
        finally
        {
            Directory.Delete(scratchDir, recursive: true);
        }

        return null;
    }


    private void SetProgress(string? origin, TrackPhase phase, int pluginsDone, int pluginsTotal)
    {
        var progress = new TrackProgress(origin, phase, pluginsDone, pluginsTotal);
        Volatile.Write(ref _progress, progress);
        _notifications?.Publish(new TrackProgressNotification(progress));
    }

    private static string ComputeSha256(string filePath) =>
        Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(filePath)));
}
