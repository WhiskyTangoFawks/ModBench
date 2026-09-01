using MEditService.Core.Schema;
using Mutagen.Bethesda;

namespace MEditService.Tests.Indexing;

/// <summary>
/// #649: the atomic-value class — a CLR value type that is not Loqui-modelled and therefore has no
/// sub-schema of its own, presented instead through one coercion/presentation table entry that says
/// which named scalar components it decomposes into. <c>System.Drawing.Color</c> is the first (and
/// today only) entry.
///
/// <para><b>Shape is xEdit's, per ADR-0034, and it is decided per field rather than per type.</b>
/// xEdit renders a 4-byte colour two different ways, and which one a given field gets is a property
/// of that field's own definition, not of its CLR type (every one of Fallout 4's 60 Color-typed
/// getter properties is the same <c>System.Drawing.Color</c>):
/// <list type="bullet">
/// <item><c>wbByteColors</c> (wbDefinitionsCommon.pas:6291-6305) — Red/Green/Blue as U8 leaves, with
/// the fourth byte declared <c>wbUnused(1)</c> and never rendered as a field. 40 of Fallout 4's 44
/// colour definitions.</item>
/// <item><c>wbByteRGBA</c> (wbDefinitionsCommon.pas:6372-6386) — Red/Green/Blue/<b>Alpha</b>, all four
/// as U8 leaves. Exactly 4 definitions, enumerated in <c>SchemaReflector</c>'s own allowlist.</item>
/// </list>
/// The allowlist is the whole of the difference; every other Color field takes the 3-leaf shape.</para>
///
/// <para><b>Why an allowlist and not a reflected signal.</b> Mutagen decides the same question with
/// <c>ColorBinaryType</c>, but chooses it inside generated binary-translation call sites
/// (<c>frame.ReadColor(ColorBinaryType.Alpha)</c>) — it is not on the CLR type, not an attribute, and
/// not reachable from a property walk. A four-row table transcribed from xEdit is smaller than any
/// mechanism that could infer it, so ADR-0034's "genuine platform limitation" carve-out does not
/// apply: the workaround is four rows. This file already carries the same transcribed-from-xEdit
/// idiom in <c>VectorStructTypes</c>, <c>ObjectModPropertyLeafSkip</c> and <c>RecordDisplayNames</c>.</para>
///
/// <para><b>The alpha loop is closed empirically, not structurally.</b> Nothing here can assert "this
/// field has no meaningful alpha" from metadata, because the binary type is not reflectable. What is
/// asserted instead: the allowlist equals the transcribed <c>wbByteRGBA</c> set and every row of it
/// resolves to a real column (<see cref="AlphaAllowlist_EveryEntryResolvesToARealColorColumn"/>), and
/// each entry's alpha edit is proved to survive a real compile in
/// <c>ColorCompileRoundTripTests</c>. Metadata shape here, byte survival there.</para>
/// </summary>
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
        // Light.Color — wbDefinitionsFO4.pas:10539 `wbByteColors('Color')`, so no Alpha leaf, the
        // fourth byte being wbUnused(1) there. Mutagen reads it as ColorBinaryType.Alpha
        // (Light_Generated.cs:4138), i.e. the byte exists and is preserved on write; xEdit simply
        // declines to render it, and ADR-0034 says we follow xEdit.
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
    // Every row is a `wbByteRGBA(CNAM)` definition in wbDefinitionsFO4.pas, cited by line, and every
    // one is ColorBinaryType.Alpha on the Mutagen side — so xEdit's UX answer and Mutagen's write
    // capability agree at all four, and an alpha edit here can never be silently discarded.
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
        // The completeness guard on a hand-transcribed table: a typo, or a Mutagen rename of either
        // the getter interface or the property, must fail loudly here rather than silently dropping
        // that field back to the 3-leaf shape — which would look exactly like correct behaviour.
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);

        var unresolved = new List<string>();
        foreach (var (ownerGetterTypeName, propertyName) in SchemaReflector.AlphaBearingColorFields)
        {
            var schema = schemas.Values.SingleOrDefault(s => s.RecordType.Name == ownerGetterTypeName);
            if (schema == null) { unresolved.Add($"{ownerGetterTypeName} (no schema)"); continue; }

            var column = schema.RecordColumns.SingleOrDefault(c => c.PropertyName == propertyName);
            if (column == null) { unresolved.Add($"{ownerGetterTypeName}.{propertyName} (no column)"); continue; }
            if (!SubFieldNames(column).Contains("alpha"))
                unresolved.Add($"{ownerGetterTypeName}.{propertyName} (no alpha leaf)");
        }

        Assert.True(unresolved.Count == 0,
            $"AlphaBearingColorFields names a field that no longer resolves to a Color column with an " +
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
            SchemaReflector.AlphaBearingColorFields.OrderBy(e => e.OwnerGetterTypeName, StringComparer.Ordinal).ToArray());
    }
}
