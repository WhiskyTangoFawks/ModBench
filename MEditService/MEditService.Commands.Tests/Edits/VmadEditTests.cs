using System.Text.Json.Nodes;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda.Fallout4;
using static MEditService.Commands.Tests.TestSupport.DocumentEditFixture;
using static MEditService.Commands.Tests.TestSupport.Envelopes;

namespace MEditService.Commands.Tests.Edits;

public sealed class VmadEditTests : IDisposable
{
    private const string Field = "VirtualMachineAdapter";
    private const string Npc = "000801:DocEdit.esp";
    private const string Twins = "000802:DocEdit.esp";
    private const string Quest = "000803:DocEdit.esp";
    private const string Perk = "000804:DocEdit.esp";
    private const string Scene = "000805:DocEdit.esp";

    private readonly DocumentEditFixture _fixture = new();

    public VmadEditTests()
    {
        var npc = new Npc(KeyOf(0x801), Fallout4Release.Fallout4) { EditorID = "Npc" };
        var adapter = new VirtualMachineAdapter { Version = 6, ObjectFormat = 2 };
        adapter.Scripts.Add(new ScriptEntry { Name = "Beta", Flags = ScriptEntry.Flag.Local });
        adapter.Scripts.Add(AlphaScript());
        npc.VirtualMachineAdapter = adapter;
        _fixture.Seed(npc, "npc_");

        var twins = new Npc(KeyOf(0x802), Fallout4Release.Fallout4) { EditorID = "Twins" };
        var twinsAdapter = new VirtualMachineAdapter { Version = 6, ObjectFormat = 2 };
        foreach (var (name, counts) in new[] { ("Lead", 1), ("Holder", 2), ("Tail", 1) })
        {
            var script = new ScriptEntry { Name = name, Flags = ScriptEntry.Flag.Local };
            for (var i = 0; i < counts; i++)
                script.Properties.Add(new ScriptIntProperty { Name = "Count", Flags = ScriptProperty.Flag.Edited, Data = i + 1 });
            twinsAdapter.Scripts.Add(script);
        }
        twins.VirtualMachineAdapter = twinsAdapter;
        _fixture.Seed(twins, "npc_");

        var quest = new Quest(KeyOf(0x803), Fallout4Release.Fallout4) { EditorID = "Quest" };
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

        var scene = new Scene(KeyOf(0x805), Fallout4Release.Fallout4) { EditorID = "Scene" };
        var sceneFragments = new SceneScriptFragments();
        sceneFragments.PhaseFragments.Add(new ScenePhaseFragment { Index = 1, Flags = ScenePhaseFragment.Flag.OnStart, ScriptName = "OneStart", FragmentName = "F1S" });
        sceneFragments.PhaseFragments.Add(new ScenePhaseFragment { Index = 0, Flags = ScenePhaseFragment.Flag.OnCompletion, ScriptName = "ZeroEnd", FragmentName = "F0E" });
        sceneFragments.PhaseFragments.Add(new ScenePhaseFragment { Index = 1, Flags = ScenePhaseFragment.Flag.OnCompletion, ScriptName = "OneEnd", FragmentName = "F1E" });
        scene.VirtualMachineAdapter = new SceneAdapter { Version = 6, ObjectFormat = 2, ScriptFragments = sceneFragments };
        quest.Scenes.Add(scene);
        _fixture.Seed(quest, "qust");

        var perk = new Perk(KeyOf(0x804), Fallout4Release.Fallout4) { EditorID = "Perk" };
        var perkFragments = new PerkScriptFragments();
        perkFragments.Fragments.Add(new PerkScriptFragment { Index = 2, ScriptName = "Two", FragmentName = "Frag2" });
        perkFragments.Fragments.Add(new PerkScriptFragment { Index = 1, ScriptName = "One", FragmentName = "Frag1" });
        perk.VirtualMachineAdapter = new PerkAdapter { Version = 6, ObjectFormat = 2, ScriptFragments = perkFragments };
        _fixture.Seed(perk, "perk");
    }

    public void Dispose() => _fixture.Dispose();

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

        return script;
    }

    private static List<int> HolderCounts(string body) =>
        [.. JsonNode.Parse(body).Require()[Field].Require()["Scripts"].Require().AsArray()
            .First(s => s.Require()["Name"].Require().GetValue<string>() == "Holder").Require()["Properties"].Require().AsArray()
            .Select(p => p.Require()["Data"].Require().GetValue<int>())];

    private static List<string> ScriptNames(string body) =>
        [.. JsonNode.Parse(body).Require()[Field].Require()["Scripts"].Require().AsArray()
            .Select(s => s.Require()["Name"].Require().GetValue<string>())];

    private string Applied(string record, RecordEditEnvelope envelope)
    {
        var (result, after) = _fixture.Apply(record, envelope);
        Assert.True(result.Applied, result.Message);
        return after.Require();
    }

    [Theory]
    [InlineData(Npc)]
    [InlineData(Quest)]
    [InlineData(Perk)]
    [InlineData(Scene)]
    public void ResendingAnAdapterHeldOutOfKeyOrder_WritesItBackUnchanged(string record)
    {
        var resent = Spelled(RecordEditEnvelope.Set, Field, JsonNode.Parse(_fixture.Document(record)).Require()[Field].Require().ToJsonString());

        Assert.Empty(_fixture.Changed(record, resent));
    }

    [Theory]
    [InlineData(Npc, "Scripts.1.Name", "\"Zulu\"", """VirtualMachineAdapter.Scripts[1].Name: "Alpha" -> "Zulu" """)]
    [InlineData(Npc, "Scripts.1.Properties.1.Data", "42", "VirtualMachineAdapter.Scripts[1].Properties[1].Data: 1 -> 42")]
    [InlineData(Npc, "Scripts.1.Properties.2.Members.0.Properties.0.Data", "9", "VirtualMachineAdapter.Scripts[1].Properties[2].Members[0].Properties[0].Data: 3 -> 9")]
    [InlineData(Quest, "Aliases.0.Scripts.0.Properties.0.Data", "7", "VirtualMachineAdapter.Aliases[0].Scripts[0].Properties[0].Data: 1 -> 7")]
    [InlineData(Quest, "Fragments.0.ScriptName", "\"Renamed\"", """VirtualMachineAdapter.Fragments[0].ScriptName: "Ten" -> "Renamed" """)]
    [InlineData(Perk, "ScriptFragments.Fragments.0.ScriptName", "\"Renamed\"", """VirtualMachineAdapter.ScriptFragments.Fragments[0].ScriptName: "Two" -> "Renamed" """)]
    [InlineData(Scene, "ScriptFragments.PhaseFragments.0.FragmentName", "\"Renamed\"", """VirtualMachineAdapter.ScriptFragments.PhaseFragments[0].FragmentName: "F1S" -> "Renamed" """)]
    public void ResendingAnAdapterWithOneMemberChanged_ChangesThatMemberAndNothingElse(string record, string path, string replacement, string change)
    {
        var changes = _fixture.Changed(record, _fixture.Resend(record, Field, path, replacement));

        Assert.Equal([change.TrimEnd()], changes);
    }

    [Fact]
    public void MovingAProperty_IsRefusedAsInvalidEnvelope_NamingItsKeyedArray()
    {
        var result = _fixture.Refused(Npc, Spelled(RecordEditEnvelope.Move, "VirtualMachineAdapter.Scripts[1].Properties[1]", "0"));

        Assert.Equal(RecordEditRefusal.InvalidEnvelope, result.Refusal);
        Assert.Contains("'VirtualMachineAdapter.Scripts[1].Properties' is a keyed array", result.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void RemovingTheLastPropertyOfAnAliasScript_LeavesItsPropertiesAbsent()
    {
        var after = Applied(Quest, Spelled(RecordEditEnvelope.Remove, "VirtualMachineAdapter.Aliases[0].Scripts[0].Properties[0]"));

        Assert.Equal(
            """[{"Property":{"Name":"","Alias":0},"Scripts":[{"Name":"AliasScript"}]}]""",
            JsonNode.Parse(after).Require()[Field].Require()["Aliases"].Require().ToJsonString());
    }

    [Fact]
    public void NullingAStructTheRecordCarries_ClearsItAndTouchesNothingElse()
    {
        var changes = _fixture.Changed(Quest, Clear(Member(Field), Member("Script")));

        Assert.All(changes, change => Assert.StartsWith("VirtualMachineAdapter.Script", change, StringComparison.Ordinal));
    }

    [Fact]
    public void RenamingAScriptToTheNameAnotherHolds_IsWritten()
    {
        var after = Applied(Twins, Spelled(RecordEditEnvelope.Set, "VirtualMachineAdapter.Scripts[0].Name", "\"Holder\""));

        Assert.Equal(["Holder", "Holder", "Tail"], ScriptNames(after));
    }

    [Theory]
    [InlineData(0, new[] { 5, 2 })]
    [InlineData(1, new[] { 1, 5 })]
    public void AnEditToOneOfAPairAnotherToolWrote_ChangesThatOneAlone(int property, int[] written)
    {
        var after = Applied(Twins, Spelled(RecordEditEnvelope.Set, $"VirtualMachineAdapter.Scripts[1].Properties[{property}].Data", "5"));

        Assert.Equal(written, HolderCounts(after));
    }

    [Theory]
    [InlineData(0, 2)]
    [InlineData(1, 1)]
    public void RemovingOneOfAPairAnotherToolWrote_RemovesThatOne(int property, int kept)
    {
        var after = Applied(Twins, Spelled(RecordEditEnvelope.Remove, $"VirtualMachineAdapter.Scripts[1].Properties[{property}]"));

        Assert.Equal([kept], HolderCounts(after));
    }

    [Fact]
    public void RemovingTheScriptAheadOfAPairAnotherToolWrote_Applies()
    {
        var after = Applied(Twins, Spelled(RecordEditEnvelope.Remove, "VirtualMachineAdapter.Scripts[0]"));

        Assert.Equal(["Holder", "Tail"], ScriptNames(after));
    }
}
