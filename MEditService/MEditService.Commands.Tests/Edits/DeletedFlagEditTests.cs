using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Codec.Serialization;
using MEditService.Commands.Tests.TestSupport;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using static MEditService.Commands.Tests.TestSupport.Envelopes;

namespace MEditService.Commands.Tests.Edits;

public sealed class DeletedFlagEditTests : IDisposable
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
    public void SettingDeleted_LeavesTheRecordItsHeaderAlone_EditorIdIncluded()
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

        Assert.Equal(0.5f, persistent["HeightMax"].Require().GetValue<float>());
        Assert.Equal("Guy", persistent["EditorID"].Require().GetValue<string>());
    }
}
