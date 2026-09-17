using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using MEditService.LoadOrder;

namespace MEditService.Tests.TestSupport;

/// <summary>Goldens were captured from a known-good implementation and reviewed by hand, so
/// they are independent of what the code emits. <c>MEDIT_GOLDEN_UPDATE=1</c> regenerates.</summary>
internal static class Golden
{
    private const string UpdateVariable = "MEDIT_GOLDEN_UPDATE";

    // The same converter Program.cs registers, so an enum lands in the golden as the string the
    // endpoint sends rather than a bare integer the wire cannot produce.
    private static readonly JsonSerializerOptions SerializeOptions =
        new() { WriteIndented = false, Converters = { new JsonStringEnumConverter() } };
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

    // MEditService.Index.Tests carries no TestData of its own (MEditService.TestSupport's is the
    // one committed copy, referenced by every project that needs it), so this walks up one more
    // level than a same-project Golden.cs would.
    private static string GoldenDirectory(string callerFile) =>
        Path.Combine(PathShape.DirectoryOf(callerFile), "..", "..", "MEditService.TestSupport", "TestData", "goldens");

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
    internal static string FirstDifference(string expected, string actual)
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
