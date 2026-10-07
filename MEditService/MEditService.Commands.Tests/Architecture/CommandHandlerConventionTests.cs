using System.Reflection;
using MEditService.Commands.Composition;
using Microsoft.Extensions.DependencyInjection;

namespace MEditService.Commands.Tests.Architecture;

public sealed class CommandHandlerConventionTests
{
    private static readonly Type[] SingleWriteHandlers =
    [
        typeof(CreateRecordHandler),
        typeof(CreatePluginHandler),
        typeof(PutLoadOrderHandler),
        typeof(RenameSourceHandler),
    ];

    private static readonly Type[] SelectionHandlers =
    [
        typeof(DeleteRecordHandler),
        typeof(TrackHandler),
        typeof(CompilePluginHandler),
        typeof(DecompilePluginHandler),
        typeof(CopyRecordHandler),
    ];

    private static readonly Type[] HandlersThatWriteNothing =
    [
        typeof(EditRecordChangesHandler),
    ];

    private static readonly Type[] Handlers = [.. SingleWriteHandlers, .. SelectionHandlers, .. HandlersThatWriteNothing];

    private static readonly Type[] Carriers =
    [
        typeof(CompileRefusal),
        typeof(DecompileRefusal),
        typeof(PluginCreateRefusal),
        typeof(PluginCreateResult),
        typeof(PutLoadOrderRefusal),
        typeof(PutLoadOrderResult),
        typeof(RenameSourceRefusal),
        typeof(RenameSourceResult),
        typeof(TrackRefusal),
        typeof(TrackedMod),
    ];

    private const string CommandsNamespace = "MEditService.Commands";

    public static IEnumerable<object[]> EveryHandler => Handlers.Select(handler => new object[] { handler });

    [Theory]
    [MemberData(nameof(EveryHandler))]
    public void AHandler_OffersTheGestureAndNothingElse(Type handler)
    {
        var gestures = DeclaredMethodsNotRequiredByAnInterface(handler);

        Assert.True(
            gestures.Length == 1,
            $"{handler.Name} declares {gestures.Length} public methods of its own; a handler is one " +
            "gesture, and no interface may declare it.");
    }

    [Theory]
    [MemberData(nameof(EveryHandler))]
    public void AHandler_IsRegisteredByTheOneRegistration(Type handler)
    {
        var services = new ServiceCollection().AddCommandHandlers();

        Assert.Contains(services, descriptor => descriptor.ServiceType == handler);
    }

    [Fact]
    public void EveryCommandInTheNamespace_IsAHandlerOrACarrierThisSuiteNames()
    {
        var found = typeof(EditRecordChangesHandler).Assembly.GetExportedTypes()
            .Where(type => type.Namespace == CommandsNamespace)
            .OrderBy(type => type.Name, StringComparer.Ordinal);

        Assert.Equal(
            Handlers.Concat(Carriers).OrderBy(type => type.Name, StringComparer.Ordinal),
            found);
    }

    private static MethodInfo[] DeclaredMethodsNotRequiredByAnInterface(Type handler)
    {
        var required = handler.GetInterfaces()
            .SelectMany(contract => handler.GetInterfaceMap(contract).TargetMethods)
            .ToHashSet();
        return handler
            .GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly)
            .Where(method => !required.Contains(method))
            .ToArray();
    }
}
