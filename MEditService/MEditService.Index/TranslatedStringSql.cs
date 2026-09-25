namespace MEditService.Index;

/// <summary>The codec writes a translated string as <c>{TargetLanguage, Value}</c>, or as
/// <c>{TargetLanguage, Values: [{Language, String}]}</c> when its strings hold several languages.</summary>
internal static class TranslatedStringSql
{
    internal static string Resolved(string body, string path) => $"""
        COALESCE(
            json_extract_string({body}, '{path}.Value'),
            json_extract_string(list_filter(
                CAST(json_extract({body}, '{path}.Values') AS JSON[]),
                lambda entry: json_extract_string(entry, '$.Language')
                    = json_extract_string({body}, '{path}.TargetLanguage'))[1], '$.String'))
        """;
}
