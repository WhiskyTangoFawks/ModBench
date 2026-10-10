using MEditService.Index.Queries;
using MEditService.Index.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Index.Tests.Query;

public sealed class VmadCompareTests : IDisposable
{
    private const string Field = "VirtualMachineAdapter";

    private readonly PluginFixtureData _fixture;
    private readonly OpenedIndex _index;
    private readonly string _scriptedNpc;
    private readonly string _scriptedQuest;

    public VmadCompareTests()
    {
        string? scriptedNpc = null;
        string? scriptedQuest = null;
        _fixture = new PluginFixtureBuilder("medit-vmad-compare")
            .WithPlugin("Base.esm", mod =>
            {
                var npc = mod.Npcs.AddNew("ScriptedNPC");
                var adapter = new VirtualMachineAdapter { Version = 6, ObjectFormat = 2 };
                adapter.Scripts.Add(NamedScript("Ambush", "Radius", 10));
                adapter.Scripts.Add(NamedScript("Guard", "Radius", 20));
                npc.VirtualMachineAdapter = adapter;
                scriptedNpc = npc.FormKey.ToString();

                var quest = mod.Quests.AddNew("ScriptedQuest");
                quest.VirtualMachineAdapter = QuestAdapterWith(aliasLevel: 1);
                scriptedQuest = quest.FormKey.ToString();
            })
            .WithPlugin("Top.esp", (mod, built) =>
            {
                var npcKeepingOnlyGuardMastersAmbushAbsentNotRenamed = built[0].Npcs.First().DeepCopy();
                var adapter = new VirtualMachineAdapter { Version = 6, ObjectFormat = 2 };
                adapter.Scripts.Add(NamedScript("Guard", "Radius", 20));
                npcKeepingOnlyGuardMastersAmbushAbsentNotRenamed.VirtualMachineAdapter = adapter;
                mod.Npcs.Set(npcKeepingOnlyGuardMastersAmbushAbsentNotRenamed);

                var questDisagreeingOnlyInAnAliasScriptsOwnProperty = built[0].Quests.First().DeepCopy();
                questDisagreeingOnlyInAnAliasScriptsOwnProperty.VirtualMachineAdapter = QuestAdapterWith(aliasLevel: 2);
                mod.Quests.Set(questDisagreeingOnlyInAnAliasScriptsOwnProperty);
            })
            .Build();
        _index = Indexes.Reconciled(_fixture);
        (_scriptedNpc, _scriptedQuest) = (scriptedNpc.Require(), scriptedQuest.Require());
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    private static ScriptEntry NamedScript(string name, string property, int value)
    {
        var script = new ScriptEntry { Name = name, Flags = ScriptEntry.Flag.Local };
        script.Properties.Add(new ScriptIntProperty { Name = property, Flags = ScriptProperty.Flag.Edited, Data = value });
        return script;
    }

    private static QuestAdapter QuestAdapterWith(int aliasLevel)
    {
        var adapter = new QuestAdapter { Version = 6, ObjectFormat = 2 };
        var alias = new QuestFragmentAlias { Version = 6, ObjectFormat = 2 };
        alias.Property.Alias = 0;
        alias.Scripts.Add(NamedScript("AliasScript", "Level", aliasLevel));
        adapter.Aliases.Add(alias);
        return adapter;
    }

    private static IReadOnlyList<FieldDiff> Children(FieldDiff diff) =>
        diff.Children ?? throw new InvalidOperationException($"Expected \"{diff.FieldName}\" to have children.");

    private static FieldDiff Child(FieldDiff diff, string name) =>
        Children(diff).Single(c => c.FieldName == name);

    private FieldDiff Adapter(string record)
    {
        var compare = _index.Queries.GetCompare(record).Value()
            ?? throw new InvalidOperationException($"Expected {record} to resolve to a compare result.");
        return compare.Diffs.Single(d => d.FieldName == Field);
    }

    [Fact]
    public void ScriptsPresentInOneOverrideOnly_AlignByName_NotPositionallyAgainstTheOtherOverridesFirstScript()
    {
        var scripts = Child(Adapter(_scriptedNpc), "Scripts");

        Assert.Equal(["Ambush", "Guard"], Children(scripts).Select(c => c.FieldName));
        var ambush = Child(scripts, "Ambush");
        Assert.NotNull(ambush.Values["Base.esm"]);
        Assert.Null(ambush.Values["Top.esp"]);
        var guard = Child(scripts, "Guard");
        var guardBase = guard.Values["Base.esm"];
        var guardTop = guard.Values["Top.esp"];
        Assert.NotNull(guardBase);
        Assert.NotNull(guardTop);
        Assert.Equal(guardBase.ToString(), guardTop.ToString());
    }

    [Fact]
    public void AConflictConfinedToAnAliasScript_IsReportedAtThatMember_UnderTheAliasNumberScriptNameAndPropertyNameKeys()
    {
        var adapter = Adapter(_scriptedQuest);

        var properties = Child(Child(Child(Child(Child(adapter, "Aliases"), "0"), "Scripts"), "AliasScript"), "Properties");
        var row = Child(Child(properties, "Level"), "Data");
        Assert.Equal(ConflictThis.Override, row.CellStates["Top.esp"]);
        Assert.Equal("Top.esp", row.WinnerColumn);
    }

    [Fact]
    public void AConflictConfinedToAnAliasScript_LeavesTheAdaptersSiblingMembersIdenticalAndTheEmptyListsBothDocumentsOmitAsNoRows()
    {
        var adapter = Adapter(_scriptedQuest);

        Assert.Equal(ConflictThis.IdenticalToMaster, Child(adapter, "Script").CellStates["Top.esp"]);
        Assert.DoesNotContain(Children(adapter), c => c.FieldName is "Scripts" or "Fragments");
    }
}
