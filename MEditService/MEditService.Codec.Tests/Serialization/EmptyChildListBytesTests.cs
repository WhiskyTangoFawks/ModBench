using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Codec.Tests.Serialization;

public sealed class EmptyChildListBytesTests
{
    private static readonly ModKey Plugin = ModKey.FromFileName("Bytes.esp");

    private static Cell Room() => new(new FormKey(Plugin, 0x800), Fallout4Release.Fallout4) { EditorID = "Room" };

    private static byte[] Written(Cell cell)
    {
        var mod = new Fallout4Mod(Plugin, Fallout4Release.Fallout4);
        mod.AddInteriorCells(cell);
        using var stream = new MemoryStream();
        mod.WriteToBinary(stream);
        return stream.ToArray();
    }

    [Fact]
    public void ACellsChildListNeverSet_IsTheEmptyList()
    {
        Assert.Empty(Room().Persistent);
    }

    [Fact]
    public void ACellWhoseChildListWasEmptied_WritesTheBytesOfOneThatNeverHeldAChild()
    {
        var emptied = Room();
        emptied.Persistent.Add(new PlacedObject(new FormKey(Plugin, 0x801), Fallout4Release.Fallout4));
        emptied.Persistent.Clear();

        Assert.Equal(Written(Room()), Written(emptied));
    }
}
