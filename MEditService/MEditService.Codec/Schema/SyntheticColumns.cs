using System.Globalization;

namespace MEditService.Codec.Schema;

/// <summary>The annotated members a document never spells (<see cref="SchemaAnnotations.SyntheticFlagMembers"/>):
/// a bool column that is one bit of a flags member the document does spell.</summary>
internal static class SyntheticColumns
{
    public static IEnumerable<ColumnSpec> For(
        Type getterType, GameReflection game, string backingPathPrefix, Func<string, IReadOnlyList<EnumMember>> backingNames)
    {
        foreach (var (name, backingMember, flag) in game.Annotations.SyntheticFlagMembersFor(getterType))
        {
            var names = backingNames(backingMember);
            var bit = names.Count == 0
                ? SchemaAnnotations.ParseBit(flag)
                : long.Parse(names.Single(m => m.Value == flag).BitValue!, CultureInfo.InvariantCulture);
            var aliases = names.Count == 0 ? game.Defaults.MembersAliasing(getterType, backingMember, bit) : [];
            yield return new ColumnSpec(
                new SubFieldSpec(name, "bool", LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers),
                name, "BOOLEAN",
                ViewDefaultLiteral: "false",
                Synthetic: new SyntheticBit(backingPathPrefix + backingMember, bit, names.Count == 0 ? null : flag, aliases));
        }
    }
}
