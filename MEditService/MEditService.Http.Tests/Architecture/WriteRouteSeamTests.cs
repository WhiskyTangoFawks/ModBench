using System.Text.RegularExpressions;

namespace MEditService.Http.Tests.Architecture;

/// <summary>Every write route's error mapping goes through WriteEndpointMapping, the write
/// handlers' one shared seam. Routes are spelled by their answering method, checked against
/// <see cref="WriteRouteHandlerTests"/>'s own canonical set so the two cannot drift apart.</summary>
public sealed class WriteRouteSeamTests
{
    // Route, and the internal method answering it. Method + Pattern are joined with a space, matching
    // how they're compared against WriteRouteHandlerTests.Routes below.
    private static readonly (string Route, string Method)[] Routes =
    [
        ("POST /records/{formKey}/edit", "EditRecord"),
        ("POST /records/delete", "DeleteRecord"),
        ("POST /records/{formKey}/copy-as-override", "CopyRecordAsOverride"),
        ("POST /records/{formKey}/copy-as-new-record", "CopyRecordAsNewRecord"),
        ("POST /plugins/create", "CreatePlugin"),
        ("POST /plugins/track", "Track"),
        ("POST /plugins/{plugin}/compile", "Compile"),
        ("POST /plugins/{plugin}/records", "CreateRecord"),
        ("POST /plugins/external-change/absorb", "AbsorbExternalChange"),
        ("POST /plugins/external-change/keep", "KeepExternalChange"),
        ("PUT /load-order", "PutLoadOrder"),
    ];

    private static readonly string[] EndpointFiles = ["RecordEndpoints.cs", "PluginEndpoints.cs", "LoadOrderEndpoints.cs"];

    private static readonly Regex CallSite = new(@"\b([A-Za-z_][A-Za-z0-9_]*)\s*\(", RegexOptions.Compiled);
    private static readonly Regex ProblemCall = new(@"Results\.Problem\(", RegexOptions.Compiled);
    private static readonly Regex WhitespaceRun = new(@"\s+", RegexOptions.Compiled);

    // Every request-shape validation 400 a write route's reach still hand-rolls, normalized
    // (whitespace collapsed). Anything else found here is a handler outcome, forbidden below.
    private static readonly string[] ValidationCarveOut =
    [
        """Results.Problem("Plugin name and origin are required.", statusCode: 400)""",
        """Results.Problem("An operation and a path are required.", statusCode: 400)""",
        """Results.Problem("At least one record is required.", statusCode: 400)""",
        """Results.Problem("Every record needs a FormKey, a plugin name and an origin.", statusCode: 400)""",
        """Results.Problem("Source plugin name and origin are required.", statusCode: 400)""",
        """Results.Problem("Destination plugin name and origin are required.", statusCode: 400)""",
        """Results.Problem("Plugin name is required.", statusCode: 400)""",
        """Results.Problem("Destination path and origin are required.", statusCode: 400)""",
        """Results.Problem( $"Invalid plugin extension '{extension}'. Must be .esp, .esm, or .esl.", statusCode: 400)""",
        """Results.Problem("Origin is required.", statusCode: 400)""",
        """Results.Problem("At least one plugin is required.", statusCode: 400)""",
        """Results.Problem("Every plugin needs a name and an origin.", statusCode: 400)""",
        """Results.Problem($"Unknown source preset '{req.Preset}'.", statusCode: 400)""",
        """Results.Problem("A record type is required.", statusCode: 400)""",
        """Results.Problem($"Game directory not found: {req.GameDirectory}", statusCode: 400)""",
        """Results.Problem($"Instance root not found: {req.InstanceRoot}", statusCode: 400)""",
        """Results.Problem("Each plugin entry must have a non-empty Name, Path, and Origin, and must state Enabled and Winning.", statusCode: 400)""",
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
        var offenders = ReachIn(EndpointFiles.Select(EndpointFile), method)
            .SelectMany(ExtractProblemCalls)
            .Where(call => !ValidationCarveOut.Contains(call, StringComparer.Ordinal))
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
            + "        return WriteEndpointMapping.NoLoadOrder(null!);\n    }\n}\n",
            file =>
            {
                Assert.Null(MethodBodyIn(file, "NoSuchMethod"));
                var body = MethodBodyIn(file, "DirectHit");
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
            + "        return WriteEndpointMapping.NoLoadOrder(null!);\n    }\n}\n",
            file => Assert.True(MapsThroughSeamIn([file], "ThroughASibling")));
    }

    // The rival this scan exists to catch: a route whose only sibling call never reaches
    // WriteEndpointMapping must still fail.
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
                var offenders = ReachIn([file], "ThroughAHandRolledSibling")
                    .SelectMany(ExtractProblemCalls)
                    .Where(call => !ValidationCarveOut.Contains(call, StringComparer.Ordinal))
                    .ToArray();
                Assert.Single(offenders);
            });
    }

    private static void WithPlantedFile(string source, Action<string> assert)
    {
        var root = Directory.CreateTempSubdirectory("medit-write-route-seam-scan-").FullName;
        try
        {
            var file = Path.Combine(root, "PlantedEndpoints.cs");
            File.WriteAllText(file, source);
            assert(file);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private static string EndpointFile(string name) =>
        Path.Combine(ArchitectureTests.SolutionDirectory(), "MEditService.Http", "Endpoints", name);

    private static bool MapsThroughSeamIn(IEnumerable<string> files, string methodName) =>
        ReachIn(files, methodName).Any(body => body.Contains("WriteEndpointMapping.", StringComparison.Ordinal));

    // A route's own body is the first place to look; a body that only delegates to a shared private
    // helper is followed one call at a time, bounded by visited so a cycle between two siblings
    // cannot loop forever.
    private static IReadOnlyList<string> ReachIn(IEnumerable<string> files, string methodName)
    {
        var fileList = files.ToArray();
        var visited = new HashSet<string>(StringComparer.Ordinal);
        var bodies = new List<string>();
        Collect(methodName);
        return bodies;

        void Collect(string method)
        {
            if (!visited.Add(method)) return;
            var body = fileList.Select(file => MethodBodyIn(file, method)).FirstOrDefault(b => b is not null);
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
        EndpointFiles.Select(file => MethodBodyIn(EndpointFile(file), methodName)).FirstOrDefault(body => body is not null);

    // A true declaration is "static <return type> Name(", never a call site. An expression-bodied
    // declaration (=> ...;) has no block, and answers null rather than wander into the next method.
    private static string? MethodBodyIn(string file, string methodName)
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
