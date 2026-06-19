using System.Globalization;
using System.Text.Json;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Edits;

public interface IPluginWriter
{
    Task<PreparedPluginSave> PrepareAsync(
        string pluginPath,
        IReadOnlyList<PendingChange> changes,
        GameRelease gameRelease);

    Task<SaveResult> SaveAsync(
        string pluginPath,
        IReadOnlyList<PendingChange> changes,
        GameRelease gameRelease);

    bool IsReadOnly(GameRelease release, string recordType, string fieldPath);
}

public sealed class PluginWriter : IPluginWriter
{
    private const int MaxBackups = 5;

    private readonly ISchemaReflector _schemaReflector;
    private readonly ILogger<PluginWriter> _logger;

    public PluginWriter(ISchemaReflector schemaReflector, ILogger<PluginWriter> logger)
    {
        _schemaReflector = schemaReflector;
        _logger = logger;
    }

    public async Task<PreparedPluginSave> PrepareAsync(
        string pluginPath,
        IReadOnlyList<PendingChange> changes,
        GameRelease gameRelease)
    {
        var backupPath = CreateBackup(pluginPath);

        var modKey = ModKey.FromFileName(Path.GetFileName(pluginPath));
        var modPath = new ModPath(modKey, pluginPath);

        var mod = ModFactory.ImportSetter(modPath, gameRelease);

        var byFormKey = changes.GroupBy(c => c.FormKey);
        var schemas = _schemaReflector.GetSchemas(gameRelease);

        var applied = new List<string>();
        var readOnly = new List<string>();
        var notFound = new List<string>();
        var createFailed = new List<string>();

        ApplyCreateChanges(byFormKey, mod, schemas, applied, notFound, createFailed);
        ApplyFieldChanges(byFormKey, mod, schemas, applied, readOnly, notFound);
        ApplyDeleteChanges(byFormKey, mod, schemas, applied, notFound);
        ApplyRenumberChanges(byFormKey, mod, schemas, applied, notFound);

        var dir = Path.GetDirectoryName(pluginPath)!;
        var tmpDir = Path.Combine(dir, ".medit_tmp_" + Path.GetRandomFileName());
        var tmpPath = Path.Combine(tmpDir, Path.GetFileName(pluginPath));
        Directory.CreateDirectory(tmpDir);

        await mod.BeginWrite
            .ToPath(tmpPath)
            .WithLoadOrderFromHeaderMasters()
            .WithNoDataFolder()
            .WriteAsync();

        return new PreparedPluginSave(tmpPath, pluginPath, new SaveResult(backupPath, applied, readOnly, notFound, createFailed));
    }

    public async Task<SaveResult> SaveAsync(
        string pluginPath,
        IReadOnlyList<PendingChange> changes,
        GameRelease gameRelease)
    {
        using var prep = await PrepareAsync(pluginPath, changes, gameRelease);
        prep.Commit();
        PruneOldBackups(pluginPath);
        return prep.Result;
    }

    public bool IsReadOnly(GameRelease release, string recordType, string fieldPath)
    {
        var schemas = _schemaReflector.GetSchemas(release);
        if (!schemas.TryGetValue(recordType, out var schema)) return true;
        var col = schema.RecordColumns.FirstOrDefault(c => c.Name == fieldPath);
        return col?.Apply == null;
    }

    private static void ApplyCreateChanges(
        IEnumerable<IGrouping<string, PendingChange>> byFormKey,
        IMod mod,
        IReadOnlyDictionary<string, RecordTableSchema> schemas,
        List<string> applied,
        List<string> notFound,
        List<string> createFailed)
    {
        foreach (var group in byFormKey)
        {
            var createChange = group.FirstOrDefault(c => c.ChangeType == PendingChangeConstants.CreateChangeType);
            if (createChange == null) continue;

            if (!FormKey.TryFactory(group.Key, out var formKey))
            {
                notFound.Add(createChange.FieldPath);
                continue;
            }

            if (!schemas.TryGetValue(createChange.RecordType, out var schema) || schema.AddNew == null)
            {
                createFailed.Add(createChange.RecordType);
                continue;
            }

            schema.AddNew(mod, formKey);
            applied.Add(createChange.FieldPath);
        }
    }

    private static void ApplyFieldChanges(
        IEnumerable<IGrouping<string, PendingChange>> byFormKey,
        IMod mod,
        IReadOnlyDictionary<string, RecordTableSchema> schemas,
        List<string> applied,
        List<string> readOnly,
        List<string> notFound)
    {
        foreach (var group in byFormKey)
        {
            var fieldChanges = group.Where(c => c.ChangeType == PendingChangeConstants.FieldEditChangeType).ToList();

            if (!FormKey.TryFactory(group.Key, out var formKey))
            {
                notFound.AddRange(fieldChanges.Select(c => c.FieldPath));
                continue;
            }

            var record = mod.EnumerateMajorRecords().OfType<IMajorRecord>().FirstOrDefault(r => r.FormKey == formKey);
            if (record == null)
            {
                notFound.AddRange(fieldChanges.Select(c => c.FieldPath));
                continue;
            }

            foreach (var change in fieldChanges)
            {
                switch (TryApplyField(record, change, schemas))
                {
                    case ApplyOutcome.Applied: applied.Add(change.FieldPath); break;
                    case ApplyOutcome.ReadOnly: readOnly.Add(change.FieldPath); break;
                    case ApplyOutcome.NotFound: notFound.Add(change.FieldPath); break;
                }
            }
        }
    }

    private static void ApplyDeleteChanges(
        IEnumerable<IGrouping<string, PendingChange>> byFormKey,
        IMod mod,
        IReadOnlyDictionary<string, RecordTableSchema> schemas,
        List<string> applied,
        List<string> notFound)
    {
        foreach (var group in byFormKey)
        {
            var deleteChange = group.FirstOrDefault(c => c.ChangeType == PendingChangeConstants.DeleteChangeType);
            if (deleteChange == null) continue;

            if (!FormKey.TryFactory(group.Key, out var formKey) ||
                !schemas.TryGetValue(deleteChange.RecordType, out var schema) ||
                schema.Remove == null)
            {
                notFound.Add(deleteChange.FieldPath);
                continue;
            }

            if (schema.Remove(mod, formKey))
                applied.Add(deleteChange.FieldPath);
            else
                notFound.Add(deleteChange.FieldPath);
        }
    }

    private static void ApplyRenumberChanges(
        IEnumerable<IGrouping<string, PendingChange>> byFormKey,
        IMod mod,
        IReadOnlyDictionary<string, RecordTableSchema> schemas,
        List<string> applied,
        List<string> notFound)
    {
        var allMappings = new Dictionary<FormKey, FormKey>();

        foreach (var group in byFormKey)
        {
            var renumberChange = group.FirstOrDefault(c => c.ChangeType == PendingChangeConstants.RenumberChangeType);
            if (renumberChange == null) continue;

            var oldFormKeyStr = renumberChange.OldValue.GetString()!;
            var newFormKeyStr = renumberChange.NewValue.GetString()!;

            if (!FormKey.TryFactory(oldFormKeyStr, out var oldFormKey) ||
                !FormKey.TryFactory(newFormKeyStr, out var newFormKey))
            {
                notFound.Add(renumberChange.FieldPath);
                continue;
            }

            if (!schemas.TryGetValue(renumberChange.RecordType, out var schema) ||
                schema.AddExisting == null || schema.Remove == null)
            {
                notFound.Add(renumberChange.FieldPath);
                continue;
            }

            var oldRecord = mod.EnumerateMajorRecords()
                .FirstOrDefault(r => r.FormKey == oldFormKey);
            if (oldRecord == null)
            {
                notFound.Add(renumberChange.FieldPath);
                continue;
            }

            var newRecord = (IMajorRecord)oldRecord.Duplicate(newFormKey);
            schema.AddExisting(mod, newRecord);
            schema.Remove(mod, oldFormKey);
            allMappings[oldFormKey] = newFormKey;
            applied.Add(renumberChange.FieldPath);
        }

        // Single pass: remap all intra-plugin FormLinks across all renumber operations.
        // IMod.RemapLinks() is an explicit interface impl on AMod that throws; iterate
        // records directly so each concrete type's public override is dispatched.
        if (allMappings.Count > 0)
            foreach (var rec in mod.EnumerateMajorRecords())
                rec.RemapLinks(allMappings);
    }

    private enum ApplyOutcome { Applied, ReadOnly, NotFound }

    private static ApplyOutcome TryApplyField(
        IMajorRecord record,
        PendingChange change,
        IReadOnlyDictionary<string, RecordTableSchema> schemas)
    {
        if (!schemas.TryGetValue(change.RecordType, out var schema))
            return ApplyOutcome.NotFound;
        var col = schema.RecordColumns.FirstOrDefault(c => c.Name == change.FieldPath);
        if (col == null)
            return ApplyOutcome.NotFound;
        if (col.Apply == null)
            return ApplyOutcome.ReadOnly;
        col.Apply(record, change.NewValue);
        return ApplyOutcome.Applied;
    }

    internal static string CreateBackup(string pluginPath, string? timestamp = null)
    {
        var dir = Path.GetDirectoryName(pluginPath)!;
        var name = Path.GetFileNameWithoutExtension(pluginPath);
        var ext = Path.GetExtension(pluginPath);
        var ts = timestamp ?? DateTime.UtcNow.ToString("yyyy-MM-ddTHH-mm-ss", CultureInfo.InvariantCulture);
        var path = Path.Combine(dir, $"{name}.{ts}.bak{ext}");
        File.Copy(pluginPath, path, overwrite: false);
        return path;
    }

    internal void PruneOldBackups(string pluginPath)
    {
        var dir = Path.GetDirectoryName(pluginPath)!;
        var name = Path.GetFileNameWithoutExtension(pluginPath);
        var ext = Path.GetExtension(pluginPath);

        var old = Directory.GetFiles(dir, $"{name}.*.bak{ext}")
            .OrderByDescending(f => f)
            .Skip(MaxBackups);

        foreach (var f in old)
            try { File.Delete(f); }
            catch (Exception ex) { _logger.LogWarning(ex, "Failed to delete old backup {File}", f); }
    }
}
