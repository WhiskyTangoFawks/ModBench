using System.Reflection;
using MEditService.Commands.Composition;
using Microsoft.Extensions.DependencyInjection;

namespace MEditService.Commands.Tests.Architecture;

public sealed class CommandHandlerConventionTests
{
    private static readonly Type[] Carriers =
    [
        typeof(ArchiveRefused),
        typeof(BuildRefused),
        typeof(BuildResult),
        typeof(CompileRefusal),
        typeof(CompileRefused),
        typeof(CompileResult),
        typeof(CompiledPlugin),
        typeof(CopyRecordRefused),
        typeof(CopyRecordResult),
        typeof(CreateRecordChanges),
        typeof(DecompileAndCommitRefused),
        typeof(DecompileAndCommitResult),
        typeof(DecompiledAndCommittedMod),
        typeof(DecompileAndRepairRefusal),
        typeof(DecompileAndRepairRefused),
        typeof(DecompileAndRepairResult),
        typeof(DecompileRefusal),
        typeof(DecompileRefused),
        typeof(DecompileResult),
        typeof(DeleteRecordRefused),
        typeof(DeleteRecordResult),
        typeof(EditRecordChanges),
        typeof(ModBuilt),
        typeof(ModRestored),
        typeof(ModUpdated),
        typeof(MoveLastWrittenResult),
        typeof(PluginCreateRefusal),
        typeof(PluginCreateRefused),
        typeof(PluginRepairPreview),
        typeof(PluginToRepair),
        typeof(PutLoadOrderApplied),
        typeof(PutLoadOrderRefusal),
        typeof(PutLoadOrderRefused),
        typeof(RecordCopied),
        typeof(RecordDeleted),
        typeof(RecordEditRefused),
        typeof(RecordWritten),
        typeof(RenameSourceChanges),
        typeof(RenameSourceRefusal),
        typeof(RenameSourceResult),
        typeof(RepairPreviewsResult),
        typeof(RestoreFromManifestResult),
        typeof(RestoreRefused),
        typeof(UpdateManifestRefused),
        typeof(UpdateManifestResult),
    ];

    private const string CommandsNamespace = "MEditService.Commands";

    private static readonly Type[] Handlers =
    [
        .. typeof(EditRecordChangesHandler).Assembly.GetExportedTypes()
            .Where(type => (type.Namespace == CommandsNamespace || type.Namespace?.StartsWith(CommandsNamespace + ".", StringComparison.Ordinal) == true)
                && type.Name.EndsWith("Handler", StringComparison.Ordinal))
            .OrderBy(type => type.FullName, StringComparer.Ordinal),
    ];

    public static TheoryData<Type> EveryHandler => [.. Handlers];

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
            Handlers.Concat(Carriers).Where(type => type.Namespace == CommandsNamespace).OrderBy(type => type.Name, StringComparer.Ordinal),
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
