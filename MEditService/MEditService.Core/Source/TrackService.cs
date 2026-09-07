using System.Security.Cryptography;
using MEditService.Core.Notifications;
using MEditService.Core.Plugins;
using MEditService.Core.Serialization;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Binary.Parameters;
using Mutagen.Bethesda.Plugins.Records;
using Noggog.WorkEngine;

namespace MEditService.Core.Source;

/// <summary>The Track gesture end to end: deep-parses each plugin under one origin (the load order's
/// overlay is not always structurally faithful), serializes through the whole-mod door, and
/// commits. A designated door (ADR-0041).</summary>
public sealed class TrackService(ILogger<TrackService> logger, INotificationPublisher? notifications = null)
{
    // Read concurrently by GET /plugins/track/status while a POST is in flight. Snapshots are replaced
    // wholesale, never mutated, so Volatile.Read/Write suffices and no lock is needed.
    private TrackProgress _progress = TrackProgress.Idle;
    public TrackProgress Progress => Volatile.Read(ref _progress);
    // ADR-0046: null in every test that does not care, matching DuckDbRecordIndex's own posture.
    private readonly INotificationPublisher? _notifications = notifications;

    /// <summary>ADR-0046: raised with the mod folder and origin of a repository that now exists, so
    /// the Source watcher starts on a tracked mod with no restart.</summary>
    public Action<string, string>? RepositoryCreated { get; set; }

    public Task TrackAsync(LoadOrder loadOrder, string origin, SourcePreset preset, CancellationToken cancel = default) =>
        TrackAsync(loadOrder, origin, preset, deserializeForVerification: null, cancel);

    /// <summary>The same gesture for a caller still holding the mirror's view.</summary>
    public Task TrackAsync(ILoadOrder loadOrder, string origin, SourcePreset preset, CancellationToken cancel = default) =>
        TrackAsync(LoadOrder.From(loadOrder), origin, preset, deserializeForVerification: null, cancel);

    /// <summary>Same gesture with one extra seam: how the round-trip gate reads the tree back. Null gets
    /// the real whole-mod door. Only a negative test overrides it: no known codec defect can trigger
    /// the gate for real.</summary>
    internal Task TrackAsync(
        ILoadOrder loadOrder,
        string origin,
        SourcePreset preset,
        Func<string, CancellationToken, Task<IFallout4Mod>>? deserializeForVerification,
        CancellationToken cancel = default) =>
        TrackAsync(LoadOrder.From(loadOrder), origin, preset, deserializeForVerification, cancel);

    internal async Task TrackAsync(
        LoadOrder loadOrder,
        string origin,
        SourcePreset preset,
        Func<string, CancellationToken, Task<IFallout4Mod>>? deserializeForVerification,
        CancellationToken cancel = default)
    {
        var deserialize = deserializeForVerification
            ?? ((folder, ct) => RecordTextCodecGeneratorSeed.DeserializeWholeMod(folder, InlineWorkDropoff.Instance, ct));

        var plugins = loadOrder.Copies.Where(p => p.Origin.Equals(origin, StringComparison.OrdinalIgnoreCase)).ToList();
        if (plugins.Count == 0)
            throw new KeyNotFoundException($"No loaded plugin has origin '{origin}' to track.");

        var modFolder = Path.GetDirectoryName(plugins[0].Path)
            ?? throw new InvalidOperationException($"Plugin path '{plugins[0].Path}' has no containing folder.");

        // Both checks are cheap and both make the whole parse loop pointless if they fail, so they run first.
        if (SourceRepository.IsTracked(modFolder))
            throw new SourceAlreadyTrackedException($"'{modFolder}' is already tracked.");
        GitCli.EnsureOnPath();

        try
        {
            var pristineFiles = new List<PristineFile>();
            var binaryHashesByPlugin = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

            SetProgress(origin, TrackPhase.Parsing, 0, plugins.Count);
            var parsedDone = 0;
            foreach (var plugin in plugins)
            {
                cancel.ThrowIfCancellationRequested();

                // A fresh deep parse, not the load order's own overlay, whose lifetime Track does not control.
                // Explicit strings parameters: "pass nothing" is not neutral for a Localized plugin (LocalizedStrings).
                IMod deepParsed;
                try
                {
                    deepParsed = ModFactory.ImportSetter(
                        new ModPath(ModKey.FromFileName(plugin.Name), plugin.Path), loadOrder.GameRelease,
                        LocalizedStrings.ForRead(modFolder, loadOrder.DataFolderPath));
                }
                catch (Exception ex)
                {
                    // A raw parse exception's Message carries no located identity; the diagnosis walks the tree for
                    // the innermost RecordException.
                    var diagnosis = PluginDiagnosis.FromParseException(ex);
                    throw new SourceRoundTripFailedException(
                        $"{plugin.Name} could not be parsed from its own binary: {diagnosis.Describe()}", ex);
                }

                // Refuse by name: TranslatedString.TryLookup returns false for a missing file with no exception.
                if (LocalizedStrings.FindMissingStringsFile(deepParsed, plugin.Name, modFolder, loadOrder.DataFolderPath, loadOrder.GameRelease) is { } missingFile)
                {
                    throw new MissingLocalizationStringsException(
                        $"{plugin.Name} is a localized plugin but its strings file '{missingFile}' was not found " +
                        $"in {LocalizedStrings.FolderFor(modFolder, loadOrder.DataFolderPath)}. Restore the file, then track again.");
                }

                parsedDone++;
                SetProgress(origin, TrackPhase.Parsing, parsedDone, plugins.Count);

                SetProgress(origin, TrackPhase.Serializing, parsedDone - 1, plugins.Count);
                var pluginPristineFiles = await SerializeToPristineFiles(deepParsed, plugin.Name, cancel);

                // ADR-0042 decision 2: the gate refuses before a single byte of any plugin in this Track is
                // committed, leaving the folder exactly as untracked as it was. Same Serializing phase — no new
                // TrackPhase.
                await VerifyRoundTrip(deepParsed, plugin.Name, plugin.Path, pluginPristineFiles, deserialize, logger, cancel);

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
    private static async Task VerifyRoundTrip(
        IMod original,
        string pluginName,
        string originalPluginPath,
        IReadOnlyList<PristineFile> pristineFilesForThisPlugin,
        Func<string, CancellationToken, Task<IFallout4Mod>> deserialize,
        ILogger logger,
        CancellationToken cancel)
    {
        var scratchDir = Directory.CreateTempSubdirectory("medit-trackverify-").FullName;
        try
        {
            await PristineFileWriter.WriteAllAsync(pristineFilesForThisPlugin, scratchDir, cancel);

            var treeRoot = Path.Combine(scratchDir, SourceRecordPath.RootFor(pluginName));
            var recompiled = await deserialize(treeRoot, cancel);

            var recompiledPath = Path.Combine(scratchDir, pluginName);
            // Raw Mutagen write, not PluginWriter: a scratch verification must not drop a .bak beside the real
            // plugin. WithLoadOrderFromHeaderMasters fixes master order; NoNextFormIDProcessing and NoCheck
            // keep the header's stored values rather than Mutagen's recompute.
            try
            {
                await recompiled.BeginWrite
                    .ToPath(recompiledPath)
                    .WithLoadOrderFromHeaderMasters()
                    .WithNoDataFolder()
                    .NoNextFormIDProcessing()
                    .WithRecordCount(RecordCountOption.NoCheck)
                    .WriteAsync();
            }
            catch (Exception ex) when (PluginDiagnosis.HasUnmappableFormID(ex))
            {
                // ADR-0038's content-derived master pass prunes a master this write still needs when the only
                // reference lives in a VMAD struct-list property Mutagen never walks (upstream issue 688). Never
                // widen this catch.
                var diagnosis = PluginDiagnosis.FromWriteException(ex);
                throw new SourceRoundTripFailedException(
                    $"{pluginName} does not round-trip through its own tracked source: {diagnosis.Describe()}", ex);
            }

            var originalBytes = await File.ReadAllBytesAsync(originalPluginPath, cancel);
            var recompiledBytes = await File.ReadAllBytesAsync(recompiledPath, cancel);
            if (originalBytes.AsSpan().SequenceEqual(recompiledBytes))
                return;

            if (PluginBinaryWalk.FindFirstSubrecordLoss(originalBytes, recompiledBytes) is { } loss)
            {
                // A Kind B diagnosis on the record names the cause ahead of the drop it produced.
                var kindB = MalformedPluginScan.Scan(originalBytes).FirstOrDefault(d =>
                    d.Anchor?.StartsWith($"{loss.RecordType} {loss.FormId:X8}", StringComparison.Ordinal) == true);
                throw new SourceRoundTripFailedException(
                    $"{pluginName} does not round-trip through its own tracked source: " + (kindB != null
                        ? $"{kindB.Describe()} — parsing the malformed subrecord dropped " +
                          $"{string.Join(", ", loss.Signatures)} before Track ever wrote its source."
                        : $"{loss.RecordType} {loss.FormId:X8} is missing {string.Join(", ", loss.Signatures)} " +
                          "present in the original — dropped during parsing, before Track ever wrote its source."));
            }

            var recompiledFromBinary = Fallout4Mod.CreateFromBinary(
                new ModPath(ModKey.FromFileName(pluginName), recompiledPath), Fallout4Release.Fallout4);

            if (ModelIdentity.FindFirst(original, recompiledFromBinary) is { } divergence)
            {
                throw new SourceRoundTripFailedException(
                    $"{pluginName} does not round-trip through its own tracked source: " +
                    $"{divergence.RecordType} {divergence.FormKey} (EditorID '{divergence.EditorId}') " +
                    divergence.Description);
            }

            // FindFirst never reaches ModHeader (not an IMajorRecordGetter); this is the header's own check,
            // scoped to OpaqueHeaderFields' allow-list — a blanket sweep would refuse legitimate divergence.
            if (ModelIdentity.FindFirstHeaderFieldDivergence(((IFallout4ModGetter)original).ModHeader, recompiledFromBinary.ModHeader) is { } headerField)
            {
                throw new SourceRoundTripFailedException(
                    $"{pluginName} does not round-trip through its own tracked source: " +
                    $"TES4 header field '{headerField}' changed after being recompiled from its own tracked source.");
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
    }


    /// <summary>One plugin's complete source tree, ready to commit — the one implementation of the door's
    /// write. A second serializer that dropped the root RecordData.json would delete the header from
    /// the baseline: CommitPristineToMain never merges.</summary>
    internal static async Task<IReadOnlyList<PristineFile>> SerializeToPristineFiles(
        IModGetter mod, string pluginName, CancellationToken cancel = default)
    {
        var scratchDir = Directory.CreateTempSubdirectory("medit-serialize-").FullName;
        try
        {
            // Always the inline dropoff, explicitly: MajorRecordListParallelHelper has a real upstream race
            // under a genuinely parallel dropoff (nested-list containers writing into each other's folders).
            await RecordTextCodecGeneratorSeed.SerializeWholeMod(
                // FO4-typed: the generated whole-mod mixin is itself seeded from an FO4 mod type — the existing
                // generalization boundary.
                (IFallout4ModGetter)mod,
                scratchDir,
                InlineWorkDropoff.Instance,
                cancel);

            // Newtonsoft's JsonTextWriter has no reachable NewLine to pin, so line endings are canonicalized
            // after the write, as the per-record codec does.
            var pristineFiles = new List<PristineFile>();
            foreach (var file in Directory.EnumerateFiles(scratchDir, "*", SearchOption.AllDirectories))
            {
                cancel.ThrowIfCancellationRequested();
                var relativePath = Path.Combine(
                    SourceRecordPath.RootFor(pluginName), Path.GetRelativePath(scratchDir, file));
                pristineFiles.Add(new PristineFile(relativePath, StripCarriageReturns(await File.ReadAllBytesAsync(file, cancel))));
            }
            return pristineFiles;
        }
        finally
        {
            Directory.Delete(scratchDir, recursive: true);
        }
    }

    private void SetProgress(string? origin, TrackPhase phase, int pluginsDone, int pluginsTotal)
    {
        var progress = new TrackProgress(origin, phase, pluginsDone, pluginsTotal);
        Volatile.Write(ref _progress, progress);
        _notifications?.Publish(new TrackProgressNotification(progress));
    }

    private static byte[] StripCarriageReturns(byte[] bytes) => [.. bytes.Where(b => b != (byte)'\r')];

    private static string ComputeSha256(string filePath) =>
        Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(filePath)));
}

/// <summary>Thrown when a plugin fails ADR-0042 decision 2's round-trip gate, naming the first record
/// that does not survive recompilation. Named so the endpoint layer maps it to its own HTTP
/// response.</summary>
public sealed class SourceRoundTripFailedException : Exception
{
    public SourceRoundTripFailedException()
    {
    }

    public SourceRoundTripFailedException(string message) : base(message)
    {
    }

    public SourceRoundTripFailedException(string message, Exception innerException) : base(message, innerException)
    {
    }
}

/// <summary>Thrown when a Localized plugin is missing one of its strings files. Named so the endpoint
/// layer maps it to its own HTTP response.</summary>
public sealed class MissingLocalizationStringsException : Exception
{
    public MissingLocalizationStringsException()
    {
    }

    public MissingLocalizationStringsException(string message) : base(message)
    {
    }

    public MissingLocalizationStringsException(string message, Exception innerException) : base(message, innerException)
    {
    }
}
