using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Core.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Tests.Serialization;

/// <summary>The codec mints the document of an empty instance, so nothing outside it constructs a
/// container level in order to serialize one.</summary>
public sealed class RecordTextCodecBlankDocumentTests
{
    [Fact]
    public void BlankDocument_ForAContainerLevel_CarriesTheIdentityGiven()
    {
        var document = RecordTextCodec.BlankDocument(
            typeof(WorldspaceBlock), GameRelease.Fallout4,
            new JsonObject { ["BlockNumberX"] = 3, ["BlockNumberY"] = -2 });

        using var parsed = JsonDocument.Parse(document);
        Assert.Equal(3, parsed.RootElement.GetProperty("BlockNumberX").GetInt32());
        Assert.Equal(-2, parsed.RootElement.GetProperty("BlockNumberY").GetInt32());
    }

    [Fact]
    public void BlankDocument_IsSpelledByTheCodec_NotByTheIdentityGiven()
    {
        var document = RecordTextCodec.BlankDocument(
            typeof(WorldspaceBlock), GameRelease.Fallout4,
            new JsonObject { ["BlockNumberX"] = 3, ["BlockNumberY"] = -2 });

        Assert.Equal("{\n  \"BlockNumberY\": -2,\n  \"BlockNumberX\": 3\n}", document);
    }

    [Fact]
    public void BlankDocument_ForAContainerLevel_RoundTripsThroughTheCodec()
    {
        var document = RecordTextCodec.BlankDocument(
            typeof(WorldspaceBlock), GameRelease.Fallout4,
            new JsonObject { ["BlockNumberX"] = 3, ["BlockNumberY"] = -2 });

        var readBackAndWritten = RecordTextCodec.BlankDocument(
            typeof(WorldspaceBlock), GameRelease.Fallout4, JsonNode.Parse(document)!.AsObject());

        Assert.Equal(document, readBackAndWritten);
    }

    [Fact]
    public void BlankDocument_WithNoIdentity_NamesNoMemberAtAll()
    {
        var document = RecordTextCodec.BlankDocument(typeof(WorldspaceSubBlock), GameRelease.Fallout4, []);

        using var parsed = JsonDocument.Parse(document);
        Assert.Empty(parsed.RootElement.EnumerateObject());
    }

    [Fact]
    public void BlankDocument_ForAMajorRecordContainer_CarriesTheFormKeyAndRoundTrips()
    {
        var identity = new JsonObject { ["FormKey"] = "000802:Source.esm" };

        var document = RecordTextCodec.BlankDocument(typeof(Cell), GameRelease.Fallout4, identity);

        using var parsed = JsonDocument.Parse(document);
        Assert.Equal("000802:Source.esm", parsed.RootElement.GetProperty("FormKey").GetString());
        Assert.Equal("{\n  \"FormKey\": \"000802:Source.esm\"\n}", document);
        Assert.Equal(
            document,
            RecordTextCodec.BlankDocument(
                typeof(Cell), GameRelease.Fallout4, JsonNode.Parse(document)!.AsObject()));
    }
}
