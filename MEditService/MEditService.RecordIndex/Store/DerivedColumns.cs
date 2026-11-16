using MEditService.Codec.Serialization;
using Mutagen.Bethesda.Strings;

namespace MEditService.RecordIndex.Store;

/// <summary>What a read takes from a record's document, derived once when the document is indexed (ADR-0005): the name the
/// strings language shows, and the base a placed reference names.</summary>
internal static class DerivedColumns
{
    internal readonly record struct Columns(string? FullName, string? Base);

    internal static Columns Of(Document document, Language language) =>
        new(document.TranslatedTextAt(language, "Name") is { Length: > 0 } name ? name : null, document.StringAt("Base"));
}
