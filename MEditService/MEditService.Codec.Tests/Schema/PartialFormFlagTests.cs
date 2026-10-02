using MEditService.Codec.Schema;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Codec.Tests.Schema;

public class PartialFormFlagTests
{
    private const int PartialFormBit = 0x0000_4000;

    private static Fallout4Mod MakeMod() => new(ModKey.FromFileName("PartialFormFlag.esp"), Fallout4Release.Fallout4);

    [Fact]
    public void IsSet_CellWithBitSet_ReturnsTrue()
    {
        var mod = MakeMod();
        var cell = new Cell(mod) { EditorID = "SomeCell", MajorRecordFlagsRaw = PartialFormBit };

        Assert.True(PartialFormFlag.IsSet(cell));
    }

    [Fact]
    public void IsSet_CellWithoutBitSet_ReturnsFalse()
    {
        var mod = MakeMod();
        var cell = new Cell(mod) { EditorID = "SomeCell" };

        Assert.False(PartialFormFlag.IsSet(cell));
    }

    // Bit 14 carries unrelated meanings on a record type that declares no 'Partial Form' header
    // flag, so a type without IsPartialFormable must not have it misread as one.
    [Fact]
    public void IsSet_NonPartialFormableTypeWithSameBitSet_ReturnsFalse()
    {
        var mod = MakeMod();
        var npc = mod.Npcs.AddNew("SomeNpc");
        npc.MajorRecordFlagsRaw = PartialFormBit;

        Assert.False(PartialFormFlag.IsSet(npc));
    }

    [Fact]
    public void IsPartialFormable_Cell_ReturnsTrue()
    {
        Assert.True(PartialFormFlag.IsPartialFormable(typeof(Cell)));
    }

    [Fact]
    public void IsPartialFormable_Npc_ReturnsFalse()
    {
        Assert.False(PartialFormFlag.IsPartialFormable(typeof(Npc)));
    }

    [Fact]
    public void EveryPartialFormableType_NamesBit14OfItsRecordFlags()
    {
        var partialFormable = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4).Values
            .Where(s => !s.IsHeader && PartialFormFlag.IsPartialFormable(s.RecordType))
            .ToList();

        Assert.NotEmpty(partialFormable);
        Assert.All(partialFormable, s => Assert.Contains(
            new EnumMember("PartialForm", "16384"),
            s.RecordColumns.Single(c => c.Name == "MajorRecordFlagsRaw").Field.EnumMembers));
    }
}
