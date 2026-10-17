using System.Text.Json;
using System.Text.Json.Nodes;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Strings;

namespace MEditService.Codec.Serialization;

/// <summary>Mutagen writes a translated string's languages in the order its lookup found their strings
/// files, which an archive and a folder list differently. A source lists them in one order (ADR-0006).</summary>
public static class TranslatedStringValues
{
    /// <summary><paramref name="json"/> with each translated string's languages in <see cref="Language"/>
    /// order, every other byte as it was.</summary>
    public static byte[] InLanguageOrder(byte[] json)
    {
        if (json.AsSpan().IndexOf("\"TargetLanguage\""u8) < 0) return json;

        var ordered = (byte[])json.Clone();
        var reader = new Utf8JsonReader(json);
        while (reader.Read())
        {
            if (reader.TokenType == JsonTokenType.PropertyName && reader.ValueTextEquals("TargetLanguage"u8)
                && reader.Read() && reader.Read()
                && reader.TokenType == JsonTokenType.PropertyName && reader.ValueTextEquals("Values"u8)
                && reader.Read() && reader.TokenType == JsonTokenType.StartArray)
                Reorder(json, ordered, Elements(ref reader));
        }
        return ordered;
    }

    /// <summary>The document as a plugin that is not localized holds it, and the paths of the translated
    /// strings that have no text in the strings language, which stay as they were.</summary>
    public readonly record struct InLanguageResult(string Text, IReadOnlyList<string> Unresolved);

    /// <summary>Each translated string as its <paramref name="language"/> text alone, as xEdit writes it into a
    /// plugin that is not localized.</summary>
    public static InLanguageResult InLanguage(string text, Language language, GameRelease release, string recordType)
    {
        var root = JsonNode.Parse(text) ?? throw new InvalidOperationException("Expected a record document.");
        var changed = false;
        var unresolved = new List<string>();
        foreach (var (path, translated) in TranslatedStrings(root, "").ToList())
        {
            var held = translated["Values"]?.AsArray()
                .FirstOrDefault(entry => entry?["Language"]?.GetValue<string>() == language.ToString());
            if (held?["String"] is not { } value)
            {
                unresolved.Add(path);
                continue;
            }
            translated.Remove("Values");
            translated["Value"] = value.DeepClone();
            changed = true;
        }
        return new InLanguageResult(changed ? RecordTextCodec.RoundTrip(root.ToJsonString(), release, recordType) : text, unresolved);
    }

    private static IEnumerable<(string Path, JsonObject Translated)> TranslatedStrings(JsonNode node, string path)
    {
        switch (node)
        {
            case JsonObject obj:
                if (obj.ContainsKey("TargetLanguage") && obj["Values"] is JsonArray) yield return (path, obj);
                foreach (var (name, child) in obj)
                {
                    if (child is null) continue;
                    foreach (var found in TranslatedStrings(child, path.Length == 0 ? name : $"{path}.{name}")) yield return found;
                }
                break;
            case JsonArray array:
                for (var i = 0; i < array.Count; i++)
                {
                    if (array[i] is not { } child) continue;
                    foreach (var found in TranslatedStrings(child, $"{path}[{i}]")) yield return found;
                }
                break;
        }
    }

    private static void Reorder(byte[] json, byte[] ordered, List<Element> elements)
    {
        var inOrder = elements.OrderBy(element => element.Language).ToList();
        var position = elements.FirstOrDefault().Start;
        for (var i = 0; i < elements.Count; i++)
        {
            position += Copy(json, inOrder[i].Start, inOrder[i].End, ordered, position);
            if (i + 1 < elements.Count) position += Copy(json, elements[i].End, elements[i + 1].Start, ordered, position);
        }
    }

    private static int Copy(byte[] from, int start, int end, byte[] to, int at)
    {
        from.AsSpan(start, end - start).CopyTo(to.AsSpan(at));
        return end - start;
    }

    private static List<Element> Elements(ref Utf8JsonReader reader)
    {
        var elements = new List<Element>();
        while (reader.Read() && reader.TokenType == JsonTokenType.StartObject)
        {
            var start = (int)reader.TokenStartIndex;
            var language = int.MaxValue;
            while (reader.Read() && reader.TokenType == JsonTokenType.PropertyName)
            {
                var isLanguage = reader.ValueTextEquals("Language"u8);
                reader.Read();
                if (isLanguage && Enum.TryParse<Language>(reader.GetString(), out var named)) language = (int)named;
            }
            elements.Add(new Element(start, (int)reader.TokenStartIndex + 1, language));
        }
        return elements;
    }

    private readonly record struct Element(int Start, int End, int Language);
}
