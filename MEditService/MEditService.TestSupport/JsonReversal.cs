using System.Text.Json;
using System.Text.Json.Nodes;

namespace MEditService.TestSupport;

public static class JsonReversal
{
    /// <summary><paramref name="text"/> with the array <paramref name="list"/> picks out of its root in reverse order, indented.</summary>
    public static string WithReversed(string text, Func<JsonObject, JsonArray> list)
    {
        var root = JsonNode.Parse(text).Require().AsObject();
        var array = list(root);
        var reversed = array.Select(item => item?.DeepClone()).Reverse().ToList();
        array.Clear();
        foreach (var item in reversed) array.Add(item);
        return root.ToJsonString(new JsonSerializerOptions { WriteIndented = true });
    }
}
