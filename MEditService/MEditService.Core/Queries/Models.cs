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
    IReadOnlyList<string> EnumValues);

public record FieldValue(FieldMetadata Metadata, object? Value);

public record RecordDetail(
    string FormKey,
    string Plugin,
    int LoadOrderIndex,
    bool IsWinner,
    string? EditorId,
    IReadOnlyList<FieldValue> Fields,
    Dictionary<string, object?>? PendingFields = null);

public record FieldDiff(
    string FieldName,
    Dictionary<string, object?> Values,
    bool IsConflict,
    string WinnerPlugin,
    object? WinnerValue);

public record CompareResult(
    IReadOnlyList<RecordDetail> Overrides,
    IReadOnlyList<FieldDiff> Diffs);

public record PluginRecordTypeCount(string Type, int Count);
