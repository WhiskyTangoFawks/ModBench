using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace MEditService.Tests.TestSupport;

/// <summary>
/// Golden-file comparison for the read model's observable output (#413 slice S0).
///
/// The goldens are captured from the implementation as it stood <b>before</b> the documents swap
/// and reviewed by hand, so they are an independent source of truth for AC3 ("conflict
/// classification and the compare grid produce identical results to before the swap") rather than
/// a snapshot of whatever the new code happens to emit. That distinction is the whole point: a
/// round trip through one mechanism asserted against itself passes even when both directions share
/// a defect.
///
/// Output is canonicalized (object keys sorted, indented, "\n" line endings) so a golden can only
/// differ when a <i>value</i> differs — never because a dictionary enumerated in a different order.
/// Regenerate deliberately with <c>MEDIT_GOLDEN_UPDATE=1</c>, then read the diff: an unexplained
/// change there is a regression, not a rebaseline.
/// </summary>
internal static class Golden
{
    private const string UpdateVariable = "MEDIT_GOLDEN_UPDATE";

    private static readonly JsonSerializerOptions SerializeOptions = new() { WriteIndented = false };
    private static readonly JsonSerializerOptions WriteOptions = new() { WriteIndented = true };

    internal static void Verify(string name, object? value, [CallerFilePath] string here = "")
    {
        var path = Path.Combine(GoldenDirectory(here), name + ".json");
        var actual = Canonical(value);

        if (Environment.GetEnvironmentVariable(UpdateVariable) == "1")
        {
            File.WriteAllText(path, actual);
            return;
        }

        Assert.True(File.Exists(path),
            $"No golden at {path}. Capture it deliberately with {UpdateVariable}=1 and review the file before committing.");

        var expected = File.ReadAllText(path).ReplaceLineEndings("\n");
        if (expected == actual) return;

        Assert.Fail($"Golden '{name}' differs from {path}:\n{FirstDifference(expected, actual)}");
    }

    /// <summary>The golden directory, resolved from this file's own compile-time path — the same
    /// [CallerFilePath] technique RecordTextCodecGeneratorSeedTests uses to reach source. Read and
    /// write both go here, so an update lands in git rather than in the build output.</summary>
    private static string GoldenDirectory(string callerFile) =>
        Path.Combine(Path.GetDirectoryName(callerFile)!, "..", "TestData", "goldens");

    private static string Canonical(object? value)
    {
        var node = JsonSerializer.SerializeToNode(value, SerializeOptions);
        return Sort(node)?.ToJsonString(WriteOptions).ReplaceLineEndings("\n") ?? "null";
    }

    private static JsonNode? Sort(JsonNode? node)
    {
        switch (node)
        {
            case JsonObject obj:
                var sorted = new JsonObject();
                foreach (var pair in obj.ToList().OrderBy(p => p.Key, StringComparer.Ordinal))
                {
                    obj.Remove(pair.Key);
                    sorted[pair.Key] = Sort(pair.Value);
                }
                return sorted;
            case JsonArray array:
                var items = array.ToList();
                array.Clear();
                var rebuilt = new JsonArray();
                foreach (var item in items) rebuilt.Add(Sort(item));
                return rebuilt;
            default:
                return node;
        }
    }

    // xUnit's own string diff truncates long documents to an unreadable window, and these goldens
    // run to thousands of lines — report the first divergent line with its neighbours instead.
    private static string FirstDifference(string expected, string actual)
    {
        var expectedLines = expected.Split('\n');
        var actualLines = actual.Split('\n');
        for (int i = 0; i < Math.Max(expectedLines.Length, actualLines.Length); i++)
        {
            var e = i < expectedLines.Length ? expectedLines[i] : "<end of golden>";
            var a = i < actualLines.Length ? actualLines[i] : "<end of actual>";
            if (e == a) continue;

            var context = string.Join("\n", expectedLines.Skip(Math.Max(0, i - 3)).Take(3).Select(l => "   " + l));
            return $"{context}\n  line {i + 1}:\n  - expected: {e}\n  + actual:   {a}";
        }
        return "(no line differs — trailing whitespace only)";
    }
}
