using System.Globalization;
using System.Reflection;
using System.Text.Json;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Cache;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Plugins.Utility;

namespace MEditService.Core.Edits;

public interface IPluginWriter
{
    Task<PreparedPluginSave> PrepareAsync(
        string pluginPath,
        IReadOnlyList<PendingChange> changes,
        GameRelease gameRelease,
        ILinkCache? linkCache = null);

    Task<SaveResult> SaveAsync(
        string pluginPath,
        IReadOnlyList<PendingChange> changes,
        GameRelease gameRelease,
        ILinkCache? linkCache = null);

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
        GameRelease gameRelease,
        ILinkCache? linkCache = null)
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

        var placedCtx = new PlacedWriteContext(gameRelease, linkCache);
        ApplyCreateChanges(byFormKey, mod, schemas, placedCtx, applied, notFound, createFailed);
        ApplyFieldChanges(byFormKey, mod, schemas, placedCtx, applied, readOnly, notFound);
        ApplyDeleteChanges(byFormKey, mod, schemas, placedCtx, applied, notFound);
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
        GameRelease gameRelease,
        ILinkCache? linkCache = null)
    {
        using var prep = await PrepareAsync(pluginPath, changes, gameRelease, linkCache);
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

    // Carries the release + link cache needed by the cell-aware placed-record write paths
    // (create/copy/delete) without breaking the parameter budget on the Apply methods.
    private readonly record struct PlacedWriteContext(GameRelease Release, ILinkCache? LinkCache);

    private static void ApplyCreateChanges(
        IEnumerable<IGrouping<string, PendingChange>> byFormKey,
        IMod mod,
        IReadOnlyDictionary<string, RecordTableSchema> schemas,
        PlacedWriteContext ctx,
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

            if (!schemas.TryGetValue(createChange.RecordType, out var schema))
            {
                createFailed.Add(createChange.RecordType);
                continue;
            }

            // Placed records (refr/achr) have no top-level group; they live inside a cell's
            // Persistent/Temporary GRUP. Route them to the cell-aware create path.
            if (createChange.ParentCell != null)
            {
                switch (TryCreatePlaced(mod, ctx, schema, formKey, createChange))
                {
                    case ApplyOutcome.Applied: applied.Add(createChange.FieldPath); break;
                    default: createFailed.Add(createChange.RecordType); break;
                }
                continue;
            }

            if (schema.AddNew == null)
            {
                createFailed.Add(createChange.RecordType);
                continue;
            }

            schema.AddNew(mod, formKey);
            applied.Add(createChange.FieldPath);
        }
    }

    // Cell-aware create for placed records (refr/achr): pull the parent cell into `mod` as an
    // override via the link cache, construct a blank placed record of the schema's concrete type,
    // and add it to the cell's Persistent/Temporary list. Game-agnostic via reflection (mirrors
    // PlacementWalker / SchemaReflector) so it holds for every Mutagen-supported game.
    private static ApplyOutcome TryCreatePlaced(
        IMod mod, PlacedWriteContext ctx, RecordTableSchema schema,
        FormKey formKey, PendingChange createChange)
    {
        if (ctx.LinkCache == null) return ApplyOutcome.NotFound;
        if (!FormKey.TryFactory(createChange.ParentCell!, out var cellFormKey)) return ApplyOutcome.NotFound;

        // Mutagen's game-agnostic factory; schema.RecordType is the getter interface, which Loqui
        // resolves to the concrete placed class. Throws only for unregistered types (not placed).
        var placed = MajorRecordInstantiator.Activator(formKey, ctx.Release, schema.RecordType);

        var cell = ResolveWinnerAsOverride(mod, ctx.LinkCache, cellFormKey);
        if (cell == null) return ApplyOutcome.NotFound;

        return AddToPlacementGroup(cell, createChange.PlacementGroup, placed)
            ? ApplyOutcome.Applied
            : ApplyOutcome.NotFound;
    }

    // Resolves a record's winning context from the link cache and pulls it into `mod` as an override,
    // reconstructing its parentage. For a cell FormKey this yields the cell override (its
    // worldspace/block chain rebuilt); for a placed-ref FormKey Mutagen rebuilds the cell→ref chain,
    // pulling the parent cell in as an override and deep-copying the ref — so this doubles as the
    // copy-as-override path for placed records. Invoked via reflection because ResolveContext /
    // GetOrAddAsOverride are typed on the game's mod types.
    private static IMajorRecord? ResolveWinnerAsOverride(IMod mod, ILinkCache linkCache, FormKey formKey)
    {
        // Pick the non-generic ResolveContext(FormKey, ResolveTarget) — the open-generic overload
        // also matches by parameter types, so GetMethod alone is ambiguous.
        var resolve = linkCache.GetType().GetMethods()
            .FirstOrDefault(m => m is { Name: "ResolveContext", IsGenericMethodDefinition: false }
                && m.GetParameters() is [{ ParameterType.Name: "FormKey" }, { ParameterType.Name: "ResolveTarget" }]);
        if (resolve == null) return null;
        var context = resolve.Invoke(linkCache, [formKey, ResolveTarget.Winner]);
        var getOrAdd = context?.GetType().GetMethod("GetOrAddAsOverride", [mod.GetType()])
            ?? context?.GetType().GetMethods()
                .FirstOrDefault(m => m.Name == "GetOrAddAsOverride" && m.GetParameters().Length == 1);
        return getOrAdd?.Invoke(context, [mod]) as IMajorRecord;
    }

    // Adds a placed record to the cell's Persistent or Temporary list (reflected by name).
    private static bool AddToPlacementGroup(IMajorRecord cell, string? placementGroup, IMajorRecord placed)
    {
        var listName = placementGroup == "temporary" ? "Temporary" : "Persistent";
        if (cell.GetType().GetProperty(listName)?.GetValue(cell) is not System.Collections.IList list)
            return false;
        list.Add(placed);
        return true;
    }

    // Removes the placed record with the given FormKey from the cell's Persistent/Temporary list.
    private static bool RemoveFromPlacementGroup(IMajorRecord cell, string? placementGroup, FormKey formKey)
    {
        var listName = placementGroup == "temporary" ? "Temporary" : "Persistent";
        if (cell.GetType().GetProperty(listName)?.GetValue(cell) is not System.Collections.IList list)
            return false;
        for (var i = list.Count - 1; i >= 0; i--)
            if (list[i] is IMajorRecordGetter rec && rec.FormKey == formKey)
            {
                list.RemoveAt(i);
                return true;
            }
        return false;
    }

    // Copy-as-override for placed records: a group of field_edit changes that carries ParentCell but
    // whose record is absent from `mod` is a copy of a placed ref. Resolving its winner and overriding
    // it pulls the parent cell into `mod` and deep-copies the ref — Mutagen rebuilds the cell→ref
    // parentage. Returns the materialised placed record so the staged field edits can apply to it.
    private static IMajorRecord? TryMaterializePlacedCopy(
        IMod mod, PlacedWriteContext ctx, IGrouping<string, PendingChange> group, FormKey formKey)
    {
        if (ctx.LinkCache == null) return null;
        var copyChange = group.FirstOrDefault(c =>
            c.ChangeType == PendingChangeConstants.FieldEditChangeType && c.ParentCell != null);
        if (copyChange == null) return null;
        return ResolveWinnerAsOverride(mod, ctx.LinkCache, formKey);
    }

    private static void ApplyFieldChanges(
        IEnumerable<IGrouping<string, PendingChange>> byFormKey,
        IMod mod,
        IReadOnlyDictionary<string, RecordTableSchema> schemas,
        PlacedWriteContext ctx,
        List<string> applied,
        List<string> readOnly,
        List<string> notFound)
    {
        foreach (var group in byFormKey)
        {
            var fieldChanges = group.Where(c =>
                c.ChangeType == PendingChangeConstants.FieldEditChangeType ||
                c.ChangeType == PendingChangeConstants.VmadStructOpChangeType).ToList();
            if (fieldChanges.Count == 0) continue;

            if (!FormKey.TryFactory(group.Key, out var formKey))
            {
                notFound.AddRange(fieldChanges.Select(c => c.FieldPath));
                continue;
            }

            // Copy-as-override of a placed ref into a plugin that doesn't have it yet: the ref isn't
            // in `mod`, so materialise it first — resolve the winner and pull it in as an override
            // (parent cell + deep-copied ref), then apply the staged field edits onto it.
            var record = mod.EnumerateMajorRecords().OfType<IMajorRecord>().FirstOrDefault(r => r.FormKey == formKey)
                ?? TryMaterializePlacedCopy(mod, ctx, group, formKey);
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
        PlacedWriteContext ctx,
        List<string> applied,
        List<string> notFound)
    {
        foreach (var group in byFormKey)
        {
            var deleteChange = group.FirstOrDefault(c => c.ChangeType == PendingChangeConstants.DeleteChangeType);
            if (deleteChange == null) continue;

            if (TryDelete(mod, schemas, ctx, deleteChange, group.Key) == ApplyOutcome.Applied)
                applied.Add(deleteChange.FieldPath);
            else
                notFound.Add(deleteChange.FieldPath);
        }
    }

    private static ApplyOutcome TryDelete(
        IMod mod, IReadOnlyDictionary<string, RecordTableSchema> schemas,
        PlacedWriteContext ctx, PendingChange change, string formKeyStr)
    {
        if (!FormKey.TryFactory(formKeyStr, out var formKey))
            return ApplyOutcome.NotFound;

        // Placed records (refr/achr) have no top-level group; remove them from their parent cell's
        // Persistent/Temporary list (pulling the cell in as an override) rather than via schema.Remove.
        if (change.ParentCell != null)
            return TryDeletePlaced(mod, ctx, change, formKey);

        if (!schemas.TryGetValue(change.RecordType, out var schema) || schema.Remove == null)
            return ApplyOutcome.NotFound;

        return schema.Remove(mod, formKey) ? ApplyOutcome.Applied : ApplyOutcome.NotFound;
    }

    // Cell-aware delete for a placed record: pull the parent cell into `mod` as an override and remove
    // the placed ref from its Persistent/Temporary list. Game-agnostic via ResolveWinnerAsOverride.
    private static ApplyOutcome TryDeletePlaced(
        IMod mod, PlacedWriteContext ctx, PendingChange change, FormKey formKey)
    {
        if (ctx.LinkCache == null) return ApplyOutcome.NotFound;
        if (!FormKey.TryFactory(change.ParentCell!, out var cellFormKey)) return ApplyOutcome.NotFound;

        var cell = ResolveWinnerAsOverride(mod, ctx.LinkCache, cellFormKey);
        if (cell == null) return ApplyOutcome.NotFound;

        return RemoveFromPlacementGroup(cell, change.PlacementGroup, formKey)
            ? ApplyOutcome.Applied
            : ApplyOutcome.NotFound;
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
