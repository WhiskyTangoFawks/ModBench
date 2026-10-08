using MEditService.LoadOrder;
using MEditService.Index.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Index.Tests.Query;

public sealed class VmadCompareTests
{
    private static readonly GameRelease Release = GameRelease.Fallout4;
    private static readonly PluginAddress BasePlugin = new("Base.esm", PluginOrigin.DataDirectory);
    private static readonly PluginAddress TopPlugin = new("Top.esp", PluginOrigin.DataDirectory);
    private const string Field = "VirtualMachineAdapter";

    private readonly FormKey _scriptedNpc;
    private readonly FormKey _scriptedQuest;
    private readonly IRecordQueryService _service;

    public VmadCompareTests()
    {
        var baseMod = new Fallout4Mod(ModKey.FromFileName("Base.esm"), Fallout4Release.Fallout4);
        var baseNpc = baseMod.Npcs.AddNew("ScriptedNPC");
        var baseAdapter = new VirtualMachineAdapter { Version = 6, ObjectFormat = 2 };
        baseAdapter.Scripts.Add(NamedScript("Ambush", "Radius", 10));
        baseAdapter.Scripts.Add(NamedScript("Guard", "Radius", 20));
        baseNpc.VirtualMachineAdapter = baseAdapter;
        _scriptedNpc = baseNpc.FormKey;

        var baseQuest = baseMod.Quests.AddNew("ScriptedQuest");
        baseQuest.VirtualMachineAdapter = QuestAdapterWith(aliasLevel: 1);
        _scriptedQuest = baseQuest.FormKey;

        var topNpcKeepingOnlyGuardMastersAmbushAbsentNotRenamed = baseNpc.DeepCopy();
        var topAdapter = new VirtualMachineAdapter { Version = 6, ObjectFormat = 2 };
        topAdapter.Scripts.Add(NamedScript("Guard", "Radius", 20));
        topNpcKeepingOnlyGuardMastersAmbushAbsentNotRenamed.VirtualMachineAdapter = topAdapter;

        var topQuestDisagreeingOnlyInAnAliasScriptsOwnProperty = baseQuest.DeepCopy();
        topQuestDisagreeingOnlyInAnAliasScriptsOwnProperty.VirtualMachineAdapter = QuestAdapterWith(aliasLevel: 2);

        var rows = new[]
        {
            Row(baseNpc, BasePlugin, 0),
            Row(topNpcKeepingOnlyGuardMastersAmbushAbsentNotRenamed, TopPlugin, 1),
            Row(baseQuest, BasePlugin, 0),
            Row(topQuestDisagreeingOnlyInAnAliasScriptsOwnProperty, TopPlugin, 1),
        };
        var opened = new Dictionary<PluginAddress, PluginContent>
        {
            [BasePlugin] = new(IsLight: false, IsMaster: true, IsBlueprint: false, Masters: [], RecordCount: 2, IsMedium: false),
            [TopPlugin] = new(IsLight: false, IsMaster: false, IsBlueprint: false, Masters: ["Base.esm"], RecordCount: 2, IsMedium: false),
        };
        var plugins = new[]
        {
            new LoadOrderEntry("Base.esm", "Base.esm", PluginOrigin.DataDirectory, 0, Enabled: true, Winning: true),
            new LoadOrderEntry("Top.esp", "Top.esp", PluginOrigin.DataDirectory, 1, Enabled: true, Winning: true),
        };
        var holder = FakeLoadOrder.Of(Release, plugins);
        _service = QueryHost.Records(new FakeIndex(new FakeReads(opened, rows)), holder);
    }

    private static FakeRow Row(IMajorRecordGetter record, PluginAddress plugin, int loadOrderIndex) =>
        new(RealDocuments.Of(record, plugin, loadOrderIndex, Release));

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

    private FieldDiff Adapter(FormKey record)
    {
        var compare = _service.GetCompare(record.ToString())
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
