using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Strings;

namespace MEditService.Codec.Serialization;

/// <summary>Mutagen writes a translated string's languages in the order its lookup found their strings
/// files, which an archive and a folder list differently. A source lists them in one order (ADR-0006).</summary>
public static class TranslatedStringValues
{
    public const string ApiType = "translatedString";

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
            translated["TargetLanguage"] = TranslatedString.DefaultLanguage.ToString();
            translated["Value"] = value.DeepClone();
            changed = true;
        }
        return new InLanguageResult(changed ? RecordTextCodec.RoundTrip(root.ToJsonString(), release, recordType) : text, unresolved);
    }

    /// <summary><paramref name="held"/> with <paramref name="text"/> as its text in <paramref name="language"/>, every
    /// other language as it was. A plugin that is not localized holds one text, which a read gives the default
    /// language.</summary>
    internal static JsonObject WithText(JsonObject? held, string text, Language language, bool localized)
    {
        var edited = held?.DeepClone().AsObject() ?? new JsonObject { ["TargetLanguage"] = (localized ? language : TranslatedString.DefaultLanguage).ToString() };
        if (!localized)
        {
            edited["TargetLanguage"] = TranslatedString.DefaultLanguage.ToString();
            edited["Value"] = text;
            return edited;
        }
        if (edited["Values"] is null && TargetLanguageOf(edited) == language)
        {
            edited["Value"] = text;
            return edited;
        }
        var values = edited["Values"] as JsonArray ?? OneLanguageAsValues(edited);
        if (values.OfType<JsonObject>().FirstOrDefault(entry => entry["Language"]?.GetValue<string>() == language.ToString()) is { } entry)
            entry["String"] = text;
        else
            values.Add(new JsonObject { ["Language"] = language.ToString(), ["String"] = text });
        return edited;
    }

    /// <summary>The members a translated string's document holds: one <c>Value</c> or the <c>Values</c> of each
    /// language. Only a localized plugin holds a language for <c>TargetLanguage</c> to name.</summary>
    internal static FieldMetadata ShapeOf(JsonObject held, bool localized, string? readOnlyReason)
    {
        static FieldMetadata Leaf(string name, string type, IReadOnlyList<EnumMember>? members = null, string? readOnlyReason = null) =>
            new(name, type, false, LeafSpec.NoFormKeyTypes, members ?? LeafSpec.NoEnumMembers, ReadOnlyReason: readOnlyReason);
        var languages = Enum.GetNames<Language>().Select(name => new EnumMember(name)).ToList();
        var perLanguage = new FieldMetadata(
            "", "struct", false, LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers,
            Fields: [Leaf("Language", "enum", languages), Leaf("String", "string")]);
        var fields = new List<FieldMetadata> { Leaf("TargetLanguage", "enum", languages, localized ? null : "the plugin is not localized, so it holds no language for a string") };
        fields.Add(held["Values"] is null
            ? Leaf("Value", "string")
            : new FieldMetadata("Values", "array", true, LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers, ElementType: perLanguage));
        var shape = new FieldMetadata(
            "", ApiType, false, LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers, Fields: fields);
        return readOnlyReason is null ? shape : shape.WithReadOnlyReason(readOnlyReason);
    }

    private static Language TargetLanguageOf(JsonObject translated) =>
        Enum.TryParse<Language>(translated["TargetLanguage"]?.GetValue<string>(), out var named) ? named : TranslatedString.DefaultLanguage;

    private static JsonArray OneLanguageAsValues(JsonObject translated)
    {
        var values = new JsonArray();
        if (translated["Value"] is { } one)
            values.Add(new JsonObject { ["Language"] = TargetLanguageOf(translated).ToString(), ["String"] = one.DeepClone() });
        translated.Remove("Value");
        translated["Values"] = values;
        return values;
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
