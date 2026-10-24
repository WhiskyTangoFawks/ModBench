using MEditService.Codec.Schema;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.PluginAdapter.Tests.PluginAdapter;

public sealed class LoadOrderLinkTargetsTests
{
    private const string BaseName = "LinkBase.esm";
    private const string PatchName = "LinkPatch.esp";

    private static readonly IPluginAdapter Adapter = TestAdapters.Mutagen();

    private FormKey _keyword;
    private FormKey _race;
    private FormKey _overriddenKeyword;
    private FormKey _placedRef;

    private PluginFixtureData TwoPluginLoadOrder(string prefix) =>
        new PluginFixtureBuilder(prefix)
            .WithPlugin(BaseName, mod =>
            {
                _keyword = mod.Keywords.AddNew("BaseKeyword").FormKey;
                _race = mod.Races.AddNew("BaseRace").FormKey;
                _overriddenKeyword = mod.Keywords.AddNew("OverriddenKeyword").FormKey;
                var placed = new PlacedObject(mod) { EditorID = "BasePlacedRef" };
                var cell = new Cell(mod) { EditorID = "BaseCell" };
                cell.Temporary.Add(placed);
                mod.Cells.Add(new CellBlock { BlockNumber = 0, SubBlocks = [new CellSubBlock { BlockNumber = 0, Cells = [cell] }] });
                _placedRef = placed.FormKey;
            })
            .WithPlugin(PatchName, (mod, built) =>
                mod.Keywords.GetOrAddAsOverride(built[0].Keywords.First(k => k.EditorID == "OverriddenKeyword")).EditorID =
                    "RenamedByPatch")
            .Build();

    private static LinkAnswers Answers(PluginFixtureData data, IEnumerable<LoadOrderEntry> entries, params string[] formKeys)
    {
        var snapshot = SnapshotPlugins.Snapshot(data.DataFolder, null, GameRelease.Fallout4, entries);
        return Adapter.LinkTargets(snapshot, snapshot.Active[^1], formKeys);
    }

    private static IReadOnlyDictionary<string, ResolvedFormKey> Targets(PluginFixtureData data, params string[] formKeys) =>
        Answers(data, data.Plugins, formKeys).Targets;

    [Fact]
    public void AFormKeyAPluginInTheLoadOrderHolds_IsNamedByItsRecordTypeAndEditorId()
    {
        using var data = TwoPluginLoadOrder("link-targets-hit");

        var targets = Targets(data, _keyword.ToString(), _race.ToString());

        Assert.Equal(new ResolvedFormKey("kywd", "BaseKeyword"), targets[_keyword.ToString()]);
        Assert.Equal(new ResolvedFormKey("race", "BaseRace"), targets[_race.ToString()]);
    }

    [Fact]
    public void AFormKeyOfARecordEmbeddedInAnotherPluginsContainer_IsNamedByItsRecordTypeAndEditorId()
    {
        using var data = TwoPluginLoadOrder("link-targets-embedded");

        var targets = Targets(data, _placedRef.ToString());

        Assert.Equal(new ResolvedFormKey("refr", "BasePlacedRef"), targets[_placedRef.ToString()]);
    }

    [Fact]
    public void AFormKeyNoPluginInTheLoadOrderHolds_IsAbsent()
    {
        using var data = TwoPluginLoadOrder("link-targets-miss");

        var targets = Targets(data, "ABCDEF:NoSuchPlugin.esp", _keyword.ToString());

        Assert.False(targets.ContainsKey("ABCDEF:NoSuchPlugin.esp"));
        Assert.True(targets.ContainsKey(_keyword.ToString()));
    }

    [Fact]
    public void AnOverriddenRecord_IsNamedByTheCopyTheLoadOrderResolvesTo()
    {
        using var data = TwoPluginLoadOrder("link-targets-override");

        var targets = Targets(data, _overriddenKeyword.ToString());

        Assert.Equal(new ResolvedFormKey("kywd", "RenamedByPatch"), targets[_overriddenKeyword.ToString()]);
    }

    [Fact]
    public void AFileTheLoadOrderNamesButDiskDoesNotHold_IsNamedAsUnread_AndLeavesTheRestAnswered()
    {
        using var data = TwoPluginLoadOrder("link-targets-missing-file");
        var absentKey = "000801:Absent.esp";
        LoadOrderEntry[] entries =
            [data.Plugins[0], new("Absent.esp", Path.Combine(data.DataFolder, "Absent.esp"), PluginOrigin.DataDirectory, 1, Enabled: true, Winning: true)];

        var answers = Answers(data, entries, _keyword.ToString(), absentKey);

        Assert.Equal(new ResolvedFormKey("kywd", "BaseKeyword"), answers.Targets[_keyword.ToString()]);
        Assert.False(answers.Targets.ContainsKey(absentKey));
        var unread = Assert.Single(answers.UnreadableFiles);
        Assert.Equal("Absent.esp", unread.FileName);
        Assert.Contains("Absent.esp", unread.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public void EveryFileTheLoadOrderNamesBeingReadable_LeavesNothingNamedAsUnread()
    {
        using var data = TwoPluginLoadOrder("link-targets-all-readable");

        Assert.Empty(Answers(data, data.Plugins, _keyword.ToString()).UnreadableFiles);
    }

    [Fact]
    public void AMalformedFormKey_IsAbsentRatherThanThrowing()
    {
        using var data = TwoPluginLoadOrder("link-targets-malformed");

        var targets = Targets(data, "not a form key");

        Assert.Empty(targets);
    }

    private static readonly FormKey MasterKeyword = FormKey.Factory("000801:Master.esp");

    private static readonly FormKey PatchKeyword = FormKey.Factory("000801:Patch.esp");

    private static readonly PluginAddress UnderCompile = new("Patch.esp", "PatchMod");

    private static string Written(string folder, string origin, string name, Action<Fallout4Mod> shape)
    {
        var path = Path.Combine(Directory.CreateDirectory(Path.Combine(folder, origin)).FullName, name);
        var mod = new Fallout4Mod(ModKey.FromFileName(name), Fallout4Release.Fallout4);
        shape(mod);
        mod.WriteToBinary(path);
        return path;
    }

    private static LoadOrderEntry Master(string folder, string origin, string editorId, int? line, bool winning = true) =>
        new("Master.esp", Written(folder, origin, "Master.esp", mod => mod.Keywords.Add(new Keyword(MasterKeyword, Fallout4Release.Fallout4) { EditorID = editorId })),
            origin, line, Enabled: false, winning);

    private static LoadOrderEntry Patch(string folder, int line, bool enabled) =>
        new(UnderCompile.Name, Written(folder, UnderCompile.Origin, UnderCompile.Name, _ => { }), UnderCompile.Origin, line, enabled, Winning: true);

    private static (LoadOrderEntry[] Entries, string CompiledPath) Compiling(params LoadOrderEntry[] entries) => (entries, entries[^1].Path);

    public static TheoryData<string, Func<string, (LoadOrderEntry[] Entries, string CompiledPath)>, FormKey, ResolvedFormKey[]> LinksOfThePluginUnderCompile => new()
    {
        {
            "a disabled plugin, into its disabled master",
            folder => Compiling(Master(folder, "MasterMod", "MasterKeyword", line: 0), Patch(folder, line: 1, enabled: false)),
            MasterKeyword, [new ResolvedFormKey("kywd", "MasterKeyword")]
        },
        {
            "an active plugin, into a disabled master the game does not load",
            folder => Compiling(Master(folder, "MasterMod", "MasterKeyword", line: 0), Patch(folder, line: 1, enabled: true)),
            MasterKeyword, []
        },
        {
            "a disabled plugin, into the copy of its disabled master the line names",
            folder => Compiling(
                Master(folder, "FirstMod", "FirstCopysKeyword", line: 0, winning: false),
                Master(folder, "SecondMod", "NamedCopysKeyword", line: 0),
                Patch(folder, line: 1, enabled: false)),
            MasterKeyword, [new ResolvedFormKey("kywd", "NamedCopysKeyword")]
        },
        {
            "a disabled plugin, into a master with no line",
            folder => Compiling(Master(folder, "MasterMod", "MasterKeyword", line: null), Patch(folder, line: 0, enabled: false)),
            MasterKeyword, [new ResolvedFormKey("kywd", "MasterKeyword")]
        },
        {
            "the plugin's own record, which only the copy being compiled holds",
            folder => ([Patch(folder, line: 0, enabled: true)],
                Written(folder, "Compiled", UnderCompile.Name, mod => mod.Keywords.Add(new Keyword(PatchKeyword, Fallout4Release.Fallout4) { EditorID = "PatchsOwnKeyword" }))),
            PatchKeyword, [new ResolvedFormKey("kywd", "PatchsOwnKeyword")]
        },
    };

    [Theory]
    [MemberData(nameof(LinksOfThePluginUnderCompile))]
    public void ALinkOfThePluginUnderCompile_IsNamedByTheCopyTheGameWouldLoadBesideIt(
        string _, Func<string, (LoadOrderEntry[] Entries, string CompiledPath)> arrange, FormKey link, ResolvedFormKey[] named)
    {
        using var scratch = new ScratchDirectory("link-targets-compile-");
        var (entries, compiledPath) = arrange(scratch);
        var loadOrder = SnapshotPlugins.Snapshot(scratch, null, GameRelease.Fallout4, entries);
        var compiled = loadOrder.Plugin(UnderCompile).Require() with { Path = compiledPath };

        Assert.Equal(named, Adapter.LinkTargets(loadOrder, compiled, [link.ToString()]).Targets.Values);
    }
}
