using Mutagen.Bethesda.Plugins;

namespace MEditService.Codec.Schema;

/// <summary>A FormKey's one identity: Mutagen's parse, written back. Text may delimit it with either `:`
/// or `_`, and one record must not hold two keys.</summary>
public static class CanonicalFormKey
{
    public static string? Of(string text) => FormKey.TryFactory(text, out var parsed) ? parsed.ToString() : null;

    public static string OfOrAsWritten(string text) => Of(text) ?? text;
}
