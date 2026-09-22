using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Commands;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.SourceRepo;
using MEditService.Tests;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using static MEditService.Commands.Tests.TestSupport.Envelopes;

namespace MEditService.Commands.Tests.Edits;

/// <summary>Each gesture is diffed member by member before and after, so one that quietly rewrote
/// another member fails naming it. Scripts and properties are keyed arrays, stored in key order
/// whatever the payload's order.</summary>
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

    // Every gesture here sits under the adapter column.
    private static PathHop[] Under(params PathHop[] hops) => [Member(Field), .. hops];

    private static JsonArray Scripts(JsonNode adapter) => adapter["Scripts"].Require().AsArray();

    private static JsonNode ScriptNamed(JsonNode adapter, string name) =>
        Scripts(adapter).First(s => s.Require()["Name"].Require().GetValue<string>() == name).Require();

    private static JsonNode PropertyNamed(JsonNode script, string name) =>
        script["Properties"].Require().AsArray().First(p => p.Require()["Name"].Require().GetValue<string>() == name).Require();

    private static List<string> WrittenScriptNames(string body) =>
        [.. JsonNode.Parse(body).Require()["VirtualMachineAdapter"].Require()["Scripts"].Require().AsArray()
            .Select(s => s.Require()["Name"].Require().GetValue<string>())];

    // ── scripts ──────────────────────────────────────────────────────────────

    [Fact]
    public void AddingAScript_StoresEveryScriptInKeyOrder_AndTouchesNothingElse()
    {
        _fixture.Normalize(_fixture.Npc);
        var before = _fixture.Body(_fixture.Npc);
        var adapter = _fixture.Adapter(_fixture.Npc);
        Scripts(adapter).Add(new JsonObject { ["Name"] = "Aardvark", ["Flags"] = "Local", ["Properties"] = new JsonArray() });

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
        adapter["Scripts"] = new JsonArray(JsonNode.Parse(kept));

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
        ScriptNamed(adapter, "Alpha")["Name"] = "Zulu";

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
        count["MutagenObjectType"] = "ScriptStringProperty";
        count["Data"] = "one";

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
        PropertyNamed(ScriptNamed(adapter, "Alpha"), "Count")["Data"] = 42;

        var result = Edit(_fixture.Npc, adapter);

        Assert.True(result.Applied, result.Message);
        Assert.Equal(
            ["VirtualMachineAdapter.Scripts[0].Properties[1].Data: 1 -> 42"],
            ConditionEditTests.DocumentDiff(before, _fixture.Body(_fixture.Npc)));
    }

    // ── a scalar-array property's own elements ───────────────────────────────

    [Theory]
    [InlineData(RecordEditEnvelope.Add, new[] { "a", "b", "" })]
    [InlineData(RecordEditEnvelope.Remove, new[] { "a" })]
    [InlineData(RecordEditEnvelope.Move, new[] { "b", "a" })]
    public void ScalarArrayPropertyElementOps_RewriteThatArrayAlone(string op, string[] expected)
    {
        _fixture.Normalize(_fixture.Npc);
        var before = _fixture.Body(_fixture.Npc);
        // add addresses the array; the other two address one of its elements.
        var array = Under(Member("Scripts"), At(0), Member("Properties"), At(3), Member("Data"));
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
        config["Members"].Require()[0].Require()["Properties"].Require()[0].Require()["Data"] = 9;

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
        PropertyNamed(adapter["Aliases"].Require()[0].Require()["Scripts"].Require().AsArray()[0].Require(), "Level")["Data"] = 7;

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
        adapter["Fragments"].Require().AsArray().First(f => f.Require()["Stage"].Require().GetValue<int>() == 10).Require()["ScriptName"] = "Renamed";

        var result = Edit(_fixture.Quest, adapter);

        Assert.True(result.Applied, result.Message);
        var written = JsonNode.Parse(_fixture.Body(_fixture.Quest)).Require()["VirtualMachineAdapter"].Require()["Fragments"].Require().AsArray();
        // The fixture wrote stage 10 before stage 5; the key is (Stage, StageIndex), so the write
        // stores them the other way round.
        Assert.Equal([5, 10], written.Select(f => f.Require()["Stage"].Require().GetValue<int>()));
        // The edited fragment differs by exactly its ScriptName; the other is byte-identical.
        var after = ByName(written, "Stage");
        var beforeByStage = ByName(
            JsonNode.Parse(before).Require()["VirtualMachineAdapter"].Require()["Fragments"].Require().AsArray(), "Stage");
        Assert.Equal(beforeByStage["5"], after["5"]);
        Assert.Equal(beforeByStage["10"].Replace("\"Ten\"", "\"Renamed\"", StringComparison.Ordinal), after["10"]);
    }

    [Fact]
    public void EditingAPerkFragment_KeepsTheFragmentsInIndexOrder()
    {
        var before = _fixture.Body(_fixture.Perk);
        var adapter = _fixture.Adapter(_fixture.Perk);
        adapter["ScriptFragments"].Require()["Fragments"].Require().AsArray()
            .First(f => f.Require()["Index"].Require().GetValue<int>() == 2).Require()["ScriptName"] = "Renamed";

        var result = Edit(_fixture.Perk, adapter);

        Assert.True(result.Applied, result.Message);
        var written = JsonNode.Parse(_fixture.Body(_fixture.Perk)).Require()["VirtualMachineAdapter"].Require()
            ["ScriptFragments"].Require()["Fragments"].Require().AsArray();
        // The fixture wrote index 2 before index 1; a single-member key sorts them by value.
        Assert.Equal([1, 2], written.Select(f => f.Require()["Index"].Require().GetValue<int>()));
        var after = ByName(written, "Index");
        var beforeByIndex = ByName(
            JsonNode.Parse(before).Require()["VirtualMachineAdapter"].Require()["ScriptFragments"].Require()["Fragments"].Require().AsArray(), "Index");
        Assert.Equal(beforeByIndex["1"], after["1"]);
        Assert.Equal(beforeByIndex["2"].Replace("\"Two\"", "\"Renamed\"", StringComparison.Ordinal), after["2"]);
    }

    [Fact]
    public void EditingAScenePhaseFragment_OrdersByIndexThenFlag_NotByIndexAlone()
    {
        var before = _fixture.Body(_fixture.Scene);
        var adapter = _fixture.Adapter(_fixture.Scene);
        adapter["ScriptFragments"].Require()["PhaseFragments"].Require().AsArray()
            .First(f => f.Require()["ScriptName"].Require().GetValue<string>() == "OneStart").Require()["FragmentName"] = "Renamed";

        var result = Edit(_fixture.Scene, adapter);

        Assert.True(result.Applied, result.Message);
        var written = JsonNode.Parse(_fixture.Body(_fixture.Scene)).Require()["VirtualMachineAdapter"].Require()
            ["ScriptFragments"].Require()["PhaseFragments"].Require().AsArray();
        // Two fragments share index 1 and the flag separates them, so all three survive and the pair sorts
        // by flag value. A key of the index alone would refuse this record's own data as a duplicate.
        Assert.Equal(["ZeroEnd", "OneStart", "OneEnd"], written.Select(f => f.Require()["ScriptName"].Require().GetValue<string>()));
        var after = ByName(written, "ScriptName");
        var beforeByName = ByName(
            JsonNode.Parse(before).Require()["VirtualMachineAdapter"].Require()["ScriptFragments"].Require()["PhaseFragments"].Require().AsArray(),
            "ScriptName");
        Assert.Equal(beforeByName["\"ZeroEnd\""], after["\"ZeroEnd\""]);
        Assert.Equal(beforeByName["\"OneEnd\""], after["\"OneEnd\""]);
        Assert.Equal(
            beforeByName["\"OneStart\""].Replace("\"F1S\"", "\"Renamed\"", StringComparison.Ordinal),
            after["\"OneStart\""]);
    }

    // ── an absent nested struct ──────────────────────────────────────────────

    [Fact]
    public void ResendingAnAdapterWhoseNestedStructIsAbsent_LeavesItAbsent()
    {
        // The first resend also puts the phase fragments in key order, so the settled document is
        // the one to compare against: from there a resend is the identity, null member included.
        _fixture.Normalize(_fixture.Scene);
        var before = _fixture.Body(_fixture.Scene);
        Assert.Null(_fixture.Adapter(_fixture.Scene)["ScriptFragments"].Require()["OnBegin"]);

        _fixture.Normalize(_fixture.Scene);

        Assert.Null(_fixture.Adapter(_fixture.Scene)["ScriptFragments"].Require()["OnBegin"]);
        Assert.Equal(before, _fixture.Body(_fixture.Scene));
    }

    // Absent means default (ADR-0005): a null set clears the member, and the document loses it.
    [Fact]
    public void NullingAStructTheRecordCarries_ClearsItAndTouchesNothingElse()
    {
        _fixture.Normalize(_fixture.Quest);
        var before = _fixture.Body(_fixture.Quest);
        Assert.NotNull(_fixture.Adapter(_fixture.Quest)["Script"]);

        var result = Edit(_fixture.Quest, Clear(Under(Member("Script"))));

        Assert.True(result.Applied, result.Message);
        var after = _fixture.Body(_fixture.Quest);
        Assert.All(
            ConditionEditTests.DocumentDiff(before, after),
            d => Assert.StartsWith("VirtualMachineAdapter.Script", d, StringComparison.Ordinal));
    }

    // ── the duplicate key ────────────────────────────────────────────────────

    [Fact]
    public void TwoScriptsSharingAName_AreRefusedNamingTheKey_AndNothingIsWritten()
    {
        _fixture.Normalize(_fixture.Npc);
        var before = _fixture.Body(_fixture.Npc);
        var adapter = _fixture.Adapter(_fixture.Npc);
        Scripts(adapter).Add(new JsonObject { ["Name"] = "Alpha", ["Flags"] = "Local", ["Properties"] = new JsonArray() });

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
        adapter["Fragments"].Require().AsArray().Add(new JsonObject
        {
            ["Stage"] = 10,
            ["StageIndex"] = 0,
            ["Unknown"] = 0,
            ["Unknown2"] = 0,
            ["ScriptName"] = "Other",
            ["FragmentName"] = "Other",
        });

        var result = Edit(_fixture.Quest, adapter);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.DuplicateKeyInKeyedArray, result.Refusal);
        Assert.Contains("10 / 0", result.Message, StringComparison.Ordinal);
    }

    // A keyed array's rows are labelled by key, not by position, so an array op names its element with
    // a key hop. Each test reads the document back, since a payload addressing the wrong element
    // still applies cleanly.

    [Fact]
    public void RemovingAQuestFragmentByItsCompositeKey_RemovesThatFragment_NotTheOneAtTheIndexTheKeyParsesTo()
    {
        _fixture.Normalize(_fixture.Quest);
        var before = _fixture.Body(_fixture.Quest);
        var beforeByStage = ByName(
            JsonNode.Parse(before).Require()["VirtualMachineAdapter"].Require()["Fragments"].Require().AsArray(), "Stage");
        // In key order stage 5 is element 0 and stage 10 is element 1, so removing the wrong one is
        // observable rather than a coin flip.
        Assert.Equal([5, 10], JsonNode.Parse(before).Require()["VirtualMachineAdapter"].Require()["Fragments"].Require()
            .AsArray().Select(f => f.Require()["Stage"].Require().GetValue<int>()));

        var result = Edit(_fixture.Quest, RemoveAt(Under(Member("Fragments"), Key("10 / 0"))));

        Assert.True(result.Applied, result.Message);
        var written = JsonNode.Parse(_fixture.Body(_fixture.Quest)).Require()["VirtualMachineAdapter"].Require()["Fragments"].Require().AsArray();
        Assert.Equal([5], written.Select(f => f.Require()["Stage"].Require().GetValue<int>()));
        Assert.Equal(beforeByStage["5"], written[0].Require().ToJsonString());
    }

    [Fact]
    public void MovingAScalarArrayElementReachedThroughTwoKeyHops_ReordersThatArrayAlone()
    {
        _fixture.Normalize(_fixture.Npc);
        var before = _fixture.Body(_fixture.Npc);

        var result = Edit(_fixture.Npc, MoveTo(0, Under(
            Member("Scripts"), Key("Alpha"), Member("Properties"), Key("Tags"), Member("Data"), At(1))));

        Assert.True(result.Applied, result.Message);
        var after = _fixture.Body(_fixture.Npc);
        Assert.Equal(
            ["b", "a"],
            WrittenProperty(after, "Alpha", "Tags")["Data"].Require().AsArray().Select(e => e.Require().GetValue<string>()));
        Assert.All(
            ConditionEditTests.DocumentDiff(before, after),
            d => Assert.StartsWith("VirtualMachineAdapter.Scripts[0].Properties[3].Data[", d, StringComparison.Ordinal));
    }

    [Fact]
    public void RemovingAnAliasScriptsPropertyReachedThroughADottedAliasKey_RemovesThatProperty()
    {
        _fixture.Normalize(_fixture.Quest);
        var before = _fixture.Body(_fixture.Quest);

        var result = Edit(_fixture.Quest, RemoveAt(Under(
            Member("Aliases"), Key("0"), Member("Scripts"), Key("AliasScript"), Member("Properties"), Key("Level"))));

        Assert.True(result.Applied, result.Message);
        var after = _fixture.Body(_fixture.Quest);
        // The alias's own script keeps its identity and loses exactly its one property; an empty
        // Properties list is simply absent from the source document.
        Assert.Equal(
            """[{"Property":{"Name":"","Alias":0},"Scripts":[{"Name":"AliasScript"}]}]""",
            JsonNode.Parse(after).Require()["VirtualMachineAdapter"].Require()["Aliases"].Require().ToJsonString());
        Assert.All(
            ConditionEditTests.DocumentDiff(before, after),
            d => Assert.StartsWith("VirtualMachineAdapter.Aliases[0].Scripts[0].Properties", d, StringComparison.Ordinal));
    }

    [Fact]
    public void AFreshlyAddedScriptIsAddressableByItsEmptyKey()
    {
        _fixture.Normalize(_fixture.Npc);
        var before = _fixture.Body(_fixture.Npc);

        var added = Edit(_fixture.Npc, AddAt(Under(Member("Scripts"))));
        Assert.True(added.Applied, added.Message);
        // The unnamed script sorts first: the empty key precedes every other.
        Assert.Equal(["", "Alpha", "Beta"], WrittenScriptNames(_fixture.Body(_fixture.Npc)));

        var removed = Edit(_fixture.Npc, RemoveAt(Under(Member("Scripts"), Key(""))));

        Assert.True(removed.Applied, removed.Message);
        Assert.Equal(before, _fixture.Body(_fixture.Npc));
    }

    [Fact]
    public void MovingAKeyedElement_IsResolvedAndLeavesTheArrayInKeyOrder()
    {
        _fixture.Normalize(_fixture.Npc);
        var before = _fixture.Body(_fixture.Npc);

        var result = Edit(_fixture.Npc, MoveTo(1, Under(Member("Scripts"), Key("Alpha"))));

        Assert.True(result.Applied, result.Message);
        Assert.Equal(["Alpha", "Beta"], WrittenScriptNames(_fixture.Body(_fixture.Npc)));
        Assert.Equal(before, _fixture.Body(_fixture.Npc));
    }

    [Fact]
    public void AKeyHopIntoAnArrayTheSchemaDoesNotKey_IsRefusedAndWritesNothing()
    {
        _fixture.Normalize(_fixture.Npc);
        var before = _fixture.Body(_fixture.Npc);

        var result = Edit(_fixture.Npc, RemoveAt(Under(
            Member("Scripts"), Key("Alpha"), Member("Properties"), Key("Tags"), Member("Data"), Key("b"))));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.InvalidEnvelope, result.Refusal);
        Assert.Equal(before, _fixture.Body(_fixture.Npc));
    }

    [Fact]
    public void RemovingByAKeyNoElementCarries_IsRefusedByName_AndWritesNothing()
    {
        _fixture.Normalize(_fixture.Npc);
        var before = _fixture.Body(_fixture.Npc);

        var result = Edit(_fixture.Npc, RemoveAt(Under(Member("Scripts"), Key("Gamma"))));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FieldNotFound, result.Refusal);
        Assert.Equal("VirtualMachineAdapter.Scripts[Gamma]", result.Path);
        Assert.Equal(before, _fixture.Body(_fixture.Npc));
    }

    private static Dictionary<string, string> WrittenScripts(string body) =>
        JsonNode.Parse(body).Require()["VirtualMachineAdapter"].Require()["Scripts"].Require().AsArray()
            .ToDictionary(s => s.Require()["Name"].Require().GetValue<string>(), s => s.Require().ToJsonString(), StringComparer.Ordinal);

    private static Dictionary<string, string> ByName(JsonArray written, string member) =>
        written.ToDictionary(e => e.Require()[member].Require().ToJsonString(), e => e.Require().ToJsonString(), StringComparer.Ordinal);

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

        private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-694-mod-").FullName;
        private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-694-game-").FullName;

        public PluginCopyKey Plugin { get; } = new(PluginName, Origin);
        public LoadOrderSnapshot LoadOrder { get; }
        public EditRecordHandler EditHandler { get; }
        public FormKey Npc { get; }
        public FormKey Quest { get; }
        public FormKey Perk { get; }
        public FormKey Scene { get; }

        public VmadFixture()
        {
            var holder = new LoadOrderHolder();
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

            // A scene phase fragment's key is its phase index then its phase flag (xEdit's
            // wbStructSK([1, 0])), so two fragments can share an index.
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

            LoadOrder = new LoadOrderSnapshot(
                _gameDirectory, _gameDirectory, GameRelease.Fallout4,
                SnapshotCopies.Of([new LoadOrderEntry(PluginName, pluginPath, Origin, Slot: 0, Enabled: true, Winning: true)]));
            new TrackService(NullLogger<TrackService>.Instance, TestAdapters.Mutagen())
                .TrackAsync(LoadOrder, Origin, SourcePreset.Edits)
                .GetAwaiter().GetResult();

            holder.Apply(LoadOrder);
            EditHandler = TestEditService.EditHandler(holder);
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

        public EditRecordHandler Service() => EditHandler;

        public string Body(FormKey formKey) =>
            TrackedTree.Body(_modFolder, Plugin, formKey.ToString());

        public JsonObject Adapter(FormKey formKey) =>
            JsonNode.Parse(Body(formKey)).Require().AsObject()[Field].Require().AsObject();

        public void Normalize(FormKey formKey)
        {
            var result = Service().Set(Plugin, formKey.ToString(), Field, Json(Adapter(formKey)));
            Assert.True(result.Applied, result.Message);
        }

        public void Dispose()
        {
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
