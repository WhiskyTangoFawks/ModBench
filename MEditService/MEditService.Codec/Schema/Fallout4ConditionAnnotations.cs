using System.Linq.Expressions;
using System.Reflection;
using Mutagen.Bethesda;

namespace MEditService.Codec.Schema;

/// <summary>The Fallout 4 condition facts overlaid on the reflected schema, read from Mutagen's
/// own types by name so no game package is referenced here.</summary>
internal static class Fallout4ConditionAnnotations
{
    private static readonly string ConditionType = $"Mutagen.Bethesda.{GameCategory.Fallout4}.Condition";

    /// <summary>Which parameter slots each function reads, from Mutagen's own
    /// <c>Condition.GetParameterTypes</c>, the table its binary writer switches on. The third slot
    /// and <c>Reference</c> are written unconditionally, so neither belongs here.</summary>
    public static IReadOnlyDictionary<string, IReadOnlyList<string>> FunctionParameterSlots() =>
        SchemaReflector.GameModule(GameCategory.Fallout4) is { } assembly
            ? SlotsByFunction(assembly)
            : new Dictionary<string, IReadOnlyList<string>>();

    /// <summary>The <c>Reference</c> member carries a target only for the one Run On value that
    /// names one; under every other value it is unread, and xEdit shows no reference row.</summary>
    public static IReadOnlyDictionary<string, IReadOnlyList<string>> RunOnReference() =>
        SchemaReflector.GameModule(GameCategory.Fallout4) is { } assembly
            ? Enum.GetNames(Found(assembly.GetType(ConditionType + "+RunOnType"))).ToDictionary(
                name => name,
                name => name == "Reference" ? (IReadOnlyList<string>)["Reference"] : [])
            : new Dictionary<string, IReadOnlyList<string>>();

    private static Dictionary<string, IReadOnlyList<string>> SlotsByFunction(Assembly assembly)
    {
        var condition = Found(assembly.GetType(ConditionType));
        var functionType = Found(condition.GetNestedType("Function"));
        var parameterType = Found(condition.GetNestedType("ParameterType"));
        var parameterTypes = StaticCall(Found(condition.GetMethod("GetParameterTypes")), functionType);
        var categoryOf = StaticCall(
            Found(assembly.GetTypes()
                .Where(t => t is { IsSealed: true, IsAbstract: true })
                .Select(t => t.GetMethod("GetCategory", [parameterType]))
                .FirstOrDefault(m => m is not null)),
            parameterType);

        return Enum.GetNames(functionType).ToDictionary(
            name => name,
            name => (IReadOnlyList<string>)SlotsUsedBy(parameterTypes(Enum.Parse(functionType, name)), categoryOf));
    }

    private static List<string> SlotsUsedBy(object parameterTypes, Func<object, object> categoryOf)
    {
        List<string> used = [];
        if (MemberFor(categoryOf, SlotOf(parameterTypes, "Item1")) is { } first)
            used.Add($"ParameterOne{first}");
        if (MemberFor(categoryOf, SlotOf(parameterTypes, "Item2")) is { } second)
            used.Add($"ParameterTwo{second}");
        return used;
    }

    private static object SlotOf(object tuple, string field) =>
        Found(Found(tuple.GetType().GetField(field)).GetValue(tuple));

    // Mutagen models each slot as three members and picks one by the parameter's category; an
    // unused slot is None and names no member at all.
    private static string? MemberFor(Func<object, object> categoryOf, object type) =>
        categoryOf(type).ToString() switch
        {
            "Number" => "Number",
            "Form" => "Record",
            "String" => "String",
            _ => null,
        };

    private static Func<object, object> StaticCall(MethodInfo method, Type parameter)
    {
        var argument = Expression.Parameter(typeof(object));
        var call = Expression.Call(method, Expression.Convert(argument, parameter));
        return Expression.Lambda<Func<object, object>>(Expression.Convert(call, typeof(object)), argument).Compile();
    }

    private static T Found<T>(T? member) where T : class =>
        member ?? throw new InvalidOperationException(
            "A Mutagen Fallout 4 condition type is not shaped as this overlay reads it.");
}
