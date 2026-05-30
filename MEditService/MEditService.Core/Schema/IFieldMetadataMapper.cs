using MEditService.Core.Queries;

namespace MEditService.Core.Schema;

public interface IFieldMetadataMapper
{
    FieldMetadata Map(ColumnSpec column);
}
