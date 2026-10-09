using System.Text.Json;

namespace MEditService.TestSupport;

public static class JsonStrings
{
    public static string Of(JsonElement element) =>
        element.GetString() ?? throw new InvalidOperationException("Expected a JSON string value.");
}
