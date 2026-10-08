using System.Reflection;
using MEditService.Commands;
using MEditService.Http.Tests.TestSupport;
using MEditService.Index.Queries;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;

namespace MEditService.Http.Tests.Architecture;

public sealed class WriteRouteHandlerTests
{
    internal static readonly (string Method, string Pattern, Type Handler)[] Routes =
    [
        ("POST", "/records/{formKey}/edit-changes", typeof(EditRecordChangesHandler)),
        ("POST", "/records/delete", typeof(DeleteRecordHandler)),
        ("POST", "/records/copy", typeof(CopyRecordHandler)),
        ("POST", "/plugins/create", typeof(CreatePluginHandler)),
        ("POST", "/plugins/track", typeof(TrackHandler)),
        ("POST", "/plugins/decompile", typeof(DecompilePluginHandler)),
        ("POST", "/plugins/compile", typeof(CompilePluginHandler)),
        ("POST", "/plugins/rename-source", typeof(RenameSourceHandler)),
        ("POST", "/plugins/{plugin}/records", typeof(CreateRecordHandler)),
        ("PUT", "/load-order", typeof(PutLoadOrderHandler)),
    ];

    private const string CommandsNamespace = "MEditService.Commands";
    private const string QueriesNamespace = "MEditService.Index.Queries";

    private static readonly string[] PrefixesWhoseMutatingRoutesAreWriteRoutes = ["/records", "/plugins"];

    public static IEnumerable<object[]> EveryRoute =>
        Routes.Select(route => new object[] { route.Method, route.Pattern, route.Handler });

    [Theory]
    [MemberData(nameof(EveryRoute))]
    public void AWriteRoute_ReachesItsOwnHandler(string method, string pattern, Type handler)
    {
        var mapped = MappedByTheHost().SingleOrDefault(route => route.Method == method && route.Pattern == pattern);

        Assert.True(mapped.Pattern != null, $"{method} {pattern} is not mapped.");
        Assert.Equal([handler], mapped.Handlers);
    }

    [Theory]
    [MemberData(nameof(EveryRoute))]
    public void AWriteRoute_IsNamedForTheGestureItsHandlerIs(string method, string pattern, Type handler)
    {
        var mapped = MappedByTheHost().Single(route => route.Method == method && route.Pattern == pattern);

        Assert.Equal(handler.Name, mapped.Name + "Handler");
    }

    [Fact]
    public void EveryWriteRoute_IsOneThisSuiteNames()
    {
        var writes = MappedByTheHost()
            .Where(route => IsWrite(route.Method, route.Pattern, route.Parameters))
            .Select(route => $"{route.Method} {route.Pattern}")
            .Order(StringComparer.Ordinal);

        Assert.Equal(
            Routes.Select(route => $"{route.Method} {route.Pattern}").Order(StringComparer.Ordinal),
            writes);
    }

    private static bool IsWrite(string method, string pattern, IReadOnlyList<Type> parameters) =>
        parameters.Any(IsHandler)
        || (method != "GET"
            && !parameters.Any(IsQueriesService)
            && Array.Exists(PrefixesWhoseMutatingRoutesAreWriteRoutes, prefix =>
                pattern.StartsWith(prefix, StringComparison.Ordinal)));

    private static bool IsQueriesService(Type type) => type.Namespace == QueriesNamespace;

    [Theory]
    [InlineData("POST", "/records/anything", false, true, false)]
    [InlineData("POST", "/records/anything", true, false, true)]
    [InlineData("POST", "/records/anything", true, true, true)]
    [InlineData("POST", "/records/anything", false, false, true)]
    [InlineData("GET", "/records/anything", false, true, false)]
    [InlineData("GET", "/records/anything", true, false, true)]
    public void ARouteIsAWrite_WhenItsHandlerTakesACommandsHandler_OrIsAMutatingRouteThatTakesNoQueriesService(
        string method, string pattern, bool takesAHandler, bool takesAQueriesService, bool write)
    {
        List<Type> parameters = [];
        if (takesAHandler) parameters.Add(typeof(CopyRecordHandler));
        if (takesAQueriesService) parameters.Add(typeof(ChildRecordQueryService));

        Assert.Equal(write, IsWrite(method, pattern, parameters));
    }

    [Fact]
    public void EveryGestureHandler_IsTheHandlerOfExactlyOneWriteRoute()
    {
        var gestures = typeof(EditRecordChangesHandler).Assembly.GetExportedTypes()
            .Where(IsHandler)
            .OrderBy(type => type.Name, StringComparer.Ordinal);

        Assert.Equal(gestures, Routes.Select(route => route.Handler).OrderBy(type => type.Name, StringComparer.Ordinal));
    }

    private static bool IsHandler(Type type) =>
        type.Namespace == CommandsNamespace && type.Name.EndsWith("Handler", StringComparison.Ordinal);

    private readonly record struct MappedRoute(
        string Method, string Pattern, string? Name, IReadOnlyList<Type> Parameters)
    {
        internal IReadOnlyList<Type> Handlers => [.. Parameters.Where(IsHandler)];
    }

    private static List<MappedRoute> MappedByTheHost()
    {
        using var app = new MEditHost();

        return [.. app.Services.GetServices<EndpointDataSource>()
            .SelectMany(source => source.Endpoints)
            .OfType<RouteEndpoint>()
            .SelectMany(endpoint => (endpoint.Metadata.GetMetadata<HttpMethodMetadata>()?.HttpMethods ?? [])
                .Select(method => new MappedRoute(
                    method,
                    "/" + (endpoint.RoutePattern.RawText ?? "").TrimStart('/'),
                    endpoint.Metadata.GetMetadata<IEndpointNameMetadata>()?.EndpointName,
                    [.. (endpoint.Metadata.GetMetadata<MethodInfo>()?.GetParameters() ?? [])
                        .Select(parameter => parameter.ParameterType)])))];
    }
}
