using MEditService.Core.PluginAdapter;
using MEditService.Core.Records;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.PluginAdapter;

/// <summary>Where a link points, answered from the plugin files the load order loads (ADR-0005 rule
/// 2): a link cache over those files, and nothing live crossing back out.</summary>
public sealed class LoadOrderLinkTargetsTests
{
    private const string BaseName = "LinkBase.esm";
    private const string PatchName = "LinkPatch.esp";

    private static readonly IPluginAdapter Adapter = MutagenPluginAdapter.Instance;

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

    private static IReadOnlyDictionary<string, RecordLookupEntry> Targets(
        IReadOnlyList<ModPath> loadOrder, params string[] formKeys) =>
        Adapter.LinkTargets(
            loadOrder,
            GameRelease.Fallout4,
            SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4),
            formKeys);

    [Fact]
    public void AFormKeyAPluginInTheLoadOrderHolds_IsNamedByItsRecordTypeAndEditorId()
    {
        using var data = TwoPluginLoadOrder("link-targets-hit");

        var targets = Targets(Paths(data, BaseName, PatchName), _keyword.ToString(), _race.ToString());

        Assert.Equal(new RecordLookupEntry("kywd", "BaseKeyword"), targets[_keyword.ToString()]);
        Assert.Equal(new RecordLookupEntry("race", "BaseRace"), targets[_race.ToString()]);
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

        Assert.Equal(new RecordLookupEntry("kywd", "RenamedByPatch"), targets[_overriddenKeyword.ToString()]);
    }

    // A file the load order names can be gone or malformed by the time compile asks (ADR-0003), and
    // every link into it is then unresolved — which is what an absent answer says.
    [Fact]
    public void AFileTheLoadOrderNamesButDiskDoesNotHold_AnswersNothing_AndLeavesTheRestAnswered()
    {
        using var data = TwoPluginLoadOrder("link-targets-missing-file");
        var missing = new ModPath(ModKey.FromFileName("Absent.esp"), Path.Combine(data.DataFolder, "Absent.esp"));

        var targets = Targets([.. Paths(data, BaseName), missing], _keyword.ToString());

        Assert.Equal(new RecordLookupEntry("kywd", "BaseKeyword"), targets[_keyword.ToString()]);
    }

    [Fact]
    public void AMalformedFormKey_IsAbsentRatherThanThrowing()
    {
        using var data = TwoPluginLoadOrder("link-targets-malformed");

        var targets = Targets(Paths(data, BaseName), "not a form key");

        Assert.Empty(targets);
    }
}
