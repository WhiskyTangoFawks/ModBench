using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.RecordIndex.Tests.Query;

public sealed class SpatialWorkingTreeStateTests : IDisposable
{
    private const WorkingTreeState None = WorkingTreeState.None;
    private const WorkingTreeState Modified = WorkingTreeState.Modified;

    private readonly ScatteredFixtureData _fixture;
    private readonly LoadOrderEntry _entry;
    private readonly OpenedIndex _index;
    private readonly SpatialPlugin.Records _records;

    public SpatialWorkingTreeStateTests()
    {
        SpatialPlugin.Records records = default;
        _fixture = new PluginFixtureBuilder("spatial-working-tree-state")
            .WithPlugin("Spatial.esp", mod => records = SpatialPlugin.AddTo(mod), origin: "SpatialMod")
            .BuildScattered()
            .CompiledPlugin();
        _records = records;
        _entry = _fixture.Plugins.Single();
        _index = Indexes.Reconciled(_fixture);
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    private static string FormKeyOf(IMajorRecordGetter record) => record.FormKey.ToString();

    private WorkingTreeState[] WorldspaceExteriorInteriorExteriorRefInteriorRefStates()
    {
        var plugin = _entry.Key;
        var queries = _index.Queries;
        static WorkingTreeState StateOf(IEnumerable<(string FormKey, WorkingTreeState State)> rows, string formKey) =>
            rows.Single(r => r.FormKey == formKey).State;
        var worldspaces = queries.GetWorldspaces(plugin).Value().Select(w => (w.FormKey, w.WorkingTreeState));
        var exteriorCells = queries.GetWorldspaceBlocks(plugin, FormKeyOf(_records.Worldspace)).Value()
            .Blocks.SelectMany(b => b.SubBlocks).SelectMany(s => s.Cells).Select(c => (c.FormKey, c.WorkingTreeState));
        var interiorCells = queries.GetInteriorCells(plugin).Value()
            .SelectMany(b => b.SubBlocks).SelectMany(s => s.Cells).Select(c => (c.FormKey, c.WorkingTreeState));
        var exteriorRefs = queries.GetCellChildRecords(plugin, FormKeyOf(_records.ExteriorCell)).Value().Persistent.Select(r => (r.FormKey, r.WorkingTreeState));
        var interiorRefs = queries.GetCellChildRecords(plugin, FormKeyOf(_records.InteriorCell)).Value().Persistent.Select(r => (r.FormKey, r.WorkingTreeState));
        return
        [
            StateOf(worldspaces, FormKeyOf(_records.Worldspace)),
            StateOf(exteriorCells, FormKeyOf(_records.ExteriorCell)),
            StateOf(interiorCells, FormKeyOf(_records.InteriorCell)),
            StateOf(exteriorRefs, FormKeyOf(_records.ExteriorRef)),
            StateOf(interiorRefs, FormKeyOf(_records.InteriorRef)),
        ];
    }

    [Fact]
    public void AnEditedPlacedReference_IsListedAsModified_NeverTheCellHoldingIt()
    {
        _index.RenameEditorId(_entry, _index.DocumentOf(FormKeyOf(_records.InteriorRef), _entry.Key), "Renamed");

        Assert.Equal([None, None, None, None, Modified], WorldspaceExteriorInteriorExteriorRefInteriorRefStates());
    }
}
