using System.Text.Json;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Schema;

public sealed record ColumnSpec(
    string Name,
    string PropertyName,
    string DuckDbType,
    Func<IMajorRecordGetter, object?> Extract,
    string ApiType,
    string[] ValidFormKeyTypes,
    string[] EnumValues,
    Action<IMajorRecord, JsonElement>? Apply);

public sealed class RecordTableSchema
{
    public required string TableName { get; init; }
    public required Type RecordType { get; init; }
    public required IReadOnlyList<ColumnSpec> RecordColumns { get; init; }
}
