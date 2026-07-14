using System.Text.Json;
using MEditService.Core.Queries;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Schema;

public sealed record ColumnSpec(
    string Name,
    string PropertyName,
    string DuckDbType,
    Func<IMajorRecordGetter, object?> Extract,
    string ApiType,
    IReadOnlyList<string> ValidFormKeyTypes,
    IReadOnlyList<string> EnumValues,
    Action<IMajorRecord, JsonElement>? Apply,
    bool IsArray = false,
    FieldMetadata? ElementType = null,
    IReadOnlyList<FieldMetadata>? SubFields = null,
    bool AllowsNull = false,
    bool IsBitmask = false,
    IReadOnlyList<string>? EnumBitValues = null)
{
    public FieldMetadata ToFieldMetadata() =>
        new(Name, ApiType, IsArray, ValidFormKeyTypes, EnumValues, ElementType, SubFields,
            AllowsNull: AllowsNull, IsBitmask: IsBitmask, EnumBitValues: EnumBitValues);
}

public sealed class RecordTableSchema
{
    public required string TableName { get; init; }
    public required Type RecordType { get; init; }
    public required IReadOnlyList<ColumnSpec> RecordColumns { get; init; }

    /// <summary>
    /// Adds a new blank record with the given FormKey to the correct group on <paramref name="mod"/>.
    /// Null when the group property could not be resolved via reflection.
    /// </summary>
    public Action<IMod, FormKey>? AddNew { get; init; }

    /// <summary>
    /// Removes the record with the given FormKey from the correct group on <paramref name="mod"/>.
    /// Returns true when removed, false when not found. Null when the group property could not be resolved via reflection.
    /// </summary>
    public Func<IMod, FormKey, bool>? Remove { get; init; }

    /// <summary>
    /// Adds an already-constructed record to the correct group on <paramref name="mod"/>.
    /// Null when the group property could not be resolved via reflection.
    /// </summary>
    public Action<IMod, IMajorRecord>? AddExisting { get; init; }

    /// <summary>
    /// Per-plugin column extractors for the synthetic "header" table only (null for every
    /// other schema). A mod header is never an <see cref="IMajorRecordGetter"/>, so
    /// <see cref="ColumnSpec.Extract"/> is structurally unusable for it — this is the real
    /// extraction path, positionally aligned with <see cref="RecordColumns"/>, invoked once per
    /// plugin against the mod itself rather than per-record.
    /// </summary>
    public IReadOnlyList<Func<IModGetter, object?>>? HeaderColumnExtract { get; init; }
}
