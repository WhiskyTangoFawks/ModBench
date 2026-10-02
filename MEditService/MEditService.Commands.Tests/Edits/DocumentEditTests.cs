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

/// <summary>Document text, envelope and metadata in; a gesture's output is the input with exactly
/// the edited path changed, through the real <see cref="EditRecordHandler"/>.</summary>
public sealed class DocumentEditTests : IDisposable
{
    private readonly DocumentEditFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private static readonly IReadOnlyDictionary<string, RecordTableSchema> Schemas =
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);

    private readonly Fallout4Mod _mod = new(ModKey.FromFileName("DocEdit.esp"), Fallout4Release.Fallout4);

    private readonly Keyword _keyword;
    private readonly Keyword _otherKeyword;
    private readonly Race _race;
    private readonly Npc _npc;
    private readonly ConstructibleObject _cobj;
    private readonly Quest _quest;
    private readonly GlobalInt _globalInt;

    public DocumentEditTests()
    {
        _keyword = _mod.Keywords.AddNew("Kw");
        _otherKeyword = _mod.Keywords.AddNew("Kw2");
        _race = _mod.Races.AddNew("Rc");
        _quest = _mod.Quests.AddNew("Qu");
        _globalInt = _mod.Globals.AddNewInt("Gi");

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
    private string SeedGlobalInt() => _fixture.Seed(_globalInt, "glob");

    private string Applied(string formKey, RecordEditEnvelope envelope)
    {
        var (result, after) = _fixture.Apply(formKey, envelope);
        Assert.True(result.Applied, result.Message);
        return after ?? throw new InvalidOperationException("Expected an applied edit to report its document.");
    }

    // Every difference between the documents sits under the edited path, and there is one.
    private static void AssertOnlyChanged(string before, string after, params string[] paths)
    {
        var diffs = ConditionEditTests.DocumentDiff(before, after);
        Assert.NotEmpty(diffs);
        Assert.All(diffs, d => Assert.Contains(paths, p => d.StartsWith(p, StringComparison.Ordinal)));
    }

    private static JsonNode Node(string text, string dotted)
    {
        var node = JsonNode.Parse(text).Require();
        foreach (var hop in dotted.Split('.')) node = node[hop].Require();
        return node;
    }

    // ── set, at every depth ─────────────────────────────────────────────────

    [Fact]
    public void Set_TopLevelScalar_ChangesExactlyThatPath()
    {
        var formKey = SeedNpc();
        var before = _fixture.Document(formKey);

        var after = Applied(formKey, SetAt(Json("0.75"), Member("HeightMax")));

        Assert.Equal(["HeightMax: 1.0 -> 0.75"], ConditionEditTests.DocumentDiff(before, after));
    }

    [Fact]
    public void Set_MemberOfANestedStruct_ChangesExactlyThatPath()
    {
        var formKey = SeedNpc();
        var before = _fixture.Document(formKey);

        var after = Applied(formKey, SetAt(Json("0.5"), Member("Weight"), Member("Thin")));

        // The struct was absent, so the document gains it holding exactly the one member.
        Assert.Equal(["Weight: <absent> -> {\"Thin\":0.5}"], ConditionEditTests.DocumentDiff(before, after));
    }

    [Fact]
    public void Set_MemberOfAnArrayElement_ChangesExactlyThatPath()
    {
        var formKey = SeedCobj();
        var before = _fixture.Document(formKey);

        var after = Applied(formKey, SetAt(Json("\"LessThan\""), Member("Conditions"), At(0), Member("CompareOperator")));

        Assert.Equal(["Conditions[0].CompareOperator: \"GreaterThan\" -> \"LessThan\""], ConditionEditTests.DocumentDiff(before, after));
    }

    [Fact]
    public void Set_ThroughTwoKeyedArrays_ChangesExactlyThatPath()
    {
        var formKey = SeedNpc();
        var before = _fixture.Document(formKey);

        var after = Applied(formKey, SetAt(Json("9"), Member("VirtualMachineAdapter"), Member("Scripts"), At(0), Member("Properties"), At(0), Member("Data")));

        Assert.Equal(["VirtualMachineAdapter.Scripts[0].Properties[0].Data: 1 -> 9"], ConditionEditTests.DocumentDiff(before, after));
    }

    [Fact]
    public void Set_Null_ClearsTheMemberSoItReadsAsItsDefault()
    {
        var formKey = SeedNpc();
        var before = _fixture.Document(formKey);

        var after = Applied(formKey, Clear(Member("HeightMax")));

        Assert.Equal(["HeightMax: 1.0 -> <absent>"], ConditionEditTests.DocumentDiff(before, after));
    }

    // ── the discriminator switch ────────────────────────────────────────────

    [Fact]
    public void Set_Discriminator_KeepsSharedMembersAndDropsTheMemberTheNewLeafShapesDifferently()
    {
        var formKey = SeedCobj();
        var before = _fixture.Document(formKey);

        var after = Applied(formKey, SetAt(Json("\"ConditionGlobal\""), Member("Conditions"), At(0), Member("MutagenObjectType")));

        Assert.Equal(
            [
                "Conditions[0].MutagenObjectType: \"ConditionFloat\" -> \"ConditionGlobal\"",
                "Conditions[0].ComparisonValue: 2.5 -> <absent>",
            ],
            ConditionEditTests.DocumentDiff(before, after));
        Assert.Equal("GreaterThan", Node(after, "Conditions")[0].Require()["CompareOperator"].Require().GetValue<string>());
    }

    // Association is a form link on every archetype leaf, over that leaf's own target type: a cloak
    // effect names a spell, a light effect a light. The switch drops it.
    [Fact]
    public void Set_Discriminator_DropsALinkWhoseTargetTypeTheIncomingLeafDoesNotName()
    {
        const string before = """
            {
              "FormKey": "000801:DocEdit.esp",
              "Archetype": {
                "MutagenObjectType": "MagicEffectCloakArchetype",
                "Association": "000802:DocEdit.esp"
              }
            }
            """;
        _fixture.SeedRaw("000801:DocEdit.esp", "mgef", null, before);

        var after = Applied("000801:DocEdit.esp", SetAt(Json("\"MagicEffectLightArchetype\""), Member("Archetype"), Member("MutagenObjectType")));

        Assert.Equal(
            [
                "Archetype.MutagenObjectType: \"MagicEffectCloakArchetype\" -> \"MagicEffectLightArchetype\"",
                "Archetype.Association: \"000802:DocEdit.esp\" -> <absent>",
            ],
            ConditionEditTests.DocumentDiff(before, after));
    }

    [Fact]
    public void Set_Discriminator_ToALeafTheUnionLacks_IsRefusedByName()
    {
        var formKey = SeedCobj();
        var before = _fixture.Document(formKey);

        var (result, after) = _fixture.Apply(formKey, SetAt(Json("\"ConditionMaybe\""), Member("Conditions"), At(0), Member("MutagenObjectType")));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.DiscriminatorInvalid, result.Refusal);
        Assert.Equal("Conditions[0].MutagenObjectType", result.Path);
        Assert.Null(after);
        Assert.Equal(before, _fixture.Document(formKey));
    }

    // ── add, remove, move ───────────────────────────────────────────────────

    [Fact]
    public void Add_Remove_Move_OnAPositionalArray_ChangeThatArrayAlone()
    {
        var formKey = SeedNpc();
        var before = _fixture.Document(formKey);

        var added = Applied(formKey, AddAt(Json($"\"{_otherKeyword.FormKey}\""), Member("Keywords")));
        AssertOnlyChanged(before, added, "Keywords[1]");
        Assert.Equal(2, Node(added, "Keywords").AsArray().Count);

        var moved = Applied(formKey, MoveTo(0, Member("Keywords"), At(1)));
        Assert.Equal([_otherKeyword.FormKey.ToString(), _keyword.FormKey.ToString()], Node(moved, "Keywords").AsArray().Select(k => k.Require().GetValue<string>()));
        AssertOnlyChanged(added, moved, "Keywords[");

        var removed = Applied(formKey, RemoveAt(Member("Keywords"), At(0)));
        Assert.Equal([_keyword.FormKey.ToString()], Node(removed, "Keywords").AsArray().Select(k => k.Require().GetValue<string>()));
        AssertOnlyChanged(moved, removed, "Keywords[");
    }

    [Fact]
    public void Add_WithoutAValue_AppendsTheElementTypesDefault()
    {
        var formKey = SeedCobj();
        var before = _fixture.Document(formKey);

        var after = Applied(formKey, AddAt(Member("Conditions")));

        AssertOnlyChanged(before, after, "Conditions[2]");
        var elementSpec = Schemas["cobj"].RecordColumns.Single(c => c.Name == "Conditions").Field.ElementSpec
            ?? throw new InvalidOperationException("Expected 'Conditions' to be an array of a struct element.");
        var subFields = elementSpec.SubFields
            ?? throw new InvalidOperationException("Expected the array element to declare its own fields.");
        var leaf = subFields.Single(f => f.IsDiscriminator).EnumMembers[0].Value;
        Assert.Equal(leaf, Node(after, "Conditions")[2].Require()["MutagenObjectType"].Require().GetValue<string>());
    }

    [Fact]
    public void Add_OnAKeyedArray_AppendsTheElement()
    {
        var formKey = SeedNpc();
        var before = _fixture.Document(formKey);

        var added = Applied(formKey, AddAt(Json("""{"Name": "Aardvark", "Flags": "Local"}"""), Member("VirtualMachineAdapter"), Member("Scripts")));

        Assert.Equal(["Alpha", "Beta", "Aardvark"], ScriptNames(added));
        AssertOnlyChanged(before, added, "VirtualMachineAdapter.Scripts[2]");
    }

    [Fact]
    public void Set_OfAKeyMember_LeavesTheElementWhereItIs()
    {
        var formKey = SeedNpc();

        var after = Applied(formKey, SetAt(Json("\"Zulu\""), Member("VirtualMachineAdapter"), Member("Scripts"), At(0), Member("Name")));

        Assert.Equal(["Zulu", "Beta"], ScriptNames(after));
    }

    private static IEnumerable<string> ScriptNames(string document) =>
        Node(document, "VirtualMachineAdapter.Scripts").AsArray().Select(s => s.Require()["Name"].Require().GetValue<string>());

    // An element that is not there is a path the document does not know, on every operation.
    [Theory]
    [InlineData(RecordEditEnvelope.Remove)]
    [InlineData(RecordEditEnvelope.Move)]
    [InlineData(RecordEditEnvelope.Set)]
    public void AnElementPastTheEnd_IsRefusedNamingThePathAndTheLength_OnEveryOperation(string op)
    {
        var formKey = SeedNpc();
        var before = _fixture.Document(formKey);
        var envelope = new RecordEditEnvelope(op, [Member("Keywords"), At(7)], Json("0"));

        var (result, after) = _fixture.Apply(formKey, envelope);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FieldNotFound, result.Refusal);
        Assert.Equal("Keywords[7]", result.Path);
        Assert.Contains("holds 1 element", result.Message, StringComparison.Ordinal);
        Assert.Null(after);
        Assert.Equal(before, _fixture.Document(formKey));
    }

    [Fact]
    public void Move_ToADestinationOutsideTheArray_IsRefusedNamingThatPosition()
    {
        var formKey = SeedNpc();
        var before = _fixture.Document(formKey);

        var (result, after) = _fixture.Apply(formKey, MoveTo(3, Member("Keywords"), At(0)));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FieldNotFound, result.Refusal);
        Assert.Equal("Keywords[3]", result.Path);
        Assert.Null(after);
        Assert.Equal(before, _fixture.Document(formKey));
    }

    // ── the cascade is the writer's ─────────────────────────────────────────

    [Fact]
    public void Set_GoverningMember_IdlesEverySlotTheNewValueDoesNotUse()
    {
        var formKey = SeedCobj();
        var before = _fixture.Document(formKey);
        Assert.Equal(10, Node(before, "Conditions")[0].Require()["Data"].Require()["ParameterTwoNumber"].Require().GetValue<int>());

        var after = Applied(formKey, SetAt(Json("\"HasKeyword\""), Member("Conditions"), At(0), Member("Data"), Member("Function")));

        var data = Node(after, "Conditions")[0].Require()["Data"].Require().AsObject();
        Assert.Equal("HasKeyword", data["Function"].Require().GetValue<string>());
        Assert.False(data.ContainsKey("ParameterTwoNumber"));
        Assert.Equal(_quest.FormKey.ToString(), data["ParameterOneRecord"].Require().GetValue<string>());
        AssertOnlyChanged(before, after, "Conditions[0].Data.");
    }

    [Fact]
    public void Set_RunOnLeavingReference_ClearsTheReference()
    {
        var formKey = SeedCobj();
        var before = _fixture.Document(formKey);
        Assert.Equal(_npc.FormKey.ToString(), Node(before, "Conditions")[1].Require()["Data"].Require()["Reference"].Require().GetValue<string>());

        var after = Applied(formKey, SetAt(Json("\"Subject\""), Member("Conditions"), At(1), Member("Data"), Member("RunOnType")));

        Assert.Equal(
            [
                "Conditions[1].Data.RunOnType: \"Reference\" -> <absent>",
                $"Conditions[1].Data.Reference: \"{_npc.FormKey}\" -> <absent>",
            ],
            ConditionEditTests.DocumentDiff(before, after));
    }

    // ── the closed pre-check list ───────────────────────────────────────────

    [Fact]
    public void UnknownTopLevelPath_IsRefusedByName_AndNothingLandsSilently()
    {
        var formKey = SeedNpc();
        var before = _fixture.Document(formKey);

        var (result, after) = _fixture.Apply(formKey, SetAt(Json("1"), Member("NoSuchField")));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FieldNotFound, result.Refusal);
        Assert.Equal("NoSuchField", result.Path);
        Assert.Null(after);
        Assert.Equal(before, _fixture.Document(formKey));
    }

    [Fact]
    public void UnknownNestedPath_IsRefusedNamingTheHopThatFailed()
    {
        var formKey = SeedNpc();

        var (result, _) = _fixture.Apply(formKey, SetAt(Json("1"), Member("Weight"), Member("Bogus")));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FieldNotFound, result.Refusal);
        Assert.Equal("Weight.Bogus", result.Path);
    }

    [Fact]
    public void MemberOfAnotherRecordClass_IsRefusedByName()
    {
        var formKey = SeedGlobalInt();

        var (result, _) = _fixture.Apply(formKey, SetAt(Json("true"), Member("OutputChar")));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FieldNotFound, result.Refusal);
        Assert.Contains(nameof(GlobalInt), result.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Header_Author_IsWrittenAsAnyFieldIs()
    {
        var headerFormKey = PluginHeader.FormKeyFor(_mod.ModKey);
        var before = Encoding.UTF8.GetString(HeaderDocument.Write(_mod));
        _fixture.SeedRaw(headerFormKey, PluginHeader.RecordType, null, before);

        var after = Applied(headerFormKey, SetAt(Json("\"me\""), Member("Author")));

        Assert.Equal("me", Node(after, "ModHeader.Author").GetValue<string>());
        AssertOnlyChanged(before, after, "ModHeader.Author");
    }

    [Fact]
    public void Header_Flags_AreWrittenAsAnyFlagsFieldIs()
    {
        var headerFormKey = PluginHeader.FormKeyFor(_mod.ModKey);
        var before = Encoding.UTF8.GetString(HeaderDocument.Write(_mod));
        _fixture.SeedRaw(headerFormKey, PluginHeader.RecordType, null, before);

        var after = Applied(headerFormKey, SetAt(Json("[\"Master\"]"), Member("Flags")));

        Assert.Equal("Master", Node(after, "ModHeader.Flags")[0].Require().GetValue<string>());
        AssertOnlyChanged(before, after, "ModHeader.Flags");
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
    public void Header_VersionControlInfo1_IsWrittenAsAnyFieldIs()
    {
        var headerFormKey = PluginHeader.FormKeyFor(_mod.ModKey);
        var before = Encoding.UTF8.GetString(HeaderDocument.Write(_mod));
        _fixture.SeedRaw(headerFormKey, PluginHeader.RecordType, null, before);

        var after = Applied(headerFormKey, SetAt(Json("7"), Member("Version")));

        Assert.Equal(7, Node(after, "ModHeader.Version").GetValue<int>());
        AssertOnlyChanged(before, after, "ModHeader.Version");
    }

    [Theory]
    [InlineData("""{"CompareOperator": "EqualTo"}""")]
    [InlineData("""{"CompareOperator": "EqualTo", "MutagenObjectType": "ConditionFloat"}""")]
    [InlineData("""{"MutagenObjectType": "ConditionMaybe"}""")]
    public void UnionElement_WithoutALeadingDiscriminatorNamingALeaf_IsRefused(string element)
    {
        var formKey = SeedCobj();
        var before = _fixture.Document(formKey);

        var (result, after) = _fixture.Apply(formKey, AddAt(Json(element), Member("Conditions")));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.DiscriminatorInvalid, result.Refusal);
        Assert.Equal("Conditions[2]", result.Path);
        Assert.Null(after);
        Assert.Equal(before, _fixture.Document(formKey));
    }

    [Fact]
    public void DuplicateKey_IsRefusedNamingTheKeyAndTheArray()
    {
        var formKey = SeedNpc();
        var before = _fixture.Document(formKey);

        var (result, after) = _fixture.Apply(formKey, AddAt(Json("""{"Name": "Alpha"}"""), Member("VirtualMachineAdapter"), Member("Scripts")));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.DuplicateKeyInKeyedArray, result.Refusal);
        Assert.Equal("VirtualMachineAdapter.Scripts", result.Path);
        Assert.Contains("'Alpha'", result.Message, StringComparison.Ordinal);
        Assert.Null(after);
        Assert.Equal(before, _fixture.Document(formKey));
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

    // Shape is the codec's and nothing else is (ADR-0015 invariant 5): what a FormKey points at is
    // not a fact the document carries, so the edit lands and the read side reports it.
    [Theory]
    [InlineData("ABCDEF:Nowhere.esp")]
    [InlineData("kywd")]
    public void LinkTarget_DanglingOrOfTheWrongType_Lands(string target)
    {
        var formKey = SeedNpc();
        var linkTarget = target == "kywd" ? _keyword.FormKey.ToString() : target;

        var after = Applied(formKey, SetAt(Json($"\"{linkTarget}\""), Member("Race")));

        Assert.Equal(linkTarget, Node(after, "Race").GetValue<string>());
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

    // ── the codec is the one shape gate ─────────────────────────────────────

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

    [Fact]
    public void NormalizedValue_CountsAsApplied_InTheCodecsOwnSpelling()
    {
        var formKey = SeedCobj();
        var before = _fixture.Document(formKey);

        var after = Applied(formKey, SetAt(Json("\"0x0a0b0c\""), Member("Conditions"), At(0), Member("Unknown1")));

        Assert.Equal(["Conditions[0].Unknown1: \"0x000000\" -> \"0x0A0B0C\""], ConditionEditTests.DocumentDiff(before, after));
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
    public void TranslatedString_IsWrittenInTheDocumentsOwnObjectForm()
    {
        var formKey = SeedNpc();
        var before = _fixture.Document(formKey);

        var after = Applied(formKey, SetAt(Json("""{"Value": "Named"}"""), Member("Name")));

        Assert.Equal("Named", Node(after, "Name.Value").GetValue<string>());
        AssertOnlyChanged(before, after, "Name");
    }

    // ── the synthetic members ───────────────────────────────────────────────

    [Fact]
    public void Header_IsSmallMaster_WritesTheFlagsMemberAndNothingElse()
    {
        var headerFormKey = PluginHeader.FormKeyFor(_mod.ModKey);
        var before = Encoding.UTF8.GetString(HeaderDocument.Write(_mod));
        _fixture.SeedRaw(headerFormKey, PluginHeader.RecordType, null, before);

        var set = Applied(headerFormKey, SetAt(Json("true"), Member("IsSmallMaster")));
        Assert.True(HeaderDocument.IsLight(Encoding.UTF8.GetBytes(set)));
        AssertOnlyChanged(before, set, "ModHeader.Flags");

        var cleared = Applied(headerFormKey, SetAt(Json("false"), Member("IsSmallMaster")));
        Assert.Equal(before, cleared);
    }

    [Fact]
    public void RecordFlags_WritesTheRawInteger_AndTheCodecsViewsOfItFollow()
    {
        const int persistent = 0x0400, cantWait = 0x0008_0000;
        var cell = new Cell(_mod) { EditorID = "C", WaterHeight = 5f, MajorRecordFlagsRaw = persistent };
        var formKey = _fixture.Seed(cell, "cell");
        var before = _fixture.Document(formKey);

        var set = Applied(formKey, SetAt(Json($"{persistent | cantWait}"), Member("MajorRecordFlagsRaw")));

        Assert.Equal(persistent | cantWait, Node(set, "MajorRecordFlagsRaw").GetValue<int>());
        Assert.Equal(["CantWait", "Persistent"], Node(set, "MajorFlags").AsArray().Select(n => n.Require().GetValue<string>()).Order(StringComparer.Ordinal));
        AssertOnlyChanged(before, set, "MajorRecordFlagsRaw", "Fallout4MajorRecordFlags", "MajorFlags");
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

    // ── container children ──────────────────────────────────────────────────

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
        Assert.Equal(["Temporary[0].Scale: 1.0 -> 2.5"], ConditionEditTests.DocumentDiff(before, after));
    }
}
