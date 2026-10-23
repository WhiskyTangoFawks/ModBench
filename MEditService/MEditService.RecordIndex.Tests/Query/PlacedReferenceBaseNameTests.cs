using MEditService.LoadOrder;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.Query;

public sealed class PlacedReferenceBaseNameTests : IDisposable
{
    private readonly ScatteredFixtureData _fixture;
    private readonly OpenedIndex _index;
    private readonly Dictionary<string, string> _roomOf = new(StringComparer.Ordinal);

    public PlacedReferenceBaseNameTests()
    {
        _fixture = new PluginFixtureBuilder("placed-reference-base-name")
            .WithPlugin("Master.esm", mod =>
            {
                var lever = mod.Activators.AddNew("MasterLever");
                PlaceInARoom(mod, lever.ToLink());
            }, origin: "MasterMod")
            .WithPlugin("Patch.esp", (mod, masters) =>
                mod.Activators.GetOrAddAsOverride(masters[0].Activators.First()).EditorID = "PatchLever", origin: "PatchMod")
            .WithPlugin("Other.esp", (mod, masters) =>
                PlaceInARoom(mod, masters[0].Activators.First().ToLink()), origin: "OtherMod")
            .BuildScattered();
        _index = Indexes.Reconciled(_fixture);
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    private void PlaceInARoom(Fallout4Mod mod, IFormLinkGetter<IPlaceableObjectGetter> baseRecord)
    {
        var placed = new PlacedObject(mod);
        placed.Base.SetTo(baseRecord);
        var room = new Cell(mod) { EditorID = $"{mod.ModKey.Name}Room" };
        room.Temporary.Add(placed);
        mod.AddInteriorCells(room);
        _roomOf[mod.ModKey.FileName] = room.FormKey.ToString();
    }

    [Theory]
    [InlineData("Master.esm", "MasterMod", "MasterLever")]
    [InlineData("Other.esp", "OtherMod", "PatchLever")]
    public void APlacedReferenceNamesItsBase_AsItsOwnPluginHoldsIt_ElseAsTheWinningCopyDoes(
        string plugin, string origin, string expected)
    {
        var placed = _index.Queries.GetCellChildRecords(new PluginAddress(plugin, origin), _roomOf[plugin]).Value();

        Assert.Equal(expected, Assert.Single(placed.Temporary).BaseEditorId);
    }
}
