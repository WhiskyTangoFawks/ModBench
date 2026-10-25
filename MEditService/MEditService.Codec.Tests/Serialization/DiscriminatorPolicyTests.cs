using System.Text.Json;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Codec.Tests.Serialization;

public sealed class DiscriminatorPolicyTests
{
    private static readonly Fallout4Mod Mod = new(ModKey.FromFileName("Discriminator.esp"), Fallout4Release.Fallout4);

    private const string Discriminator = "MutagenObjectType";

    private static GlobalFloat MakeGlobalFloat() =>
        new(Mod) { EditorID = "PolicyGlobal", Data = 2.5f };

    [Theory]
    [InlineData("glob")]
    [InlineData("globalfloat")]
    [InlineData(null)]
    public void AGlobalFloatsText_ReadsBackAGlobalFloat_UnderTheGrupSignatureIngestStoresTheLowercasedClrNameTracksSourcePathFallsBackToAndNoRecordType(string? recordType)
    {
        var text = RecordTextCodec.SerializeToText(MakeGlobalFloat(), GameRelease.Fallout4);

        using var roundTripped = JsonDocument.Parse(RecordTextCodec.RoundTrip(text, GameRelease.Fallout4, recordType));

        Assert.Equal("GlobalFloat", roundTripped.RootElement.GetProperty(Discriminator).GetString());
        Assert.Equal(2.5f, roundTripped.RootElement.GetProperty("Data").GetSingle());
    }

    [Fact]
    public void ACellsChildren_AreWrittenNamingTheirTypes_ThoughTheCellIsNot()
    {
        var cell = new Cell(Mod) { EditorID = "DiscriminatorCell" };
        cell.Persistent.Add(new PlacedObject(Mod) { EditorID = "PersistentRef" });

        var text = RecordTextCodec.SerializeToText(cell, GameRelease.Fallout4);

        using var doc = JsonDocument.Parse(text);
        Assert.False(doc.RootElement.TryGetProperty(Discriminator, out _), "CELL's group element is concrete.");
        var child = doc.RootElement.GetProperty("Persistent").EnumerateArray().Single();
        Assert.Equal("PlacedObject", child.GetProperty(Discriminator).GetString());
    }
}
