using System.Text.Json;
using MEditService.Core.Serialization;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Serialization;

/// <summary>A discriminator is written only when the group element type is abstract (ADR-0041); otherwise
/// the type identity is the index's <c>record_type</c>.</summary>
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
    public async Task SerializeToBytesAsync_ForAWeapon_WritesNoTopLevelDiscriminator()
    {
        var bytes = await Codec().SerializeToBytesAsync(MakeWeapon(), GameRelease.Fallout4);

        using var doc = JsonDocument.Parse(bytes);
        Assert.False(doc.RootElement.TryGetProperty(Discriminator, out _),
            $"A concrete-element type must not self-describe:\n{System.Text.Encoding.UTF8.GetString(bytes)}");
    }

    [Fact]
    public async Task DeserializeFromBytesAsync_ForAWeaponDocument_ReconstitutesFromRecordType()
    {
        var codec = Codec();
        var bytes = await codec.SerializeToBytesAsync(MakeWeapon(), GameRelease.Fallout4);

        var roundTripped = await codec.DeserializeFromBytesAsync(bytes, GameRelease.Fallout4, "weap");

        var weapon = Assert.IsType<Weapon>(roundTripped);
        Assert.Equal("PolicyWeapon", weapon.EditorID);
        Assert.Equal(7u, weapon.BaseDamage);
    }

    [Fact]
    public async Task SerializeToBytesAsync_ForAGlobalFloat_KeepsTheDiscriminator()
    {
        var bytes = await Codec().SerializeToBytesAsync(MakeGlobalFloat(), GameRelease.Fallout4);

        using var doc = JsonDocument.Parse(bytes);
        Assert.Equal("GlobalFloat", doc.RootElement.GetProperty(Discriminator).GetString());
    }

    [Theory]
    [InlineData("glob")]
    [InlineData("globalfloat")]
    [InlineData(null)]
    public async Task DeserializeFromBytesAsync_ForAGlobalFloatDocument_ReturnsGlobalFloat(string? recordType)
    {
        var codec = Codec();
        var bytes = await codec.SerializeToBytesAsync(MakeGlobalFloat(), GameRelease.Fallout4);

        var roundTripped = await codec.DeserializeFromBytesAsync(bytes, GameRelease.Fallout4, recordType);

        var global = Assert.IsType<GlobalFloat>(roundTripped);
        Assert.Equal(2.5f, global.Data);
    }

    [Fact]
    public async Task SerializeToBytesAsync_ForACellWithChildren_KeepsTheChildrensDiscriminators()
    {
        var cell = new Cell(Mod) { EditorID = "DiscriminatorCell" };
        cell.Persistent.Add(new PlacedObject(Mod) { EditorID = "PersistentRef" });

        var bytes = await Codec().SerializeToBytesAsync(cell, GameRelease.Fallout4);

        using var doc = JsonDocument.Parse(bytes);
        Assert.False(doc.RootElement.TryGetProperty(Discriminator, out _), "CELL's group element is concrete.");
        var child = doc.RootElement.GetProperty("Persistent").EnumerateArray().Single();
        Assert.Equal("PlacedObject", child.GetProperty(Discriminator).GetString());
    }
}
