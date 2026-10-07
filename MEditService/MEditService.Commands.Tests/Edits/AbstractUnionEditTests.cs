using System.Text.Json;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using static MEditService.Commands.Tests.TestSupport.Envelopes;

namespace MEditService.Commands.Tests.Edits;

public sealed class AbstractUnionEditTests : IDisposable
{
    private readonly AbstractUnionFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    [Fact]
    public void Level_EditingWithinSameConcreteType_RoundTrips()
    {
        var result = _fixture.Service().Set(
            _fixture.Plugin, _fixture.Npc.ToString(), "Level",
            Json("""{"MutagenObjectType": "NpcLevel", "Level": 20}"""));

        Assert.True(result.Applied, result.Message);
        var body = _fixture.NpcBody();
        Assert.Contains("NpcLevel", body, StringComparison.Ordinal);
        Assert.Contains("20", body, StringComparison.Ordinal);
    }

    [Fact]
    public void Level_SwitchingConcreteType_NpcLevelToPcLevelMult_RoundTrips()
    {
        var result = _fixture.Service().Set(
            _fixture.Plugin, _fixture.Npc.ToString(), "Level",
            Json("""{"MutagenObjectType": "PcLevelMult", "LevelMult": 1.5}"""));

        Assert.True(result.Applied, result.Message);
        var body = _fixture.NpcBody();
        Assert.Contains("PcLevelMult", body, StringComparison.Ordinal);
        Assert.DoesNotContain("NpcLevel", body, StringComparison.Ordinal);
    }

    [Fact]
    public void Level_MissingDiscriminator_IsRefused_AndAnswersNoChanges()
    {
        var before = _fixture.NpcBody();

        var result = _fixture.Service().Set(
            _fixture.Plugin, _fixture.Npc.ToString(), "Level", Json("""{"Level": 20}"""));

        Assert.False(result.Applied);
        Assert.Equal(before, _fixture.NpcBody());
    }

    [Fact]
    public void Aliases_WholeArrayWrite_QuestReferenceAliasElement_RoundTrips()
    {
        var result = _fixture.Service().Set(
            _fixture.Plugin, _fixture.Quest.ToString(), "Aliases",
            Json("""[{"MutagenObjectType": "QuestReferenceAlias", "Name": "NewRef", "ClosestToAlias": 4}]"""));

        Assert.True(result.Applied, result.Message);
        var body = _fixture.QuestBody();
        Assert.Contains("QuestReferenceAlias", body, StringComparison.Ordinal);
        Assert.Contains("\"Name\": \"NewRef\"", body, StringComparison.Ordinal);
        Assert.Contains("\"ClosestToAlias\": 4", body, StringComparison.Ordinal);
    }

    [Fact]
    public void Aliases_WholeArrayWrite_QuestReferenceAliasElement_LocationNamedInPayload_RoundTrips()
    {
        var result = _fixture.Service().Set(
            _fixture.Plugin, _fixture.Quest.ToString(), "Aliases",
            Json("""
            [{"MutagenObjectType": "QuestReferenceAlias", "Name": "NewRef", "ClosestToAlias": 4,
              "Location": {"AliasID": 9}}]
            """));

        Assert.True(result.Applied, result.Message);
        var body = _fixture.QuestBody();
        Assert.Contains("\"Name\": \"NewRef\"", body, StringComparison.Ordinal);
        Assert.Contains("\"Location\"", body, StringComparison.Ordinal);
        Assert.Contains("\"AliasID\": 9", body, StringComparison.Ordinal);
    }

    [Fact]
    public void Aliases_WholeArrayWrite_QuestCollectionAliasElement_RoundTrips()
    {
        var result = _fixture.Service().Set(
            _fixture.Plugin, _fixture.Quest.ToString(), "Aliases",
            Json("""[{"MutagenObjectType": "QuestCollectionAlias"}]"""));

        Assert.True(result.Applied, result.Message);
        var body = _fixture.QuestBody();
        Assert.Contains("QuestCollectionAlias", body, StringComparison.Ordinal);
        Assert.DoesNotContain("OriginalLoc", body, StringComparison.Ordinal);
    }

    [Fact]
    public void Aliases_ElementWithUnresolvableNestedConditionElement_IsRefusedAsDiscriminatorInvalid_AndAnswersNoChanges()
    {
        var before = _fixture.QuestBody();

        var result = _fixture.Service().Set(
            _fixture.Plugin, _fixture.Quest.ToString(), "Aliases",
            Json("""
            [{"MutagenObjectType": "QuestReferenceAlias", "Name": "NewRef",
              "Conditions": [{"ComparisonValue": 1.0}]}]
            """));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.DiscriminatorInvalid, result.Refusal);
        Assert.Equal(before, _fixture.QuestBody());
    }

    [Fact]
    public void Aliases_SwitchingElementLeaf_KeepsSharedMembers_DefaultsLeafOnlyOnes_AndLeavesTheRestOfTheDocumentAlone()
    {
        var setUp = _fixture.Service().Set(
            _fixture.Plugin, _fixture.Quest.ToString(), "Aliases", Json("""
            [{"MutagenObjectType": "QuestLocationAlias", "Name": "Switched", "ClosestToAlias": 7, "ID": 1,
              "ReferenceAliasLocation": {"AliasID": 5} },
             {"MutagenObjectType": "QuestReferenceAlias", "Name": "Sibling", "ClosestToAlias": 9, "ID": 2}]
            """));
        Assert.True(setUp.Applied, setUp.Message);
        var before = _fixture.QuestBody();

        var result = _fixture.Service().Edit(
            _fixture.Plugin, _fixture.Quest.ToString(),
            SetAt(Json("\"QuestReferenceAlias\""), Member("Aliases"), At(0), Member("MutagenObjectType")));

        Assert.True(result.Applied, result.Message);
        var after = _fixture.QuestBody();

        var switched = Written(after)[0];
        Assert.Equal("QuestReferenceAlias", switched.GetProperty("MutagenObjectType").GetString());
        Assert.Equal("Switched", switched.GetProperty("Name").GetString());
        Assert.Equal(7, switched.GetProperty("ClosestToAlias").GetInt32());
        Assert.Equal(1, switched.GetProperty("ID").GetInt32());
        Assert.False(switched.TryGetProperty("ReferenceAliasLocation", out _));
        Assert.False(switched.TryGetProperty("Location", out _));

        Assert.Equal(Written(before)[1].GetRawText(), Written(after)[1].GetRawText());
        foreach (var property in JsonDocument.Parse(before).RootElement.EnumerateObject())
        {
            if (property.NameEquals("Aliases")) continue;
            Assert.Equal(
                property.Value.GetRawText(),
                JsonDocument.Parse(after).RootElement.GetProperty(property.Name).GetRawText());
        }
    }

    [Fact]
    public void Aliases_ArrayAdd_AppendsOneElementOfTheUnionsFirstLeaf()
    {
        var result = _fixture.Service().Edit(_fixture.Plugin, _fixture.Quest.ToString(), AddAt(Member("Aliases")));

        Assert.Equal(RecordEditRefusal.None, result.Refusal);
        Assert.True(result.Applied, result.Message);

        var written = Written(_fixture.QuestBody());
        Assert.Equal(2, written.Count);
        Assert.Equal("OriginalLoc", written[0].GetProperty("Name").GetString());
        Assert.Equal(
            SharedSchemaReflector.FirstArrayElementLeaf("qust", "Aliases", "MutagenObjectType"),
            written[1].GetProperty("MutagenObjectType").GetString());
    }

    private static List<JsonElement> Written(string body) =>
        [.. JsonDocument.Parse(body).RootElement.GetProperty("Aliases").EnumerateArray()];

    private sealed class AbstractUnionFixture : TestInstance
    {
        private const string PluginName = "AbstractUnion548.esp";
        private const string Origin = "AbstractUnion548Mod";

        public PluginAddress Plugin { get; }
        public FormKey Npc { get; }
        public FormKey Quest { get; }

        public AbstractUnionFixture()
        {
            var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);

            var npc = new Npc(mod.GetNextFormKey("Npc548"), Fallout4Release.Fallout4)
            {
                EditorID = "Npc548",
                Level = new NpcLevel { Level = 5 },
            };
            mod.Npcs.Add(npc);
            Npc = npc.FormKey;

            var quest = new Quest(mod.GetNextFormKey("Quest548"), Fallout4Release.Fallout4)
            {
                EditorID = "Quest548",
                Aliases = [new QuestLocationAlias { Name = "OriginalLoc" }],
            };
            mod.Quests.Add(quest);
            Quest = quest.FormKey;

            Plugin = Add(mod, Origin);
        }

        public TestEditor Service() => EditHandler;

        public string NpcBody() => TrackedTree.Body(ModFolderOf(Plugin), Plugin, Npc.ToString());
        public string QuestBody() => TrackedTree.Body(ModFolderOf(Plugin), Plugin, Quest.ToString());
    }
}
