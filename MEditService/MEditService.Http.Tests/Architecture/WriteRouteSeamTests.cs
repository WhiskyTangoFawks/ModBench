using System.Text.RegularExpressions;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Architecture;

public sealed class WriteRouteSeamTests
{
    private static readonly (string Route, string Method)[] Routes =
    [
        ("POST /records/{formKey}/edit-changes", "EditRecordChanges"),
        ("POST /records/delete", "DeleteRecord"),
        ("POST /records/copy", "CopyRecord"),
        ("POST /plugins/create", "CreatePlugin"),
        ("POST /plugins/track", "Track"),
        ("POST /plugins/decompile", "Decompile"),
        ("POST /plugins/compile", "Compile"),
        ("POST /plugins/rename-source", "RenameSource"),
        ("POST /plugins/{plugin}/records", "CreateRecord"),
        ("PUT /load-order", "PutLoadOrder"),
    ];

    private static readonly string[] EndpointFiles = ["RecordEndpoints.cs", "PluginEndpoints.cs", "LoadOrderEndpoints.cs"];

    private static readonly Regex CallSite = new(@"\b([A-Za-z_][A-Za-z0-9_]*)\s*\(", RegexOptions.Compiled);
    private static readonly Regex ProblemCall = new(@"Results\.Problem\(", RegexOptions.Compiled);
    private static readonly Regex WhitespaceRun = new(@"\s+", RegexOptions.Compiled);

    private static readonly string[] HandRolledRequestShapeValidation400s =
    [
        """Results.Problem("Plugin name and origin are required.", statusCode: 400)""",
        """Results.Problem("An operation and a path are required.", statusCode: 400)""",
        """Results.Problem("The text of the document carrying the record is required.", statusCode: 400)""",
        """Results.Problem("At least one record is required.", statusCode: 400)""",
        """Results.Problem("Every record needs a FormKey, a plugin name and an origin.", statusCode: 400)""",
        """Results.Problem("At least one destination is required.", statusCode: 400)""",
        """Results.Problem("Every destination needs a name and an origin.", statusCode: 400)""",
        """Results.Problem("Plugin name is required.", statusCode: 400)""",
        """Results.Problem("The folder and the origin are required.", statusCode: 400)""",
        """Results.Problem("Origin is required.", statusCode: 400)""",
        """Results.Problem("At least one plugin is required.", statusCode: 400)""",
        """Results.Problem("Every plugin needs a name and an origin.", statusCode: 400)""",
        """Results.Problem("At least one mod is required.", statusCode: 400)""",
        """Results.Problem("Every mod needs a name.", statusCode: 400)""",
        """Results.Problem("A record type is required.", statusCode: 400)""",
        """Results.Problem($"Game directory not found: {req.GameDirectory}", statusCode: 400)""",
        """Results.Problem($"Instance root not found: {req.InstanceRoot}", statusCode: 400)""",
        """Results.Problem("Each plugin entry must have a non-empty Name, Path, Origin and Provider.", statusCode: 400)""",
        """Results.Problem("The snapshot must state its active plugins and those loaded with no line.", statusCode: 400)""",
    ];

    public static IEnumerable<object[]> EveryNamedMethodRoute =>
        Routes.Select(r => new object[] { r.Route, r.Method });

    [Fact]
    public void TheGate_CoversExactlyTheCanonicalWriteRoutes()
    {
        var canonical = WriteRouteHandlerTests.Routes
            .Select(r => $"{r.Method} {r.Pattern}")
            .Order(StringComparer.Ordinal);
        var covered = Routes.Select(r => r.Route).Order(StringComparer.Ordinal);

        Assert.Equal(canonical, covered);
    }

    [Theory]
    [MemberData(nameof(EveryNamedMethodRoute))]
    public void AWriteRoute_MapsThroughTheSharedSeam(string route, string method)
    {
        Assert.True(MethodBody(method) is not null, $"{route}: no internal/private/public static method named {method} found in {string.Join(", ", EndpointFiles)}.");
        Assert.True(
            MapsThroughSeamIn(EndpointFiles.Select(EndpointFile), method),
            $"{route}: {method} never reaches WriteEndpointMapping — the write routes' shared error-mapping seam.");
    }

    [Theory]
    [MemberData(nameof(EveryNamedMethodRoute))]
    public void AWriteRoute_NeverHandRollsAResultsProblemForAHandlerOutcome(string route, string method)
    {
        var offenders = ReachInFollowingEachHelperOnce(EndpointFiles.Select(EndpointFile), method)
            .SelectMany(ExtractProblemCalls)
            .Where(call => !HandRolledRequestShapeValidation400s.Contains(call, StringComparer.Ordinal))
            .ToArray();

        Assert.True(
            offenders.Length == 0,
            $"{route}: {method} hand-rolls a Results.Problem(...) outside the request-shape validation "
            + $"carve-out — a handler outcome must map through WriteEndpointMapping instead: {string.Join(" | ", offenders)}");
    }

    [Fact]
    public void TheScan_FindsTheDeclaration_NotAnEarlierCallSite()
    {
        WithPlantedFile(
            "internal static class PlantedEndpoints\n{\n"
            + "    internal static IResult Caller(int x)\n    {\n"
            + "        return DirectHit(x);\n    }\n\n"
            + "    internal static IResult DirectHit(int x)\n    {\n"
            + "        return WriteEndpointMapping.Refusal(null!);\n    }\n}\n",
            file =>
            {
                Assert.Null(BlockBodyOfStaticDeclarationIn(file, "NoSuchMethod"));
                var body = BlockBodyOfStaticDeclarationIn(file, "DirectHit");
                Assert.NotNull(body);
                Assert.Contains("WriteEndpointMapping.", body, StringComparison.Ordinal);
                Assert.DoesNotContain("Caller", body, StringComparison.Ordinal);
            });
    }

    [Fact]
    public void TheScan_FollowsASiblingMethodTheRouteCalls()
    {
        WithPlantedFile(
            "internal static class PlantedEndpoints\n{\n"
            + "    internal static IResult ThroughASibling(int x)\n    {\n"
            + "        return Shared(x);\n    }\n\n"
            + "    private static IResult Shared(int x)\n    {\n"
            + "        return WriteEndpointMapping.Refusal(null!);\n    }\n}\n",
            file => Assert.True(MapsThroughSeamIn([file], "ThroughASibling")));
    }

    [Fact]
    public void TheScan_FailsARouteWhoseSiblingNeverReachesTheSeam()
    {
        WithPlantedFile(
            "internal static class PlantedEndpoints\n{\n"
            + "    internal static IResult ThroughAHandRolledSibling(int x)\n    {\n"
            + "        return HandRolled(x);\n    }\n\n"
            + "    private static IResult HandRolled(int x)\n    {\n"
            + "        return Results.Problem(\"not found\", statusCode: 404);\n    }\n}\n",
            file =>
            {
                Assert.False(MapsThroughSeamIn([file], "ThroughAHandRolledSibling"));
                var offenders = ReachInFollowingEachHelperOnce([file], "ThroughAHandRolledSibling")
                    .SelectMany(ExtractProblemCalls)
                    .Where(call => !HandRolledRequestShapeValidation400s.Contains(call, StringComparer.Ordinal))
                    .ToArray();
                Assert.Single(offenders);
            });
    }

    private static void WithPlantedFile(string source, Action<string> assert)
    {
        using var root = new ScratchDirectory("medit-write-route-seam-scan-");
        var file = Path.Combine(root, "PlantedEndpoints.cs");
        File.WriteAllText(file, source);
        assert(file);
    }

    private static string EndpointFile(string name) =>
        Path.Combine(ServiceProjects.SolutionDirectory(), "MEditService.Http", "Endpoints", name);

    private static bool MapsThroughSeamIn(IEnumerable<string> files, string methodName) =>
        ReachInFollowingEachHelperOnce(files, methodName).Any(body => body.Contains("WriteEndpointMapping.", StringComparison.Ordinal));

    private static IReadOnlyList<string> ReachInFollowingEachHelperOnce(IEnumerable<string> files, string methodName)
    {
        var fileList = files.ToArray();
        var visited = new HashSet<string>(StringComparer.Ordinal);
        var bodies = new List<string>();
        Collect(methodName);
        return bodies;

        void Collect(string method)
        {
            if (!visited.Add(method)) return;
            var body = fileList.Select(file => BlockBodyOfStaticDeclarationIn(file, method)).FirstOrDefault(b => b is not null);
            if (body is null) return;
            bodies.Add(body);

            foreach (var candidate in CallSite.Matches(body).Select(m => m.Groups[1].Value).Distinct(StringComparer.Ordinal))
                Collect(candidate);
        }
    }

    private static IEnumerable<string> ExtractProblemCalls(string body)
    {
        foreach (Match m in ProblemCall.Matches(body))
        {
            var openIndex = m.Index + m.Length - 1;
            var closeIndex = MatchingDelimiter(body, openIndex, '(', ')');
            yield return Normalize(body[m.Index..(closeIndex + 1)]);
        }
    }

    private static string Normalize(string text) => WhitespaceRun.Replace(text, " ").Trim();

    private static string? MethodBody(string methodName) =>
        EndpointFiles.Select(file => BlockBodyOfStaticDeclarationIn(EndpointFile(file), methodName)).FirstOrDefault(body => body is not null);

    private static string? BlockBodyOfStaticDeclarationIn(string file, string methodName)
    {
        var text = File.ReadAllText(file);
        var declaration = new Regex(
            $@"(?:internal|private|public)\s+static\s+(?:async\s+)?\S+\s+{Regex.Escape(methodName)}\s*\(",
            RegexOptions.Compiled);
        var match = declaration.Match(text);
        if (!match.Success) return null;

        var parametersOpen = match.Index + match.Length - 1;
        var parametersClose = MatchingDelimiter(text, parametersOpen, '(', ')');
        var bodyOpen = parametersClose + 1;
        while (bodyOpen < text.Length && char.IsWhiteSpace(text[bodyOpen])) bodyOpen++;
        if (bodyOpen >= text.Length || text[bodyOpen] != '{') return null;

        var bodyClose = MatchingDelimiter(text, bodyOpen, '{', '}');
        return text[bodyOpen..(bodyClose + 1)];
    }

    private static int MatchingDelimiter(string text, int openIndex, char open, char close)
    {
        var depth = 0;
        for (var i = openIndex; i < text.Length; i++)
        {
            if (text[i] == open) depth++;
            else if (text[i] == close && --depth == 0) return i;
        }
        throw new InvalidOperationException($"No matching '{close}' for '{open}' at {openIndex}.");
    }
}
