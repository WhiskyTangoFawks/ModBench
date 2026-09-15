using System.Text.Json.Nodes;

namespace MEditService.Tests.TestSupport;

/// <summary>A copy of ConditionEditTests' own comparison, which the split put in a different
/// assembly: a test-only helper, not a production internal, so the duplication is the whole fix.</summary>
internal static class JsonDocumentDiff
{
    internal static List<string> Of(string before, string after)
    {
        var diffs = new List<string>();
        Walk("", JsonNode.Parse(before), JsonNode.Parse(after), diffs);
        return diffs;
    }

    private static void Walk(string path, JsonNode? before, JsonNode? after, List<string> diffs)
    {
        if (before is JsonObject b && after is JsonObject a)
        {
            foreach (var name in b.Select(p => p.Key).Concat(a.Select(p => p.Key)).Distinct(StringComparer.Ordinal))
                Walk(path.Length == 0 ? name : $"{path}.{name}", b[name], a[name], diffs);
            return;
        }
        if (before is JsonArray ba && after is JsonArray aa)
        {
            for (var i = 0; i < Math.Max(ba.Count, aa.Count); i++)
            {
                Walk($"{path}[{i}]",
                    i < ba.Count ? ba[i] : null,
                    i < aa.Count ? aa[i] : null,
                    diffs);
            }
            return;
        }

        var left = before?.ToJsonString() ?? "<absent>";
        var right = after?.ToJsonString() ?? "<absent>";
        if (!string.Equals(left, right, StringComparison.Ordinal)) diffs.Add($"{path}: {left} -> {right}");
    }
}
