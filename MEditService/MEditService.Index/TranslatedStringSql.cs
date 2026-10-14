namespace MEditService.Index;

/// <summary>The codec writes a translated string as <c>{TargetLanguage, Value}</c>, or as
/// <c>{TargetLanguage, Values: [{Language, String}]}</c> when its strings hold several languages. A text shows in the
/// strings language the load order names, not the one it was written in.</summary>
internal static class TranslatedStringSql
{
    internal static string Resolved(string body, string path) => $"""
        COALESCE(
            json_extract_string({body}, '{path}.Value'),
            list_extract(
                json_extract_string({body}, '{path}.Values[*].String'),
                list_position(
                    json_extract_string({body}, '{path}.Values[*].Language'),
                    (SELECT language FROM {TableDdlBuilder.StringsLanguageRelation}))))
        """;
}
