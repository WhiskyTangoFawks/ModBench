using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Core.Edits;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using static MEditService.Tests.TestSupport.Envelopes;

namespace MEditService.Tests.Edits;

/// <summary>Document text, envelope and metadata in; document text or one refusal out, no index
/// and no disk (ADR-0032). Every gesture is asserted as whole-document equality: the output is the
/// input with exactly the edited path changed.</summary>
public sealed class DocumentEditTests
{
    private static readonly IReadOnlyDictionary<string, RecordTableSchema> Schemas =
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);

    private readonly Fallout4Mod _mod = new(ModKey.FromFileName("DocEdit.esp"), Fallout4Release.Fallout4);
    private readonly Dictionary<string, RecordLookupEntry> _lookup = new(StringComparer.Ordinal);

    private readonly Keyword _keyword;
    private readonly Keyword _otherKeyword;
    private readonly Race _race;
    private readonly Npc _npc;
    private readonly ConstructibleObject _cobj;
    private readonly Quest _quest;
    private readonly GlobalInt _globalInt;

    public DocumentEditTests()
    {
        _keyword = Register(_mod.Keywords.AddNew("Kw"), "kywd");
        _otherKeyword = Register(_mod.Keywords.AddNew("Kw2"), "kywd");
        _race = Register(_mod.Races.AddNew("Rc"), "race");
        _quest = Register(_mod.Quests.AddNew("Qu"), "qust");
        _globalInt = Register(_mod.Globals.AddNewInt("Gi"), "glob");

        _npc = Register(_mod.Npcs.AddNew("Guy"), "npc_");
        _npc.Race.SetTo(_race);
        _npc.HeightMax = 1f;
        _npc.Keywords = [_keyword.ToLink<IKeywordGetter>()];
        // In key order already, so a gesture's only change is its own.
        var adapter = new VirtualMachineAdapter { Version = 6, ObjectFormat = 2 };
        var alpha = new ScriptEntry { Name = "Alpha", Flags = ScriptEntry.Flag.Local };
        alpha.Properties.Add(new ScriptIntProperty { Name = "Count", Flags = ScriptProperty.Flag.Edited, Data = 1 });
        adapter.Scripts.Add(alpha);
        adapter.Scripts.Add(new ScriptEntry { Name = "Beta", Flags = ScriptEntry.Flag.Local });
        _npc.VirtualMachineAdapter = adapter;

        _cobj = Register(_mod.ConstructibleObjects.AddNew("Recipe"), "cobj");
        var stageDone = new FunctionConditionData { Function = Condition.Function.GetStageDone, ParameterTwoNumber = 10 };
        stageDone.ParameterOneRecord.SetTo(_quest.FormKey);
        var onReference = new FunctionConditionData { Function = Condition.Function.GetIsSex, RunOnType = Condition.RunOnType.Reference };
        onReference.Reference.SetTo(_npc.FormKey);
        _cobj.Conditions.Add(new ConditionFloat { CompareOperator = CompareOperator.GreaterThan, ComparisonValue = 2.5f, Data = stageDone });
        _cobj.Conditions.Add(new ConditionFloat { CompareOperator = CompareOperator.EqualTo, ComparisonValue = 1f, Data = onReference });
    }

    private T Register<T>(T record, string recordType) where T : IFallout4MajorRecordGetter
    {
        _lookup[record.FormKey.ToString()] = new RecordLookupEntry(recordType, record.EditorID);
        return record;
    }

    private RecordLookupEntry? Resolve(string formKey) => _lookup.GetValueOrDefault(formKey);

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    private RecordEditResult? Apply(string text, string table, RecordEditEnvelope envelope, out string written) =>
        DocumentEdits.Apply(text, Schemas[table], envelope, out written, Resolve);

    private string Applied(string text, string table, RecordEditEnvelope envelope)
    {
        var refusal = Apply(text, table, envelope, out var written);
        Assert.Null(refusal);
        return written;
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
        JsonNode? node = JsonNode.Parse(text);
        foreach (var hop in dotted.Split('.')) node = node![hop];
        return node!;
    }

    // ── set, at every depth ─────────────────────────────────────────────────

    [Fact]
    public void Set_TopLevelScalar_ChangesExactlyThatPath()
    {
        var before = DocumentEdits.Serialize(_npc);

        var after = Applied(before, "npc_", SetAt(Json("0.75"), Member("HeightMax")));

        Assert.Equal(["HeightMax: 1.0 -> 0.75"], ConditionEditTests.DocumentDiff(before, after));
    }

    [Fact]
    public void Set_MemberOfANestedStruct_ChangesExactlyThatPath()
    {
        var before = DocumentEdits.Serialize(_npc);

        var after = Applied(before, "npc_", SetAt(Json("0.5"), Member("Weight"), Member("Thin")));

        // The struct was absent, so the document gains it holding exactly the one member.
        Assert.Equal(["Weight: <absent> -> {\"Thin\":0.5}"], ConditionEditTests.DocumentDiff(before, after));
    }

    [Fact]
    public void Set_MemberOfAnArrayElement_ChangesExactlyThatPath()
    {
        var before = DocumentEdits.Serialize(_cobj);

        var after = Applied(before, "cobj", SetAt(Json("\"LessThan\""), Member("Conditions"), At(0), Member("CompareOperator")));

        Assert.Equal(["Conditions[0].CompareOperator: \"GreaterThan\" -> \"LessThan\""], ConditionEditTests.DocumentDiff(before, after));
    }

    [Fact]
    public void Set_ThroughTwoKeyHops_ChangesExactlyThatPath()
    {
        var before = DocumentEdits.Serialize(_npc);

        var after = Applied(before, "npc_", SetAt(Json("9"), Member("VirtualMachineAdapter"), Member("Scripts"), Key("Alpha"), Member("Properties"), Key("Count"), Member("Data")));

        Assert.Equal(["VirtualMachineAdapter.Scripts[0].Properties[0].Data: 1 -> 9"], ConditionEditTests.DocumentDiff(before, after));
    }

    [Fact]
    public void Set_Null_ClearsTheMemberSoItReadsAsItsDefault()
    {
        var before = DocumentEdits.Serialize(_npc);

        var after = Applied(before, "npc_", Clear(Member("HeightMax")));

        Assert.Equal(["HeightMax: 1.0 -> <absent>"], ConditionEditTests.DocumentDiff(before, after));
    }

    // ── the discriminator switch ────────────────────────────────────────────

    [Fact]
    public void Set_Discriminator_KeepsSharedMembersAndDropsTheMemberTheNewLeafShapesDifferently()
    {
        var before = DocumentEdits.Serialize(_cobj);

        var after = Applied(before, "cobj", SetAt(Json("\"ConditionGlobal\""), Member("Conditions"), At(0), Member("MutagenObjectType")));

        Assert.Equal(
            [
                "Conditions[0].MutagenObjectType: \"ConditionFloat\" -> \"ConditionGlobal\"",
                "Conditions[0].ComparisonValue: 2.5 -> <absent>",
            ],
            ConditionEditTests.DocumentDiff(before, after));
        Assert.Equal("GreaterThan", Node(after, "Conditions")[0]!["CompareOperator"]!.GetValue<string>());
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

        var after = Applied(before, "mgef",
            SetAt(Json("\"MagicEffectLightArchetype\""), Member("Archetype"), Member("MutagenObjectType")));

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
        var before = DocumentEdits.Serialize(_cobj);

        var refusal = Apply(before, "cobj", SetAt(Json("\"ConditionMaybe\""), Member("Conditions"), At(0), Member("MutagenObjectType")), out var written);

        Assert.Equal(RecordEditRefusal.DiscriminatorInvalid, refusal!.Refusal);
        Assert.Equal("Conditions[0].MutagenObjectType", refusal.Path);
        Assert.Equal(before, written);
    }

    // ── add, remove, move ───────────────────────────────────────────────────

    [Fact]
    public void Add_Remove_Move_OnAPositionalArray_ChangeThatArrayAlone()
    {
        var before = DocumentEdits.Serialize(_npc);

        var added = Applied(before, "npc_", AddAt(Json($"\"{_otherKeyword.FormKey}\""), Member("Keywords")));
        AssertOnlyChanged(before, added, "Keywords[1]");
        Assert.Equal(2, Node(added, "Keywords").AsArray().Count);

        var moved = Applied(added, "npc_", MoveTo(0, Member("Keywords"), At(1)));
        Assert.Equal([_otherKeyword.FormKey.ToString(), _keyword.FormKey.ToString()], Node(moved, "Keywords").AsArray().Select(k => k!.GetValue<string>()));
        AssertOnlyChanged(added, moved, "Keywords[");

        var removed = Applied(moved, "npc_", RemoveAt(Member("Keywords"), At(0)));
        Assert.Equal([_keyword.FormKey.ToString()], Node(removed, "Keywords").AsArray().Select(k => k!.GetValue<string>()));
        AssertOnlyChanged(moved, removed, "Keywords[");
    }

    [Fact]
    public void Add_WithoutAValue_AppendsTheElementTypesDefault()
    {
        var before = DocumentEdits.Serialize(_cobj);

        var after = Applied(before, "cobj", AddAt(Member("Conditions")));

        AssertOnlyChanged(before, after, "Conditions[2]");
        var leaf = Schemas["cobj"].RecordColumns.Single(c => c.Name == "Conditions").Field.ElementSpec!.SubFields!.Single(f => f.IsDiscriminator).EnumMembers[0].Value;
        Assert.Equal(leaf, Node(after, "Conditions")[2]!["MutagenObjectType"]!.GetValue<string>());
    }

    [Fact]
    public void Add_OnAKeyedArray_LandsInKeyOrder_AndAKeyHopFindsIt()
    {
        var before = DocumentEdits.Serialize(_npc);

        var added = Applied(before, "npc_", AddAt(Json("""{"Name": "Aardvark", "Flags": "Local"}"""), Member("VirtualMachineAdapter"), Member("Scripts")));

        Assert.Equal(["Aardvark", "Alpha", "Beta"], Node(added, "VirtualMachineAdapter.Scripts").AsArray().Select(s => s!["Name"]!.GetValue<string>()));
        AssertOnlyChanged(before, added, "VirtualMachineAdapter.Scripts[");

        var removed = Applied(added, "npc_", RemoveAt(Member("VirtualMachineAdapter"), Member("Scripts"), Key("Aardvark")));
        Assert.Equal(["Alpha", "Beta"], Node(removed, "VirtualMachineAdapter.Scripts").AsArray().Select(s => s!["Name"]!.GetValue<string>()));
    }

    [Fact]
    public void Set_OfAKeyMember_MovesTheElementToItsNewKeysPlace()
    {
        var before = Applied(DocumentEdits.Serialize(_npc), "npc_", AddAt(Json("""{"Name": "Aardvark", "Flags": "Local"}"""), Member("VirtualMachineAdapter"), Member("Scripts")));

        var after = Applied(before, "npc_", SetAt(Json("\"Zulu\""), Member("VirtualMachineAdapter"), Member("Scripts"), Key("Aardvark"), Member("Name")));

        Assert.Equal(["Alpha", "Beta", "Zulu"], Node(after, "VirtualMachineAdapter.Scripts").AsArray().Select(s => s!["Name"]!.GetValue<string>()));
    }

    // An element that is not there is a path the document does not know, on every operation.
    [Theory]
    [InlineData(RecordEditEnvelope.Remove)]
    [InlineData(RecordEditEnvelope.Move)]
    [InlineData(RecordEditEnvelope.Set)]
    public void AnElementPastTheEnd_IsRefusedNamingThePathAndTheLength_OnEveryOperation(string op)
    {
        var before = DocumentEdits.Serialize(_npc);
        var envelope = new RecordEditEnvelope(op, [Member("Keywords"), At(7)], Json("0"));

        var refusal = Apply(before, "npc_", envelope, out var written);

        Assert.Equal(RecordEditRefusal.FieldNotFound, refusal!.Refusal);
        Assert.Equal("Keywords[7]", refusal.Path);
        Assert.Contains("holds 1 element", refusal.Message, StringComparison.Ordinal);
        Assert.Equal(before, written);
    }

    [Fact]
    public void AKeyNoElementCarries_IsRefusedNamingThePathAndTheLength()
    {
        var before = DocumentEdits.Serialize(_npc);

        var refusal = Apply(before, "npc_", RemoveAt(Member("VirtualMachineAdapter"), Member("Scripts"), Key("Gamma")), out var written);

        Assert.Equal(RecordEditRefusal.FieldNotFound, refusal!.Refusal);
        Assert.Equal("VirtualMachineAdapter.Scripts[Gamma]", refusal.Path);
        Assert.Contains("holds 2 element", refusal.Message, StringComparison.Ordinal);
        Assert.Equal(before, written);
    }

    [Fact]
    public void Move_ToADestinationOutsideTheArray_IsRefusedNamingThatPosition()
    {
        var before = DocumentEdits.Serialize(_npc);

        var refusal = Apply(before, "npc_", MoveTo(3, Member("Keywords"), At(0)), out var written);

        Assert.Equal(RecordEditRefusal.FieldNotFound, refusal!.Refusal);
        Assert.Equal("Keywords[3]", refusal.Path);
        Assert.Equal(before, written);
    }

    // ── the cascade is the writer's ─────────────────────────────────────────

    [Fact]
    public void Set_GoverningMember_IdlesEverySlotTheNewValueDoesNotUse()
    {
        var before = DocumentEdits.Serialize(_cobj);
        Assert.Equal(10, Node(before, "Conditions")[0]!["Data"]!["ParameterTwoNumber"]!.GetValue<int>());

        var after = Applied(before, "cobj", SetAt(Json("\"HasKeyword\""), Member("Conditions"), At(0), Member("Data"), Member("Function")));

        var data = Node(after, "Conditions")[0]!["Data"]!.AsObject();
        Assert.Equal("HasKeyword", data["Function"]!.GetValue<string>());
        Assert.False(data.ContainsKey("ParameterTwoNumber"));
        Assert.Equal(_quest.FormKey.ToString(), data["ParameterOneRecord"]!.GetValue<string>());
        AssertOnlyChanged(before, after, "Conditions[0].Data.");
    }

    [Fact]
    public void Set_RunOnLeavingReference_ClearsTheReference()
    {
        var before = DocumentEdits.Serialize(_cobj);
        Assert.Equal(_npc.FormKey.ToString(), Node(before, "Conditions")[1]!["Data"]!["Reference"]!.GetValue<string>());

        var after = Applied(before, "cobj", SetAt(Json("\"Subject\""), Member("Conditions"), At(1), Member("Data"), Member("RunOnType")));

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
        var before = DocumentEdits.Serialize(_npc);

        var refusal = Apply(before, "npc_", SetAt(Json("1"), Member("NoSuchField")), out var written);

        Assert.Equal(RecordEditRefusal.FieldNotFound, refusal!.Refusal);
        Assert.Equal("NoSuchField", refusal.Path);
        Assert.Equal(before, written);
    }

    [Fact]
    public void UnknownNestedPath_IsRefusedNamingTheHopThatFailed()
    {
        var refusal = Apply(DocumentEdits.Serialize(_npc), "npc_", SetAt(Json("1"), Member("Weight"), Member("Bogus")), out _);

        Assert.Equal(RecordEditRefusal.FieldNotFound, refusal!.Refusal);
        Assert.Equal("Weight.Bogus", refusal.Path);
    }

    [Fact]
    public void MemberOfAnotherRecordClass_IsRefusedByName()
    {
        var refusal = Apply(DocumentEdits.Serialize(_globalInt), "glob", SetAt(Json("true"), Member("OutputChar")), out _);

        Assert.Equal(RecordEditRefusal.FieldNotFound, refusal!.Refusal);
        Assert.Contains(nameof(GlobalInt), refusal.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ReadOnlyColumn_IsRefusedWithItsReason()
    {
        var refusal = Apply(Encoding.UTF8.GetString(HeaderDocument.Write(_mod)), HeaderIndexer.RecordType, SetAt(Json("\"me\""), Member("Author")), out _);

        Assert.Equal(RecordEditRefusal.FieldReadOnly, refusal!.Refusal);
        Assert.Contains(SchemaRefusals.HeaderNoWritePathReason, refusal.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("""{"CompareOperator": "EqualTo"}""")]
    [InlineData("""{"CompareOperator": "EqualTo", "MutagenObjectType": "ConditionFloat"}""")]
    [InlineData("""{"MutagenObjectType": "ConditionMaybe"}""")]
    public void UnionElement_WithoutALeadingDiscriminatorNamingALeaf_IsRefused(string element)
    {
        var before = DocumentEdits.Serialize(_cobj);

        var refusal = Apply(before, "cobj", AddAt(Json(element), Member("Conditions")), out var written);

        Assert.Equal(RecordEditRefusal.DiscriminatorInvalid, refusal!.Refusal);
        Assert.Equal("Conditions[2]", refusal.Path);
        Assert.Equal(before, written);
    }

    [Fact]
    public void DuplicateKey_IsRefusedNamingTheKeyAndTheArray()
    {
        var before = DocumentEdits.Serialize(_npc);

        var refusal = Apply(before, "npc_", AddAt(Json("""{"Name": "Alpha"}"""), Member("VirtualMachineAdapter"), Member("Scripts")), out var written);

        Assert.Equal(RecordEditRefusal.DuplicateKeyInKeyedArray, refusal!.Refusal);
        Assert.Equal("VirtualMachineAdapter.Scripts", refusal.Path);
        Assert.Contains("'Alpha'", refusal.Message, StringComparison.Ordinal);
        Assert.Equal(before, written);
    }

    [Fact]
    public void HexOfAnotherLength_IsRefusedNamingBothLengths()
    {
        var before = DocumentEdits.Serialize(_cobj);
        Assert.Equal("0x000000", Node(before, "Conditions")[0]!["Unknown1"]!.GetValue<string>());

        var refusal = Apply(before, "cobj", SetAt(Json("\"0x0102\""), Member("Conditions"), At(0), Member("Unknown1")), out var written);

        Assert.Equal(RecordEditRefusal.HexLengthMismatch, refusal!.Refusal);
        Assert.Contains("3 bytes", refusal.Message, StringComparison.Ordinal);
        Assert.Contains("2 bytes", refusal.Message, StringComparison.Ordinal);
        Assert.Equal(before, written);
    }

    [Theory]
    [InlineData("\"ABCDEF:Nowhere.esp\"")]
    [InlineData("kywd")]
    public void LinkTarget_DanglingOrOfTheWrongType_IsRefused(string target)
    {
        var value = target == "kywd" ? $"\"{_keyword.FormKey}\"" : target;

        var refusal = Apply(DocumentEdits.Serialize(_npc), "npc_", SetAt(Json(value), Member("Race")), out _);

        Assert.Equal(RecordEditRefusal.InvalidFormLink, refusal!.Refusal);
        Assert.Equal("Race", refusal.Path);
    }

    [Fact]
    public void KeyHop_IntoAnArrayTheSchemaDoesNotKey_IsRefused()
    {
        var refusal = Apply(DocumentEdits.Serialize(_npc), "npc_", RemoveAt(Member("Keywords"), Key("x")), out _);

        Assert.Equal(RecordEditRefusal.InvalidEnvelope, refusal!.Refusal);
    }

    [Theory]
    [InlineData("frobnicate", "HeightMax", "1")]
    [InlineData("set", "HeightMax", null)]
    [InlineData("remove", "HeightMax", null)]
    [InlineData("move", "Keywords[0]", "\"up\"")]
    public void MalformedEnvelope_IsRefusedAsSuch(string op, string path, string? value)
    {
        var hops = path == "Keywords[0]" ? new[] { Member("Keywords"), At(0) } : [Member(path)];
        var envelope = new RecordEditEnvelope(op, hops, value == null ? null : Json(value));

        var refusal = Apply(DocumentEdits.Serialize(_npc), "npc_", envelope, out _);

        Assert.Equal(RecordEditRefusal.InvalidEnvelope, refusal!.Refusal);
    }

    // ── the codec is the one shape gate ─────────────────────────────────────

    [Fact]
    public void CodecRejection_NamesThePathAndQuotesMutagen()
    {
        var before = DocumentEdits.Serialize(_npc);

        var refusal = Apply(before, "npc_", SetAt(Json("\"tall\""), Member("HeightMax")), out var written);

        Assert.Equal(RecordEditRefusal.CodecRejected, refusal!.Refusal);
        Assert.Equal("HeightMax", refusal.Path);
        Assert.Contains("tall", refusal.Message, StringComparison.Ordinal);
        Assert.Equal(before, written);
    }

    [Theory]
    [InlineData("npc_", "EnergyLevel", "256")]
    [InlineData("npc_", "XpValueOffset", "32768")]
    [InlineData("npc_", "AggroRadiusWarn", "-1")]
    public void IntegerWidth_IsTheCodecs(string table, string column, string value)
    {
        var refusal = Apply(DocumentEdits.Serialize(_npc), table, SetAt(Json(value), Member(column)), out _);

        Assert.Equal(RecordEditRefusal.CodecRejected, refusal!.Refusal);
        Assert.Equal(column, refusal.Path);
    }

    [Fact]
    public void NormalizedValue_CountsAsApplied_InTheCodecsOwnSpelling()
    {
        var before = DocumentEdits.Serialize(_cobj);

        var after = Applied(before, "cobj", SetAt(Json("\"0x0a0b0c\""), Member("Conditions"), At(0), Member("Unknown1")));

        Assert.Equal(["Conditions[0].Unknown1: \"0x000000\" -> \"0x0A0B0C\""], ConditionEditTests.DocumentDiff(before, after));
    }

    [Fact]
    public void ValueTheCodecDrops_IsRefusedNamingIt_NeverReportedAsSuccess()
    {
        var before = DocumentEdits.Serialize(_npc);

        var refusal = Apply(before, "npc_", SetAt(Json("""{"Thin": 0.5, "Bogus": 1}"""), Member("Weight")), out var written);

        Assert.Equal(RecordEditRefusal.CodecDroppedValue, refusal!.Refusal);
        Assert.Equal("Weight.Bogus", refusal.Path);
        Assert.Equal(before, written);
    }

    [Fact]
    public void TranslatedString_IsWrittenInTheDocumentsOwnObjectForm()
    {
        var before = DocumentEdits.Serialize(_npc);

        var after = Applied(before, "npc_", SetAt(Json("""{"Value": "Named"}"""), Member("Name")));

        Assert.Equal("Named", Node(after, "Name.Value").GetValue<string>());
        AssertOnlyChanged(before, after, "Name");
    }

    // ── the synthetic members ───────────────────────────────────────────────

    [Fact]
    public void Header_IsSmallMaster_WritesTheFlagsMemberAndNothingElse()
    {
        var before = Encoding.UTF8.GetString(HeaderDocument.Write(_mod));

        var set = Applied(before, HeaderIndexer.RecordType, SetAt(Json("true"), Member("IsSmallMaster")));
        Assert.True(HeaderDocument.IsLight(Encoding.UTF8.GetBytes(set)));
        AssertOnlyChanged(before, set, "ModHeader.Flags");

        var cleared = Applied(set, HeaderIndexer.RecordType, SetAt(Json("false"), Member("IsSmallMaster")));
        Assert.Equal(before, cleared);
    }

    [Fact]
    public void PartialForm_WritesExactlyItsBitOfTheHeaderFlags_AndTheCodecsOwnViewsOfIt()
    {
        var cell = new Cell(_mod) { EditorID = "C", WaterHeight = 5f, MajorRecordFlagsRaw = 0x0400 };
        var before = DocumentEdits.Serialize(cell);

        var set = Applied(before, "cell", SetAt(Json("true"), Member("IsPartialForm")));

        Assert.Equal(0x4400, Node(set, "MajorRecordFlagsRaw").GetValue<int>());
        Assert.All(ConditionEditTests.DocumentDiff(before, set),
            d => Assert.Contains(d.Split(':')[0].Split('[')[0], new[] { "MajorRecordFlagsRaw", "Fallout4MajorRecordFlags", "MajorFlags" }));

        var cleared = Applied(set, "cell", SetAt(Json("false"), Member("IsPartialForm")));
        Assert.Equal(before, cleared);
    }

    [Fact]
    public void PartialForm_OnATypeThatCannotCarryIt_IsRefusedByName()
    {
        var refusal = Apply(DocumentEdits.Serialize(_npc), "npc_", SetAt(Json("true"), Member("IsPartialForm")), out _);

        Assert.Equal(RecordEditRefusal.FieldNotFound, refusal!.Refusal);
    }

    [Fact]
    public void PartialFormRecord_RefusesItsOwnFields_ButNotTheFlagOrTheEditorId()
    {
        var cell = new Cell(_mod) { EditorID = "C", WaterHeight = 5f, MajorRecordFlagsRaw = PartialFormFlag.Bit };
        var before = DocumentEdits.Serialize(cell);

        var refusal = Apply(before, "cell", SetAt(Json("9.0"), Member("WaterHeight")), out var written);
        Assert.Equal(RecordEditRefusal.PartialFormFieldReadOnly, refusal!.Refusal);
        Assert.Equal(before, written);

        Assert.Null(Apply(before, "cell", SetAt(Json("\"Renamed\""), Member("EditorID")), out _));
        Assert.Null(Apply(before, "cell", SetAt(Json("false"), Member("IsPartialForm")), out _));
    }

    // ── container children ──────────────────────────────────────────────────

    [Fact]
    public void EmbeddedChild_IsPatchedInsideItsParentsDocument()
    {
        var cell = new Cell(_mod) { EditorID = "C", WaterHeight = 5f };
        var placed = new PlacedObject(_mod) { EditorID = "Ref", Scale = 1f };
        cell.Temporary.Add(placed);
        var before = DocumentEdits.Serialize(cell);

        var refusal = DocumentEdits.Apply(
            before, Schemas["refr"], SetAt(Json("2.5"), Member("Scale")), out var after,
            Resolve, prefix: [Member("Temporary"), At(0)], ownerRecordType: "cell");

        Assert.Null(refusal);
        Assert.Equal(["Temporary[0].Scale: 1.0 -> 2.5"], ConditionEditTests.DocumentDiff(before, after));
    }

    [Fact]
    public void ChildOrderMember_IsCarriedThroughTheReserialize()
    {
        var quest = _mod.Quests.AddNew("Ordered");
        var order = JsonNode.Parse("""{"DialogTopics": ["000801:DocEdit.esp", "000802:DocEdit.esp"]}""")!;
        var before = SourceChildOrder.WithOrder(DocumentEdits.Serialize(quest), order);

        var after = Applied(before, "qust", SetAt(Json("\"Renamed\""), Member("EditorID")));

        Assert.Equal(
            JsonNode.Parse(before)![SourceChildOrder.OrderMember]!.ToJsonString(),
            JsonNode.Parse(after)![SourceChildOrder.OrderMember]!.ToJsonString());
        Assert.Equal(["EditorID: \"Ordered\" -> \"Renamed\""], ConditionEditTests.DocumentDiff(before, after));
    }

    [Fact]
    public void FolderSplitChild_IsNeverInlinedIntoItsParent()
    {
        var before = DocumentEdits.Serialize(_quest);

        var refusal = Apply(before, "qust", SetAt(Json($$"""[{"FormKey": "000900:DocEdit.esp", "EditorID": "Topic"}]"""), Member("DialogTopics")), out var written);

        // The per-record codec writes a folder-split child to its own file, never inline, so the
        // member the patch spelled comes back absent and the write is refused as dropped.
        Assert.Equal(RecordEditRefusal.CodecDroppedValue, refusal!.Refusal);
        Assert.Equal("DialogTopics", refusal.Path);
        Assert.Equal(before, written);
    }
}
