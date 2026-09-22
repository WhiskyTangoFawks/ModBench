using MEditService.Codec.Schema;
using MEditService.PluginAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.PluginAdapter.Tests.PluginAdapter;

/// <summary>Where a link points, answered from the plugin files the load order loads (ADR-0005 rule
/// 2): a link cache over those files, and nothing live crossing back out.</summary>
public sealed class LoadOrderLinkTargetsTests
{
    private const string BaseName = "LinkBase.esm";
    private const string PatchName = "LinkPatch.esp";

    private static readonly IPluginAdapter Adapter = TestAdapters.Mutagen();

    private FormKey _keyword;
    private FormKey _race;
    private FormKey _overriddenKeyword;

    private PluginFixtureData TwoPluginLoadOrder(string prefix) =>
        new PluginFixtureBuilder(prefix)
            .WithPlugin(BaseName, mod =>
            {
                _keyword = mod.Keywords.AddNew("BaseKeyword").FormKey;
                _race = mod.Races.AddNew("BaseRace").FormKey;
                _overriddenKeyword = mod.Keywords.AddNew("OverriddenKeyword").FormKey;
            })
            .WithPlugin(PatchName, (mod, built) =>
                mod.Keywords.GetOrAddAsOverride(built[0].Keywords.First(k => k.EditorID == "OverriddenKeyword")).EditorID =
                    "RenamedByPatch")
            .Build();

    private static IReadOnlyList<ModPath> Paths(PluginFixtureData data, params string[] names) =>
        [.. names.Select(name => new ModPath(ModKey.FromFileName(name), Path.Combine(data.DataFolder, name)))];

    private static LinkAnswers Answers(IReadOnlyList<ModPath> loadOrder, params string[] formKeys) =>
        Adapter.LinkTargets(
            loadOrder,
            GameRelease.Fallout4,
            SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4),
            formKeys);

    private static IReadOnlyDictionary<string, ResolvedFormKey> Targets(
        IReadOnlyList<ModPath> loadOrder, params string[] formKeys) =>
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
    public void AFormKeyNoPluginInTheLoadOrderHolds_IsAbsent()
    {
        using var data = TwoPluginLoadOrder("link-targets-miss");

        var targets = Targets(Paths(data, BaseName, PatchName), "ABCDEF:NoSuchPlugin.esp", _keyword.ToString());

        Assert.False(targets.ContainsKey("ABCDEF:NoSuchPlugin.esp"));
        Assert.True(targets.ContainsKey(_keyword.ToString()));
    }

    // The load order is a load order, not a bag of files: the winning override is what a link
    // reaches in game, so it is what the answer names.
    [Fact]
    public void AnOverriddenRecord_IsNamedByTheCopyTheLoadOrderResolvesTo()
    {
        using var data = TwoPluginLoadOrder("link-targets-override");

        var targets = Targets(Paths(data, BaseName, PatchName), _overriddenKeyword.ToString());

        Assert.Equal(new ResolvedFormKey("kywd", "RenamedByPatch"), targets[_overriddenKeyword.ToString()]);
    }

    // A file the load order names can be gone or malformed by the time compile asks (ADR-0003). It
    // answers nothing, and it is named as unread, because the caller has to say so (ADR-0019).
    [Fact]
    public void AFileTheLoadOrderNamesButDiskDoesNotHold_IsNamedAsUnread_AndLeavesTheRestAnswered()
    {
        using var data = TwoPluginLoadOrder("link-targets-missing-file");
        var missing = new ModPath(ModKey.FromFileName("Absent.esp"), Path.Combine(data.DataFolder, "Absent.esp"));
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
