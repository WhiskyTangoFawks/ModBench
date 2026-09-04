using System.Linq;
using MEditService.Core.Schema;

namespace MEditService.Tests.Indexing;

// DMGT's DamageTypes splits into two shape-named columns whose names are deterministic by shape,
// not by which subclass wins schema discovery: that race is a reflection-order artifact no caller
// may pin.
internal static class DmgtSplitColumns
{
    public static ColumnSpec StructShaped(RecordTableSchema dmgt) =>
        dmgt.RecordColumns.Single(c => c.ApiType == "array" && c.ElementType?.Type == "struct");

    public static ColumnSpec ScalarShaped(RecordTableSchema dmgt) =>
        dmgt.RecordColumns.Single(c => c.ApiType == "array" && c.ElementType != null && c.ElementType.Type != "struct");
}
