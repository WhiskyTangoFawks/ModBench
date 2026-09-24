using System.Text.RegularExpressions;

namespace MEditService.Http.Tests.Architecture;

/// <summary>Every write route's error mapping goes through WriteEndpointMapping, the write
/// handlers' one shared seam. Routes are spelled by their answering method, as
/// <see cref="WriteRouteHandlerTests"/> spells them by their Commands handler.</summary>
public sealed class WriteRouteSeamTests
{
    private static readonly (string Route, string Method)[] NamedMethodRoutes =
    [
        ("POST /records/{formKey}/edit", "EditRecord"),
        ("POST /records/delete", "DeleteRecord"),
        ("POST /records/{formKey}/renumber", "RenumberRecord"),
        ("POST /records/{formKey}/copy-as-override", "CopyRecordAsOverride"),
        ("POST /records/{formKey}/copy-as-new-record", "CopyRecordAsNewRecord"),
        ("POST /plugins/create", "CreatePlugin"),
        ("POST /plugins/track", "Track"),
        ("POST /plugins/{plugin}/compile", "Compile"),
        ("POST /plugins/{plugin}/records", "CreateRecord"),
        ("POST /plugins/external-change/absorb", "AbsorbExternalChange"),
        ("POST /plugins/external-change/keep", "KeepExternalChange"),
        ("POST /plugins/rebase", "Rebase"),
        ("POST /plugins/rebase/continue", "ContinueRebase"),
        ("PUT /load-order", "PutLoadOrder"),
    ];

    private static readonly string[] EndpointFiles = ["RecordEndpoints.cs", "PluginEndpoints.cs", "LoadOrderEndpoints.cs"];

    private static readonly Regex CallSite = new(@"\b([A-Za-z_][A-Za-z0-9_]*)\s*\(", RegexOptions.Compiled);

    public static IEnumerable<object[]> EveryNamedMethodRoute =>
        NamedMethodRoutes.Select(r => new object[] { r.Route, r.Method });

    [Theory]
    [MemberData(nameof(EveryNamedMethodRoute))]
    public void AWriteRoute_MapsThroughTheSharedSeam(string route, string method)
    {
        Assert.True(MethodBody(method) is not null, $"{route}: no internal/private/public static method named {method} found in {string.Join(", ", EndpointFiles)}.");
        Assert.True(
            MapsThroughSeam(method),
            $"{route}: {method} never reaches WriteEndpointMapping — the write routes' shared error-mapping seam.");
    }

    // PeekNextFreeFormKey answers inline in its own MapGet lambda, not a named method (ruling 7's
    // read gesture), so its call-site span is asserted directly instead of a method body.
    [Fact]
    public void PeekNextFreeFormKey_MapsThroughTheSharedSeam()
    {
        const string route = "GET /plugins/{plugin}/records/next-form-key";
        var source = File.ReadAllText(EndpointFile("PluginEndpoints.cs"));
        var routeIndex = source.IndexOf("\"/plugins/{plugin}/records/next-form-key\"", StringComparison.Ordinal);
        Assert.True(routeIndex >= 0, $"{route}: route pattern not found in PluginEndpoints.cs.");
        var nameIndex = source.IndexOf(".WithName(\"PeekNextFreeFormKey\")", routeIndex, StringComparison.Ordinal);
        Assert.True(nameIndex >= 0, $"{route}: could not find its own .WithName(\"PeekNextFreeFormKey\") to bound the scan.");

        Assert.True(
            source[routeIndex..nameIndex].Contains("WriteEndpointMapping.", StringComparison.Ordinal),
            $"{route}: never calls WriteEndpointMapping — the write routes' shared error-mapping seam.");
    }

    // Zero offenders and zero files walked read the same: an EndpointFiles typo, or a method this
    // scan cannot find, would still pass every assertion above.
    [Fact]
    public void TheScan_FindsAMethodBodyForEveryNamedRoute()
    {
        foreach (var (route, method) in NamedMethodRoutes)
            Assert.True(MethodBody(method) is not null, $"{route}: no method body found for {method}.");
    }

    [Fact]
    public void TheScan_FindsTheDeclaration_NotACallSite()
    {
        WithPlantedFile(
            "internal static class PlantedEndpoints\n{\n"
            + "    internal static IResult DirectHit(int x)\n    {\n"
            + "        // A call site naming DirectHit( must not be mistaken for its own declaration.\n"
            + "        return WriteEndpointMapping.NoLoadOrder(null!);\n    }\n}\n",
            file =>
            {
                Assert.Null(MethodBodyIn(file, "NoSuchMethod"));
                var body = MethodBodyIn(file, "DirectHit");
                Assert.NotNull(body);
                Assert.Contains("WriteEndpointMapping.", body, StringComparison.Ordinal);
            });
    }

    // Rebase/ContinueRebase delegate through a shared private helper (Rebased) instead of naming
    // WriteEndpointMapping inline, so the seam must be found one hop away.
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
    // WriteEndpointMapping must still fail (Rebase/ContinueRebase, before OriginNotFound existed).
    [Fact]
    public void TheScan_FailsARouteWhoseSiblingNeverReachesTheSeam()
    {
        WithPlantedFile(
            "internal static class PlantedEndpoints\n{\n"
            + "    internal static IResult ThroughAHandRolledSibling(int x)\n    {\n"
            + "        return HandRolled(x);\n    }\n\n"
            + "    private static IResult HandRolled(int x)\n    {\n"
            + "        return Results.Problem(\"not found\", statusCode: 404);\n    }\n}\n",
            file => Assert.False(MapsThroughSeamIn([file], "ThroughAHandRolledSibling")));
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

    private static bool MapsThroughSeam(string methodName) => MapsThroughSeamIn(EndpointFiles.Select(EndpointFile), methodName);

    // A route's own body is the first place to look; a body that only delegates to a shared private
    // helper is followed one call at a time, bounded by visited so a cycle between two siblings
    // cannot loop forever.
    private static bool MapsThroughSeamIn(IEnumerable<string> files, string methodName)
    {
        var fileList = files.ToArray();
        var visited = new HashSet<string>(StringComparer.Ordinal);
        return Reaches(methodName);

        bool Reaches(string method)
        {
            if (!visited.Add(method)) return false;
            var body = fileList.Select(file => MethodBodyIn(file, method)).FirstOrDefault(b => b is not null);
            if (body is null) return false;
            if (body.Contains("WriteEndpointMapping.", StringComparison.Ordinal)) return true;

            return CallSite.Matches(body)
                .Select(m => m.Groups[1].Value)
                .Distinct(StringComparer.Ordinal)
                .Any(Reaches);
        }
    }

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
