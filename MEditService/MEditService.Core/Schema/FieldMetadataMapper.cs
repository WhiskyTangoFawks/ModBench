using MEditService.Core.Queries;

namespace MEditService.Core.Schema;

public sealed class FieldMetadataMapper : IFieldMetadataMapper
{
    public FieldMetadata Map(ColumnSpec column) =>
        new(column.Name, column.ApiType, false, column.ValidFormKeyTypes, column.EnumValues);
}
