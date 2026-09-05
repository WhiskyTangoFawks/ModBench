using System.Text.Json;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Noggog;

namespace MEditService.Tests.Indexing;

/// <summary>The hex form is Mutagen's own: what the document holds is what a write accepts.</summary>
public sealed class SchemaReflectorHexLeafTests
{
    private static ColumnSpec Column(string table, string column) =>
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4)[table]
            .RecordColumns.Single(c => c.Name == column);

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

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
        var col = Column("gras", "Unknown3");

        Assert.Equal("hex", col.ApiType);
        Assert.Equal("VARCHAR", col.DuckDbType);
        Assert.False(col.IsArray);
        Assert.Null(col.SubFields);
        Assert.NotNull(col.Apply.Writer);
    }

    [Fact]
    public void Write_AnyLengthOntoAnAbsentNullableSlice_IsApplied()
    {
        var worldspace = new Worldspace(FormKey.Factory("123456:Fixture.esp"), Fallout4Release.Fallout4);
        var apply = Column("wrld", "OffsetData").Apply.Writer!;

        Assert.Equal(ApplyOutcome.Applied, apply(worldspace, Json("\"0xAABBCCDD\"")));
        Assert.Equal(new byte[] { 0xAA, 0xBB, 0xCC, 0xDD }, worldspace.OffsetData!.Value.ToArray());
        Assert.Equal(ApplyOutcome.Applied, apply(worldspace, Json("null")));
        Assert.Null(worldspace.OffsetData);
    }

    [Fact]
    public void TheRemainingSliceExclusion_DoesNotCoverAByteSlice()
    {
        Assert.Null(SchemaRefusals.ExcludedShapeReason(typeof(ReadOnlyMemorySlice<byte>)));
        Assert.NotNull(SchemaRefusals.ExcludedShapeReason(typeof(ReadOnlyMemorySlice<float>)));
    }

    [Fact]
    public void Write_MutagensAbsentMarker_ClearsANullableSlice()
    {
        var worldspace = new Worldspace(FormKey.Factory("123456:Fixture.esp"), Fallout4Release.Fallout4);
        var apply = Column("wrld", "OffsetData").Apply.Writer!;
        Assert.Equal(ApplyOutcome.Applied, apply(worldspace, Json("\"0xAABB\"")));

        Assert.Equal(ApplyOutcome.Applied, apply(worldspace, Json("\"\"")));
        Assert.Null(worldspace.OffsetData);
    }

    private static ApplyOutcome Write(Grass grass, string valueJson) =>
        Column("gras", "Unknown3").Apply.Writer!(grass, Json(valueJson));

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

    [Fact]
    public async Task Write_TheValueTheDocumentHolds_IsApplied()
    {
        var grass = NewGrass();
        var body = await new RecordTextCodec(NullLogger<RecordTextCodec>.Instance)
            .SerializeToBytesAsync(grass, GameRelease.Fallout4);
        using var document = JsonDocument.Parse(body);
        var served = document.RootElement.GetProperty("Unknown3").GetString()!;

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

    [Theory]
    [InlineData("\"0xABC\"")]
    [InlineData("\"0xAABBCCD\"")]
    public void Write_OddLengthHexOntoASliceWithNoEstablishedSize_IsRejected(string value)
    {
        var worldspace = new Worldspace(FormKey.Factory("123456:Fixture.esp"), Fallout4Release.Fallout4);

        Assert.Equal(ApplyOutcome.ValueRejected,
            Column("wrld", "OffsetData").Apply.Writer!(worldspace, Json(value)));
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

    // ── The same refusals, one level down ──
    //
    // A sub-field applier is a different closure from a column applier, so a length gate wired only at
    // the top level leaves every nested blob writable to any length.

    private static ApplyOutcome WriteMarkerParameters(Furniture furniture, string unknownHex) =>
        Column("furn", "MarkerParameters").Apply.Writer!(
            furniture, Json($$"""[{"Enabled": true, "Unknown": {{unknownHex}}}]"""));

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
        Column("debr", "Models").Apply.Writer!(
            debris, Json($$"""[{"Percentage": 50, "ModelFilename": "A.nif", "TextureFileHashes": {{hashesHex}}}]"""));

    // A whole-list write builds each element fresh, so the gate reads the constructor's own default
    // size; gating on the pre-write element instead would refuse an ordinary reorder.
    [Fact]
    public void WriteNested_OntoAVariableLengthBlob_AcceptsALengthTheRecordDidNotAlreadyHold()
    {
        var debris = new Debris(FormKey.Factory("123456:Fixture.esp"), Fallout4Release.Fallout4);

        Assert.Equal(ApplyOutcome.Applied, WriteDebrisModels(debris, "\"0xAABBCCDD\""));
        Assert.Equal(new byte[] { 0xAA, 0xBB, 0xCC, 0xDD }, debris.Models![0].TextureFileHashes!.Value.ToArray());

        Assert.Equal(ApplyOutcome.Applied, WriteDebrisModels(debris, "\"0x1122\""));
        Assert.Equal(new byte[] { 0x11, 0x22 }, debris.Models![0].TextureFileHashes!.Value.ToArray());
    }

    // No byte-slice column has a same-named twin of another shape, so the containment is pinned
    // through the one mismatched pair Fallout 4 supplies.
    [Fact]
    public void Write_OntoARecordWhoseSameNamedPropertyIsAnotherShape_Declines()
    {
        var grass = NewGrass();

        Assert.Equal(ApplyOutcome.ValueRejected,
            Column("weap", "Unknown").Apply.Writer!(grass, Json("1.5")));
    }

    [Fact]
    public void Write_NullOntoANonNullableSlice_IsRejected()
    {
        var grass = NewGrass();

        Assert.Equal(ApplyOutcome.ValueRejected, Write(grass, "null"));
    }
}
