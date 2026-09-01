using System.Security.Cryptography;
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

/// <summary>
/// The Track gesture's orchestration seam, end to end. Resolves every plugin the load order
/// loaded under one mod-folder origin, deep-parses each (the load order's own overlay reader is
/// read-only and not always structurally faithful), then serializes the
/// whole mod through the whole-mod door (ADR-0041 amendment: the source tree
/// took over the whole-mod door's own file layout wholesale), computes provenance, then hands the
/// git mechanics to
/// <see cref="SourceRepository.Track"/>. This class invents no record content and no provenance
/// content on its own account either — the binary hash and <c>meta.ini</c> version string are both
/// read as opaque bytes, never interpreted.
///
/// <para><b>This is a designated door</b> for the generated whole-mod mixin —
/// only the designated doors may call it; <see cref="Serialization.RecordTextCodecGeneratorSeedTests"/>
/// enforces the whitelist.</para>
/// </summary>
public sealed class TrackService(ILogger<TrackService> logger)
{
    // One shared instance on this singleton, read
    // concurrently by GET /plugins/track/status while a track's own POST is still in flight, same
    // idiom LoadOrderMirror.Status/GET /load-order/status already established for the reconcile. A
    // reference-type field, so Volatile.Read/Write is enough for cross-thread visibility of each
    // whole snapshot (LoadOrder's own _pluginsSnapshot uses the same pattern) — no lock needed
    // since nothing here ever mutates a snapshot in place, only replaces it wholesale.
    private TrackProgress _progress = TrackProgress.Idle;
    public TrackProgress Progress => Volatile.Read(ref _progress);

    public Task TrackAsync(ILoadOrder loadOrder, string origin, SourcePreset preset, CancellationToken cancel = default) =>
        TrackAsync(loadOrder, origin, preset, deserializeForVerification: null, cancel);

    /// <summary>
    /// Same gesture as the public overload, with one extra seam: which function reads the tree
    /// <see cref="VerifyRoundTrip"/> just wrote for a plugin back into a mod, for the round-trip
    /// gate below (ADR-0042 decision 2). Every real caller goes through the public overload,
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
        ILoadOrder loadOrder,
        string origin,
        SourcePreset preset,
        Func<string, CancellationToken, Task<IFallout4Mod>>? deserializeForVerification,
        CancellationToken cancel = default)
    {
        var deserialize = deserializeForVerification
            ?? ((folder, ct) => RecordTextCodecGeneratorSeed.DeserializeWholeMod(folder, InlineWorkDropoff.Instance, ct));

        var plugins = loadOrder.Plugins.Where(p => p.Origin.Equals(origin, StringComparison.OrdinalIgnoreCase)).ToList();
        if (plugins.Count == 0)
            throw new KeyNotFoundException($"No loaded plugin has origin '{origin}' to track.");

        var modFolder = Path.GetDirectoryName(plugins[0].Path)
            ?? throw new InvalidOperationException($"Plugin path '{plugins[0].Path}' has no containing folder.");

        // Fail fast: both checks are cheap and both make the entire deep-parse/
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

                // A fresh deep parse, deliberately — not the load order's own already-open overlay,
                // which belongs to the load order and whose lifetime Track does not control.
                // Reader-agnosticism between the two — that a deep-parsed record and an overlay
                // serialize to the same bytes — is what RecordTextCodecRealDataTests protects at the
                // codec seam.
                // Explicit strings parameters, not null — see LocalizedStrings' own doc
                // comment for why "pass nothing" is not neutral for a Localized plugin.
                IMod deepParsed;
                try
                {
                    deepParsed = ModFactory.ImportSetter(
                        new ModPath(ModKey.FromFileName(plugin.Name), plugin.Path), loadOrder.GameRelease,
                        LocalizedStrings.ForRead(modFolder, loadOrder.DataFolderPath));
                }
                catch (Exception ex)
                {
                    // A raw Mutagen parse exception carries no located identity in its own Message
                    // (never FormKey/EditorID; RecordException carries those only
                    // on its ToString(), confirmed live). PluginDiagnosis.FromParseException walks
                    // the exception's own InnerException chain for the innermost RecordException, so
                    // a real record identity survives even when Mutagen wrapped it in one or more
                    // AggregateExceptions from its own parallel record-block parsing.
                    var diagnosis = PluginDiagnosis.FromParseException(ex);
                    throw new SourceRoundTripFailedException(
                        $"{plugin.Name} could not be parsed from its own binary: {diagnosis.Describe()}", ex);
                }

                // Refuse by name before anything else — never Mutagen's own listings-path
                // exception (which the strings parameters above already prevent) and never a silent
                // empty string (TranslatedString.TryLookup returns false for a missing file with no
                // exception at all).
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

                // ADR-0042 decision 2: the gate. Refuses before a single byte of this plugin —
                // or any other plugin sharing this Track call — is committed, so a failure here
                // leaves the mod folder exactly as untracked as it was on entry
                // (SourceRepository.Track below never runs). Reported under the same Serializing
                // phase as the plugin whose tree it is verifying: no new TrackPhase, so no wire/API
                // change and nothing for trackProgress.ts's own exhaustive switch to learn about.
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
        }
        finally
        {
            // Idle at rest, success or failure alike — a poller reading after this call returns
            // (or throws) must never keep reporting a track that is no longer actually running.
            SetProgress(null, TrackPhase.Idle, 0, 0);
        }
    }

    /// <summary>
    /// ADR-0042 decision 2's gate (2026-08 amendment), run live against the plugin actually
    /// being tracked: writes <paramref name="pristineFilesForThisPlugin"/> (the tree
    /// <see cref="SerializeToPristineFiles"/> just produced from <paramref name="original"/>) into a
    /// scratch tree, reads it back through <paramref name="deserialize"/>, recompiles that to a
    /// scratch binary, and refuses unless <b>every record's own content is model-identical</b> to the
    /// original — not unless the two binaries are byte-identical. Byte identity is still checked
    /// first, as a cheap accept short-circuit (byte-identical trivially implies model-identical, and
    /// skips the cost of a second parse for the common already-canonical case); a byte difference
    /// alone is never itself refused.
    ///
    /// <para><b>Reparse, not the pre-write object.</b> The model-identity comparison below runs
    /// against a fresh parse of <paramref name="recompiledPath"/>'s own written bytes
    /// (<c>recompiledFromBinary</c>), not the in-memory <c>recompiled</c> object handed to
    /// <c>BeginWrite</c>. <c>recompiled</c> is deserialized straight from the lossless tree
    /// (decision 3), so it is definitionally equal to <paramref name="original"/> on every field the
    /// tree carries — comparing against it could never see anything Mutagen's own binary *writer*
    /// does to a value (zlib re-deflate, <c>-0.0</c>→<c>+0.0</c>, or a writer defect like
    /// <c>Furniture.Flags</c> materializing from <see langword="null"/> once <c>FNAM</c>/<c>MNAM</c>
    /// are re-added — a real survey finding, content this amendment exists to still refuse).
    /// Only a reparse of what was actually written can.</para>
    ///
    /// <para><b>An independent diagnosis tried first.</b> <see cref="PluginBinaryWalk.FindFirstSubrecordLoss"/>
    /// runs straight over the same two byte buffers this method already has in hand — no extra parse,
    /// no extra write. It exists because Mutagen's own model can be lossy on the way *in*: a record
    /// whose original bytes and recompiled bytes both parse into equal objects can still differ on
    /// disk, when the parser silently dropped a subrecord neither model ever held (observed on a real
    /// plugin, <c>LitR - TrueStorms.esp</c> REGN <c>001D2AF4</c> — a malformed 6-byte <c>RDAT</c>
    /// where the format wants 8 desyncs Mutagen's own parse, which then silently drops every
    /// subrecord after it in that record; see <c>docs/specs/medit-repair.md</c>'s R2 for the
    /// byte-level diagnosis). Model equality (<see cref="ModelIdentity"/>) cannot name that record:
    /// both sides of its comparison come from the same lossy parse, so they agree. Only a byte-level
    /// count comparison can, which is what makes this check independent of, not a replacement for,
    /// the model-identity one below.</para>
    /// </summary>
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
            // Raw Mutagen write, deliberately not PluginWriter: this is a scratch verification
            // write, never the plugin the user is tracking, so it must not drop a .bak beside the
            // real plugin as a side effect of merely checking it. WithLoadOrderFromHeaderMasters
            // mirrors BinaryRoundTripGateTests' own precedent for exactly this "reproduce the
            // original's own bytes" shape (as opposed to PluginCompileService's load-order-derived
            // load order, which answers a different question: what should the masters be now).
            // NoNextFormIDProcessing/RecordCountOption.NoCheck mirror PluginWriter: the
            // source's own stored HEDR.NextObjectID/NumRecords are the bytes to reproduce, not
            // Mutagen's recompute of them.
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
                // ADR-0038's content-derived master pass (MastersListContentOption.Iterate,
                // the same default this write and PluginWriter both take) prunes a master this
                // write still needs when the only reference to it lives somewhere Mutagen's own
                // EnumerateFormLinks does not walk (a VMAD struct-list script property —
                // Mutagen-Modding/Mutagen upstream issue 688, real fixture SpaDia_AMR.esp).
                // Everything but this one Kind A shape still propagates raw below — never fall back
                // to a silent NoCheck, and never widen this catch to any other write failure.
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
                // #569: when the record carrying the loss also carries a Kind B diagnosis, the
                // refusal names the *cause* (defect class + repair tail + observed-vs-expected)
                // ahead of the drop it produced — the generic inventory wording remains the
                // fallback for a loss no detector explains.
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

            // ModelIdentity.FindFirst above never reaches ModHeader (not an IMajorRecordGetter,
            // never walked by EnumerateMajorRecords) — this is the header's own model-identity check,
            // scoped to ModelIdentity.OpaqueHeaderFields' allow-list rather than every Mask field (see
            // that allow-list's own doc comment for why a blanket sweep is wrong: MasterReferences and
            // Stats both have confirmed legitimate divergence paths that must not start
            // false-positive-refusing). The (IFallout4ModGetter) cast mirrors recompiledFromBinary's
            // own pre-existing FO4 narrowing three lines above, not a new one.
            if (ModelIdentity.FindFirstHeaderFieldDivergence(((IFallout4ModGetter)original).ModHeader, recompiledFromBinary.ModHeader) is { } headerField)
            {
                throw new SourceRoundTripFailedException(
                    $"{pluginName} does not round-trip through its own tracked source: " +
                    $"TES4 header field '{headerField}' changed after being recompiled from its own tracked source.");
            }

            // Bytes differ but every record's own content is model-identical — an encoding-only
            // difference ADR-0042 decision 2 documents rather than gates (zlib level, negative
            // zero, subrecord/GRUP-child order, derived sizes and counts, master pruning). Reported,
            // not silent, and never a refusal.
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
    /// while defeating its purpose. The hazard is concrete: a hand-rolled rebuild that omits the
    /// root <c>RecordData.json</c> (the mod header's source file, ADR-0041 amendment) <i>deletes</i>
    /// the header from the baseline — <see cref="SourceRepository.CommitPristineToMain"/> writes only
    /// what it is handed, with no merge against the previous tree — and the resulting tree cannot be
    /// read back at all: the whole-mod door takes ModKey and GameRelease from that file.</para>
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
            // The whole-mod door — this class is one of the designated callers.
            // Always a sequential/inline dropoff, explicitly, even though it is already the library's
            // own default (SerializationMetaData falls back to InlineWorkDropoff when handed null):
            // there is a real upstream race in MajorRecordListParallelHelper
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

            // Canonicalization at the door. The whole-mod door's writer goes through the
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

/// <summary>Thrown by <see cref="TrackService.TrackAsync(ILoadOrder, string, SourcePreset, CancellationToken)"/>
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

/// <summary>Thrown by <see cref="TrackService.TrackAsync(ILoadOrder, string, SourcePreset, CancellationToken)"/>
/// when a Localized plugin is missing one of its own <c>.STRINGS</c>/<c>.DLSTRINGS</c>/<c>.ILSTRINGS</c>
/// files — named so the endpoint layer maps it to its own HTTP response, the same way
/// <see cref="SourceRoundTripFailedException"/> is, rather than surfacing as a bare
/// <see cref="InvalidOperationException"/>.</summary>
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
