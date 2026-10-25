using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Tests.Schema;

public class PartialFormFlagTests
{
    private const int PartialFormBit = 0x0000_4000;

    private static Fallout4Mod MakeMod() => new(ModKey.FromFileName("PartialFormFlag.esp"), Fallout4Release.Fallout4);

    private static readonly Dictionary<string, (Func<IMajorRecordGetter> Record, string Table)> Records = new(StringComparer.Ordinal)
    {
        ["a cell carrying bit 14"] = (() => new Cell(MakeMod()) { EditorID = "SomeCell", MajorRecordFlagsRaw = PartialFormBit }, "cell"),
        ["a cell without bit 14"] = (() => new Cell(MakeMod()) { EditorID = "SomeCell" }, "cell"),
        ["an npc carrying bit 14, which means something else on a type with no Partial Form flag"] =
            (() => new Npc(MakeMod()) { EditorID = "SomeNpc", MajorRecordFlagsRaw = PartialFormBit }, "npc_"),
    };

    [Theory]
    [InlineData("a cell carrying bit 14", true)]
    [InlineData("a cell without bit 14", false)]
    [InlineData("an npc carrying bit 14, which means something else on a type with no Partial Form flag", false)]
    public void ARecord_IsAPartialForm_ExactlyWhenItsTypeDeclaresTheFlagAndItCarriesBit14(string record, bool partialForm)
    {
        var (made, table) = Records[record];
        var document = Document.Parse(RecordTextCodec.SerializeToText(made(), GameRelease.Fallout4));

        Assert.Equal(partialForm, SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4)[table].IsPartialForm(document));
    }

    [Theory]
    [InlineData("cell", true)]
    [InlineData("npc_", false)]
    public void ARecordType_IsPartialFormable_ExactlyWhenItDeclaresThePartialFormFlag(string table, bool partialFormable)
    {
        Assert.Equal(partialFormable, SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4)[table].IsPartialFormable);
    }

    [Fact]
    public void EveryPartialFormableType_NamesBit14OfItsRecordFlags()
    {
        var partialFormable = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4).Values
            .Where(s => !s.IsHeader && s.IsPartialFormable)
            .ToList();

        Assert.NotEmpty(partialFormable);
        Assert.All(partialFormable, s => Assert.Contains(
            new EnumMember("PartialForm", "16384"),
            s.RecordColumns.Single(c => c.Name == "MajorRecordFlagsRaw").Field.EnumMembers));
    }
}
