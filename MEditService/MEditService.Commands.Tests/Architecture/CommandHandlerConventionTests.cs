using System.Reflection;

namespace MEditService.Commands.Tests.Architecture;

public sealed class CommandHandlerConventionTests
{
    [Fact]
    public void EveryHandler_OffersOneGesture_ThatNoInterfaceDeclares()
    {
        var offenders = typeof(EditRecordChangesHandler).Assembly.GetExportedTypes()
            .Where(type => type.Name.EndsWith("Handler", StringComparison.Ordinal))
            .Where(handler => DeclaredMethodsNotRequiredByAnInterface(handler).Length != 1)
            .Select(handler => handler.Name);

        Assert.Empty(offenders);
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
