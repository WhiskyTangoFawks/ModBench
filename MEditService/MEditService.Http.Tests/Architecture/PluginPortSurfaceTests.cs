using MEditService.PluginAdapter;
using MEditService.TestSupport.TestSupport;

namespace MEditService.Http.Tests.Architecture;

/// <summary>ADR-0005 rule 2 on the port itself: no member of <see cref="IPluginAdapter"/> names a
/// live Mutagen object, directly or through a value it returns. The banned namespaces are the
/// analyzer's own.</summary>
public sealed class PluginPortSurfaceTests
{
    private static readonly string[] LiveObjectNamespaces =
        [.. SourceTree.ReadAllowlist(
                Path.Combine(ArchitectureTests.SolutionDirectory(), "BannedSymbols.Mutagen.txt"))
            .Select(line => line.Split(';')[0].Replace("N:", "", StringComparison.Ordinal))];

    [Fact]
    public void ThePort_HandsNoLiveMutagenObjectOutOrTakesOneIn()
    {
        var offenders = LiveObjectsOn(typeof(IPluginAdapter));

        Assert.True(
            offenders.Count == 0,
            "A member of IPluginAdapter names a live Mutagen object, directly or through a value it "
            + "returns. Bytes become a mod inside the adapter alone (ADR-0005 rule 2), so the port "
            + "answers in documents and facts:\n"
            + string.Join("\n", offenders));
    }

    [Fact]
    public void ThePortScan_NamesAPlantedLiveObject_OnAMemberAndThroughAValueItReturns()
    {
        Assert.Equal(
            ["IPlantedPort.CreateEmpty: Mutagen.Bethesda.Plugins.Records.IMod",
             "IPlantedPort.Open: IPlantedHandle.Getter: Mutagen.Bethesda.Plugins.Records.IModGetter",
             "IPlantedPort.Write(plugin): Mutagen.Bethesda.Plugins.Records.IMod"],
            LiveObjectsOn(typeof(IPlantedPort)).Order(StringComparer.Ordinal));
    }

    [Fact]
    public void ThePortScan_LeavesIdentityAndTheReleaseAlone()
    {
        Assert.Empty(LiveObjectsOn(typeof(IIdentityOnlyPort)));
    }

    // A value the port returns is part of the port, so the walk goes one level past its own
    // signature. A collaborator handed in — the codec — is another box's door, and live objects are
    // that box's business.
    private static List<string> LiveObjectsOn(Type port)
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
                offenders.AddRange(LiveObjectsBehind(method.ReturnType).Select(m => $"{port.Name}.{method.Name}: {m}"));
        }
        return offenders;
    }

    // Only this solution's own types are walked into: a framework type's members are not the port's
    // vocabulary.
    private static IEnumerable<string> LiveObjectsBehind(Type type) =>
        Unwrap(type)
            .Where(t => t.Assembly == typeof(IPluginAdapter).Assembly
                || t.Assembly == typeof(PluginPortSurfaceTests).Assembly)
            .SelectMany(t => t.GetProperties().Select(p => (Member: $"{t.Name}.{p.Name}", Type: p.PropertyType))
                .Concat(t.GetMethods().Where(m => !m.IsSpecialName)
                    .Select(m => (Member: $"{t.Name}.{m.Name}", Type: m.ReturnType))))
            .Where(member => IsLiveObject(member.Type))
            .Select(member => $"{member.Member}: {member.Type.FullName}")
            .Distinct(StringComparer.Ordinal);

    // A Task<T>, a tuple or a collection is a wrapper, not the answer: what travels is its argument.
    private static IEnumerable<Type> Unwrap(Type type) =>
        type.IsGenericType ? type.GetGenericArguments().SelectMany(Unwrap).Append(type) : [type];

    private static bool IsLiveObject(Type type) =>
        Unwrap(type).Any(t => LiveObjectNamespaces.Contains(t.Namespace, StringComparer.Ordinal));

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
