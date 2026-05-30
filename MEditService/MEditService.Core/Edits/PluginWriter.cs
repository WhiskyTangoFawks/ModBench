using System.Text.Json;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Edits;

public interface IPluginWriter
{
    Task<SaveResult> SaveAsync(
        string pluginPath,
        IReadOnlyList<PendingChange> changes,
        IRecordRepository repository,
        int loadOrderIndex,
        GameRelease gameRelease);

    bool IsReadOnly(GameRelease release, string recordType, string fieldPath);
}

public sealed class PluginWriter : IPluginWriter
{
    private const int MaxBackups = 5;

    private readonly ISchemaReflector _schemaReflector;

    public PluginWriter(ISchemaReflector schemaReflector)
    {
        _schemaReflector = schemaReflector;
    }

    public async Task<SaveResult> SaveAsync(
        string pluginPath,
        IReadOnlyList<PendingChange> changes,
        IRecordRepository repository,
        int loadOrderIndex,
        GameRelease gameRelease)
    {
        var backupPath = CreateBackup(pluginPath);

        var modKey  = ModKey.FromFileName(Path.GetFileName(pluginPath));
        var modPath = new ModPath(modKey, pluginPath);

        var mod = ModFactory.ImportSetter(modPath, gameRelease);

        var byFormKey = changes.GroupBy(c => c.FormKey);
        var schemas = _schemaReflector.GetSchemas(gameRelease);

        var applied  = new List<string>();
        var readOnly = new List<string>();
        var notFound = new List<string>();

        foreach (var group in byFormKey)
        {
            if (!FormKey.TryFactory(group.Key, out var formKey))
            {
                notFound.AddRange(group.Select(c => c.FieldPath));
                continue;
            }

            var record = mod.EnumerateMajorRecords().FirstOrDefault(r => r.FormKey == formKey);
            if (record == null)
            {
                notFound.AddRange(group.Select(c => c.FieldPath));
                continue;
            }

            foreach (var change in group)
            {
                switch (TryApplyField(record, change, schemas))
                {
                    case ApplyOutcome.Applied:  applied.Add(change.FieldPath);  break;
                    case ApplyOutcome.ReadOnly: readOnly.Add(change.FieldPath); break;
                    case ApplyOutcome.NotFound: notFound.Add(change.FieldPath); break;
                }
            }
        }

        await mod.BeginWrite
            .ToPath(pluginPath)
            .WithLoadOrderFromHeaderMasters()
            .WithNoDataFolder()
            .WriteAsync();

        repository.Index((IModGetter)mod, loadOrderIndex);
        repository.UpdateWinners();

        PruneOldBackups(pluginPath);

        return new SaveResult(backupPath, applied, readOnly, notFound);
    }

    public bool IsReadOnly(GameRelease release, string recordType, string fieldPath)
    {
        var schemas = _schemaReflector.GetSchemas(release);
        if (!schemas.TryGetValue(recordType, out var schema)) return true;
        var col = schema.RecordColumns.FirstOrDefault(c => c.Name == fieldPath);
        return col?.Apply == null;
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

    private static string CreateBackup(string pluginPath)
    {
        var dir  = Path.GetDirectoryName(pluginPath)!;
        var name = Path.GetFileNameWithoutExtension(pluginPath);
        var ext  = Path.GetExtension(pluginPath);
        var ts   = DateTime.UtcNow.ToString("yyyy-MM-ddTHH-mm-ss");
        var path = Path.Combine(dir, $"{name}.{ts}.bak{ext}");
        File.Copy(pluginPath, path, overwrite: false);
        return path;
    }

    private static void PruneOldBackups(string pluginPath)
    {
        var dir  = Path.GetDirectoryName(pluginPath)!;
        var name = Path.GetFileNameWithoutExtension(pluginPath);
        var ext  = Path.GetExtension(pluginPath);

        var old = Directory.GetFiles(dir, $"{name}.*.bak{ext}")
            .OrderByDescending(f => f)
            .Skip(MaxBackups);

        foreach (var f in old)
            try { File.Delete(f); } catch { /* best effort */ }
    }
}
