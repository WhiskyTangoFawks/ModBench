using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Noggog;
using static MEditService.Commands.Tests.TestSupport.Envelopes;

namespace MEditService.Commands.Tests.Edits;

public sealed class RefillOnClearingTests : IDisposable
{
    private const int Deleted = 0x0020, PartialForm = 0x4000;

    private static readonly ModKey Fallout4Esm = ModKey.FromFileName("Fallout4.esm");
    private static readonly FormKey TheNpc = new(Fallout4Esm, 0x900);
    private static readonly FormKey TheCell = new(Fallout4Esm, 0x800);
    private static readonly FormKey TheRef = new(Fallout4Esm, 0x901);

    private readonly string _root = Directory.CreateTempSubdirectory("medit-refill-").FullName;
    private readonly List<Fallout4Mod> _plugins = [];
    private EditRecordHandler? _handler;

    public void Dispose() => Directory.Delete(_root, recursive: true);

    private static Fallout4Mod Plugin(string name, Action<Fallout4Mod> holds)
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(name), Fallout4Release.Fallout4);
        if (name != Fallout4Esm.FileName) mod.ModHeader.MasterReferences.Add(new MasterReference { Master = Fallout4Esm });
        holds(mod);
        return mod;
    }

    private static Action<Fallout4Mod> NpcCopy(int flags, string? editorId = null, float height = 0) => mod =>
        mod.Npcs.Add(new Npc(TheNpc, Fallout4Release.Fallout4) { EditorID = editorId, HeightMax = height, MajorRecordFlagsRaw = flags });

    private static Action<Fallout4Mod> CellCopy(int flags, string? editorId = null, float water = 0, Action<Cell>? also = null) => mod =>
    {
        var cell = new Cell(TheCell, Fallout4Release.Fallout4)
        {
            EditorID = editorId, Flags = Cell.Flag.IsInteriorCell, WaterHeight = water, MajorRecordFlagsRaw = flags,
        };
        also?.Invoke(cell);
        var subBlock = new CellSubBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellSubBlock };
        subBlock.Cells.Add(cell);
        var block = new CellBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellBlock };
        block.SubBlocks.Add(subBlock);
        mod.Cells.Records.Add(block);
    };

    private static Action<Cell> Placing(PlacedObject placed) => cell => cell.Temporary.Add(placed);

    private void Load(params (Fallout4Mod Mod, bool Tracked)[] plugins)
    {
        _plugins.AddRange(plugins.Select(p => p.Mod));
        var game = Directory.CreateDirectory(Path.Combine(_root, "game")).FullName;
        var entries = plugins.Select((p, slot) =>
        {
            var folder = Directory.CreateDirectory(FolderOf(p.Mod)).FullName;
            var path = Path.Combine(folder, p.Mod.ModKey.FileName);
            p.Mod.WriteToBinary(path);
            return new LoadOrderEntry(p.Mod.ModKey.FileName, path, Origin(p.Mod), Slot: slot, Enabled: true, Winning: true);
        }).ToList();
        var loadOrder = SnapshotPlugins.Snapshot(game, _root, GameRelease.Fallout4, entries);
        foreach (var (mod, _) in plugins.Where(p => p.Tracked))
        {
            new TrackService(NullLogger<TrackService>.Instance, TestAdapters.Mutagen())
                .TrackModAsync(loadOrder, Origin(mod), SourcePreset.Edits).GetAwaiter().GetResult();
        }
        var holder = new LoadOrderHolder();
        holder.Apply(loadOrder);
        _handler = TestEditService.EditHandler(holder);
    }

    private static string Origin(IModGetter mod) => mod.ModKey.Name + "Mod";

    private static PluginAddress Address(IModGetter mod) => new(mod.ModKey.FileName, Origin(mod));

    private string FolderOf(IModGetter mod) => Path.Combine(_root, "mods", Origin(mod));

    private Fallout4Mod Edited => _plugins[^1];

    private RecordEditResult WriteFlags(FormKey formKey, int raw) =>
        (_handler ?? throw new InvalidOperationException("Load the plugins first.")).Edit(
            Address(Edited), formKey.ToString(),
            SetAt(JsonDocument.Parse(raw.ToString(CultureInfo.InvariantCulture)).RootElement, Member("MajorRecordFlagsRaw")));

    private string Text(IModGetter mod, FormKey formKey) => TrackedTree.Body(FolderOf(mod), Address(mod), formKey.ToString());

    private JsonObject Written(FormKey formKey, int raw)
    {
        var result = WriteFlags(formKey, raw);
        Assert.True(result.Applied, result.Message);
        return JsonNode.Parse(Text(Edited, formKey)).Require().AsObject();
    }

    [Fact]
    public void ClearingDeleted_FillsTheCopysOwnFields_FromTheCopyToItsLeft()
    {
        Load(
            (Plugin("Fallout4.esm", NpcCopy(0, "Guy", 0.7f)), false),
            (Plugin("Override.esp", NpcCopy(Deleted)), true));

        var undeleted = Written(TheNpc, 0);

        Assert.Equal("Guy", undeleted["EditorID"]?.GetValue<string>());
        Assert.Equal(0.7f, undeleted["HeightMax"]?.GetValue<float>());
    }

    [Fact]
    public void ClearingDeleted_PassesOverADeletedCopyToItsLeft()
    {
        Load(
            (Plugin("Fallout4.esm", NpcCopy(0, "Guy", 0.7f)), false),
            (Plugin("Middle.esp", NpcCopy(Deleted)), false),
            (Plugin("Override.esp", NpcCopy(Deleted)), true));

        var undeleted = Written(TheNpc, 0);

        Assert.Equal(0.7f, undeleted["HeightMax"]?.GetValue<float>());
    }

    [Fact]
    public void ClearingDeleted_TakesTheNearestCopyToItsLeft()
    {
        Load(
            (Plugin("Fallout4.esm", NpcCopy(0, "Guy", 0.7f)), false),
            (Plugin("Middle.esp", NpcCopy(0, "Guy", 0.9f)), false),
            (Plugin("Override.esp", NpcCopy(Deleted)), true));

        var undeleted = Written(TheNpc, 0);

        Assert.Equal(0.9f, undeleted["HeightMax"]?.GetValue<float>());
    }

    [Fact]
    public void ClearingDeleted_OnAPlacedRecord_FillsItFromTheCopyToItsLeft()
    {
        var rock = new PlacedObject(TheRef, Fallout4Release.Fallout4) { EditorID = "Rock", Position = new P3Float(1, 2, 3) };
        var deleted = new PlacedObject(TheRef, Fallout4Release.Fallout4) { MajorRecordFlagsRaw = Deleted };
        Load(
            (Plugin("Fallout4.esm", CellCopy(0, "Inside", also: Placing(rock))), false),
            (Plugin("Override.esp", CellCopy(0, "Inside", also: Placing(deleted))), true));

        var undeleted = Written(TheRef, 0);

        Assert.Equal("Rock", undeleted["EditorID"]?.GetValue<string>());
        Assert.Equal("1, 2, 3", undeleted["Position"]?.GetValue<string>());
    }

    [Fact]
    public void ClearingPartialForm_FillsTheCopysOwnFieldsAndEditorId_PassingOverAPartialFormToItsLeft()
    {
        Load(
            (Plugin("Fallout4.esm", CellCopy(0, "Inside", 5f)), false),
            (Plugin("Middle.esp", CellCopy(PartialForm, "Middle", 4f)), false),
            (Plugin("Override.esp", CellCopy(PartialForm, "Mine", 3f)), true));

        var whole = Written(TheCell, 0);

        Assert.Equal("Inside", whole["EditorID"]?.GetValue<string>());
        Assert.Equal(5f, whole["WaterHeight"]?.GetValue<float>());
    }

    [Fact]
    public void ClearingPartialForm_KeepsTheCopysRecordHeaderRowsAndChildren()
    {
        var theirs = new PlacedObject(TheRef, Fallout4Release.Fallout4) { EditorID = "Theirs" };
        var mine = new PlacedObject(new FormKey(ModKey.FromFileName("Override.esp"), 0x801), Fallout4Release.Fallout4) { EditorID = "Mine" };
        Load(
            (Plugin("Fallout4.esm", CellCopy(0, "Inside", 5f, cell => { cell.VersionControl = 3; cell.Temporary.Add(theirs); })), false),
            (Plugin("Override.esp", CellCopy(PartialForm, "Inside", also: cell => { cell.VersionControl = 7; cell.Temporary.Add(mine); })), true));

        var whole = Written(TheCell, 0);

        Assert.Equal(7, whole["VersionControl"]?.GetValue<int>());
        Assert.Equal([mine.FormKey.ToString()], whole["Temporary"].Require().AsArray().Select(r => r?["FormKey"]?.GetValue<string>()));
    }

    [Fact]
    public void SettingPartialForm_OnADeletedCopy_TakesItsEditorIdFromTheCopyToItsLeft()
    {
        Load(
            (Plugin("Fallout4.esm", CellCopy(0, "Inside", 5f)), false),
            (Plugin("Override.esp", CellCopy(Deleted)), true));

        var partial = Written(TheCell, PartialForm);

        Assert.Equal("Inside", partial["EditorID"]?.GetValue<string>());
        Assert.DoesNotContain(partial, p => p.Key == "WaterHeight");
    }

    [Fact]
    public void ClearingDeleted_WhenTheNearestCopyToItsLeftCannotBeRead_IsRefused_AndWritesNothing()
    {
        var middle = Plugin("Middle.esp", NpcCopy(0, "Guy", 0.9f));
        Load(
            (Plugin("Fallout4.esm", NpcCopy(0, "Guy", 0.7f)), false),
            (middle, true),
            (Plugin("Override.esp", NpcCopy(Deleted)), true));
        var unreadable = Text(middle, TheNpc).Replace("0.9", "\"tall\"", StringComparison.Ordinal);
        SourceRepository.Open(FolderOf(middle), GameRelease.Fallout4).Require()
            .Put(Address(middle), new SourceDocument(TheNpc.ToString(), "npc_", "Guy", unreadable));
        var before = Text(Edited, TheNpc);

        var result = WriteFlags(TheNpc, 0);

        Assert.Equal(RecordEditRefusal.RecordParseFailed, result.Refusal);
        Assert.Equal(before, Text(Edited, TheNpc));
    }
}
