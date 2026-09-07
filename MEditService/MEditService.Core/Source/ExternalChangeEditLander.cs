using System.Security.Cryptography;
using System.Text;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Source;

/// <summary>The "Keep as My Edit" path: the binary lands as working-tree dirt on the records it
/// touched, so unrelated edits survive. A record with independent dirt that disagrees with the
/// incoming value refuses the whole gesture.</summary>
public static class ExternalChangeEditLander
{
    public static ExternalChangeLandResult Keep(
        string modFolder, PluginKey plugin, string pluginPath, GameRelease gameRelease,
        SchemaReflector reflector, ILogger? logger = null)
    {
        logger ??= NullLogger.Instance;
        var repository = SourceRepository.Open(modFolder, gameRelease)
            ?? throw new InvalidOperationException($"'{modFolder}' is not tracked, so it has no source to land on.");
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var schemas = reflector.GetSchemas(gameRelease);
        var pluginName = plugin.Name;

        // Keyed by the record, not by its path: an external EditorID change moves a record's file, and
        // the baseline it is diffed against is still the same record's.
        var baselineByFormKey = repository.ReadAll(plugin, SourceRepository.LastCompileRef(pluginName))
            .ToDictionary(d => d.FormKey, d => d.Body, StringComparer.Ordinal);

        // Keep only runs against a tracked plugin, so the mod-folder-only ForRead overload applies.
        var deepParsed = ModFactory.ImportSetter(
            new ModPath(ModKey.FromFileName(pluginName), pluginPath), gameRelease, LocalizedStrings.ForRead(modFolder));
        var touched = new List<TouchedRecord>();
        foreach (var record in deepParsed.EnumerateMajorRecords())
        {
            var recordType = SourceRecordType.Resolve(record, schemas);
            var groupFolder = RecordTypeDispatch.For(gameRelease).FolderNameFor(recordType);
            var containerFormKey = record.FormKey.ToString();

            // A container or embedded record has no computable path but usually already has a file; the same
            // disk-scan resolution the point-write path uses.
            if (groupFolder is null)
            {
                var unit = repository.Locate(plugin, new RecordIdentity(containerFormKey, recordType, record.EditorID));

                if (unit is null)
                {
                    // Truly new, nowhere in the tree and with no container to hold it: landing a brand-new container
                    // needs the layout grammar this method lacks, so it is logged and skipped.
                    if (logger.IsEnabled(LogLevel.Debug))
                    {
                        logger.LogDebug(
                            "Skipping {FormKey} ({RecordType}) in {Plugin}: no existing source unit anywhere in " +
                            "the tree — landing a brand-new container isn't supported yet",
                            record.FormKey, recordType, pluginName);
                    }
                    continue;
                }

                if (unit.Value.IsEmbedded)
                {
                    // Inlined in its owner's document, and the owner's own pass serializes this child's current value
                    // as part of the owner's whole text.
                    if (logger.IsEnabled(LogLevel.Trace))
                    {
                        logger.LogTrace(
                            "Deferring {FormKey} ({RecordType}) in {Plugin} to its owner {OwnerFormKey}'s own pass — " +
                            "it is embedded, not its own source unit",
                            record.FormKey, recordType, pluginName, unit.Value.OwnerFormKey);
                    }
                    continue;
                }

                // Its own source unit, so the path found is the path to diff and land on.
                if (DiffAgainstBaseline(
                        record, gameRelease, codec, baselineByFormKey, containerFormKey,
                        unit.Value.FullPath, unit.Value.FullPath) is { } containerTouched)
                {
                    touched.Add(containerTouched);
                }
                continue;
            }

            var formKey = record.FormKey.ToString();
            var fullPath = Path.Combine(
                modFolder, SourceRecordPath.For(pluginName, recordType, formKey, record.EditorID, gameRelease));

            // An external EditorID change moves the record's file, so it may sit under its old EditorID.
            // Resolved by FormKey so the collision check reads the real current text and the stale file
            // is removed.
            var existingPath = repository
                .Locate(plugin, new RecordIdentity(formKey, recordType, record.EditorID))
                ?.FullPath ?? fullPath;

            if (DiffAgainstBaseline(
                    record, gameRelease, codec, baselineByFormKey, formKey, fullPath, existingPath)
                is { } flatTouched)
            {
                touched.Add(flatTouched);
            }
        }

        var colliding = touched
            .Where(t => !string.Equals(t.CurrentText, t.BaselineText, StringComparison.Ordinal)
                     && !string.Equals(t.CurrentText, t.IncomingText, StringComparison.Ordinal))
            .ToList();
        if (colliding.Count > 0)
        {
            return ExternalChangeLandResult.Refused(
                $"{pluginName} has uncommitted working-tree changes on record(s) the external change also " +
                $"touched — {string.Join(", ", colliding.Select(c => c.FormKey))}. Commit or revert them, then " +
                "answer the external-change question again.");
        }

        foreach (var t in touched)
        {
            // The stale file under the old EditorID, never left behind as a duplicate.
            if (!string.Equals(t.ExistingPath, t.FullPath, StringComparison.Ordinal) && File.Exists(t.ExistingPath))
                File.Delete(t.ExistingPath);

            Directory.CreateDirectory(Path.GetDirectoryName(t.FullPath)!);
            File.WriteAllText(t.FullPath, t.IncomingText);
        }

        // The working tree now corresponds to this binary — atRef: null snapshots it as it stands, as
        // Save & Compile parks.
        var binarySha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(pluginPath)));
        SourceRepository.ParkCompileSnapshot(modFolder, pluginName, atRef: null, binarySha256);
        ExternalChangeDeferral.Clear(modFolder, pluginName);

        return ExternalChangeLandResult.Success([.. touched.Select(t => t.FormKey)]);
    }

    // Null when the external binary never touched this record (incoming == baseline).
    private static TouchedRecord? DiffAgainstBaseline(
        IMajorRecordGetter record, GameRelease gameRelease, RecordTextCodec codec,
        Dictionary<string, string> baselineByFormKey, string formKey, string fullPath, string existingPath)
    {
        var incomingText = Encoding.UTF8.GetString(codec.SerializeToBytesAsync(record, gameRelease).GetAwaiter().GetResult());

        var baselineText = baselineByFormKey.TryGetValue(formKey, out var baseline) ? baseline : null;
        if (string.Equals(incomingText, baselineText, StringComparison.Ordinal))
            return null; // the external change never actually touched this record

        var currentText = File.Exists(existingPath) ? File.ReadAllText(existingPath) : null;
        return new TouchedRecord(formKey, fullPath, existingPath, incomingText, currentText, baselineText);
    }

    private sealed record TouchedRecord(
        string FormKey, string FullPath, string ExistingPath, string IncomingText,
        string? CurrentText, string? BaselineText);
}

/// <summary>Keep as My Edit's outcome — a typed refusal (naming the colliding records), never a
/// partial apply: either every touched record lands, or none of them do.</summary>
public sealed record ExternalChangeLandResult(bool Applied, string? RefusalReason, IReadOnlyList<string> LandedFormKeys)
{
    public static ExternalChangeLandResult Success(IReadOnlyList<string> landedFormKeys) => new(true, null, landedFormKeys);

    public static ExternalChangeLandResult Refused(string reason) => new(false, reason, []);
}
