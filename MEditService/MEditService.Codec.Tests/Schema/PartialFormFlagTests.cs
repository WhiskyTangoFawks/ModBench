using MEditService.Codec.Schema;
using MEditService.Tests;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

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

    // IsPartialFormable is the same container-type gate IsSet already uses, split out so the
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

    // The write door and the read gate name the same types: a container type IsPartialFormable
    // admits carries the annotated IsPartialForm member, and no other type does.
    [Fact]
    public void TheAnnotatedPartialFormMembers_AreExactlyThePartialFormableTypes()
    {
        var schemas = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);

        var annotated = schemas.Values
            .Where(s => s.RecordColumns.Any(c => c.Synthetic is { Bit: PartialFormFlag.Bit }))
            .Select(s => s.TableName)
            .Order(StringComparer.Ordinal);
        var partialFormable = schemas.Values
            .Where(s => !s.IsHeader && PartialFormFlag.IsPartialFormable(s.RecordType))
            .Select(s => s.TableName)
            .Order(StringComparer.Ordinal);

        Assert.Equal(partialFormable, annotated);
        Assert.NotEmpty(annotated);
    }
}
