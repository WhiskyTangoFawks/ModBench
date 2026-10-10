using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Noggog;
using static MEditService.Commands.Tests.TestSupport.Envelopes;

namespace MEditService.Commands.Tests.Edits;

public sealed class DeletedAndPartialFormFlagEditTests : IDisposable
{
    private const int Deleted = 0x0020, Persistent = 0x0400, PartialForm = 0x4000, Compressed = 0x40000;

    private static readonly ModKey Fallout4Esm = ModKey.FromFileName("Fallout4.esm");

    private readonly DocumentEditFixture _fixture = new();
    private readonly Fallout4Mod _mod = new(DocumentEditFixture.ModKey, Fallout4Release.Fallout4);

    public void Dispose() => _fixture.Dispose();

    private static Cell InteriorCellOfFallout4Esm(int flags = 0) =>
        new(new FormKey(Fallout4Esm, 0x800), Fallout4Release.Fallout4)
        {
            EditorID = "C",
            Flags = Cell.Flag.IsInteriorCell,
            MajorRecordFlagsRaw = flags,
        };

    private static Cell ExteriorCellOfFallout4Esm(int flags) =>
        new(new FormKey(Fallout4Esm, 0x800), Fallout4Release.Fallout4)
        {
            EditorID = "C",
            Grid = new CellGrid { Point = new P2Int(3, -2) },
            MajorRecordFlagsRaw = flags,
        };

    public static TheoryData<string, Func<IMajorRecordGetter>> RecordsThatCannotBePartialForms => new()
    {
        { "a temporary exterior cell", () => ExteriorCellOfFallout4Esm(0) },
        { "a cell another plugin than Fallout4.esm defines", () => new Cell(DocumentEditFixture.KeyOf(0x800), Fallout4Release.Fallout4) { EditorID = "C", Flags = Cell.Flag.IsInteriorCell } },
        { "a cell that says not where it sits", () => new Cell(new FormKey(Fallout4Esm, 0x800), Fallout4Release.Fallout4) { EditorID = "C" } },
    };

    public static TheoryData<Func<IMajorRecordGetter>, string, int, string> RecordsThatCanBePartialForms => new()
    {
        { () => ExteriorCellOfFallout4Esm(Persistent), "cell", Persistent, "Grid" },
        { () => new Quest(DocumentEditFixture.KeyOf(0x800), Fallout4Release.Fallout4) { EditorID = "Q", Filter = "F" }, "qust", 0, "Filter" },
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

    private static JsonObject Parse(string text) => JsonNode.Parse(text).Require().AsObject();

    private static int FlagsOf(JsonObject document) => document["MajorRecordFlagsRaw"].Require().GetValue<int>();

    [Theory]
    [InlineData(Compressed, Compressed | Deleted, Deleted)]
    [InlineData(Compressed, Compressed | PartialForm, PartialForm)]
    [InlineData(PartialForm, PartialForm | Deleted, Deleted)]
    [InlineData(Deleted | Persistent, Deleted | Persistent | PartialForm, Persistent | PartialForm)]
    [InlineData(0, Deleted | PartialForm, PartialForm)]
    public void DeletedAndPartialFormExcludeEachOtherAndCompressed_WhateverIsWrittenAfterwards(int held, int written, int kept)
    {
        var formKey = _fixture.Seed(InteriorCellOfFallout4Esm(held), "cell");

        Assert.Equal(kept, FlagsOf(SetFlags(formKey, written)));
    }

    [Theory]
    [InlineData(0, Deleted)]
    [InlineData(0, PartialForm)]
    [InlineData(PartialForm, PartialForm | Deleted)]
    public void EmptyingACell_KeepsItsChildren_AndDropsItsOwnFields(int held, int written)
    {
        var cell = InteriorCellOfFallout4Esm(held);
        cell.WaterHeight = 5f;
        cell.Landscape = new Landscape(_mod);
        var formKey = _fixture.Seed(cell, "cell");
        var landscape = Parse(_fixture.Document(formKey))["Landscape"].Require().DeepClone();

        var emptied = SetFlags(formKey, written);

        Assert.True(JsonNode.DeepEquals(landscape, emptied["Landscape"]), emptied.ToJsonString());
        Assert.DoesNotContain(emptied, p => p.Key == "WaterHeight");
    }

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
            JsonNode.DeepEquals(Parse(RecordTextCodec.SerializeToText(headerAlone, GameRelease.Fallout4)), deleted),
            deleted.ToJsonString());
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
            JsonNode.DeepEquals(Parse(RecordTextCodec.SerializeToText(headerAndEditorId, GameRelease.Fallout4)), partial),
            partial.ToJsonString());
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
    public void SettingPersistent_OnADeletedCell_IsRefusedAsPersistentOnDeletedRecord_AndAnswersNoChanges()
    {
        var formKey = _fixture.Seed(InteriorCellOfFallout4Esm(Deleted), "cell");

        var result = _fixture.Refused(formKey, SetAt(Flags(Deleted | Persistent), Member("MajorRecordFlagsRaw")));

        Assert.Equal(RecordEditRefusal.PersistentOnDeletedRecord, result.Refusal);
    }

    [Fact]
    public void ClearingDeleted_WithNoCopyToItsLeft_LeavesItsFieldsEmpty()
    {
        var npc = _mod.Npcs.AddNew("Guy");
        npc.HeightMax = 0.5f;
        npc.MajorRecordFlagsRaw = Deleted;
        var formKey = _fixture.Seed(npc, "npc_");

        var undeleted = SetFlags(formKey, 0);

        Assert.DoesNotContain(undeleted, p => p.Key is "EditorID" or "HeightMax");
    }

    [Fact]
    public void ClearingDeleted_WithNoCopyToItsLeft_KeepsItsFormVersionAndVersionStamps_AndTheFlagsWritten()
    {
        var npc = _mod.Npcs.AddNew("Guy");
        npc.FormVersion = 120;
        npc.VersionControl = 7;
        npc.Version2 = 8;
        npc.MajorRecordFlagsRaw = Deleted | Persistent;
        var formKey = _fixture.Seed(npc, "npc_");

        var undeleted = SetFlags(formKey, Persistent);

        Assert.Equal(Persistent, FlagsOf(undeleted));
        Assert.Equal(120, undeleted["FormVersion"].Require().GetValue<int>());
        Assert.Equal(7, undeleted["VersionControl"].Require().GetValue<int>());
        Assert.Equal(8, undeleted["Version2"].Require().GetValue<int>());
    }

    [Fact]
    public void ClearingPartialForm_WithNoCopyToItsLeft_LeavesItsOwnFieldsEmpty()
    {
        var cell = InteriorCellOfFallout4Esm(PartialForm);
        cell.WaterHeight = 5f;
        var formKey = _fixture.Seed(cell, "cell");

        var whole = SetFlags(formKey, 0);

        Assert.DoesNotContain(whole, p => p.Key is "EditorID" or "WaterHeight" or "Flags");
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
        var formKey = _fixture.Seed(InteriorCellOfFallout4Esm(PartialForm), "cell");

        SetFlags(formKey, 0);
        var (result, _) = _fixture.Apply(formKey, SetAt(Flags(9), Member("WaterHeight")));

        Assert.True(result.Applied, result.Message);
    }

    [Fact]
    public void ARecordHeaderRow_OnAPartialForm_Edits()
    {
        var formKey = _fixture.Seed(new Cell(_mod) { EditorID = "C", MajorRecordFlagsRaw = PartialForm }, "cell");

        var (result, after) = _fixture.Apply(formKey, SetAt(Flags(9), Member("VersionControl")));

        Assert.True(result.Applied, result.Message);
        Assert.Equal(9, Parse(after.Require())["VersionControl"].Require().GetValue<int>());
    }

    [Fact]
    public void AViewOfRecordFlags_IsRefusedAsFieldNotFound_AndAnswersNoChanges()
    {
        var formKey = _fixture.Seed(InteriorCellOfFallout4Esm(), "cell");

        var result = _fixture.Refused(formKey, SetAt(JsonDocument.Parse("[\"Deleted\"]").RootElement, Member("Fallout4MajorRecordFlags")));

        Assert.Equal(RecordEditRefusal.FieldNotFound, result.Refusal);
    }

    [Theory]
    [MemberData(nameof(RecordsThatCannotBePartialForms))]
    public void SettingPartialForm_OnARecordThatCannotBeOne_IsRefusedAsCannotBePartialForm_AndAnswersNoChanges(string description, Func<IMajorRecordGetter> record)
    {
        var formKey = _fixture.Seed(record(), "cell");

        var result = _fixture.Refused(formKey, SetAt(Flags(PartialForm), Member("MajorRecordFlagsRaw")));

        Assert.True(result.Refusal == RecordEditRefusal.CannotBePartialForm, description);
    }

    [Theory]
    [MemberData(nameof(RecordsThatCanBePartialForms))]
    public void SettingPartialForm_OnARecordThatCanBeOne_EmptiesIt(Func<IMajorRecordGetter> record, string recordType, int held, string dropped)
    {
        var formKey = _fixture.Seed(record(), recordType);

        var partial = SetFlags(formKey, held | PartialForm);

        Assert.DoesNotContain(partial, p => p.Key == dropped);
    }
}
