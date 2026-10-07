using System.Text;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Noggog;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceRepositoryCellsInTests : IDisposable
{
    private const string PluginName = "CellsIn.esp";
    private const GameRelease Release = GameRelease.Fallout4;
    private static readonly PluginAddress Plugin = new(PluginName, "CellsInMod");

    private readonly ScratchDirectory _modFolder = new("medit-cellsin-");
    private readonly RecordTextCodec _codec = new(NullLogger<RecordTextCodec>.Instance);
    private readonly Fallout4Mod _mod = new(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);

    public void Dispose() => _modFolder.Dispose();

    private static string Leaf(IMajorRecordGetter record) =>
        $"{record.EditorID} - {record.FormKey.ID:X6}_{record.FormKey.ModKey.FileName}";

    private TreeFile File(string[] folders, Cell cell) =>
        new(PluginSourceRoot.ContainerDocument(Path.Combine([PluginSourceRoot.For(PluginName), .. folders, Leaf(cell)])), Encoding.UTF8.GetBytes(_codec.SerializeToText(cell, Release)));

    private Cell ExteriorCell(string editorId, int x, int y) =>
        new(_mod) { EditorID = editorId, Grid = new CellGrid { Point = new P2Int(x, y) } };

    [Fact]
    public void CellsIn_AWorldspace_ListsItsPersistentCellAndEveryNumberedCell_AndNoOtherCell()
    {
        var persistent = new Cell(_mod) { EditorID = "Persistent" };
        var world = new Worldspace(_mod) { EditorID = "World", TopCell = persistent };
        var other = new Worldspace(_mod) { EditorID = "Other" };
        var near = ExteriorCell("Near", 1, -2);
        var far = ExteriorCell("Far", 170, 42);
        var elsewhere = ExteriorCell("Elsewhere", 1, 1);
        var interior = new Cell(_mod) { EditorID = "Interior" };
        var worldFolder = new[] { "Worldspaces", Leaf(world) };
        var otherFolder = new[] { "Worldspaces", Leaf(other) };
        PluginBaselines.Track(
            _modFolder,
            [
                new TreeFile(PluginSourceRoot.ContainerDocument(Path.Combine(PluginSourceRoot.For(PluginName), "Worldspaces", Leaf(world))), Encoding.UTF8.GetBytes(_codec.SerializeToText(world, Release))),
                new TreeFile(PluginSourceRoot.ContainerDocument(Path.Combine(PluginSourceRoot.For(PluginName), "Worldspaces", Leaf(other))), Encoding.UTF8.GetBytes(_codec.SerializeToText(other, Release))),
                File([.. worldFolder, "0, -1", "0, -1"], near),
                File([.. worldFolder, "5, 1", "21, 5"], far),
                File([.. otherFolder, "0, 0", "0, 0"], elsewhere),
                File(["Cells", "0", "0"], interior),
            ]);
        var repository = SourceRepository.Open(TestMod.In(_modFolder), Release) ?? throw new InvalidOperationException("not tracked");

        var listed = repository.CellsIn(Plugin, world.FormKey.ToString(), SharedSchemaReflector.Instance.GetSchemas(Release));

        Assert.Equal(
            new[] { persistent, near, far }.Select(cell => cell.FormKey.ToString()).Order(StringComparer.Ordinal),
            listed.Order(StringComparer.Ordinal));
    }
}
