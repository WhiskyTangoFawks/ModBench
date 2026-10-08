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

    private static RegisteredPlugin Plugin(PluginFixtureData data, string name) =>
        new(name, PluginOrigin.DataDirectory, Path.Combine(data.DataFolder, name), PluginProvider.Game);

    private static IReadOnlyList<RegisteredPlugin> Paths(PluginFixtureData data, params string[] names) =>
        [.. names.Select(name => Plugin(data, name))];

    private static LinkAnswers Answers(IReadOnlyList<RegisteredPlugin> loadOrder, params string[] formKeys) =>
        Adapter.LinkTargets(
            new LoadOrderSnapshot(
                DataFolderOf(loadOrder[0]), null, GameRelease.Fallout4, loadOrder, [.. loadOrder.Select(plugin => plugin.Key)], []),
            loadOrder[^1],
            SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4),
            formKeys);

    private static string DataFolderOf(RegisteredPlugin plugin) => Path.GetDirectoryName(plugin.Path) ?? plugin.Path;

    private static IReadOnlyDictionary<string, ResolvedFormKey> Targets(
        IReadOnlyList<RegisteredPlugin> loadOrder, params string[] formKeys) =>
        Answers(loadOrder, formKeys).Targets;

    [Fact]
    public void AFormKeyAPluginInTheLoadOrderHolds_IsNamedByItsRecordTypeAndEditorId()
    {
        using var data = TwoPluginLoadOrder("link-targets-hit");

        var targets = Targets(Paths(data, BaseName, PatchName), _keyword.ToString(), _race.ToString());

        Assert.Equal(new ResolvedFormKey("kywd", "BaseKeyword"), targets[_keyword.ToString()]);
        Assert.Equal(new ResolvedFormKey("race", "BaseRace"), targets[_race.ToString()]);
    }

    [Fact]
    public void AFormKeyOfARecordEmbeddedInAnotherPluginsContainer_IsNamedByItsRecordTypeAndEditorId()
    {
        using var data = TwoPluginLoadOrder("link-targets-embedded");

        var targets = Targets(Paths(data, BaseName, PatchName), _placedRef.ToString());

        Assert.Equal(new ResolvedFormKey("refr", "BasePlacedRef"), targets[_placedRef.ToString()]);
    }

    [Fact]
    public void AFormKeyNoPluginInTheLoadOrderHolds_IsAbsent()
    {
        using var data = TwoPluginLoadOrder("link-targets-miss");

        var targets = Targets(Paths(data, BaseName, PatchName), "ABCDEF:NoSuchPlugin.esp", _keyword.ToString());

        Assert.False(targets.ContainsKey("ABCDEF:NoSuchPlugin.esp"));
        Assert.True(targets.ContainsKey(_keyword.ToString()));
    }

    [Fact]
    public void AnOverriddenRecord_IsNamedByTheCopyTheLoadOrderResolvesTo()
    {
        using var data = TwoPluginLoadOrder("link-targets-override");

        var targets = Targets(Paths(data, BaseName, PatchName), _overriddenKeyword.ToString());

        Assert.Equal(new ResolvedFormKey("kywd", "RenamedByPatch"), targets[_overriddenKeyword.ToString()]);
    }

    [Fact]
    public void AFileTheLoadOrderNamesButDiskDoesNotHold_IsNamedAsUnread_AndLeavesTheRestAnswered()
    {
        using var data = TwoPluginLoadOrder("link-targets-missing-file");
        var missing = Plugin(data, "Absent.esp");
        var absentKey = $"000801:Absent.esp";

        var answers = Answers([.. Paths(data, BaseName), missing], _keyword.ToString(), absentKey);

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

        Assert.Empty(Answers(Paths(data, BaseName, PatchName), _keyword.ToString()).UnreadableFiles);
    }

    [Fact]
    public void AMalformedFormKey_IsAbsentRatherThanThrowing()
    {
        using var data = TwoPluginLoadOrder("link-targets-malformed");

        var targets = Targets(Paths(data, BaseName), "not a form key");

        Assert.Empty(targets);
    }
}
