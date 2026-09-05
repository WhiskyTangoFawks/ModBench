using MEditService.Core.Schema;
using Mutagen.Bethesda;

namespace MEditService.Tests.Indexing;

/// <summary>Color's shape is decided per field, not per type (ADR-0034): xEdit renders most as RGB and four
/// as RGBA.</summary>
public class SchemaReflectorAtomicValueTests
{
    private readonly SchemaReflector _reflector = SharedSchemaReflector.Instance;

    private static string[] SubFieldNames(ColumnSpec column) =>
        column.SubFields?.Select(f => f.Name).ToArray() ?? [];

    private ColumnSpec Column(string table, string column) =>
        _reflector.GetSchemas(GameRelease.Fallout4)[table].RecordColumns.Single(c => c.Name == column);

    // ── The 3-leaf shape: xEdit's wbByteColors, the overwhelming majority ──────────────────────

    [Fact]
    public void Color_OnANonAllowlistedField_IsAStructOfRedGreenBlue()
    {
        // Light.Color is `wbByteColors('Color')` in wbDefinitionsFO4.pas:10539, so no Alpha leaf,
        // the fourth byte being wbUnused(1).
        var color = Column("ligh", "color");

        Assert.Equal("struct", color.ApiType);
        Assert.Equal(["red", "green", "blue"], SubFieldNames(color));
        Assert.All(color.SubFields!, f => Assert.Equal("int", f.Type));
    }

    [Fact]
    public void Color_NestedInsideAStruct_IsAStructOfRedGreenBlue()
    {
        // Cell.Lighting -> CellLighting.AmbientColor, one level in — the nested twin of the fact
        // above, proving the atomic-value class is reached from BuildSubSchema's dispatch and not
        // only from the top-level column dispatch.
        var lighting = Column("cell", "lighting");
        var ambient = lighting.SubFields!.Single(f => f.Name == "ambient_color");

        Assert.Equal("struct", ambient.Type);
        Assert.Equal(["red", "green", "blue"], ambient.Fields!.Select(f => f.Name).ToArray());
    }

    // ── The 4-leaf shape: xEdit's wbByteRGBA, exactly four fields ──────────────────────────────

    [Theory]
    // Every row is a `wbByteRGBA(CNAM)` definition cited by line, and every one is
    // ColorBinaryType.Alpha on the Mutagen side, so an alpha edit here can never be silently
    // discarded.
    [InlineData("kywd", 7028)]  // KYWD — Keyword_Generated.cs:1875
    [InlineData("lcrt", 7040)]  // LCRT — LocationReferenceType_Generated.cs:1510
    [InlineData("aact", 7051)]  // AACT — ActionRecord_Generated.cs:1766
    [InlineData("lctn", 8256)]  // LCTN — Location_Generated.cs:5435
    public void Color_OnAnAllowlistedField_IsAStructOfRedGreenBlueAlpha(string table, int xEditDefinitionLine)
    {
        Assert.True(xEditDefinitionLine > 0); // the citation is the point of the row, not a value under test

        var color = Column(table, "color");

        Assert.Equal("struct", color.ApiType);
        Assert.Equal(["red", "green", "blue", "alpha"], SubFieldNames(color));
        Assert.All(color.SubFields!, f => Assert.Equal("int", f.Type));
    }

    [Fact]
    public void AlphaAllowlist_EveryEntryResolvesToARealColorColumn()
    {
        // The completeness guard on a hand-transcribed table: a typo, or a Mutagen rename of the
        // getter interface or the property, must fail loudly rather than dropping that field to the
        // 3-leaf shape.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);

        var unresolved = new List<string>();
        foreach (var (ownerGetterTypeName, propertyName) in SchemaAnnotations.For(GameCategory.Fallout4).AlphaBearingColorFields)
        {
            var schema = schemas.Values.SingleOrDefault(s => s.RecordType.Name == ownerGetterTypeName);
            if (schema == null) { unresolved.Add($"{ownerGetterTypeName} (no schema)"); continue; }

            var column = schema.RecordColumns.SingleOrDefault(c => c.PropertyName == propertyName);
            if (column == null) { unresolved.Add($"{ownerGetterTypeName}.{propertyName} (no column)"); continue; }
            if (!SubFieldNames(column).Contains("alpha"))
                unresolved.Add($"{ownerGetterTypeName}.{propertyName} (no alpha leaf)");
        }

        Assert.True(unresolved.Count == 0,
            $"AlphaBearingColorFields names a field that does not resolve to a Color column with an " +
            $"alpha leaf: {string.Join(", ", unresolved)}. Re-check the row against wbDefinitionsFO4.pas " +
            "and the Mutagen getter — don't just delete it.");
    }

    [Fact]
    public void AlphaAllowlist_IsExactlyTheFourTranscribedXEditRgbaFields()
    {
        // Pins the table's size and contents against the transcription, so growing it is a deliberate
        // act with a reference line to cite rather than an incidental edit.
        Assert.Equal(
            [
                ("IActionRecordGetter", "Color"),
                ("IKeywordGetter", "Color"),
                ("ILocationGetter", "Color"),
                ("ILocationReferenceTypeGetter", "Color"),
            ],
            SchemaAnnotations.For(GameCategory.Fallout4).AlphaBearingColorFields.OrderBy(e => e.TypeName, StringComparer.Ordinal).ToArray());
    }
}
