namespace MEditService.Core.Records;

// ADR-0031: resolution is one batched pass per response, not a query per value. Wrapping the
// resolver once per response means each distinct FormKey is queried at most once however many
// FieldDiff leaves share it.
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
