using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Noggog;

namespace MEditService.RecordIndex.Tests.Query;

public sealed class SpatialWorkingTreeStateTests : IDisposable
{
    private static readonly string[] Kinds = ["worldspace", "exteriorCell", "interiorCell", "exteriorRef", "interiorRef"];

    private static readonly Dictionary<string, string> EditorIdOf = new()
    {
        ["worldspace"] = "SpatialWorld",
        ["exteriorCell"] = "SpatialExterior",
        ["interiorCell"] = "SpatialInterior",
        ["exteriorRef"] = "SpatialExteriorRef",
        ["interiorRef"] = "SpatialInteriorRef",
    };

    private readonly Dictionary<string, string> _formKeys = new(StringComparer.Ordinal);
    private readonly ScatteredFixtureData _fixture;
    private readonly LoadOrderEntry _entry;
    private readonly OpenedIndex _index;

    public SpatialWorkingTreeStateTests()
    {
        _fixture = new PluginFixtureBuilder("spatial-working-tree-state")
            .WithPlugin("Spatial.esp", mod =>
            {
                var world = mod.Worldspaces.AddNew(EditorIdOf["worldspace"]);
                var exterior = new Cell(mod) { EditorID = EditorIdOf["exteriorCell"], Grid = new CellGrid { Point = new P2Int(0, 0) } };
                var exteriorRef = new PlacedObject(mod) { EditorID = EditorIdOf["exteriorRef"] };
                exterior.Persistent.Add(exteriorRef);
                var subBlock = new WorldspaceSubBlock { BlockNumberX = 0, BlockNumberY = 0 };
                subBlock.Items.Add(exterior);
                var block = new WorldspaceBlock { BlockNumberX = 0, BlockNumberY = 0 };
                block.Items.Add(subBlock);
                world.SubCells.Add(block);

                var interior = new Cell(mod) { EditorID = EditorIdOf["interiorCell"] };
                var interiorRef = new PlacedObject(mod) { EditorID = EditorIdOf["interiorRef"] };
                interior.Persistent.Add(interiorRef);
                mod.AddInteriorCells(interior);

                _formKeys["worldspace"] = world.FormKey.ToString();
                _formKeys["exteriorCell"] = exterior.FormKey.ToString();
                _formKeys["interiorCell"] = interior.FormKey.ToString();
                _formKeys["exteriorRef"] = exteriorRef.FormKey.ToString();
                _formKeys["interiorRef"] = interiorRef.FormKey.ToString();
            }, origin: "SpatialMod")
            .BuildScattered()
            .CompiledPlugin();
        _entry = _fixture.Plugins.Single();
        _index = Indexes.Reconciled(_fixture);
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    private Dictionary<string, WorkingTreeState> States()
    {
        var plugin = _entry.KeyOf();
        var queries = _index.Queries;
        static WorkingTreeState StateOf(IEnumerable<(string FormKey, WorkingTreeState State)> rows, string formKey) =>
            rows.Single(r => r.FormKey == formKey).State;
        var worldspaces = queries.GetWorldspaces(plugin).Value().Select(w => (w.FormKey, w.WorkingTreeState));
        var exteriorCells = queries.GetWorldspaceBlocks(plugin, _formKeys["worldspace"]).Value()
            .Blocks.SelectMany(b => b.SubBlocks).SelectMany(s => s.Cells).Select(c => (c.FormKey, c.WorkingTreeState));
        var interiorCells = queries.GetInteriorCells(plugin).Value()
            .SelectMany(b => b.SubBlocks).SelectMany(s => s.Cells).Select(c => (c.FormKey, c.WorkingTreeState));
        var exteriorRefs = queries.GetCellChildRecords(plugin, _formKeys["exteriorCell"]).Value().Persistent.Select(r => (r.FormKey, r.WorkingTreeState));
        var interiorRefs = queries.GetCellChildRecords(plugin, _formKeys["interiorCell"]).Value().Persistent.Select(r => (r.FormKey, r.WorkingTreeState));
        return new Dictionary<string, WorkingTreeState>
        {
            ["worldspace"] = StateOf(worldspaces, _formKeys["worldspace"]),
            ["exteriorCell"] = StateOf(exteriorCells, _formKeys["exteriorCell"]),
            ["interiorCell"] = StateOf(interiorCells, _formKeys["interiorCell"]),
            ["exteriorRef"] = StateOf(exteriorRefs, _formKeys["exteriorRef"]),
            ["interiorRef"] = StateOf(interiorRefs, _formKeys["interiorRef"]),
        };
    }

    [Theory]
    [InlineData("worldspace", new[] { "worldspace" })]
    [InlineData("exteriorCell", new[] { "exteriorCell" })]
    [InlineData("interiorCell", new[] { "interiorCell" })]
    [InlineData("exteriorRef", new[] { "exteriorRef", "exteriorCell" })]
    [InlineData("interiorRef", new[] { "interiorRef", "interiorCell" })]
    public void AnEditedSpatialRecord_IsListedAsModified_WithTheDocumentHoldingIt(string edited, string[] modified)
    {
        var identity = _index.DocumentOf(_formKeys[edited], _entry.KeyOf());
        _index.Rename(
            _entry, identity, "Renamed",
            _entry.SourceTextOf(identity).Replace($"\"{EditorIdOf[edited]}\"", "\"Renamed\"", StringComparison.Ordinal));

        var expected = Kinds.ToDictionary(kind => kind, kind => modified.Contains(kind) ? WorkingTreeState.Modified : WorkingTreeState.None);
        Assert.Equal(expected, States());
    }
}
