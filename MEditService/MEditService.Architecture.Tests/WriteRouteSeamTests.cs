using System.Text.RegularExpressions;
using MEditService.TestSupport;

namespace MEditService.Architecture.Tests;

public sealed class WriteRouteSeamTests
{
    private static readonly string[] EndpointFiles = ["RecordEndpoints.cs", "PluginEndpoints.cs", "LoadOrderEndpoints.cs", "ModEndpoints.cs", "ManifestEndpoints.cs"];

    private static readonly Regex CallSite = new(@"\b([A-Za-z_][A-Za-z0-9_]*)\s*\(", RegexOptions.Compiled);
    private static readonly Regex ProblemCall = new(@"Results\.Problem\(|EndpointMapping\.BadRequest\(", RegexOptions.Compiled);
    private static readonly Regex LiteralOrNamedConstant = new(
        @"^(?:""(?:[^""\\]|\\.)*""|[A-Z]\w*(?:\.[A-Z]\w*)+)$", RegexOptions.Compiled);
    private const string BadRequestCall = "EndpointMapping.BadRequest(";
    private const string AnsweredCall = "EndpointMapping.Answered(";
    private static readonly Regex RefusalCall = new(@"EndpointMapping\.(?:Refusal|LogRefusal)\s*[<(]", RegexOptions.Compiled);

    private static readonly Regex WhitespaceRun = new(@"\s+", RegexOptions.Compiled);

    public static IEnumerable<object[]> EveryNamedMethodRoute =>
        WriteRouteHandlerTests.Routes.Select(r => new object[] { $"{r.Method} {r.Pattern}", r.EndpointMethod });

    [Theory]
    [MemberData(nameof(EveryNamedMethodRoute))]
    public void AWriteRoute_AnswersThroughEndpointMappingAnswered(string route, string method)
    {
        Assert.True(MethodBody(method) is not null, $"{route}: no internal/private/public static method named {method} found in {string.Join(", ", EndpointFiles)}.");
        Assert.True(
            AnswersThroughAnswered(EndpointFiles.Select(EndpointFile), method),
            $"{route}: {method} never answers through EndpointMapping.Answered — the one place a write's answer and refusal are mapped.");
    }

    [Theory]
    [MemberData(nameof(EveryNamedMethodRoute))]
    public void AWriteRoute_NeverHandRollsAResultsProblemForAHandlerOutcome(string route, string method)
    {
        var offenders = ReachInFollowingEachHelperOnce(EndpointFiles.Select(EndpointFile), method)
            .SelectMany(ExtractProblemCalls)
            .ToArray();

        Assert.True(
            offenders.Length == 0,
            $"{route}: {method} hand-rolls a Results.Problem(...) outside the request-shape validation "
            + $"carve-out — a handler outcome must map through EndpointMapping instead: {string.Join(" | ", offenders)}");
    }

    [Theory]
    [MemberData(nameof(EveryNamedMethodRoute))]
    public void AWriteRoute_NeverCallsARefusalHelperOutsideAnswered(string route, string method)
    {
        var offenders = ReachInFollowingEachHelperOnce(EndpointFiles.Select(EndpointFile), method)
            .SelectMany(body => RefusalCall.Matches(body).Select(m => m.Value))
            .ToArray();

        Assert.True(offenders.Length == 0, $"{route}: {method} calls {string.Join(", ", offenders)} itself; a refusal is mapped and logged only through EndpointMapping.Answered.");
    }

    [Theory]
    [InlineData("EndpointMapping.Refusal(null!)", 1)]
    [InlineData("EndpointMapping.LogRefusal(null!, \"x\", 1, \"m\")", 1)]
    [InlineData("EndpointMapping.Answered(\"x\", null!, 1, EndpointMapping.Refusal)", 0)]
    public void TheScan_FlagsARefusalHelperCalledBesideAnswered(string other, int flagged)
    {
        WithPlantedFile(
            "internal static class PlantedEndpoints\n{\n"
            + $"    internal static IResult Route(bool x) => x ? EndpointMapping.Answered(null!) : {other};\n}}\n",
            file => Assert.Equal(flagged, ReachInFollowingEachHelperOnce([file], "Route").SelectMany(body => RefusalCall.Matches(body)).Count()));
    }

    [Fact]
    public void TheScan_FindsTheDeclaration_NotAnEarlierCallSite()
    {
        WithPlantedFile(
            "internal static class PlantedEndpoints\n{\n"
            + "    internal static IResult Caller(int x)\n    {\n"
            + "        return DirectHit(x);\n    }\n\n"
            + "    internal static IResult DirectHit(int x)\n    {\n"
            + "        return EndpointMapping.Answered(null!);\n    }\n}\n",
            file =>
            {
                Assert.Null(BodyOfStaticDeclarationIn(file, "NoSuchMethod"));
                var body = BodyOfStaticDeclarationIn(file, "DirectHit");
                Assert.NotNull(body);
                Assert.Contains("EndpointMapping.Answered(", body, StringComparison.Ordinal);
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
            + "        return EndpointMapping.Answered(null!);\n    }\n}\n",
            file => Assert.True(AnswersThroughAnswered([file], "ThroughASibling")));
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
                Assert.False(AnswersThroughAnswered([file], "ThroughAHandRolledSibling"));
                var offenders = ReachInFollowingEachHelperOnce([file], "ThroughAHandRolledSibling")
                    .SelectMany(ExtractProblemCalls)
                    .ToArray();
                Assert.Single(offenders);
            });
    }

    [Fact]
    public void TheScan_ReadsAnExpressionBodiedRoute()
    {
        WithPlantedFile(
            "internal static class PlantedEndpoints\n{\n"
            + "    internal static IResult HandRolled(int x) =>\n"
            + "        Results.Problem(\"not found\", statusCode: 404);\n}\n",
            file =>
            {
                Assert.Single(ReachInFollowingEachHelperOnce([file], "HandRolled").SelectMany(ExtractProblemCalls));
            });
    }

    [Fact]
    public void TheScan_FollowsAnExpressionBodiedRouteIntoTheSeam()
    {
        WithPlantedFile(
            "internal static class PlantedEndpoints\n{\n"
            + "    internal static IResult Mapped(int x) => EndpointMapping.Answered(null!);\n}\n",
            file => Assert.True(AnswersThroughAnswered([file], "Mapped")));
    }

    [Fact]
    public void TheScan_FollowsACalleeInTheCallersOwnFileFirst()
    {
        using var root = new ScratchDirectory("medit-write-route-seam-scan-");
        var other = Path.Combine(root, "OtherEndpoints.cs");
        var own = Path.Combine(root, "OwnEndpoints.cs");
        File.WriteAllText(other,
            "internal static class Other\n{\n    internal static IResult Shared() { return EndpointMapping.Answered(null!); }\n}\n");
        File.WriteAllText(own,
            "internal static class Own\n{\n    internal static IResult Route() { return Shared(); }\n"
            + "    private static IResult Shared() { return Results.Problem(\"x\", statusCode: 404); }\n}\n");

        Assert.False(AnswersThroughAnswered([other, own], "Route"));
        Assert.Single(ReachInFollowingEachHelperOnce([other, own], "Route").SelectMany(ExtractProblemCalls));
    }

    [Theory]
    [InlineData("EndpointMapping.BadRequest(\"x\")")]
    [InlineData("EndpointMapping.Refusal(null!)")]
    [InlineData("Results.Ok(EndpointMapping.LogRefusal(null!, \"x\", 1, \"m\"))")]
    public void TheScan_CountsNothingButAnsweredAsTheSeam(string answer)
    {
        WithPlantedFile(
            "internal static class PlantedEndpoints\n{\n"
            + $"    internal static IResult Route() => {answer};\n}}\n",
            file => Assert.False(AnswersThroughAnswered([file], "Route")));
    }

    [Theory]
    [InlineData("\"At least one mod is required.\"", 0)]
    [InlineData("ArchiveVariantsRequest.NotOneEach", 0)]
    [InlineData("refused.Message", 1)]
    [InlineData("$\"Unknown {x}\"", 1)]
    public void TheScan_FlagsABadRequestUnlessItsDetailIsALiteralOrANamedConstant(string detail, int flagged)
    {
        WithPlantedFile(
            "internal static class PlantedEndpoints\n{\n"
            + $"    internal static IResult Route(int x) => EndpointMapping.BadRequest({detail});\n}}\n",
            file => Assert.Equal(flagged, ReachInFollowingEachHelperOnce([file], "Route").SelectMany(ExtractProblemCalls).Count()));
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

    private static bool AnswersThroughAnswered(IEnumerable<string> files, string methodName) =>
        ReachInFollowingEachHelperOnce(files, methodName).Any(body => body.Contains(AnsweredCall, StringComparison.Ordinal));

    private static IReadOnlyList<string> ReachInFollowingEachHelperOnce(IEnumerable<string> files, string methodName)
    {
        var fileList = files.ToArray();
        var visited = new HashSet<(string? File, string Method)>();
        var bodies = new List<string>();
        Collect(methodName, null);
        return bodies;

        void Collect(string method, string? callerFile)
        {
            var (file, body) = fileList
                .OrderBy(candidate => candidate == callerFile ? 0 : 1)
                .Select(candidate => (File: candidate, Body: BodyOfStaticDeclarationIn(candidate, method)))
                .FirstOrDefault(found => found.Body is not null);
            if (body is null || !visited.Add((file, method))) return;
            bodies.Add(body);

            foreach (var candidate in CallSite.Matches(body).Select(m => m.Groups[1].Value).Distinct(StringComparer.Ordinal))
                Collect(candidate, file);
        }
    }

    private static IEnumerable<string> ExtractProblemCalls(string body)
    {
        foreach (Match m in ProblemCall.Matches(body))
        {
            var openIndex = m.Index + m.Length - 1;
            var closeIndex = MatchingDelimiter(body, openIndex, '(', ')');
            var call = Normalize(body[m.Index..(closeIndex + 1)]);
            var detail = Normalize(body[(openIndex + 1)..closeIndex]);
            if (!call.StartsWith(BadRequestCall, StringComparison.Ordinal) || !LiteralOrNamedConstant.IsMatch(detail))
                yield return call;
        }
    }

    private static string Normalize(string text) => WhitespaceRun.Replace(text, " ").Trim();

    private static string? MethodBody(string methodName) =>
        EndpointFiles.Select(file => BodyOfStaticDeclarationIn(EndpointFile(file), methodName)).FirstOrDefault(body => body is not null);

    private static string? BodyOfStaticDeclarationIn(string file, string methodName)
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
        if (text.AsSpan(bodyOpen).StartsWith("=>"))
            return text[bodyOpen..(EndOfExpression(text, bodyOpen) + 1)];
        if (bodyOpen >= text.Length || text[bodyOpen] != '{') return null;

        var bodyClose = MatchingDelimiter(text, bodyOpen, '{', '}');
        return text[bodyOpen..(bodyClose + 1)];
    }

    private static int EndOfExpression(string text, int start)
    {
        var depth = 0;
        for (var i = start; i < text.Length; i++)
        {
            if (text[i] is '(' or '{' or '[') depth++;
            else if (text[i] is ')' or '}' or ']') depth--;
            else if (text[i] == ';' && depth == 0) return i;
        }
        throw new InvalidOperationException($"No ';' ends the expression at {start}.");
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
