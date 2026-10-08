using System.Text.Json;
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

    private static bool IsPartialForm(IMajorRecordGetter record, string table)
    {
        using var document = JsonDocument.Parse(RecordTextCodec.SerializeToText(record, GameRelease.Fallout4));
        return SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4)[table].IsPartialForm(document.RootElement);
    }

    [Fact]
    public void IsPartialForm_CellWithBitSet_ReturnsTrue()
    {
        var cell = new Cell(MakeMod()) { EditorID = "SomeCell", MajorRecordFlagsRaw = PartialFormBit };

        Assert.True(IsPartialForm(cell, "cell"));
    }

    [Fact]
    public void IsPartialForm_CellWithoutBitSet_ReturnsFalse()
    {
        var cell = new Cell(MakeMod()) { EditorID = "SomeCell" };

        Assert.False(IsPartialForm(cell, "cell"));
    }

    [Fact]
    public void IsPartialForm_NonPartialFormableTypeWithSameBitSet_ReturnsFalse_BecauseBit14CarriesUnrelatedMeaningsOnATypeThatDeclaresNoPartialFormFlag()
    {
        var npc = MakeMod().Npcs.AddNew("SomeNpc");
        npc.MajorRecordFlagsRaw = PartialFormBit;

        Assert.False(IsPartialForm(npc, "npc_"));
    }

    [Fact]
    public void ACell_IsPartialFormable()
    {
        Assert.True(SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4)["cell"].IsPartialFormable);
    }

    [Fact]
    public void AnNpc_IsNotPartialFormable()
    {
        Assert.False(SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4)["npc_"].IsPartialFormable);
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
