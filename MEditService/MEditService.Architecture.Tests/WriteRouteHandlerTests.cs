using System.Reflection;
using MEditService.Commands;
using MEditService.Commands.Build;
using MEditService.RecordIndex.Queries;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;

namespace MEditService.Architecture.Tests;

public sealed class WriteRouteHandlerTests
{
    internal static readonly (string Method, string Pattern, Type Handler, string EndpointMethod)[] Routes =
    [
        ("POST", "/records/{formKey}/edit-changes", typeof(EditRecordChangesHandler), "EditRecordChanges"),
        ("POST", "/records/{formKey}/edit", typeof(EditRecordHandler), "EditRecord"),
        ("POST", "/records/copy", typeof(CopyRecordHandler), "CopyRecord"),
        ("POST", "/records/delete", typeof(DeleteRecordHandler), "DeleteRecord"),
        ("POST", "/plugins/{plugin}/create-record", typeof(CreateRecordHandler), "CreateRecord"),
        ("POST", "/records/delete-changes", typeof(DeleteRecordChangesHandler), "DeleteRecordChanges"),
        ("POST", "/records/copy-changes", typeof(CopyRecordChangesHandler), "CopyRecordChanges"),
        ("POST", "/plugins/create", typeof(CreatePluginHandler), "CreatePlugin"),
        ("POST", "/plugins/create-in-mod", typeof(CreatePluginInModHandler), "CreatePluginInMod"),
        ("POST", "/plugins/decompile", typeof(DecompilePluginHandler), "Decompile"),
        ("POST", "/plugins/repair-previews", typeof(RepairPreviewsHandler), "RepairPreviews"),
        ("POST", "/plugins/decompile-and-repair", typeof(DecompileAndRepairPluginHandler), "DecompileAndRepair"),
        ("POST", "/plugins/compile", typeof(CompilePluginHandler), "Compile"),
        ("POST", "/plugins/rename-source-changes", typeof(RenameSourceChangesHandler), "RenameSourceChanges"),
        ("POST", "/plugins/move-last-written", typeof(MoveLastWrittenHandler), "MoveLastWritten"),
        ("POST", "/plugins/{plugin}/create-record-changes", typeof(CreateRecordChangesHandler), "CreateRecordChanges"),
        ("PUT", "/load-order", typeof(PutLoadOrderHandler), "PutLoadOrder"),
        ("POST", "/build", typeof(BuildModHandler), "Build"),
        ("POST", "/decompile-and-commit", typeof(DecompileAndCommitModHandler), "DecompileAndCommit"),
        ("POST", "/clone-submodules", typeof(CloneSubmodulesHandler), "CloneSubmodules"),
    ];

    private const string CommandsNamespace = "MEditService.Commands";
    private const string QueriesNamespace = "MEditService.RecordIndex.Queries";

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

    public static TheoryData<string, Type[], bool> RoutesUnderRecords => new()
    {
        { "POST", [typeof(IQueries)], false },
        { "POST", [typeof(CopyRecordChangesHandler)], true },
        { "POST", [typeof(CopyRecordChangesHandler), typeof(IQueries)], true },
        { "POST", [], true },
        { "GET", [typeof(IQueries)], false },
        { "GET", [typeof(CopyRecordChangesHandler)], true },
    };

    [Theory]
    [MemberData(nameof(RoutesUnderRecords))]
    public void ARouteIsAWrite_WhenItsHandlerTakesACommandsHandler_OrIsAMutatingRouteThatTakesNoQueriesService(
        string method, Type[] parameters, bool write)
    {
        Assert.Equal(write, IsWrite(method, "/records/anything", parameters));
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
        (type.Namespace == CommandsNamespace
            || type.Namespace?.StartsWith(CommandsNamespace + ".", StringComparison.Ordinal) == true)
        && type.Name.EndsWith("Handler", StringComparison.Ordinal);

    private readonly record struct MappedRoute(
        string Method, string Pattern, string? Name, IReadOnlyList<Type> Parameters)
    {
        internal IReadOnlyList<Type> Handlers => [.. Parameters.Where(IsHandler)];
    }

    private static List<MappedRoute> MappedByTheHost()
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
                        .Select(parameter => parameter.ParameterType)])))];
    }
}
