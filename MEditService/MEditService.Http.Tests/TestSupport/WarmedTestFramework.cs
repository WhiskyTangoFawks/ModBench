using MEditService.TestSupport;
using Mutagen.Bethesda;
using Xunit.Abstractions;

[assembly: TestFramework("MEditService.Http.Tests.TestSupport.WarmedTestFramework", "MEditService.Http.Tests")]

namespace MEditService.Http.Tests.TestSupport;

/// <summary>Walks each gesture once before the first test starts, so the seconds of JIT the first
/// calls cost are no test's time and cannot break the per-test ceiling under load.</summary>
public sealed class WarmedTestFramework(IMessageSink diagnostics) : SchemaWarmedTestFramework(diagnostics)
{
    protected override void Warm()
    {
        base.Warm();
        WalkGestures().GetAwaiter().GetResult();
    }

    private static async Task WalkGestures()
    {
        const string Plugin = "Warm.esp";
        const string Origin = "WarmMod";
        using var fx = new PluginFixtureBuilder("warm-up")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew("WarmNpc"), origin: Origin)
            .BuildScattered();
        using var host = new MEditHost();
        using var client = host.CreateClient();

        (await client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await client.Init(Origin)).EnsureSuccessStatusCode();
        await client.NextSnapshot(fx);
        await client.PluginReportsSourcePlugin(Plugin);
        var formKey = await client.FirstFormKey(Plugin, Origin);
        (await client.Edit(formKey, Plugin, Origin, "HeightMax", 0.75)).EnsureSuccessStatusCode();
        (await client.Compile([(Plugin, Origin)])).EnsureSuccessStatusCode();
        (await client.Decompile([(Plugin, Origin)])).EnsureSuccessStatusCode();
    }
}
