using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Edits;

/// <summary>
/// #694: every script gesture, through the ordinary reflected-field door. The
/// virtual-machine adapter is a struct column like any other, so there is no script write path to
/// test — there is the one write path, asked to carry scripts.
///
/// <para>Each gesture is measured, not asserted: the record's own source document is captured
/// before and after and diffed member by member (<see cref="ConditionEditTests.DocumentDiff"/>), so
/// a gesture that quietly rewrote a member it was not asked to touch fails naming that member.</para>
///
/// <para>Scripts, properties, struct members, alias scripts and the PERK/QUST fragment arrays are
/// keyed arrays (<c>SchemaAnnotations.KeyedArrays</c>), so every write stores them in key order
/// whatever order the payload listed them in — which is what the fixture, built deliberately out of
/// key order, lets the first gesture here demonstrate.</para>
/// </summary>
public sealed class VmadEditTests : IDisposable
{
    private readonly VmadFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private const string Field = "virtual_machine_adapter";

    private static JsonElement Json(JsonNode value) => JsonDocument.Parse(value.ToJsonString()).RootElement;

    private RecordEditResult Edit(FormKey record, JsonNode value) =>
        _fixture.Service().EditField(_fixture.Plugin, record.ToString(), Field, Json(value));

    private static JsonArray Scripts(JsonNode adapter) => adapter["scripts"]!.AsArray();

    private static JsonNode ScriptNamed(JsonNode adapter, string name) =>
        Scripts(adapter).First(s => s!["name"]!.GetValue<string>() == name)!;

    private static JsonNode PropertyNamed(JsonNode script, string name) =>
        script["properties"]!.AsArray().First(p => p!["name"]!.GetValue<string>() == name)!;

    private static List<string> WrittenScriptNames(string body) =>
        [.. JsonNode.Parse(body)!["VirtualMachineAdapter"]!["Scripts"]!.AsArray()
            .Select(s => s!["Name"]!.GetValue<string>())];

    // ── scripts ──────────────────────────────────────────────────────────────

    [Fact]
    public void AddingAScript_StoresEveryScriptInKeyOrder_AndTouchesNothingElse()
    {
        _fixture.Normalize(_fixture.Npc);
        var before = _fixture.Body(_fixture.Npc);
        var adapter = _fixture.Adapter(_fixture.Npc);
        Scripts(adapter).Add(new JsonObject { ["name"] = "Aardvark", ["flags"] = "Local", ["properties"] = new JsonArray() });

        var result = Edit(_fixture.Npc, adapter);

        Assert.True(result.Applied, result.Message);
        var after = _fixture.Body(_fixture.Npc);
        Assert.Equal(["Aardvark", "Alpha", "Beta"], WrittenScriptNames(after));
        // The two scripts the fixture wrote out of key order move, and carry exactly what they
        // carried; the new one is the only content the record gained.
        Assert.Equal(WrittenScripts(before)["Alpha"], WrittenScripts(after)["Alpha"]);
        Assert.Equal(WrittenScripts(before)["Beta"], WrittenScripts(after)["Beta"]);
        Assert.All(
            ConditionEditTests.DocumentDiff(before, after),
            d => Assert.StartsWith("VirtualMachineAdapter.Scripts", d, StringComparison.Ordinal));
    }

    [Fact]
    public void RemovingAScript_LeavesTheOtherScriptExactlyAsItWas()
    {
        _fixture.Normalize(_fixture.Npc);
        var before = _fixture.Body(_fixture.Npc);
        var adapter = _fixture.Adapter(_fixture.Npc);
        var kept = ScriptNamed(adapter, "Alpha").ToJsonString();
        adapter["scripts"] = new JsonArray(JsonNode.Parse(kept));

        var result = Edit(_fixture.Npc, adapter);

        Assert.True(result.Applied, result.Message);
        var after = _fixture.Body(_fixture.Npc);
        Assert.Equal(["Alpha"], WrittenScriptNames(after));
        // Alpha is byte-identical; every difference is Beta's own removal.
        Assert.Equal(WrittenScripts(before)["Alpha"], WrittenScripts(after)["Alpha"]);
        Assert.All(
            ConditionEditTests.DocumentDiff(before, after),
            d => Assert.StartsWith("VirtualMachineAdapter.Scripts[1]", d, StringComparison.Ordinal));
    }

    [Fact]
    public void RenamingAScript_MovesItToItsNewKeysPlace_CarryingEverythingElseWithIt()
    {
        _fixture.Normalize(_fixture.Npc);
        var before = _fixture.Body(_fixture.Npc);
        var adapter = _fixture.Adapter(_fixture.Npc);
        ScriptNamed(adapter, "Alpha")["name"] = "Zulu";

        var result = Edit(_fixture.Npc, adapter);

        Assert.True(result.Applied, result.Message);
        var after = _fixture.Body(_fixture.Npc);
        Assert.Equal(["Beta", "Zulu"], WrittenScriptNames(after));
        // The renamed script swaps places with Beta and its own name changes. Nothing else does:
        // its properties travel with it verbatim, and Beta's own text is untouched.
        Assert.Equal(
            WrittenScripts(before)["Alpha"].Replace("\"Alpha\"", "\"Zulu\"", StringComparison.Ordinal),
            WrittenScripts(after)["Zulu"]);
        Assert.Equal(WrittenScripts(before)["Beta"], WrittenScripts(after)["Beta"]);
    }

    // ── properties ───────────────────────────────────────────────────────────

    [Fact]
    public void AddingAProperty_StoresThePropertiesInKeyOrder()
    {
        _fixture.Normalize(_fixture.Npc);
        var adapter = _fixture.Adapter(_fixture.Npc);
        ScriptNamed(adapter, "Alpha")["properties"]!.AsArray().Add(new JsonObject
        {
            ["concrete_type"] = "ScriptFloatProperty",
            ["name"] = "Amount",
            ["flags"] = "Edited",
            ["data_float"] = 2.5,
        });

        var result = Edit(_fixture.Npc, adapter);

        Assert.True(result.Applied, result.Message);
        Assert.Equal(
            ["Amount", "Config", "Count", "Parts", "Tags"],
            WrittenPropertyNames(_fixture.Body(_fixture.Npc), "Alpha"));
    }

    [Fact]
    public void SwitchingAPropertysDiscriminator_DropsTheOutgoingLeafsMemberOnly()
    {
        _fixture.Normalize(_fixture.Npc);
        var before = _fixture.Body(_fixture.Npc);
        var adapter = _fixture.Adapter(_fixture.Npc);
        var count = PropertyNamed(ScriptNamed(adapter, "Alpha"), "Count");
        count["concrete_type"] = "ScriptStringProperty";
        count["data_string"] = "one";

        var result = Edit(_fixture.Npc, adapter);

        Assert.True(result.Applied, result.Message);
        Assert.Equal(
            [
                "VirtualMachineAdapter.Scripts[0].Properties[1].MutagenObjectType: \"ScriptIntProperty\" -> \"ScriptStringProperty\"",
                "VirtualMachineAdapter.Scripts[0].Properties[1].Data: 1 -> \"one\"",
            ],
            ConditionEditTests.DocumentDiff(before, _fixture.Body(_fixture.Npc)));
    }

    [Fact]
    public void EditingAPropertysValue_ChangesThatMemberAndNothingElse()
    {
        _fixture.Normalize(_fixture.Npc);
        var before = _fixture.Body(_fixture.Npc);
        var adapter = _fixture.Adapter(_fixture.Npc);
        PropertyNamed(ScriptNamed(adapter, "Alpha"), "Count")["data_int"] = 42;

        var result = Edit(_fixture.Npc, adapter);

        Assert.True(result.Applied, result.Message);
        Assert.Equal(
            ["VirtualMachineAdapter.Scripts[0].Properties[1].Data: 1 -> 42"],
            ConditionEditTests.DocumentDiff(before, _fixture.Body(_fixture.Npc)));
    }

    // ── a scalar-array property's own elements ───────────────────────────────

    [Theory]
    [InlineData("array_add", new[] { "a", "b", "" })]
    [InlineData("array_remove", new[] { "a" })]
    [InlineData("array_move_up", new[] { "b", "a" })]
    public void ScalarArrayPropertyElementOps_RewriteThatArrayAlone(string op, string[] expected)
    {
        _fixture.Normalize(_fixture.Npc);
        var before = _fixture.Body(_fixture.Npc);
        // 'array_add' addresses the array; the other two address one of its elements.
        var path = new JsonArray(
            new JsonObject { ["kind"] = "member", ["name"] = "scripts" },
            new JsonObject { ["kind"] = "index", ["index"] = 0 },
            new JsonObject { ["kind"] = "member", ["name"] = "properties" },
            new JsonObject { ["kind"] = "index", ["index"] = 3 },
            new JsonObject { ["kind"] = "member", ["name"] = "data_string_array" });
        if (op != "array_add") path.Add(new JsonObject { ["kind"] = "index", ["index"] = 1 });

        var result = Edit(_fixture.Npc, new JsonObject { ["op"] = op, ["path"] = path });

        Assert.True(result.Applied, result.Message);
        var tags = WrittenProperty(_fixture.Body(_fixture.Npc), "Alpha", "Tags");
        Assert.Equal(expected, tags["Data"]!.AsArray().Select(e => e!.GetValue<string>()));
        Assert.All(
            ConditionEditTests.DocumentDiff(before, _fixture.Body(_fixture.Npc)),
            d => Assert.StartsWith("VirtualMachineAdapter.Scripts[0].Properties[3].Data[", d, StringComparison.Ordinal));
    }

    // ── struct members and array-of-struct instances ─────────────────────────

    [Fact]
    public void EditingAStructMember_ChangesThatMemberAndNothingElse()
    {
        _fixture.Normalize(_fixture.Npc);
        var before = _fixture.Body(_fixture.Npc);
        var adapter = _fixture.Adapter(_fixture.Npc);
        var config = PropertyNamed(ScriptNamed(adapter, "Alpha"), "Config");
        config["members"]![0]!["properties"]![0]!["data_int"] = 9;

        var result = Edit(_fixture.Npc, adapter);

        Assert.True(result.Applied, result.Message);
        Assert.Equal(
            ["VirtualMachineAdapter.Scripts[0].Properties[0].Members[0].Properties[0].Data: 3 -> 9"],
            ConditionEditTests.DocumentDiff(before, _fixture.Body(_fixture.Npc)));
    }

    [Fact]
    public void AddingAnArrayOfStructInstance_AppendsIt_LeavingTheExistingOneAlone()
    {
        _fixture.Normalize(_fixture.Npc);
        var before = _fixture.Body(_fixture.Npc);
        var adapter = _fixture.Adapter(_fixture.Npc);
        var parts = PropertyNamed(ScriptNamed(adapter, "Alpha"), "Parts");
        parts["structs"]!.AsArray().Add(new JsonObject
        {
            ["members"] = new JsonArray(new JsonObject
            {
                ["concrete_type"] = "ScriptFloatProperty",
                ["name"] = "Weight",
                ["flags"] = "Edited",
                ["data_float"] = 4,
            }),
        });

        var result = Edit(_fixture.Npc, adapter);

        Assert.True(result.Applied, result.Message);
        // One difference, and it is the whole new instance: nothing else in the record moved.
        var added = Assert.Single(ConditionEditTests.DocumentDiff(before, _fixture.Body(_fixture.Npc)));
        Assert.StartsWith(
            "VirtualMachineAdapter.Scripts[0].Properties[2].Structs[1]: <absent> -> ",
            added, StringComparison.Ordinal);
        Assert.Contains("\"Weight\"", added, StringComparison.Ordinal);
    }

    // ── a quest's alias scripts and fragments ────────────────────────────────

    [Fact]
    public void EditingAnAliasScriptProperty_ChangesThatMemberAndNothingElse()
    {
        _fixture.Normalize(_fixture.Quest);
        var before = _fixture.Body(_fixture.Quest);
        var adapter = _fixture.Adapter(_fixture.Quest);
        PropertyNamed(adapter["aliases"]![0]!["scripts"]!.AsArray()[0]!, "Level")["data_int"] = 7;

        var result = Edit(_fixture.Quest, adapter);

        Assert.True(result.Applied, result.Message);
        Assert.Equal(
            ["VirtualMachineAdapter.Aliases[0].Scripts[0].Properties[0].Data: 1 -> 7"],
            ConditionEditTests.DocumentDiff(before, _fixture.Body(_fixture.Quest)));
    }

    [Fact]
    public void EditingAFragment_ChangesThatMemberAndKeepsTheFragmentsInKeyOrder()
    {
        var before = _fixture.Body(_fixture.Quest);
        var adapter = _fixture.Adapter(_fixture.Quest);
        adapter["fragments"]!.AsArray().First(f => f!["stage"]!.GetValue<int>() == 10)!["script_name"] = "Renamed";

        var result = Edit(_fixture.Quest, adapter);

        Assert.True(result.Applied, result.Message);
        var written = JsonNode.Parse(_fixture.Body(_fixture.Quest))!["VirtualMachineAdapter"]!["Fragments"]!.AsArray();
        // The fixture wrote stage 10 before stage 5; the key is (Stage, StageIndex), so the write
        // stores them the other way round.
        Assert.Equal([5, 10], written.Select(f => f!["Stage"]!.GetValue<int>()));
        // The edited fragment differs by exactly its ScriptName; the other is byte-identical.
        var after = ByName(written, "Stage");
        var beforeByStage = ByName(
            JsonNode.Parse(before)!["VirtualMachineAdapter"]!["Fragments"]!.AsArray(), "Stage");
        Assert.Equal(beforeByStage["5"], after["5"]);
        Assert.Equal(beforeByStage["10"].Replace("\"Ten\"", "\"Renamed\"", StringComparison.Ordinal), after["10"]);
    }

    [Fact]
    public void EditingAPerkFragment_KeepsTheFragmentsInIndexOrder()
    {
        var before = _fixture.Body(_fixture.Perk);
        var adapter = _fixture.Adapter(_fixture.Perk);
        adapter["script_fragments"]!["fragments"]!.AsArray()
            .First(f => f!["index"]!.GetValue<int>() == 2)!["script_name"] = "Renamed";

        var result = Edit(_fixture.Perk, adapter);

        Assert.True(result.Applied, result.Message);
        var written = JsonNode.Parse(_fixture.Body(_fixture.Perk))!["VirtualMachineAdapter"]!
            ["ScriptFragments"]!["Fragments"]!.AsArray();
        // The fixture wrote index 2 before index 1; a single-member key sorts them by value.
        Assert.Equal([1, 2], written.Select(f => f!["Index"]!.GetValue<int>()));
        var after = ByName(written, "Index");
        var beforeByIndex = ByName(
            JsonNode.Parse(before)!["VirtualMachineAdapter"]!["ScriptFragments"]!["Fragments"]!.AsArray(), "Index");
        Assert.Equal(beforeByIndex["1"], after["1"]);
        Assert.Equal(beforeByIndex["2"].Replace("\"Two\"", "\"Renamed\"", StringComparison.Ordinal), after["2"]);
    }

    [Fact]
    public void EditingAScenePhaseFragment_OrdersByIndexThenFlag_NotByIndexAlone()
    {
        var before = _fixture.Body(_fixture.Scene);
        var adapter = _fixture.Adapter(_fixture.Scene);
        adapter["script_fragments"]!["phase_fragments"]!.AsArray()
            .First(f => f!["script_name"]!.GetValue<string>() == "OneStart")!["fragment_name"] = "Renamed";

        var result = Edit(_fixture.Scene, adapter);

        Assert.True(result.Applied, result.Message);
        var written = JsonNode.Parse(_fixture.Body(_fixture.Scene))!["VirtualMachineAdapter"]!
            ["ScriptFragments"]!["PhaseFragments"]!.AsArray();
        // Two fragments share index 1; the flag is what separates them, so all three survive and
        // the pair sorts among itself by flag value (OnStart = 1 before OnCompletion = 2). A key of
        // the index alone would have refused this record's own data as a duplicate.
        Assert.Equal(["ZeroEnd", "OneStart", "OneEnd"], written.Select(f => f!["ScriptName"]!.GetValue<string>()));
        var after = ByName(written, "ScriptName");
        var beforeByName = ByName(
            JsonNode.Parse(before)!["VirtualMachineAdapter"]!["ScriptFragments"]!["PhaseFragments"]!.AsArray(),
            "ScriptName");
        Assert.Equal(beforeByName["\"ZeroEnd\""], after["\"ZeroEnd\""]);
        Assert.Equal(beforeByName["\"OneEnd\""], after["\"OneEnd\""]);
        Assert.Equal(
            beforeByName["\"OneStart\""].Replace("\"F1S\"", "\"Renamed\"", StringComparison.Ordinal),
            after["\"OneStart\""]);
    }

    // ── an absent nested struct ──────────────────────────────────────────────

    /// <summary>A scene adapter carries no <c>on_begin</c>/<c>on_end</c> fragment unless someone
    /// authored one, so the record's own read value gives them as null — and a resend of a read
    /// value must be accepted, not refused. It stays absent afterwards: nothing is written for a
    /// null either way.</summary>
    [Fact]
    public void ResendingAnAdapterWhoseNestedStructIsAbsent_LeavesItAbsent()
    {
        // The first resend also puts the phase fragments in key order, so the settled document is
        // the one to compare against: from there a resend is the identity, null member included.
        _fixture.Normalize(_fixture.Scene);
        var before = _fixture.Body(_fixture.Scene);
        Assert.Null(_fixture.Adapter(_fixture.Scene)["script_fragments"]!["on_begin"]);

        _fixture.Normalize(_fixture.Scene);

        Assert.Null(_fixture.Adapter(_fixture.Scene)["script_fragments"]!["on_begin"]);
        Assert.Equal(before, _fixture.Body(_fixture.Scene));
    }

    /// <summary>The other direction, which is what keeps the rule above from being a delete
    /// gesture nobody asked for: a null over a struct the record <i>does</i> carry is refused, and
    /// writes nothing. A Loqui member the record format requires could not survive being cleared,
    /// and this is what stops a payload doing it by accident.</summary>
    [Fact]
    public void NullingAStructTheRecordCarries_IsRefusedAndWritesNothing()
    {
        var before = _fixture.Body(_fixture.Quest);
        var adapter = _fixture.Adapter(_fixture.Quest);
        Assert.NotNull(adapter["script"]);
        adapter["script"] = null;

        var result = Edit(_fixture.Quest, adapter);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FieldValueShapeMismatch, result.Refusal);
        Assert.Equal(before, _fixture.Body(_fixture.Quest));
    }

    // ── the duplicate key ────────────────────────────────────────────────────

    [Fact]
    public void TwoScriptsSharingAName_AreRefusedNamingTheKey_AndNothingIsWritten()
    {
        _fixture.Normalize(_fixture.Npc);
        var before = _fixture.Body(_fixture.Npc);
        var adapter = _fixture.Adapter(_fixture.Npc);
        Scripts(adapter).Add(new JsonObject { ["name"] = "Alpha", ["flags"] = "Local", ["properties"] = new JsonArray() });

        var result = Edit(_fixture.Npc, adapter);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.DuplicateKeyInKeyedArray, result.Refusal);
        Assert.Contains("Alpha", result.Message, StringComparison.Ordinal);
        Assert.Equal(before, _fixture.Body(_fixture.Npc));
    }

    [Fact]
    public void TwoQuestFragmentsOnOneStage_AreRefusedNamingTheCompositeKey()
    {
        var adapter = _fixture.Adapter(_fixture.Quest);
        adapter["fragments"]!.AsArray().Add(new JsonObject
        {
            ["stage"] = 10,
            ["stage_index"] = 0,
            ["unknown"] = 0,
            ["unknown2"] = 0,
            ["script_name"] = "Other",
            ["fragment_name"] = "Other",
        });

        var result = Edit(_fixture.Quest, adapter);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.DuplicateKeyInKeyedArray, result.Refusal);
        Assert.Contains("10 / 0", result.Message, StringComparison.Ordinal);
    }

    /// <summary>Each written script's own text, by name — what a gesture that was not about a
    /// script has to leave byte-identical, wherever the sort moved it to.</summary>
    private static Dictionary<string, string> WrittenScripts(string body) =>
        JsonNode.Parse(body)!["VirtualMachineAdapter"]!["Scripts"]!.AsArray()
            .ToDictionary(s => s!["Name"]!.GetValue<string>(), s => s!.ToJsonString(), StringComparer.Ordinal);

    /// <summary>Each element's own written text, by whatever names it — what a gesture aimed at
    /// one element has to leave byte-identical in every other, wherever the sort moved them to.</summary>
    private static Dictionary<string, string> ByName(JsonArray written, string member) =>
        written.ToDictionary(e => e![member]!.ToJsonString(), e => e!.ToJsonString(), StringComparer.Ordinal);

    private static JsonNode WrittenProperty(string body, string script, string property) =>
        JsonNode.Parse(body)!["VirtualMachineAdapter"]!["Scripts"]!.AsArray()
            .First(s => s!["Name"]!.GetValue<string>() == script)!["Properties"]!.AsArray()
            .First(p => p!["Name"]!.GetValue<string>() == property)!;

    private static List<string> WrittenPropertyNames(string body, string script) =>
        [.. JsonNode.Parse(body)!["VirtualMachineAdapter"]!["Scripts"]!.AsArray()
            .First(s => s!["Name"]!.GetValue<string>() == script)!["Properties"]!.AsArray()
            .Select(p => p!["Name"]!.GetValue<string>())];

    private sealed class VmadFixture : IDisposable
    {
        private const string PluginName = "Vmad694.esp";
        private const string Origin = "Vmad694Mod";

        private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-694-mod-").FullName;
        private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-694-game-").FullName;
        private readonly LoadOrderMirror _mirror;

        public PluginKey Plugin { get; } = new(PluginName, Origin);
        public FormKey Npc { get; }
        public FormKey Quest { get; }
        public FormKey Perk { get; }
        public FormKey Scene { get; }

        public VmadFixture()
        {
            var pluginPath = Path.Combine(_modFolder, PluginName);
            var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);

            var npc = mod.Npcs.AddNew("Vmad694Npc");
            // Deliberately out of key order, and written straight to binary rather than through the
            // write path — the order a file on disk can genuinely be in, which is what makes the
            // first gesture's key-order assertion mean something.
            var adapter = new VirtualMachineAdapter { Version = 6, ObjectFormat = 2 };
            adapter.Scripts.Add(new ScriptEntry { Name = "Beta", Flags = ScriptEntry.Flag.Local });
            adapter.Scripts.Add(AlphaScript());
            npc.VirtualMachineAdapter = adapter;
            Npc = npc.FormKey;

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

            // A PERK fragment array keys on a single member (its index) rather than QUST's pair,
            // and is written out of key order like everything else here.
            var perk = mod.Perks.AddNew("Vmad694Perk");
            var perkAdapter = new PerkAdapter { Version = 6, ObjectFormat = 2 };
            var perkFragments = new PerkScriptFragments();
            perkFragments.Fragments.Add(new PerkScriptFragment { Index = 2, ScriptName = "Two", FragmentName = "Frag2" });
            perkFragments.Fragments.Add(new PerkScriptFragment { Index = 1, ScriptName = "One", FragmentName = "Frag1" });
            perkAdapter.ScriptFragments = perkFragments;
            perk.VirtualMachineAdapter = perkAdapter;
            Perk = perk.FormKey;

            // A scene phase fragment's key is its phase index and its phase flag, in that order —
            // xEdit's own wbStructSK([1, 0]) — so two fragments can share an index and be told
            // apart by the flag. Also the one adapter here whose own on_begin/on_end fragments are
            // unset, so a resend of it carries a null nested struct member.
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

            mod.WriteToBinary(pluginPath);

            _mirror = new LoadOrderMirror(
                new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
            ((ILoadOrderMirror)_mirror).Reconcile(
                _gameDirectory, [new LoadOrderEntry(PluginName, pluginPath, Origin, Slot: 0, Enabled: true, Winning: true)],
                GameRelease.Fallout4);
            Assert.Empty(_mirror.LoadOrder!.LoadFailures);
            new TrackService(NullLogger<TrackService>.Instance)
                .TrackAsync(_mirror.LoadOrder!, Origin, SourcePreset.Edits)
                .GetAwaiter().GetResult();
        }

        // Alpha's properties are written out of key order too, and cover every shape a gesture
        // below reaches: a scalar, a scalar array, a struct and an array of structs.
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

        public RecordEditService Service() =>
            new(_mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

        public string Body(FormKey formKey) =>
            _mirror.Index!.At(RecordRef.Effective).GetDocument(formKey.ToString(), Plugin)!.Body!;

        /// <summary>The adapter exactly as the record editor reads it — the value a resend puts
        /// back, so a gesture's payload is the read value with one member changed and nothing
        /// else, the way the webview builds it.</summary>
        public JsonObject Adapter(FormKey formKey)
        {
            var document = _mirror.Index!.At(RecordRef.Effective).GetDocument(formKey.ToString(), Plugin)!;
            var raw = document.Fields.Single(f => f.Metadata.Name == Field).Value;
            return JsonNode.Parse(raw!.ToString()!)!.AsObject();
        }

        /// <summary>Resends the adapter unchanged, so the record on disk is in key order before a
        /// gesture that asserts on positions. The fixture writes it out of order on purpose; a test
        /// about one member changing should not also be a test about the sort.</summary>
        public void Normalize(FormKey formKey)
        {
            var result = Service().EditField(Plugin, formKey.ToString(), Field, Json(Adapter(formKey)));
            Assert.True(result.Applied, result.Message);
        }

        public void Dispose()
        {
            _mirror.Dispose();
            TryDelete(_modFolder);
            TryDelete(_gameDirectory);
        }

        private static void TryDelete(string path)
        {
            try { Directory.Delete(path, recursive: true); }
            catch (IOException) { /* scratch directory, best effort */ }
            catch (UnauthorizedAccessException) { /* ditto */ }
        }
    }
}
