using System.Reflection;

namespace MEditService.Http.Tests.Architecture;

public sealed class JsonOffPublicSurfaceScanTests
{
    private const string JsonNamespace = "System.Text.Json";

    private const BindingFlags Declared =
        BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly;

    private static readonly string[] Boxes =
        ["MEditService.Codec", "MEditService.Commands", "MEditService.SourceAdapter"];

    // The Index's conflict classification still reads values as JSON nodes (epic #1544, a later batch);
    // each type leaves this list when the classifier reads documents.
    private static readonly string[] ReadByTheIndexsConflictClassification =
        ["MEditService.Codec.Schema.CheckErrorBuilder", "MEditService.Codec.Schema.DocumentNodes", "MEditService.Codec.Schema.ElementKey"];

    [Fact]
    public void CodecCommandsAndSourceAdapter_ShowSystemTextJsonOnNoPublicSurface()
    {
        var types = Boxes.Select(Assembly.Load).SelectMany(a => a.GetTypes()).ToList();
        var leaks = types
            .Where(type => IsVisible(type) && !ReadByTheIndexsConflictClassification.Contains(type.FullName))
            .SelectMany(type => Surface(type).Where(IsJson).Select(json => $"{type.FullName} exposes {json.FullName}"))
            .Distinct()
            .Order(StringComparer.Ordinal)
            .ToList();

        Assert.True(types.Count > 100, "The scan read too few types; it would pass by finding nothing.");
        Assert.True(leaks.Count == 0, "System.Text.Json types on a public surface:\n" + string.Join("\n", leaks));
    }

    private static IEnumerable<Type> Surface(Type type)
    {
        var inherited = type.GetInterfaces().Concat(type.BaseType is { } baseType ? new[] { baseType } : []);
        var members = type.GetMembers(Declared).Where(IsVisible).SelectMany(Exposed);
        return inherited.Concat(members).SelectMany(Parts);
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
