using System.Linq;
using MEditService.Core.Schema;

namespace MEditService.Tests.Indexing;

// DMGT's DamageTypes splits into two shape-named columns (damage_types: struct-shaped,
// actor_value_indices: scalar-shaped) whose names are deterministic by shape, not by which
// subclass wins schema discovery (SchemaReflector.BuildForCategory's own comment: that race is a
// reflection-order artifact no caller may pin). SchemaReflectorTests' schema-seam test and
// MultiSubclassIndexingTests' round-trip test both need "which of the two split columns holds this
// shape" — one mechanism, shared here, rather than two ad-hoc lookups that could drift apart.
internal static class DmgtSplitColumns
{
    public static ColumnSpec StructShaped(RecordTableSchema dmgt) =>
        dmgt.RecordColumns.Single(c => c.ApiType == "array" && c.ElementType?.Type == "struct");

    public static ColumnSpec ScalarShaped(RecordTableSchema dmgt) =>
        dmgt.RecordColumns.Single(c => c.ApiType == "array" && c.ElementType != null && c.ElementType.Type != "struct");
}
