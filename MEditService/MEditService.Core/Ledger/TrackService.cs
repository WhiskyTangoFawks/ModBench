using System.Security.Cryptography;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Core.Session;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Ledger;

/// <summary>
/// #414's orchestration seam: the Track gesture end to end. Resolves every plugin the session
/// loaded under one mod-folder origin, eagerly serializes every one of their records to the ledger
/// (deep-parsing each plugin file itself — the session's own overlay reader is read-only and, per
/// #369's pinned defect, not always structurally faithful; a fresh deep parse is the same source
/// <see cref="RecordTextCodecRealDataTests"/>'s codec fidelity already depends on), computes
/// provenance, then hands the git mechanics to <see cref="LedgerRepository.Track"/>. This class
/// invents no record content and no provenance content on its own account either — the binary hash
/// and <c>meta.ini</c> version string are both read as opaque bytes, never interpreted.
/// </summary>
public sealed class TrackService(ISchemaReflector reflector, ILogger<TrackService> logger)
{
    public async Task TrackAsync(IGameSession session, string origin, LedgerPreset preset, CancellationToken cancel = default)
    {
        var plugins = session.Plugins.Where(p => p.Origin.Equals(origin, StringComparison.OrdinalIgnoreCase)).ToList();
        if (plugins.Count == 0)
            throw new KeyNotFoundException($"No loaded plugin has origin '{origin}' to track.");

        var modFolder = Path.GetDirectoryName(plugins[0].Path)
            ?? throw new InvalidOperationException($"Plugin path '{plugins[0].Path}' has no containing folder.");

        var codec = new RecordTextCodec(NoOpLogger);
        var schemas = reflector.GetSchemas(session.GameRelease);
        var pristineFiles = new List<PristineFile>();
        var binaryHashesByPlugin = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        foreach (var plugin in plugins)
        {
            cancel.ThrowIfCancellationRequested();

            // A fresh deep parse, deliberately — not the session's own already-open overlay: the
            // overlay is read-only, so nothing here could strip a container's child-major fields on
            // it even if it were otherwise safe to reuse (ContainerStripFields.StripInPlace needs a
            // mutable IMajorRecord). Reader-agnosticism between the two is exactly what
            // RecordTextCodecRealDataTests exists to protect at the codec seam; Track pays a second
            // parse to get a graph it can mutate safely, never touching the session's own state.
            var deepParsed = ModFactory.ImportSetter(new ModPath(ModKey.FromFileName(plugin.Name), plugin.Path), session.GameRelease);
            foreach (var record in deepParsed.EnumerateMajorRecords())
            {
                cancel.ThrowIfCancellationRequested();
                ContainerStripFields.StripInPlace(record);

                var recordType = ResolveRecordType(record, schemas);
                var relativePath = LedgerRecordPath.For(plugin.Name, recordType, record.FormKey.ToString());
                pristineFiles.Add(await SerializeToPristineFileAsync(codec, record, relativePath, session.GameRelease, cancel));
            }

            binaryHashesByPlugin[plugin.Name] = ComputeSha256(plugin.Path);
        }

        var trailers = new TrackProvenance(ReadMetaIniVersion(modFolder), null, binaryHashesByPlugin);

        logger.LogInformation("Tracking {Origin}: {RecordCount} records across {PluginCount} plugin(s)", origin, pristineFiles.Count, plugins.Count);
        LedgerRepository.Track(modFolder, preset, pristineFiles, trailers);
    }

    // RecordTextCodec's own write path is a real, atomic file write (temp-file-then-rename) with no
    // in-memory byte[] exit — appropriate for its own callers, but Track needs bytes to hand to
    // LedgerRepository.Track's PristineFile list rather than writing into the (not yet git-tracked)
    // mod folder directly. A scratch temp file per record bridges the two without changing the
    // codec's own contract.
    private static async Task<PristineFile> SerializeToPristineFileAsync(
        RecordTextCodec codec, IMajorRecord record, string relativePath, GameRelease gameRelease, CancellationToken cancel)
    {
        var tempPath = Path.Combine(Path.GetTempPath(), $"medit-track-{Guid.NewGuid():N}.json");
        try
        {
            await codec.SerializeAsync(record, tempPath, gameRelease, cancel);
            var bytes = await File.ReadAllBytesAsync(tempPath, cancel);
            return new PristineFile(relativePath, bytes);
        }
        finally
        {
            if (File.Exists(tempPath)) File.Delete(tempPath);
        }
    }

    private static readonly ILogger<RecordTextCodec> NoOpLogger = Microsoft.Extensions.Logging.Abstractions.NullLogger<RecordTextCodec>.Instance;

    // Same resolution DuckDbRecordRepository.ResolveRecordType uses (schema table name by type
    // match, else the CLR type name lowercased) — duplicated rather than shared, deliberately: it's
    // ten lines with no other caller today, and promoting it costs touching an established indexing
    // path for one new consumer (Minimal-by-Default, root CLAUDE.md).
    private static string ResolveRecordType(IMajorRecordGetter record, IReadOnlyDictionary<string, RecordTableSchema> schemas)
    {
        foreach (var (tableName, schema) in schemas)
        {
            if (schema.RecordType.IsInstanceOfType(record)) return tableName;
        }

        return record.GetType().Name.ToLowerInvariant();
    }

    private static string ComputeSha256(string filePath) =>
        Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(filePath)));

    // meta.ini is a source, never tracked content (ADR-0041 amendment) — read here as opaque bytes,
    // the one field this ticket's trailer set needs (Upstream-Version); absent entirely for
    // authored/manually-installed mods, which is fine, everything on TrackProvenance is optional.
    private static string? ReadMetaIniVersion(string modFolder)
    {
        var metaPath = Path.Combine(modFolder, "meta.ini");
        if (!File.Exists(metaPath)) return null;

        foreach (var line in File.ReadAllLines(metaPath))
        {
            var trimmed = line.Trim();
            if (trimmed.StartsWith("version=", StringComparison.OrdinalIgnoreCase))
                return trimmed["version=".Length..];
        }

        return null;
    }
}
