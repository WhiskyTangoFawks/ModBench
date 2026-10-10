using System.Reflection;

namespace MEditService.Architecture.Tests;

public sealed class JsonOffPublicSurfaceScanTests
{
    private const string JsonNamespace = "System.Text.Json";

    private const BindingFlags Declared =
        BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly;

    private static readonly string[] Boxes =
        ["MEditService.Codec", "MEditService.Commands", "MEditService.SourceAdapter"];

    private static readonly string[] ReadByTheIndexsOwnJsonReads =
    [
        "MEditService.Codec.Schema.CheckErrorBuilder.Build",
        "MEditService.Codec.Schema.DocumentNodes.ComparedText",
        "MEditService.Codec.Schema.DocumentNodes.VariantFor",
        "MEditService.Codec.Schema.ElementKey.Of",
        "MEditService.Codec.Schema.ElementKey.SortKeyOf",
    ];

    [Fact]
    public void CodecCommandsAndSourceAdapter_ShowSystemTextJsonOnNoPublicSurface_ButTheIndexsOwnJsonReads()
    {
        var leaks = Leaks(Boxes.Select(Assembly.Load).SelectMany(a => a.GetTypes()));

        Assert.Equal(ReadByTheIndexsOwnJsonReads, leaks.Intersect(ReadByTheIndexsOwnJsonReads).Order(StringComparer.Ordinal));
        var unexpected = leaks.Except(ReadByTheIndexsOwnJsonReads).ToList();
        Assert.True(unexpected.Count == 0, "System.Text.Json types on a public surface:\n" + string.Join("\n", unexpected));
    }

    [Fact]
    public void TheScan_NamesAPublicMemberThatExposesJson()
    {
        Assert.Equal([$"{typeof(PlantedLeak).FullName}.Probe"], Leaks([typeof(PlantedLeak)]));
    }

    public sealed class PlantedLeak
    {
        public static System.Text.Json.JsonElement? Probe() => null;
    }

    private static List<string> Leaks(IEnumerable<Type> types) =>
        [.. types
            .Where(IsVisible)
            .SelectMany(type => Surface(type))
            .Distinct()
            .Order(StringComparer.Ordinal)];

    private static IEnumerable<string> Surface(Type type)
    {
        var inherited = type.GetInterfaces().Concat(type.BaseType is { } baseType ? new[] { baseType } : []);
        if (inherited.SelectMany(Parts).Any(IsJson)) yield return type.FullName ?? type.Name;
        foreach (var member in type.GetMembers(Declared).Where(IsVisible))
        {
            if (Exposed(member).SelectMany(Parts).Any(IsJson)) yield return $"{type.FullName}.{member.Name}";
        }
    }

    private static IEnumerable<Type> Exposed(MemberInfo member) => member switch
    {
        FieldInfo field => [field.FieldType],
        PropertyInfo property => [property.PropertyType, .. property.GetIndexParameters().Select(p => p.ParameterType)],
        EventInfo @event => @event.EventHandlerType is { } handler ? new[] { handler } : [],
        MethodBase method => method.GetParameters().Select(p => p.ParameterType).Concat(method is MethodInfo m ? new[] { m.ReturnType } : []),
        _ => [],
    };

    private static IEnumerable<Type> Parts(Type type)
    {
        yield return type;
        var inner = type.HasElementType ? type.GetElementType() : null;
        foreach (var part in (inner is null ? [] : new[] { inner }).Concat(type.IsGenericType ? type.GetGenericArguments() : []))
            foreach (var nested in Parts(part))
                yield return nested;
    }

    private static bool IsJson(Type type) => type.Namespace?.StartsWith(JsonNamespace, StringComparison.Ordinal) == true;

    private static bool IsVisible(Type type) => type.IsVisible || type.IsNestedFamily || type.IsNestedFamORAssem;

    private static bool IsVisible(MemberInfo member) => member switch
    {
        FieldInfo f => f.IsPublic || f.IsFamily || f.IsFamilyOrAssembly,
        MethodBase m => m.IsPublic || m.IsFamily || m.IsFamilyOrAssembly,
        PropertyInfo p => p.GetAccessors(true).Any(IsVisible),
        EventInfo e => e.GetAddMethod(true) is { } add && IsVisible(add),
        _ => false,
    };
}
