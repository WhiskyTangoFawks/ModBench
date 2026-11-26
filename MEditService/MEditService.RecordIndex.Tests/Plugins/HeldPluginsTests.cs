using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Tests.Plugins;

public sealed class HeldPluginsTests
{
    private static Dictionary<PluginAddress, PluginResponse> Opened(OpenedIndex held) =>
        held.Queries.GetPlugins().Value().ToDictionary(row => row.KeyOf(), row => row, PluginAddress.Comparer);

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
        Assert.Contains(new PluginAddress("Fixed.esp", PluginOrigin.DataDirectory), Opened(held).Keys);
    }
}
