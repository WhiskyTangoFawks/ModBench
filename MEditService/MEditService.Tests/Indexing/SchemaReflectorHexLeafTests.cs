using System.Text.Json;
using MEditService.Core.Schema;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Noggog;

namespace MEditService.Tests.Indexing;

/// <summary>
/// #690: a byte slice is an ordinary reflected leaf rendered as hex, read and written, so a
/// whole-list write carries it. The document's own hex form is Mutagen's
/// (<c>NewtonsoftJsonSerializationWriterKernel.WriteBytes</c>: <c>"0x" + uppercase hex</c>,
/// <c>"[]"</c> for empty, <c>""</c> for absent), and this leaf reads and writes exactly that, so the
/// generated <c>json_extract</c> view and <see cref="ColumnSpec.Extract"/> answer the same string
/// for the same record rather than two spellings of it.
/// </summary>
public sealed class SchemaReflectorHexLeafTests
{
    private static ColumnSpec Column(string table, string column) =>
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4)[table]
            .RecordColumns.Single(c => c.Name == column);

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    /// <summary>AC #1. Every byte slice the walk reaches is classified, so none is reported as
    /// excluded or unclassified any more.</summary>
    [Fact]
    public void NoByteSliceMemberIsExcludedOrUnclassified()
    {
        var entries = new List<LogEntry>();
        using var factory = LoggerFactory.Create(b => b
            .SetMinimumLevel(LogLevel.Debug)
            .AddProvider(new CollectingLoggerProvider(entries)));
        new SchemaReflector(factory.CreateLogger<SchemaReflector>()).GetSchemas(GameRelease.Fallout4);

        var byteSlices = entries
            .Where(e => e.Message.Contains("ReadOnlyMemorySlice<Byte>", StringComparison.Ordinal))
            .Select(e => e.Message).Distinct().Order(StringComparer.Ordinal).ToList();

        Assert.True(byteSlices.Count == 0,
            $"{byteSlices.Count} byte-slice member(s) still omitted from the schema:\n  "
            + string.Join("\n  ", byteSlices));
    }

    [Fact]
    public void ByteSliceColumn_IsAHexVarcharColumn()
    {
        var col = Column("gras", "unknown3");

        Assert.Equal("hex", col.ApiType);
        Assert.Equal("VARCHAR", col.DuckDbType);
        Assert.False(col.IsArray);
        Assert.Null(col.SubFields);
        Assert.NotNull(col.Apply.Writer);
    }

    [Fact]
    public void Extract_RendersMutagensOwnHexForm()
    {
        var grass = new Grass(FormKey.Factory("123456:Fixture.esp"), Fallout4Release.Fallout4)
        {
            Unknown3 = new byte[] { 0xDE, 0xAD, 0xBE },
        };

        Assert.Equal("0xDEADBE", Column("gras", "unknown3").Extract(grass));
    }

    [Fact]
    public void Extract_EmptySlice_IsMutagensOwnEmptyMarker()
    {
        var grass = new Grass(FormKey.Factory("123456:Fixture.esp"), Fallout4Release.Fallout4)
        {
            Unknown3 = Array.Empty<byte>(),
        };

        Assert.Equal("[]", Column("gras", "unknown3").Extract(grass));
    }

    [Fact]
    public void Extract_AbsentNullableSlice_IsNull()
    {
        var worldspace = new Worldspace(FormKey.Factory("123456:Fixture.esp"), Fallout4Release.Fallout4);

        Assert.Null(Column("wrld", "offset_data").Extract(worldspace));
    }

    [Fact]
    public void Write_AnyLengthOntoAnAbsentNullableSlice_IsApplied()
    {
        var worldspace = new Worldspace(FormKey.Factory("123456:Fixture.esp"), Fallout4Release.Fallout4);
        var apply = Column("wrld", "offset_data").Apply.Writer!;

        Assert.Equal(ApplyOutcome.Applied, apply(worldspace, Json("\"0xAABBCCDD\"")));
        Assert.Equal(new byte[] { 0xAA, 0xBB, 0xCC, 0xDD }, worldspace.OffsetData!.Value.ToArray());
        Assert.Equal(ApplyOutcome.Applied, apply(worldspace, Json("null")));
        Assert.Null(worldspace.OffsetData);
    }

    /// <summary>
    /// The exclusion that still names <c>ReadOnlyMemorySlice&lt;&gt;</c> covers its non-byte
    /// elements only. Were it to match on the open generic alone, a byte slice reaching a dispatch
    /// site nobody taught would be dropped silently under a reason that is false of it — the
    /// total-classification invariant reporting an anomaly is what must happen instead.
    /// </summary>
    [Fact]
    public void TheRemainingSliceExclusion_DoesNotCoverAByteSlice()
    {
        Assert.Null(SchemaRefusals.ExcludedShapeReason(typeof(ReadOnlyMemorySlice<byte>)));
        Assert.NotNull(SchemaRefusals.ExcludedShapeReason(typeof(ReadOnlyMemorySlice<float>)));
    }

    /// <summary>Mutagen writes an absent slice as the empty string, so reading its own document
    /// back must clear the slice rather than write it zero bytes.</summary>
    [Fact]
    public void Write_MutagensAbsentMarker_ClearsANullableSlice()
    {
        var worldspace = new Worldspace(FormKey.Factory("123456:Fixture.esp"), Fallout4Release.Fallout4);
        var apply = Column("wrld", "offset_data").Apply.Writer!;
        Assert.Equal(ApplyOutcome.Applied, apply(worldspace, Json("\"0xAABB\"")));

        Assert.Equal(ApplyOutcome.Applied, apply(worldspace, Json("\"\"")));
        Assert.Null(worldspace.OffsetData);
    }

    private static ApplyOutcome Write(Grass grass, string valueJson) =>
        Column("gras", "unknown3").Apply.Writer!(grass, Json(valueJson));

    private static Grass NewGrass() =>
        new(FormKey.Factory("123456:Fixture.esp"), Fallout4Release.Fallout4)
        {
            Unknown3 = new byte[] { 0x01, 0x02, 0x03 },
        };

    [Fact]
    public void Write_HexOfTheSameLength_IsApplied()
    {
        var grass = NewGrass();

        Assert.Equal(ApplyOutcome.Applied, Write(grass, "\"0xAABBCC\""));
        Assert.Equal(new byte[] { 0xAA, 0xBB, 0xCC }, grass.Unknown3.ToArray());
    }

    /// <summary>What <see cref="ColumnSpec.Extract"/> just served is always writable again — the
    /// property every array op depends on, since an op re-applies the column's own extracted value.</summary>
    [Fact]
    public void Write_TheValueExtractJustServed_IsApplied()
    {
        var grass = NewGrass();
        var served = (string)Column("gras", "unknown3").Extract(grass)!;

        Assert.Equal(ApplyOutcome.Applied, Write(grass, JsonSerializer.Serialize(served)));
    }

    [Theory]
    [InlineData("\"0xAABB\"")]      // one byte short
    [InlineData("\"0xAABBCCDD\"")]  // one byte long
    public void Write_HexOfADifferentLength_IsRejected(string value)
    {
        var grass = NewGrass();

        Assert.Equal(ApplyOutcome.ValueRejected, Write(grass, value));
        Assert.Equal(new byte[] { 0x01, 0x02, 0x03 }, grass.Unknown3.ToArray());
    }

    /// <summary>
    /// Odd-length hex is refused by the <i>parse</i>, not incidentally by the length gate. Onto a
    /// slice with no established size there is no gate to catch it, so a parser that silently
    /// dropped the trailing half-byte would write a value the user never typed — and every other
    /// odd-length case in this file would still pass, because a truncated value happens to be the
    /// wrong length too.
    /// </summary>
    [Theory]
    [InlineData("\"0xABC\"")]
    [InlineData("\"0xAABBCCD\"")]
    public void Write_OddLengthHexOntoASliceWithNoEstablishedSize_IsRejected(string value)
    {
        var worldspace = new Worldspace(FormKey.Factory("123456:Fixture.esp"), Fallout4Release.Fallout4);

        Assert.Equal(ApplyOutcome.ValueRejected,
            Column("wrld", "offset_data").Apply.Writer!(worldspace, Json(value)));
        Assert.Null(worldspace.OffsetData);
    }

    [Theory]
    [InlineData("\"0xABC\"")]      // odd-length hex: no byte reading at all
    [InlineData("\"0xZZZZZZ\"")]   // right length, not hex
    [InlineData("\"hello!\"")]     // right length, not hex, no prefix
    [InlineData("17")]             // not a string at all
    [InlineData("[\"0xAABBCC\"]")] // an array, not a scalar
    public void Write_TextWithNoByteReading_IsRejected(string value)
    {
        var grass = NewGrass();

        Assert.Equal(ApplyOutcome.ValueRejected, Write(grass, value));
        Assert.Equal(new byte[] { 0x01, 0x02, 0x03 }, grass.Unknown3.ToArray());
    }

    // ── The same refusals, one level down (#690 AC #3) ────────────────────────
    // A sub-field applier is a different closure from a column applier, so a length gate wired only
    // at the top level would leave every nested blob writable to any length.
    //
    // A whole-list write builds each element fresh, so the size the nested gate reads is that
    // element's own constructor default, never a pre-write element at the same index — index
    // correspondence does not survive a whole-list write, and gating on it would refuse an ordinary
    // reorder past a different-length sibling (ByteSliceArrayOpEditTests.TwoModels).

    private static ApplyOutcome WriteMarkerParameters(Furniture furniture, string unknownHex) =>
        Column("furn", "marker_parameters").Apply.Writer!(
            furniture, Json($$"""[{"enabled": true, "unknown": {{unknownHex}}}]"""));

    private static Furniture NewFurniture() =>
        new(FormKey.Factory("123456:Fixture.esp"), Fallout4Release.Fallout4);

    [Fact]
    public void WriteNested_HexOfTheSizeTheElementWasBuiltWith_IsApplied()
    {
        var furniture = NewFurniture();

        Assert.Equal(ApplyOutcome.Applied, WriteMarkerParameters(furniture, "\"0xAABBCC\""));
        Assert.Equal(new byte[] { 0xAA, 0xBB, 0xCC }, furniture.MarkerParameters![0].Unknown.ToArray());
    }

    [Theory]
    [InlineData("\"0xAABB\"")]      // wrong length
    [InlineData("\"0xABC\"")]       // odd-length hex
    [InlineData("\"0xZZZZZZ\"")]    // not hex
    [InlineData("7")]              // not a string
    public void WriteNested_AnUnacceptableValue_RefusesTheWholeArray(string unknownHex)
    {
        var furniture = NewFurniture();

        Assert.Equal(ApplyOutcome.ValueRejected, WriteMarkerParameters(furniture, unknownHex));
        Assert.Null(furniture.MarkerParameters);
    }

    private static ApplyOutcome WriteDebrisModels(Debris debris, string hashesHex) =>
        Column("debr", "models").Apply.Writer!(
            debris, Json($$"""[{"percentage": 50, "model_filename": "A.nif", "texture_file_hashes": {{hashesHex}}}]"""));

    /// <summary>The gate's other half: a blob the element constructor leaves absent has no
    /// established size, so a whole-list write may give it a length the record did not hold.</summary>
    [Fact]
    public void WriteNested_OntoAVariableLengthBlob_AcceptsALengthTheRecordDidNotAlreadyHold()
    {
        var debris = new Debris(FormKey.Factory("123456:Fixture.esp"), Fallout4Release.Fallout4);

        Assert.Equal(ApplyOutcome.Applied, WriteDebrisModels(debris, "\"0xAABBCCDD\""));
        Assert.Equal(new byte[] { 0xAA, 0xBB, 0xCC, 0xDD }, debris.Models![0].TextureFileHashes!.Value.ToArray());

        Assert.Equal(ApplyOutcome.Applied, WriteDebrisModels(debris, "\"0x1122\""));
        Assert.Equal(new byte[] { 0x11, 0x22 }, debris.Models![0].TextureFileHashes!.Value.ToArray());
    }

    /// <summary>
    /// The hex applier resolves its property off the receiver's runtime type, so its own
    /// <c>SetValue</c> is an open-world call — a same-named property of another shape must decline
    /// the value rather than throw out of the write path. Pinned through the shared write
    /// (<c>LeafWriters.SetOrDecline</c>) at the one place Fallout 4 supplies a mismatched pair:
    /// <c>weap.unknown</c> is a Single, <c>Grass.Unknown</c> a Byte. No byte-slice column has such a
    /// twin today, which is exactly why the containment cannot be pinned on one directly.
    /// </summary>
    [Fact]
    public void Write_OntoARecordWhoseSameNamedPropertyIsAnotherShape_Declines()
    {
        var grass = NewGrass();

        Assert.Equal(ApplyOutcome.ValueRejected,
            Column("weap", "unknown").Apply.Writer!(grass, Json("1.5")));
    }

    /// <summary>A non-nullable slice has no null to be set to, so JSON <c>null</c> is refused the
    /// same way every other non-nullable leaf refuses it.</summary>
    [Fact]
    public void Write_NullOntoANonNullableSlice_IsRejected()
    {
        var grass = NewGrass();

        Assert.Equal(ApplyOutcome.ValueRejected, Write(grass, "null"));
    }
}
