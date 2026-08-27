using System.Security.Cryptography;
using MEditService.Core.Serialization;
using MEditService.Core.Session;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Binary.Parameters;
using Mutagen.Bethesda.Plugins.Records;
using Noggog.WorkEngine;

namespace MEditService.Core.Source;

/// <summary>
/// #414's orchestration seam: the Track gesture end to end. Resolves every plugin the session
/// loaded under one mod-folder origin, deep-parses each (the session's own overlay reader is
/// read-only and, per #369's pinned defect, not always structurally faithful), then serializes the
/// whole mod through the whole-mod door (#451 slice A — ADR-0041's #444 amendment: "the source tree
/// adopts Spriggit's layout wholesale"), computes provenance, then hands the git mechanics to
/// <see cref="SourceRepository.Track"/>. This class invents no record content and no provenance
/// content on its own account either — the binary hash and <c>meta.ini</c> version string are both
/// read as opaque bytes, never interpreted.
///
/// <para><b>This is a designated door</b> for the generated whole-mod mixin
/// (<see cref="Serialization.RecordTextCodecGeneratorSeed"/>'s AC2 guard, re-scoped by #451 from "no
/// caller, ever" to "only the designated doors" — <see cref="Serialization.RecordTextCodecGeneratorSeedTests"/>
/// enforces the whitelist).</para>
/// </summary>
public sealed class TrackService(ILogger<TrackService> logger)
{
    // #414 review F2: "reports progress" (AC4) — one shared instance on this singleton, read
    // concurrently by GET /plugins/track/status while a track's own POST is still in flight, same
    // idiom SessionManager.Status/GET /session/status already established for the session load. A
    // reference-type field, so Volatile.Read/Write is enough for cross-thread visibility of each
    // whole snapshot (GameSession's own _pluginsSnapshot uses the same pattern) — no lock needed
    // since nothing here ever mutates a snapshot in place, only replaces it wholesale.
    private TrackProgress _progress = TrackProgress.Idle;
    public TrackProgress Progress => Volatile.Read(ref _progress);

    public Task TrackAsync(IGameSession session, string origin, SourcePreset preset, CancellationToken cancel = default) =>
        TrackAsync(session, origin, preset, deserializeForVerification: null, cancel);

    /// <summary>
    /// Same gesture as the public overload, with one extra seam: which function reads the tree
    /// <see cref="VerifyRoundTrip"/> just wrote for a plugin back into a mod, for the round-trip
    /// gate below (#471, ADR-0042 decision 2). Every real caller goes through the public overload,
    /// which passes <see langword="null"/> here and gets the real whole-mod door
    /// (<see cref="Serialization.RecordTextCodecGeneratorSeed.DeserializeWholeMod"/>). The only
    /// override is the negative test proving the gate actually refuses a plugin: no known codec
    /// defect is reproducible at this project's current Mutagen/Serialization pins to trigger that
    /// path for real (<see cref="Serialization.RecordTextCodecCustomization"/>'s own doc comment —
    /// decision 3 has no exception left; <c>BinaryRoundTripGateTests</c>' one known defect is
    /// confined to the lazy overlay reader Track never uses), so that test forges one by
    /// deserializing for real and then mutating a record, rather than mocking deserialization away
    /// entirely.
    /// </summary>
    internal async Task TrackAsync(
        IGameSession session,
        string origin,
        SourcePreset preset,
        Func<string, CancellationToken, Task<IFallout4Mod>>? deserializeForVerification,
        CancellationToken cancel = default)
    {
        var deserialize = deserializeForVerification
            ?? ((folder, ct) => RecordTextCodecGeneratorSeed.DeserializeWholeMod(folder, InlineWorkDropoff.Instance, ct));

        var plugins = session.Plugins.Where(p => p.Origin.Equals(origin, StringComparison.OrdinalIgnoreCase)).ToList();
        if (plugins.Count == 0)
            throw new KeyNotFoundException($"No loaded plugin has origin '{origin}' to track.");

        var modFolder = Path.GetDirectoryName(plugins[0].Path)
            ?? throw new InvalidOperationException($"Plugin path '{plugins[0].Path}' has no containing folder.");

        // Fail fast (#414 review F3): both checks are cheap and both make the entire deep-parse/
        // serialize loop below pointless if they fail, so they run before it, not after — an
        // already-tracked folder or a missing git must never pay the full (worst-case tens-of-
        // seconds, mega-plugin) parse cost just to learn an answer that was available up front.
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

                // A fresh deep parse, deliberately — not the session's own already-open overlay,
                // which belongs to the session and whose lifetime Track does not control.
                // Reader-agnosticism between the two — that a deep-parsed record and an overlay
                // serialize to the same bytes — is what RecordTextCodecRealDataTests protects at the
                // codec seam.
                var deepParsed = ModFactory.ImportSetter(new ModPath(ModKey.FromFileName(plugin.Name), plugin.Path), session.GameRelease);
                parsedDone++;
                SetProgress(origin, TrackPhase.Parsing, parsedDone, plugins.Count);

                SetProgress(origin, TrackPhase.Serializing, parsedDone - 1, plugins.Count);
                var pluginPristineFiles = await SerializeToPristineFiles(deepParsed, plugin.Name, cancel);

                // #471, ADR-0042 decision 2: the gate. Refuses before a single byte of this plugin —
                // or any other plugin sharing this Track call — is committed, so a failure here
                // leaves the mod folder exactly as untracked as it was on entry
                // (SourceRepository.Track below never runs). Reported under the same Serializing
                // phase as the plugin whose tree it is verifying: no new TrackPhase, so no wire/API
                // change and nothing for trackProgress.ts's own exhaustive switch to learn about.
                await VerifyRoundTrip(deepParsed, plugin.Name, plugin.Path, pluginPristineFiles, deserialize, cancel);

                pristineFiles.AddRange(pluginPristineFiles);

                binaryHashesByPlugin[plugin.Name] = ComputeSha256(plugin.Path);
                SetProgress(origin, TrackPhase.Serializing, parsedDone, plugins.Count);
            }

            SetProgress(origin, TrackPhase.Committing, plugins.Count, plugins.Count);
            var trailers = new TrackProvenance(MetaIni.ReadVersion(modFolder), MetaIni.ComputeSha256(modFolder), binaryHashesByPlugin);

            logger.LogInformation("Tracking {Origin}: {FileCount} source files across {PluginCount} plugin(s)", origin, pristineFiles.Count, plugins.Count);
            SourceRepository.Track(modFolder, preset, pristineFiles, trailers);
        }
        finally
        {
            // Idle at rest, success or failure alike — a poller reading after this call returns
            // (or throws) must never keep reporting a track that is no longer actually running.
            SetProgress(null, TrackPhase.Idle, 0, 0);
        }
    }

    /// <summary>
    /// ADR-0042 decision 2's gate, run live against the plugin actually being tracked: writes
    /// <paramref name="pristineFilesForThisPlugin"/> (the tree <see cref="SerializeToPristineFiles"/>
    /// just produced from <paramref name="original"/>) into a scratch tree, reads it back through
    /// <paramref name="deserialize"/>, recompiles that to a scratch binary, and refuses unless it is
    /// byte-identical to <paramref name="originalPluginPath"/>'s own bytes. Byte identity is the
    /// gate; <see cref="DescribeFirstDivergence"/>'s per-record model equality is only reached to
    /// name the offending record once the gate has already failed, so a passing Track pays one
    /// extra deserialize and one extra binary write per plugin, never a record-by-record diff.
    /// </summary>
    private static async Task VerifyRoundTrip(
        IMod original,
        string pluginName,
        string originalPluginPath,
        IReadOnlyList<PristineFile> pristineFilesForThisPlugin,
        Func<string, CancellationToken, Task<IFallout4Mod>> deserialize,
        CancellationToken cancel)
    {
        var scratchDir = Directory.CreateTempSubdirectory("medit-trackverify-").FullName;
        try
        {
            await PristineFileWriter.WriteAllAsync(pristineFilesForThisPlugin, scratchDir, cancel);

            var treeRoot = Path.Combine(scratchDir, SourceRecordPath.RootFor(pluginName));
            var recompiled = await deserialize(treeRoot, cancel);

            var recompiledPath = Path.Combine(scratchDir, pluginName);
            // Raw Mutagen write, deliberately not PluginWriter: this is a scratch verification
            // write, never the plugin the user is tracking, so it must not drop a .bak beside the
            // real plugin as a side effect of merely checking it. WithLoadOrderFromHeaderMasters
            // mirrors BinaryRoundTripGateTests' own precedent for exactly this "reproduce the
            // original's own bytes" shape (as opposed to PluginCompileService's session-derived
            // load order, which answers a different question: what should the masters be now).
            // NoNextFormIDProcessing/RecordCountOption.NoCheck mirror PluginWriter (#506): the
            // source's own stored HEDR.NextObjectID/NumRecords are the bytes to reproduce, not
            // Mutagen's recompute of them.
            await recompiled.BeginWrite
                .ToPath(recompiledPath)
                .WithLoadOrderFromHeaderMasters()
                .WithNoDataFolder()
                .NoNextFormIDProcessing()
                .WithRecordCount(RecordCountOption.NoCheck)
                .WriteAsync();

            var originalBytes = await File.ReadAllBytesAsync(originalPluginPath, cancel);
            var recompiledBytes = await File.ReadAllBytesAsync(recompiledPath, cancel);
            if (originalBytes.AsSpan().SequenceEqual(recompiledBytes))
                return;

            throw new SourceRoundTripFailedException(DescribeFirstDivergence(original, recompiled, pluginName));
        }
        finally
        {
            Directory.Delete(scratchDir, recursive: true);
        }
    }

    /// <summary>
    /// The diagnostic half of the gate (ADR-0042 decision 2): names the first record — in the
    /// original plugin's own GRUP order — that does not survive a round trip through its own
    /// tracked source, using Mutagen's own generated deep equality (every generated major record
    /// overrides <c>object.Equals</c> to a field-by-field comparison — reached here through the
    /// common <see cref="IMajorRecordGetter"/> interface type, no per-game downcast needed).
    /// </summary>
    private static string DescribeFirstDivergence(IMod original, IFallout4Mod recompiled, string pluginName)
    {
        var recompiledByFormKey = recompiled.EnumerateMajorRecords().ToDictionary(r => r.FormKey);
        var originalFormKeys = new HashSet<FormKey>();
        foreach (var originalRecord in original.EnumerateMajorRecords())
        {
            originalFormKeys.Add(originalRecord.FormKey);
            if (!recompiledByFormKey.TryGetValue(originalRecord.FormKey, out var recompiledRecord))
            {
                return $"{pluginName} does not round-trip through its own tracked source: " +
                    $"{originalRecord.GetType().Name} {originalRecord.FormKey} (EditorID '{originalRecord.EditorID}') " +
                    "is missing from the recompiled plugin.";
            }

            if (!originalRecord.Equals(recompiledRecord))
            {
                return $"{pluginName} does not round-trip through its own tracked source: " +
                    $"{originalRecord.GetType().Name} {originalRecord.FormKey} (EditorID '{originalRecord.EditorID}') " +
                    "differs after being recompiled from its own tracked source.";
            }
        }

        // #506: the other direction — a record the recompile produced that the original never had.
        foreach (var recompiledRecord in recompiled.EnumerateMajorRecords())
        {
            if (!originalFormKeys.Contains(recompiledRecord.FormKey))
            {
                return $"{pluginName} does not round-trip through its own tracked source: " +
                    $"{recompiledRecord.GetType().Name} {recompiledRecord.FormKey} (EditorID '{recompiledRecord.EditorID}') " +
                    "is present in the recompiled plugin but not present in the original.";
            }
        }

        return $"{pluginName} does not round-trip through its own tracked source, but every individual " +
            "record matched — the divergence is in the plugin header or a container's own structure, not a record's content.";
    }

    /// <summary>
    /// One plugin's complete source tree as a list of <see cref="PristineFile"/>s, ready to commit —
    /// the whole-mod door's own write operation, start to finish: serialize, canonicalize line
    /// endings.
    ///
    /// <para><b>Why this lives in the door file, and why that is not a whitelist dodge.</b> It is the
    /// door's own operation, factored out so there is exactly one implementation of it — not a routing
    /// convenience that lets another class reach the mixin. The guard
    /// (<c>RecordTextCodecGeneratorSeedTests</c>) exists to keep whole-mod serialization in few enough
    /// places that the sequential dropoff and the <c>\r</c> canonicalization happen the same way
    /// everywhere; a second hand-rolled implementation elsewhere would satisfy the guard's letter
    /// while defeating its purpose. That is not hypothetical — it is exactly what happened.
    /// <see cref="ExternalChangeAbsorber"/> rebuilt the tree one record at a time and omitted the
    /// root <c>RecordData.json</c> that ADR-0041's #444 amendment makes the mod header's source file.
    /// Since <see cref="SourceRepository.CommitPristineToMain"/> writes only what it is handed, with no
    /// merge against the previous tree, that <i>deleted</i> the header from the baseline, and the
    /// resulting tree could not be read back at all — the whole-mod door takes ModKey and GameRelease
    /// from that file. Found by #454, which is the first thing to read a whole tree back; latent for
    /// ingest-from-source (#452) on the same call for just as long.</para>
    ///
    /// <para>The caller supplies the already-parsed mod rather than a path: both callers parse for
    /// their own reasons (Track reports progress around it; Absorb parses the binary that changed
    /// underneath it), and the parse was never the part that differed.</para>
    /// </summary>
    internal static async Task<IReadOnlyList<PristineFile>> SerializeToPristineFiles(
        IModGetter mod, string pluginName, CancellationToken cancel = default)
    {
        var scratchDir = Directory.CreateTempSubdirectory("medit-serialize-").FullName;
        try
        {
            // The whole-mod door — this class is one of the designated callers (AC2 re-scope, #451).
            // Always a sequential/inline dropoff, explicitly, even though it is already the library's
            // own default (SerializationMetaData falls back to InlineWorkDropoff when handed null):
            // the #444 spike's own finding 4 is a real upstream race in MajorRecordListParallelHelper
            // under a genuinely parallel dropoff (nested-list containers writing into each other's
            // folders), so this is named rather than relied on implicitly —
            // RecordTextCodecGeneratorSeedTests' companion guard fails loudly if this ever gets
            // quietly swapped for a genuinely parallel one.
            await RecordTextCodecGeneratorSeed.SerializeWholeMod(
                // FO4-typed, matching RecordTextCodecGeneratorSeed's own seed type — the generated
                // whole-mod mixin is itself FO4-specific (seeded from an FO4 mod type), so this is
                // the existing generalization boundary, not a new one.
                (IFallout4ModGetter)mod,
                scratchDir,
                InlineWorkDropoff.Instance,
                cancel);

            // #451 AC4: canonicalization at the door. The whole-mod door's writer goes through the
            // same JSON kernel the per-record codec does, whose own doc comment already established
            // (RecordTextCodec.SerializeCoreAsync) that Newtonsoft's JsonTextWriter has no reachable
            // NewLine to pin — the per-record codec answers this with its own post-write \r-strip,
            // and this mirrors that precedent for the whole-mod door rather than assuming Linux's
            // own \n-native Environment.NewLine generalizes to every platform this ships on.
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

    private void SetProgress(string? origin, TrackPhase phase, int pluginsDone, int pluginsTotal) =>
        Volatile.Write(ref _progress, new TrackProgress(origin, phase, pluginsDone, pluginsTotal));

    private static byte[] StripCarriageReturns(byte[] bytes) => [.. bytes.Where(b => b != (byte)'\r')];

    private static string ComputeSha256(string filePath) =>
        Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(filePath)));
}

/// <summary>Thrown by <see cref="TrackService.TrackAsync(IGameSession, string, SourcePreset, CancellationToken)"/>
/// when a plugin fails ADR-0042 decision 2's round-trip gate — its own message names the first
/// record (or, failing that, the header/container structure) that does not survive being recompiled
/// from its own freshly-tracked source. Named and actionable, the same way
/// <see cref="SourceAlreadyTrackedException"/> is, so the endpoint layer maps it to a real HTTP
/// response distinct from every other failure <c>TrackAsync</c> can raise, rather than a bare
/// <see cref="InvalidOperationException"/> a caller would have to string-match to tell apart.</summary>
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
