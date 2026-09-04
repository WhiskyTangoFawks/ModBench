using Mutagen.Bethesda.Fallout4;

namespace MEditService.Core.Schema;

/// <summary>
/// The Fallout 4 condition facts <see cref="SchemaAnnotations"/> overlays on the reflected schema.
/// Kept in its own file because it is the one place a game-specific Mutagen type is named for the
/// sake of an annotation row; <see cref="SchemaAnnotations"/> itself stays game-neutral and the
/// reflector never learns a game.
/// </summary>
internal static class Fallout4ConditionAnnotations
{
    /// <summary>
    /// Which parameter members each condition function actually uses, read from Mutagen's own
    /// <c>Condition.GetParameterTypes</c> rather than transcribed: the same table
    /// <c>FunctionConditionDataBinaryWriteTranslation.WriteBinaryParameterParsingCustom</c>
    /// switches on when it decides whether a slot goes to the wire as a number or as a FormID.
    ///
    /// <para>Only the first two slots are function-dependent. The third
    /// (<c>ConditionData.Unknown3</c> — xEdit's Parameter #3) and <c>Reference</c> are written
    /// unconditionally by <c>GetEventDataBinaryWriteTranslation.WriteCommonParams</c> whatever the
    /// function is, so neither belongs here.</para>
    ///
    /// <para>The string members are the reason this matters beyond presentation:
    /// <c>ConditionBinaryWriteTranslation.CustomStringExports</c> writes a CIS1/CIS2 subrecord for
    /// any non-null <c>ParameterOneString</c>/<c>ParameterTwoString</c> without consulting the
    /// function at all, so a string left behind by a function change is written to the plugin.
    /// Reading a stale slot is already prevented — the form-reference and check walks skip an idle
    /// member (<c>FormRefPathBuilder</c>) — but clearing one on a function change is the editor's
    /// gesture and belongs to #693, which owns the write side of this map.</para>
    /// </summary>
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
                ? (IReadOnlyList<string>)["reference"]
                : []);

    private static List<string> SlotsUsedBy(Condition.Function function)
    {
        var (one, two, _) = Condition.GetParameterTypes(function);
        List<string> used = [];
        if (MemberFor(one) is { } first) used.Add($"parameter_one_{first}");
        if (MemberFor(two) is { } second) used.Add($"parameter_two_{second}");
        return used;
    }

    // Mutagen models each slot as three members and picks one by the parameter's category; an
    // unused slot is None and names no member at all.
    private static string? MemberFor(Condition.ParameterType type) => type.GetCategory() switch
    {
        Condition.ParameterCategory.Number => "number",
        Condition.ParameterCategory.Form => "record",
        Condition.ParameterCategory.String => "string",
        _ => null,
    };
}
