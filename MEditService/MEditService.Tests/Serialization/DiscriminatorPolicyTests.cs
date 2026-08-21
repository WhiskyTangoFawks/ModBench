using System.Text.Json;
using MEditService.Core.Serialization;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Serialization;

/// <summary>
/// #450 S2 (ADR-0041's #444 amendment): the codec adopts the whole-mod path's <b>discriminator
/// policy</b> — a top-level <c>MutagenObjectType</c> is written only when the record's group element
/// type is abstract, so the path alone cannot say which concrete type the document holds (GLOB splits
/// into GlobalFloat/GlobalBool/…). Everything else dispatches its concrete
/// <c>&lt;Type&gt;_Serialization.Serialize</c> and carries no discriminator, exactly as the whole-mod
/// folder-split file for that record does.
///
/// <para>The type identity a non-self-describing document needs on the way back in is the index's
/// own <c>record_type</c> column. Note what that column actually holds: the schema table name (a
/// 4-char GRUP signature, <c>"weap"</c>) for a schema-known type, and the lowercased CLR type name
/// (<c>"landscape"</c>) for the handful <c>SchemaReflector</c> excludes — both are resolved here, and
/// <see cref="RecordTypeDispatchTests"/> sweeps that claim across the whole schema.</para>
/// </summary>
public sealed class DiscriminatorPolicyTests
{
    private static readonly Fallout4Mod Mod = new(ModKey.FromFileName("Discriminator.esp"), Fallout4Release.Fallout4);

    private const string Discriminator = "MutagenObjectType";

    private static RecordTextCodec Codec() => new(NullLogger<RecordTextCodec>.Instance);

    private static Weapon MakeWeapon() =>
        new(Mod) { EditorID = "PolicyWeapon", BaseDamage = 7, Value = 11 };

    private static GlobalFloat MakeGlobalFloat() =>
        new(Mod) { EditorID = "PolicyGlobal", Data = 2.5f };

    /// <summary>
    /// WEAP's group element type is the concrete <c>Weapon</c>, so the path is unambiguous and the
    /// whole-mod door writes no discriminator. The codec now matches it.
    /// </summary>
    [Fact]
    public async Task SerializeToBytesAsync_ForAWeapon_WritesNoTopLevelDiscriminator()
    {
        var bytes = await Codec().SerializeToBytesAsync(MakeWeapon(), GameRelease.Fallout4);

        using var doc = JsonDocument.Parse(bytes);
        Assert.False(doc.RootElement.TryGetProperty(Discriminator, out _),
            $"A concrete-element type must not self-describe:\n{System.Text.Encoding.UTF8.GetString(bytes)}");
    }

    /// <summary>AC2's second half: the document no longer names its type, so <c>record_type</c> does.</summary>
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

    /// <summary>
    /// The GLOB-as-GlobalFloat guarantee, preserved <i>because</i> ambiguous types are exactly the
    /// ones that keep the discriminator. Without it the schema's discovery winner decides, and a real
    /// GlobalFloat read as a GlobalBool throws on the cast (measured: "Unable to cast object of type
    /// 'System.Double' to type 'System.Boolean'").
    /// </summary>
    [Fact]
    public async Task SerializeToBytesAsync_ForAGlobalFloat_KeepsTheDiscriminator()
    {
        var bytes = await Codec().SerializeToBytesAsync(MakeGlobalFloat(), GameRelease.Fallout4);

        using var doc = JsonDocument.Parse(bytes);
        Assert.Equal("GlobalFloat", doc.RootElement.GetProperty(Discriminator).GetString());
    }

    /// <summary>
    /// Both spellings <c>record_type</c> can carry for an ambiguous type route to the discriminated
    /// path: the signature ingest stores (<c>"glob"</c>) and the lowercased CLR name Track's source
    /// path carries (<c>"globalfloat"</c>). Neither may be taken as permission to dispatch a concrete
    /// deserializer at a document that self-describes.
    /// </summary>
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

    /// <summary>
    /// Embedded children keep their discriminators, and get them from the kernel's own
    /// abstract-element rule rather than from anything this codec does: <c>Cell.Persistent</c> is an
    /// <c>ExtendedList&lt;IPlaced&gt;</c> and <c>IPlaced</c> is abstract. This is the property a
    /// "policy" implemented as post-hoc text surgery on the serialized bytes would destroy — the
    /// child lines look exactly like the top-level one.
    /// </summary>
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
