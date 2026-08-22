using System.Security.Cryptography;
using MEditService.Core.Serialization;
using MEditService.Core.Session;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
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

    public async Task TrackAsync(IGameSession session, string origin, SourcePreset preset, CancellationToken cancel = default)
    {
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
                pristineFiles.AddRange(
                    await SerializeToPristineFiles(deepParsed, plugin.Name, cancel));

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
                    $"{pluginName}{SourceRecordPath.SourceSuffix}", Path.GetRelativePath(scratchDir, file));
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
