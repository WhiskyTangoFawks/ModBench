using System.Globalization;
using MEditService.Commands;
using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.SourceRepo;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.Tests.Edits;

/// <summary>The one sanctioned write to header flag bit 14: clearing it restores full
/// editability, touches only that bit, and no other write surface can flip it.</summary>
public sealed class PartialFormHeaderWriteTests : IDisposable
{
    private const int PartialFormBit = 0x0000_4000;
    // An extra, unrelated bit riding alongside PartialFormBit: the rival (a full-overwrite Set)
    // clobbers it, so its presence is what keeps the byte-diff assertion from passing by coincidence.
    private const int PersistentBit = 0x0000_0400;
    private const string PluginName = "PartialFormHeaderWrite.esp";
    private const string Origin = "PartialFormHeaderWriteMod";

    private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-partialform-header-mod-").FullName;
    private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-partialform-header-game-").FullName;

    public PluginCopyKey Plugin { get; } = new(PluginName, Origin);
    public LoadOrderSnapshot LoadOrder { get; }
    public EditRecordHandler EditHandler { get; }
    public FormKey PartialCell { get; }
    public FormKey OrdinaryNpc { get; }

    public PartialFormHeaderWriteTests()
    {
        var holder = new LoadOrderHolder();
        var pluginPath = Path.Combine(_modFolder, PluginName);
        var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);

        var cell = new Cell(mod)
        {
            EditorID = "PartialCell",
            WaterHeight = 100f,
            MajorRecordFlagsRaw = PartialFormBit | PersistentBit,
        };
        var subBlock = new CellSubBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellSubBlock };
        subBlock.Cells.Add(cell);
        var block = new CellBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellBlock };
        block.SubBlocks.Add(subBlock);
        mod.Cells.Records.Add(block);

        var npc = mod.Npcs.AddNew("OrdinaryNpc");

        mod.WriteToBinary(pluginPath);
        PartialCell = cell.FormKey;
        OrdinaryNpc = npc.FormKey;

        LoadOrder = new LoadOrderSnapshot(
            _gameDirectory, _gameDirectory, GameRelease.Fallout4,
            SnapshotCopies.Of([new LoadOrderEntry(PluginName, pluginPath, Origin, Slot: 0, Enabled: true, Winning: true)]));
        new TrackService(NullLogger<TrackService>.Instance, TestAdapters.Mutagen())
            .TrackAsync(LoadOrder, Origin, SourcePreset.Edits)
            .GetAwaiter().GetResult();

        holder.Apply(LoadOrder);
        EditHandler = TestEditService.EditHandler(holder);
    }

    public void Dispose()
    {
        try { Directory.Delete(_modFolder, recursive: true); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { /* best-effort cleanup */ }
        try { Directory.Delete(_gameDirectory, recursive: true); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { /* best-effort cleanup */ }
    }

    private EditRecordHandler Service() => EditHandler;

    // xEdit's SetIsPartialForm (wbImplementation.pas:14146-14221) re-populates a cleared override from
    // its nearest non-partial predecessor; mEdit's minimum is narrower, and is that the record becomes
    // writable again.
    [Fact]
    public void EditField_ClearingPartialForm_RestoresFullEditability()
    {
        var service = Service();

        var beforeClear = service.Set(Plugin, PartialCell.ToString(), "WaterHeight", Json("50.0"));
        Assert.False(beforeClear.Applied);
        Assert.Equal(RecordEditRefusal.PartialFormFieldReadOnly, beforeClear.Refusal);

        var clear = service.Set(Plugin, PartialCell.ToString(), "IsPartialForm", Json("false"));
        Assert.True(clear.Applied);

        var afterClear = service.Set(Plugin, PartialCell.ToString(), "WaterHeight", Json("50.0"));
        Assert.True(afterClear.Applied);
    }

    [Fact]
    public void EditField_SettingIsPartialForm_OnEligibleUnflaggedRecord_Succeeds()
    {
        var service = Service();
        // OrdinaryNpc isn't eligible; use a fresh, unflagged Cell-shaped fixture instead by clearing
        // the seeded flag first, then setting it again — proves the write is a genuine toggle, not
        // just a one-way clear.
        Assert.True(service.Set(Plugin, PartialCell.ToString(), "IsPartialForm", Json("false")).Applied);

        var result = service.Set(Plugin, PartialCell.ToString(), "IsPartialForm", Json("true"));

        Assert.True(result.Applied);
    }

    [Fact]
    public void EditField_IsPartialForm_OnNonPartialFormableType_IsRefused()
    {
        var result = Service().Set(Plugin, OrdinaryNpc.ToString(), "IsPartialForm", Json("true"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FieldNotFound, result.Refusal);
    }

    // A byte-diff over the record's own source file rather than an in-memory assertion, so a codec
    // reserializing more than the one changed property is caught too.
    [Fact]
    public void EditField_ClearingIsPartialForm_ChangesOnlyBit14InSourceFile()
    {
        var path = SourcePath();
        var before = File.ReadAllText(path);

        var result = Service().Set(Plugin, PartialCell.ToString(), "IsPartialForm", Json("false"));
        Assert.True(result.Applied);

        var after = File.ReadAllText(path);
        AssertOnlyBit14Changed(before, after, PartialFormBit | PersistentBit, PersistentBit);
    }

    [Fact]
    public void EditField_SettingIsPartialForm_ChangesOnlyBit14InSourceFile()
    {
        // Start from a cleared cell so this test exercises the opposite direction from the one above.
        Assert.True(Service().Set(Plugin, PartialCell.ToString(), "IsPartialForm", Json("false")).Applied);
        var path = SourcePath();
        var before = File.ReadAllText(path);

        var result = Service().Set(Plugin, PartialCell.ToString(), "IsPartialForm", Json("true"));
        Assert.True(result.Applied);

        var after = File.ReadAllText(path);
        AssertOnlyBit14Changed(before, after, PersistentBit, PersistentBit | PartialFormBit);
    }

    private static void AssertOnlyBit14Changed(string beforeJson, string afterJson, int expectedBefore, int expectedAfter)
    {
        Assert.Equal(PartialFormBit, expectedBefore ^ expectedAfter);

        using var beforeDoc = System.Text.Json.JsonDocument.Parse(beforeJson);
        using var afterDoc = System.Text.Json.JsonDocument.Parse(afterJson);
        var before = beforeDoc.RootElement;
        var after = afterDoc.RootElement;

        Assert.Equal(expectedBefore, before.GetProperty("MajorRecordFlagsRaw").GetInt32());
        Assert.Equal(expectedAfter, after.GetProperty("MajorRecordFlagsRaw").GetInt32());

        var mirroredOfMajorRecordFlagsRaw = new HashSet<string>(StringComparer.Ordinal)
        {
            "MajorRecordFlagsRaw", "Fallout4MajorRecordFlags", "MajorFlags",
        };
        var beforeOthers = before.EnumerateObject()
            .Where(p => !mirroredOfMajorRecordFlagsRaw.Contains(p.Name))
            .ToDictionary(p => p.Name, p => p.Value.GetRawText());
        var afterOthers = after.EnumerateObject()
            .Where(p => !mirroredOfMajorRecordFlagsRaw.Contains(p.Name))
            .ToDictionary(p => p.Name, p => p.Value.GetRawText());
        Assert.Equal(beforeOthers, afterOthers);
    }

    // Two reflected columns alias the int bit 14 lives in, and is_partial_form is the one sanctioned
    // door. Both start from an unflagged record: while flagged, PartialFormFieldReadOnly already
    // blocks every non-exempt field, so neither column would reach this guard.
    [Fact]
    public void EditField_MajorFlags_AttemptingToSetBit14OnUnflaggedRecord_IsRefused()
    {
        Assert.True(Service().Set(Plugin, PartialCell.ToString(), "IsPartialForm", Json("false")).Applied);
        var path = SourcePath();
        var before = File.ReadAllText(path);

        // MajorFlags is Cell.MajorFlags's own reflected flags column, an array of names that the
        // codec reads back over MajorRecordFlagsRaw wholesale, so a bit no name spells rides in as
        // its number and sets bit 14 as a side effect.
        var result = Service().Set(
            Plugin, PartialCell.ToString(), "MajorFlags",
            Json($"[\"Persistent\", \"{PartialFormBit.ToString(CultureInfo.InvariantCulture)}\"]"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.SyntheticMemberIndirectWrite, result.Refusal);
        Assert.Equal(before, File.ReadAllText(path));
    }

    // Mutagen spells the same flags again under Fallout4MajorRecordFlags, ahead of MajorFlags, and
    // its reader takes the last spelling: a write to the earlier one cannot land and is refused,
    // never silently overridden.
    [Fact]
    public void EditField_FallOut4MajorRecordFlags_OverriddenByTheLaterAlias_IsRefusedNotSilentlyLost()
    {
        Assert.True(Service().Set(Plugin, PartialCell.ToString(), "IsPartialForm", Json("false")).Applied);
        var path = SourcePath();
        var before = File.ReadAllText(path);

        var result = Service().Set(
            Plugin, PartialCell.ToString(), "Fallout4MajorRecordFlags",
            Json($"[\"{PartialFormBit.ToString(CultureInfo.InvariantCulture)}\"]"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.CodecDroppedValue, result.Refusal);
        Assert.Equal("Fallout4MajorRecordFlags", result.Path);
        Assert.Equal(before, File.ReadAllText(path));
    }

    // The guard is bit-14-specific, not a blanket lockout: a write through either column that leaves
    // bit 14 untouched still succeeds. Unflagged for the same reason as the tests above.
    [Fact]
    public void EditField_MajorFlags_NotTouchingBit14_Succeeds()
    {
        Assert.True(Service().Set(Plugin, PartialCell.ToString(), "IsPartialForm", Json("false")).Applied);

        var result = Service().Set(Plugin, PartialCell.ToString(), "MajorFlags", Json("[\"Persistent\"]"));

        Assert.True(result.Applied);
    }

    private string SourcePath() =>
        Directory.EnumerateFiles(_modFolder, "RecordData.json", SearchOption.AllDirectories)
            .Single(p => p.Contains("PartialCell", StringComparison.Ordinal));

    private static System.Text.Json.JsonElement Json(string json) =>
        System.Text.Json.JsonSerializer.Deserialize<System.Text.Json.JsonElement>(json);
}
