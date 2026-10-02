using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;
using static MEditService.Commands.Tests.TestSupport.Envelopes;

namespace MEditService.Commands.Tests.Edits;

public sealed class DeletedAndPartialFormFlagEditTests : IDisposable
{
    private const int Deleted = 0x0020, Persistent = 0x0400, PartialForm = 0x4000;

    private static readonly RecordTextCodec Codec = new(NullLogger<RecordTextCodec>.Instance);
    private static readonly ModKey Fallout4Esm = ModKey.FromFileName("Fallout4.esm");

    private readonly DocumentEditFixture _fixture = new();
    private readonly Fallout4Mod _mod = new(ModKey.FromFileName("DocEdit.esp"), Fallout4Release.Fallout4);

    public void Dispose() => _fixture.Dispose();

    private static Cell InteriorCellOfFallout4Esm() =>
        new(new FormKey(Fallout4Esm, 0x800), Fallout4Release.Fallout4) { EditorID = "C", Flags = Cell.Flag.IsInteriorCell };

    private static Cell ExteriorCellOfFallout4Esm(int flags) =>
        new(new FormKey(Fallout4Esm, 0x800), Fallout4Release.Fallout4)
        {
            EditorID = "C",
            Grid = new CellGrid { Point = new P2Int(3, -2) },
            MajorRecordFlagsRaw = flags,
        };

    private static JsonElement Flags(int raw) => JsonDocument.Parse(raw.ToString(CultureInfo.InvariantCulture)).RootElement;

    private (RecordEditResult Result, string? After) WriteFlags(string formKey, int raw) =>
        _fixture.Apply(formKey, SetAt(Flags(raw), Member("MajorRecordFlagsRaw")));

    private JsonObject SetFlags(string formKey, int raw)
    {
        var (result, after) = WriteFlags(formKey, raw);
        Assert.True(result.Applied, result.Message);
        return Parse(after.Require());
    }

    private void AssertRefusedUnchanged(string formKey, int raw)
    {
        var before = _fixture.Document(formKey);

        var (result, _) = WriteFlags(formKey, raw);

        Assert.Equal(RecordEditRefusal.CannotBePartialForm, result.Refusal);
        Assert.Equal(before, _fixture.Document(formKey));
    }

    private static JsonObject Parse(string text) => JsonNode.Parse(text).Require().AsObject();

    private static int FlagsOf(JsonObject document) => document["MajorRecordFlagsRaw"].Require().GetValue<int>();

    [Fact]
    public void SettingDeleted_LeavesTheRecordItsHeaderAlone_RemovingItsEditorId()
    {
        var npc = _mod.Npcs.AddNew("Guy");
        npc.HeightMax = 1f;
        npc.VersionControl = 7;
        var formKey = _fixture.Seed(npc, "npc_");
        var headerAlone = new Npc(npc.FormKey, Fallout4Release.Fallout4) { MajorRecordFlagsRaw = Deleted, VersionControl = 7 };

        var deleted = SetFlags(formKey, Deleted);

        Assert.True(
            JsonNode.DeepEquals(Parse(Codec.SerializeToText(headerAlone, GameRelease.Fallout4)), deleted),
            deleted.ToJsonString());
    }

    [Fact]
    public void SettingDeleted_OnAContainer_KeepsItsChildren()
    {
        var cell = new Cell(_mod) { EditorID = "C", WaterHeight = 5f, Landscape = new Landscape(_mod) };
        var formKey = _fixture.Seed(cell, "cell");
        var landscape = Parse(_fixture.Document(formKey))["Landscape"].Require().DeepClone();

        var deleted = SetFlags(formKey, Deleted);

        Assert.True(JsonNode.DeepEquals(landscape, deleted["Landscape"]), deleted.ToJsonString());
        Assert.DoesNotContain(deleted, p => p.Key is "EditorID" or "WaterHeight");
    }

    [Fact]
    public void SettingDeleted_OnAPartialForm_ClearsPartialForm()
    {
        var cell = new Cell(_mod) { EditorID = "C", WaterHeight = 5f, MajorRecordFlagsRaw = PartialForm };
        var formKey = _fixture.Seed(cell, "cell");

        var deleted = SetFlags(formKey, PartialForm | Deleted);

        Assert.Equal(Deleted, FlagsOf(deleted));
        Assert.DoesNotContain(deleted, p => p.Key is "EditorID" or "WaterHeight");
    }

    [Fact]
    public void SettingDeleted_OnAPartialForm_KeepsItsChildren()
    {
        var cell = new Cell(_mod) { EditorID = "C", MajorRecordFlagsRaw = PartialForm, Landscape = new Landscape(_mod) };
        var formKey = _fixture.Seed(cell, "cell");
        var landscape = Parse(_fixture.Document(formKey))["Landscape"].Require().DeepClone();

        var deleted = SetFlags(formKey, PartialForm | Deleted);

        Assert.True(JsonNode.DeepEquals(landscape, deleted["Landscape"]), deleted.ToJsonString());
    }

    [Fact]
    public void SettingDeleted_OnARecordOfSeveralKinds_KeepsItsKind()
    {
        var global = _mod.Globals.AddNewInt("Gi");
        global.Data = 3;
        var formKey = _fixture.Seed(global, "glob");
        var kind = Parse(_fixture.Document(formKey))["MutagenObjectType"].Require().GetValue<string>();

        var deleted = SetFlags(formKey, Deleted);

        Assert.Equal(kind, deleted["MutagenObjectType"].Require().GetValue<string>());
        Assert.DoesNotContain(deleted, p => p.Key is "EditorID" or "Data");
    }

    [Fact]
    public void AnotherFlag_OnACopyAlreadyDeleted_ChangesOnlyItsBit()
    {
        var npc = _mod.Npcs.AddNew("Guy");
        npc.HeightMax = 0.5f;
        npc.MajorRecordFlagsRaw = Deleted;
        var formKey = _fixture.Seed(npc, "npc_");

        var persistent = SetFlags(formKey, Deleted | Persistent);

        Assert.Equal(Deleted | Persistent, FlagsOf(persistent));
        Assert.Equal(0.5f, persistent["HeightMax"].Require().GetValue<float>());
        Assert.Equal("Guy", persistent["EditorID"].Require().GetValue<string>());
    }

    [Fact]
    public void SettingPartialForm_LeavesTheCopyItsHeaderAndItsEditorIdAlone()
    {
        var cell = InteriorCellOfFallout4Esm();
        cell.WaterHeight = 5f;
        cell.VersionControl = 7;
        var formKey = _fixture.Seed(cell, "cell");
        var headerAndEditorId = new Cell(cell.FormKey, Fallout4Release.Fallout4)
        {
            EditorID = "C",
            MajorRecordFlagsRaw = PartialForm,
            VersionControl = 7,
        };

        var partial = SetFlags(formKey, PartialForm);

        Assert.True(
            JsonNode.DeepEquals(Parse(Codec.SerializeToText(headerAndEditorId, GameRelease.Fallout4)), partial),
            partial.ToJsonString());
    }

    [Fact]
    public void SettingPartialForm_KeepsTheCopysChildren()
    {
        var cell = InteriorCellOfFallout4Esm();
        cell.WaterHeight = 5f;
        cell.Landscape = new Landscape(_mod);
        var formKey = _fixture.Seed(cell, "cell");
        var landscape = Parse(_fixture.Document(formKey))["Landscape"].Require().DeepClone();

        var partial = SetFlags(formKey, PartialForm);

        Assert.True(JsonNode.DeepEquals(landscape, partial["Landscape"]), partial.ToJsonString());
        Assert.DoesNotContain(partial, p => p.Key == "WaterHeight");
    }

    [Fact]
    public void SettingPartialForm_OnADeletedCopy_ClearsDeleted()
    {
        var cell = InteriorCellOfFallout4Esm();
        cell.MajorRecordFlagsRaw = Deleted | Persistent;
        var formKey = _fixture.Seed(cell, "cell");

        var partial = SetFlags(formKey, Deleted | Persistent | PartialForm);

        Assert.Equal(Persistent | PartialForm, FlagsOf(partial));
    }

    [Fact]
    public void SettingDeletedAndPartialFormTogether_OnACopyHoldingNeither_MakesAPartialForm()
    {
        var cell = InteriorCellOfFallout4Esm();
        cell.WaterHeight = 5f;
        var formKey = _fixture.Seed(cell, "cell");

        var partial = SetFlags(formKey, Deleted | PartialForm);

        Assert.Equal(PartialForm, FlagsOf(partial));
        Assert.Equal("C", partial["EditorID"].Require().GetValue<string>());
        Assert.DoesNotContain(partial, p => p.Key == "WaterHeight");
    }

    [Fact]
    public void Bit14_OnATypeThatCannotBeAPartialForm_ChangesOnlyItsBit()
    {
        var npc = _mod.Npcs.AddNew("Guy");
        npc.HeightMax = 0.5f;
        var formKey = _fixture.Seed(npc, "npc_");

        var written = SetFlags(formKey, PartialForm);

        Assert.Equal(PartialForm, FlagsOf(written));
        Assert.Equal(0.5f, written["HeightMax"].Require().GetValue<float>());
    }

    [Fact]
    public void ClearingPartialForm_MakesTheCopysOwnFieldsEditable()
    {
        var cell = InteriorCellOfFallout4Esm();
        cell.MajorRecordFlagsRaw = PartialForm;
        var formKey = _fixture.Seed(cell, "cell");

        SetFlags(formKey, 0);
        var (result, _) = _fixture.Apply(formKey, SetAt(Flags(9), Member("WaterHeight")));

        Assert.True(result.Applied, result.Message);
    }

    [Fact]
    public void ARecordHeaderRow_OnAPartialForm_Edits()
    {
        var cell = new Cell(_mod) { EditorID = "C", MajorRecordFlagsRaw = PartialForm };
        var formKey = _fixture.Seed(cell, "cell");

        var (result, after) = _fixture.Apply(formKey, SetAt(Flags(9), Member("VersionControl")));

        Assert.True(result.Applied, result.Message);
        Assert.Equal(9, Parse(after.Require())["VersionControl"].Require().GetValue<int>());
    }

    [Fact]
    public void AViewOfRecordFlags_IsRefused_AndWritesNothing()
    {
        var formKey = _fixture.Seed(InteriorCellOfFallout4Esm(), "cell");
        var before = _fixture.Document(formKey);

        var (result, _) = _fixture.Apply(
            formKey, SetAt(JsonDocument.Parse("[\"Deleted\"]").RootElement, Member("Fallout4MajorRecordFlags")));

        Assert.Equal(RecordEditRefusal.FieldNotFound, result.Refusal);
        Assert.Equal(before, _fixture.Document(formKey));
    }

    [Fact]
    public void SettingPartialForm_OnATemporaryExteriorCell_IsRefused_AndWritesNothing()
    {
        var formKey = _fixture.Seed(ExteriorCellOfFallout4Esm(0), "cell");

        AssertRefusedUnchanged(formKey, PartialForm);
    }

    [Fact]
    public void SettingPartialForm_OnAPersistentExteriorCell_EmptiesIt()
    {
        var formKey = _fixture.Seed(ExteriorCellOfFallout4Esm(Persistent), "cell");

        var partial = SetFlags(formKey, Persistent | PartialForm);

        Assert.DoesNotContain(partial, p => p.Key == "Grid");
    }

    [Fact]
    public void SettingPartialForm_OnACellAPluginOtherThanFallout4EsmDefines_IsRefused_AndWritesNothing()
    {
        var formKey = _fixture.Seed(new Cell(_mod) { EditorID = "C", Flags = Cell.Flag.IsInteriorCell }, "cell");

        AssertRefusedUnchanged(formKey, PartialForm);
    }

    [Fact]
    public void SettingPartialForm_OnACellThatSaysNotWhereItSits_WithNoCopyToItsLeft_IsRefused_AndWritesNothing()
    {
        var formKey = _fixture.Seed(new Cell(new FormKey(Fallout4Esm, 0x800), Fallout4Release.Fallout4) { EditorID = "C" }, "cell");

        AssertRefusedUnchanged(formKey, PartialForm);
    }

    [Fact]
    public void SettingPartialForm_OnAQuestAPluginOtherThanFallout4EsmDefines_EmptiesIt()
    {
        var formKey = _fixture.Seed(new Quest(_mod) { EditorID = "Q", Filter = "F" }, "qust");

        var partial = SetFlags(formKey, PartialForm);

        Assert.DoesNotContain(partial, p => p.Key == "Filter");
    }
}
