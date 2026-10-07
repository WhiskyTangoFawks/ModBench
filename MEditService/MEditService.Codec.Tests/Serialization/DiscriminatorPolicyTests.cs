using System.Text.Json;
using MEditService.Codec.Serialization;
using MEditService.Codec.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Codec.Tests.Serialization;

public sealed class DiscriminatorPolicyTests
{
    private static readonly Fallout4Mod Mod = new(ModKey.FromFileName("Discriminator.esp"), Fallout4Release.Fallout4);

    private const string Discriminator = "MutagenObjectType";

    private static RecordTextCodec Codec() => new(NullLogger<RecordTextCodec>.Instance);

    private static Weapon MakeWeapon() =>
        new(Mod) { EditorID = "PolicyWeapon", BaseDamage = 7, Value = 11 };

    private static GlobalFloat MakeGlobalFloat() =>
        new(Mod) { EditorID = "PolicyGlobal", Data = 2.5f };

    [Fact]
    public void SerializeToBytes_ForAWeapon_WritesNoTopLevelDiscriminator()
    {
        var bytes = Codec().SerializeToBytes(MakeWeapon(), GameRelease.Fallout4);

        using var doc = JsonDocument.Parse(bytes);
        Assert.False(doc.RootElement.TryGetProperty(Discriminator, out _),
            $"A concrete-element type must not self-describe:\n{System.Text.Encoding.UTF8.GetString(bytes)}");
    }

    [Fact]
    public void RoundTrip_ForAWeaponDocument_ReconstitutesFromRecordType_BecauseAConcreteElementTypeWritesNoDiscriminatorAndItsIdentityIsTheIndexsRecordType()
    {
        var weapon = ReadBack.Of<Weapon>(Codec(), MakeWeapon(), GameRelease.Fallout4, "weap");

        Assert.Equal("PolicyWeapon", weapon.EditorID);
        Assert.Equal(7u, weapon.BaseDamage);
    }

    [Fact]
    public void SerializeToBytes_ForAGlobalFloat_KeepsTheDiscriminator_BecauseADiscriminatorIsWrittenOnlyWhenTheGroupElementTypeIsAbstract()
    {
        var bytes = Codec().SerializeToBytes(MakeGlobalFloat(), GameRelease.Fallout4);

        using var doc = JsonDocument.Parse(bytes);
        Assert.Equal("GlobalFloat", doc.RootElement.GetProperty(Discriminator).GetString());
    }

    [Theory]
    [InlineData("glob")]
    [InlineData("globalfloat")]
    [InlineData(null)]
    public void RoundTrip_ForAGlobalFloatDocument_KeepsItGlobalFloat_UnderTheGrupSignatureIngestStoresTheLowercasedClrNameTracksSourcePathFallsBackToAndNoRecordType(string? recordType)
    {
        var codec = Codec();
        var text = codec.SerializeToText(MakeGlobalFloat(), GameRelease.Fallout4);

        using var roundTripped = JsonDocument.Parse(codec.RoundTrip(text, GameRelease.Fallout4, recordType));

        Assert.Equal("GlobalFloat", roundTripped.RootElement.GetProperty(Discriminator).GetString());
        Assert.Equal(2.5f, roundTripped.RootElement.GetProperty("Data").GetSingle());
    }

    [Fact]
    public void SerializeToBytes_ForACellWithChildren_KeepsTheChildrensDiscriminators()
    {
        var cell = new Cell(Mod) { EditorID = "DiscriminatorCell" };
        cell.Persistent.Add(new PlacedObject(Mod) { EditorID = "PersistentRef" });

        var bytes = Codec().SerializeToBytes(cell, GameRelease.Fallout4);

        using var doc = JsonDocument.Parse(bytes);
        Assert.False(doc.RootElement.TryGetProperty(Discriminator, out _), "CELL's group element is concrete.");
        var child = doc.RootElement.GetProperty("Persistent").EnumerateArray().Single();
        Assert.Equal("PlacedObject", child.GetProperty(Discriminator).GetString());
    }
}
