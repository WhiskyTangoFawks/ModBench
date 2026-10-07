using MEditService.PluginAdapter;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Architecture;

public sealed class PluginPortSurfaceTests
{
    private static readonly string[] LiveObjectNamespaces =
        [.. SourceTree.ReadAllowlist(
                Path.Combine(ServiceProjects.SolutionDirectory(), "BannedSymbols.Mutagen.txt"))
            .Select(line => line.Split(';')[0].Replace("N:", "", StringComparison.Ordinal))];

    [Fact]
    public void ThePort_HandsNoLiveMutagenObjectOutOrTakesOneIn()
    {
        var offenders = LiveObjectsOnThePortAndBehindItsReturnedValues(typeof(IPluginAdapter));

        Assert.True(
            offenders.Count == 0,
            "A member of IPluginAdapter names a live Mutagen object, directly or through a value it "
            + "returns. The Plugin adapter hides the game assemblies (target-architecture.d2), so the "
            + "port answers in documents and facts:\n"
            + string.Join("\n", offenders));
    }

    [Fact]
    public void ThePortScan_NamesAPlantedLiveObject_OnAMemberAndThroughAValueItReturns()
    {
        Assert.Equal(
            ["IPlantedPort.CreateEmpty: Mutagen.Bethesda.Plugins.Records.IMod",
             "IPlantedPort.Open: IPlantedHandle.Getter: Mutagen.Bethesda.Plugins.Records.IModGetter",
             "IPlantedPort.Write(plugin): Mutagen.Bethesda.Plugins.Records.IMod"],
            LiveObjectsOnThePortAndBehindItsReturnedValues(typeof(IPlantedPort)).Order(StringComparer.Ordinal));
    }

    [Fact]
    public void ThePortScan_LeavesIdentityAndTheReleaseAlone()
    {
        Assert.Empty(LiveObjectsOnThePortAndBehindItsReturnedValues(typeof(IIdentityOnlyPort)));
    }

    private static List<string> LiveObjectsOnThePortAndBehindItsReturnedValues(Type port)
    {
        var offenders = new List<string>();
        foreach (var method in port.GetMethods())
        {
            offenders.AddRange(method.GetParameters()
                .Where(p => IsLiveObject(p.ParameterType))
                .Select(p => $"{port.Name}.{method.Name}({p.Name}): {p.ParameterType.FullName}"));

            if (IsLiveObject(method.ReturnType))
                offenders.Add($"{port.Name}.{method.Name}: {method.ReturnType.FullName}");
            else
                offenders.AddRange(LiveObjectsBehindThisSolutionsOwnTypes(method.ReturnType).Select(m => $"{port.Name}.{method.Name}: {m}"));
        }
        return offenders;
    }

    private static IEnumerable<string> LiveObjectsBehindThisSolutionsOwnTypes(Type type) =>
        TheTypeAndEveryTypeArgumentInsideIt(type)
            .Where(t => t.Assembly == typeof(IPluginAdapter).Assembly
                || t.Assembly == typeof(PluginPortSurfaceTests).Assembly)
            .SelectMany(t => t.GetProperties().Select(p => (Member: $"{t.Name}.{p.Name}", Type: p.PropertyType))
                .Concat(t.GetMethods().Where(m => !m.IsSpecialName)
                    .Select(m => (Member: $"{t.Name}.{m.Name}", Type: m.ReturnType))))
            .Where(member => IsLiveObject(member.Type))
            .Select(member => $"{member.Member}: {member.Type.FullName}")
            .Distinct(StringComparer.Ordinal);

    private static IEnumerable<Type> TheTypeAndEveryTypeArgumentInsideIt(Type type) =>
        type.IsGenericType ? type.GetGenericArguments().SelectMany(TheTypeAndEveryTypeArgumentInsideIt).Append(type) : [type];

    private static bool IsLiveObject(Type type) =>
        TheTypeAndEveryTypeArgumentInsideIt(type).Any(t => LiveObjectNamespaces.Contains(t.Namespace, StringComparer.Ordinal));

    private interface IPlantedHandle
    {
        Mutagen.Bethesda.Plugins.Records.IModGetter Getter { get; }
    }

    private interface IPlantedPort
    {
        IPlantedHandle Open();
        Mutagen.Bethesda.Plugins.Records.IMod CreateEmpty();
        Task Write(Mutagen.Bethesda.Plugins.Records.IMod plugin);
    }

    private interface IIdentityOnlyPort
    {
        Task<IReadOnlyList<Mutagen.Bethesda.Plugins.FormKey>> Keys(
            Mutagen.Bethesda.Plugins.ModPath modPath, Mutagen.Bethesda.GameRelease release);
    }
}
