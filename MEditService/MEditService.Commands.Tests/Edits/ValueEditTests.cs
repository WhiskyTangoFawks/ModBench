using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;
using static MEditService.Commands.Tests.TestSupport.DocumentEditFixture;
using static MEditService.Commands.Tests.TestSupport.Envelopes;

namespace MEditService.Commands.Tests.Edits;

public sealed class ValueEditTests : IDisposable
{
    private const string Npc = "000801:DocEdit.esp";
    private const string ArmorMod = "000802:DocEdit.esp";
    private const string Race = "000803:DocEdit.esp";
    private const string MiscItem = "000804:DocEdit.esp";
    private const string SceneCollection = "000805:DocEdit.esp";
    private const string MaterialObject = "000806:DocEdit.esp";
    private const string Faction = "000807:DocEdit.esp";
    private const string ScriptedNpc = "000808:DocEdit.esp";
    private const string Debris = "000809:DocEdit.esp";
    private const string TwoPropertyArmorMod = "00080A:DocEdit.esp";
    private const string Keyword = "00080B:DocEdit.esp";
    private const string Quest = "00080D:DocEdit.esp";

    private readonly DocumentEditFixture _fixture = new();

    public ValueEditTests()
    {
        var npc = new Npc(KeyOf(0x801), Fallout4Release.Fallout4) { EditorID = "Guy" };
        npc.Factions.Add(new RankPlacement { Faction = new FormLink<IFactionGetter>(KeyOf(0x80C)), Rank = 1 });
        _fixture.Seed(npc, "npc_");

        _fixture.Seed(ArmorModWith(0x802, new ObjectModIntProperty<Armor.Property> { Property = Armor.Property.BodyPart, Step = 1f }), "omod");
        _fixture.Seed(
            ArmorModWith(
                0x80A,
                new ObjectModIntProperty<Armor.Property> { Property = Armor.Property.BodyPart, Step = 1f, Value = 5, Value2 = 6 },
                new ObjectModFloatProperty<Armor.Property> { Property = Armor.Property.Weight, Step = 2f, Value = 1.5f, Value2 = 2.5f }),
            "omod");

        var race = new Race(KeyOf(0x803), Fallout4Release.Fallout4) { EditorID = "Race" };
        race.MovementTypeNames.Add("Walk");
        race.Subgraphs.Add(new Subgraph { Role = Subgraph.SubgraphRole.MT, BehaviorGraph = "graph\\zero", AnimationPaths = { "Actors\\Zero" } });
        race.Subgraphs.Add(new Subgraph { Role = Subgraph.SubgraphRole.Weapon, BehaviorGraph = "graph\\one", AnimationPaths = { "Actors\\OneA", "Actors\\OneB" } });
        _fixture.Seed(race, "race");

        _fixture.Seed(new MiscItem(KeyOf(0x804), Fallout4Release.Fallout4) { EditorID = "Misc", ComponentDisplayIndices = [1] }, "misc");
        _fixture.Seed(new SceneCollection(KeyOf(0x805), Fallout4Release.Fallout4) { EditorID = "Scco", XNAMs = [1L] }, "scco");

        var material = new MaterialObject(KeyOf(0x806), Fallout4Release.Fallout4) { EditorID = "Mato" };
        material.DNAMs.Add(new MemorySlice<byte>([0x01, 0x02]));
        _fixture.Seed(material, "mato");

        _fixture.Seed(
            new Faction(KeyOf(0x807), Fallout4Release.Fallout4)
            {
                EditorID = "Faction",
                VendorLocation = new LocationTargetRadius
                {
                    Radius = 1,
                    Target = new LocationFallback { Type = LocationTargetRadius.LocationType.NearReference },
                },
            },
            "fact");

        var scripted = new Npc(KeyOf(0x808), Fallout4Release.Fallout4)
        {
            EditorID = "Scripted",
            VirtualMachineAdapter = new VirtualMachineAdapter
            {
                Version = 6,
                ObjectFormat = 2,
                Scripts = [new ScriptEntry { Name = "TestScript", Properties = [new ScriptIntProperty { Name = "Switched", Flags = ScriptProperty.Flag.Removed, Data = 42 }] }],
            },
        };
        _fixture.Seed(scripted, "npc_");

        var debris = new Debris(KeyOf(0x809), Fallout4Release.Fallout4) { EditorID = "Debris" };
        debris.Models.Add(new DebrisModel { Percentage = 50, ModelFilename = "First.nif", TextureFileHashes = new MemorySlice<byte>([0x11, 0x22]) });
        debris.Models.Add(new DebrisModel { Percentage = 50, ModelFilename = "Second.nif", TextureFileHashes = new MemorySlice<byte>([0xAA, 0xBB, 0xCC, 0xDD]) });
        _fixture.Seed(debris, "debr");
        _fixture.Seed(new Quest(KeyOf(0x80D), Fallout4Release.Fallout4) { EditorID = "Quest", Aliases = [new QuestLocationAlias { Name = "OriginalLoc" }] }, "qust");
    }

    public void Dispose() => _fixture.Dispose();

    private static ArmorModification ArmorModWith(uint id, params AObjectModProperty<Armor.Property>[] properties)
    {
        var armor = new ArmorModification(KeyOf(id), Fallout4Release.Fallout4) { EditorID = $"ArmorMod{id:X}" };
        armor.Properties.AddRange(properties);
        return armor;
    }

    [Theory]
    [InlineData(Npc, RecordEditEnvelope.Set, "Keywords", """["00080B:DocEdit.esp"]""", new[] { """Keywords: <absent> -> ["00080B:DocEdit.esp"]""" })]
    [InlineData(Quest, RecordEditEnvelope.Set, "Aliases", """[{"MutagenObjectType": "QuestCollectionAlias"}]""", new[] { """Aliases[0].MutagenObjectType: "QuestLocationAlias" -> "QuestCollectionAlias" """, """Aliases[0].Name: "OriginalLoc" -> <absent>""" })]
    [InlineData(Npc, RecordEditEnvelope.Set, "Weight", """{"Thin":0.5,"Fat":0.25,"Muscular":0.75}""", new[] { """Weight: <absent> -> {"Thin":0.5,"Muscular":0.75,"Fat":0.25}""" })]
    [InlineData(Npc, RecordEditEnvelope.Set, "Factions", """[{"Faction":"00080C:DocEdit.esp","Rank":9}]""", new[] { "Factions[0].Rank: 1 -> 9" })]
    [InlineData(ArmorMod, RecordEditEnvelope.Set, "Properties", """[{"MutagenObjectType":"ObjectModIntProperty<Armor+Property>","Property":"BodyPart","Step":1.0,"Value":42,"Value2":7,"FunctionType":"Set"}]""", new[] { "Properties[0].Value: <absent> -> 42", "Properties[0].Value2: <absent> -> 7" })]
    [InlineData(
        ArmorMod, RecordEditEnvelope.Set, "Properties", """[{"MutagenObjectType":"ObjectModFloatProperty<Armor+Property>","Property":"Weight","Step":2.0,"Value":1.5,"Value2":2.5,"FunctionType":"Set"}]""",
        new[]
        {
            """Properties[0].MutagenObjectType: "ObjectModIntProperty<Armor+Property>" -> "ObjectModFloatProperty<Armor+Property>" """,
            """Properties[0].Property: "BodyPart" -> "Weight" """,
            "Properties[0].Step: 1.0 -> 2.0",
            "Properties[0].Value: <absent> -> 1.5",
            "Properties[0].Value2: <absent> -> 2.5",
        })]
    [InlineData(
        TwoPropertyArmorMod, RecordEditEnvelope.Set, "Properties", """[{"MutagenObjectType":"ObjectModFloatProperty<Armor+Property>","Property":"Weight","Step":2.0,"Value":1.5,"Value2":2.5,"FunctionType":"Set"},{"MutagenObjectType":"ObjectModIntProperty<Armor+Property>","Property":"BodyPart","Step":1.0,"Value":5,"Value2":6,"FunctionType":"Set"}]""",
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
        TwoPropertyArmorMod, RecordEditEnvelope.Set, "Properties", """[{"MutagenObjectType":"ObjectModIntProperty<Armor+Property>","Property":"BodyPart","Step":1.0,"Value":5,"Value2":6,"FunctionType":"Set"},{"MutagenObjectType":"ObjectModBoolProperty<Armor+Property>","Property":"Value","Step":3.0,"Value":true,"FunctionType":"Set"}]""",
        new[]
        {
            """Properties[1].MutagenObjectType: "ObjectModFloatProperty<Armor+Property>" -> "ObjectModBoolProperty<Armor+Property>" """,
            """Properties[1].Property: "Weight" -> "Value" """,
            "Properties[1].Step: 2.0 -> 3.0",
            "Properties[1].Value: 1.5 -> true",
            "Properties[1].Value2: 2.5 -> <absent>",
        })]
    [InlineData(
        TwoPropertyArmorMod, RecordEditEnvelope.Set, "Properties", """[{"MutagenObjectType":"ObjectModIntProperty<Armor+Property>","Property":"BodyPart","Step":1.0,"Value":5,"Value2":6,"FunctionType":"Set"}]""",
        new[] { """Properties[1]: {"MutagenObjectType":"ObjectModFloatProperty<Armor+Property>","Property":"Weight","Step":2.0,"Value":1.5,"Value2":2.5} -> <absent>""" })]
    [InlineData(
        Race, RecordEditEnvelope.Set, "Subgraphs", """[{"Role": "MT", "BehaviorGraph": "graph\\zero", "AnimationPaths": ["Actors\\Edited", "Actors\\Added"]}, {"Role": "Weapon", "BehaviorGraph": "graph\\one", "AnimationPaths": ["Actors\\OneA", "Actors\\OneB"]}]""",
        new[] { """Subgraphs[0].AnimationPaths[0]: "Actors\\Zero" -> "Actors\\Edited" """, """Subgraphs[0].AnimationPaths[1]: <absent> -> "Actors\\Added" """ })]
    [InlineData(
        Race, RecordEditEnvelope.Set, "Subgraphs", """[{"Role": "MT"}, {"Role": "Weapon"}]""",
        new[]
        {
            """Subgraphs[0].BehaviorGraph: "graph\\zero" -> <absent>""",
            """Subgraphs[0].AnimationPaths: ["Actors\\Zero"] -> <absent>""",
            """Subgraphs[1].BehaviorGraph: "graph\\one" -> <absent>""",
            """Subgraphs[1].AnimationPaths: ["Actors\\OneA","Actors\\OneB"] -> <absent>""",
        })]
    [InlineData(
        Race, RecordEditEnvelope.Set, "Subgraphs", """[{"Role": "MT", "AnimationPaths": []}, {"Role": "Weapon", "AnimationPaths": ["Actors\\OneA", "Actors\\OneB"]}]""",
        new[]
        {
            """Subgraphs[0].BehaviorGraph: "graph\\zero" -> <absent>""",
            """Subgraphs[0].AnimationPaths: ["Actors\\Zero"] -> <absent>""",
            """Subgraphs[1].BehaviorGraph: "graph\\one" -> <absent>""",
        })]
    [InlineData(Race, RecordEditEnvelope.Set, "MovementTypeNames", """["Sneak", "Sprint"]""", new[] { """MovementTypeNames[0]: "Walk" -> "Sneak" """, """MovementTypeNames[1]: <absent> -> "Sprint" """ })]
    [InlineData(Race, RecordEditEnvelope.Add, "Subgraphs[0].AnimationPaths", null, new[] { """Subgraphs[0].AnimationPaths[1]: <absent> -> "" """ })]
    [InlineData(MiscItem, RecordEditEnvelope.Set, "ComponentDisplayIndices", "[3, 7]", new[] { "ComponentDisplayIndices[0]: 1 -> 3", "ComponentDisplayIndices[1]: <absent> -> 7" })]
    [InlineData(SceneCollection, RecordEditEnvelope.Set, "XNAMs", "[8589934591, -4294967296]", new[] { "XNAMs[0]: 1 -> 8589934591", "XNAMs[1]: <absent> -> -4294967296" })]
    [InlineData(MaterialObject, RecordEditEnvelope.Set, "DNAMs", """["0xAABB", "[]"]""", new[] { """DNAMs[0]: "0x0102" -> "0xAABB" """, """DNAMs[1]: <absent> -> "[]" """ })]
    [InlineData(MaterialObject, RecordEditEnvelope.Add, "DNAMs", null, new[] { """DNAMs[1]: <absent> -> "[]" """ })]
    [InlineData(Faction, RecordEditEnvelope.Set, "VendorLocation", """{"Radius": 99, "CollectionIndex": 2}""", new[] { "VendorLocation.Radius: 1 -> 99", "VendorLocation.CollectionIndex: <absent> -> 2" })]
    [InlineData(
        ScriptedNpc, RecordEditEnvelope.Set, "VirtualMachineAdapter.Scripts[0].Properties[0].MutagenObjectType", "\"ScriptProperty\"",
        new[]
        {
            """VirtualMachineAdapter.Scripts[0].Properties[0].MutagenObjectType: "ScriptIntProperty" -> "ScriptProperty" """,
            "VirtualMachineAdapter.Scripts[0].Properties[0].Data: 42 -> <absent>",
        })]
    [InlineData(
        Debris, RecordEditEnvelope.Remove, "Models[0]", null,
        new[]
        {
            """Models[0].ModelFilename: "First.nif" -> "Second.nif" """,
            """Models[0].TextureFileHashes: "0x1122" -> "0xAABBCCDD" """,
            """Models[1]: {"Percentage":50,"ModelFilename":"Second.nif","TextureFileHashes":"0xAABBCCDD"} -> <absent>""",
        })]
    [InlineData(
        Debris, RecordEditEnvelope.Move, "Models[1]", "0",
        new[]
        {
            """Models[0].ModelFilename: "First.nif" -> "Second.nif" """,
            """Models[0].TextureFileHashes: "0x1122" -> "0xAABBCCDD" """,
            """Models[1].ModelFilename: "Second.nif" -> "First.nif" """,
            """Models[1].TextureFileHashes: "0xAABBCCDD" -> "0x1122" """,
        })]
    public void AnEdit_ChangesExactlyWhatItNames(string record, string op, string path, string? value, string[] changes)
    {
        Assert.Equal(changes.Select(change => change.TrimEnd()), _fixture.Changed(record, Spelled(op, path, value)));
    }
}
