using System.Text;
using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using static MEditService.Codec.Tests.TestSupport.DocumentEditing;

namespace MEditService.Codec.Tests.Schema;

public sealed class DocumentEditTests
{
    private static readonly IReadOnlyDictionary<string, RecordTableSchema> Schemas =
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);

    private readonly Fallout4Mod _mod = new(ModKey.FromFileName("DocEdit.esp"), Fallout4Release.Fallout4);

    private readonly Keyword _keyword;
    private readonly Keyword _otherKeyword;
    private readonly Npc _npc;
    private readonly ConstructibleObject _cobj;
    private readonly Quest _quest;
    private readonly GlobalInt _globalInt;

    public DocumentEditTests()
    {
        _keyword = _mod.Keywords.AddNew("Kw");
        _otherKeyword = _mod.Keywords.AddNew("Kw2");
        var race = _mod.Races.AddNew("Rc");
        _quest = _mod.Quests.AddNew("Qu");
        _globalInt = _mod.Globals.AddNewInt("Gi");

        _npc = _mod.Npcs.AddNew("Guy");
        _npc.Race.SetTo(race);
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

    private static string TextOf(IMajorRecordGetter record) => RecordTextCodec.SerializeToText(record, GameRelease.Fallout4);

    private string NpcText() => TextOf(_npc);

    private string CobjText() => TextOf(_cobj);

    private string HeaderText() => Encoding.UTF8.GetString(HeaderDocument.Write(_mod));

    private static void AssertOnlyChanged(string before, string after, params string[] paths)
    {
        var diffs = DocumentDiffs.Of(before, after);
        Assert.NotEmpty(diffs);
        Assert.All(diffs, d => Assert.Contains(paths, p => d.StartsWith(p, StringComparison.Ordinal)));
    }

    private static JsonNode Node(string text, string dotted)
    {
        var node = JsonNode.Parse(text).Require();
        foreach (var hop in dotted.Split('.')) node = node[hop].Require();
        return node;
    }

    private static IEnumerable<string> ScriptNames(string document) =>
        Node(document, "VirtualMachineAdapter.Scripts").AsArray().Select(s => s.Require()["Name"].Require().GetValue<string>());

    [Fact]
    public void Set_TopLevelScalar_ChangesExactlyThatPath()
    {
        var before = NpcText();

        var after = Edited(before, "npc_", EditOp.Set, "0.75", Member("HeightMax"));

        Assert.Equal(["HeightMax: 1.0 -> 0.75"], DocumentDiffs.Of(before, after));
    }

    [Fact]
    public void Set_MemberOfANestedStruct_ChangesExactlyThatPath()
    {
        var before = NpcText();

        var after = Edited(before, "npc_", EditOp.Set, "0.5", Member("Weight"), Member("Thin"));

        Assert.Equal(["Weight: <absent> -> {\"Thin\":0.5}"], DocumentDiffs.Of(before, after));
    }

    [Fact]
    public void Set_MemberOfAnArrayElement_ChangesExactlyThatPath()
    {
        var before = CobjText();

        var after = Edited(before, "cobj", EditOp.Set, "\"LessThan\"", Member("Conditions"), At(0), Member("CompareOperator"));

        Assert.Equal(["Conditions[0].CompareOperator: \"GreaterThan\" -> \"LessThan\""], DocumentDiffs.Of(before, after));
    }

    [Fact]
    public void Set_ThroughTwoKeyedArrays_ChangesExactlyThatPath()
    {
        var before = NpcText();

        var after = Edited(
            before, "npc_", EditOp.Set, "9",
            Member("VirtualMachineAdapter"), Member("Scripts"), At(0), Member("Properties"), At(0), Member("Data"));

        Assert.Equal(["VirtualMachineAdapter.Scripts[0].Properties[0].Data: 1 -> 9"], DocumentDiffs.Of(before, after));
    }

    [Fact]
    public void Set_Null_ClearsTheMemberSoItReadsAsItsDefault()
    {
        var before = NpcText();

        var after = Edited(before, "npc_", EditOp.Set, "null", Member("HeightMax"));

        Assert.Equal(["HeightMax: 1.0 -> <absent>"], DocumentDiffs.Of(before, after));
    }

    [Fact]
    public void Set_Discriminator_KeepsSharedMembersAndDropsTheMemberTheNewLeafShapesDifferently()
    {
        var before = CobjText();

        var after = Edited(before, "cobj", EditOp.Set, "\"ConditionGlobal\"", Member("Conditions"), At(0), Member("MutagenObjectType"));

        Assert.Equal(
            [
                "Conditions[0].MutagenObjectType: \"ConditionFloat\" -> \"ConditionGlobal\"",
                "Conditions[0].ComparisonValue: 2.5 -> <absent>",
            ],
            DocumentDiffs.Of(before, after));
        Assert.Equal("GreaterThan", Node(after, "Conditions")[0].Require()["CompareOperator"].Require().GetValue<string>());
    }

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

        var after = Edited(before, "mgef", EditOp.Set, "\"MagicEffectLightArchetype\"", Member("Archetype"), Member("MutagenObjectType"));

        Assert.Equal(
            [
                "Archetype.MutagenObjectType: \"MagicEffectCloakArchetype\" -> \"MagicEffectLightArchetype\"",
                "Archetype.Association: \"000802:DocEdit.esp\" -> <absent>",
            ],
            DocumentDiffs.Of(before, after));
    }

    [Fact]
    public void Set_Discriminator_ToALeafTheUnionLacks_FailsNamingTheDiscriminator()
    {
        var failure = Failure(CobjText(), "cobj", EditOp.Set, "\"ConditionMaybe\"", Member("Conditions"), At(0), Member("MutagenObjectType"));

        var notALeaf = Assert.IsType<EditFailure.NotALeaf>(failure);
        Assert.Equal("Conditions[0].MutagenObjectType", notALeaf.Path);
        Assert.Equal("MutagenObjectType", notALeaf.Discriminator.Name);
    }

    [Fact]
    public void Add_Remove_Move_OnAPositionalArray_ChangeThatArrayAlone()
    {
        var before = NpcText();

        var added = Edited(before, "npc_", EditOp.Add, $"\"{_otherKeyword.FormKey}\"", Member("Keywords"));
        AssertOnlyChanged(before, added, "Keywords[1]");
        Assert.Equal(2, Node(added, "Keywords").AsArray().Count);

        var moved = Edited(added, "npc_", EditOp.Move, "0", Member("Keywords"), At(1));
        Assert.Equal([_otherKeyword.FormKey.ToString(), _keyword.FormKey.ToString()], Node(moved, "Keywords").AsArray().Select(k => k.Require().GetValue<string>()));
        AssertOnlyChanged(added, moved, "Keywords[");

        var removed = Edited(moved, "npc_", EditOp.Remove, null, Member("Keywords"), At(0));
        Assert.Equal([_keyword.FormKey.ToString()], Node(removed, "Keywords").AsArray().Select(k => k.Require().GetValue<string>()));
        AssertOnlyChanged(moved, removed, "Keywords[");
    }

    [Fact]
    public void Add_WithoutAValue_AppendsTheElementTypesDefault()
    {
        var before = CobjText();

        var after = Edited(before, "cobj", EditOp.Add, null, Member("Conditions"));

        AssertOnlyChanged(before, after, "Conditions[2]");
        var elementSpec = Schemas["cobj"].RecordColumns.Single(c => c.Name == "Conditions").Field.ElementType
            ?? throw new InvalidOperationException("Expected 'Conditions' to be an array of a struct element.");
        var subFields = elementSpec.Fields
            ?? throw new InvalidOperationException("Expected the array element to declare its own fields.");
        var leaf = subFields.Single(f => f.IsDiscriminator).EnumMembers[0].Value;
        Assert.Equal(leaf, Node(after, "Conditions")[2].Require()["MutagenObjectType"].Require().GetValue<string>());
    }

    [Fact]
    public void Add_OnAKeyedArray_AppendsTheElement()
    {
        var before = NpcText();

        var added = Edited(before, "npc_", EditOp.Add, """{"Name": "Aardvark", "Flags": "Local"}""", Member("VirtualMachineAdapter"), Member("Scripts"));

        Assert.Equal(["Alpha", "Beta", "Aardvark"], ScriptNames(added));
        AssertOnlyChanged(before, added, "VirtualMachineAdapter.Scripts[2]");
    }

    [Fact]
    public void Set_OfAKeyMember_LeavesTheElementWhereItIs()
    {
        var after = Edited(NpcText(), "npc_", EditOp.Set, "\"Zulu\"", Member("VirtualMachineAdapter"), Member("Scripts"), At(0), Member("Name"));

        Assert.Equal(["Zulu", "Beta"], ScriptNames(after));
    }

    [Theory]
    [InlineData(EditOp.Remove)]
    [InlineData(EditOp.Move)]
    [InlineData(EditOp.Set)]
    public void AnElementPastTheEnd_FailsNamingThePathAndTheLength_OnEveryOperation(EditOp op)
    {
        var failure = Failure(NpcText(), "npc_", op, "0", Member("Keywords"), At(7));

        Assert.Equal(new EditFailure.NoElement("Keywords[7]", 1), failure);
    }

    [Fact]
    public void Move_ToADestinationOutsideTheArray_FailsNamingThatPosition()
    {
        var failure = Failure(NpcText(), "npc_", EditOp.Move, "3", Member("Keywords"), At(0));

        Assert.Equal(new EditFailure.NoElement("Keywords[3]", 1), failure);
    }

    [Fact]
    public void Set_GoverningMember_IdlesEverySlotTheNewValueDoesNotUse()
    {
        var before = CobjText();
        Assert.Equal(10, Node(before, "Conditions")[0].Require()["Data"].Require()["ParameterTwoNumber"].Require().GetValue<int>());

        var after = Edited(before, "cobj", EditOp.Set, "\"HasKeyword\"", Member("Conditions"), At(0), Member("Data"), Member("Function"));

        var data = Node(after, "Conditions")[0].Require()["Data"].Require().AsObject();
        Assert.Equal("HasKeyword", data["Function"].Require().GetValue<string>());
        Assert.False(data.ContainsKey("ParameterTwoNumber"));
        Assert.Equal(_quest.FormKey.ToString(), data["ParameterOneRecord"].Require().GetValue<string>());
        AssertOnlyChanged(before, after, "Conditions[0].Data.");
    }

    [Fact]
    public void Set_RunOnLeavingReference_ClearsTheReference()
    {
        var before = CobjText();
        Assert.Equal(_npc.FormKey.ToString(), Node(before, "Conditions")[1].Require()["Data"].Require()["Reference"].Require().GetValue<string>());

        var after = Edited(before, "cobj", EditOp.Set, "\"Subject\"", Member("Conditions"), At(1), Member("Data"), Member("RunOnType"));

        Assert.Equal(
            [
                "Conditions[1].Data.RunOnType: \"Reference\" -> <absent>",
                $"Conditions[1].Data.Reference: \"{_npc.FormKey}\" -> <absent>",
            ],
            DocumentDiffs.Of(before, after));
    }

    [Fact]
    public void UnknownTopLevelPath_FailsAsNoFieldOfTheTable_NamingThePath()
    {
        var failure = Failure(NpcText(), "npc_", EditOp.Set, "1", Member("NoSuchField"));

        Assert.Equal(new EditFailure.NoField("NoSuchField", "npc_", "NoSuchField"), failure);
    }

    [Fact]
    public void UnknownNestedPath_FailsNamingTheHopThatFailed()
    {
        var failure = Failure(NpcText(), "npc_", EditOp.Set, "1", Member("Weight"), Member("Bogus"));

        Assert.Equal("Weight.Bogus", Assert.IsType<EditFailure.NoMember>(failure).Path);
    }

    [Fact]
    public void MemberOfAnotherRecordClass_FailsNamingThatClass()
    {
        var failure = Failure(TextOf(_globalInt), "glob", EditOp.Set, "true", Member("OutputChar"));

        Assert.Equal(nameof(GlobalInt), Assert.IsType<EditFailure.NoField>(failure).Owner);
    }

    [Fact]
    public void Header_Author_IsWrittenAsAnyFieldIs()
    {
        var before = HeaderText();

        var after = Edited(before, PluginHeader.RecordType, EditOp.Set, "\"me\"", Member("Author"));

        Assert.Equal("me", Node(after, "ModHeader.Author").GetValue<string>());
        AssertOnlyChanged(before, after, "ModHeader.Author");
    }

    [Fact]
    public void Header_Flags_AreWrittenAsAnyFlagsFieldIs()
    {
        var before = HeaderText();

        var after = Edited(before, PluginHeader.RecordType, EditOp.Set, "[\"Master\"]", Member("Flags"));

        Assert.Equal("Master", Node(after, "ModHeader.Flags")[0].Require().GetValue<string>());
        AssertOnlyChanged(before, after, "ModHeader.Flags");
    }

    [Fact]
    public void Header_Masters_FailAsReadOnly_WithTheirReason()
    {
        var failure = Failure(HeaderText(), PluginHeader.RecordType, EditOp.Set, "[]", Member("MasterReferences"));

        Assert.Contains("content-derived", Assert.IsType<EditFailure.ReadOnlyMember>(failure).Reason, StringComparison.Ordinal);
    }

    [Fact]
    public void Header_VersionControlInfo1_IsWrittenAsAnyFieldIs()
    {
        var before = HeaderText();

        var after = Edited(before, PluginHeader.RecordType, EditOp.Set, "7", Member("Version"));

        Assert.Equal(7, Node(after, "ModHeader.Version").GetValue<int>());
        AssertOnlyChanged(before, after, "ModHeader.Version");
    }

    [Theory]
    [InlineData("""{"CompareOperator": "EqualTo"}""")]
    [InlineData("""{"CompareOperator": "EqualTo", "MutagenObjectType": "ConditionFloat"}""")]
    [InlineData("""{"MutagenObjectType": "ConditionMaybe"}""")]
    public void UnionElement_WithoutALeadingDiscriminatorNamingALeaf_Fails(string element)
    {
        var failure = Failure(CobjText(), "cobj", EditOp.Add, element, Member("Conditions"));

        Assert.Equal("Conditions[2]", Assert.IsType<EditFailure.NotALeaf>(failure).Path);
    }

    [Fact]
    public void AnElementAddedAtAKeyAnotherHolds_IsWritten()
    {
        var after = Edited(NpcText(), "npc_", EditOp.Add, """{"Name": "Alpha"}""", Member("VirtualMachineAdapter"), Member("Scripts"));

        Assert.Equal(["Alpha", "Beta", "Alpha"], ScriptNames(after));
    }

    [Theory]
    [InlineData("ABCDEF:Nowhere.esp")]
    [InlineData("kywd")]
    public void LinkTarget_DanglingOrOfTheWrongType_Lands(string target)
    {
        var linkTarget = target == "kywd" ? _keyword.FormKey.ToString() : target;

        var after = Edited(NpcText(), "npc_", EditOp.Set, $"\"{linkTarget}\"", Member("Race"));

        Assert.Equal(linkTarget, Node(after, "Race").GetValue<string>());
    }

    [Fact]
    public void NormalizedValue_IsMade_InTheCodecsOwnSpelling()
    {
        var before = CobjText();

        var after = Edited(before, "cobj", EditOp.Set, "\"0x0a0b0c\"", Member("Conditions"), At(0), Member("Unknown1"));

        Assert.Equal(["Conditions[0].Unknown1: \"0x000000\" -> \"0x0A0B0C\""], DocumentDiffs.Of(before, after));
    }

    [Fact]
    public void AColorHoldingAlpha_TakesAnOpaqueAlpha_WhichTheCodecSpellsWithoutIt()
    {
        var before = TextOf(_keyword);

        var after = Edited(before, "kywd", EditOp.Set, "\"#FF102030\"", Member("Color"));

        Assert.Equal(["Color: <absent> -> \"#102030\""], DocumentDiffs.Of(before, after));
    }

    [Theory]
    [InlineData("\"#102030\"")]
    [InlineData("\"#00102030\"")]
    public void AColorHoldingNoAlpha_TakesItsRgb_InMutagensOwnSpellingOfNoAlpha(string color)
    {
        var before = TextOf(_mod.Weather.AddNew("Wt"));

        var after = Edited(before, "wthr", EditOp.Set, color, Member("LightningColor"));

        Assert.Equal(["LightningColor: <absent> -> \"#00102030\""], DocumentDiffs.Of(before, after));
    }

    [Fact]
    public void AColorHoldingNoAlpha_PastedBackAsItsCellCopiesIt_ChangesNothing()
    {
        var weather = _mod.Weather.AddNew("Wt");
        weather.LightningColor = System.Drawing.Color.FromArgb(0, 0x10, 0x20, 0x30);
        var before = TextOf(weather);
        Assert.Equal("#00102030", Node(before, "LightningColor").GetValue<string>());

        var after = Edited(before, "wthr", EditOp.Set, "\"#102030\"", Member("LightningColor"));

        Assert.Empty(DocumentDiffs.Of(before, after));
    }

    [Theory]
    [InlineData("#102030")]
    [InlineData("#00102030")]
    public void AnElementPasted_WithAColorHoldingNoAlpha_HoldsItInMutagensOwnSpellingOfNoAlpha(string tint)
    {
        var after = Edited(TextOf(_mod.LensFlares.AddNew("Lf")), "lens", EditOp.Add, $$$"""{"Data": {"Tint": "{{{tint}}}"}}""", Member("Sprites"));

        Assert.Equal("#00102030", Node(after, "Sprites").AsArray()[0].Require()["Data"].Require()["Tint"].Require().GetValue<string>());
    }

    [Fact]
    public void TranslatedString_IsWrittenInTheDocumentsOwnObjectForm()
    {
        var before = NpcText();

        var after = Edited(before, "npc_", EditOp.Set, """{"Value": "Named"}""", Member("Name"));

        Assert.Equal("Named", Node(after, "Name.Value").GetValue<string>());
        AssertOnlyChanged(before, after, "Name");
    }

    [Fact]
    public void Header_IsSmallMaster_WritesTheFlagsMemberAndNothingElse()
    {
        var before = HeaderText();

        var set = Edited(before, PluginHeader.RecordType, EditOp.Set, "true", Member("IsSmallMaster"));
        Assert.True(HeaderDocument.IsLight(Encoding.UTF8.GetBytes(set)));
        AssertOnlyChanged(before, set, "ModHeader.Flags");

        var cleared = Edited(set, PluginHeader.RecordType, EditOp.Set, "false", Member("IsSmallMaster"));
        Assert.Equal(before, cleared);
    }

    [Fact]
    public void RecordFlags_WritesTheRawInteger_AndTheCodecsViewsOfItFollow()
    {
        const int persistent = 0x0400, cantWait = 0x0008_0000;
        var before = TextOf(new Cell(_mod) { EditorID = "C", WaterHeight = 5f, MajorRecordFlagsRaw = persistent });

        var set = Edited(before, "cell", EditOp.Set, $"{persistent | cantWait}", Member("MajorRecordFlagsRaw"));

        Assert.Equal(persistent | cantWait, Node(set, "MajorRecordFlagsRaw").GetValue<int>());
        Assert.Equal(["CantWait", "Persistent"], Node(set, "MajorFlags").AsArray().Select(n => n.Require().GetValue<string>()).Order(StringComparer.Ordinal));
        AssertOnlyChanged(before, set, "MajorRecordFlagsRaw", "Fallout4MajorRecordFlags", "MajorFlags");
    }

    [Fact]
    public void APathReachingTheGovernedMember_FailsAsReadOnlyByName()
    {
        var failure = Failure(SceneWithAnActionText(), "scen", EditOp.Set, "{}", Member("Actions"), At(0), Member("Type"));

        Assert.Equal("Type", Assert.IsType<EditFailure.ReadOnlyMember>(failure).Member);
    }

    [Fact]
    public void AWholeElementSpellingTheGovernedMember_FailsAsReadOnlyByName()
    {
        var failure = Failure(SceneWithAnActionText(), "scen", EditOp.Set, """{"Name": "Second", "Type": {}}""", Member("Actions"), At(0));

        Assert.Equal("Type", Assert.IsType<EditFailure.ReadOnlyMember>(failure).Member);
    }

    private string SceneWithAnActionText()
    {
        var scene = new Scene(_mod) { EditorID = "DefectScene" };
        scene.Actions.Add(new SceneAction { Name = "First" });
        return TextOf(scene);
    }

    [Fact]
    public void ARegionsWeatherOcclusionDistance_TakesASet()
    {
        var region = new Region(new FormKey(_mod.ModKey, 0x800), Fallout4Release.Fallout4)
        {
            Weather = new RegionWeather { LodDisplayDistanceMultiplier = 2, OcclusionAccuracyDist = 12 },
        };

        var after = Edited(TextOf(region), "regn", EditOp.Set, "13", Member("Weather"), Member("OcclusionAccuracyDist"));

        Assert.Equal(13, Node(after, "Weather.OcclusionAccuracyDist").GetValue<float>());
    }

    [Fact]
    public void AQuestHoldingStageZero_TakesTwoNewStages_EachAtStageZero()
    {
        var quest = new Quest(new FormKey(_mod.ModKey, 0x801), Fallout4Release.Fallout4) { Stages = [new QuestStage { Index = 0 }, new QuestStage { Index = 10 }] };

        var once = Edited(TextOf(quest), "qust", EditOp.Add, null, Member("Stages"));
        var twice = Edited(once, "qust", EditOp.Add, null, Member("Stages"));

        Assert.Equal([0, 10, 0, 0], Node(twice, "Stages").AsArray().Select(stage => stage.Require()["Index"]?.GetValue<int>() ?? 0));
    }

    [Fact]
    public void GameSettingFloat_Data_IsWrittenAsTheFloatItsLeafDeclares()
    {
        var key = new FormKey(_mod.ModKey, 0x801);

        var after = Edited(TextOf(new GameSettingFloat(key, Fallout4Release.Fallout4) { EditorID = "fTest", Data = 1.5f }), "gmst", EditOp.Set, "2.5", Member("Data"));

        Assert.Equal(TextOf(new GameSettingFloat(key, Fallout4Release.Fallout4) { EditorID = "fTest", Data = 2.5f }), after);
    }

    [Fact]
    public void ObjectModIntProperty_Value_IsWrittenAsTheIntItsLeafDeclares()
    {
        var after = Edited(TextOf(ArmorMod(value: 5)), "omod", EditOp.Set, "42", Member("Properties"), At(0), Member("Value"));

        Assert.Equal(TextOf(ArmorMod(value: 42)), after);
    }

    private ArmorModification ArmorMod(uint value)
    {
        var armor = new ArmorModification(new FormKey(_mod.ModKey, 0x801), Fallout4Release.Fallout4) { EditorID = "ArmorMod" };
        armor.Properties.Add(new ObjectModIntProperty<Armor.Property> { Property = Armor.Property.BodyPart, Step = 1f, Value = value });
        return armor;
    }
}
