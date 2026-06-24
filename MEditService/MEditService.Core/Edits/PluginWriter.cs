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
            var fieldChanges = group.Where(c =>
                c.ChangeType == PendingChangeConstants.FieldEditChangeType ||
                c.ChangeType == PendingChangeConstants.VmadStructOpChangeType).ToList();

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
        if (change.ChangeType == PendingChangeConstants.VmadStructOpChangeType)
            return ApplyVmadStructOp(record, change);

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

        return ApplyValue(prop, change.NewValue);
    }

    // Applies a value (per-type payload shape from 13.4/13.6/13.7) into an existing property.
    // Shared by in-place field edits (ApplyVmadField) and structural add_property.
    private static ApplyOutcome ApplyValue(ScriptProperty prop, JsonElement value)
    {
        switch (prop)
        {
            case ScriptBoolProperty p: p.Data = value.GetBoolean(); break;
            case ScriptIntProperty p: p.Data = value.GetInt32(); break;
            case ScriptFloatProperty p: p.Data = value.GetSingle(); break;
            case ScriptStringProperty p: p.Data = value.GetString()!; break;
            case ScriptObjectProperty p: return ApplyObjectProperty(p, value);
            case ScriptBoolListProperty p: return RebuildList(p.Data, value, el => el.GetBoolean());
            case ScriptIntListProperty p: return RebuildList(p.Data, value, el => el.GetInt32());
            case ScriptFloatListProperty p: return RebuildList(p.Data, value, el => el.GetSingle());
            case ScriptStringListProperty p: return RebuildList(p.Data, value, el => el.GetString()!);
            case ScriptObjectListProperty p: return ApplyObjectListProperty(p, value);
            case ScriptStructProperty p: return ApplyStructProperty(p, value);
            case ScriptStructListProperty p: return ApplyStructListProperty(p, value);
            case ScriptVariableProperty:
            case ScriptVariableListProperty:
                return ApplyOutcome.ReadOnly;
            default:
                return ApplyOutcome.NotFound;
        }

        return ApplyOutcome.Applied;
    }

    // Structural VMAD operations (phase 13.8): add/remove a property on a script.
    // The change value is an op payload { op, ... }; the op discriminator routes the work.
    private static ApplyOutcome ApplyVmadStructOp(IMajorRecord record, PendingChange change)
    {
        if (record is not IHaveVirtualMachineAdapter vmadRecord)
            return ApplyOutcome.NotFound;

        var op = change.NewValue;
        if (op.ValueKind != JsonValueKind.Object
            || !op.TryGetProperty("op", out var opEl) || opEl.GetString() is not string opName)
            return ApplyOutcome.NotFound;

        // Route by path shape: "VMAD\<ScriptName>" is script-level, "VMAD\<ScriptName>\<Prop>" property-level.
        if (VmadPath.TryParseScript(change.FieldPath, out var scriptOnly))
        {
            var adapter = vmadRecord.VirtualMachineAdapter;
            return opName switch
            {
                "add_script" => AddScript(vmadRecord, scriptOnly, op),
                "remove_script" => RemoveScript(adapter, scriptOnly),
                "set_flags" => SetScriptFlags(adapter, scriptOnly, op),
                _ => ApplyOutcome.NotFound,
            };
        }

        if (!VmadPath.TryParse(change.FieldPath, out var scriptName, out var propName))
            return ApplyOutcome.NotFound;

        var vmad = vmadRecord.VirtualMachineAdapter;
        var script = vmad?.Scripts.FirstOrDefault(s =>
            string.Equals(s.Name, scriptName, StringComparison.OrdinalIgnoreCase));
        if (script == null)
            return ApplyOutcome.NotFound;

        return opName switch
        {
            "add_property" => AddProperty(script, op),
            "remove_property" => RemoveProperty(script, propName),
            "set_type" => SetType(script, propName, op),
            "set_flags" => SetPropertyFlags(script, propName, op),
            _ => ApplyOutcome.NotFound,
        };
    }

    private static ApplyOutcome SetPropertyFlags(ScriptEntry script, string propName, JsonElement op)
    {
        var prop = script.Properties.FirstOrDefault(p =>
            string.Equals(p.Name, propName, StringComparison.OrdinalIgnoreCase));
        if (prop == null) return ApplyOutcome.NotFound;
        if (!op.TryGetProperty("flags", out var f) || f.GetString() is not string s
            || !Enum.TryParse<ScriptProperty.Flag>(s, out var parsed))
            return ApplyOutcome.NotFound;
        prop.Flags = parsed;
        return ApplyOutcome.Applied;
    }

    private static ApplyOutcome SetScriptFlags(IAVirtualMachineAdapter? vmad, string scriptName, JsonElement op)
    {
        var script = vmad?.Scripts.FirstOrDefault(s =>
            string.Equals(s.Name, scriptName, StringComparison.OrdinalIgnoreCase));
        if (script == null) return ApplyOutcome.NotFound;
        if (!op.TryGetProperty("flags", out var f) || f.GetString() is not string s
            || !Enum.TryParse<ScriptEntry.Flag>(s, out var parsed))
            return ApplyOutcome.NotFound;
        script.Flags = parsed;
        return ApplyOutcome.Applied;
    }

    // Replaces a property in place with a default-valued property of the target type, preserving
    // Name and Flags (mirrors xEdit's wbScriptPropertyTypeAfterSet, which resets the value).
    private static ApplyOutcome SetType(ScriptEntry script, string propName, JsonElement op)
    {
        if (!op.TryGetProperty("type", out var typeEl) || typeEl.GetString() is not string type)
            return ApplyOutcome.NotFound;

        var idx = -1;
        for (var i = 0; i < script.Properties.Count; i++)
            if (string.Equals(script.Properties[i].Name, propName, StringComparison.OrdinalIgnoreCase))
            {
                idx = i;
                break;
            }
        if (idx < 0) return ApplyOutcome.NotFound;

        var replacement = BuildDefaultProperty(type);
        if (replacement == null) return ApplyOutcome.NotFound;
        replacement.Name = script.Properties[idx].Name;
        replacement.Flags = script.Properties[idx].Flags;
        script.Properties[idx] = replacement;
        return ApplyOutcome.Applied;
    }

    private static ApplyOutcome AddScript(IHaveVirtualMachineAdapter vmadRecord, string scriptName, JsonElement op)
    {
        // Attach an adapter to a record that has none (correct subtype per record via reflection).
        var vmad = vmadRecord.VirtualMachineAdapter ?? CreateAdapter(vmadRecord);
        if (vmad == null)
            return ApplyOutcome.NotFound;

        // A new script starts empty; properties are added individually via add_property.
        var entry = new ScriptEntry { Name = scriptName, Flags = ParseScriptFlags(op) };

        for (var i = vmad.Scripts.Count - 1; i >= 0; i--)
            if (string.Equals(vmad.Scripts[i].Name, scriptName, StringComparison.OrdinalIgnoreCase))
                vmad.Scripts.RemoveAt(i);
        vmad.Scripts.Add(entry);
        SortScripts(vmad);
        return ApplyOutcome.Applied;
    }

    // Removing the last script leaves an empty adapter (matches xEdit) rather than nulling it.
    private static ApplyOutcome RemoveScript(IAVirtualMachineAdapter? vmad, string scriptName)
    {
        if (vmad == null) return ApplyOutcome.NotFound;
        var removed = false;
        for (var i = vmad.Scripts.Count - 1; i >= 0; i--)
            if (string.Equals(vmad.Scripts[i].Name, scriptName, StringComparison.OrdinalIgnoreCase))
            {
                vmad.Scripts.RemoveAt(i);
                removed = true;
            }
        return removed ? ApplyOutcome.Applied : ApplyOutcome.NotFound;
    }

    private static void SortScripts(IAVirtualMachineAdapter vmad)
    {
        var sorted = vmad.Scripts.OrderBy(s => s.Name, StringComparer.OrdinalIgnoreCase).ToList();
        vmad.Scripts.Clear();
        foreach (var s in sorted) vmad.Scripts.Add(s);
    }

    private static IAVirtualMachineAdapter? CreateAdapter(IHaveVirtualMachineAdapter record)
    {
        var prop = record.GetType().GetProperty(nameof(IHaveVirtualMachineAdapter.VirtualMachineAdapter));
        if (prop?.CanWrite != true || prop.PropertyType.IsAbstract) return null;
        if (System.Activator.CreateInstance(prop.PropertyType) is not IAVirtualMachineAdapter adapter) return null;
        prop.SetValue(record, adapter);
        return adapter;
    }

    private static ScriptEntry.Flag ParseScriptFlags(JsonElement op) =>
        op.TryGetProperty("flags", out var f) && f.GetString() is string s
            && Enum.TryParse<ScriptEntry.Flag>(s, out var parsed)
            ? parsed
            : ScriptEntry.Flag.Local;

    private static ApplyOutcome AddProperty(ScriptEntry script, JsonElement op)
    {
        if (!op.TryGetProperty("name", out var nameEl) || nameEl.GetString() is not string name
            || !op.TryGetProperty("type", out var typeEl) || typeEl.GetString() is not string type)
            return ApplyOutcome.NotFound;

        var prop = BuildDefaultProperty(type);
        if (prop == null)
            return ApplyOutcome.NotFound;
        prop.Name = name;
        prop.Flags = ParseStructOpFlags(op);

        if (op.TryGetProperty("value", out var value) && value.ValueKind != JsonValueKind.Null)
        {
            var outcome = ApplyValue(prop, value);
            if (outcome != ApplyOutcome.Applied) return outcome;
        }

        RemoveByName(script, name);
        script.Properties.Add(prop);
        SortProperties(script);
        return ApplyOutcome.Applied;
    }

    private static ApplyOutcome RemoveProperty(ScriptEntry script, string propName) =>
        RemoveByName(script, propName) ? ApplyOutcome.Applied : ApplyOutcome.NotFound;

    private static bool RemoveByName(ScriptEntry script, string name)
    {
        var removed = false;
        for (var i = script.Properties.Count - 1; i >= 0; i--)
            if (string.Equals(script.Properties[i].Name, name, StringComparison.OrdinalIgnoreCase))
            {
                script.Properties.RemoveAt(i);
                removed = true;
            }
        return removed;
    }

    private static void SortProperties(ScriptEntry script)
    {
        var sorted = script.Properties
            .OrderBy(p => p.Name, StringComparer.OrdinalIgnoreCase)
            .ToList();
        script.Properties.Clear();
        foreach (var p in sorted) script.Properties.Add(p);
    }

    // Empty property of the given VMAD type; value is filled separately via ApplyValue.
    // Returns null for unknown / non-editable (Variable) types.
    private static ScriptProperty? BuildDefaultProperty(string type) => type switch
    {
        "Bool" => new ScriptBoolProperty(),
        "Int" => new ScriptIntProperty(),
        "Float" => new ScriptFloatProperty(),
        "String" => new ScriptStringProperty { Data = "" },
        "Object" => new ScriptObjectProperty { Alias = -1 },
        "ArrayOfBool" => new ScriptBoolListProperty(),
        "ArrayOfInt" => new ScriptIntListProperty(),
        "ArrayOfFloat" => new ScriptFloatListProperty(),
        "ArrayOfString" => new ScriptStringListProperty(),
        "ArrayOfObject" => new ScriptObjectListProperty(),
        "Struct" => new ScriptStructProperty(),
        "ArrayOfStruct" => new ScriptStructListProperty(),
        _ => null,
    };

    // Like ParseMemberFlags but defaults a new property to Edited (matches xEdit's add default).
    private static ScriptProperty.Flag ParseStructOpFlags(JsonElement op) =>
        op.TryGetProperty("flags", out var f) && f.GetString() is string s
            && Enum.TryParse<ScriptProperty.Flag>(s, out var parsed)
            ? parsed
            : ScriptProperty.Flag.Edited;

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
