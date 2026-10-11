using MEditService.Index.Queries;
using MEditService.Index.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Query;

public sealed class ContainerConflictTests : IDisposable
{
    private static readonly FormKey Room = ComparedCopies.InMaster(0x800);
    private static readonly FormKey Placed = ComparedCopies.InMaster(0x801);

    private readonly PluginFixtureData _fixture;
    private readonly OpenedIndex _index;

    public ContainerConflictTests()
    {
        _fixture = new PluginFixtureBuilder("container-conflict")
            .WithPlugin("A.esp", mod => mod.AddInteriorCells(RoomHolding(scale: 1f)))
            .WithPlugin("B.esp", mod => mod.AddInteriorCells(RoomHolding(scale: 2f)))
            .Build();
        _index = Indexes.Reconciled(_fixture);
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    private static Cell RoomHolding(float scale)
    {
        var room = new Cell(Room, Fallout4Release.Fallout4) { EditorID = "Room" };
        room.Temporary.Add(new PlacedObject(Placed, Fallout4Release.Fallout4) { EditorID = "Placed", Scale = scale });
        return room;
    }

    private (ConflictAll All, ConflictThis? Overrider) ConflictOf(FormKey formKey)
    {
        var compare = _index.Queries.GetCompare(formKey.ToString()).Value()
            ?? throw new InvalidOperationException($"Expected {formKey} to compare.");
        return (compare.ConflictAll, compare.Overrides.Single(o => o.Plugin == "B.esp").ConflictThis);
    }

    [Fact]
    public void TwoCopiesOfACell_DifferingOnlyInsideAPlacedReference_AreIdentical()
    {
        Assert.Equal((ConflictAll.NoConflict, ConflictThis.IdenticalToMaster), ConflictOf(Room));
    }

    [Fact]
    public void ThePlacedReference_ShowsTheDifferenceItself()
    {
        Assert.Equal((ConflictAll.Override, ConflictThis.Override), ConflictOf(Placed));
    }
}
