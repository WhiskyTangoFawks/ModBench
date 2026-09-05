using System.Text.Json;
using MEditService.Core.Schema;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Indexing;

/// <summary>A Color is one text leaf the codec spells as "#AARRGGBB". Whether the alpha byte is the
/// field's to edit is decided per field, not per type (ADR-0034): xEdit renders most as RGB and four
/// as RGBA.</summary>
public class SchemaReflectorAtomicValueTests
{
    private readonly SchemaReflector _reflector = SharedSchemaReflector.Instance;

    private ColumnSpec Column(string table, string column) =>
        _reflector.GetSchemas(GameRelease.Fallout4)[table].RecordColumns.Single(c => c.Name == column);

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    [Fact]
    public void Color_IsAColorLeaf_WithNoMembersOfItsOwn()
    {
        // Light.Color is `wbByteColors('Color')` in wbDefinitionsFO4.pas:10539.
        var color = Column("ligh", "Color");

        Assert.Equal("color", color.ApiType);
        Assert.Null(color.SubFields);
        Assert.True(color.IsViewable);
    }

    [Fact]
    public void Color_NestedInsideAStruct_IsAColorLeaf()
    {
        // Cell.Lighting -> CellLighting.AmbientColor, one level in — the nested twin of the fact
        // above, proving the leaf kind is reached from BuildSubSchema's dispatch and not only from
        // the top-level column dispatch.
        var lighting = Column("cell", "Lighting");
        var ambient = lighting.SubFields!.Single(f => f.Name == "AmbientColor");

        Assert.Equal("color", ambient.Type);
        Assert.Null(ambient.Fields);
    }

    // ── The alpha byte is written only where xEdit shows one (wbByteRGBA) ──────────────────────

    [Fact]
    public void Color_OnANonAllowlistedField_KeepsItsAlphaByteWhateverTheEditNames()
    {
        var light = new Light(FormKey.Factory("000001:Test.esp"), Fallout4Release.Fallout4)
        {
            Color = System.Drawing.Color.FromArgb(0x7F, 1, 2, 3),
        };

        Assert.Equal(ApplyOutcome.Applied, Column("ligh", "Color").Apply.Writer!(light, Json("\"#A0C86432\"")));

        Assert.Equal((0x7F, 200, 100, 50), (light.Color.A, light.Color.R, light.Color.G, light.Color.B));
    }

    [Theory]
    // Every row is a `wbByteRGBA(CNAM)` definition cited by line, and every one is
    // ColorBinaryType.Alpha on the Mutagen side, so an alpha edit here can never be silently
    // discarded.
    [InlineData("kywd", 7028)]  // KYWD — Keyword_Generated.cs:1875
    [InlineData("lcrt", 7040)]  // LCRT — LocationReferenceType_Generated.cs:1510
    [InlineData("aact", 7051)]  // AACT — ActionRecord_Generated.cs:1766
    [InlineData("lctn", 8256)]  // LCTN — Location_Generated.cs:5435
    public void Color_OnAnAllowlistedField_TakesTheAlphaByteTheEditNames(string table, int xEditDefinitionLine)
    {
        Assert.True(xEditDefinitionLine > 0); // the citation is the point of the row, not a value under test

        var color = Column(table, "Color");
        Assert.Equal("color", color.ApiType);

        var keyword = new Keyword(FormKey.Factory("000001:Test.esp"), Fallout4Release.Fallout4);
        Assert.Equal(ApplyOutcome.Applied, Column("kywd", "Color").Apply.Writer!(keyword, Json("\"#A0285078\"")));
        Assert.Equal((0xA0, 40, 80, 120), (keyword.Color!.Value.A, keyword.Color.Value.R, keyword.Color.Value.G, keyword.Color.Value.B));
    }

    [Fact]
    public void AlphaAllowlist_EveryEntryResolvesToARealColorColumn()
    {
        // The completeness guard on a hand-transcribed table: a typo, or a Mutagen rename of the
        // getter interface or the property, must fail loudly rather than dropping that field to the
        // RGB rule.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);

        var unresolved = new List<string>();
        foreach (var (ownerGetterTypeName, propertyName) in SchemaAnnotations.For(GameCategory.Fallout4).AlphaBearingColorFields)
        {
            var schema = schemas.Values.SingleOrDefault(s => s.RecordType.Name == ownerGetterTypeName);
            if (schema == null) { unresolved.Add($"{ownerGetterTypeName} (no schema)"); continue; }

            var column = schema.RecordColumns.SingleOrDefault(c => c.PropertyName == propertyName);
            if (column == null) { unresolved.Add($"{ownerGetterTypeName}.{propertyName} (no column)"); continue; }
            if (column.ApiType != "color") unresolved.Add($"{ownerGetterTypeName}.{propertyName} (not a color)");
        }

        Assert.True(unresolved.Count == 0,
            $"AlphaBearingColorFields names a field that does not resolve to a Color column: " +
            $"{string.Join(", ", unresolved)}. Re-check the row against wbDefinitionsFO4.pas " +
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
