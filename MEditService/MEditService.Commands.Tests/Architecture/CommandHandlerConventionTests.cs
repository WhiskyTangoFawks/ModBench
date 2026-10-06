using System.Reflection;
using MEditService.Commands.Composition;
using Microsoft.Extensions.DependencyInjection;

namespace MEditService.Commands.Tests.Architecture;

public sealed class CommandHandlerConventionTests
{
    private static readonly Type[] SingleWriteHandlers =
    [
        typeof(EditRecordHandler),
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

    public static IEnumerable<object[]> EverySingleWrite => SingleWriteHandlers.Select(handler => new object[] { handler });

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
    [MemberData(nameof(EverySingleWrite))]
    public void ASingleWriteHandler_AnswersWhetherTheWriteLanded(Type handler)
    {
        const string landed = "Applied";
        var answer = AnswerCarrierUnwrappingTask(DeclaredMethodsNotRequiredByAnInterface(handler).Single().ReturnType);

        Assert.True(
            LandedType(answer, landed) == typeof(bool),
            $"{answer.Name} has no public {landed} of type bool, so {handler.Name}'s carrier does " +
            "not answer with it.");
    }

    [Theory]
    [MemberData(nameof(EveryHandler))]
    public void AHandler_SharesNoBaseClass(Type handler)
    {
        Assert.True(handler.IsSealed, $"{handler.Name} is inheritable.");
        Assert.Equal(typeof(object), handler.BaseType);
    }

    [Theory]
    [MemberData(nameof(EveryHandler))]
    public void AHandler_IsRegisteredByTheOneRegistration(Type handler)
    {
        var services = new ServiceCollection().AddCommandHandlers();

        Assert.Contains(services, descriptor => descriptor.ServiceType == handler);
    }

    [Fact]
    public void NoInterfaceIsSharedByTwoHandlers()
    {
        var shared = Handlers
            .SelectMany(handler => handler.GetInterfaces().Distinct())
            .GroupBy(contract => contract)
            .Where(group => group.Count() > 1)
            .Select(group => group.Key.Name);

        Assert.Empty(shared);
    }

    [Fact]
    public void EveryCommandInTheNamespace_IsAHandlerOrACarrierThisSuiteNames()
    {
        var found = typeof(EditRecordHandler).Assembly.GetExportedTypes()
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

    private static Type? LandedType(Type answer, string member) =>
        answer.GetProperty(member, BindingFlags.Public | BindingFlags.Instance)?.PropertyType
        ?? answer.GetField(member, BindingFlags.Public | BindingFlags.Instance)?.FieldType
        ?? answer.GetMethod(member, BindingFlags.Public | BindingFlags.Instance, Type.EmptyTypes)?.ReturnType;

    private static Type AnswerCarrierUnwrappingTask(Type returned) =>
        returned.IsGenericType && returned.GetGenericTypeDefinition() == typeof(Task<>)
            ? returned.GetGenericArguments()[0]
            : returned;
}
