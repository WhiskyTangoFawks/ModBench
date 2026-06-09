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
    bool IsSortable = false);                    // true when element is a pure FormLink

public record FieldValue(FieldMetadata Metadata, object? Value);

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
    object? WinnerValue);

public record ClassifyResult(
    ConflictAll ConflictAll,
    IReadOnlyDictionary<string, ConflictThis> PluginStates,
    IReadOnlyList<FieldDiff> Diffs);

public record CompareResult(
    IReadOnlyList<CompareOverride> Overrides,
    IReadOnlyList<FieldDiff> Diffs,
    ConflictAll ConflictAll);

public record PluginRecordTypeCount(string Type, int Count);

public record SessionFilterRequest(string Sql);
public record SessionFilterResponse(string? Sql);
