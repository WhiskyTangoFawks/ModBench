using Mutagen.Bethesda;

namespace MEditService.Index;

/// <summary>Queries' own two verbs on the derived store (target-architecture.d2 medit_core.queries):
/// set and clear the record filter, and rebuild the index. Every member has a caller in
/// <c>MEditService.Queries</c>.</summary>
public interface IIndexMaintenance : IQueryIndex
{
    /// <summary>Throws <see cref="ArgumentException"/> if the SQL does not return a form_key column.</summary>
    void SetFilter(string sql, string source);

    void ClearFilter();

    /// <summary>ADR-0009 invariant 5: drops the index file and re-derives it against the load order
    /// held, as a cold load does.</summary>
    Task RebuildStore(GameRelease gameRelease, string instanceRoot);
}
