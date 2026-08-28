using MEditService.Core.Schema;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.Tests.Schema;

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

    // #491: bit 14 is reused for unrelated meanings on a record type that never declares a
    // 'Partial Form' header flag — a type without static IsPartialFormable => true must not have the
    // same bit misread as Partial Form. Npc is not partial-formable in Fallout4's definitions.
    [Fact]
    public void IsSet_NonPartialFormableTypeWithSameBitSet_ReturnsFalse()
    {
        var mod = MakeMod();
        var npc = mod.Npcs.AddNew("SomeNpc");
        npc.MajorRecordFlagsRaw = PartialFormBit;

        Assert.False(PartialFormFlag.IsSet(npc));
    }
}
