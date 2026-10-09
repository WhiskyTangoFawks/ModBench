using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Noggog;
using static MEditService.Commands.Tests.TestSupport.Envelopes;
using static MEditService.Commands.Tests.TestSupport.LoadOrderOfPlugins;

namespace MEditService.Commands.Tests.Edits;

public sealed class NearestCopyToTheLeftTests : IDisposable
{
    private const int Bit9 = 0x0200, Deleted = 0x0020, Persistent = 0x0400, InitiallyDisabled = 0x0800, PartialForm = 0x4000, OffLimits = 0x20000, Compressed = 0x40000;

    private static readonly FormKey TheNpc = new(Fallout4Esm, 0x900);
    private static readonly FormKey TheCell = new(Fallout4Esm, 0x800);
    private static readonly FormKey TheRef = new(Fallout4Esm, 0x901);

    private readonly LoadOrderOfPlugins _plugins = new();
    private Fallout4Mod? _edited;

    public void Dispose() => _plugins.Dispose();

    private static Action<Fallout4Mod> NpcCopy(int flags, string? editorId = null, float height = 0, ushort formVersion = 131) => mod =>
        mod.Npcs.Add(new Npc(TheNpc, Fallout4Release.Fallout4)
        {
            EditorID = editorId,
            HeightMax = height,
            MajorRecordFlagsRaw = flags,
            FormVersion = formVersion,
        });

    private static Action<Fallout4Mod> CellCopy(int flags, string? editorId = null, float? water = null, Action<Cell>? also = null) => mod =>
    {
        var cell = new Cell(TheCell, Fallout4Release.Fallout4)
        {
            EditorID = editorId,
            Flags = Cell.Flag.IsInteriorCell,
            WaterHeight = water,
            MajorRecordFlagsRaw = flags,
        };
        also?.Invoke(cell);
        mod.Cells.Records.Add(BlockOf(cell));
    };

    private static Action<Fallout4Mod> Mastering(string master, Action<Fallout4Mod> holds) => mod =>
    {
        mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName(master) });
        mod.Npcs.Add(new Npc(new FormKey(ModKey.FromFileName(master), 0x950), Fallout4Release.Fallout4) { EditorID = "Link" });
        holds(mod);
    };

    private static Action<Cell> Placing(PlacedObject placed) => cell => cell.Temporary.Add(placed);

    private void Load(params (Fallout4Mod Mod, bool Tracked)[] plugins)
    {
        _plugins.Load(plugins);
        _edited = plugins[^1].Mod;
    }

    private Fallout4Mod Edited => _edited ?? throw new InvalidOperationException("Load the plugins first.");

    private RecordEditResult WriteFlags(FormKey formKey, int raw) =>
        _plugins.EditHandler.Edit(
            Address(Edited), formKey.ToString(),
            SetAt(JsonDocument.Parse(raw.ToString(CultureInfo.InvariantCulture)).RootElement, Member("MajorRecordFlagsRaw")));

    private JsonObject Written(FormKey formKey, int raw)
    {
        var result = WriteFlags(formKey, raw);
        Assert.True(result.Applied, result.Message);
        return JsonNode.Parse(_plugins.Text(Edited, formKey)).Require().AsObject();
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
    public void ClearingDeleted_TakesTheRecordFlagsAndFormVersionOfTheCopyToItsLeft()
    {
        Load(
            (Plugin("Fallout4.esm", NpcCopy(Compressed | InitiallyDisabled, "Guy", formVersion: 120)), false),
            (Plugin("Override.esp", NpcCopy(Deleted | Bit9, formVersion: 131)), true));

        var undeleted = Written(TheNpc, Bit9);

        Assert.Equal(Compressed | InitiallyDisabled, undeleted["MajorRecordFlagsRaw"]?.GetValue<int>());
        Assert.Equal(120, undeleted["FormVersion"]?.GetValue<int>());
    }

    [Fact]
    public void ClearingDeleted_KeepsEachOtherBitTheWriteChanges_AndTakesTheRestFromTheCopyToItsLeft()
    {
        Load(
            (Plugin("Fallout4.esm", NpcCopy(Bit9 | InitiallyDisabled, "Guy")), false),
            (Plugin("Override.esp", NpcCopy(Deleted | Bit9)), true));

        var undeleted = Written(TheNpc, OffLimits);

        Assert.Equal(OffLimits | InitiallyDisabled, undeleted["MajorRecordFlagsRaw"]?.GetValue<int>());
    }

    [Fact]
    public void ClearingDeleted_AndSettingPersistent_OnAPlacedRecord_MovesItIntoItsCellsPersistentGroup()
    {
        var rock = new PlacedObject(TheRef, Fallout4Release.Fallout4) { EditorID = "Rock" };
        var deleted = new PlacedObject(TheRef, Fallout4Release.Fallout4) { MajorRecordFlagsRaw = Deleted };
        Load(
            (Plugin("Fallout4.esm", CellCopy(0, "Inside", also: Placing(rock))), false),
            (Plugin("Override.esp", CellCopy(0, "Inside", also: Placing(deleted))), true));

        var undeleted = Written(TheRef, Persistent);

        var cell = JsonNode.Parse(_plugins.Text(Edited, TheCell)).Require().AsObject();
        Assert.Equal(Persistent, undeleted["MajorRecordFlagsRaw"]?.GetValue<int>());
        Assert.Equal(["Rock"], cell["Persistent"].Require().AsArray().Select(r => r?["EditorID"]?.GetValue<string>()));
    }

    [Fact]
    public void ClearingDeleted_DropsItsFormVersion_WhenTheCopyToItsLeftSpellsNone()
    {
        var middle = Plugin("Middle.esp", NpcCopy(0, "Guy", formVersion: 120));
        Load(
            (Plugin("Fallout4.esm", NpcCopy(0, "Guy")), false),
            (middle, true),
            (Plugin("Override.esp", Mastering("Middle.esp", NpcCopy(Deleted))), true));
        _plugins.Respell(middle, TheNpc, "npc_", "\"FormVersion\": 120,", "");
        _plugins.Respell(Edited, TheNpc, "npc_", "\"IsDeleted\": true,", "\"IsDeleted\": true, \"FormVersion\": 140,");
        Assert.Contains("FormVersion", _plugins.Text(Edited, TheNpc));

        var undeleted = Written(TheNpc, 0);

        Assert.DoesNotContain(undeleted, p => p.Key == "FormVersion");
    }

    [Fact]
    public void ClearingDeleted_FillsFromThePluginFile_OfACopyToItsLeftWhosePluginSourceIsUnreadable()
    {
        var middle = Plugin("Middle.esp", NpcCopy(0, "Middle"));
        Load(
            (Plugin("Fallout4.esm", NpcCopy(0, "Guy")), false),
            (middle, true),
            (Plugin("Override.esp", Mastering("Middle.esp", NpcCopy(Deleted))), true));
        Directory.Delete(PluginSourceRoot.In(_plugins.FolderOf(middle), "Middle.esp"), recursive: true);

        var undeleted = Written(TheNpc, 0);

        Assert.Equal("Middle", undeleted["EditorID"]?.GetValue<string>());
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
    public void ClearingDeleted_PassesOverADeletedCopyToItsLeft_ThatCannotBeRead()
    {
        var middle = Plugin("Middle.esp", NpcCopy(Deleted));
        Load(
            (Plugin("Fallout4.esm", NpcCopy(0, "Guy", 0.7f)), false),
            (middle, false),
            (Plugin("Override.esp", NpcCopy(Deleted)), true));
        _plugins.Rewrite(middle, path => DeletedNpcPlugin.WriteHoldingFields(path, TheNpc, Fallout4Esm));

        var undeleted = Written(TheNpc, 0);

        Assert.Equal(0.7f, undeleted["HeightMax"]?.GetValue<float>());
    }

    [Fact]
    public void ClearingDeleted_PassesOverADeletedCopyToItsLeft_ThatATrackedPluginHolds()
    {
        Load(
            (Plugin("Fallout4.esm", NpcCopy(0, "Guy", 0.7f)), false),
            (Plugin("Middle.esp", NpcCopy(Deleted)), true),
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
            (Plugin("Override.esp", Mastering("Middle.esp", NpcCopy(Deleted))), true));

        var undeleted = Written(TheNpc, 0);

        Assert.Equal(0.9f, undeleted["HeightMax"]?.GetValue<float>());
    }

    [Fact]
    public void ClearingDeleted_InADisabledPlugin_TakesTheNearestCopyToTheLeftOfItsLine()
    {
        var disabled = Plugin("Override.esp", Mastering("Middle.esp", NpcCopy(Deleted)));
        _plugins.Load(
            (Plugin("Fallout4.esm", NpcCopy(0, "Guy", 0.7f)), false),
            (disabled, true),
            (Plugin("Middle.esp", NpcCopy(0, "Guy", 0.9f)), false));
        _plugins.Relist(Address(disabled), entry => entry with { Enabled = false });
        _edited = disabled;

        var undeleted = Written(TheNpc, 0);

        Assert.Equal(0.7f, undeleted["HeightMax"]?.GetValue<float>());
    }

    [Fact]
    public void ClearingDeleted_InAPluginWithNoLine_TakesTheNearestCopyAmongItsMasters()
    {
        var unlisted = Plugin("Override.esp", Mastering("Middle.esp", NpcCopy(Deleted)));
        _plugins.Load(
            (Plugin("Fallout4.esm", NpcCopy(0, "Guy", 0.7f)), false),
            (Plugin("Middle.esp", NpcCopy(0, "Guy", 0.9f)), false),
            (unlisted, true));
        _plugins.Relist(Address(unlisted), entry => entry with { Line = null });
        _edited = unlisted;

        var undeleted = Written(TheNpc, 0);

        Assert.Equal(0.9f, undeleted["HeightMax"]?.GetValue<float>());
    }

    [Fact]
    public void ClearingDeleted_TakesTheCopyOfADisabledMasterThatItsLineNames()
    {
        var edited = Plugin("Override.esp", Mastering("Middle.esp", NpcCopy(Deleted)));
        _plugins.Load(
            (Plugin("Fallout4.esm", NpcCopy(0, "Guy", 0.7f)), "Fallout4Mod", false, Listing.Winning),
            (Plugin("Middle.esp", NpcCopy(0, "Guy", 0.8f)), "FirstMod", false, Listing.Winning),
            (Plugin("Middle.esp", NpcCopy(0, "Guy", 0.9f)), "SecondMod", false, Listing.Overridden),
            (edited, "OverrideMod", true, Listing.Winning));
        _plugins.Relist(new("Middle.esp", "FirstMod"), entry => entry with { Winning = false });
        _plugins.Relist(new("Middle.esp", "SecondMod"), entry => entry with { Winning = true, Enabled = false });
        _edited = edited;

        var undeleted = Written(TheNpc, 0);

        Assert.Equal(0.9f, undeleted["HeightMax"]?.GetValue<float>());
    }

    [Fact]
    public void ClearingDeleted_TakesTheMastersCopy_OverANearerCopyOfAPluginThatIsNoMaster()
    {
        Load(
            (Plugin("Fallout4.esm", NpcCopy(0, "Guy", 0.7f)), false),
            (Plugin("Stranger.esp", NpcCopy(0, "Guy", 0.9f)), false),
            (Plugin("Override.esp", NpcCopy(Deleted)), true));

        var undeleted = Written(TheNpc, 0);

        Assert.Equal(0.7f, undeleted["HeightMax"]?.GetValue<float>());
    }

    [Fact]
    public void ClearingDeleted_LeavesTheFieldsEmpty_WhenTheOnlyCopyToItsLeftThatIsNotDeletedIsNoMasters()
    {
        Load(
            (Plugin("Fallout4.esm", NpcCopy(Deleted)), false),
            (Plugin("Stranger.esp", NpcCopy(0, "Guy", 0.9f)), false),
            (Plugin("Override.esp", NpcCopy(Deleted)), true));

        var undeleted = Written(TheNpc, 0);

        Assert.DoesNotContain(undeleted, p => p.Key == "EditorID");
        Assert.DoesNotContain(undeleted, p => p.Key == "HeightMax" && p.Value?.GetValue<float>() != 0);
    }

    [Fact]
    public void ClearingDeleted_WhenAnotherDocumentOfItsSourceTreeCannotBeRead_IsRefusedAsRecordParseFailed_NamingTheTreeAndWhatItNeeds_AndAnswersNoChanges()
    {
        var other = new FormKey(ModKey.FromFileName("Override.esp"), 0x951);
        Load(
            (Plugin("Fallout4.esm", NpcCopy(0, "Guy", 0.7f)), false),
            (Plugin("Override.esp", mod =>
            {
                NpcCopy(Deleted)(mod);
                mod.Npcs.Add(new Npc(other, Fallout4Release.Fallout4) { EditorID = "Other" });
            }), true));
        var before = _plugins.Text(Edited, TheNpc);
        _plugins.Respell(Edited, other, "npc_", "{", "[");

        var result = WriteFlags(TheNpc, 0);

        Assert.Equal(RecordEditRefusal.RecordParseFailed, result.Refusal);
        Assert.Contains(
            $"{TheNpc}'s own fields come from its nearest copy to the left that is not Deleted, and the source tree that names Override.esp's masters cannot be read",
            result.Message, StringComparison.Ordinal);
        Assert.Equal(before, _plugins.Text(Edited, TheNpc));
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
    public void ClearingDeleted_OnAPlacedRecord_WhoseCopyToItsLeftIsPersistent_MovesItIntoItsCellsPersistentGroup()
    {
        var rock = new PlacedObject(TheRef, Fallout4Release.Fallout4) { EditorID = "Rock", MajorRecordFlagsRaw = Persistent };
        var deleted = new PlacedObject(TheRef, Fallout4Release.Fallout4) { MajorRecordFlagsRaw = Deleted };
        Load(
            (Plugin("Fallout4.esm", CellCopy(0, "Inside", also: cell => cell.Persistent.Add(rock))), false),
            (Plugin("Override.esp", CellCopy(0, "Inside", also: Placing(deleted))), true));

        var undeleted = Written(TheRef, 0);

        var cell = JsonNode.Parse(_plugins.Text(Edited, TheCell)).Require().AsObject();
        Assert.Equal(Persistent, undeleted["MajorRecordFlagsRaw"]?.GetValue<int>());
        Assert.Equal(["Rock"], cell["Persistent"].Require().AsArray().Select(r => r?["EditorID"]?.GetValue<string>()));
        Assert.DoesNotContain(cell, p => p.Key == "Temporary" && p.Value is JsonArray { Count: > 0 });
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
    public void ClearingPartialForm_TakesTheRecordFlagsAndFormVersionOfTheCopyToItsLeft()
    {
        Load(
            (Plugin("Fallout4.esm", CellCopy(OffLimits, "Inside", also: cell => cell.FormVersion = 120)), false),
            (Plugin("Override.esp", CellCopy(PartialForm, "Inside", also: cell => cell.FormVersion = 131)), true));

        var whole = Written(TheCell, 0);

        Assert.Equal(OffLimits, whole["MajorRecordFlagsRaw"]?.GetValue<int>());
        Assert.Equal(120, whole["FormVersion"]?.GetValue<int>());
    }

    [Fact]
    public void ClearingPartialForm_RemovesAFieldTheCopyToItsLeftLacks()
    {
        Load(
            (Plugin("Fallout4.esm", CellCopy(0, "Inside")), false),
            (Plugin("Override.esp", CellCopy(PartialForm, "Inside", 3f)), true));

        var whole = Written(TheCell, 0);

        Assert.DoesNotContain(whole, p => p.Key == "WaterHeight");
    }

    [Fact]
    public void ClearingPartialForm_KeepsTheCopysChildren()
    {
        var theirs = new PlacedObject(TheRef, Fallout4Release.Fallout4) { EditorID = "Theirs" };
        var mine = new PlacedObject(new FormKey(ModKey.FromFileName("Override.esp"), 0x801), Fallout4Release.Fallout4) { EditorID = "Mine" };
        Load(
            (Plugin("Fallout4.esm", CellCopy(0, "Inside", 5f, Placing(theirs))), false),
            (Plugin("Override.esp", CellCopy(PartialForm, "Inside", also: Placing(mine))), true));

        var whole = Written(TheCell, 0);

        Assert.Equal([mine.FormKey.ToString()], whole["Temporary"].Require().AsArray().Select(r => r?["FormKey"]?.GetValue<string>()));
    }

    [Fact]
    public void ClearingPartialForm_SetsVersionControlInfo1And2ToZero()
    {
        Load(
            (Plugin("Fallout4.esm", CellCopy(0, "Inside", also: cell => { cell.VersionControl = 3; cell.Version2 = 4; })), false),
            (Plugin("Override.esp", CellCopy(PartialForm, "Inside", also: cell => { cell.VersionControl = 7; cell.Version2 = 8; })), true));

        var whole = Written(TheCell, 0);

        Assert.Equal(0, whole["VersionControl"]?.GetValue<int>() ?? 0);
        Assert.Equal(0, whole["Version2"]?.GetValue<int>() ?? 0);
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
    public void SettingPartialForm_OnADeletedCopy_TakesTheRecordFlagsAndFormVersionOfTheCopyToItsLeft()
    {
        Load(
            (Plugin("Fallout4.esm", CellCopy(OffLimits, "Inside", also: cell => cell.FormVersion = 120)), false),
            (Plugin("Override.esp", CellCopy(Deleted, also: cell => cell.FormVersion = 131)), true));

        var partial = Written(TheCell, PartialForm);

        Assert.Equal(OffLimits | PartialForm, partial["MajorRecordFlagsRaw"]?.GetValue<int>());
        Assert.Equal(120, partial["FormVersion"]?.GetValue<int>());
    }

    [Fact]
    public void SettingDeletedAndPartialFormTogether_WithACopyToItsLeft_EndsAPartialFormThatIsNotDeleted()
    {
        Load(
            (Plugin("Fallout4.esm", CellCopy(OffLimits, "Inside")), false),
            (Plugin("Override.esp", CellCopy(0, "Mine")), true));

        var partial = Written(TheCell, Deleted | PartialForm);

        Assert.Equal(OffLimits | PartialForm, partial["MajorRecordFlagsRaw"]?.GetValue<int>());
    }

    [Fact]
    public void SettingPartialForm_OnADeletedCopy_ClearsCompressed_WhichItsCopyToTheLeftHolds()
    {
        Load(
            (Plugin("Fallout4.esm", CellCopy(Compressed, "Inside")), false),
            (Plugin("Override.esp", CellCopy(Deleted)), true));

        var partial = Written(TheCell, PartialForm);

        Assert.Equal(PartialForm, partial["MajorRecordFlagsRaw"]?.GetValue<int>());
    }

    [Fact]
    public void ClearingDeleted_WhenTheNearestCopyToItsLeftCannotBeRead_IsRefusedAsRecordParseFailed_NamingItsPlugin_AndAnswersNoChanges()
    {
        var middle = Plugin("Middle.esp", NpcCopy(0, "Guy", 0.9f));
        Load(
            (Plugin("Fallout4.esm", NpcCopy(0, "Guy", 0.7f)), false),
            (middle, true),
            (Plugin("Override.esp", Mastering("Middle.esp", NpcCopy(Deleted))), true));
        _plugins.Respell(middle, TheNpc, "npc_", "0.9", "\"tall\"");
        var before = _plugins.Text(Edited, TheNpc);

        var result = WriteFlags(TheNpc, 0);

        Assert.Equal(RecordEditRefusal.RecordParseFailed, result.Refusal);
        Assert.Contains("Middle.esp's copy of", result.Message, StringComparison.Ordinal);
        Assert.Contains("that is not Deleted", result.Message, StringComparison.Ordinal);
        Assert.Equal(before, _plugins.Text(Edited, TheNpc));
    }

    [Fact]
    public void ClearingDeleted_WhenTheNearestCopyToItsLeftIsNoJsonDocument_IsRefusedNamingItsPlugin()
    {
        var middle = Plugin("Middle.esp", NpcCopy(0, "Guy", 0.9f));
        Load(
            (Plugin("Fallout4.esm", NpcCopy(0, "Guy", 0.7f)), false),
            (middle, true),
            (Plugin("Override.esp", Mastering("Middle.esp", NpcCopy(Deleted))), true));
        _plugins.Respell(middle, TheNpc, "npc_", "{", "[");

        var result = WriteFlags(TheNpc, 0);

        Assert.Equal(RecordEditRefusal.RecordParseFailed, result.Refusal);
        Assert.Contains("Middle.esp's copy of", result.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void SettingPartialForm_OnACellThatSaysNotWhereItSits_IsDecidedByTheMastersKind_NotANonMastersNearerOne()
    {
        Load(
            (Plugin("Fallout4.esm", CellCopy(0, "Inside")), false),
            (Plugin("Stranger.esp", CellCopy(0, "Outside", also: cell =>
            {
                cell.Flags = 0;
                cell.Grid = new CellGrid { Point = new P2Int(1, 2) };
            })), false),
            (Plugin("Override.esp", mod => mod.Cells.Records.Add(BlockOf(new Cell(TheCell, Fallout4Release.Fallout4) { EditorID = "Inside" }))), true));

        var result = WriteFlags(TheCell, PartialForm);

        Assert.True(result.Applied, result.Message);
    }

    [Fact]
    public void SettingPartialForm_OnACellThatSaysNotWhereItSits_PassesOverANearerMastersCopyThatSaysNeither()
    {
        Load(
            (Plugin("Fallout4.esm", CellCopy(0, "Inside")), false),
            (Plugin("Middle.esp", CellCopy(PartialForm, "Middle", also: cell => cell.Flags = 0)), false),
            (Plugin("Override.esp", Mastering("Middle.esp", mod => mod.Cells.Records.Add(BlockOf(new Cell(TheCell, Fallout4Release.Fallout4) { EditorID = "Inside" })))), true));

        var result = WriteFlags(TheCell, PartialForm);

        Assert.True(result.Applied, result.Message);
    }

    [Fact]
    public void SettingPartialForm_OnACellThatSaysNotWhereItSits_WhenItsCopyToTheLeftCannotBeRead_IsRefusedNamingItsPlugin()
    {
        var middle = Plugin("Middle.esp", CellCopy(0, "Inside", 4f));
        Load(
            (Plugin("Fallout4.esm", CellCopy(0, "Inside")), false),
            (middle, true),
            (Plugin("Override.esp", Mastering("Middle.esp", mod => mod.Cells.Records.Add(BlockOf(new Cell(TheCell, Fallout4Release.Fallout4) { EditorID = "Inside" })))), true));
        _plugins.Respell(middle, TheCell, "cell", "\"WaterHeight\": 4.0", "\"WaterHeight\": \"deep\"");

        var result = WriteFlags(TheCell, PartialForm);

        Assert.Equal(RecordEditRefusal.RecordParseFailed, result.Refusal);
        Assert.Contains("Middle.esp's copy of", result.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void SettingPersistent_OnARecordWhoseCellSaysNotWhereItSits_WhenTheCellsCopyToTheLeftCannotBeRead_IsRefusedNamingItsPlugin()
    {
        var middle = Plugin("Middle.esp", CellCopy(0, "Inside", 4f));
        var rock = new PlacedObject(new FormKey(ModKey.FromFileName("Override.esp"), 0x801), Fallout4Release.Fallout4) { EditorID = "Rock" };
        var placing = new Cell(TheCell, Fallout4Release.Fallout4) { EditorID = "Inside" };
        placing.Temporary.Add(rock);
        Load(
            (Plugin("Fallout4.esm", CellCopy(0, "Inside")), false),
            (middle, true),
            (Plugin("Override.esp", Mastering("Middle.esp", mod => mod.Cells.Records.Add(BlockOf(placing)))), true));
        _plugins.Respell(middle, TheCell, "cell", "\"WaterHeight\": 4.0", "\"WaterHeight\": \"deep\"");

        var result = WriteFlags(rock.FormKey, Persistent);

        Assert.Equal(RecordEditRefusal.RecordParseFailed, result.Refusal);
        Assert.Contains("Middle.esp's copy of", result.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void WritesThatReadNoCopyToTheLeft_ApplyWhenTheSourceTreeNamingTheMastersCannotBeRead()
    {
        var rock = new PlacedObject(TheRef, Fallout4Release.Fallout4) { EditorID = "Rock" };
        var other = new FormKey(ModKey.FromFileName("Override.esp"), 0x951);
        Load(
            (Plugin("Fallout4.esm", CellCopy(0, "Inside")), false),
            (Plugin("Override.esp", mod =>
            {
                CellCopy(PartialForm, "Inside", also: cell =>
                {
                    cell.Flags = 0;
                    cell.Temporary.Add(rock);
                })(mod);
                mod.Npcs.Add(new Npc(other, Fallout4Release.Fallout4) { EditorID = "Other" });
            }), true));
        _plugins.Respell(Edited, other, "npc_", "{", "[");

        var placed = WriteFlags(TheRef, InitiallyDisabled);
        var partial = WriteFlags(TheCell, PartialForm | InitiallyDisabled);

        Assert.True(placed.Applied, placed.Message);
        Assert.True(partial.Applied, partial.Message);
    }

    private static CellBlock BlockOf(Cell cell)
    {
        var subBlock = new CellSubBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellSubBlock };
        subBlock.Cells.Add(cell);
        var block = new CellBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellBlock };
        block.SubBlocks.Add(subBlock);
        return block;
    }
}
