using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using static MEditService.Commands.Tests.TestSupport.Envelopes;

namespace MEditService.Commands.Tests.Edits;

public sealed class VmadEditTests : IDisposable
{
    private readonly VmadFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private const string Field = "VirtualMachineAdapter";

    private static JsonElement Json(JsonNode value) => JsonDocument.Parse(value.ToJsonString()).RootElement;

    private RecordEditResult Edit(FormKey record, JsonNode value) =>
        _fixture.Service().Set(_fixture.Plugin, record.ToString(), Field, Json(value));

    private RecordEditResult Edit(FormKey record, RecordEditEnvelope envelope) =>
        _fixture.Service().Edit(_fixture.Plugin, record.ToString(), envelope);

    private static PathHop[] Under(params PathHop[] hops) => [Member(Field), .. hops];

    private static JsonArray Scripts(JsonNode adapter) => adapter["Scripts"].Require().AsArray();

    private static JsonNode ScriptNamed(JsonNode adapter, string name) =>
        Scripts(adapter).First(s => s.Require()["Name"].Require().GetValue<string>() == name).Require();

    private static JsonNode PropertyNamed(JsonNode script, string name) =>
        script["Properties"].Require().AsArray().First(p => p.Require()["Name"].Require().GetValue<string>() == name).Require();

    private static List<string> WrittenScriptNames(string body) =>
        [.. JsonNode.Parse(body).Require()["VirtualMachineAdapter"].Require()["Scripts"].Require().AsArray()
            .Select(s => s.Require()["Name"].Require().GetValue<string>())];

    [Theory]
    [InlineData("Npc")]
    [InlineData("Quest")]
    [InlineData("Perk")]
    [InlineData("Scene")]
    public void ResendingAnAdapterHeldOutOfKeyOrder_WritesItBackUnchanged(string record)
    {
        var formKey = record switch
        {
            "Npc" => _fixture.Npc,
            "Quest" => _fixture.Quest,
            "Perk" => _fixture.Perk,
            _ => _fixture.Scene,
        };
        var before = _fixture.Body(formKey);

        var result = Edit(formKey, _fixture.Adapter(formKey));

        Assert.True(result.Applied, result.Message);
        Assert.Equal(before, _fixture.Body(formKey));
    }

    [Fact]
    public void MovingAProperty_IsRefusedNamingItsKeyedArray_AndWritesNothing()
    {
        var before = _fixture.Body(_fixture.Npc);

        var result = Edit(_fixture.Npc, MoveTo(0, Under(Member("Scripts"), At(1), Member("Properties"), At(1))));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.InvalidEnvelope, result.Refusal);
        Assert.Contains("'VirtualMachineAdapter.Scripts[1].Properties' is a keyed array", result.Message, StringComparison.Ordinal);
        Assert.Equal(before, _fixture.Body(_fixture.Npc));
    }

    [Fact]
    public void AddingAScript_AppendsIt_AndTouchesNothingElse()
    {
        var before = _fixture.Body(_fixture.Npc);
        var adapter = _fixture.Adapter(_fixture.Npc);
        Scripts(adapter).Add(new JsonObject { ["Name"] = "Aardvark", ["Flags"] = "Local", ["Properties"] = new JsonArray() });

        var result = Edit(_fixture.Npc, adapter);

        Assert.True(result.Applied, result.Message);
        var after = _fixture.Body(_fixture.Npc);
        Assert.Equal(["Beta", "Alpha", "Aardvark"], WrittenScriptNames(after));
        Assert.All(
            ConditionEditTests.DocumentDiff(before, after),
            d => Assert.StartsWith("VirtualMachineAdapter.Scripts[2]", d, StringComparison.Ordinal));
    }

    [Fact]
    public void RemovingAScript_LeavesTheOtherScriptExactlyAsItWas()
    {
        var before = _fixture.Body(_fixture.Npc);
        var adapter = _fixture.Adapter(_fixture.Npc);
        var kept = ScriptNamed(adapter, "Alpha").ToJsonString();
        adapter["Scripts"] = new JsonArray(JsonNode.Parse(kept));

        var result = Edit(_fixture.Npc, adapter);

        Assert.True(result.Applied, result.Message);
        var after = _fixture.Body(_fixture.Npc);
        Assert.Equal(["Alpha"], WrittenScriptNames(after));
        Assert.Equal(WrittenScripts(before)["Alpha"], WrittenScripts(after)["Alpha"]);
    }

    [Fact]
    public void RenamingAScript_KeepsItsPlace_AndChangesItsNameAlone()
    {
        var before = _fixture.Body(_fixture.Npc);
        var adapter = _fixture.Adapter(_fixture.Npc);
        ScriptNamed(adapter, "Alpha")["Name"] = "Zulu";

        var result = Edit(_fixture.Npc, adapter);

        Assert.True(result.Applied, result.Message);
        Assert.Equal(
            ["VirtualMachineAdapter.Scripts[1].Name: \"Alpha\" -> \"Zulu\""],
            ConditionEditTests.DocumentDiff(before, _fixture.Body(_fixture.Npc)));
    }

    [Fact]
    public void AddingAProperty_AppendsIt()
    {
        var adapter = _fixture.Adapter(_fixture.Npc);
        ScriptNamed(adapter, "Alpha")["Properties"].Require().AsArray().Add(new JsonObject
        {
            ["MutagenObjectType"] = "ScriptFloatProperty",
            ["Name"] = "Amount",
            ["Flags"] = "Edited",
            ["Data"] = 2.5,
        });

        var result = Edit(_fixture.Npc, adapter);

        Assert.True(result.Applied, result.Message);
        Assert.Equal(
            ["Tags", "Count", "Config", "Parts", "Amount"],
            WrittenPropertyNames(_fixture.Body(_fixture.Npc), "Alpha"));
    }

    [Fact]
    public void SwitchingAPropertysDiscriminator_DropsTheOutgoingLeafsMemberOnly()
    {
        var before = _fixture.Body(_fixture.Npc);
        var adapter = _fixture.Adapter(_fixture.Npc);
        var count = PropertyNamed(ScriptNamed(adapter, "Alpha"), "Count");
        count["MutagenObjectType"] = "ScriptStringProperty";
        count["Data"] = "one";

        var result = Edit(_fixture.Npc, adapter);

        Assert.True(result.Applied, result.Message);
        Assert.Equal(
            [
                "VirtualMachineAdapter.Scripts[1].Properties[1].MutagenObjectType: \"ScriptIntProperty\" -> \"ScriptStringProperty\"",
                "VirtualMachineAdapter.Scripts[1].Properties[1].Data: 1 -> \"one\"",
            ],
            ConditionEditTests.DocumentDiff(before, _fixture.Body(_fixture.Npc)));
    }

    [Fact]
    public void EditingAPropertysValue_ChangesThatMemberAndNothingElse()
    {
        var before = _fixture.Body(_fixture.Npc);
        var adapter = _fixture.Adapter(_fixture.Npc);
        PropertyNamed(ScriptNamed(adapter, "Alpha"), "Count")["Data"] = 42;

        var result = Edit(_fixture.Npc, adapter);

        Assert.True(result.Applied, result.Message);
        Assert.Equal(
            ["VirtualMachineAdapter.Scripts[1].Properties[1].Data: 1 -> 42"],
            ConditionEditTests.DocumentDiff(before, _fixture.Body(_fixture.Npc)));
    }

    [Theory]
    [InlineData(RecordEditEnvelope.Add, new[] { "a", "b", "" })]
    [InlineData(RecordEditEnvelope.Remove, new[] { "a" })]
    [InlineData(RecordEditEnvelope.Move, new[] { "b", "a" })]
    public void ScalarArrayPropertyElementOps_RewriteThatArrayAlone(string op, string[] expected)
    {
        var before = _fixture.Body(_fixture.Npc);
        var array = Under(Member("Scripts"), At(1), Member("Properties"), At(0), Member("Data"));
        var envelope = op switch
        {
            RecordEditEnvelope.Add => AddAt(array),
            RecordEditEnvelope.Remove => RemoveAt([.. array, At(1)]),
            _ => MoveTo(0, [.. array, At(1)]),
        };

        var result = Edit(_fixture.Npc, envelope);

        Assert.True(result.Applied, result.Message);
        var tags = WrittenProperty(_fixture.Body(_fixture.Npc), "Alpha", "Tags");
        Assert.Equal(expected, tags["Data"].Require().AsArray().Select(e => e.Require().GetValue<string>()));
        Assert.All(
            ConditionEditTests.DocumentDiff(before, _fixture.Body(_fixture.Npc)),
            d => Assert.StartsWith("VirtualMachineAdapter.Scripts[1].Properties[0].Data[", d, StringComparison.Ordinal));
    }

    [Fact]
    public void EditingAStructMember_ChangesThatMemberAndNothingElse()
    {
        var before = _fixture.Body(_fixture.Npc);
        var adapter = _fixture.Adapter(_fixture.Npc);
        var config = PropertyNamed(ScriptNamed(adapter, "Alpha"), "Config");
        config["Members"].Require()[0].Require()["Properties"].Require()[0].Require()["Data"] = 9;

        var result = Edit(_fixture.Npc, adapter);

        Assert.True(result.Applied, result.Message);
        Assert.Equal(
            ["VirtualMachineAdapter.Scripts[1].Properties[2].Members[0].Properties[0].Data: 3 -> 9"],
            ConditionEditTests.DocumentDiff(before, _fixture.Body(_fixture.Npc)));
    }

    [Fact]
    public void AddingAnArrayOfStructInstance_AppendsIt_LeavingTheExistingOneAlone()
    {
        var before = _fixture.Body(_fixture.Npc);
        var adapter = _fixture.Adapter(_fixture.Npc);
        var parts = PropertyNamed(ScriptNamed(adapter, "Alpha"), "Parts");
        parts["Structs"].Require().AsArray().Add(new JsonObject
        {
            ["Members"] = new JsonArray(new JsonObject
            {
                ["MutagenObjectType"] = "ScriptFloatProperty",
                ["Name"] = "Weight",
                ["Flags"] = "Edited",
                ["Data"] = 4,
            }),
        });

        var result = Edit(_fixture.Npc, adapter);

        Assert.True(result.Applied, result.Message);
        var added = Assert.Single(ConditionEditTests.DocumentDiff(before, _fixture.Body(_fixture.Npc)));
        Assert.StartsWith(
            "VirtualMachineAdapter.Scripts[1].Properties[3].Structs[1]: <absent> -> ",
            added, StringComparison.Ordinal);
        Assert.Contains("\"Weight\"", added, StringComparison.Ordinal);
    }

    [Fact]
    public void EditingAnAliasScriptProperty_ChangesThatMemberAndNothingElse()
    {
        var before = _fixture.Body(_fixture.Quest);
        var adapter = _fixture.Adapter(_fixture.Quest);
        PropertyNamed(adapter["Aliases"].Require()[0].Require()["Scripts"].Require().AsArray()[0].Require(), "Level")["Data"] = 7;

        var result = Edit(_fixture.Quest, adapter);

        Assert.True(result.Applied, result.Message);
        Assert.Equal(
            ["VirtualMachineAdapter.Aliases[0].Scripts[0].Properties[0].Data: 1 -> 7"],
            ConditionEditTests.DocumentDiff(before, _fixture.Body(_fixture.Quest)));
    }

    [Fact]
    public void EditingAFragment_ChangesThatMemberAndNothingElse()
    {
        var before = _fixture.Body(_fixture.Quest);
        var adapter = _fixture.Adapter(_fixture.Quest);
        adapter["Fragments"].Require()[0].Require()["ScriptName"] = "Renamed";

        var result = Edit(_fixture.Quest, adapter);

        Assert.True(result.Applied, result.Message);
        Assert.Equal(
            ["VirtualMachineAdapter.Fragments[0].ScriptName: \"Ten\" -> \"Renamed\""],
            ConditionEditTests.DocumentDiff(before, _fixture.Body(_fixture.Quest)));
    }

    [Fact]
    public void EditingAPerkFragment_ChangesThatMemberAndNothingElse()
    {
        var before = _fixture.Body(_fixture.Perk);
        var adapter = _fixture.Adapter(_fixture.Perk);
        adapter["ScriptFragments"].Require()["Fragments"].Require()[0].Require()["ScriptName"] = "Renamed";

        var result = Edit(_fixture.Perk, adapter);

        Assert.True(result.Applied, result.Message);
        Assert.Equal(
            ["VirtualMachineAdapter.ScriptFragments.Fragments[0].ScriptName: \"Two\" -> \"Renamed\""],
            ConditionEditTests.DocumentDiff(before, _fixture.Body(_fixture.Perk)));
    }

    [Fact]
    public void EditingAScenePhaseFragment_KeysByIndexThenFlag_NotByIndexAlone()
    {
        var before = _fixture.Body(_fixture.Scene);
        var adapter = _fixture.Adapter(_fixture.Scene);
        adapter["ScriptFragments"].Require()["PhaseFragments"].Require()[0].Require()["FragmentName"] = "Renamed";

        var result = Edit(_fixture.Scene, adapter);

        Assert.True(result.Applied, result.Message);
        Assert.Equal(
            ["VirtualMachineAdapter.ScriptFragments.PhaseFragments[0].FragmentName: \"F1S\" -> \"Renamed\""],
            ConditionEditTests.DocumentDiff(before, _fixture.Body(_fixture.Scene)));
    }

    [Fact]
    public void ResendingAnAdapterWhoseNestedStructIsAbsent_LeavesItAbsent()
    {
        var before = _fixture.Body(_fixture.Scene);
        Assert.Null(_fixture.Adapter(_fixture.Scene)["ScriptFragments"].Require()["OnBegin"]);

        var result = Edit(_fixture.Scene, _fixture.Adapter(_fixture.Scene));

        Assert.True(result.Applied, result.Message);
        Assert.Null(_fixture.Adapter(_fixture.Scene)["ScriptFragments"].Require()["OnBegin"]);
        Assert.Equal(before, _fixture.Body(_fixture.Scene));
    }

    [Fact]
    public void RemovingTheLastPropertyOfAnAliasScript_LeavesItsPropertiesAbsent()
    {
        var before = _fixture.Body(_fixture.Quest);

        var result = Edit(_fixture.Quest, RemoveAt(Under(
            Member("Aliases"), At(0), Member("Scripts"), At(0), Member("Properties"), At(0))));

        Assert.True(result.Applied, result.Message);
        var after = _fixture.Body(_fixture.Quest);
        Assert.Equal(
            """[{"Property":{"Name":"","Alias":0},"Scripts":[{"Name":"AliasScript"}]}]""",
            JsonNode.Parse(after).Require()["VirtualMachineAdapter"].Require()["Aliases"].Require().ToJsonString());
        Assert.All(
            ConditionEditTests.DocumentDiff(before, after),
            d => Assert.StartsWith("VirtualMachineAdapter.Aliases[0].Scripts[0].Properties", d, StringComparison.Ordinal));
    }

    [Fact]
    public void NullingAStructTheRecordCarries_ClearsItAndTouchesNothingElse()
    {
        var before = _fixture.Body(_fixture.Quest);
        Assert.NotNull(_fixture.Adapter(_fixture.Quest)["Script"]);

        var result = Edit(_fixture.Quest, Clear(Under(Member("Script"))));

        Assert.True(result.Applied, result.Message);
        var after = _fixture.Body(_fixture.Quest);
        Assert.All(
            ConditionEditTests.DocumentDiff(before, after),
            d => Assert.StartsWith("VirtualMachineAdapter.Script", d, StringComparison.Ordinal));
    }

    [Fact]
    public void TwoScriptsSharingAName_AreWritten()
    {
        var adapter = _fixture.Adapter(_fixture.Npc);
        Scripts(adapter).Add(new JsonObject { ["Name"] = "Alpha", ["Flags"] = "Local", ["Properties"] = new JsonArray() });

        var result = Edit(_fixture.Npc, adapter);

        Assert.True(result.Applied, result.Message);
        Assert.Equal(["Beta", "Alpha", "Alpha"], WrittenScriptNames(_fixture.Body(_fixture.Npc)));
    }

    [Fact]
    public void RenamingAScriptToTheNameAnotherHolds_IsWritten()
    {
        var result = Edit(_fixture.Twins, SetAt(JsonSerializer.SerializeToElement("Holder"), Under(Member("Scripts"), At(0), Member("Name"))));

        Assert.True(result.Applied, result.Message);
        Assert.Equal(["Holder", "Holder", "Tail"], WrittenScriptNames(_fixture.Body(_fixture.Twins)));
    }

    [Theory]
    [InlineData(0, new[] { 5, 2 })]
    [InlineData(1, new[] { 1, 5 })]
    public void AnEditToOneOfAPairAnotherToolWrote_ChangesThatOneAlone(int property, int[] written)
    {
        var result = Edit(_fixture.Twins, SetAt(
            JsonSerializer.SerializeToElement(5), Under(Member("Scripts"), At(1), Member("Properties"), At(property), Member("Data"))));

        Assert.True(result.Applied, result.Message);
        Assert.Equal(written, HolderCounts(_fixture.Body(_fixture.Twins)));
    }

    [Theory]
    [InlineData(0, 2)]
    [InlineData(1, 1)]
    public void RemovingOneOfAPairAnotherToolWrote_RemovesThatOne(int property, int kept)
    {
        var result = Edit(_fixture.Twins, RemoveAt(Under(Member("Scripts"), At(1), Member("Properties"), At(property))));

        Assert.True(result.Applied, result.Message);
        Assert.Equal([kept], HolderCounts(_fixture.Body(_fixture.Twins)));
    }

    [Fact]
    public void RemovingTheScriptAheadOfAPairAnotherToolWrote_Applies()
    {
        var result = Edit(_fixture.Twins, RemoveAt(Under(Member("Scripts"), At(0))));

        Assert.True(result.Applied, result.Message);
        Assert.Equal(["Holder", "Tail"], WrittenScriptNames(_fixture.Body(_fixture.Twins)));
    }

    private static List<int> HolderCounts(string body) =>
        [.. JsonNode.Parse(body).Require()["VirtualMachineAdapter"].Require()["Scripts"].Require().AsArray()
            .First(s => s.Require()["Name"].Require().GetValue<string>() == "Holder").Require()["Properties"].Require().AsArray()
            .Select(p => p.Require()["Data"].Require().GetValue<int>())];

    private static Dictionary<string, string> WrittenScripts(string body) =>
        JsonNode.Parse(body).Require()["VirtualMachineAdapter"].Require()["Scripts"].Require().AsArray()
            .ToDictionary(s => s.Require()["Name"].Require().GetValue<string>(), s => s.Require().ToJsonString(), StringComparer.Ordinal);

    private static JsonNode WrittenProperty(string body, string script, string property) =>
        JsonNode.Parse(body).Require()["VirtualMachineAdapter"].Require()["Scripts"].Require().AsArray()
            .First(s => s.Require()["Name"].Require().GetValue<string>() == script).Require()["Properties"].Require().AsArray()
            .First(p => p.Require()["Name"].Require().GetValue<string>() == property).Require();

    private static List<string> WrittenPropertyNames(string body, string script) =>
        [.. JsonNode.Parse(body).Require()["VirtualMachineAdapter"].Require()["Scripts"].Require().AsArray()
            .First(s => s.Require()["Name"].Require().GetValue<string>() == script).Require()["Properties"].Require().AsArray()
            .Select(p => p.Require()["Name"].Require().GetValue<string>())];

    private sealed class VmadFixture : IDisposable
    {
        private const string PluginName = "Vmad694.esp";
        private const string Origin = "Vmad694Mod";

        private readonly ScratchDirectory _modFolder = new("medit-694-mod-");
        private readonly ScratchDirectory _gameDirectory = new("medit-694-game-");

        public PluginAddress Plugin { get; } = new(PluginName, Origin);
        public LoadOrderSnapshot LoadOrder { get; }
        public TestEditor EditHandler { get; }
        public FormKey Npc { get; }
        public FormKey Quest { get; }
        public FormKey Perk { get; }
        public FormKey Scene { get; }
        public FormKey Twins { get; }

        public VmadFixture()
        {
            var holder = new LoadOrderHolder();
            var pluginPath = Path.Combine(_modFolder, PluginName);
            var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);

            var npc = mod.Npcs.AddNew("Vmad694Npc");
            var adapter = new VirtualMachineAdapter { Version = 6, ObjectFormat = 2 };
            adapter.Scripts.Add(new ScriptEntry { Name = "Beta", Flags = ScriptEntry.Flag.Local });
            adapter.Scripts.Add(AlphaScript());
            npc.VirtualMachineAdapter = adapter;
            Npc = npc.FormKey;

            var twins = mod.Npcs.AddNew("Vmad694Twins");
            var twinsAdapter = new VirtualMachineAdapter { Version = 6, ObjectFormat = 2 };
            foreach (var (name, counts) in new[] { ("Lead", 1), ("Holder", 2), ("Tail", 1) })
            {
                var script = new ScriptEntry { Name = name, Flags = ScriptEntry.Flag.Local };
                for (var i = 0; i < counts; i++)
                    script.Properties.Add(new ScriptIntProperty { Name = "Count", Flags = ScriptProperty.Flag.Edited, Data = i + 1 });
                twinsAdapter.Scripts.Add(script);
            }
            twins.VirtualMachineAdapter = twinsAdapter;
            Twins = twins.FormKey;

            var quest = mod.Quests.AddNew("Vmad694Quest");
            var questAdapter = new QuestAdapter { Version = 6, ObjectFormat = 2 };
            questAdapter.Fragments.Add(new QuestScriptFragment { Stage = 10, StageIndex = 0, ScriptName = "Ten", FragmentName = "Frag10" });
            questAdapter.Fragments.Add(new QuestScriptFragment { Stage = 5, StageIndex = 1, ScriptName = "Five", FragmentName = "Frag5" });
            var alias = new QuestFragmentAlias { Version = 6, ObjectFormat = 2 };
            alias.Property.Alias = 0;
            var aliasScript = new ScriptEntry { Name = "AliasScript", Flags = ScriptEntry.Flag.Local };
            aliasScript.Properties.Add(new ScriptIntProperty { Name = "Level", Data = 1 });
            alias.Scripts.Add(aliasScript);
            questAdapter.Aliases.Add(alias);
            quest.VirtualMachineAdapter = questAdapter;
            Quest = quest.FormKey;

            var perk = mod.Perks.AddNew("Vmad694Perk");
            var perkAdapter = new PerkAdapter { Version = 6, ObjectFormat = 2 };
            var perkFragments = new PerkScriptFragments();
            perkFragments.Fragments.Add(new PerkScriptFragment { Index = 2, ScriptName = "Two", FragmentName = "Frag2" });
            perkFragments.Fragments.Add(new PerkScriptFragment { Index = 1, ScriptName = "One", FragmentName = "Frag1" });
            perkAdapter.ScriptFragments = perkFragments;
            perk.VirtualMachineAdapter = perkAdapter;
            Perk = perk.FormKey;

            var scene = new Scene(mod.GetNextFormKey("Vmad694Scene"), Fallout4Release.Fallout4) { EditorID = "Vmad694Scene" };
            quest.Scenes.Add(scene);
            var sceneAdapter = new SceneAdapter { Version = 6, ObjectFormat = 2 };
            var sceneFragments = new SceneScriptFragments();
            sceneFragments.PhaseFragments.Add(new ScenePhaseFragment
            { Index = 1, Flags = ScenePhaseFragment.Flag.OnStart, ScriptName = "OneStart", FragmentName = "F1S" });
            sceneFragments.PhaseFragments.Add(new ScenePhaseFragment
            { Index = 0, Flags = ScenePhaseFragment.Flag.OnCompletion, ScriptName = "ZeroEnd", FragmentName = "F0E" });
            sceneFragments.PhaseFragments.Add(new ScenePhaseFragment
            { Index = 1, Flags = ScenePhaseFragment.Flag.OnCompletion, ScriptName = "OneEnd", FragmentName = "F1E" });
            sceneAdapter.ScriptFragments = sceneFragments;
            scene.VirtualMachineAdapter = sceneAdapter;
            Scene = scene.FormKey;

            TrackedTemplates.WriteTracked(_modFolder, mod);

            LoadOrder = SnapshotPlugins.Snapshot(
                _gameDirectory, _gameDirectory, GameRelease.Fallout4,
                [new LoadOrderEntry(PluginName, pluginPath, Origin, Slot: 0, Enabled: true, Winning: true)]);

            holder.Apply(LoadOrder);
            EditHandler = TestEditService.EditHandler(holder);
        }

        private static ScriptEntry AlphaScript()
        {
            var script = new ScriptEntry { Name = "Alpha", Flags = ScriptEntry.Flag.Local };

            var tags = new ScriptStringListProperty { Name = "Tags", Flags = ScriptProperty.Flag.Edited };
            tags.Data.Add("a");
            tags.Data.Add("b");
            script.Properties.Add(tags);

            script.Properties.Add(new ScriptIntProperty { Name = "Count", Flags = ScriptProperty.Flag.Edited, Data = 1 });

            var config = new ScriptStructProperty { Name = "Config", Flags = ScriptProperty.Flag.Edited };
            var member = new ScriptEntry();
            member.Properties.Add(new ScriptIntProperty { Name = "Level", Flags = ScriptProperty.Flag.Edited, Data = 3 });
            config.Members.Add(member);
            script.Properties.Add(config);

            var parts = new ScriptStructListProperty { Name = "Parts", Flags = ScriptProperty.Flag.Edited };
            var instance = new ScriptEntryStructs();
            instance.Members.Add(new ScriptFloatProperty { Name = "Weight", Flags = ScriptProperty.Flag.Edited, Data = 1.5f });
            parts.Structs.Add(instance);
            script.Properties.Add(parts);

            return script;
        }

        public TestEditor Service() => EditHandler;

        public string Body(FormKey formKey) =>
            TrackedTree.Body(_modFolder, Plugin, formKey.ToString());

        public JsonObject Adapter(FormKey formKey) =>
            JsonNode.Parse(Body(formKey)).Require().AsObject()[Field].Require().AsObject();

        public void Dispose()
        {
            _modFolder.Dispose();
            _gameDirectory.Dispose();
        }
    }
}
