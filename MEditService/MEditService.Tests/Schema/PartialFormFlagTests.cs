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

    // #539: IsPartialFormable is the same container-type gate IsSet already uses, split out so the
    // write path can ask "is this type eligible" independent of the bit's current state.
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

    // #539 AC2's rival, at the unit level: a full-overwrite implementation of Set
    // (`MajorRecordFlagsRaw = value ? Bit : 0`) would silently drop this pre-existing, unrelated bit
    // (Persistent, 0x0400) — the correct implementation only ever touches bit 14.
    [Fact]
    public void Set_True_OnlyFlipsBit14_PreservesOtherBits()
    {
        var mod = MakeMod();
        var cell = new Cell(mod) { EditorID = "SomeCell", MajorRecordFlagsRaw = 0x0000_0400 };

        PartialFormFlag.Set(cell, true);

        Assert.Equal(0x0000_0400 | PartialFormBit, cell.MajorRecordFlagsRaw);
    }

    [Fact]
    public void Set_False_OnlyFlipsBit14_PreservesOtherBits()
    {
        var mod = MakeMod();
        var cell = new Cell(mod) { EditorID = "SomeCell", MajorRecordFlagsRaw = 0x0000_0400 | PartialFormBit };

        PartialFormFlag.Set(cell, false);

        Assert.Equal(0x0000_0400, cell.MajorRecordFlagsRaw);
    }
}
