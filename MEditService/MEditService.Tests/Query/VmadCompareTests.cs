using MEditService.Core.Plugins;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Query;

/// <summary>Scripts, properties and alias scripts are keyed arrays aligned by key, so a plugin
/// carrying fewer scripts reads as absences at those keys rather than shifting rows.</summary>
public sealed class VmadCompareTests : IDisposable
{
    private readonly PluginFixtureData _fixture;
    private readonly LoadOrderMirror _manager;
    private readonly RecordQueryService _service;

    private static readonly FormKey ScriptedNpc = new(ModKey.FromFileName("Base.esm"), 0x800);
    private static readonly FormKey ScriptedQuest = new(ModKey.FromFileName("Base.esm"), 0x801);

    private const string Field = "VirtualMachineAdapter";

    public VmadCompareTests()
    {
        _fixture = new PluginFixtureBuilder("compare-vmad")
            .WithPlugin("Base.esm", mod =>
            {
                var npc = mod.Npcs.AddNew("ScriptedNPC");
                var adapter = new VirtualMachineAdapter { Version = 6, ObjectFormat = 2 };
                adapter.Scripts.Add(NamedScript("Ambush", "Radius", 10));
                adapter.Scripts.Add(NamedScript("Guard", "Radius", 20));
                npc.VirtualMachineAdapter = adapter;

                var quest = mod.Quests.AddNew("ScriptedQuest");
                quest.VirtualMachineAdapter = QuestAdapterWith(aliasLevel: 1);
            })
            .WithPlugin("Top.esp", (mod, built) =>
            {
                var basePlugin = built.Single(m => m.ModKey.FileName == "Base.esm");
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Base.esm") });

                // Only Guard survives here — the master's Ambush is absent, not renamed.
                var npc = basePlugin.Npcs.First(n => n.FormKey == ScriptedNpc).DeepCopy();
                var adapter = new VirtualMachineAdapter { Version = 6, ObjectFormat = 2 };
                adapter.Scripts.Add(NamedScript("Guard", "Radius", 20));
                npc.VirtualMachineAdapter = adapter;
                mod.Npcs.Set(npc);

                // The one disagreement, confined to a member of an alias script's own property.
                var quest = basePlugin.Quests.First(q => q.FormKey == ScriptedQuest).DeepCopy();
                quest.VirtualMachineAdapter = QuestAdapterWith(aliasLevel: 2);
                mod.Quests.Set(quest);
            })
            .Build();

        var reflector = SharedSchemaReflector.Instance;
        _manager = new LoadOrderMirror(new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector)));
        _manager.Reconcile(_fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);
        _service = new RecordQueryService(_manager.Projector, reflector, new ConflictClassifier());
    }

    public void Dispose()
    {
        _manager.Dispose();
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

    private static FieldDiff Child(FieldDiff diff, string name) =>
        diff.Children!.Single(c => c.FieldName == name);

    private FieldDiff Adapter(FormKey record) =>
        _service.GetCompare(record.ToString())!.Diffs.Single(d => d.FieldName == Field);

    [Fact]
    public void ScriptsPresentInOneOverrideOnly_AlignByName()
    {
        var scripts = Child(Adapter(ScriptedNpc), "Scripts");

        // Both keys are rows, in key order, and the master's own holds nothing on the override's side. A
        // positional reading would line the master's Ambush up against the override's Guard.
        Assert.Equal(["Ambush", "Guard"], scripts.Children!.Select(c => c.FieldName));
        var ambush = Child(scripts, "Ambush");
        Assert.NotNull(ambush.Values["Base.esm"]);
        Assert.Null(ambush.Values["Top.esp"]);
        var guard = Child(scripts, "Guard");
        Assert.Equal(guard.Values["Base.esm"]!.ToString(), guard.Values["Top.esp"]!.ToString());
    }

    [Fact]
    public void AConflictConfinedToAnAliasScript_IsReportedAtThatMember()
    {
        var adapter = Adapter(ScriptedQuest);

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
        Assert.DoesNotContain(adapter.Children!, c => c.FieldName is "Scripts" or "Fragments");
    }

    [Fact]
    public void Vmad_Compare_MatchesGolden()
    {
        var captured = new Dictionary<string, object?>
        {
            ["scripted-npc"] = Project(_service.GetCompare(ScriptedNpc.ToString())!),
            ["scripted-quest"] = Project(_service.GetCompare(ScriptedQuest.ToString())!),
        };

        Golden.Verify("compare-vmad", captured);
    }

    // The adapter's own diff subtree only: the record-wide picture is CompareGoldenTests' golden,
    // and repeating an NPC's ~200 agreeing columns here would bury the one field this pins.
    private static object Project(CompareResult r) => new
    {
        r.ConflictAll,
        Adapter = r.Diffs.Single(d => d.FieldName == Field),
    };
}
