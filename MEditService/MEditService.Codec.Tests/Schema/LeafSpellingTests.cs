using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Codec.Tests.Schema;

public sealed class LeafSpellingTests
{
    private static readonly IReadOnlyDictionary<string, RecordTableSchema> Schemas =
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);

    private const string Bare = """{"FormKey":"000800:LeafSpelling.esp"}""";

    private static DocumentEdit.Patch Patched(string table, EditOp op, string? value, string member)
    {
        Assert.Null(DocumentEdit.Locate(Document.Parse(Bare), Schemas[table], op, [new(member, null)], out var edit));
        Assert.Null(edit.Require().Apply(value, out var patch));
        return patch.Require();
    }

    private static string? DroppedWhenWrittenAs(string table, string member, string patched, string? written)
    {
        var patch = Patched(table, EditOp.Set, patched, member);
        var text = written is null ? Bare : $$"""{"FormKey":"000800:LeafSpelling.esp","{{member}}":{{written}}}""";
        return patch.FirstDropped(patch.Document, Document.Parse(text));
    }

    [Theory]
    [InlineData("npc_", "NAM5", "\"0xAB12\"", "\"ab12\"", true)]
    [InlineData("npc_", "NAM5", "\"0xAB12\"", "\"0xAB13\"", false)]
    [InlineData("npc_", "TextureLighting", "\"#ff0000\"", "\"#FF0000\"", true)]
    [InlineData("npc_", "TextureLighting", "\"#FF0000\"", "\"#00FF00\"", false)]
    [InlineData("npc_", "Race", "\"0008aa:A.esp\"", "\"0008AA:A.esp\"", true)]
    [InlineData("npc_", "Race", "\"0008AA:A.esp\"", "\"0008AB:A.esp\"", false)]
    [InlineData("mato", "ProjectionVector", "\"1, 2\"", "\"1,2.0\"", true)]
    [InlineData("mato", "ProjectionVector", "\"1, 2\"", "\"1, 3\"", false)]
    [InlineData("npc_", "EditorID", "\"Abc\"", "\"abc\"", false)]
    public void ASpellingTheCodecMayChange_IsTheSameValue_AndAnyOtherIsDroppedByName(
        string table, string member, string patched, string written, bool same)
    {
        Assert.Equal(same ? null : member, DroppedWhenWrittenAs(table, member, patched, written));
    }

    [Fact]
    public void NumbersAreComparedByMagnitude_AndAKindMismatchIsNeverTheSame()
    {
        Assert.Null(DroppedWhenWrittenAs("npc_", "HeightMax", "2", "2.0"));
        Assert.Equal("HeightMax", DroppedWhenWrittenAs("npc_", "HeightMax", "2", "\"2\""));
    }

    [Fact]
    public void ABitNamedByAMemberAndTheSameBitSpelledInHex_AreTheSameBits()
    {
        Assert.Null(DroppedWhenWrittenAs("npc_", "Flags", """["Essential"]""", """["0x2"]"""));
        Assert.Equal("Flags", DroppedWhenWrittenAs("npc_", "Flags", """["Essential"]""", """["0x4"]"""));
    }

    [Theory]
    [InlineData("EditorID", "\"\"", true)]
    [InlineData("Race", "\"Null\"", true)]
    [InlineData("NAM5", "\"[]\"", true)]
    [InlineData("EditorID", "\"Null\"", false)]
    [InlineData("NAM5", "\"0x01\"", false)]
    public void TheSentinelAFieldIsMintedWith_IsKeptWhereTheCodecOmitsIt(string member, string patched, bool unset)
    {
        Assert.Equal(unset ? null : member, DroppedWhenWrittenAs("npc_", member, patched, written: null));
    }

    [Theory]
    [InlineData("race", "MovementTypeNames", "")]
    [InlineData("npc_", "Keywords", "Null")]
    [InlineData("mato", "DNAMs", "[]")]
    public void AnElementAddedWithoutAValue_IsMintedAsTheSentinelItsTypeHas(string table, string member, string sentinel)
    {
        var patch = Patched(table, EditOp.Add, null, member);

        Assert.Equal(sentinel, JsonNode.Parse(patch.Document.Text).Require()[member].Require()[0].Require().GetValue<string>());
    }

    [Fact]
    public void AStructElementAddedWithoutAValue_NamesOnlyItsDiscriminator()
    {
        var element = Schemas["cobj"].RecordColumns.Single(c => c.Name == "Conditions").Field.ElementType.Require();
        var discriminator = element.Fields.Require().Single(f => f.IsDiscriminator);

        var patch = Patched("cobj", EditOp.Add, null, "Conditions");

        var minted = JsonNode.Parse(patch.Document.Text).Require()["Conditions"].Require()[0].Require().AsObject();
        Assert.Equal([discriminator.Name], minted.Select(p => p.Key));
        Assert.Equal(discriminator.EnumMembers[0].Value, minted[discriminator.Name]?.GetValue<string>());
    }

    [Fact]
    public void AColourHoldingNoAlpha_LandsAsMutagensBinaryReadSpellsIt()
    {
        var patch = Patched("mato", EditOp.Set, "\"#112233\"", "SinglePassColor");

        Assert.Equal("#00112233", patch.Document.StringAt("SinglePassColor"));
    }
}
