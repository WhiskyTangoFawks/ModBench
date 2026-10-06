using System.Globalization;
using System.Text.Json;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using static MEditService.Commands.Tests.TestSupport.Envelopes;

namespace MEditService.Commands.Tests.Edits;

public sealed class PartialFormCellCopyToTheLeftTests : IDisposable
{
    private const int PartialForm = 0x4000;
    private const string OverrideOrigin = "OverrideMod";

    private readonly ScratchDirectory _root = new("medit-partial-left-");
    private readonly PluginAddress _override = new("Override.esp", OverrideOrigin);
    private readonly FormKey _cell;
    private readonly TestEditor _handler;

    public PartialFormCellCopyToTheLeftTests()
    {
        var masterFolder = Directory.CreateDirectory(Path.Combine(_root, "mods", "MasterMod")).FullName;
        var overrideFolder = Directory.CreateDirectory(Path.Combine(_root, "mods", OverrideOrigin)).FullName;
        var gameDirectory = Directory.CreateDirectory(Path.Combine(_root, "game")).FullName;

        var master = new Fallout4Mod(ModKey.FromFileName("Fallout4.esm"), Fallout4Release.Fallout4);
        var masterCell = new Cell(master) { EditorID = "Inside", Flags = Cell.Flag.IsInteriorCell };
        master.Cells.Records.Add(CellBlocks.Interior(masterCell));
        var masterPath = Path.Combine(masterFolder, "Fallout4.esm");
        master.WriteToBinary(masterPath);

        var copy = new Fallout4Mod(ModKey.FromFileName(_override.Name), Fallout4Release.Fallout4);
        copy.ModHeader.MasterReferences.Add(new MasterReference { Master = master.ModKey });
        copy.Cells.Records.Add(CellBlocks.Interior(new Cell(masterCell.FormKey, Fallout4Release.Fallout4) { EditorID = "Inside" }));
        var overridePath = Path.Combine(overrideFolder, _override.Name);
        copy.WriteToBinary(overridePath);
        _cell = masterCell.FormKey;

        var loadOrder = SnapshotPlugins.Snapshot(
            gameDirectory, _root, GameRelease.Fallout4,
            [
                new LoadOrderEntry("Fallout4.esm", masterPath, "MasterMod", Slot: 0, Enabled: true, Winning: true),
                new LoadOrderEntry(_override.Name, overridePath, OverrideOrigin, Slot: 1, Enabled: true, Winning: true),
            ]);
        TrackEveryPluginOf.ModAsync(loadOrder, OverrideOrigin).GetAwaiter().GetResult();
        var holder = new LoadOrderHolder();
        holder.Apply(loadOrder);
        _handler = TestEditService.EditHandler(holder);
    }

    public void Dispose() => _root.Dispose();

    [Fact]
    public void SettingPartialForm_OnACopyThatSaysNotWhereItSits_TakesItsPlaceFromTheCopyToItsLeft()
    {
        var result = _handler.Edit(
            _override, _cell.ToString(),
            SetAt(JsonDocument.Parse(PartialForm.ToString(CultureInfo.InvariantCulture)).RootElement, Member("MajorRecordFlagsRaw")));

        Assert.True(result.Applied, result.Message);
    }
}
