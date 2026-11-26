using System.Reflection;
using System.Text.RegularExpressions;
using MEditService.TestSupport;

namespace MEditService.Architecture.Tests;

public sealed class WriteRouteSeamTests
{
    private const string AnsweredCall = "EndpointMapping.Answered(";
    private const string BadRequestCall = "EndpointMapping.BadRequest(";

    private static readonly Regex CallSite = new(@"\b([A-Za-z_][A-Za-z0-9_]*)\s*\(", RegexOptions.Compiled);
    private static readonly Regex ProblemCall = new(@"Results\.Problem\(|EndpointMapping\.BadRequest\(", RegexOptions.Compiled);
    private static readonly Regex RefusalCall = new(@"EndpointMapping\.(?:Refusal|LogRefusal)\s*[<(]", RegexOptions.Compiled);
    private static readonly Regex LiteralOrNamedConstant = new(@"^(?:""(?:[^""\\]|\\.)*""|[A-Z]\w*(?:\.[A-Z]\w*)+)$", RegexOptions.Compiled);
    private static readonly Regex WhitespaceRun = new(@"\s+", RegexOptions.Compiled);

    [Fact]
    public void EveryWriteRoute_MapsItsHandlersOutcomeOnlyThroughEndpointMappingAnswered()
    {
        var endpoints = Path.Combine(ServiceProjects.SolutionDirectory(), "MEditService.Http", "Endpoints");
        var files = Directory.GetFiles(endpoints, "*Endpoints.cs").Order(StringComparer.Ordinal).ToList();

        var offences = WriteRouteHandlerTests.WriteRoutes.Value
            .SelectMany(route => Offences(
                    files, Path.Combine(endpoints, route.EndpointFile), route.EndpointMethod, route.Handlers.Any(HasAnAnswerToMap))
                .Select(offence => $"{route.Route}: {offence}"))
            .ToList();

        Assert.True(
            offences.Count == 0,
            "A write route maps its handler's outcome outside EndpointMapping.Answered, the one place a write's answer "
            + "and refusal are mapped and logged:\n" + string.Join("\n", offences));
    }

    public static TheoryData<string[], string[]> PlantedRoutes => new()
    {
        {
            ["internal static IResult Route(bool x) => x ? EndpointMapping.Answered(null!) : EndpointMapping.Refusal(null!);"],
            ["calls EndpointMapping.Refusal( itself"]
        },
        {
            ["internal static IResult Route(bool x) => x ? EndpointMapping.Answered(null!) : Results.Ok(EndpointMapping.LogRefusal(null!, \"x\", 1, \"m\"));"],
            ["calls EndpointMapping.LogRefusal( itself"]
        },
        {
            ["internal static IResult Route(bool x) => x ? EndpointMapping.Answered(null!) : EndpointMapping.BadRequest(refused.Message);"],
            ["hand-rolls EndpointMapping.BadRequest(refused.Message)"]
        },
        {
            ["internal static IResult Route() => EndpointMapping.BadRequest(\"x\");"],
            ["never answers through EndpointMapping.Answered"]
        },
        {
            ["internal static IResult Route(int x)\n{\n    return HandRolled(x);\n}\n\nprivate static IResult HandRolled(int x)\n{\n    return Results.Problem(\"not found\", statusCode: 404);\n}"],
            ["never answers through EndpointMapping.Answered", "hand-rolls Results.Problem(\"not found\", statusCode: 404)"]
        },
        {
            [
                "internal static IResult Shared() { return EndpointMapping.Answered(null!); }",
                "internal static IResult Route() { return Shared(); }\nprivate static IResult Shared() { return Results.Problem(\"x\", statusCode: 404); }",
            ],
            ["never answers through EndpointMapping.Answered", "hand-rolls Results.Problem(\"x\", statusCode: 404)"]
        },
    };

    [Theory]
    [MemberData(nameof(PlantedRoutes))]
    public void TheScan_NamesEachWayARouteMapsAnOutcomeOutsideAnswered(string[] sources, string[] offences)
    {
        using var root = new ScratchDirectory("medit-write-route-seam-scan-");
        var files = sources.Select((source, at) =>
        {
            var file = Path.Combine(root, $"Planted{at}Endpoints.cs");
            File.WriteAllText(file, $"internal static class Planted{at}\n{{\n{source}\n}}\n");
            return file;
        }).ToList();

        Assert.Equal(offences, Offences(files, files[^1], "Route", mustAnswer: true));
    }

    [Fact]
    public void TheScan_HoldsToAnsweredAHandlerWithAVerbThatAnswers()
    {
        Assert.True(HasAnAnswerToMap(typeof(PlantedHandlerAnsweringOneVerb)));
    }

    private sealed class PlantedHandlerAnsweringOneVerb
    {
        private int _signals;

        public void Signal() => _signals++;

        public int Answer() => _signals;
    }

    private static bool HasAnAnswerToMap(Type handler) =>
        handler.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly).Any(m => m.ReturnType != typeof(void));

    private static List<string> Offences(IReadOnlyList<string> files, string routeFile, string method, bool mustAnswer)
    {
        var bodies = ReachInFollowingEachHelperOnce(files.ToDictionary(file => file, File.ReadAllText), routeFile, method);
        if (bodies.Count == 0) return [$"no static method {method} in {Path.GetFileName(routeFile)}"];

        return
        [
            .. mustAnswer && !bodies.Any(body => body.Contains(AnsweredCall, StringComparison.Ordinal))
                ? ["never answers through EndpointMapping.Answered"]
                : Array.Empty<string>(),
            .. bodies.SelectMany(HandRolledProblems).Select(call => $"hand-rolls {call}"),
            .. bodies.SelectMany(body => RefusalCall.Matches(body)).Select(call => $"calls {call.Value} itself"),
        ];
    }

    private static List<string> ReachInFollowingEachHelperOnce(Dictionary<string, string> texts, string routeFile, string methodName)
    {
        var visited = new HashSet<(string File, string Method)>();
        var bodies = new List<string>();
        Collect(methodName, routeFile);
        return bodies;

        void Collect(string method, string callerFile)
        {
            var found = texts.Keys
                .OrderBy(file => file == callerFile ? 0 : 1)
                .Select(file => (File: file, Body: BodyOfStaticDeclaration(texts[file], method)))
                .FirstOrDefault(candidate => candidate.Body is not null);
            if (found.Body is not { } body || !visited.Add((found.File, method))) return;
            bodies.Add(body);

            foreach (var callee in CallSite.Matches(body).Select(m => m.Groups[1].Value).Distinct(StringComparer.Ordinal))
                Collect(callee, found.File);
        }
    }

    private static IEnumerable<string> HandRolledProblems(string body)
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

    private static string? BodyOfStaticDeclaration(string text, string methodName)
    {
        var match = Regex.Match(text, $@"(?:internal|private|public)\s+static\s+(?:async\s+)?\S+\s+{Regex.Escape(methodName)}\s*\(");
        if (!match.Success) return null;

        var parametersClose = MatchingDelimiter(text, match.Index + match.Length - 1, '(', ')');
        var bodyOpen = parametersClose + 1;
        while (bodyOpen < text.Length && char.IsWhiteSpace(text[bodyOpen])) bodyOpen++;
        if (text.AsSpan(bodyOpen).StartsWith("=>"))
            return text[bodyOpen..(EndOfExpression(text, bodyOpen) + 1)];
        if (bodyOpen >= text.Length || text[bodyOpen] != '{') return null;

        return text[bodyOpen..(MatchingDelimiter(text, bodyOpen, '{', '}') + 1)];
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
