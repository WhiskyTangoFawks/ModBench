using System.Text.Json;
using MEditService.Core.Schema;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

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

    /// <summary>A slice with no value yet has no established size, so the first write sets one.
    /// The alternative — refusing every write to a null slice because its length is not equal to
    /// nothing — would make a never-populated blob permanently unwritable.</summary>
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
    [InlineData("\"0xAABB\"", "one byte short")]
    [InlineData("\"0xAABBCCDD\"", "one byte long")]
    public void Write_HexOfADifferentLength_IsRejected(string value, string why)
    {
        var grass = NewGrass();

        Assert.Equal(ApplyOutcome.ValueRejected, Write(grass, value));
        Assert.Equal(new byte[] { 0x01, 0x02, 0x03 }, grass.Unknown3.ToArray());
        Assert.NotEmpty(why);
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

    /// <summary>Length is counted in <i>bytes</i>, not characters: six hex characters are three
    /// bytes, and a rival counting characters would accept a three-character value here.</summary>
    [Fact]
    public void Write_OddLengthHex_IsRejected()
    {
        var grass = NewGrass();

        Assert.Equal(ApplyOutcome.ValueRejected, Write(grass, "\"0xABC\""));
        Assert.Equal(new byte[] { 0x01, 0x02, 0x03 }, grass.Unknown3.ToArray());
    }

    [Theory]
    [InlineData("\"0xZZZZZZ\"")]   // right length, not hex
    [InlineData("\"hello!\"")]     // right length, not hex, no prefix
    [InlineData("17")]             // not a string at all
    [InlineData("[\"0xAABBCC\"]")] // an array, not a scalar
    public void Write_NonHex_IsRejected(string value)
    {
        var grass = NewGrass();

        Assert.Equal(ApplyOutcome.ValueRejected, Write(grass, value));
        Assert.Equal(new byte[] { 0x01, 0x02, 0x03 }, grass.Unknown3.ToArray());
    }

    // ── The same refusals, one level down (#690 AC #3) ────────────────────────
    // A sub-field applier is a different closure from a column applier, so a length gate wired only
    // at the top level would leave every nested blob — the overwhelming majority of them — writable
    // to any length. Furniture.MarkerParameters[].Unknown is a 3-byte non-nullable slice inside a
    // list element, which is exactly that shape.

    private static ApplyOutcome WriteMarkerParameters(Furniture furniture, string unknownHex) =>
        Column("furn", "marker_parameters").Apply.Writer!(
            furniture, Json($$"""[{"enabled": true, "unknown": {{unknownHex}}}]"""));

    private static Furniture NewFurniture() =>
        new(FormKey.Factory("123456:Fixture.esp"), Fallout4Release.Fallout4);

    [Fact]
    public void WriteNested_HexOfTheDeclaredLength_IsApplied()
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

    /// <summary>A non-nullable slice has no null to be set to, so JSON <c>null</c> is refused the
    /// same way every other non-nullable leaf refuses it.</summary>
    [Fact]
    public void Write_NullOntoANonNullableSlice_IsRejected()
    {
        var grass = NewGrass();

        Assert.Equal(ApplyOutcome.ValueRejected, Write(grass, "null"));
    }
}
