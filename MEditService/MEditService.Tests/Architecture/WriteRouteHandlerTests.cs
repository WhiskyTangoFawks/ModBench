using System.Reflection;
using MEditService.Commands;
using MEditService.Tests.Api;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;

namespace MEditService.Tests.Architecture;

/// <summary>Every write route reaches a handler named for its gesture, and the handlers and the
/// gestures are one set (ADR-0014 invariant 3). No route is excused, so a gesture written inline in
/// its endpoint fails here.</summary>
[Collection(WebHostCollection.Name)]
public sealed class WriteRouteHandlerTests
{
    // The wire door for each gesture, and the type behind it. Spelled rather than derived, so a
    // route that stops reaching its handler fails here rather than following the change.
    private static readonly (string Method, string Pattern, Type Handler)[] Routes =
    [
        ("POST", "/records/{formKey}/edit", typeof(EditRecordHandler)),
        ("POST", "/records/{formKey}/delete", typeof(DeleteRecordHandler)),
        ("POST", "/records/{formKey}/renumber", typeof(RenumberRecordHandler)),
        ("POST", "/records/{formKey}/copy-as-override", typeof(CopyRecordAsOverrideHandler)),
        ("POST", "/records/{formKey}/copy-as-new-record", typeof(CopyRecordAsNewRecordHandler)),
        ("POST", "/plugins/create", typeof(CreatePluginHandler)),
        ("POST", "/plugins/track", typeof(TrackHandler)),
        ("POST", "/plugins/{plugin}/compile", typeof(CompilePluginHandler)),
        ("POST", "/plugins/{plugin}/records", typeof(CreateRecordHandler)),
        ("POST", "/plugins/external-change/absorb", typeof(AbsorbExternalChangeHandler)),
        ("POST", "/plugins/external-change/keep", typeof(KeepExternalChangeHandler)),
        ("POST", "/plugins/rebase", typeof(RebaseEditBranchHandler)),
        ("POST", "/plugins/rebase/continue", typeof(ContinueRebaseEditBranchHandler)),
        ("PUT", "/load-order", typeof(PutLoadOrderHandler)),
        // A read, and still a gesture: what Create and Renumber would allocate, asked without
        // allocating it (ruling 7).
        ("GET", "/plugins/{plugin}/records/next-form-key", typeof(PeekNextFreeFormKeyHandler)),
    ];

    private const string CommandsNamespace = "MEditService.Commands";

    // The two prefixes the record and plugin gestures live under. A mutating route under either is a
    // write route whether or not anyone gave it a handler.
    private static readonly string[] GesturePrefixes = ["/records", "/plugins"];

    public static IEnumerable<object[]> EveryRoute =>
        Routes.Select(route => new object[] { route.Method, route.Pattern, route.Handler });

    [Theory]
    [MemberData(nameof(EveryRoute))]
    public void AWriteRoute_ReachesItsOwnHandler(string method, string pattern, Type handler)
    {
        var mapped = Mapped().SingleOrDefault(route => route.Method == method && route.Pattern == pattern);

        Assert.True(mapped.Pattern != null, $"{method} {pattern} is not mapped.");
        Assert.Equal([handler], mapped.Handlers);
    }

    [Theory]
    [MemberData(nameof(EveryRoute))]
    public void AWriteRoute_IsNamedForTheGestureItsHandlerIs(string method, string pattern, Type handler)
    {
        var mapped = Mapped().Single(route => route.Method == method && route.Pattern == pattern);

        Assert.Equal(handler.Name, mapped.Name + "Handler");
    }

    [Fact]
    public void EveryWriteRoute_IsOneThisSuiteNames()
    {
        var writes = Mapped()
            .Where(route => route.Handlers.Count > 0
                || (route.Method != "GET"
                    && Array.Exists(GesturePrefixes, prefix =>
                        route.Pattern.StartsWith(prefix, StringComparison.Ordinal))))
            .Select(route => $"{route.Method} {route.Pattern}")
            .Order(StringComparer.Ordinal);

        Assert.Equal(
            Routes.Select(route => $"{route.Method} {route.Pattern}").Order(StringComparer.Ordinal),
            writes);
    }

    [Fact]
    public void EveryGestureHandler_IsTheHandlerOfExactlyOneWriteRoute()
    {
        var gestures = typeof(EditRecordHandler).Assembly.GetExportedTypes()
            .Where(IsHandler)
            .OrderBy(type => type.Name, StringComparer.Ordinal);

        Assert.Equal(gestures, Routes.Select(route => route.Handler).OrderBy(type => type.Name, StringComparer.Ordinal));
    }

    // The carriers the gestures answer with share this namespace (ADR-0014 invariant 4), and only a
    // handler is routed. CommandHandlerConventionTests is what holds the namespace to those two.
    private static bool IsHandler(Type type) =>
        type.Namespace == CommandsNamespace && type.Name.EndsWith("Handler", StringComparison.Ordinal);

    private readonly record struct MappedRoute(
        string Method, string Pattern, string? Name, IReadOnlyList<Type> Handlers);

    // The routes the host maps, not the ones a file lists: an endpoint's own delegate says which
    // handler it takes, and a route with none says so by taking nothing.
    private static List<MappedRoute> Mapped()
    {
        using var app = new WebApplicationFactory<Program>();

        return [.. app.Services.GetServices<EndpointDataSource>()
            .SelectMany(source => source.Endpoints)
            .OfType<RouteEndpoint>()
            .SelectMany(endpoint => (endpoint.Metadata.GetMetadata<HttpMethodMetadata>()?.HttpMethods ?? [])
                .Select(method => new MappedRoute(
                    method,
                    "/" + (endpoint.RoutePattern.RawText ?? "").TrimStart('/'),
                    endpoint.Metadata.GetMetadata<IEndpointNameMetadata>()?.EndpointName,
                    [.. (endpoint.Metadata.GetMetadata<MethodInfo>()?.GetParameters() ?? [])
                        .Select(parameter => parameter.ParameterType)
                        .Where(IsHandler)])))];
    }
}
