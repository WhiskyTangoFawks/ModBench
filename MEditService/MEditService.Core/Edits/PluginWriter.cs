using System.Globalization;
using System.Text.Json;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
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
        if (VmadPath.IsVmadPath(fieldPath)) return false;
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
        if (VmadPath.IsVmadPath(change.FieldPath))
            return ApplyVmadField(record, change);

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

    private static ApplyOutcome ApplyVmadField(IMajorRecord record, PendingChange change)
    {
        if (record is not IHaveVirtualMachineAdapter vmadRecord)
            return ApplyOutcome.NotFound;

        var vmad = vmadRecord.VirtualMachineAdapter;
        if (vmad == null)
            return ApplyOutcome.NotFound;

        if (!VmadPath.TryParse(change.FieldPath, out var scriptName, out var propName))
            return ApplyOutcome.NotFound;

        var script = vmad.Scripts.FirstOrDefault(s =>
            string.Equals(s.Name, scriptName, StringComparison.OrdinalIgnoreCase));
        if (script == null)
            return ApplyOutcome.NotFound;

        var prop = script.Properties.FirstOrDefault(p =>
            string.Equals(p.Name, propName, StringComparison.OrdinalIgnoreCase));
        if (prop == null)
            return ApplyOutcome.NotFound;

        switch (prop)
        {
            case ScriptBoolProperty p: p.Data = change.NewValue.GetBoolean(); break;
            case ScriptIntProperty p: p.Data = change.NewValue.GetInt32(); break;
            case ScriptFloatProperty p: p.Data = change.NewValue.GetSingle(); break;
            case ScriptStringProperty p: p.Data = change.NewValue.GetString()!; break;
            case ScriptObjectProperty p: return ApplyObjectProperty(p, change.NewValue);
            case ScriptBoolListProperty p: return RebuildList(p.Data, change.NewValue, el => el.GetBoolean());
            case ScriptIntListProperty p: return RebuildList(p.Data, change.NewValue, el => el.GetInt32());
            case ScriptFloatListProperty p: return RebuildList(p.Data, change.NewValue, el => el.GetSingle());
            case ScriptStringListProperty p: return RebuildList(p.Data, change.NewValue, el => el.GetString()!);
            case ScriptObjectListProperty p: return ApplyObjectListProperty(p, change.NewValue);
            case ScriptStructProperty p: return ApplyStructProperty(p, change.NewValue);
            case ScriptStructListProperty p: return ApplyStructListProperty(p, change.NewValue);
            case ScriptVariableProperty:
            case ScriptVariableListProperty:
                return ApplyOutcome.ReadOnly;
            default:
                return ApplyOutcome.NotFound;
        }

        return ApplyOutcome.Applied;
    }

    private static bool TryParseScriptObject(JsonElement el, out FormKey fk, out short alias)
    {
        alias = 0;
        if (!el.TryGetProperty("formKey", out var fkEl) ||
            fkEl.GetString() is not string fkStr ||
            !FormKey.TryFactory(fkStr, out fk) ||
            !el.TryGetProperty("alias", out var aliasEl))
        {
            fk = default;
            return false;
        }
        if (aliasEl.ValueKind == JsonValueKind.Null) { fk = default; return false; }
        alias = aliasEl.GetInt16();
        return true;
    }

    private static ApplyOutcome ApplyObjectProperty(ScriptObjectProperty p, JsonElement value)
    {
        if (!TryParseScriptObject(value, out var fk, out var alias))
            return ApplyOutcome.NotFound;
        p.Object.SetTo(fk);
        p.Alias = alias;
        return ApplyOutcome.Applied;
    }

    private static ApplyOutcome RebuildList<T>(IList<T> list, JsonElement array, Func<JsonElement, T> parse)
    {
        if (array.ValueKind != JsonValueKind.Array) return ApplyOutcome.NotFound;
        list.Clear();
        foreach (var el in array.EnumerateArray()) list.Add(parse(el));
        return ApplyOutcome.Applied;
    }

    private static ApplyOutcome ApplyObjectListProperty(ScriptObjectListProperty p, JsonElement array)
    {
        if (array.ValueKind != JsonValueKind.Array) return ApplyOutcome.NotFound;
        var built = new List<ScriptObjectProperty>();
        foreach (var el in array.EnumerateArray())
        {
            if (!TryParseScriptObject(el, out var elFk, out var alias))
                return ApplyOutcome.NotFound;
            var obj = new ScriptObjectProperty { Alias = alias };
            obj.Object.SetTo(elFk);
            built.Add(obj);
        }
        p.Objects.Clear();
        foreach (var obj in built) p.Objects.Add(obj);
        return ApplyOutcome.Applied;
    }

    private static ApplyOutcome ApplyStructProperty(ScriptStructProperty p, JsonElement members)
    {
        if (members.ValueKind != JsonValueKind.Array || !TryBuildMembers(members, out var built))
            return ApplyOutcome.NotFound;
        // A Struct's fields live inside a single unnamed ScriptEntry wrapper in the binary format.
        var wrapper = new ScriptEntry();
        foreach (var m in built) wrapper.Properties.Add(m);
        p.Members.Clear();
        p.Members.Add(wrapper);
        return ApplyOutcome.Applied;
    }

    private static ApplyOutcome ApplyStructListProperty(ScriptStructListProperty p, JsonElement instances)
    {
        if (instances.ValueKind != JsonValueKind.Array) return ApplyOutcome.NotFound;
        var built = new List<ScriptEntryStructs>();
        foreach (var inst in instances.EnumerateArray())
        {
            if (inst.ValueKind != JsonValueKind.Array || !TryBuildMembers(inst, out var members))
                return ApplyOutcome.NotFound;
            var entry = new ScriptEntryStructs();
            foreach (var m in members) entry.Members.Add(m);
            built.Add(entry);
        }
        p.Structs.Clear();
        foreach (var entry in built) p.Structs.Add(entry);
        return ApplyOutcome.Applied;
    }

    private static bool TryBuildMembers(JsonElement array, out List<ScriptProperty> built)
    {
        built = [];
        if (array.ValueKind != JsonValueKind.Array) return false;
        foreach (var el in array.EnumerateArray())
        {
            if (!TryBuildMemberProperty(el, out var prop)) return false;
            built.Add(prop);
        }
        return true;
    }

    private static bool TryBuildMemberProperty(JsonElement node, out ScriptProperty prop)
    {
        prop = null!;
        if (node.ValueKind != JsonValueKind.Object
            || !node.TryGetProperty("name", out var nameEl) || nameEl.GetString() is not string name
            || !node.TryGetProperty("type", out var typeEl) || typeEl.GetString() is not string type)
            return false;

        var flags = ParseMemberFlags(node);
        switch (type)
        {
            case "Bool" when node.TryGetProperty("boolValue", out var v):
                prop = new ScriptBoolProperty { Name = name, Flags = flags, Data = v.GetBoolean() }; break;
            case "Int" when node.TryGetProperty("intValue", out var v):
                prop = new ScriptIntProperty { Name = name, Flags = flags, Data = v.GetInt32() }; break;
            case "Float" when node.TryGetProperty("floatValue", out var v):
                prop = new ScriptFloatProperty { Name = name, Flags = flags, Data = v.GetSingle() }; break;
            case "String" when node.TryGetProperty("stringValue", out var v):
                prop = new ScriptStringProperty { Name = name, Flags = flags, Data = v.GetString()! }; break;
            case "Object":
                // Struct member Object nodes carry formKeyValue/aliasValue (the VmadPropertyNode
                // wire shape), distinct from the {formKey, alias} shape used for top-level edits.
                if (!node.TryGetProperty("formKeyValue", out var fkEl) || fkEl.GetString() is not string fkStr
                    || !FormKey.TryFactory(fkStr, out var fk))
                    return false;
                var alias = node.TryGetProperty("aliasValue", out var aEl) && aEl.ValueKind == JsonValueKind.Number
                    ? aEl.GetInt16()
                    : (short)0;
                var obj = new ScriptObjectProperty { Name = name, Flags = flags, Alias = alias };
                obj.Object.SetTo(fk);
                prop = obj;
                break;
            case "Struct" when node.TryGetProperty("members", out var nested):
                if (!TryBuildMembers(nested, out var nestedBuilt)) return false;
                var wrapper = new ScriptEntry();
                foreach (var m in nestedBuilt) wrapper.Properties.Add(m);
                var sp = new ScriptStructProperty { Name = name, Flags = flags };
                sp.Members.Add(wrapper);
                prop = sp;
                break;
            default:
                return false;
        }
        return true;
    }

    private static ScriptProperty.Flag ParseMemberFlags(JsonElement node) =>
        node.TryGetProperty("flags", out var f) && f.GetString() is string s
            && Enum.TryParse<ScriptProperty.Flag>(s, out var parsed)
            ? parsed
            : 0;

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
