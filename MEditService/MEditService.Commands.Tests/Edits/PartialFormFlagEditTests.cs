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
using static MEditService.Commands.Tests.TestSupport.Envelopes;

namespace MEditService.Commands.Tests.Edits;

public sealed class PartialFormFlagEditTests : IDisposable
{
    private const int Deleted = 0x0020, Persistent = 0x0400, PartialForm = 0x4000;

    private static readonly RecordTextCodec Codec = new(NullLogger<RecordTextCodec>.Instance);

    private readonly DocumentEditFixture _fixture = new();
    private readonly Fallout4Mod _mod = new(ModKey.FromFileName("DocEdit.esp"), Fallout4Release.Fallout4);

    public void Dispose() => _fixture.Dispose();

    private static JsonElement Flags(int raw) => JsonDocument.Parse(raw.ToString(CultureInfo.InvariantCulture)).RootElement;

    private JsonObject SetFlags(string formKey, int raw)
    {
        var (result, after) = _fixture.Apply(formKey, SetAt(Flags(raw), Member("MajorRecordFlagsRaw")));
        Assert.True(result.Applied, result.Message);
        return Parse(after.Require());
    }

    private static JsonObject Parse(string text) => JsonNode.Parse(text).Require().AsObject();

    private static int FlagsOf(JsonObject document) => document["MajorRecordFlagsRaw"].Require().GetValue<int>();

    [Fact]
    public void SettingPartialForm_LeavesTheCopyItsHeaderAndItsEditorIdAlone()
    {
        var cell = new Cell(_mod) { EditorID = "C", WaterHeight = 5f, VersionControl = 7, Flags = Cell.Flag.HasWater };
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
        var cell = new Cell(_mod) { EditorID = "C", WaterHeight = 5f, Landscape = new Landscape(_mod) };
        var formKey = _fixture.Seed(cell, "cell");
        var landscape = Parse(_fixture.Document(formKey))["Landscape"].Require().DeepClone();

        var partial = SetFlags(formKey, PartialForm);

        Assert.True(JsonNode.DeepEquals(landscape, partial["Landscape"]), partial.ToJsonString());
        Assert.DoesNotContain(partial, p => p.Key == "WaterHeight");
    }

    [Fact]
    public void SettingPartialForm_OnADeletedCopy_ClearsDeleted()
    {
        var cell = new Cell(_mod) { MajorRecordFlagsRaw = Deleted | Persistent };
        var formKey = _fixture.Seed(cell, "cell");

        var partial = SetFlags(formKey, Deleted | Persistent | PartialForm);

        Assert.Equal(Persistent | PartialForm, FlagsOf(partial));
    }

    [Fact]
    public void SettingDeletedAndPartialFormTogether_OnACopyHoldingNeither_MakesAPartialForm()
    {
        var cell = new Cell(_mod) { EditorID = "C", WaterHeight = 5f };
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
        var cell = new Cell(_mod) { EditorID = "C", MajorRecordFlagsRaw = PartialForm };
        var formKey = _fixture.Seed(cell, "cell");

        SetFlags(formKey, 0);
        var (result, _) = _fixture.Apply(formKey, SetAt(Flags(9), Member("WaterHeight")));

        Assert.True(result.Applied, result.Message);
    }

    [Fact]
    public void PartialForm_HasNoMemberOfItsOwn()
    {
        var formKey = _fixture.Seed(new Cell(_mod) { EditorID = "C" }, "cell");

        var (result, _) = _fixture.Apply(formKey, SetAt(JsonDocument.Parse("true").RootElement, Member("IsPartialForm")));

        Assert.Equal(RecordEditRefusal.FieldNotFound, result.Refusal);
    }
}
