using MEditService.Core.Queries;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Schema;

internal sealed record ColumnInfoResult(
    string DuckDbType,
    string ApiType,
    string[] ValidFormKeyTypes,
    IReadOnlyList<EnumMember> EnumMembers,
    LeafWrite<IMajorRecord> Apply,
    FieldMetadata? ElementMeta = null,
    IReadOnlyList<FieldMetadata>? SubFieldMetas = null,
    bool AllowsNull = false,
    string? ViewDefaultLiteral = null,
    IReadOnlyList<string>? KeyMembers = null,
    string? LeafTypeName = null,
    object? Default = null);
