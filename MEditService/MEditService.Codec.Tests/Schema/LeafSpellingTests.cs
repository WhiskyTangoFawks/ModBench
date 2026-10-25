using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Strings;

namespace MEditService.Codec.Tests.Schema;

public sealed class LeafSpellingTests
{
    private static readonly IReadOnlyDictionary<string, RecordTableSchema> Schemas =
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);

    private const string Bare = """{"FormKey":"000800:LeafSpelling.esp"}""";

    private static DocumentEdit.Patch Patched(string table, EditOp op, string? value, string member)
    {
        Assert.Null(DocumentEdit.Locate(Document.Parse(Bare), Schemas[table], op, [new(member, null)], out var edit));
        Assert.Null(edit.Require().Apply(value, Language.English, localized: false, out var patch));
        return patch.Require();
    }

    private static string? DroppedWhenWrittenAs(string table, string member, string patched, string? written)
    {
        var patch = Patched(table, EditOp.Set, patched, member);
        var text = written is null ? Bare : $$"""{"FormKey":"000800:LeafSpelling.esp","{{member}}":{{written}}}""";
        return patch.FirstDropped(patch.Document, Document.Parse(text));
    }

    [Theory]
    [InlineData("npc_", "NAM5", "\"0xAB12\"", "\"ab12\"", null)]
    [InlineData("npc_", "NAM5", "\"0xAB12\"", "\"0xAB13\"", "NAM5")]
    [InlineData("npc_", "TextureLighting", "\"#ff0000\"", "\"#FF0000\"", null)]
    [InlineData("npc_", "TextureLighting", "\"#FF0000\"", "\"#00FF00\"", "TextureLighting")]
    [InlineData("npc_", "Race", "\"0008aa:A.esp\"", "\"0008AA:A.esp\"", null)]
    [InlineData("npc_", "Race", "\"0008AA:A.esp\"", "\"0008AB:A.esp\"", "Race")]
    [InlineData("mato", "ProjectionVector", "\"1, 2\"", "\"1,2.0\"", null)]
    [InlineData("mato", "ProjectionVector", "\"1, 2\"", "\"1, 3\"", "ProjectionVector")]
    [InlineData("npc_", "EditorID", "\"Abc\"", "\"abc\"", "EditorID")]
    [InlineData("npc_", "HeightMax", "2", "2.0", null)]
    [InlineData("npc_", "HeightMax", "2", "\"2\"", "HeightMax")]
    [InlineData("npc_", "Flags", """["Essential"]""", """["0x2"]""", null)]
    [InlineData("npc_", "Flags", """["Essential"]""", """["0x4"]""", "Flags")]
    public void ASpellingTheCodecMayChange_IsTheSameValue_AndAnyOtherIsDroppedByName(
        string table, string member, string patched, string written, string? dropped)
    {
        Assert.Equal(dropped, DroppedWhenWrittenAs(table, member, patched, written));
    }

    [Theory]
    [InlineData("EditorID", "\"\"", null)]
    [InlineData("Race", "\"Null\"", null)]
    [InlineData("NAM5", "\"[]\"", null)]
    [InlineData("EditorID", "\"Null\"", "EditorID")]
    [InlineData("NAM5", "\"0x01\"", "NAM5")]
    public void TheSentinelAFieldIsMintedWith_IsKeptWhereTheCodecOmitsIt(string member, string patched, string? dropped)
    {
        Assert.Equal(dropped, DroppedWhenWrittenAs("npc_", member, patched, written: null));
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
    public void AStructElementAddedWithoutAValue_NamesOnlyItsDiscriminator_AsTheUnionsFirstLeaf()
    {
        var patch = Patched("cobj", EditOp.Add, null, "Conditions");

        Assert.Equal("""{"MutagenObjectType":"ConditionFloat"}""", JsonNode.Parse(patch.Document.Text).Require()["Conditions"].Require()[0].Require().ToJsonString());
    }

    [Fact]
    public void AColourHoldingNoAlpha_LandsAsMutagensBinaryReadSpellsIt()
    {
        var patch = Patched("mato", EditOp.Set, "\"#112233\"", "SinglePassColor");

        Assert.Equal("#00112233", patch.Document.StringAt("SinglePassColor"));
    }
}
