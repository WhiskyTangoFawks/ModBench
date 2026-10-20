namespace MEditService.RecordIndex;

/// <summary>The store in force, handed to one write inside the write gate and the scope. A ref struct, so the
/// write cannot keep it past the call, where a write may race it or a reconcile close it.</summary>
internal readonly ref struct GatedStore(Store store, IndexScope scope)
{
    public IndexScope Scope => scope;

    /// <summary>Why the SQL cannot be a filter, or null once it is materialized; null clears it.</summary>
    public string? SetFilter(string? sql) => store.Filter.Set(sql);

    public void CreateRecordTypeViews() => store.CreateRecordTypeViews();
}
