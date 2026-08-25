using MEditService.Core.Schema;
using Mutagen.Bethesda;

namespace MEditService.Core.Records;

/// <summary>#421's replacement for the deleted <c>IRecordRepositoryFactory</c>.</summary>
public interface IRecordIndexFactory
{
    IRecordIndex Create(GameRelease gameRelease);

    /// <summary>The same reflector every <see cref="Create"/>d index reads its schema from (#463) —
    /// exposed so a caller that needs a record's schema-table spelling outside the index itself
    /// (<c>SourceIngest.ReconcileHead</c>'s structural fallback, via <c>SourceRecordType.Resolve</c>)
    /// reuses the exact instance already built for this session rather than constructing and caching a
    /// second one.</summary>
    ISchemaReflector SchemaReflector { get; }
}
