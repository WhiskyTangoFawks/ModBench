using System.Text.Json.Nodes;
using MEditService.Codec.Schema;

namespace MEditService.Codec.Tests.Schema;

public sealed class LeafSpellingTests
{
    private static FieldMetadata Leaf(string type, bool holdsAlpha = false) =>
        new("Leaf", type, false, [], [], HoldsAlpha: holdsAlpha);

    private static JsonValue V(object value) => JsonValue.Create(value) ?? throw new InvalidOperationException("Not a JSON value.");

    [Theory]
    [InlineData("hex", "0xAB12", "ab12", true)]
    [InlineData("hex", "0xAB12", "0xAB13", false)]
    [InlineData("color", "#ff0000", "#FF0000", true)]
    [InlineData("color", "#FF0000", "#00FF00", false)]
    [InlineData("formKey", "0008aa:A.esp", "0008AA:A.esp", true)]
    [InlineData("formKey", "0008AA:A.esp", "0008AB:A.esp", false)]
    [InlineData("vector", "1, 2", "1,2.0", true)]
    [InlineData("vector", "1, 2", "1, 3", false)]
    [InlineData("string", "Abc", "abc", false)]
    public void Same_ASpellingTheCodecMayChange_IsTheSameValue(string type, string written, string patched, bool same)
    {
        Assert.Equal(same, LeafSpelling.Same(V(written), V(patched), Leaf(type)));
    }

    [Fact]
    public void Same_NumbersAreComparedByMagnitude_AndAKindMismatchIsNeverTheSame()
    {
        Assert.True(LeafSpelling.Same(V(2), V(2.0), Leaf("float")));
        Assert.False(LeafSpelling.Same(V(2), V("2"), Leaf("float")));
    }

    [Fact]
    public void SameFlags_ABitNamedByAMemberAndTheSameBitSpelledInHex_AreTheSameBits()
    {
        var flags = new FieldMetadata("Flags", "flags", true, [], [new EnumMember("Quest", "2")]);

        Assert.True(LeafSpelling.SameFlags(["Quest"], ["0x2"], flags));
        Assert.False(LeafSpelling.SameFlags(["Quest"], ["0x4"], flags));
    }

    [Theory]
    [InlineData("string", "", true)]
    [InlineData("formKey", "Null", true)]
    [InlineData("hex", "[]", true)]
    [InlineData("string", "Null", false)]
    [InlineData("hex", "0x01", false)]
    public void IsUnset_TheSentinelAFieldIsMintedWith_IsUnset(string type, string text, bool unset)
    {
        Assert.Equal(unset, LeafSpelling.IsUnset(V(text), Leaf(type)));
    }

    [Theory]
    [InlineData("string", "")]
    [InlineData("formKey", "Null")]
    [InlineData("hex", "[]")]
    public void Minted_ALeafIsMintedAsTheSentinelItsTypeHas(string type, string sentinel)
    {
        var minted = Assert.IsAssignableFrom<JsonValue>(LeafSpelling.Minted(Leaf(type)));

        Assert.Equal(sentinel, minted.GetValue<string>());
        Assert.True(LeafSpelling.IsUnset(minted, Leaf(type)));
    }

    [Fact]
    public void Minted_AStructNamesOnlyItsDiscriminator()
    {
        var discriminator = new FieldMetadata("Type", "enum", false, [], [new EnumMember("First"), new EnumMember("Second")], IsDiscriminator: true);
        var other = new FieldMetadata("Other", "int", false, [], []);
        var shape = new FieldMetadata("S", "struct", false, [], [], Fields: [discriminator, other]);

        var minted = Assert.IsType<JsonObject>(LeafSpelling.Minted(shape));

        Assert.Equal(["Type"], minted.Select(p => p.Key));
        Assert.Equal("First", minted["Type"]?.GetValue<string>());
    }

    [Fact]
    public void AsRead_AColourHoldingNoAlpha_LandsAsMutagensBinaryReadSpellsIt()
    {
        var read = LeafSpelling.AsRead(V("#112233"), Leaf("color"));

        Assert.Equal("#00112233", read?.GetValue<string>());
    }
}
