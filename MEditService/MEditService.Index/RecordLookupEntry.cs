using MEditService.Codec.Schema;

namespace MEditService.Index;

// One row's worth of the global form_key -> (record type, EditorID) lookup, one per
// record so resolution is O(1).
internal readonly record struct RecordLookupEntry(string RecordType, string? EditorId)
{
    /// <summary><paramref name="lookup"/> in the kernel's words, as the codec's checks ask it.</summary>
    public static Func<string, ResolvedFormKey?> Resolver(Func<string, RecordLookupEntry?> lookup) =>
        formKey => lookup(formKey) is { } entry ? new ResolvedFormKey(entry.RecordType, entry.EditorId) : null;
}
