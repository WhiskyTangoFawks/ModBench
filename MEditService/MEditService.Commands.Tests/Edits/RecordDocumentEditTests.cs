using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using static MEditService.Commands.Tests.TestSupport.Envelopes;

namespace MEditService.Commands.Tests.Edits;

public sealed class RecordDocumentEditTests : IDisposable
{
    private readonly DocumentEditFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private readonly Fallout4Mod _mod = new(ModKey.FromFileName("DocEdit.esp"), Fallout4Release.Fallout4);

    private readonly Keyword _keyword;
    private readonly Race _race;
    private readonly Npc _npc;
    private readonly ConstructibleObject _cobj;
    private readonly Quest _quest;

    public RecordDocumentEditTests()
    {
        _keyword = _mod.Keywords.AddNew("Kw");
        _race = _mod.Races.AddNew("Rc");
        _quest = _mod.Quests.AddNew("Qu");

        _npc = _mod.Npcs.AddNew("Guy");
        _npc.Race.SetTo(_race);
        _npc.HeightMax = 1f;
        _npc.Keywords = [_keyword.ToLink<IKeywordGetter>()];
        var adapter = new VirtualMachineAdapter { Version = 6, ObjectFormat = 2 };
        var alpha = new ScriptEntry { Name = "Alpha", Flags = ScriptEntry.Flag.Local };
        alpha.Properties.Add(new ScriptIntProperty { Name = "Count", Flags = ScriptProperty.Flag.Edited, Data = 1 });
        adapter.Scripts.Add(alpha);
        adapter.Scripts.Add(new ScriptEntry { Name = "Beta", Flags = ScriptEntry.Flag.Local });
        _npc.VirtualMachineAdapter = adapter;

        _cobj = _mod.ConstructibleObjects.AddNew("Recipe");
        var stageDone = new FunctionConditionData { Function = Condition.Function.GetStageDone, ParameterTwoNumber = 10 };
        stageDone.ParameterOneRecord.SetTo(_quest.FormKey);
        var onReference = new FunctionConditionData { Function = Condition.Function.GetIsSex, RunOnType = Condition.RunOnType.Reference };
        onReference.Reference.SetTo(_npc.FormKey);
        _cobj.Conditions.Add(new ConditionFloat { CompareOperator = CompareOperator.GreaterThan, ComparisonValue = 2.5f, Data = stageDone });
        _cobj.Conditions.Add(new ConditionFloat { CompareOperator = CompareOperator.EqualTo, ComparisonValue = 1f, Data = onReference });
    }

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    private string SeedNpc() => _fixture.Seed(_npc, "npc_");
    private string SeedCobj() => _fixture.Seed(_cobj, "cobj");

    private string Applied(string formKey, RecordEditEnvelope envelope)
    {
        var (result, after) = _fixture.Apply(formKey, envelope);
        Assert.True(result.Applied, result.Message);
        return after ?? throw new InvalidOperationException("Expected an applied edit to report its document.");
    }

    private static JsonNode Node(string text, string dotted)
    {
        var node = JsonNode.Parse(text).Require();
        foreach (var hop in dotted.Split('.')) node = node[hop].Require();
        return node;
    }

    [Fact]
    public void Header_Masters_AreRefusedWithTheirReason()
    {
        var headerFormKey = PluginHeader.FormKeyFor(_mod.ModKey);
        _fixture.SeedRaw(headerFormKey, PluginHeader.RecordType, null, Encoding.UTF8.GetString(HeaderDocument.Write(_mod)));

        var (result, _) = _fixture.Apply(headerFormKey, SetAt(Json("[]"), Member("MasterReferences")));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FieldReadOnly, result.Refusal);
        Assert.Contains("content-derived", result.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Move_ToThePositionTheElementHolds_IsRefusedAsMalformed_AndChangesNothing()
    {
        var formKey = SeedNpc();
        var before = _fixture.Document(formKey);

        var (result, after) = _fixture.Apply(formKey, MoveTo(0, Member("Keywords"), At(0)));

        Assert.Equal(RecordEditRefusal.InvalidEnvelope, result.Refusal);
        Assert.Equal("'Keywords[0]': the element is already at position 0.", result.Message);
        Assert.Null(after);
        Assert.Equal(before, _fixture.Document(formKey));
    }

    [Fact]
    public void Header_FormID_IsRefusedWithItsReason()
    {
        var headerFormKey = PluginHeader.FormKeyFor(_mod.ModKey);
        _fixture.SeedRaw(headerFormKey, PluginHeader.RecordType, null, Encoding.UTF8.GetString(HeaderDocument.Write(_mod)));

        var (result, _) = _fixture.Apply(headerFormKey, SetAt(Json("2048"), Member("FormID")));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FieldReadOnly, result.Refusal);
        Assert.Equal("'FormID' is read-only: a plugin header's FormID names the plugin itself, not a record in it.", result.Message);
    }

    [Fact]
    public void HexOfAnotherLength_IsRefusedNamingBothLengths()
    {
        var formKey = SeedCobj();
        var before = _fixture.Document(formKey);
        Assert.Equal("0x000000", Node(before, "Conditions")[0].Require()["Unknown1"].Require().GetValue<string>());

        var (result, after) = _fixture.Apply(formKey, SetAt(Json("\"0x0102\""), Member("Conditions"), At(0), Member("Unknown1")));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.HexLengthMismatch, result.Refusal);
        Assert.Contains("3 bytes", result.Message, StringComparison.Ordinal);
        Assert.Contains("2 bytes", result.Message, StringComparison.Ordinal);
        Assert.Null(after);
        Assert.Equal(before, _fixture.Document(formKey));
    }

    [Theory]
    [InlineData("frobnicate", "HeightMax", "1")]
    [InlineData("set", "HeightMax", null)]
    [InlineData("remove", "HeightMax", null)]
    [InlineData("move", "Keywords[0]", "\"up\"")]
    public void MalformedEnvelope_IsRefusedAsSuch(string op, string path, string? value)
    {
        var formKey = SeedNpc();
        var hops = path == "Keywords[0]" ? new[] { Member("Keywords"), At(0) } : [Member(path)];
        var envelope = new RecordEditEnvelope(op, hops, value == null ? null : Json(value));

        var (result, _) = _fixture.Apply(formKey, envelope);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.InvalidEnvelope, result.Refusal);
    }

    [Fact]
    public void CodecRejection_NamesThePathAndQuotesMutagen()
    {
        var formKey = SeedNpc();
        var before = _fixture.Document(formKey);

        var (result, after) = _fixture.Apply(formKey, SetAt(Json("\"tall\""), Member("HeightMax")));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.CodecRejected, result.Refusal);
        Assert.Equal("HeightMax", result.Path);
        Assert.Contains("tall", result.Message, StringComparison.Ordinal);
        Assert.Null(after);
        Assert.Equal(before, _fixture.Document(formKey));
    }

    [Theory]
    [InlineData("EnergyLevel", "256")]
    [InlineData("XpValueOffset", "32768")]
    [InlineData("AggroRadiusWarn", "-1")]
    public void IntegerWidth_IsTheCodecs(string column, string value)
    {
        var formKey = SeedNpc();

        var (result, _) = _fixture.Apply(formKey, SetAt(Json(value), Member(column)));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.CodecRejected, result.Refusal);
        Assert.Equal(column, result.Path);
    }

    [Theory]
    [InlineData("\"#7F102030\"")]
    [InlineData("\"#FF102030\"")]
    public void AColorHoldingNoAlpha_RefusesAnAlpha_NamingTheField(string color)
    {
        var formKey = _fixture.Seed(_mod.Weather.AddNew("Wt"), "wthr");
        var before = _fixture.Document(formKey);

        var (result, _) = _fixture.Apply(formKey, SetAt(Json(color), Member("LightningColor")));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.AlphaNotHeld, result.Refusal);
        Assert.Equal("LightningColor", result.Path);
        Assert.Contains("'LightningColor'", result.Message, StringComparison.Ordinal);
        Assert.Equal(before, _fixture.Document(formKey));
    }

    [Fact]
    public void AnElementPasted_WithAnAlphaInAColorHoldingNone_IsRefusedNamingThatColor()
    {
        var formKey = _fixture.Seed(_mod.LensFlares.AddNew("Lf"), "lens");

        var (result, _) = _fixture.Apply(formKey, AddAt(Json("""{"Data": {"Tint": "#7F102030"}}"""), Member("Sprites")));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.AlphaNotHeld, result.Refusal);
        Assert.Equal("Sprites[0].Data.Tint", result.Path);
    }

    [Fact]
    public void ValueTheCodecDrops_IsRefusedNamingIt_NeverReportedAsSuccess()
    {
        var formKey = SeedNpc();
        var before = _fixture.Document(formKey);

        var (result, after) = _fixture.Apply(formKey, SetAt(Json("""{"Thin": 0.5, "Bogus": 1}"""), Member("Weight")));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.CodecDroppedValue, result.Refusal);
        Assert.Equal("Weight.Bogus", result.Path);
        Assert.Null(after);
        Assert.Equal(before, _fixture.Document(formKey));
    }

    [Fact]
    public void RecordFlags_ClearedToNone_LeavesNoSpellingOfThemBehind()
    {
        var cell = new Cell(_mod) { EditorID = "C", WaterHeight = 5f, MajorRecordFlagsRaw = 0x0420 };
        var formKey = _fixture.Seed(cell, "cell");

        var cleared = JsonNode.Parse(Applied(formKey, SetAt(Json("0"), Member("MajorRecordFlagsRaw")))).Require().AsObject();

        Assert.DoesNotContain(cleared, p => p.Key is "MajorRecordFlagsRaw" or "IsDeleted" or "Fallout4MajorRecordFlags" or "MajorFlags");
    }

    [Fact]
    public void PartialFormRecord_RefusesItsOwnFields_ButNotItsFlagsOrItsEditorId()
    {
        var cell = new Cell(_mod) { EditorID = "C", WaterHeight = 5f, MajorRecordFlagsRaw = PartialFormFlag.Bit };
        var formKey = _fixture.Seed(cell, "cell");
        var before = _fixture.Document(formKey);

        var (result, after) = _fixture.Apply(formKey, SetAt(Json("9.0"), Member("WaterHeight")));
        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.PartialFormFieldReadOnly, result.Refusal);
        Assert.Null(after);
        Assert.Equal(before, _fixture.Document(formKey));

        Assert.True(_fixture.Apply(formKey, SetAt(Json("\"Renamed\""), Member("EditorID"))).Result.Applied);
        Assert.True(_fixture.Apply(formKey, SetAt(Json("0"), Member("MajorRecordFlagsRaw"))).Result.Applied);
    }

    [Fact]
    public void EmbeddedChild_IsPatchedInsideItsParentsDocument()
    {
        var cell = new Cell(_mod) { EditorID = "C", WaterHeight = 5f };
        var placed = new PlacedObject(_mod) { EditorID = "Ref", Scale = 1f };
        cell.Temporary.Add(placed);
        var cellKey = _fixture.Seed(cell, "cell");
        var before = _fixture.Document(cellKey);

        var (result, _) = _fixture.Apply(placed.FormKey.ToString(), SetAt(Json("2.5"), Member("Scale")));

        Assert.True(result.Applied, result.Message);
        var after = _fixture.Document(cellKey);
        Assert.Equal(["Temporary[0].Scale: 1.0 -> 2.5"], DocumentDiffs.Of(before, after));
    }
}
