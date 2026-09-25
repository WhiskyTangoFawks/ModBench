using System.Reflection;
using MEditService.Commands;
using MEditService.Commands.Composition;
using Microsoft.Extensions.DependencyInjection;

namespace MEditService.Commands.Tests.Architecture;

/// <summary>The command convention, enforced rather than described (ADR-0014 invariant 3): one type
/// per gesture, one public method, applied-or-refusal returned. No interface states it, because
/// Track is asynchronous and the rest are not.</summary>
public sealed class CommandHandlerConventionTests
{
    // Each gesture's change appends its handler and the member its carrier answers with. Spelled
    // rather than nameof, so a carrier that stops answering fails here rather than following a
    // rename.
    private static readonly (Type Handler, string Landed)[] Handlers =
    [
        (typeof(EditRecordHandler), "Applied"),
        (typeof(DeleteRecordHandler), "AllApplied"),
        (typeof(CreateRecordHandler), "Applied"),
        (typeof(TrackHandler), "AllApplied"),
        (typeof(CompilePluginHandler), "Succeeded"),
        (typeof(CopyRecordAsOverrideHandler), "Applied"),
        (typeof(CopyRecordAsNewRecordHandler), "Applied"),
        (typeof(AbsorbExternalChangeHandler), "AllApplied"),
        (typeof(KeepExternalChangeHandler), "Applied"),
        (typeof(CreatePluginHandler), "Applied"),
        (typeof(PutLoadOrderHandler), "Applied"),
    ];

    // What the gestures answer and report through, each with its own refusal vocabulary. The carrier
    // is the gesture's own (ADR-0014 invariant 4).
    private static readonly Type[] Carriers =
    [
        typeof(AbsorbResult),
        typeof(ExternalChangeLandResult),
        typeof(PluginCreateResult),
        typeof(PutLoadOrderRefusal),
        typeof(PutLoadOrderResult),
        typeof(TrackRefusal),
        typeof(TrackRefused),
        typeof(TrackResult),
        typeof(TrackSelectionResult),
    ];

    private const string CommandsNamespace = "MEditService.Commands";

    public static IEnumerable<object[]> EveryHandler => Handlers.Select(entry => new object[] { entry.Handler });

    public static IEnumerable<object[]> EveryAnswer =>
        Handlers.Select(entry => new object[] { entry.Handler, entry.Landed });

    [Theory]
    [MemberData(nameof(EveryHandler))]
    public void AHandler_OffersTheGestureAndNothingElse(Type handler)
    {
        var gestures = GestureMethods(handler);

        Assert.True(
            gestures.Length == 1,
            $"{handler.Name} declares {gestures.Length} public methods of its own; a handler is one " +
            "gesture, and no interface may declare it.");
    }

    [Theory]
    [MemberData(nameof(EveryAnswer))]
    public void AHandler_AnswersWhetherTheWriteLanded(Type handler, string landed)
    {
        var answer = Answered(GestureMethods(handler).Single().ReturnType);

        Assert.True(
            LandedType(answer, landed) == typeof(bool),
            $"{answer.Name} has no public {landed} of type bool, so {handler.Name}'s carrier does " +
            "not answer with it (ADR-0014 invariant 4).");
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

    // IDisposable on one handler is neither of the things ruling 2 forbids; an interface two
    // handlers share is the shared handler interface by another name.
    [Fact]
    public void NoInterface_IsSharedAcrossHandlers()
    {
        var shared = Handlers
            .SelectMany(entry => entry.Handler.GetInterfaces().Distinct())
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
            Handlers.Select(entry => entry.Handler).Concat(Carriers).OrderBy(type => type.Name, StringComparer.Ordinal),
            found);
    }

    // Declared only, so the members every object has are not the gesture, and minus what an
    // interface asks for, so implementing one is not a second gesture.
    private static MethodInfo[] GestureMethods(Type handler)
    {
        var required = handler.GetInterfaces()
            .SelectMany(contract => handler.GetInterfaceMap(contract).TargetMethods)
            .ToHashSet();
        return handler
            .GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly)
            .Where(method => !required.Contains(method))
            .ToArray();
    }

    // A property, a field or a parameterless method: which of the three a gesture's own carrier
    // uses is its business, and the entry above names the member either way.
    private static Type? LandedType(Type answer, string member) =>
        answer.GetProperty(member, BindingFlags.Public | BindingFlags.Instance)?.PropertyType
        ?? answer.GetField(member, BindingFlags.Public | BindingFlags.Instance)?.FieldType
        ?? answer.GetMethod(member, BindingFlags.Public | BindingFlags.Instance, Type.EmptyTypes)?.ReturnType;

    // Track's answer arrives later rather than in a different shape, so the task is unwrapped and
    // the carrier inside it is what the convention asks about.
    private static Type Answered(Type returned) =>
        returned.IsGenericType && returned.GetGenericTypeDefinition() == typeof(Task<>)
            ? returned.GetGenericArguments()[0]
            : returned;
}
