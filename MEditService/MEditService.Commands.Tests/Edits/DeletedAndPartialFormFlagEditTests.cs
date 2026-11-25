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
    [InlineData(PartialForm | Compressed, PartialForm | Compressed | Deleted, Deleted)]
    [InlineData(Compressed, Compressed | Deleted | PartialForm, PartialForm)]
    public void DeletedAndPartialFormExcludeEachOtherAndCompressed_WhateverIsWrittenAfterwards(int held, int written, int kept)
    {
        var formKey = _fixture.Seed(InteriorCellOfFallout4Esm(held), "cell");

        Assert.Equal(kept, FlagsOf(SetFlags(formKey, written)));
    }

    [Fact]
    public void APartialFormMadeOfACopyTheWriteDeletes_WithNoCopyToItsLeft_HoldsNeitherItsEditorIdNorItsFields()
    {
        var cell = InteriorCellOfFallout4Esm();
        cell.WaterHeight = 5f;
        var formKey = _fixture.Seed(cell, "cell");

        var emptied = SetFlags(formKey, Deleted | PartialForm);

        Assert.DoesNotContain(emptied, p => p.Key is "EditorID" or "WaterHeight");
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
    public void SettingPartialForm_LeavesTheCopyItsHeaderItsEditorIdAndItsChildrenAlone()
    {
        var cell = InteriorCellOfFallout4Esm();
        cell.WaterHeight = 5f;
        cell.VersionControl = 7;
        cell.Landscape = new Landscape(_mod);
        var formKey = _fixture.Seed(cell, "cell");
        var headerAndEditorId = new Cell(cell.FormKey, Fallout4Release.Fallout4)
        {
            EditorID = "C",
            MajorRecordFlagsRaw = PartialForm,
            VersionControl = 7,
            Landscape = cell.Landscape,
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

    [Theory]
    [InlineData(Deleted, Deleted | Persistent)]
    [InlineData(0, PartialForm)]
    public void AWriteThatNeitherEmptiesNorRefills_ChangesOnlyItsBits(int held, int written)
    {
        var npc = _mod.Npcs.AddNew("Guy");
        npc.HeightMax = 0.5f;
        npc.MajorRecordFlagsRaw = held;
        var formKey = _fixture.Seed(npc, "npc_");

        var after = SetFlags(formKey, written);

        Assert.Equal(written, FlagsOf(after));
        Assert.Equal(0.5f, after["HeightMax"].Require().GetValue<float>());
        Assert.Equal("Guy", after["EditorID"].Require().GetValue<string>());
    }

    [Fact]
    public void SettingPersistent_OnADeletedCell_IsRefusedAsPersistentOnDeletedRecord_AndAnswersNoChanges()
    {
        var formKey = _fixture.Seed(InteriorCellOfFallout4Esm(Deleted), "cell");

        var result = _fixture.Refused(formKey, SetAt(Flags(Deleted | Persistent), Member("MajorRecordFlagsRaw")));

        Assert.Equal(RecordEditRefusal.PersistentOnDeletedRecord, result.Refusal);
    }

    [Fact]
    public void ClearingDeleted_WithNoCopyToItsLeft_LeavesItsFieldsEmpty_AndKeepsItsFormVersionVersionStampsAndTheFlagsWritten()
    {
        var npc = _mod.Npcs.AddNew("Guy");
        npc.HeightMax = 0.5f;
        npc.FormVersion = 120;
        npc.VersionControl = 7;
        npc.Version2 = 8;
        npc.MajorRecordFlagsRaw = Deleted | Persistent;
        var formKey = _fixture.Seed(npc, "npc_");

        var undeleted = SetFlags(formKey, Persistent);

        Assert.DoesNotContain(undeleted, p => p.Key is "EditorID" or "HeightMax");
        Assert.Equal(Persistent, FlagsOf(undeleted));
        Assert.Equal(120, undeleted["FormVersion"].Require().GetValue<int>());
        Assert.Equal(7, undeleted["VersionControl"].Require().GetValue<int>());
        Assert.Equal(8, undeleted["Version2"].Require().GetValue<int>());
    }

    [Fact]
    public void AViewOfRecordFlags_IsRefusedAsFieldNotFound_NamingTheFieldThatEditsIt()
    {
        var formKey = _fixture.Seed(InteriorCellOfFallout4Esm(), "cell");

        var result = _fixture.Refused(formKey, SetAt(JsonDocument.Parse("[\"Deleted\"]").RootElement, Member("Fallout4MajorRecordFlags")));

        Assert.Equal(RecordEditRefusal.FieldNotFound, result.Refusal);
        Assert.Equal("'Fallout4MajorRecordFlags' spells MajorRecordFlagsRaw again; edit MajorRecordFlagsRaw.", result.Message);
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
