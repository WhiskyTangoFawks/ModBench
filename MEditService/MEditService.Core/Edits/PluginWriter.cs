using System.Globalization;
using System.Reflection;
using System.Text.Json;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Binary.Parameters;
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

public sealed class PluginWriter(ISchemaReflector schemaReflector, ILogger<PluginWriter> logger) : IPluginWriter
{
    private const int MaxBackups = 5;

    private readonly ISchemaReflector _schemaReflector = schemaReflector;
    private readonly ILogger<PluginWriter> _logger = logger;

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

        var results = new ApplyResults();
        var createFailed = new List<string>();

        var placedCtx = new PlacedWriteContext(gameRelease, linkCache);
        ApplyCreateChanges(byFormKey, mod, schemas, placedCtx, results, createFailed);
        ApplyFieldChanges(byFormKey, mod, schemas, placedCtx, results);
        ApplyHeaderChanges(byFormKey, mod, schemas, results);
        ApplyDeleteChanges(byFormKey, mod, schemas, placedCtx, results);
        ApplyRenumberChanges(byFormKey, mod, schemas, results);

        var dir = Path.GetDirectoryName(pluginPath)!;
        var tmpDir = Path.Combine(dir, ".medit_tmp_" + Path.GetRandomFileName());
        var tmpPath = Path.Combine(tmpDir, Path.GetFileName(pluginPath));
        Directory.CreateDirectory(tmpDir);

        var writeBuilder = mod.BeginWrite
            .ToPath(tmpPath)
            .WithLoadOrderFromHeaderMasters()
            .WithNoDataFolder();

        // Issue #86: Mutagen's default MastersListContentOption.Iterate recomputes the written
        // masters list purely from FormLink/override content, discarding any declared master with
        // no referencing content yet — which would silently drop a just-staged "Add Master" (the
        // whole point of which is to pre-declare a master before content references it). Scoped to
        // only saves that actually staged a masters edit, so every other save keeps today's
        // content-derived master sync untouched.
        if (HasMastersEdit(changes))
            writeBuilder = writeBuilder.WithMastersListContent(MastersListContentOption.NoCheck);

        await writeBuilder.WriteAsync();

        return new PreparedPluginSave(tmpPath, pluginPath,
            new SaveResult(backupPath, results.Applied, results.ReadOnly, results.NotFound, createFailed));
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

    // Issue #86: does this save include a staged edit to the header's masters field? Used to scope
    // the MastersListContentOption.NoCheck override to only the saves that need it.
    private static bool HasMastersEdit(IReadOnlyList<PendingChange> changes) =>
        changes.Any(c =>
            c.RecordType == Records.HeaderIndexer.TableName &&
            c.FieldPath == Records.HeaderIndexer.MastersFieldName &&
            c.ChangeType == PendingChangeConstants.FieldEditChangeType);

    public bool IsReadOnly(GameRelease release, string recordType, string fieldPath)
    {
        if (VmadPath.IsVmadPath(fieldPath)) return false;
        if (ConditionPath.IsConditionPath(fieldPath))
        {
            // #181: a nested (per-array-item) condition path — composed FieldPath contains '[',
            // e.g. "Effects[0].Conditions" — stays read-only this slice; there's no write path for
            // it yet (scalar editing lands in #182). Reject here at stage time rather than accept
            // and only fail later at save (Fallout4ConditionCodec.ApplyFieldValue's
            // record.GetType().GetProperty returns null for a composed path). A malformed CTDA path
            // fails closed the same way.
            return !ConditionPath.TryParse(fieldPath, out var conditionFieldPath, out _, out _)
                || conditionFieldPath.Contains('[');
        }
        var schemas = _schemaReflector.GetSchemas(release);
        if (!schemas.TryGetValue(recordType, out var schema)) return true;

        // #154: any of the record's condition-owning fields (not just a hardcoded "Conditions")
        // is always editable via the whole-list-restage path — recognized by asking this game's
        // codec whether recordType actually has a condition-list property named fieldPath.
        if (ConditionCodecRegistry.For(release.ToCategory()) is { } codec
            && codec.IsConditionListField(schema.RecordType, fieldPath))
        {
            return false;
        }

        // The header's columns are written via HeaderColumnApply (ModHeader isn't an IMajorRecord,
        // so ColumnSpec.Apply is always null for it) — resolve editability from that list instead.
        if (schema.HeaderColumnApply is { } headerApply)
        {
            var idx = HeaderColumnIndex(schema, fieldPath);
            return idx < 0 || headerApply[idx] == null;
        }

        var col = schema.RecordColumns.FirstOrDefault(c => c.Name == fieldPath);
        return col?.Apply == null;
    }

    private static int HeaderColumnIndex(RecordTableSchema schema, string fieldPath)
    {
        for (var i = 0; i < schema.RecordColumns.Count; i++)
            if (schema.RecordColumns[i].Name == fieldPath) return i;
        return -1;
    }

    // Carries the release + link cache needed by the cell-aware placed-record write paths
    // (create/copy/delete) without breaking the parameter budget on the Apply methods.
    private readonly record struct PlacedWriteContext(GameRelease Release, ILinkCache? LinkCache);

    private static void ApplyCreateChanges(
        IEnumerable<IGrouping<string, PendingChange>> byFormKey,
        IMod mod,
        IReadOnlyDictionary<string, RecordTableSchema> schemas,
        PlacedWriteContext ctx,
        ApplyResults results,
        List<string> createFailed)
    {
        foreach (var group in byFormKey)
        {
            var createChange = group.FirstOrDefault(c => c.ChangeType == PendingChangeConstants.CreateChangeType);
            if (createChange == null) continue;

            if (!FormKey.TryFactory(group.Key, out var formKey))
            {
                results.NotFound.Add(createChange.FieldPath);
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
                    case ApplyOutcome.Applied: results.Applied.Add(createChange.FieldPath); break;
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
            results.Applied.Add(createChange.FieldPath);
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
        var applied = cell != null && AddToPlacementGroup(cell, createChange.PlacementGroup, placed);
        return applied ? ApplyOutcome.Applied : ApplyOutcome.NotFound;
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
        {
            if (list[i] is IMajorRecordGetter rec && rec.FormKey == formKey)
            {
                list.RemoveAt(i);
                return true;
            }
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
        return copyChange == null ? null : ResolveWinnerAsOverride(mod, ctx.LinkCache, formKey);
    }

    private static void ApplyFieldChanges(
        IEnumerable<IGrouping<string, PendingChange>> byFormKey,
        IMod mod,
        IReadOnlyDictionary<string, RecordTableSchema> schemas,
        PlacedWriteContext ctx,
        ApplyResults results)
    {
        foreach (var group in byFormKey)
        {
            // Header field edits are applied to mod.ModHeader by ApplyHeaderChanges — the header
            // is not an IMajorRecord, so it would never be found by the record lookup below.
            var fieldChanges = group.Where(c =>
                (c.ChangeType == PendingChangeConstants.FieldEditChangeType ||
                 c.ChangeType == PendingChangeConstants.VmadStructOpChangeType) &&
                c.RecordType != Records.HeaderIndexer.TableName).ToList();
            if (fieldChanges.Count == 0) continue;

            if (!FormKey.TryFactory(group.Key, out var formKey))
            {
                results.NotFound.AddRange(fieldChanges.Select(c => c.FieldPath));
                continue;
            }

            // Copy-as-override of a placed ref into a plugin that doesn't have it yet: the ref isn't
            // in `mod`, so materialise it first — resolve the winner and pull it in as an override
            // (parent cell + deep-copied ref), then apply the staged field edits onto it.
            var record = mod.EnumerateMajorRecords().OfType<IMajorRecord>().FirstOrDefault(r => r.FormKey == formKey)
                ?? TryMaterializePlacedCopy(mod, ctx, group, formKey);
            if (record == null)
            {
                results.NotFound.AddRange(fieldChanges.Select(c => c.FieldPath));
                continue;
            }

            foreach (var change in OrderForConditionListRestage(fieldChanges))
                results.Record(TryApplyField(record, change, schemas, ctx.Release), change.FieldPath);
        }
    }

    // #153 Q3 ordering guarantee: a condition-owner whole-list restage (e.g. "Conditions") must
    // apply before any CTDA\<fieldPath>\N\... per-field edit on the same record, since a per-field
    // edit staged *after* an add (targeting the newly-added index) is only valid once the restage
    // has run. A stable sort — not reliance on incidental enumeration order — makes this hold
    // regardless of which order the two pending changes happen to have been staged/enumerated in.
    private static IEnumerable<PendingChange> OrderForConditionListRestage(List<PendingChange> fieldChanges) =>
        fieldChanges.OrderBy(c => ConditionPath.IsConditionPath(c.FieldPath) ? 1 : 0);

    // Applies header field edits (author/flags) onto mod.ModHeader via the schema's
    // HeaderColumnApply delegates. A null delegate (e.g. masters) is read-only.
    private static void ApplyHeaderChanges(
        IEnumerable<IGrouping<string, PendingChange>> byFormKey,
        IMod mod,
        IReadOnlyDictionary<string, RecordTableSchema> schemas,
        ApplyResults results)
    {
        foreach (var group in byFormKey)
        {
            foreach (var change in group.Where(c =>
                c.ChangeType == PendingChangeConstants.FieldEditChangeType &&
                c.RecordType == Records.HeaderIndexer.TableName))
            {
                results.Record(TryApplyHeaderField(mod, change, schemas), change.FieldPath);
            }
        }
    }

    private static ApplyOutcome TryApplyHeaderField(
        IMod mod, PendingChange change, IReadOnlyDictionary<string, RecordTableSchema> schemas)
    {
        if (!schemas.TryGetValue(change.RecordType, out var schema) || schema.HeaderColumnApply == null)
            return ApplyOutcome.NotFound;

        var idx = HeaderColumnIndex(schema, change.FieldPath);
        if (idx < 0) return ApplyOutcome.NotFound;

        var apply = schema.HeaderColumnApply[idx];
        if (apply == null) return ApplyOutcome.ReadOnly;
        apply(mod, change.NewValue);
        return ApplyOutcome.Applied;
    }

    private static void ApplyDeleteChanges(
        IEnumerable<IGrouping<string, PendingChange>> byFormKey,
        IMod mod,
        IReadOnlyDictionary<string, RecordTableSchema> schemas,
        PlacedWriteContext ctx,
        ApplyResults results)
    {
        foreach (var group in byFormKey)
        {
            var deleteChange = group.FirstOrDefault(c => c.ChangeType == PendingChangeConstants.DeleteChangeType);
            if (deleteChange == null) continue;

            results.Record(TryDelete(mod, schemas, ctx, deleteChange, group.Key), deleteChange.FieldPath);
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

        var applied = schemas.TryGetValue(change.RecordType, out var schema)
            && schema.Remove != null
            && schema.Remove(mod, formKey);
        return applied ? ApplyOutcome.Applied : ApplyOutcome.NotFound;
    }

    // Cell-aware delete for a placed record: pull the parent cell into `mod` as an override and remove
    // the placed ref from its Persistent/Temporary list. Game-agnostic via ResolveWinnerAsOverride.
    private static ApplyOutcome TryDeletePlaced(
        IMod mod, PlacedWriteContext ctx, PendingChange change, FormKey formKey)
    {
        if (ctx.LinkCache == null) return ApplyOutcome.NotFound;
        if (!FormKey.TryFactory(change.ParentCell!, out var cellFormKey)) return ApplyOutcome.NotFound;

        var cell = ResolveWinnerAsOverride(mod, ctx.LinkCache, cellFormKey);
        var applied = cell != null && RemoveFromPlacementGroup(cell, change.PlacementGroup, formKey);
        return applied ? ApplyOutcome.Applied : ApplyOutcome.NotFound;
    }

    private static void ApplyRenumberChanges(
        IEnumerable<IGrouping<string, PendingChange>> byFormKey,
        IMod mod,
        IReadOnlyDictionary<string, RecordTableSchema> schemas,
        ApplyResults results)
    {
        var allMappings = new Dictionary<FormKey, FormKey>();

        foreach (var group in byFormKey)
        {
            var renumberChange = group.FirstOrDefault(c => c.ChangeType == PendingChangeConstants.RenumberChangeType);
            if (renumberChange == null) continue;

            if (TryRenumberRecord(mod, schemas, renumberChange, allMappings))
                results.Applied.Add(renumberChange.FieldPath);
            else
                results.NotFound.Add(renumberChange.FieldPath);
        }

        // Single pass: remap all intra-plugin FormLinks across all renumber operations.
        // IMod.RemapLinks() is an explicit interface impl on AMod that throws; iterate
        // records directly so each concrete type's public override is dispatched.
        if (allMappings.Count > 0)
        {
            foreach (var rec in mod.EnumerateMajorRecords())
                rec.RemapLinks(allMappings);
        }
    }

    private static bool TryRenumberRecord(
        IMod mod, IReadOnlyDictionary<string, RecordTableSchema> schemas,
        PendingChange renumberChange, Dictionary<FormKey, FormKey> allMappings)
    {
        if (!FormKey.TryFactory(renumberChange.OldValue.GetString()!, out var oldFormKey) ||
            !FormKey.TryFactory(renumberChange.NewValue.GetString()!, out var newFormKey))
        {
            return false;
        }

        if (!schemas.TryGetValue(renumberChange.RecordType, out var schema) ||
            schema.AddExisting == null || schema.Remove == null)
        {
            return false;
        }

        var oldRecord = mod.EnumerateMajorRecords()
            .FirstOrDefault(r => r.FormKey == oldFormKey);
        if (oldRecord == null)
            return false;

        var newRecord = (IMajorRecord)oldRecord.Duplicate(newFormKey);
        schema.AddExisting(mod, newRecord);
        schema.Remove(mod, oldFormKey);
        allMappings[oldFormKey] = newFormKey;
        return true;
    }

    private enum ApplyOutcome { Applied, ReadOnly, NotFound }

    // Collects each change's outcome into the three SaveResult buckets, owning the
    // ApplyOutcome→bucket mapping in one place so the four Apply passes don't each
    // re-implement it. createFailed is tracked separately by the create pass — it records
    // a RecordType (the schema that couldn't be built), not a field path.
    private sealed class ApplyResults
    {
        public List<string> Applied { get; } = [];
        public List<string> ReadOnly { get; } = [];
        public List<string> NotFound { get; } = [];

        public void Record(ApplyOutcome outcome, string fieldPath)
        {
            switch (outcome)
            {
                case ApplyOutcome.Applied: Applied.Add(fieldPath); break;
                case ApplyOutcome.ReadOnly: ReadOnly.Add(fieldPath); break;
                case ApplyOutcome.NotFound: NotFound.Add(fieldPath); break;
            }
        }
    }

    private static ApplyOutcome TryApplyField(
        IMajorRecord record,
        PendingChange change,
        IReadOnlyDictionary<string, RecordTableSchema> schemas,
        GameRelease release)
    {
        if (change.ChangeType == PendingChangeConstants.VmadStructOpChangeType)
            return ApplyVmadStructOp(record, change);

        if (VmadPath.IsVmadPath(change.FieldPath))
            return ApplyVmadField(record, change);

        if (ConditionPath.IsConditionPath(change.FieldPath))
            return ApplyConditionField(record, change, release);

        // #154: dispatches on whichever of the record's actual condition-owning fields this is
        // (not just "Conditions") — an instance is on hand here, so the check reflects directly
        // off record.GetType() rather than needing the recordType-string/schema lookup PluginWriter
        // .IsReadOnly uses when it only has a type name.
        if (ConditionCodecRegistry.For(release.ToCategory()) is { } codec
            && codec.IsConditionListField(record.GetType(), change.FieldPath))
        {
            return ApplyConditionListField(record, change, release);
        }

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

    private static ApplyOutcome ApplyVmadField(IMajorRecord record, PendingChange change) =>
        record is IHaveVirtualMachineAdapter vmadRecord
            && VmadPath.TryParse(change.FieldPath, out var scriptName, out var propName)
            ? ToOutcome(VmadCodec.ApplyFieldValue(vmadRecord, scriptName, propName, change.NewValue))
            : ApplyOutcome.NotFound;

    private static ApplyOutcome ToOutcome(VmadApplyResult result) => result switch
    {
        VmadApplyResult.Applied => ApplyOutcome.Applied,
        VmadApplyResult.ReadOnly => ApplyOutcome.ReadOnly,
        _ => ApplyOutcome.NotFound,
    };

    private static ApplyOutcome ApplyConditionField(IMajorRecord record, PendingChange change, GameRelease release)
    {
        if (ConditionCodecRegistry.For(release.ToCategory()) is not { } codec)
            return ApplyOutcome.NotFound;
        if (!ConditionPath.TryParse(change.FieldPath, out var fieldPath, out var index, out var subField))
            return ApplyOutcome.NotFound;

        var result = codec.ApplyFieldValue(record, fieldPath, index, subField, change.NewValue);
        return result switch
        {
            ConditionApplyResult.Applied => ApplyOutcome.Applied,
            _ => ApplyOutcome.NotFound,
        };
    }

    // Whole-list restage (#153): change.FieldPath is the bare owning field name (e.g. "Conditions"),
    // change.NewValue the full ParsedCondition-shaped JSON array an add/remove/move staged.
    private static ApplyOutcome ApplyConditionListField(IMajorRecord record, PendingChange change, GameRelease release)
    {
        if (ConditionCodecRegistry.For(release.ToCategory()) is not { } codec)
            return ApplyOutcome.NotFound;

        var result = codec.ApplyListValue(record, change.FieldPath, change.NewValue);
        return result switch
        {
            ConditionApplyResult.Applied => ApplyOutcome.Applied,
            _ => ApplyOutcome.NotFound,
        };
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
        {
            return ApplyOutcome.NotFound;
        }

        // Route by path shape: "VMAD\<ScriptName>" is script-level, "VMAD\<ScriptName>\<Prop>" property-level.
        return true switch
        {
            _ when VmadPath.TryParseScript(change.FieldPath, out var scriptOnly)
                => ToOutcome(VmadCodec.ApplyScriptOp(vmadRecord, scriptOnly, opName, op)),
            _ when VmadPath.TryParse(change.FieldPath, out var scriptName, out var propName)
                => ToOutcome(VmadCodec.ApplyPropertyOp(vmadRecord, scriptName, propName, opName, op)),
            _ => ApplyOutcome.NotFound,
        };
    }

    // The timestamp resolves to sub-second because one user gesture now writes a plugin more than
    // once a second: saving is per change group, and since ADR-0028 a plugin's field edits are many
    // groups rather than one, so "Save All" runs several saves of the same plugin back to back.
    // At one-second resolution the second of those collided with the first's backup and threw,
    // failing the save. Sub-second keeps every backup — deliberately not File.Copy(overwrite: true),
    // which would destroy the earlier one, nor a uniquifying retry, which would silently mask a
    // genuine collision; CreateBackup_FileAlreadyExists_ThrowsIOException pins that throw.
    internal static string CreateBackup(string pluginPath, string? timestamp = null)
    {
        var dir = Path.GetDirectoryName(pluginPath)!;
        var name = Path.GetFileNameWithoutExtension(pluginPath);
        var ext = Path.GetExtension(pluginPath);
        var ts = timestamp ?? DateTime.UtcNow.ToString("yyyy-MM-ddTHH-mm-ss-fffffff", CultureInfo.InvariantCulture);
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
        {
            try { File.Delete(f); }
            catch (Exception ex) { _logger.LogWarning(ex, "Failed to delete old backup {File}", f); }
        }
    }
}
