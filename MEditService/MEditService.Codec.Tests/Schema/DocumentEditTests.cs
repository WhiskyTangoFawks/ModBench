using System.Text;
using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Strings;
using Noggog;
using static MEditService.Codec.Tests.TestSupport.DocumentEditing;

namespace MEditService.Codec.Tests.Schema;

public sealed class DocumentEditTests
{
    private const string KeywordFormKey = "000900:DocEdit.esp";

    private readonly Fallout4Mod _mod = new(ModKey.FromFileName("DocEdit.esp"), Fallout4Release.Fallout4);

    private readonly Keyword _keyword;
    private readonly Keyword _otherKeyword;
    private readonly Npc _npc;
    private readonly ConstructibleObject _cobj;
    private readonly Quest _quest;
    private readonly GlobalInt _globalInt;
    private readonly Dictionary<string, (string Table, string Text)> _records;

    public DocumentEditTests()
    {
        _keyword = new Keyword(FormKey.Factory(KeywordFormKey), Fallout4Release.Fallout4) { EditorID = "Kw" };
        _mod.Keywords.Add(_keyword);
        _otherKeyword = _mod.Keywords.AddNew("Kw2");
        var race = _mod.Races.AddNew("Rc");
        _quest = _mod.Quests.AddNew("Qu");
        _globalInt = _mod.Globals.AddNewInt("Gi");
        _globalInt.Data = 3;

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

        _records = new(StringComparer.Ordinal)
        {
            ["the npc"] = ("npc_", TextOf(_npc)),
            ["the recipe"] = ("cobj", TextOf(_cobj)),
            ["the int global"] = ("glob", TextOf(_globalInt)),
            ["the keyword"] = ("kywd", TextOf(_keyword)),
            ["a weather"] = ("wthr", TextOf(_mod.Weather.AddNew("Wt"))),
            ["a magic effect with a cloak archetype"] = ("mgef", """
                {
                  "FormKey": "000801:DocEdit.esp",
                  "Archetype": {
                    "MutagenObjectType": "MagicEffectCloakArchetype",
                    "Association": "000802:DocEdit.esp"
                  }
                }
                """),
            ["an npc in a faction"] = ("npc_", TextOf(NpcInAFaction())),
            ["an armor mod"] = ("omod", TextOf(ArmorModWith(0x802, new ObjectModIntProperty<Armor.Property> { Property = Armor.Property.BodyPart, Step = 1f }))),
            ["an armor mod of two properties"] = ("omod", TextOf(ArmorModWith(
                0x80A,
                new ObjectModIntProperty<Armor.Property> { Property = Armor.Property.BodyPart, Step = 1f, Value = 5, Value2 = 6 },
                new ObjectModFloatProperty<Armor.Property> { Property = Armor.Property.Weight, Step = 2f, Value = 1.5f, Value2 = 2.5f }))),
            ["a race"] = ("race", TextOf(RaceOfTwoSubgraphs())),
            ["a misc item"] = ("misc", TextOf(new MiscItem(KeyOf(0x804), Fallout4Release.Fallout4) { EditorID = "Misc", ComponentDisplayIndices = [1] })),
            ["a scene collection"] = ("scco", TextOf(new SceneCollection(KeyOf(0x805), Fallout4Release.Fallout4) { EditorID = "Scco", XNAMs = [1L] })),
            ["a material object"] = ("mato", TextOf(MaterialObjectOfOneSlice())),
            ["a faction with a vendor location"] = ("fact", TextOf(FactionWithAVendorLocation())),
            ["an npc with a removed script property"] = ("npc_", TextOf(NpcWithARemovedScriptProperty())),
            ["a debris of two models"] = ("debr", TextOf(DebrisOfTwoModels())),
            ["a quest with a location alias"] = ("qust", TextOf(new Quest(KeyOf(0x80D), Fallout4Release.Fallout4) { EditorID = "Quest", Aliases = [new QuestLocationAlias { Name = "OriginalLoc" }] })),
            ["an npc of scripts out of key order"] = ("npc_", TextOf(NpcOfScriptsOutOfKeyOrder())),
            ["an npc of scripts another tool wrote"] = ("npc_", TextOf(NpcOfScriptsAnotherToolWrote())),
            ["an npc of a fixed level"] = ("npc_", TextOf(new Npc(KeyOf(0x815), Fallout4Release.Fallout4) { EditorID = "Leveled", Level = new NpcLevel { Level = 5 } })),
            ["a book teaching a spell"] = ("book", TextOf(new Book(KeyOf(0x816), Fallout4Release.Fallout4) { EditorID = "Book", Teaches = new BookSpell() })),
            ["a color of a remapping index"] = ("clfm", TextOf(new ColorRecord(KeyOf(0x817), Fallout4Release.Fallout4) { EditorID = "Color", Data = new ColorRemappingIndex { Index = 2.5f } })),
            ["a holotape program"] = ("note", TextOf(new Holotape(KeyOf(0x818), Fallout4Release.Fallout4) { EditorID = "Holotape", Data = new HolotapeProgram { File = "startup.txt" } })),
            ["a sound descriptor of standard data"] = ("sndr", TextOf(new SoundDescriptor(KeyOf(0x819), Fallout4Release.Fallout4) { EditorID = "Sound", Data = new SoundDescriptorStandardData { Priority = 3 } })),
            ["a perk of a quest effect"] = ("perk", TextOf(new Perk(KeyOf(0x81A), Fallout4Release.Fallout4) { EditorID = "Perk", Effects = [new PerkQuestEffect { Stage = 7 }] })),
            ["a magic effect of a light archetype"] = ("mgef", TextOf(new MagicEffect(KeyOf(0x81B), Fallout4Release.Fallout4) { EditorID = "Effect", Archetype = new MagicEffectLightArchetype() })),
            ["an audio effect chain of an overdrive"] = ("aech", TextOf(new AudioEffectChain(KeyOf(0x81C), Fallout4Release.Fallout4) { EditorID = "Chain", Effects = [new OverdriveAudioEffect { Enabled = true, InputGain = 1f }] })),
            ["a quest of fragments and an alias script"] = ("qust", TextOf(QuestOfFragmentsAndAnAliasScript())),
            ["a perk of fragments out of key order"] = ("perk", TextOf(PerkOfFragmentsOutOfKeyOrder())),
            ["a scene of phase fragments out of key order"] = ("scen", TextOf(SceneOfPhaseFragmentsOutOfKeyOrder())),
        };
    }

    private FormKey KeyOf(uint id) => new(_mod.ModKey, id);

    private static string TextOf(IMajorRecordGetter record) => RecordTextCodec.SerializeToText(record, GameRelease.Fallout4);

    private string NpcText() => TextOf(_npc);

    private string CobjText() => TextOf(_cobj);

    private string HeaderText() => Encoding.UTF8.GetString(HeaderDocument.Write(_mod));

    private Npc NpcInAFaction()
    {
        var npc = new Npc(KeyOf(0x801), Fallout4Release.Fallout4) { EditorID = "Guy" };
        npc.Factions.Add(new RankPlacement { Faction = new FormLink<IFactionGetter>(KeyOf(0x80C)), Rank = 1 });
        return npc;
    }

    private ArmorModification ArmorModWith(uint id, params AObjectModProperty<Armor.Property>[] properties)
    {
        var armor = new ArmorModification(KeyOf(id), Fallout4Release.Fallout4) { EditorID = $"ArmorMod{id:X}" };
        armor.Properties.AddRange(properties);
        return armor;
    }

    private Race RaceOfTwoSubgraphs()
    {
        var race = new Race(KeyOf(0x803), Fallout4Release.Fallout4) { EditorID = "Race" };
        race.MovementTypeNames.Add("Walk");
        race.Subgraphs.Add(new Subgraph { Role = Subgraph.SubgraphRole.MT, BehaviorGraph = "graph\\zero", AnimationPaths = { "Actors\\Zero" } });
        race.Subgraphs.Add(new Subgraph { Role = Subgraph.SubgraphRole.Weapon, BehaviorGraph = "graph\\one", AnimationPaths = { "Actors\\OneA", "Actors\\OneB" } });
        return race;
    }

    private MaterialObject MaterialObjectOfOneSlice()
    {
        var material = new MaterialObject(KeyOf(0x806), Fallout4Release.Fallout4) { EditorID = "Mato" };
        material.DNAMs.Add(new MemorySlice<byte>([0x01, 0x02]));
        return material;
    }

    private Faction FactionWithAVendorLocation() => new(KeyOf(0x807), Fallout4Release.Fallout4)
    {
        EditorID = "Faction",
        VendorLocation = new LocationTargetRadius
        {
            Radius = 1,
            Target = new LocationFallback { Type = LocationTargetRadius.LocationType.NearReference },
        },
    };

    private Npc NpcWithARemovedScriptProperty() => new(KeyOf(0x808), Fallout4Release.Fallout4)
    {
        EditorID = "Scripted",
        VirtualMachineAdapter = new VirtualMachineAdapter
        {
            Version = 6,
            ObjectFormat = 2,
            Scripts = [new ScriptEntry { Name = "TestScript", Properties = [new ScriptIntProperty { Name = "Switched", Flags = ScriptProperty.Flag.Removed, Data = 42 }] }],
        },
    };

    private Debris DebrisOfTwoModels()
    {
        var debris = new Debris(KeyOf(0x809), Fallout4Release.Fallout4) { EditorID = "Debris" };
        debris.Models.Add(new DebrisModel { Percentage = 50, ModelFilename = "First.nif", TextureFileHashes = new MemorySlice<byte>([0x11, 0x22]) });
        debris.Models.Add(new DebrisModel { Percentage = 50, ModelFilename = "Second.nif", TextureFileHashes = new MemorySlice<byte>([0xAA, 0xBB, 0xCC, 0xDD]) });
        return debris;
    }

    private Npc NpcOfScriptsOutOfKeyOrder()
    {
        var alpha = new ScriptEntry { Name = "Alpha", Flags = ScriptEntry.Flag.Local };
        var tags = new ScriptStringListProperty { Name = "Tags", Flags = ScriptProperty.Flag.Edited };
        tags.Data.Add("a");
        tags.Data.Add("b");
        alpha.Properties.Add(tags);
        alpha.Properties.Add(new ScriptIntProperty { Name = "Count", Flags = ScriptProperty.Flag.Edited, Data = 1 });
        var config = new ScriptStructProperty { Name = "Config", Flags = ScriptProperty.Flag.Edited };
        var member = new ScriptEntry();
        member.Properties.Add(new ScriptIntProperty { Name = "Level", Flags = ScriptProperty.Flag.Edited, Data = 3 });
        config.Members.Add(member);
        alpha.Properties.Add(config);

        var adapter = new VirtualMachineAdapter { Version = 6, ObjectFormat = 2 };
        adapter.Scripts.Add(new ScriptEntry { Name = "Beta", Flags = ScriptEntry.Flag.Local });
        adapter.Scripts.Add(alpha);
        return new Npc(KeyOf(0x810), Fallout4Release.Fallout4) { EditorID = "Npc", VirtualMachineAdapter = adapter };
    }

    private Npc NpcOfScriptsAnotherToolWrote()
    {
        var adapter = new VirtualMachineAdapter { Version = 6, ObjectFormat = 2 };
        adapter.Scripts.Add(ScriptOfCounts("Lead", 1));
        adapter.Scripts.Add(ScriptOfCounts("Holder", 1, 2));
        adapter.Scripts.Add(ScriptOfCounts("Tail", 1));
        return new Npc(KeyOf(0x811), Fallout4Release.Fallout4) { EditorID = "Twins", VirtualMachineAdapter = adapter };

        static ScriptEntry ScriptOfCounts(string name, params int[] counts)
        {
            var script = new ScriptEntry { Name = name, Flags = ScriptEntry.Flag.Local };
            script.Properties.AddRange(counts.Select(count => new ScriptIntProperty { Name = "Count", Flags = ScriptProperty.Flag.Edited, Data = count }));
            return script;
        }
    }

    private Quest QuestOfFragmentsAndAnAliasScript()
    {
        var questAdapter = new QuestAdapter { Version = 6, ObjectFormat = 2, Script = new ScriptEntry { Name = "QuestScript" } };
        questAdapter.Fragments.Add(new QuestScriptFragment { Stage = 10, StageIndex = 0, ScriptName = "Ten", FragmentName = "Frag10" });
        questAdapter.Fragments.Add(new QuestScriptFragment { Stage = 5, StageIndex = 1, ScriptName = "Five", FragmentName = "Frag5" });
        var alias = new QuestFragmentAlias { Version = 6, ObjectFormat = 2 };
        alias.Property.Alias = 0;
        var aliasScript = new ScriptEntry { Name = "AliasScript", Flags = ScriptEntry.Flag.Local };
        aliasScript.Properties.Add(new ScriptIntProperty { Name = "Level", Data = 1 });
        alias.Scripts.Add(aliasScript);
        questAdapter.Aliases.Add(alias);
        return new Quest(KeyOf(0x812), Fallout4Release.Fallout4) { EditorID = "Quest", VirtualMachineAdapter = questAdapter };
    }

    private Perk PerkOfFragmentsOutOfKeyOrder()
    {
        var fragments = new PerkScriptFragments();
        fragments.Fragments.Add(new PerkScriptFragment { Index = 2, ScriptName = "Two", FragmentName = "Frag2" });
        fragments.Fragments.Add(new PerkScriptFragment { Index = 1, ScriptName = "One", FragmentName = "Frag1" });
        return new Perk(KeyOf(0x813), Fallout4Release.Fallout4) { EditorID = "Perk", VirtualMachineAdapter = new PerkAdapter { Version = 6, ObjectFormat = 2, ScriptFragments = fragments } };
    }

    private Scene SceneOfPhaseFragmentsOutOfKeyOrder()
    {
        var fragments = new SceneScriptFragments();
        fragments.PhaseFragments.Add(new ScenePhaseFragment { Index = 1, Flags = ScenePhaseFragment.Flag.OnStart, ScriptName = "OneStart", FragmentName = "F1S" });
        fragments.PhaseFragments.Add(new ScenePhaseFragment { Index = 0, Flags = ScenePhaseFragment.Flag.OnCompletion, ScriptName = "ZeroEnd", FragmentName = "F0E" });
        fragments.PhaseFragments.Add(new ScenePhaseFragment { Index = 1, Flags = ScenePhaseFragment.Flag.OnCompletion, ScriptName = "OneEnd", FragmentName = "F1E" });
        return new Scene(KeyOf(0x814), Fallout4Release.Fallout4) { EditorID = "Scene", VirtualMachineAdapter = new SceneAdapter { Version = 6, ObjectFormat = 2, ScriptFragments = fragments } };
    }

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

    private static List<int> HolderCounts(string document) =>
        [.. Node(document, "VirtualMachineAdapter.Scripts").AsArray()
            .First(s => s.Require()["Name"].Require().GetValue<string>() == "Holder").Require()["Properties"].Require().AsArray()
            .Select(p => p.Require()["Data"].Require().GetValue<int>())];

    private string EditedRecord(string record, EditOp op, string path, string? value)
    {
        var (table, text) = _records[record];
        return Edited(text, table, op, value, Path(path));
    }

    private List<string> Changed(string record, EditOp op, string path, string? value) =>
        DocumentDiffs.Of(_records[record].Text, EditedRecord(record, op, path, value));

    [Theory]
    [InlineData("the npc", EditOp.Set, "HeightMax", "0.75", new[] { "HeightMax: 1.0 -> 0.75" })]
    [InlineData("the npc", EditOp.Set, "Weight.Thin", "0.5", new[] { """Weight: <absent> -> {"Thin":0.5}""" })]
    [InlineData("the recipe", EditOp.Set, "Conditions[0].CompareOperator", "\"LessThan\"", new[] { """Conditions[0].CompareOperator: "GreaterThan" -> "LessThan" """ })]
    [InlineData("the npc", EditOp.Set, "VirtualMachineAdapter.Scripts[0].Properties[0].Data", "9", new[] { "VirtualMachineAdapter.Scripts[0].Properties[0].Data: 1 -> 9" })]
    [InlineData("the npc", EditOp.Set, "HeightMax", "null", new[] { "HeightMax: 1.0 -> <absent>" })]
    [InlineData(
        "the recipe", EditOp.Set, "Conditions[0].MutagenObjectType", "\"ConditionGlobal\"",
        new[] { """Conditions[0].MutagenObjectType: "ConditionFloat" -> "ConditionGlobal" """, "Conditions[0].ComparisonValue: 2.5 -> <absent>" })]
    [InlineData(
        "a magic effect with a cloak archetype", EditOp.Set, "Archetype.MutagenObjectType", "\"MagicEffectLightArchetype\"",
        new[] { """Archetype.MutagenObjectType: "MagicEffectCloakArchetype" -> "MagicEffectLightArchetype" """, """Archetype.Association: "000802:DocEdit.esp" -> <absent>""" })]
    [InlineData("the int global", EditOp.Set, "MutagenObjectType", "\"GlobalShort\"", new[] { """MutagenObjectType: "GlobalInt" -> "GlobalShort" """ })]
    [InlineData(
        "the recipe", EditOp.Set, "Conditions[1].Data.RunOnType", "\"Subject\"",
        new[] { """Conditions[1].Data.RunOnType: "Reference" -> <absent>""", """Conditions[1].Data.Reference: "000804:DocEdit.esp" -> <absent>""" })]
    [InlineData("the recipe", EditOp.Set, "Conditions[0].Unknown1", "\"0x0a0b0c\"", new[] { """Conditions[0].Unknown1: "0x000000" -> "0x0A0B0C" """ })]
    [InlineData("the keyword", EditOp.Set, "Color", "\"#FF102030\"", new[] { """Color: <absent> -> "#102030" """ })]
    [InlineData("a weather", EditOp.Set, "LightningColor", "\"#102030\"", new[] { """LightningColor: <absent> -> "#00102030" """ })]
    [InlineData("a weather", EditOp.Set, "LightningColor", "\"#00102030\"", new[] { """LightningColor: <absent> -> "#00102030" """ })]
    [InlineData("an npc in a faction", EditOp.Set, "Keywords", """["00080B:DocEdit.esp"]""", new[] { """Keywords: <absent> -> ["00080B:DocEdit.esp"]""" })]
    [InlineData(
        "a quest with a location alias", EditOp.Set, "Aliases", """[{"MutagenObjectType": "QuestCollectionAlias"}]""",
        new[] { """Aliases[0].MutagenObjectType: "QuestLocationAlias" -> "QuestCollectionAlias" """, """Aliases[0].Name: "OriginalLoc" -> <absent>""" })]
    [InlineData("an npc in a faction", EditOp.Set, "Weight", """{"Thin":0.5,"Fat":0.25,"Muscular":0.75}""", new[] { """Weight: <absent> -> {"Thin":0.5,"Muscular":0.75,"Fat":0.25}""" })]
    [InlineData("an npc in a faction", EditOp.Set, "Factions", """[{"Faction":"00080C:DocEdit.esp","Rank":9}]""", new[] { "Factions[0].Rank: 1 -> 9" })]
    [InlineData(
        "an armor mod", EditOp.Set, "Properties", """[{"MutagenObjectType":"ObjectModIntProperty<Armor+Property>","Property":"BodyPart","Step":1.0,"Value":42,"Value2":7,"FunctionType":"Set"}]""",
        new[] { "Properties[0].Value: <absent> -> 42", "Properties[0].Value2: <absent> -> 7" })]
    [InlineData(
        "an armor mod", EditOp.Set, "Properties", """[{"MutagenObjectType":"ObjectModFloatProperty<Armor+Property>","Property":"Weight","Step":2.0,"Value":1.5,"Value2":2.5,"FunctionType":"Set"}]""",
        new[]
        {
            """Properties[0].MutagenObjectType: "ObjectModIntProperty<Armor+Property>" -> "ObjectModFloatProperty<Armor+Property>" """,
            """Properties[0].Property: "BodyPart" -> "Weight" """,
            "Properties[0].Step: 1.0 -> 2.0",
            "Properties[0].Value: <absent> -> 1.5",
            "Properties[0].Value2: <absent> -> 2.5",
        })]
    [InlineData(
        "an armor mod of two properties", EditOp.Set, "Properties",
        """[{"MutagenObjectType":"ObjectModFloatProperty<Armor+Property>","Property":"Weight","Step":2.0,"Value":1.5,"Value2":2.5,"FunctionType":"Set"},{"MutagenObjectType":"ObjectModIntProperty<Armor+Property>","Property":"BodyPart","Step":1.0,"Value":5,"Value2":6,"FunctionType":"Set"}]""",
        new[]
        {
            """Properties[0].MutagenObjectType: "ObjectModIntProperty<Armor+Property>" -> "ObjectModFloatProperty<Armor+Property>" """,
            """Properties[0].Property: "BodyPart" -> "Weight" """,
            "Properties[0].Step: 1.0 -> 2.0",
            "Properties[0].Value: 5 -> 1.5",
            "Properties[0].Value2: 6 -> 2.5",
            """Properties[1].MutagenObjectType: "ObjectModFloatProperty<Armor+Property>" -> "ObjectModIntProperty<Armor+Property>" """,
            """Properties[1].Property: "Weight" -> "BodyPart" """,
            "Properties[1].Step: 2.0 -> 1.0",
            "Properties[1].Value: 1.5 -> 5",
            "Properties[1].Value2: 2.5 -> 6",
        })]
    [InlineData(
        "an armor mod of two properties", EditOp.Set, "Properties",
        """[{"MutagenObjectType":"ObjectModIntProperty<Armor+Property>","Property":"BodyPart","Step":1.0,"Value":5,"Value2":6,"FunctionType":"Set"},{"MutagenObjectType":"ObjectModBoolProperty<Armor+Property>","Property":"Value","Step":3.0,"Value":true,"FunctionType":"Set"}]""",
        new[]
        {
            """Properties[1].MutagenObjectType: "ObjectModFloatProperty<Armor+Property>" -> "ObjectModBoolProperty<Armor+Property>" """,
            """Properties[1].Property: "Weight" -> "Value" """,
            "Properties[1].Step: 2.0 -> 3.0",
            "Properties[1].Value: 1.5 -> true",
            "Properties[1].Value2: 2.5 -> <absent>",
        })]
    [InlineData(
        "an armor mod of two properties", EditOp.Set, "Properties", """[{"MutagenObjectType":"ObjectModIntProperty<Armor+Property>","Property":"BodyPart","Step":1.0,"Value":5,"Value2":6,"FunctionType":"Set"}]""",
        new[] { """Properties[1]: {"MutagenObjectType":"ObjectModFloatProperty<Armor+Property>","Property":"Weight","Step":2.0,"Value":1.5,"Value2":2.5} -> <absent>""" })]
    [InlineData(
        "a race", EditOp.Set, "Subgraphs", """[{"Role": "MT", "BehaviorGraph": "graph\\zero", "AnimationPaths": ["Actors\\Edited", "Actors\\Added"]}, {"Role": "Weapon", "BehaviorGraph": "graph\\one", "AnimationPaths": ["Actors\\OneA", "Actors\\OneB"]}]""",
        new[] { """Subgraphs[0].AnimationPaths[0]: "Actors\\Zero" -> "Actors\\Edited" """, """Subgraphs[0].AnimationPaths[1]: <absent> -> "Actors\\Added" """ })]
    [InlineData(
        "a race", EditOp.Set, "Subgraphs", """[{"Role": "MT"}, {"Role": "Weapon"}]""",
        new[]
        {
            """Subgraphs[0].BehaviorGraph: "graph\\zero" -> <absent>""",
            """Subgraphs[0].AnimationPaths: ["Actors\\Zero"] -> <absent>""",
            """Subgraphs[1].BehaviorGraph: "graph\\one" -> <absent>""",
            """Subgraphs[1].AnimationPaths: ["Actors\\OneA","Actors\\OneB"] -> <absent>""",
        })]
    [InlineData(
        "a race", EditOp.Set, "Subgraphs", """[{"Role": "MT", "AnimationPaths": []}, {"Role": "Weapon", "AnimationPaths": ["Actors\\OneA", "Actors\\OneB"]}]""",
        new[]
        {
            """Subgraphs[0].BehaviorGraph: "graph\\zero" -> <absent>""",
            """Subgraphs[0].AnimationPaths: ["Actors\\Zero"] -> <absent>""",
            """Subgraphs[1].BehaviorGraph: "graph\\one" -> <absent>""",
        })]
    [InlineData("a race", EditOp.Set, "MovementTypeNames", """["Sneak", "Sprint"]""", new[] { """MovementTypeNames[0]: "Walk" -> "Sneak" """, """MovementTypeNames[1]: <absent> -> "Sprint" """ })]
    [InlineData("a race", EditOp.Add, "Subgraphs[0].AnimationPaths", null, new[] { """Subgraphs[0].AnimationPaths[1]: <absent> -> "" """ })]
    [InlineData("a misc item", EditOp.Set, "ComponentDisplayIndices", "[3, 7]", new[] { "ComponentDisplayIndices[0]: 1 -> 3", "ComponentDisplayIndices[1]: <absent> -> 7" })]
    [InlineData("a scene collection", EditOp.Set, "XNAMs", "[8589934591, -4294967296]", new[] { "XNAMs[0]: 1 -> 8589934591", "XNAMs[1]: <absent> -> -4294967296" })]
    [InlineData("a material object", EditOp.Set, "DNAMs", """["0xAABB", "[]"]""", new[] { """DNAMs[0]: "0x0102" -> "0xAABB" """, """DNAMs[1]: <absent> -> "[]" """ })]
    [InlineData("a material object", EditOp.Add, "DNAMs", null, new[] { """DNAMs[1]: <absent> -> "[]" """ })]
    [InlineData(
        "a faction with a vendor location", EditOp.Set, "VendorLocation", """{"Radius": 99, "CollectionIndex": 2}""",
        new[] { "VendorLocation.Radius: 1 -> 99", "VendorLocation.CollectionIndex: <absent> -> 2" })]
    [InlineData(
        "an npc with a removed script property", EditOp.Set, "VirtualMachineAdapter.Scripts[0].Properties[0].MutagenObjectType", "\"ScriptProperty\"",
        new[]
        {
            """VirtualMachineAdapter.Scripts[0].Properties[0].MutagenObjectType: "ScriptIntProperty" -> "ScriptProperty" """,
            "VirtualMachineAdapter.Scripts[0].Properties[0].Data: 42 -> <absent>",
        })]
    [InlineData(
        "a debris of two models", EditOp.Remove, "Models[0]", null,
        new[]
        {
            """Models[0].ModelFilename: "First.nif" -> "Second.nif" """,
            """Models[0].TextureFileHashes: "0x1122" -> "0xAABBCCDD" """,
            """Models[1]: {"Percentage":50,"ModelFilename":"Second.nif","TextureFileHashes":"0xAABBCCDD"} -> <absent>""",
        })]
    [InlineData(
        "a debris of two models", EditOp.Move, "Models[1]", "0",
        new[]
        {
            """Models[0].ModelFilename: "First.nif" -> "Second.nif" """,
            """Models[0].TextureFileHashes: "0x1122" -> "0xAABBCCDD" """,
            """Models[1].ModelFilename: "Second.nif" -> "First.nif" """,
            """Models[1].TextureFileHashes: "0xAABBCCDD" -> "0x1122" """,
        })]
    [InlineData(
        "an npc of scripts out of key order", EditOp.Move, "VirtualMachineAdapter.Scripts[1].Properties[0].Data[1]", "0",
        new[]
        {
            """VirtualMachineAdapter.Scripts[1].Properties[0].Data[0]: "a" -> "b" """,
            """VirtualMachineAdapter.Scripts[1].Properties[0].Data[1]: "b" -> "a" """,
        })]
    public void AnEdit_ChangesExactlyWhatItNames(string record, EditOp op, string path, string? value, string[] changes)
    {
        Assert.Equal(changes.Select(change => change.TrimEnd()), Changed(record, op, path, value));
    }

    [Theory]
    [InlineData("an npc of a fixed level", "Level", """{"MutagenObjectType": "NpcLevel", "Level": 20}""", "Level", "20")]
    [InlineData("an npc of a fixed level", "Level", """{"MutagenObjectType": "PcLevelMult", "LevelMult": 1.5}""", "LevelMult", "1.5")]
    [InlineData("a quest with a location alias", "Aliases", """[{"MutagenObjectType": "QuestReferenceAlias", "Name": "NewRef", "ClosestToAlias": 4}]""", "0.ClosestToAlias", "4")]
    [InlineData("a quest with a location alias", "Aliases", """[{"MutagenObjectType": "QuestReferenceAlias", "Name": "NewRef", "ClosestToAlias": 4, "Location": {"AliasID": 9}}]""", "0.Location.AliasID", "9")]
    [InlineData("a book teaching a spell", "Teaches", """{"MutagenObjectType": "BookPerk", "Perk": "000901:DocEdit.esp"}""", "Perk", "\"000901:DocEdit.esp\"")]
    [InlineData("a color of a remapping index", "Data", """{"MutagenObjectType": "ColorRemappingIndex", "Index": 7.5}""", "Index", "7.5")]
    [InlineData("a color of a remapping index", "Data", """{"MutagenObjectType": "ColorData", "Color": "#112233"}""", "MutagenObjectType", "\"ColorData\"")]
    [InlineData("a holotape program", "Data", """{"MutagenObjectType": "HolotapeSound", "Sound": "000902:DocEdit.esp"}""", "Sound", "\"000902:DocEdit.esp\"")]
    [InlineData("a sound descriptor of standard data", "Data", """{"MutagenObjectType": "SoundDescriptorStandardData", "PercentFrequencyShift": 5, "PercentFrequencyVariance": 9, "Priority": 20, "Variance": 30, "StaticAttenuation": 2.5}""", "StaticAttenuation", "2.5")]
    [InlineData("a sound descriptor of standard data", "Data", """{"MutagenObjectType": "SoundDescriptorCompoundData"}""", "MutagenObjectType", "\"SoundDescriptorCompoundData\"")]
    [InlineData("a perk of a quest effect", "Effects", """[{"MutagenObjectType": "PerkAbilityEffect", "Ability": "000903:DocEdit.esp"}]""", "0.Ability", "\"000903:DocEdit.esp\"")]
    [InlineData("a perk of a quest effect", "Effects", """[{"MutagenObjectType": "PerkEntryPointAddRangeToValue", "From": 1.5, "To": 9.5}]""", "0.To", "9.5")]
    [InlineData("a magic effect of a light archetype", "Archetype", """{"MutagenObjectType": "MagicEffectPeakValueModArchetype", "Association": "000904:DocEdit.esp"}""", "Association", "\"000904:DocEdit.esp\"")]
    [InlineData("a magic effect of a light archetype", "Archetype", """{"MutagenObjectType": "MagicEffectPeakValueModArchetype", "Association": "000904:DocEdit.esp", "ActorValue": "000905:DocEdit.esp"}""", "ActorValue", "\"000905:DocEdit.esp\"")]
    [InlineData("a magic effect of a light archetype", "Archetype", """{"MutagenObjectType": "MagicEffectArchetype", "Type": "ValueModifier", "Association": "000905:DocEdit.esp"}""", "Association", "\"000905:DocEdit.esp\"")]
    [InlineData("an audio effect chain of an overdrive", "Effects", """[{"MutagenObjectType": "StateVariableFilterAudioEffect", "Enabled": true, "CenterFrequency": 440.0, "QValue": 0.75}]""", "0.QValue", "0.75")]
    [InlineData("a faction with a vendor location", "VendorLocation", """{"Radius": 99, "Target": {"MutagenObjectType": "LocationFallback", "Type": "NearSelf", "Data": 3}}""", "Target.Data", "3")]
    public void AUnionSetToAnotherLeaf_IsWrittenAsThatLeaf_HoldingWhatTheValueGives(string record, string member, string value, string at, string held)
    {
        var written = at.Split('.').Aggregate(Node(EditedRecord(record, EditOp.Set, member, value), member), Step);

        Assert.Equal(held, written.ToJsonString());
    }

    [Theory]
    [InlineData("an npc of scripts out of key order")]
    [InlineData("a quest of fragments and an alias script")]
    [InlineData("a perk of fragments out of key order")]
    [InlineData("a scene of phase fragments out of key order")]
    public void ResendingAnAdapterHeldOutOfKeyOrder_WritesItBackUnchanged(string record)
    {
        var adapter = Node(_records[record].Text, "VirtualMachineAdapter").ToJsonString();

        Assert.Empty(Changed(record, EditOp.Set, "VirtualMachineAdapter", adapter));
    }

    [Theory]
    [InlineData("an npc of scripts out of key order", "Scripts.1.Name", "\"Zulu\"", """VirtualMachineAdapter.Scripts[1].Name: "Alpha" -> "Zulu" """)]
    [InlineData("an npc of scripts out of key order", "Scripts.1.Properties.1.Data", "42", "VirtualMachineAdapter.Scripts[1].Properties[1].Data: 1 -> 42")]
    [InlineData("an npc of scripts out of key order", "Scripts.1.Properties.2.Members.0.Properties.0.Data", "9", "VirtualMachineAdapter.Scripts[1].Properties[2].Members[0].Properties[0].Data: 3 -> 9")]
    [InlineData("a quest of fragments and an alias script", "Aliases.0.Scripts.0.Properties.0.Data", "7", "VirtualMachineAdapter.Aliases[0].Scripts[0].Properties[0].Data: 1 -> 7")]
    [InlineData("a quest of fragments and an alias script", "Fragments.0.ScriptName", "\"Renamed\"", """VirtualMachineAdapter.Fragments[0].ScriptName: "Ten" -> "Renamed" """)]
    [InlineData("a perk of fragments out of key order", "ScriptFragments.Fragments.0.ScriptName", "\"Renamed\"", """VirtualMachineAdapter.ScriptFragments.Fragments[0].ScriptName: "Two" -> "Renamed" """)]
    [InlineData("a scene of phase fragments out of key order", "ScriptFragments.PhaseFragments.0.FragmentName", "\"Renamed\"", """VirtualMachineAdapter.ScriptFragments.PhaseFragments[0].FragmentName: "F1S" -> "Renamed" """)]
    public void ResendingAnAdapterWithOneMemberChanged_ChangesThatMemberAndNothingElse(string record, string at, string replacement, string change)
    {
        var adapter = Node(_records[record].Text, "VirtualMachineAdapter");
        var hops = at.Split('.');
        hops[..^1].Aggregate(adapter, Step)[hops[^1]] = JsonNode.Parse(replacement);

        Assert.Equal([change.TrimEnd()], Changed(record, EditOp.Set, "VirtualMachineAdapter", adapter.ToJsonString()));
    }

    private static JsonNode Step(JsonNode node, string hop) => (int.TryParse(hop, out var index) ? node[index] : node[hop]).Require();

    [Fact]
    public void RemovingTheLastPropertyOfAnAliasScript_LeavesItsPropertiesAbsent()
    {
        var after = EditedRecord("a quest of fragments and an alias script", EditOp.Remove, "VirtualMachineAdapter.Aliases[0].Scripts[0].Properties[0]", null);

        Assert.Equal("""[{"Property":{"Name":"","Alias":0},"Scripts":[{"Name":"AliasScript"}]}]""", Node(after, "VirtualMachineAdapter.Aliases").ToJsonString());
    }

    [Fact]
    public void NullingAStructTheRecordAlwaysCarries_LeavesItEmpty_AndTouchesNothingElse()
    {
        var changes = Changed("a quest of fragments and an alias script", EditOp.Set, "VirtualMachineAdapter.Script", "null");

        Assert.Equal(["VirtualMachineAdapter.Script.Name: \"QuestScript\" -> \"\""], changes);
    }

    [Fact]
    public void RenamingAScriptToTheNameAnotherHolds_IsWritten()
    {
        var after = EditedRecord("an npc of scripts another tool wrote", EditOp.Set, "VirtualMachineAdapter.Scripts[0].Name", "\"Holder\"");

        Assert.Equal(["Holder", "Holder", "Tail"], ScriptNames(after));
    }

    [Theory]
    [InlineData(0, new[] { 5, 2 })]
    [InlineData(1, new[] { 1, 5 })]
    public void AnEditToOneOfAPairAnotherToolWrote_ChangesThatOneAlone(int property, int[] written)
    {
        var after = EditedRecord("an npc of scripts another tool wrote", EditOp.Set, $"VirtualMachineAdapter.Scripts[1].Properties[{property}].Data", "5");

        Assert.Equal(written, HolderCounts(after));
    }

    [Theory]
    [InlineData(0, 2)]
    [InlineData(1, 1)]
    public void RemovingOneOfAPairAnotherToolWrote_RemovesThatOne(int property, int kept)
    {
        var after = EditedRecord("an npc of scripts another tool wrote", EditOp.Remove, $"VirtualMachineAdapter.Scripts[1].Properties[{property}]", null);

        Assert.Equal([kept], HolderCounts(after));
    }

    [Fact]
    public void RemovingTheScriptAheadOfAPairAnotherToolWrote_RemovesItAlone()
    {
        var after = EditedRecord("an npc of scripts another tool wrote", EditOp.Remove, "VirtualMachineAdapter.Scripts[0]", null);

        Assert.Equal(["Holder", "Tail"], ScriptNames(after));
    }

    [Fact]
    public void ADiscriminatorSetToALeafTheUnionLacks_FailsNamingTheDiscriminator()
    {
        var failure = Failure(CobjText(), "cobj", EditOp.Set, "\"ConditionMaybe\"", Member("Conditions"), At(0), Member("MutagenObjectType"));

        var notALeaf = Assert.IsType<EditFailure.NotALeaf>(failure);
        Assert.Equal("Conditions[0].MutagenObjectType", notALeaf.Path);
        Assert.Equal("MutagenObjectType", notALeaf.Discriminator.Name);
    }

    [Theory]
    [InlineData("the recipe", EditOp.Add, "Conditions", """{"CompareOperator": "EqualTo"}""", "Conditions[2]")]
    [InlineData("the recipe", EditOp.Add, "Conditions", """{"CompareOperator": "EqualTo", "MutagenObjectType": "ConditionFloat"}""", "Conditions[2]")]
    [InlineData("the recipe", EditOp.Add, "Conditions", """{"MutagenObjectType": "ConditionMaybe"}""", "Conditions[2]")]
    [InlineData("a quest with a location alias", EditOp.Set, "Aliases", """[{"MutagenObjectType": "QuestReferenceAlias", "Name": "NewRef", "Conditions": [{"ComparisonValue": 1.0}]}]""", "Aliases[0].Conditions[0]")]
    [InlineData("an armor mod", EditOp.Set, "Properties", """[{"Property":"BodyPart","Step":1.0,"Value":5,"Value2":6,"FunctionType":"Set"}]""", "Properties[0]")]
    [InlineData("an npc in a faction", EditOp.Set, "Level", """{"Level": 20}""", "Level")]
    [InlineData(
        "an npc in a faction", EditOp.Set, "VirtualMachineAdapter", """{"Scripts": [{"Name": "S", "Properties": [{"Name": "P", "Flags": "Edited", "Data": 1}]}]}""",
        "VirtualMachineAdapter.Scripts[0].Properties[0]")]
    public void AUnionValueNotLeadingWithADiscriminatorNamingALeaf_FailsNamingWhere(string record, EditOp op, string path, string value, string where)
    {
        var (table, text) = _records[record];

        Assert.Equal(where, Assert.IsType<EditFailure.NotALeaf>(Failure(text, table, op, value, Path(path))).Path);
    }

    [Fact]
    public void AddingRemovingAndMovingOnAPositionalArray_ChangeThatArrayAlone()
    {
        var before = NpcText();

        var added = Edited(before, "npc_", EditOp.Add, $"\"{_otherKeyword.FormKey}\"", Member("Keywords"));
        AssertOnlyChanged(before, added, "Keywords[1]");
        Assert.Equal(2, Node(added, "Keywords").AsArray().Count);

        var moved = Edited(added, "npc_", EditOp.Move, "0", Member("Keywords"), At(1));
        Assert.Equal([_otherKeyword.FormKey.ToString(), KeywordFormKey], Node(moved, "Keywords").AsArray().Select(k => k.Require().GetValue<string>()));
        AssertOnlyChanged(added, moved, "Keywords[");

        var removed = Edited(moved, "npc_", EditOp.Remove, null, Member("Keywords"), At(0));
        Assert.Equal([KeywordFormKey], Node(removed, "Keywords").AsArray().Select(k => k.Require().GetValue<string>()));
        AssertOnlyChanged(moved, removed, "Keywords[");
    }

    [Fact]
    public void AnElementAddedToAKeyedArray_IsAppended()
    {
        var before = NpcText();

        var added = Edited(before, "npc_", EditOp.Add, """{"Name": "Aardvark", "Flags": "Local"}""", Member("VirtualMachineAdapter"), Member("Scripts"));

        Assert.Equal(["Alpha", "Beta", "Aardvark"], ScriptNames(added));
        AssertOnlyChanged(before, added, "VirtualMachineAdapter.Scripts[2]");
    }

    [Fact]
    public void ASetOfAKeyMember_LeavesTheElementWhereItIs()
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
    public void AMoveToADestinationOutsideTheArray_FailsNamingThatPosition()
    {
        var failure = Failure(NpcText(), "npc_", EditOp.Move, "3", Member("Keywords"), At(0));

        Assert.Equal(new EditFailure.NoElement("Keywords[3]", 1), failure);
    }

    [Fact]
    public void ASetOfAGoverningMember_IdlesEverySlotTheNewValueDoesNotUse()
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

    [Theory]
    [InlineData("Author", "\"me\"", "ModHeader.Author")]
    [InlineData("Flags", "[\"Master\"]", "ModHeader.Flags")]
    [InlineData("Version", "7", "ModHeader.Version")]
    public void AHeaderMember_IsWrittenAsAnyFieldIs(string member, string value, string written)
    {
        var before = HeaderText();

        var after = Edited(before, PluginHeader.RecordType, EditOp.Set, value, Member(member));

        Assert.Equal(value, Node(after, written).ToJsonString());
        AssertOnlyChanged(before, after, written);
    }

    [Fact]
    public void AnElementAddedAtAKeyAnotherHolds_IsWritten()
    {
        var after = Edited(NpcText(), "npc_", EditOp.Add, """{"Name": "Alpha"}""", Member("VirtualMachineAdapter"), Member("Scripts"));

        Assert.Equal(["Alpha", "Beta", "Alpha"], ScriptNames(after));
    }

    [Theory]
    [InlineData("ABCDEF:Nowhere.esp")]
    [InlineData(KeywordFormKey)]
    public void ALinkToARecordThatIsMissingOrOfAnotherType_Lands(string target)
    {
        var after = Edited(NpcText(), "npc_", EditOp.Set, $"\"{target}\"", Member("Race"));

        Assert.Equal(target, Node(after, "Race").GetValue<string>());
    }

    [Fact]
    public void AColorHoldingNoAlpha_PastedBackAsItsCellCopiesIt_ChangesNothing()
    {
        var weather = _mod.Weather.AddNew("Wt");
        weather.LightningColor = System.Drawing.Color.FromArgb(0, 0x10, 0x20, 0x30);
        var before = TextOf(weather);
        Assert.Equal("#00102030", Node(before, "LightningColor").GetValue<string>());

        var after = Edited(before, "wthr", EditOp.Set, "\"#102030\"", Member("LightningColor"));

        Assert.Equal(before, after);
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

    [Theory]
    [InlineData(false, """{"TargetLanguage":"English","Value":"Old"}""", """{"TargetLanguage":"English","Value":"Nommé"}""")]
    [InlineData(false, null, """{"TargetLanguage":"French","Value":"Nommé"}""")]
    [InlineData(true, """{"TargetLanguage":"French","Value":"Vieux"}""", """{"TargetLanguage":"French","Value":"Nommé"}""")]
    [InlineData(
        true, """{"TargetLanguage":"English","Value":"Old"}""",
        """{"TargetLanguage":"English","Values":[{"Language":"English","String":"Old"},{"Language":"French","String":"Nommé"}]}""")]
    [InlineData(
        true, """{"TargetLanguage":"English","Values":[{"Language":"English","String":"Old"},{"Language":"French","String":"Vieux"}]}""",
        """{"TargetLanguage":"English","Values":[{"Language":"English","String":"Old"},{"Language":"French","String":"Nommé"}]}""")]
    [InlineData(
        true, """{"TargetLanguage":"English","Values":[{"Language":"English","String":"Old"},{"Language":"German","String":"Alt"}]}""",
        """{"TargetLanguage":"English","Values":[{"Language":"English","String":"Old"},{"Language":"German","String":"Alt"},{"Language":"French","String":"Nommé"}]}""")]
    public void TranslatedString_SetToText_IsItsTextInTheStringsLanguageWhereThePluginIsLocalized(bool localized, string? held, string expected)
    {
        var before = JsonNode.Parse(NpcText()).Require().AsObject();
        before["Name"] = held is null ? null : JsonNode.Parse(held);

        var after = Edited(Language.French, localized, before.ToJsonString(), "npc_", EditOp.Set, "\"Nommé\"", Member("Name"));

        Assert.Equal(expected, JsonStrings.AsWritten(Node(after, "Name")));
    }

    [Fact]
    public void Header_IsSmallMaster_WritesTheFlagsMemberAndNothingElse()
    {
        var before = HeaderText();

        var set = Edited(before, PluginHeader.RecordType, EditOp.Set, "true", Member("IsSmallMaster"));
        Assert.True(HeaderDocument.Read(Encoding.UTF8.GetBytes(set), GameRelease.Fallout4).IsSmallMaster);
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
