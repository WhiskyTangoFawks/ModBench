using System.Reflection;
using MEditService.Core.Commands;

namespace MEditService.Tests.Architecture;

/// <summary>The command convention, enforced rather than described (ADR-0046 invariant 3): one type
/// per gesture, one public method, applied-or-refusal returned. No interface states it, because
/// Track is asynchronous and the rest are not.</summary>
public sealed class CommandHandlerConventionTests
{
    // Each gesture's own change adds its handler here; the sweep below is what stops one arriving
    // in the namespace without joining this list.
    private static readonly Type[] Handlers = [typeof(EditRecordHandler)];

    private const string CommandsNamespace = "MEditService.Core.Commands";

    public static IEnumerable<object[]> EveryHandler => Handlers.Select(handler => new object[] { handler });

    [Theory]
    [MemberData(nameof(EveryHandler))]
    public void AHandler_OffersTheGestureAndNothingElse(Type handler) => Assert.Single(PublicMethods(handler));

    [Theory]
    [MemberData(nameof(EveryHandler))]
    public void AHandler_AnswersWhetherTheWriteLanded(Type handler)
    {
        var answer = Answered(PublicMethods(handler).Single().ReturnType);

        Assert.NotEqual(typeof(void), answer);
        Assert.NotEqual(typeof(Task), answer);
        Assert.Contains(answer.GetProperties(), member => member.PropertyType == typeof(bool));
    }

    [Theory]
    [MemberData(nameof(EveryHandler))]
    public void AHandler_SharesNoInterfaceAndNoBaseClass(Type handler)
    {
        Assert.True(handler.IsSealed, $"{handler.Name} is inheritable.");
        Assert.Equal(typeof(object), handler.BaseType);
        Assert.Empty(handler.GetInterfaces());
    }

    [Fact]
    public void EveryCommandInTheNamespace_IsAHandlerThisSuiteNames()
    {
        var found = typeof(EditRecordHandler).Assembly.GetTypes()
            .Where(type => type.IsPublic && type.Namespace == CommandsNamespace)
            .OrderBy(type => type.Name, StringComparer.Ordinal);

        Assert.Equal(Handlers.OrderBy(type => type.Name, StringComparer.Ordinal), found);
    }

    // Declared only, so the members every object has are not the gesture; a public property's
    // getter counts, which is what keeps a handler from carrying state.
    private static MethodInfo[] PublicMethods(Type handler) =>
        handler.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly);

    // Track's answer arrives later rather than in a different shape, so the task is unwrapped and
    // the spine inside it is what the convention asks about.
    private static Type Answered(Type returned) =>
        returned.IsGenericType && returned.GetGenericTypeDefinition() == typeof(Task<>)
            ? returned.GetGenericArguments()[0]
            : returned;
}
