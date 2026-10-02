namespace MEditService.Codec.Schema;

/// <summary>The annotated members a document never spells (<see cref="SchemaAnnotations.SyntheticFlagMembers"/>):
/// a bool column that is one flag of a flags member the document does spell.</summary>
internal static class SyntheticColumns
{
    public static IEnumerable<ColumnSpec> For(Type getterType, GameReflection game, string backingPathPrefix) =>
        game.Annotations.SyntheticFlagMembersFor(getterType).Select(row => new ColumnSpec(
            new SubFieldSpec(row.Name, "bool", LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers),
            row.Name, "BOOLEAN",
            ViewDefaultLiteral: "false",
            Synthetic: new SyntheticBit(backingPathPrefix + row.BackingMember, row.Flag)));
}
