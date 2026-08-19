namespace MEditService.Core.Records;

// ADR-0031: "resolution ... computed in one batched pass per GetCompare/GetChanges response ...
// not a query per value." A duplicate FormKey commonly recurs across sibling cells/plugins/leaves
// within one response (e.g. the same keyword referenced by two overrides) — wrapping the resolver
// once per response in this cache means each distinct FormKey is queried at most once, regardless
// of how many FieldDiff/VmadPropertyDiff leaves share it.
public static class FormKeyResolutionCache
{
    public static Func<string, RecordLookupEntry?> Memoize(Func<string, RecordLookupEntry?> resolve)
    {
        var cache = new Dictionary<string, RecordLookupEntry?>(StringComparer.Ordinal);
        return fk =>
        {
            if (cache.TryGetValue(fk, out var cached)) return cached;
            var resolved = resolve(fk);
            cache[fk] = resolved;
            return resolved;
        };
    }
}
