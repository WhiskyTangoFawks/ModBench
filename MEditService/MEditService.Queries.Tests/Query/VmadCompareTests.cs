using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Queries;
using MEditService.Queries.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Queries.Tests.Query;

/// <summary>Scripts, properties and alias scripts are keyed arrays aligned by key, so a plugin
/// carrying fewer scripts reads as absences at those keys rather than shifting rows.</summary>
public sealed class VmadCompareTests
{
    private static readonly GameRelease Release = GameRelease.Fallout4;
    private static readonly PluginCopyKey BasePlugin = new("Base.esm", "Data");
    private static readonly PluginCopyKey TopPlugin = new("Top.esp", "Data");
    private const string Field = "VirtualMachineAdapter";

    private readonly FormKey _scriptedNpc;
    private readonly FormKey _scriptedQuest;
    private readonly RecordQueryService _service;

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

        // Only Guard survives here — the master's Ambush is absent, not renamed.
        var topNpc = baseNpc.DeepCopy();
        var topAdapter = new VirtualMachineAdapter { Version = 6, ObjectFormat = 2 };
        topAdapter.Scripts.Add(NamedScript("Guard", "Radius", 20));
        topNpc.VirtualMachineAdapter = topAdapter;

        // The one disagreement, confined to a member of an alias script's own property.
        var topQuest = baseQuest.DeepCopy();
        topQuest.VirtualMachineAdapter = QuestAdapterWith(aliasLevel: 2);

        var rows = new[]
        {
            Row(baseNpc, BasePlugin, 0, isWinner: false, "npc_"),
            Row(topNpc, TopPlugin, 1, isWinner: true, "npc_"),
            Row(baseQuest, BasePlugin, 0, isWinner: false, "qust"),
            Row(topQuest, TopPlugin, 1, isWinner: true, "qust"),
        };
        var opened = new Dictionary<PluginCopyKey, PluginContent>
        {
            [BasePlugin] = new(IsLight: false, IsMaster: true, Masters: [], RecordCount: 2),
            [TopPlugin] = new(IsLight: false, IsMaster: false, Masters: ["Base.esm"], RecordCount: 2),
        };
        var copies = new[]
        {
            new RegisteredCopy("Base.esm", "Data", "Base.esm", 0, Enabled: true, Winning: true),
            new RegisteredCopy("Top.esp", "Data", "Top.esp", 1, Enabled: true, Winning: true),
        };
        var holder = FakeLoadOrder.Of(Release, copies);
        _service = new RecordQueryService(new FakeIndex(new FakeReads(opened, rows)), holder, SharedSchemaReflector.Instance, new ConflictClassifier());
    }

    private static FakeRow Row(IMajorRecordGetter record, PluginCopyKey plugin, int loadOrderIndex, bool isWinner, string recordType) =>
        new(plugin, loadOrderIndex, isWinner, RealDocuments.Of(record, plugin, loadOrderIndex, isWinner, Release, recordType, [Field]));

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
    public void ScriptsPresentInOneOverrideOnly_AlignByName()
    {
        var scripts = Child(Adapter(_scriptedNpc), "Scripts");

        // Both keys are rows, in key order, and the master's own holds nothing on the override's side. A
        // positional reading would line the master's Ambush up against the override's Guard.
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
    public void AConflictConfinedToAnAliasScript_IsReportedAtThatMember()
    {
        var adapter = Adapter(_scriptedQuest);

        // The alias array is keyed by the alias number its binding names; the scripts under it by
        // script name; the properties under those by property name.
        var properties = Child(Child(Child(Child(Child(adapter, "Aliases"), "0"), "Scripts"), "AliasScript"), "Properties");
        var row = Child(Child(properties, "Level"), "Data");
        Assert.Equal(ConflictThis.Override, row.CellStates["Top.esp"]);
        Assert.Equal("Top.esp", row.WinnerColumn);

        // Confined: the adapter's own sibling members agree — the quest's own script binding is
        // identical in both, and the empty script and fragment lists, which both documents omit,
        // are not rows at all.
        Assert.Equal(ConflictThis.IdenticalToMaster, Child(adapter, "Script").CellStates["Top.esp"]);
        Assert.DoesNotContain(Children(adapter), c => c.FieldName is "Scripts" or "Fragments");
    }
}
