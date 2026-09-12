using Mutagen.Bethesda.Fallout4;

namespace MEditService.Codec.Schema;

/// <summary>The Fallout 4 condition facts overlaid on the reflected schema — the one place a
/// game-specific Mutagen type is named for an annotation row, so <see cref="SchemaAnnotations"/>
/// stays game-neutral.</summary>
internal static class Fallout4ConditionAnnotations
{
    /// <summary>Which parameter slots each function reads, from Mutagen's own
    /// <c>Condition.GetParameterTypes</c>, the table its binary writer switches on. The third slot
    /// and <c>Reference</c> are written unconditionally, so neither belongs here.</summary>
    public static IReadOnlyDictionary<string, IReadOnlyList<string>> FunctionParameterSlots { get; } =
        Enum.GetNames<Condition.Function>().ToDictionary(
            name => name,
            name => (IReadOnlyList<string>)SlotsUsedBy(Enum.Parse<Condition.Function>(name)));

    /// <summary>The <c>Reference</c> member carries a target only for the one Run On value that
    /// names one; under every other value it is unread, and xEdit shows no reference row.</summary>
    public static IReadOnlyDictionary<string, IReadOnlyList<string>> RunOnReference { get; } =
        Enum.GetNames<Condition.RunOnType>().ToDictionary(
            name => name,
            name => name == nameof(Condition.RunOnType.Reference)
                ? (IReadOnlyList<string>)[nameof(ConditionData.Reference)]
                : []);

    private static List<string> SlotsUsedBy(Condition.Function function)
    {
        var (one, two, _) = Condition.GetParameterTypes(function);
        List<string> used = [];
        if (MemberFor(one) is { } first) used.Add($"ParameterOne{first}");
        if (MemberFor(two) is { } second) used.Add($"ParameterTwo{second}");
        return used;
    }

    // Mutagen models each slot as three members and picks one by the parameter's category; an
    // unused slot is None and names no member at all.
    private static string? MemberFor(Condition.ParameterType type) => type.GetCategory() switch
    {
        Condition.ParameterCategory.Number => "Number",
        Condition.ParameterCategory.Form => "Record",
        Condition.ParameterCategory.String => "String",
        _ => null,
    };
}
