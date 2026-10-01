using System.Text.Json;
using System.Text.Json.Serialization;

namespace MEditService.Http;

/// <summary>Reads a JSON null as the null element rather than as an absent value, so a request can
/// tell "clear this" from "no value given".</summary>
public sealed class KeepsJsonNullConverter : JsonConverter<JsonElement?>
{
    public override bool HandleNull => true;

    public override JsonElement? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
        JsonElement.ParseValue(ref reader);

    public override void Write(Utf8JsonWriter writer, JsonElement? value, JsonSerializerOptions options)
    {
        if (value is { } element) element.WriteTo(writer);
        else writer.WriteNullValue();
    }
}
