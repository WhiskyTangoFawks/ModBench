using System.Text.Json;
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

    // Each element moves with its own bytes, and the separators between them stay where they were.
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
