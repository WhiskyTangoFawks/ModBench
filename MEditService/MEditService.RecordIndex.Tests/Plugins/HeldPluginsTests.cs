using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Tests.Plugins;

public sealed class HeldPluginsTests
{
    private const string UserPlugin = "UserMod.esp";

    private static OpenedIndex Open(PluginFixtureData data, IReadOnlyList<LoadOrderEntry>? entries = null) =>
        Indexes.Reconciled(data.DataFolder, entries ?? data.Plugins);

    private static PluginAddress Key(string name, string origin = PluginOrigin.DataDirectory) => new(name, origin);

    private static Dictionary<PluginAddress, PluginResponse> Opened(OpenedIndex held) =>
        held.Queries.GetPlugins().Value().ToDictionary(row => row.KeyOf(), row => row, PluginAddress.Comparer);

    [Fact]
    public void TheGamesMasterSentFirst_IsHeldBeforeTheUserPlugin()
    {
        using var data = new PluginFixtureBuilder("lo-open")
            .WithPlugin("Fallout4.esm")
            .WithPlugin(UserPlugin)
            .Build();

        using var held = Open(data);

        Assert.Equal(["Fallout4.esm", UserPlugin], held.Status.IndexedPlugins.Select(p => p.Name));
        Assert.Contains(Key("Fallout4.esm"), Opened(held).Keys);
        Assert.Contains(Key(UserPlugin), Opened(held).Keys);
    }

    [Fact]
    public void AMissingFile_IsAFailureOnTheRow_NotAnException()
    {
        using var data = new PluginFixtureBuilder("lo-missing")
            .WithPlugin("Present.esp")
            .Build();
        var entries = data.Plugins.Append(new LoadOrderEntry(
            "NonExistent.esp", Path.Combine(data.DataFolder, "NonExistent.esp"),
            PluginOrigin.DataDirectory, Line: 1, Enabled: true, Winning: true)).ToList();

        using var held = Open(data, entries);

        var opened = Opened(held).Keys;
        Assert.Contains(Key("Present.esp"), opened);
        Assert.DoesNotContain(Key("NonExistent.esp"), opened);
        Assert.Contains(held.Status.Failures, f => f.Name == "NonExistent.esp");
    }

    [Fact]
    public void AnUnparseableOverriddenPlugin_TheFailureNamesTheOverriddenPluginsOrigin()
    {
        using var fx = new PluginFixtureBuilder("lo-losing-garbage")
            .WithPlugin("Shared.esp", origin: "ModB")
            .WithPlugin("Shared.esp", origin: "ModA")
            .BuildScattered();
        var winner = fx.Plugins.Single(p => p.Origin == "ModA");
        var overridden = fx.Plugins.Single(p => p.Origin == "ModB");
        File.WriteAllBytes(overridden.Path, [0xDE, 0xAD, 0xBE, 0xEF]);

        using var held = Indexes.Reconciled(fx.DataFolder, [winner, overridden]);

        Assert.Equal("ModA", Assert.Single(Opened(held).Keys).Origin);
        var failure = Assert.Single(held.Status.Failures);
        Assert.Equal("Shared.esp", failure.Name);
        Assert.Equal("ModB", failure.Origin);
    }

    [Fact]
    public void AReconcileAfterAFailure_ClearsTheFailure()
    {
        using var data = new PluginFixtureBuilder("lo-recover")
            .WithPlugin("Fixed.esp")
            .Build();
        var resolved = data.Plugins.Single();
        var missing = resolved with { Path = Path.Combine(data.DataFolder, "Elsewhere.esp") };
        var holder = new LoadOrderHolder();
        using var held = Indexes.Open(holder);

        held.Reconcile(holder, data.DataFolder, [missing], GameRelease.Fallout4);
        Assert.Single(held.Status.Failures);

        held.Reconcile(holder, data.DataFolder, [resolved], GameRelease.Fallout4);
        Assert.Empty(held.Status.Failures);
        Assert.Contains(Key("Fixed.esp"), Opened(held).Keys);
    }

    [Fact]
    public void ThePluginRow_CarriesTheLightAndMasterFlagsThePluginReads()
    {
        using var data = new PluginFixtureBuilder("lo-ext").WithPlugin("TestMod.esl").Build();
        using var held = Open(data);

        var row = Opened(held)[Key("TestMod.esl")];
        Assert.True(row.IsLight);
        Assert.False(row.IsMaster);
    }

    [Fact]
    public void ThePluginRows_HoldTheHeldPlugin_AndNoUnknownPluginOrOrigin()
    {
        using var data = new PluginFixtureBuilder("lo-find").WithPlugin("CaseMod.esp").Build();
        using var held = Open(data);

        Assert.Equal([Key("CaseMod.esp")], held.Queries.GetPlugins().Value().Select(row => row.KeyOf()));
    }

    [Fact]
    public void ARemovedPlugin_IsNoLongerHeld()
    {
        using var data = new PluginFixtureBuilder("lo-remove").WithPlugin("A.esp").WithPlugin("B.esp").Build();
        var holder = new LoadOrderHolder();
        using var held = Indexes.Open(holder);
        held.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4);
        var removed = Key("A.esp");

        held.Reconcile(holder, data.DataFolder, [.. data.Plugins.Where(p => p.Name == "B.esp")], GameRelease.Fallout4);

        Assert.Equal(["B.esp"], held.Status.IndexedPlugins.Select(p => p.Name));
        Assert.DoesNotContain(removed, Opened(held).Keys);
    }
}
