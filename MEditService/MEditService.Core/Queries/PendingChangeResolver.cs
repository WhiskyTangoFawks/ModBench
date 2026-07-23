using MEditService.Core.Edits;
using MEditService.Core.Records;
using MEditService.Core.Schema;

namespace MEditService.Core.Queries;

// ADR-0031: resolves every FormKey-typed value inside a PendingChange.NewValue against the O(1)
// form_lookup, mirroring FieldDiff's per-leaf treatment — the compare/changes surfaces' pending
// column and the Pending Changes tree both need this to render a hyperlink for a staged value that
// hasn't been saved yet.
public static class PendingChangeResolver
{
    public static PendingChange Resolve(
        PendingChange change,
        IReadOnlyDictionary<string, RecordTableSchema> schemas,
        Func<string, RecordLookupEntry?> resolveFormKey)
    {
        var withIdentity = change with { RecordResolution = FormKeyResolution.From(resolveFormKey(change.FormKey), []) };
        return VmadPath.IsVmadPath(change.FieldPath)
            ? ResolveVmad(withIdentity, resolveFormKey)
            : ResolveField(withIdentity, schemas, resolveFormKey);
    }

    private static PendingChange ResolveField(
        PendingChange change,
        IReadOnlyDictionary<string, RecordTableSchema> schemas,
        Func<string, RecordLookupEntry?> resolveFormKey)
    {
        if (!schemas.TryGetValue(change.RecordType, out var schema)) return change;

        var col = schema.RecordColumns.FirstOrDefault(c => c.Name == change.FieldPath);
        if (col == null) return change;

        var meta = col.ToFieldMetadata();
        var resolutions = new Dictionary<string, FormKeyResolution>();
        FormRefPathBuilder.Walk(meta, (object?)change.NewValue, "",
            (path, raw, _, validTypes) =>
            {
                if (string.IsNullOrEmpty(raw) || raw == "Null") return;
                resolutions[path] = FormKeyResolution.From(resolveFormKey(raw), validTypes);
            });

        return resolutions.Count == 0 ? change : change with { Resolutions = resolutions };
    }

    // VMAD Object/ArrayOfObject-kind staged values reference ordinary major records, resolved
    // through the same lookup as slice 5's VmadConflictClassifier — no expected-type list exists at
    // this layer (no Papyrus-declared type to compare against), so every resolved Object is
    // ResolvedValidType, never ResolvedWrongType (mirrors VmadConflictClassifier.BuildResolutions).
    // Struct/ArrayOfStruct-shaped VMAD values yield nothing here — VmadCodec.ValueFormKeysWithPaths
    // doesn't walk into them today; that's a pre-existing gap (same one form_references/
    // ExtractVmadValueRefs already has), not something this method regresses.
    private static PendingChange ResolveVmad(PendingChange change, Func<string, RecordLookupEntry?> resolveFormKey)
    {
        var resolutions = VmadCodec.ValueFormKeysWithPaths(change.NewValue)
            .ToDictionary(p => p.Path, p => FormKeyResolution.From(resolveFormKey(p.FormKey), []));

        return resolutions.Count == 0 ? change : change with { Resolutions = resolutions };
    }

    public static IReadOnlyList<PendingChange> ResolveAll(
        IReadOnlyList<PendingChange> changes,
        IReadOnlyDictionary<string, RecordTableSchema> schemas,
        Func<string, RecordLookupEntry?> resolveFormKey) =>
        [.. changes.Select(c => Resolve(c, schemas, resolveFormKey))];
}
