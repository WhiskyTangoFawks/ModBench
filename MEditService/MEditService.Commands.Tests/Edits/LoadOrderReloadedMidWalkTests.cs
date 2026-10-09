using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using Microsoft.Extensions.DependencyInjection;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using static MEditService.Commands.Tests.TestSupport.LoadOrderOfPlugins;

namespace MEditService.Commands.Tests.Edits;

public sealed class LoadOrderReloadedMidWalkTests : IDisposable
{
    private const int Deleted = 0x0020;
    private static readonly FormKey TheNpc = new(Fallout4Esm, 0x900);

    private readonly LoadOrderOfPlugins _plugins = new();

    public void Dispose() => _plugins.Dispose();

    [Fact]
    public void ClearingDeleted_WhenTheLoadOrderIsReplacedMidWalk_ReadsEveryCopyFromTheSnapshotItWalks()
    {
        var mid = Plugin("Mid.esp", mod => mod.Npcs.Add(new Npc(new FormKey(ModKey.FromFileName("Mid.esp"), 0x950), Fallout4Release.Fallout4)));
        var edited = Plugin("Override.esp", mod =>
        {
            mod.ModHeader.MasterReferences.Add(new MasterReference { Master = mid.ModKey });
            mod.Npcs.Add(new Npc(new FormKey(mid.ModKey, 0x950), Fallout4Release.Fallout4));
            mod.Npcs.Add(new Npc(TheNpc, Fallout4Release.Fallout4) { MajorRecordFlagsRaw = Deleted });
        });
        var master = Plugin("Fallout4.esm", mod => mod.Npcs.Add(new Npc(TheNpc, Fallout4Release.Fallout4) { EditorID = "Guy" }));
        _plugins.Load(
            (master, false),
            (mid, false),
            (edited, true));
        var handler = new TestEditor(
            TestEditService.Over(_plugins.Holder, adapter: new DroppingAPluginOnTheFirstRead(_plugins.Holder, Address(master)))
                .GetRequiredService<EditRecordChangesHandler>());

        var result = handler.Set(Address(edited), TheNpc.ToString(), "MajorRecordFlagsRaw", JsonDocument.Parse("0").RootElement);

        Assert.True(result.Applied, result.Message);
        Assert.Equal("Guy", JsonNode.Parse(_plugins.Text(edited, TheNpc))?["EditorID"]?.GetValue<string>());
    }

    [Fact]
    public void CopyingARefWhoseCellTheDestinationLacks_WhenTheLoadOrderIsReplacedOnceTheSourceIsRead_CarriesTheCellTheSourcesLoadOrderShowsIt()
    {
        var cellKey = new FormKey(ModKey.FromFileName("Base.esm"), 0x800);
        var staticKey = new FormKey(ModKey.FromFileName("Base.esm"), 0x801);
        var master = Plugin("Base.esm", mod =>
        {
            mod.Cells.Records.Add(CellBlocks.Interior(new Cell(cellKey, Fallout4Release.Fallout4) { EditorID = "BaseCell" }));
            mod.Statics.Add(new Static(staticKey, Fallout4Release.Fallout4) { EditorID = "BaseStatic" });
        });
        var placed = new FormKey(ModKey.FromFileName("Source.esp"), 0x900);
        var source = Plugin("Source.esp", mod =>
        {
            var cell = new Cell(cellKey, Fallout4Release.Fallout4) { EditorID = "SourceCell", MajorRecordFlagsRaw = (int)PartialFormFlag.Bit };
            cell.Persistent.Add(new PlacedObject(placed, Fallout4Release.Fallout4) { EditorID = "CopiedRef" });
            mod.Cells.Records.Add(CellBlocks.Interior(cell));
        });
        var destination = Plugin("Dest.esp", mod => mod.Statics.Add(new Static(staticKey, Fallout4Release.Fallout4) { EditorID = "DestStatic" }));
        _plugins.Load((master, false), (source, false), (destination, true));
        var handler = TestEditService.Over(_plugins.Holder, adapter: new DroppingAPluginOnTheFirstRead(_plugins.Holder, Address(master)))
            .GetRequiredService<CopyRecordChangesHandler>();

        handler.CopySync([new RecordAt(Address(source), placed.ToString())], CopyMode.Override, [Address(destination)], replace: false)
            .OnlyLanded();

        Assert.Equal("BaseCell", JsonNode.Parse(_plugins.Text(destination, cellKey))?["EditorID"]?.GetValue<string>());
    }
}
