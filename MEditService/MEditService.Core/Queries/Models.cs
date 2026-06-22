using MEditService.Core.Session;

namespace MEditService.Core.Queries;

public record PluginResponse(
    string Name,
    string Path,
    int LoadOrderIndex,
    bool IsLight,
    bool IsMaster,
    IReadOnlyList<string> Masters,
    int RecordCount,
    bool IsImmutable)
{
    public static PluginResponse FromMetadata(PluginMetadata m) =>
        new(m.Name, m.Path, m.LoadOrderIndex, m.IsLight, m.IsMaster, m.Masters, m.RecordCount, m.IsImmutable);
}

public record RecordSummary(
    string FormKey,
    string Plugin,
    int LoadOrderIndex,
    bool IsWinner,
    string? EditorId);

public record PagedResult<T>(IReadOnlyList<T> Items, int Total);

public record FieldMetadata(
    string Name,
    string Type,
    bool IsArray,
    IReadOnlyList<string> ValidFormKeyTypes,
    IReadOnlyList<string> EnumValues,
    FieldMetadata? ElementType = null,          // for 'array': element schema
    IReadOnlyList<FieldMetadata>? Fields = null, // for 'struct': sub-field schemas
    bool IsSortable = false,                     // true when element is a pure FormLink
    bool AllowsNull = false,                     // for 'formKey': true when the Mutagen type is IFormLinkNullable<T>
    bool IsBitmask = false,                      // for 'enum': true when the C# enum has [Flags]
    IReadOnlyList<string>? EnumBitValues = null); // for 'enum' + IsBitmask: decimal string bit values aligned with EnumValues

// Value contract: a bitmask field (Metadata.IsBitmask) carries its combined flags as a decimal
// string, not a number — so values above 2^53 survive JSON round-tripping without IEEE 754 loss.
public record FieldValue(FieldMetadata Metadata, object? Value, string? CheckError = null);

public record RecordDetail(
    string FormKey,
    string Plugin,
    int LoadOrderIndex,
    bool IsWinner,
    string? EditorId,
    IReadOnlyList<FieldValue> Fields,
    Dictionary<string, object?>? PendingFields = null);

public record CompareOverride(
    string FormKey,
    string Plugin,
    int LoadOrderIndex,
    bool IsWinner,
    string? EditorId,
    IReadOnlyList<FieldValue> Fields,
    Dictionary<string, object?>? PendingFields,
    ConflictThis ConflictThis)
    : RecordDetail(FormKey, Plugin, LoadOrderIndex, IsWinner, EditorId, Fields, PendingFields);

public record FieldDiff(
    string FieldName,
    Dictionary<string, object?> Values,
    string WinnerPlugin,
    object? WinnerValue,
    IReadOnlyDictionary<string, ConflictThis> CellStates,
    IReadOnlyList<FieldDiff>? Children = null);

public record ClassifyResult(
    ConflictAll ConflictAll,
    IReadOnlyDictionary<string, ConflictThis> PluginStates,
    IReadOnlyList<FieldDiff> Diffs);

// VMAD aligned diff — mirrors FieldDiff so the frontend reuses the same per-plugin cell + CellStates rendering.
public record VmadPropertyDiff(
    string Name,                                       // sort key = propertyName / member name / "[i]"
    string Kind,                                       // "scalar"|"object"|"array"|"struct"|"structList"|"variable"
    Dictionary<string, object?> Values,                // per-plugin leaf value (scalar / "FormKey [Alias]" / null when absent or has children)
    Dictionary<string, string> Types,                  // per-plugin property Type (types differing across plugins → a conflict)
    string WinnerPlugin,
    IReadOnlyDictionary<string, ConflictThis> CellStates,
    IReadOnlyList<VmadPropertyDiff>? Children);        // struct members (by name) / array elements (by index), aligned & recursive

public record VmadScriptDiff(
    string Name,                                       // sort key = ScriptName
    Dictionary<string, string?> Flags,                 // per-plugin script flags; null = script absent in that plugin
    string WinnerPlugin,
    IReadOnlyDictionary<string, ConflictThis> CellStates,
    IReadOnlyList<VmadPropertyDiff> Properties);

public record VmadCompare(IReadOnlyList<VmadScriptDiff> Scripts);

public record CompareResult(
    IReadOnlyList<CompareOverride> Overrides,
    IReadOnlyList<FieldDiff> Diffs,
    ConflictAll ConflictAll,
    VmadCompare? Vmad = null);

public record PluginRecordTypeCount(string Type, int Count);

public record SessionFilterRequest(string Sql);
public record SessionFilterResponse(string? Sql);

public record ReferenceResult(string FormKey, string Plugin, string FieldPath, string RecordType, string? EditorId);

public record CreateRecordResult(string FormKey, Guid GroupId);

public record BlockedReference(
    string TargetFormKey,
    string SourceFormKey,
    string SourcePlugin,
    string FieldPath,
    string RecordType,
    string? EditorId);

public record DeleteRecordTarget(string FormKey, string Plugin);

public record DeleteRecordsRequest(IReadOnlyList<DeleteRecordTarget> Records);
