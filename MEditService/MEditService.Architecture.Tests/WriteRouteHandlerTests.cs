using System.Reflection;
using MEditService.Commands;
using MEditService.RecordIndex.Queries;
using MEditService.TestSupport;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;

namespace MEditService.Architecture.Tests;

public sealed class WriteRouteHandlerTests
{
    private const string CommandsNamespace = "MEditService.Commands";
    private const string QueriesNamespace = "MEditService.RecordIndex.Queries";

    private static readonly string[] PrefixesWhoseMutatingRoutesAreWriteRoutes = ["/records", "/plugins"];

    internal static readonly Lazy<IReadOnlyList<WriteRoute>> WriteRoutes = new(MappedWriteRoutes);

    internal sealed record WriteRoute(string Route, string EndpointFile, string EndpointMethod, IReadOnlyList<Type> Handlers);

    [Fact]
    public void EachWriteRoute_TakesOneGesturesHandler_AndEachGestureHasOneWriteRoute()
    {
        var gestures = typeof(EditRecordChangesHandler).Assembly.GetExportedTypes().Where(IsHandler).Select(type => type.FullName);

        Assert.Empty(WriteRoutes.Value.Where(route => route.Handlers.Count != 1).Select(route => route.Route));
        Assert.Equal(
            gestures.Order(StringComparer.Ordinal),
            WriteRoutes.Value.SelectMany(route => route.Handlers).Select(type => type.FullName).Order(StringComparer.Ordinal));
    }

    public static TheoryData<string, Type[]> WritesUnderRecords => new()
    {
        { "POST", [typeof(CopyRecordChangesHandler), typeof(IQueries)] },
        { "GET", [typeof(CopyRecordChangesHandler)] },
        { "POST", [] },
    };

    [Theory]
    [MemberData(nameof(WritesUnderRecords))]
    public void ARouteIsAWrite_WhenItTakesACommandsHandler_OrIsAMutatingRouteThatTakesNoQueriesService(string method, Type[] parameters)
    {
        Assert.True(IsWrite(method, "/records/anything", parameters));
    }

    private static bool IsWrite(string method, string pattern, IReadOnlyList<Type> parameters) =>
        parameters.Any(IsHandler)
        || (method != "GET"
            && !parameters.Any(type => type.Namespace == QueriesNamespace)
            && Array.Exists(PrefixesWhoseMutatingRoutesAreWriteRoutes, prefix =>
                pattern.StartsWith(prefix, StringComparison.Ordinal)));

    private static bool IsHandler(Type type) =>
        (type.Namespace == CommandsNamespace
            || type.Namespace?.StartsWith(CommandsNamespace + ".", StringComparison.Ordinal) == true)
        && type.Name.EndsWith("Handler", StringComparison.Ordinal);

    private static List<WriteRoute> MappedWriteRoutes()
    {
        using var app = new WebApplicationFactory<Program>();

        return [.. app.Services.GetServices<EndpointDataSource>()
            .SelectMany(source => source.Endpoints)
            .OfType<RouteEndpoint>()
            .Where(endpoint => endpoint.Metadata.GetMetadata<MethodInfo>() is not null)
            .SelectMany(endpoint => (endpoint.Metadata.GetMetadata<HttpMethodMetadata>()?.HttpMethods ?? [])
                .Select(method => (
                    Method: method,
                    Pattern: "/" + (endpoint.RoutePattern.RawText ?? "").TrimStart('/'),
                    Name: endpoint.Metadata.GetMetadata<IEndpointNameMetadata>()?.EndpointName,
                    Answering: endpoint.Metadata.GetMetadata<MethodInfo>().Require())))
            .Select(route => (route.Method, route.Pattern, route.Name, route.Answering,
                Parameters: route.Answering.GetParameters().Select(parameter => parameter.ParameterType).ToList()))
            .Where(route => IsWrite(route.Method, route.Pattern, route.Parameters))
            .Select(route => new WriteRoute(
                $"{route.Method} {route.Pattern}",
                OutermostTypeOf(route.Answering).Name + ".cs",
                IsLambda(route.Answering) ? route.Name ?? route.Answering.Name : route.Answering.Name,
                [.. route.Parameters.Where(IsHandler)]))
            .OrderBy(route => route.Route, StringComparer.Ordinal)];
    }

    private static bool IsLambda(MethodInfo method) => method.Name.Contains('<', StringComparison.Ordinal);

    private static Type OutermostTypeOf(MethodInfo method)
    {
        var type = method.DeclaringType.Require();
        while (type.DeclaringType is { } outer) type = outer;
        return type;
    }
}
