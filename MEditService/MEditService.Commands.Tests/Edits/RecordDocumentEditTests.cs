using System.Text;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Noggog;
using static MEditService.Commands.Tests.TestSupport.Envelopes;

namespace MEditService.Commands.Tests.Edits;

public sealed class RecordDocumentEditTests : IDisposable
{
    private readonly DocumentEditFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private readonly Fallout4Mod _mod = new(DocumentEditFixture.ModKey, Fallout4Release.Fallout4);

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

    private string SeedNpc() => _fixture.Seed(_npc, "npc_");
    private string SeedCobj() => _fixture.Seed(_cobj, "cobj");

    [Fact]
    public void AHeaderMemberTheContentDerives_IsRefusedAsReadOnly_WithItsReason()
    {
        var headerFormKey = PluginHeader.FormKeyFor(_mod.ModKey);
        _fixture.SeedRaw(headerFormKey, PluginHeader.RecordType, null, Encoding.UTF8.GetString(HeaderDocument.Write(_mod)));

        var (result, _) = _fixture.Apply(headerFormKey, SetAt(Json("[]"), Member("MasterReferences")));

        Assert.False(result.Applied);
        Assert.Equal(
            (RecordEditRefusal.FieldReadOnly, "'MasterReferences' is read-only: masters are wholly content-derived at compile time."),
            (result.Refusal, result.Message));
    }

    [Theory]
    [InlineData("frobnicate", "HeightMax", "1")]
    [InlineData("set", "HeightMax", null)]
    [InlineData("remove", "HeightMax", null)]
    [InlineData("move", "Keywords[0]", "1.5")]
    [InlineData("move", "Keywords[0]", "99999999999999999999")]
    public void MalformedEnvelope_IsRefusedAsSuch(string op, string path, string? value)
    {
        var formKey = SeedNpc();

        var (result, _) = _fixture.Apply(formKey, Spelled(op, path, value));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.InvalidEnvelope, result.Refusal);
    }

    public static TheoryData<string, Func<RecordDocumentEditTests, string>, RecordEditEnvelope, RecordEditRefusal, string> Refusals => new()
    {
        {
            "a move to the position the element holds", t => t.SeedCobj(), MoveTo(0, Member("Conditions"), At(0)),
            RecordEditRefusal.InvalidEnvelope, "'Conditions[0]': the element is already at position 0."
        },
        {
            "a move in an array whose order the game does not read",
            t =>
            {
                t._npc.Keywords = [t._keyword.ToLink<IKeywordGetter>(), t._mod.Keywords.AddNew("Kw2").ToLink<IKeywordGetter>()];
                return t.SeedNpc();
            },
            MoveTo(1, Member("Keywords"), At(0)),
            RecordEditRefusal.InvalidEnvelope, "'Keywords' is an array whose order the game does not read"
        },
        {
            "hex of another length",
            t => t._fixture.Seed(new MaterialObject(t._mod) { EditorID = "Mato", DNAMs = [new MemorySlice<byte>([0x01, 0x02, 0x03])] }, "mato"),
            SetAt(Json("\"0x0102\""), Member("DNAMs"), At(0)),
            RecordEditRefusal.HexLengthMismatch, "holds 3 bytes; a value of 2 bytes"
        },
        {
            "a value the codec cannot hold",
            t => t._fixture.Seed(new MiscItem(t._mod) { EditorID = "Misc", ComponentDisplayIndices = [1] }, "misc"),
            SetAt(Json("[3, 4096]"), Member("ComponentDisplayIndices")),
            RecordEditRefusal.CodecRejected, "'ComponentDisplayIndices': the codec rejected the document — "
        },
        {
            "a union value naming no leaf", t => t.SeedNpc(), SetAt(Json("""{"Level": 20}"""), Member("Level")),
            RecordEditRefusal.DiscriminatorInvalid, "MutagenObjectType"
        },
        {
            "an alpha in a color holding none", t => t._fixture.Seed(t._mod.Weather.AddNew("Wt"), "wthr"),
            SetAt(Json("\"#7F102030\""), Member("LightningColor")),
            RecordEditRefusal.AlphaNotHeld, "'LightningColor' holds no alpha"
        },
        {
            "an element pasted with an alpha in a color holding none", t => t._fixture.Seed(t._mod.LensFlares.AddNew("Lf"), "lens"),
            AddAt(Json("""{"Data": {"Tint": "#7F102030"}}"""), Member("Sprites")),
            RecordEditRefusal.AlphaNotHeld, "'Sprites[0].Data.Tint' holds no alpha"
        },
        {
            "a member the codec drops", t => t.SeedNpc(), SetAt(Json("""{"Thin": 0.5, "Bogus": 1}"""), Member("Weight")),
            RecordEditRefusal.CodecDroppedValue, "'Weight.Bogus' was not kept by the codec"
        },
        {
            "a member past its owner's set break",
            t =>
            {
                t._quest.VirtualMachineAdapter = new QuestAdapter { Versioning = QuestAdapter.VersioningBreaks.Break0 };
                return t._fixture.Seed(t._quest, "qust");
            },
            SetAt(Json("\"QuestFragments\""), Member("VirtualMachineAdapter"), Member("Script"), Member("Name")),
            RecordEditRefusal.CodecDroppedValue,
            "'VirtualMachineAdapter.Script' lies past its owner's Versioning.Break0, which is set, so the record does not hold it and nothing was written."
        },
    };

    [Theory]
    [MemberData(nameof(Refusals))]
    public void AWriteTheRulesOfAnEditRefuse_IsRefusedSayingWhy_AndChangesNothing(
        string _, Func<RecordDocumentEditTests, string> seed, RecordEditEnvelope envelope, RecordEditRefusal refusal, string why)
    {
        var formKey = seed(this);
        var before = _fixture.Document(formKey);

        var (result, after) = _fixture.Apply(formKey, envelope);

        Assert.Equal(refusal, result.Refusal);
        Assert.Contains(why, result.Message, StringComparison.Ordinal);
        Assert.Null(after);
        Assert.Equal(before, _fixture.Document(formKey));
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
    public void ATemplatedField_IsRefusedNamingItsFlag_WhileAnOwnFieldAndTheFlagStillEdit()
    {
        var template = _mod.Npcs.AddNew("Template");
        var npc = new Npc(_mod)
        {
            EditorID = "Copy",
            HeightMax = 1f,
            UseTemplateActors = Npc.TemplateActorType.Traits,
        };
        npc.DefaultTemplate.SetTo(template.FormKey);
        var formKey = _fixture.Seed(npc, "npc_");
        var before = _fixture.Document(formKey);

        var (result, after) = _fixture.Apply(formKey, SetAt(Json("2.0"), Member("HeightMax")));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.TemplatedFieldReadOnly, result.Refusal);
        Assert.Contains("HeightMax", result.Message);
        Assert.Contains("Traits", result.Message);
        Assert.Null(after);
        Assert.Equal(before, _fixture.Document(formKey));

        Assert.True(_fixture.Apply(formKey, SetAt(Json("\"Renamed\""), Member("EditorID"))).Result.Applied);
        Assert.True(_fixture.Apply(formKey, SetAt(Json("null"), Member("UseTemplateActors"))).Result.Applied);
        Assert.True(_fixture.Apply(formKey, SetAt(Json("2.0"), Member("HeightMax"))).Result.Applied);
    }

    [Fact]
    public void AChildOfAPartialFormCell_IsEdited()
    {
        var cell = new Cell(_mod) { EditorID = "C", MajorRecordFlagsRaw = PartialFormFlag.Bit };
        var placed = new PlacedObject(_mod) { EditorID = "Ref", Scale = 1f };
        cell.Temporary.Add(placed);
        _fixture.Seed(cell, "cell");

        var (result, _) = _fixture.Apply(placed.FormKey.ToString(), SetAt(Json("2.5"), Member("Scale")));

        Assert.True(result.Applied, result.Message);
    }
}
